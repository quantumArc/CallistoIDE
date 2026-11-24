/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationToken, CancellationTokenSource, Disposable, PreferenceService } from '@theia/core';
import {
    ChatModel, ChatMode, ChatRequestModel, ChatResponseContent, ChatResponseModel, CompactionChatResponseContent,
    CompactionChatResponseContentImpl, ErrorChatResponseContent, InformationalChatResponseContent, InformationalChatResponseContentImpl,
    MutableChatRequestModel, ProgressChatResponseContent, ProgressChatResponseContentImpl, ResponseTokenUsage, ThinkingChatResponseContent,
    ToolCallChatResponseContent
} from '@theia/ai-chat/lib/common';
import { ImageContextVariable } from '@theia/ai-chat/lib/common/image-context-variable';
import {
    isLanguageModelStreamResponse, isLanguageModelTextResponse, isTextResponsePart, isThinkingResponsePart, isToolCallResponsePart, LanguageModel,
    LanguageModelMessage, LanguageModelRequirement, LanguageModelResponse, LanguageModelStreamResponse, PromptVariantSet, ToolRequest
} from '@theia/ai-core';
import { AbstractModeAwareChatAgent } from '@theia/ai-ide/lib/browser/mode-aware-chat-agent';
import { RUN_TASK_FUNCTION_ID } from '@theia/ai-ide/lib/common/workspace-functions';
import { WorkspaceFunctionScope } from '@theia/ai-ide/lib/browser/workspace-functions';
import { TODO_WRITE_FUNCTION_ID } from '@theia/ai-ide/lib/common/todo-tool';
import {
    CLEAR_FILE_CHANGES_ID, SUGGEST_FILE_CONTENT_ID, SUGGEST_FILE_REPLACEMENTS_ID, WRITE_FILE_CONTENT_ID, WRITE_FILE_REPLACEMENTS_ID
} from '@theia/ai-ide/lib/common/file-changeset-function-ids';
import { SHELL_EXECUTION_FUNCTION_ID } from '@theia/ai-terminal/lib/common/shell-execution-server';
import {
    CALLISTO_AGENT_MODE_ID, CALLISTO_REQUEST_CONTEXT_ID, CALLISTO_REVIEW_MODE_ID, CALLISTO_SYSTEM_PROMPT_ID, getCallistoAgentModePrompt,
    getCallistoRequestContextPrompt, getCallistoReviewModePrompt
} from '../common/callisto-agent-prompts.js';
import { ThinkingLoopDetector, ThinkingLoopVerdict } from '../common/thinking-loop-detector.js';
import { CALLISTO_REASONING_SIGNATURE, LOW_REASONING_UNTIL_ACTION_SETTING } from '../common/reasoning-text.js';
import { carriedThinking } from '../common/carried-thinking.js';
import { commandFailed, describe, keptReasoning, NudgeContext, nudgeFor } from '../common/callisto-nudges.js';
import { SyntaxCheckResult, SyntaxCheckService } from '../common/syntax-check-protocol.js';
import { LOOP_BREAKER_PREF, MAX_THINKING_TOKENS_PREF, SUMMARIZE_AFTER_TOKENS_PREF } from './callisto-agent-preferences.js';
import { contextOverflowMessage, parseContextOverflow } from '../common/context-overflow.js';
import { LM_STUDIO_PREFIX, LocalModelsContribution } from './local-models-contribution.js';
import {
    CALLISTO_SUMMARY_PROVIDER, CallistoSummaryData, changedFiles, cleanSummary, isCallistoSummaryData, MAX_SUMMARY_CHARS, parseTodos,
    summarizeThreshold, summaryInstruction, summaryMessage, TodoItem
} from '../common/conversation-summary.js';

export const CALLISTO_AGENT_ID = 'Callisto';

/** The same tool with the same arguments is answered from the guard from this call on, until something changes. */
const MAX_IDENTICAL_CALLS = 3;
/** Tool calls allowed for one chat request before the agent is told to stop and report. */
const MAX_TOOL_CALLS_PER_REQUEST = 100;
/** Full rewrites of one file allowed per chat request (writing it the first time counts). */
const MAX_FULL_WRITES_PER_FILE = 2;
/**
 * Interruptions in a row, with no action in between, after which Callisto hands the task back to the user. The last
 * resume before that is sent at a low thinking level: on the chess-app task Inkling at its default (high) level
 * thought for 18k characters without acting where at low it wrote its todo list within 43 seconds.
 */
const MAX_LOOP_RESUMES = 2;
/** Share of the loaded context window a single stretch of reasoning may fill up to, counting the prompt. */
const CONTEXT_CEILING_RATIO = 0.9;
/** Reasoning always gets at least this much room, so that a nearly full chat still gets a chance to act. */
const MIN_THINKING_ROOM_TOKENS = 2000;
/** Conservative characters per token for the context ceiling (Inkling averages about 2.6). */
const CEILING_CHARS_PER_TOKEN = 2.5;

/**
 * Tools that can change what other tools return (files, task output). After one of them runs, repeating an
 * earlier call is legitimate again, e.g. re-reading a file after editing it or re-running the tests after a fix.
 */
const STATE_CHANGING_TOOLS = new Set([
    WRITE_FILE_REPLACEMENTS_ID, WRITE_FILE_CONTENT_ID, SUGGEST_FILE_REPLACEMENTS_ID, SUGGEST_FILE_CONTENT_ID,
    CLEAR_FILE_CHANGES_ID, SHELL_EXECUTION_FUNCTION_ID, RUN_TASK_FUNCTION_ID
]);

/** Tools that replace a whole file. */
const FULL_WRITE_TOOLS = new Set([WRITE_FILE_CONTENT_ID, SUGGEST_FILE_CONTENT_ID]);

/** Tools that change a file on disk (Agent mode), after which Callisto checks that the file still parses. */
const DISK_WRITE_TOOLS = new Set([WRITE_FILE_CONTENT_ID, WRITE_FILE_REPLACEMENTS_ID]);

/** Tools whose `path` argument names a file the model created or changed, for the file list kept with a summary. */
const FILE_CHANGE_TOOLS = new Set([WRITE_FILE_CONTENT_ID, WRITE_FILE_REPLACEMENTS_ID, SUGGEST_FILE_CONTENT_ID, SUGGEST_FILE_REPLACEMENTS_ID]);

/** Room for a summary, reasoning included (LM Studio counts both against `max_tokens`). */
const SUMMARY_MAX_TOKENS = 8192;
/** Reasoning past this while writing a summary means the model is working on the task again instead: give up. */
const MAX_SUMMARY_THINKING_CHARS = 40000;
/** What a tool call gets while the model writes a summary. The tools stay declared so the prompt matches LM Studio's cache. */
const TOOLS_OFF_WHILE_SUMMARIZING = 'Callisto: tools are switched off while you write the summary. Reply with the summary now.';

/** Files that can be run or tested, for which the model is reminded to run them instead of re-reading them. */
const CODE_FILE = /\.(m?js|cjs|jsx|tsx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/i;

const RUN_IT_NOTE = 'Next: check this file by running it (the tests, or a short script that exercises it), not by re-reading it in your head.';
const TEST_CHANGED_NOTE = 'Callisto note: your last command failed and you have now changed a test. Only do that if the test itself was wrong, '
    + 'not the code under test. Say in one sentence why the old expectation was wrong; if you are not sure, prove it first with a quick '
    + 'check (for example `node -e` or `python3 -c`).';

interface LoopGuardState {
    identicalCalls: Map<string, number>;
    fullWrites: Map<string, number>;
    totalCalls: number;
    /** Whether the last shell command failed, e.g. a test run. */
    lastRunFailed: boolean;
}

/** What is needed to send the request again after an interruption. */
interface LlmCall {
    messages: LanguageModelMessage[];
    tools: ToolRequest[];
    deferredToolIds: string[] | undefined;
    languageModel: LanguageModel;
    promptVariantId?: string;
    isPromptVariantCustomized?: boolean;
    cancellation: CancellationTokenSource;
    cancellationLink: Disposable;
}

/** The prompt a summary is asked for in: the same system message, tools and model as the chat's requests. */
interface SummaryCall {
    system: LanguageModelMessage[];
    tools: ToolRequest[];
    deferredToolIds: string[] | undefined;
    languageModel: LanguageModel;
    /** Request whose session settings (thinking level, provider settings) apply. */
    settingsFrom: MutableChatRequestModel;
}

/** A Callisto summary in a chat, and the index of the request it covers up to. */
interface ChatSummary {
    part: CompactionChatResponseContent;
    data: CallistoSummaryData;
    index: number;
}

/**
 * Callisto's coding agent: a harness tuned for local models such as Inkling 2 Mini.
 *
 * On top of Theia's agent loop it adds:
 * - a short, loop-shaped system prompt (see `callisto-agent-prompts.ts`);
 * - a **loop breaker**: the reasoning is watched while it streams, and when it starts going in circles (or is about to
 *   fill the context window) the model call is cancelled and resumed with everything done so far, what it had worked
 *   out before the loop, and a nudge to act. Long planning on its own is not interrupted: Inkling plans for a long time
 *   and then acts, and cutting that short only made it plan again. On a long chess-app task this would have cut a
 *   16-minute self-review loop short;
 * - a **loop guard** on tool calls: repeated identical calls, repeated full rewrites of one file, and calls past a
 *   per-request budget are answered with an instruction to change course instead of being run.
 */
@injectable()
export class CallistoAgent extends AbstractModeAwareChatAgent {

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(WorkspaceFunctionScope)
    protected readonly workspaceScope: WorkspaceFunctionScope;

    @inject(SyntaxCheckService)
    protected readonly syntaxCheckService: SyntaxCheckService;

    @inject(LocalModelsContribution)
    protected readonly localModels: LocalModelsContribution;

    id = CALLISTO_AGENT_ID;
    name = CALLISTO_AGENT_ID;
    override description = 'Callisto\'s coding agent, tuned for local models such as Inkling. It plans with a todo list, edits files, runs '
        + 'tests and commands to verify its work, and reports what it changed and how it checked it. It interrupts reasoning that goes '
        + 'in circles. Agent mode edits files directly; Review mode proposes changes for you to apply.';
    override iconClass = 'codicon codicon-rocket';

    languageModelRequirements: LanguageModelRequirement[] = [{ purpose: 'chat', identifier: 'default/code' }];
    protected defaultLanguageModelPurpose = 'chat';

    protected readonly modeDefinitions: Omit<ChatMode, 'isDefault'>[] = [
        { id: CALLISTO_AGENT_MODE_ID, name: 'Agent' },
        { id: CALLISTO_REVIEW_MODE_ID, name: 'Review' }
    ];

    override prompts: PromptVariantSet[] = [{
        id: CALLISTO_SYSTEM_PROMPT_ID,
        defaultVariant: getCallistoAgentModePrompt(),
        variants: [getCallistoReviewModePrompt()]
    }, {
        id: CALLISTO_REQUEST_CONTEXT_ID,
        defaultVariant: getCallistoRequestContextPrompt()
    }];
    protected override systemPromptId: string | undefined = CALLISTO_SYSTEM_PROMPT_ID;

    /** Per chat request; dropped with the request. */
    protected readonly loopGuards = new WeakMap<MutableChatRequestModel, LoopGuardState>();
    protected readonly llmCalls = new WeakMap<MutableChatRequestModel, LlmCall>();
    /**
     * Messages that follow each request's own message: its context (changed files, open editors …) and any notice about
     * files changed outside. Resolved once, when the request is sent, and replayed unchanged in every later request so
     * that LM Studio's prompt cache keeps matching. Kept in memory: after a restart the first follow-up re-reads once.
     */
    protected readonly requestNotes = new Map<string, LanguageModelMessage[]>();
    /** The nudge sent after each interruption notice, replayed at the notice's place in later requests. */
    protected readonly nudges = new WeakMap<object, string>();
    /** Summaries being written, by chat session id. */
    protected readonly summarizing = new Map<string, Promise<boolean>>();
    /** The request a chat's last failed summary was to cover up to: not tried again until the chat has moved on. */
    protected readonly failedSummaries = new WeakMap<ChatModel, string>();

    /**
     * Replaces a server's raw "request exceeds the available context size" 400 with what happened and what to do,
     * in the chat and in the error notification alike. Everything else is handled as Theia does.
     */
    protected override handleError(request: MutableChatRequestModel, error: Error): void {
        const overflow = parseContextOverflow(error?.message);
        if (!overflow) {
            return super.handleError(request, error);
        }
        const modelId = this.llmCalls.get(request)?.languageModel.id ?? request.response.languageModel;
        const lmStudio = !!modelId?.startsWith(LM_STUDIO_PREFIX);
        const message = contextOverflowMessage(overflow, {
            model: modelId?.replace(/^[^/]+\//, ''),
            maxContext: this.localModels.getLmStudioInfo(modelId)?.context?.max,
            chatHasHistory: request.session.getRequests().length > 1 || request.response.response.content.length > 0,
            lmStudio
        });
        this.logger.warn('Request did not fit in the model\'s context window:', error.message);
        // No `cause`: Theia appends the cause chain's messages, which would bring the raw 400 back.
        super.handleError(request, Object.assign(new Error(message), { stack: error.stack }));
    }

    /**
     * Same as Theia's, except that the request gets its own cancellation, linked to the user's stop button, so the
     * loop breaker can stop the model without ending the chat request; and every tool goes through the loop guard.
     */
    protected override async sendLlmRequest(
        request: MutableChatRequestModel,
        messages: LanguageModelMessage[],
        toolRequests: ToolRequest[],
        deferredToolIds: string[] | undefined,
        languageModel: LanguageModel,
        promptVariantId?: string,
        isPromptVariantCustomized?: boolean,
        options: { lowReasoningUntilAction?: boolean } = {}
    ): Promise<LanguageModelResponse> {
        if (!this.llmCalls.has(request) && isLocalModel(languageModel)
            && await this.summarizeBeforeRequest(request, messages, toolRequests, deferredToolIds, languageModel)) {
            // The chat now starts with the summary: rebuild what this request sends.
            messages = [...messages.filter(message => message.actor === 'system'), ...await this.getMessages(request.session)];
        }
        const previous = this.llmCalls.get(request);
        previous?.cancellationLink.dispose();
        const cancellation = new CancellationTokenSource();
        const userToken = request.response.cancellationToken;
        const cancellationLink = userToken.onCancellationRequested(() => cancellation.cancel());
        if (userToken.isCancellationRequested) {
            cancellation.cancel();
        }
        this.llmCalls.set(request, {
            messages, tools: toolRequests, deferredToolIds, languageModel, promptVariantId, isPromptVariantCustomized, cancellation, cancellationLink
        });

        if (!carriesReasoning(languageModel)) {
            // Reasoning marked for LM Studio must never reach a provider that would take the marker for a real signature.
            messages = messages.filter(message => !isCarriedThinking(message));
        }
        const tools = this.deduplicateTools(toolRequests.map(tool => this.withLoopGuard(request, tool)));
        const { commonSettings, providerSettings } = this.getSessionSettings(request);
        let settings: Record<string, unknown> = { ...this.getLlmSettings(), ...providerSettings };
        if (options.lowReasoningUntilAction && supportsLowReasoning(languageModel)) {
            // The backend tool loop sends 'low' until the model acts, then the level resolved for this request
            // (see CallistoChatCompletionStream).
            settings = { ...settings, [LOW_REASONING_UNTIL_ACTION_SETTING]: true };
        }
        const vendor = languageModel.vendor;
        const enabledServerTools = vendor
            ? (request.request.serverToolSelections?.[vendor] ?? []).filter(id => languageModel.serverTools?.some(tool => tool.id === id))
            : [];
        return this.languageModelService.sendRequest(languageModel, {
            messages,
            tools: tools.length > 0 ? tools : undefined,
            deferredToolIds,
            serverTools: enabledServerTools.length > 0 ? enabledServerTools : undefined,
            settings,
            reasoning: commonSettings?.reasoning,
            compaction: commonSettings?.compaction,
            agentId: this.id,
            sessionId: request.session.id,
            requestId: request.id,
            cancellationToken: cancellation.token,
            promptVariantId,
            isPromptVariantCustomized
        });
    }

    // ---------------------------------------------------------------- loop breaker

    /**
     * Streams the model's work into the response, interrupting it when its reasoning loops or is about to fill the
     * context window. After an interruption the model is resumed with what it had worked out so far and a nudge to act;
     * the last resume runs at a low thinking level. If it still does not act, the task goes back to the user, with the
     * model's reasoning kept in the chat so that "continue" picks up from there.
     */
    protected override async addStreamResponse(languageModelResponse: LanguageModelStreamResponse, request: MutableChatRequestModel): Promise<void> {
        let response: LanguageModelResponse = languageModelResponse;
        // Interruptions in a row with no action in between.
        let attempts = 0;
        let triedLowReasoning = false;
        for (; ;) {
            if (!isLanguageModelStreamResponse(response)) {
                await super.addContentsToResponse(response, request);
                return;
            }
            const outcome = await this.streamWithLoopBreaker(response, request);
            const { verdict } = outcome;
            if (!verdict || request.response.cancellationToken.isCancellationRequested) {
                return;
            }
            if (outcome.acted) {
                // It made progress after the last nudge, so this is a new episode, not the same loop coming back.
                attempts = 0;
                triedLowReasoning = false;
            }
            attempts++;
            const context: NudgeContext = {
                step: this.currentTodoStep(request),
                hasTodoList: this.hasTodoList(request),
                reasoning: keptReasoning(outcome.reasoning, verdict),
                contextFull: outcome.contextFull
            };
            if (attempts > MAX_LOOP_RESUMES) {
                const handBack = new InformationalChatResponseContentImpl(
                    `Callisto paused the task: the model's reasoning ${describe(verdict, outcome.contextFull)} again, after ${MAX_LOOP_RESUMES} `
                    + `attempts to get it to act${triedLowReasoning ? ' (the last one at a low thinking level)' : ''}. Its work and what it had `
                    + 'worked out are kept in this chat. Reply "continue" to let it carry on, or give it a smaller first step.');
                request.response.response.addContent(handBack);
                // Replayed before the user's next message, so that "continue" starts from the model's reasoning, not from zero.
                this.nudges.set(handBack, nudgeFor(verdict, { ...context, pausedForUser: true }));
                return;
            }
            const lastAttempt = attempts === MAX_LOOP_RESUMES;
            const lowReasoning = lastAttempt && supportsLowReasoning(this.llmCalls.get(request)?.languageModel);
            triedLowReasoning ||= lowReasoning;
            const notice = new InformationalChatResponseContentImpl(
                `Callisto interrupted the model because its reasoning ${describe(verdict, outcome.contextFull)}. It keeps what it had worked `
                + `out and is asked to act${lowReasoning ? ', this time at a low thinking level until its first action' : ''}.`);
            request.response.response.addContent(notice);
            response = await this.resume(request, nudgeFor(verdict, { ...context, lastAttempt }), notice, lowReasoning);
        }
    }

    /**
     * Streams one model call into the response, cancelling it as soon as the reasoning loops or would fill the context.
     * @returns the verdict that stopped it, if any; whether the model acted (called a tool or wrote text) before that;
     *   the interrupted block of reasoning; and whether the limit it hit was the room left in the context window.
     */
    protected async streamWithLoopBreaker(
        response: LanguageModelStreamResponse, request: MutableChatRequestModel
    ): Promise<{ verdict?: ThinkingLoopVerdict; acted: boolean; reasoning: string; contextFull: boolean }> {
        if (!this.preferences.get<boolean>(LOOP_BREAKER_PREF, true)) {
            await super.addStreamResponse(response, request);
            return { acted: true, reasoning: '', contextFull: false };
        }
        const call = this.llmCalls.get(request);
        // One detector per block of reasoning, created when the block starts: by then the token usage of the previous
        // model call is known, so the room left in the context window is up to date.
        let detector: ThinkingLoopDetector | undefined;
        let contextFull = false;
        let verdict: ThinkingLoopVerdict | undefined;
        let acted = false;
        const startBlock = (): ThinkingLoopDetector => {
            const limit = this.thinkingLimit(request);
            contextFull = limit.contextFull;
            return new ThinkingLoopDetector({ maxChars: limit.maxChars });
        };
        async function* watched(): AsyncIterable<unknown> {
            for await (const part of response.stream) {
                if (isThinkingResponsePart(part)) {
                    detector ??= startBlock();
                    verdict = detector.push(part.thought);
                } else if (isToolCallResponsePart(part) || (isTextResponsePart(part) && part.content.trim().length > 0)) {
                    // A tool call or answer text: the model acted, so a new block of reasoning starts after it. Other
                    // parts (empty deltas the OpenAI stream sends between reasoning chunks, usage) are not actions.
                    acted = true;
                    detector = undefined;
                }
                yield part;
                if (verdict) {
                    call?.cancellation.cancel();
                    return;
                }
            }
        }
        await super.addStreamResponse({ ...response, stream: watched() } as LanguageModelStreamResponse, request);
        // `detector` is assigned inside the generator; TypeScript cannot see that.
        const interrupted = detector as ThinkingLoopDetector | undefined;
        return { verdict, acted, reasoning: verdict ? interrupted?.reasoning ?? '' : '', contextFull };
    }

    /**
     * How much the model may reason before its next action: the user's limit, if one is set, and the room left in the
     * context window. There is no limit of Callisto's own: left alone, Inkling plans for up to ~150k characters and then
     * acts, while interrupting it earlier only made it plan again.
     */
    protected thinkingLimit(request: MutableChatRequestModel): { maxChars: number; contextFull: boolean } {
        const capTokens = Math.max(0, this.preferences.get<number>(MAX_THINKING_TOKENS_PREF, 0) ?? 0);
        const roomTokens = this.contextRoomTokens(request);
        if (roomTokens === undefined || (capTokens > 0 && capTokens <= roomTokens)) {
            return { maxChars: Math.round(capTokens * CEILING_CHARS_PER_TOKEN), contextFull: false };
        }
        return { maxChars: Math.round(roomTokens * CEILING_CHARS_PER_TOKEN), contextFull: true };
    }

    /** Tokens left for reasoning in the context window the model is loaded with; undefined when that is not known. */
    protected contextRoomTokens(request: MutableChatRequestModel): number | undefined {
        const call = this.llmCalls.get(request);
        const loaded = this.localModels.getLmStudioInfo(call?.languageModel.id)?.context?.loaded;
        if (!loaded || !call) {
            return undefined;
        }
        const usage = request.response.tokenUsage;
        const used = usage && usage.inputTokens > 0
            ? usage.inputTokens + usage.outputTokens
            : Math.round(JSON.stringify(call.messages).length / CEILING_CHARS_PER_TOKEN);
        return Math.max(MIN_THINKING_ROOM_TOKENS, Math.floor(loaded * CONTEXT_CEILING_RATIO) - used);
    }

    /**
     * Sends the request again with everything done so far in this task (tool calls and their results, the reasoning
     * that led to them) plus the nudge, which carries what the model had worked out before the interruption. The nudge
     * is tied to the interruption notice, so that `getMessages` replays it in that place from now on.
     */
    protected async resume(
        request: MutableChatRequestModel, nudge: string, notice: object, lowReasoningUntilAction: boolean
    ): Promise<LanguageModelResponse> {
        const call = this.llmCalls.get(request);
        if (!call) {
            throw new Error('Callisto: no model call to resume.');
        }
        this.nudges.set(notice, nudge);
        const system = call.messages.filter(message => message.actor === 'system');
        const history = await this.getMessages(request.session, true);
        return this.sendLlmRequest(
            request, [...system, ...history], call.tools, call.deferredToolIds, call.languageModel,
            call.promptVariantId, call.isPromptVariantCustomized, { lowReasoningUntilAction }
        );
    }

    // ---------------------------------------------------------------- history that matches LM Studio's prompt cache

    /**
     * Theia's history, rebuilt so that it matches what the model was actually sent, token for token. LM Studio reuses
     * its cached prompt only up to the first difference, so every mismatch here means re-reading the conversation from
     * that point (minutes, on a long task). Differences from Theia's version:
     * - each request is followed by the context and notices that were sent with it ({@link requestNotes});
     * - reasoning that led to a tool call is kept, marked with {@link CALLISTO_REASONING_SIGNATURE}, because the backend
     *   tool loop sent it back to the model (Theia drops all reasoning without a provider signature);
     * - the nudge after an interruption is replayed where the interruption notice is.
     */
    protected override async getMessages(model: ChatModel, includeResponseInProgress = false): Promise<LanguageModelMessage[]> {
        return this.historyMessages(model, model.getRequests(), includeResponseInProgress);
    }

    /**
     * The messages for the given requests of a chat, as {@link getMessages} describes; when a Callisto summary covers some
     * of them, the summary stands in for those.
     */
    protected async historyMessages(
        model: ChatModel, requests: readonly ChatRequestModel[], includeResponseInProgress = false
    ): Promise<LanguageModelMessage[]> {
        const messages: LanguageModelMessage[] = [];
        const summary = latestSummary(requests);
        if (summary) {
            messages.push({ actor: 'user', type: 'text', text: summaryMessage(summary.part.summary ?? '', summary.data) });
        }
        for (const request of requests.slice(summary ? summary.index + 1 : 0)) {
            const text = request.message.parts.map(part => part.promptText).join('');
            if (text.length > 0) {
                messages.push({ actor: 'user', type: 'text', text });
            }
            messages.push(...imageMessages(request));
            const isCurrent = request === requests[requests.length - 1] && !request.response.isComplete;
            messages.push(...await this.notesFor(request, model, isCurrent));
            if (request.response.isComplete || includeResponseInProgress) {
                messages.push(...this.responseMessages(request));
            }
        }
        return messages;
    }

    /** Context for a request, resolved the first time the request is sent and replayed unchanged afterwards. */
    protected async notesFor(request: ChatRequestModel, model: ChatModel, isCurrent: boolean): Promise<LanguageModelMessage[]> {
        let notes = this.requestNotes.get(request.id);
        if (!notes && isCurrent) {
            const resolved = await this.promptService.getResolvedPromptFragment(
                CALLISTO_REQUEST_CONTEXT_ID, undefined, { model, request: request as MutableChatRequestModel });
            const text = resolved?.text.trim();
            notes = text ? [{ actor: 'user', type: 'text', text: `[Callisto] Context for this request:\n\n${text}` }] : [];
            this.requestNotes.set(request.id, notes);
        }
        return notes ?? [];
    }

    /**
     * Theia appends a notice about files changed outside the agent to the end of the request. Record it with the
     * request's notes instead, so that later requests contain it in the same place.
     */
    protected override async appendExternalFileChangeNotice(request: MutableChatRequestModel, messages: LanguageModelMessage[]): Promise<void> {
        const notices: LanguageModelMessage[] = [];
        await super.appendExternalFileChangeNotice(request, notices);
        if (notices.length > 0) {
            this.requestNotes.set(request.id, [...this.requestNotes.get(request.id) ?? [], ...notices]);
            messages.push(...notices);
        }
    }

    protected responseMessages(request: ChatRequestModel): LanguageModelMessage[] {
        const content = request.response.response.content;
        const carried = carriedThinking(content);
        const messages: LanguageModelMessage[] = [];
        for (const part of content) {
            if (InformationalChatResponseContent.is(part)) {
                const nudge = this.nudges.get(part);
                if (nudge) {
                    messages.push({ actor: 'user', type: 'text', text: nudge });
                }
                continue;
            }
            if (ErrorChatResponseContent.is(part) || ProgressChatResponseContent.is(part) || isCallistoSummary(part)) {
                // Errors and progress are for the user only; a summary is sent in place of what it covers (historyMessages).
                continue;
            }
            if (ThinkingChatResponseContent.is(part)) {
                if (part.signature) {
                    messages.push({ actor: 'ai', type: 'thinking', thinking: part.content, signature: part.signature });
                } else if (carried.has(part)) {
                    messages.push({ actor: 'ai', type: 'thinking', thinking: part.content, signature: CALLISTO_REASONING_SIGNATURE });
                }
                continue;
            }
            if (ChatResponseContent.hasToLanguageModelMessage(part)) {
                const converted = part.toLanguageModelMessage();
                messages.push(...(Array.isArray(converted) ? converted : [converted]));
            } else if (!(ChatResponseContent.hasAsString(part) && part.asString() === undefined)) {
                messages.push({ actor: 'ai', type: 'text', text: part.asString?.() || part.asDisplayString?.() || '' });
            }
        }
        return messages;
    }

    /** The step the model's todo list marks as in progress (or else the next pending one), from its latest `todoWrite`. */
    protected currentTodoStep(request: MutableChatRequestModel): string | undefined {
        const content = request.response.response.content;
        for (let i = content.length - 1; i >= 0; i--) {
            const part = content[i];
            if (ToolCallChatResponseContent.is(part) && part.name === TODO_WRITE_FUNCTION_ID && part.arguments) {
                try {
                    const todos = (JSON.parse(part.arguments) as { todos?: { content?: unknown; status?: unknown }[] }).todos ?? [];
                    const step = todos.find(todo => todo.status === 'in_progress') ?? todos.find(todo => todo.status === 'pending');
                    return typeof step?.content === 'string' ? step.content : undefined;
                } catch {
                    return undefined;
                }
            }
        }
        return undefined;
    }

    /** Whether the model has written a todo list in this task. */
    protected hasTodoList(request: MutableChatRequestModel): boolean {
        return request.response.response.content.some(part => ToolCallChatResponseContent.is(part) && part.name === TODO_WRITE_FUNCTION_ID);
    }

    // ---------------------------------------------------------------- summaries of long chats

    /**
     * Once a chat with a local model is long, summarizes it right after the model's reply, while LM Studio still holds
     * the whole chat in its prompt cache: the summary request is that same prompt plus one instruction, so only the
     * instruction and the summary itself are new work. Without this, the next message after LM Studio restarts or unloads
     * the model (an idle hour, by default) re-reads the whole chat, which took over 6 minutes for 65k tokens.
     */
    protected override async onResponseComplete(request: MutableChatRequestModel): Promise<void> {
        await super.onResponseComplete(request);
        const call = this.llmCalls.get(request);
        const requests = request.session.getRequests();
        if (!call || !isLocalModel(call.languageModel) || request.response.isError || requests[requests.length - 1] !== request
            || this.summarizing.has(request.session.id) || !this.needsSummary(request.session, requests, call.languageModel)) {
            return;
        }
        const session = request.session;
        const system = call.messages.filter(message => message.actor === 'system');
        const job = this.summarize(session, requests, {
            system, tools: call.tools, deferredToolIds: call.deferredToolIds, languageModel: call.languageModel, settingsFrom: request
        }, CancellationToken.None).finally(() => this.summarizing.delete(session.id));
        this.summarizing.set(session.id, job);
    }

    /**
     * Before the first model call of a request: waits for a summary still being written, or writes one now if the chat
     * before this request is long and has none (a chat from before a restart, or one whose last reply ended in an error).
     * @returns whether the chat now has a newer summary, so that the request's messages have to be rebuilt.
     */
    protected async summarizeBeforeRequest(
        request: MutableChatRequestModel, messages: LanguageModelMessage[], tools: ToolRequest[], deferredToolIds: string[] | undefined,
        languageModel: LanguageModel
    ): Promise<boolean> {
        const session = request.session;
        const all = session.getRequests();
        const earlier = all.slice(0, Math.max(0, all.indexOf(request)));
        const before = latestSummary(earlier)?.part;
        const token = request.response.cancellationToken;
        let progress: ChatResponseContent | undefined;
        const showProgress = (message: string): void => {
            if (!progress) {
                progress = new ProgressChatResponseContentImpl(message);
                request.response.response.addContent(progress);
            }
        };
        try {
            const pending = this.summarizing.get(session.id);
            if (pending) {
                showProgress('Callisto is finishing its summary of the earlier conversation…');
                await Promise.race([pending, whenCancelled(token)]);
            }
            if (!token.isCancellationRequested && earlier.length > 0 && this.needsSummary(session, earlier, languageModel)) {
                const tokens = unsummarizedTokens(earlier);
                showProgress(`Callisto is summarizing the earlier conversation${tokens ? ` (${tokens.toLocaleString('en-US')} tokens)` : ''}, `
                    + 'so that this request and the next ones start short…');
                await this.summarize(session, earlier, {
                    system: messages.filter(message => message.actor === 'system'), tools, deferredToolIds, languageModel, settingsFrom: request
                }, token);
            }
        } finally {
            if (progress) {
                removeContent(request, progress);
            }
        }
        return latestSummary(earlier)?.part !== before;
    }

    /** Whether the part of the chat no summary covers yet is past the size from which Callisto summarizes. */
    protected needsSummary(session: ChatModel, requests: readonly ChatRequestModel[], languageModel: LanguageModel): boolean {
        const threshold = summarizeThreshold(
            this.preferences.get<number>(SUMMARIZE_AFTER_TOKENS_PREF), this.localModels.getLmStudioInfo(languageModel.id)?.context?.loaded);
        const tokens = unsummarizedTokens(requests);
        const last = requests[requests.length - 1];
        return threshold !== undefined && tokens !== undefined && tokens >= threshold && !!last && this.failedSummaries.get(session) !== last.id;
    }

    /**
     * Asks the model for a summary of the given requests (the chat up to and including the last of them) and stores it
     * in the last one's response. The prompt is the chat exactly as the agent sends it, same system message and tools,
     * plus an instruction at the end, so LM Studio reuses its cache for all but the instruction. Tool calls are answered
     * with "write the summary", and the files changed and the todo list are taken from the tool calls, not the model.
     * @returns whether a summary was stored. On failure the chat goes on unsummarized.
     */
    protected async summarize(session: ChatModel, covered: readonly ChatRequestModel[], call: SummaryCall, token: CancellationToken): Promise<boolean> {
        const last = covered[covered.length - 1] as MutableChatRequestModel | undefined;
        if (!last) {
            return false;
        }
        const earlier = latestSummary(covered);
        const tokensBefore = unsummarizedTokens(covered);
        const started = Date.now();
        const source = new CancellationTokenSource();
        const link = token.onCancellationRequested(() => source.cancel());
        try {
            let messages: LanguageModelMessage[] = [
                ...call.system,
                ...await this.historyMessages(session, covered),
                { actor: 'user', type: 'text', text: summaryInstruction(!!earlier) }
            ];
            if (!carriesReasoning(call.languageModel)) {
                messages = messages.filter(message => !isCarriedThinking(message));
            }
            const tools = this.deduplicateTools(call.tools.map(tool => ({ ...tool, handler: async () => TOOLS_OFF_WHILE_SUMMARIZING })));
            const { commonSettings, providerSettings } = this.getSessionSettings(call.settingsFrom);
            const settings: Record<string, unknown> = { ...this.getLlmSettings(), ...providerSettings };
            if (call.languageModel.id.startsWith(LM_STUDIO_PREFIX)) {
                settings.max_tokens = SUMMARY_MAX_TOKENS;
            }
            if (supportsLowReasoning(call.languageModel)) {
                // The backend sends 'low' for this request (it never acts, so the level is not put back).
                settings[LOW_REASONING_UNTIL_ACTION_SETTING] = true;
            }
            const response = await this.languageModelService.sendRequest(call.languageModel, {
                messages,
                tools: tools.length > 0 ? tools : undefined,
                deferredToolIds: call.deferredToolIds,
                settings,
                reasoning: commonSettings?.reasoning,
                agentId: this.id,
                sessionId: session.id,
                requestId: last.id,
                subRequestId: `${last.id}.callisto-summary`,
                cancellationToken: source.token
            });
            const summary = cleanSummary(await readSummaryReply(response, source));
            if (!summary || token.isCancellationRequested) {
                if (!token.isCancellationRequested) {
                    this.failedSummaries.set(session, last.id);
                    this.logger.warn('Callisto: the model did not write a usable summary; the chat goes on unsummarized.');
                }
                return false;
            }
            const since = covered.slice(earlier ? earlier.index + 1 : 0);
            const data: CallistoSummaryData = {
                version: 1,
                coveredRequestId: last.id,
                tokensBefore,
                files: changedFiles(fileChangeArguments(since), earlier?.data.files),
                todos: latestTodos(since) ?? earlier?.data.todos
            };
            last.response.response.addContent(new CompactionChatResponseContentImpl(CALLISTO_SUMMARY_PROVIDER, data, summary));
            this.logger.info(`Callisto: summarized ${covered.length} requests (${tokensBefore ?? '?'} tokens) in ${Math.round((Date.now() - started) / 1000)} s.`);
            return true;
        } catch (error) {
            if (!token.isCancellationRequested) {
                this.failedSummaries.set(session, last.id);
                this.logger.warn('Callisto: summarizing the chat failed; it goes on unsummarized.', error);
            }
            return false;
        } finally {
            link.dispose();
            source.dispose();
        }
    }

    // ---------------------------------------------------------------- loop guard on tool calls

    protected withLoopGuard(request: MutableChatRequestModel, tool: ToolRequest): ToolRequest {
        return {
            ...tool,
            handler: async (argString, ctx) => {
                const state = this.guardStateFor(request);
                state.totalCalls++;
                if (state.totalCalls > MAX_TOOL_CALLS_PER_REQUEST) {
                    return `Callisto step limit: this task has used ${MAX_TOOL_CALLS_PER_REQUEST} tool calls. Do not call any more tools. `
                        + 'Reply to the user now: what is done, what is not, and what you would do next.';
                }
                const signature = `${tool.id}\u0000${normalizeArguments(argString)}`;
                const count = (state.identicalCalls.get(signature) ?? 0) + 1;
                state.identicalCalls.set(signature, count);
                if (count >= MAX_IDENTICAL_CALLS) {
                    return `Callisto loop guard: you already called ${tool.name} with exactly these arguments ${count - 1} times, and nothing `
                        + 'has changed since, so the result would be the same. Do not repeat this call. Use the result you already have, '
                        + 'or try a different approach.';
                }
                if (FULL_WRITE_TOOLS.has(tool.id)) {
                    const path = pathArgument(argString);
                    if (path) {
                        const writes = (state.fullWrites.get(path) ?? 0) + 1;
                        if (writes > MAX_FULL_WRITES_PER_FILE) {
                            return `Callisto loop guard: ${path} has already been written in full ${writes - 1} times in this task. Do not rewrite `
                                + 'it again. If a specific bug remains, fix just that part with a targeted replacement; otherwise move on to the next step.';
                        }
                        state.fullWrites.set(path, writes);
                    }
                }
                const result = await tool.handler(argString, ctx);
                if (STATE_CHANGING_TOOLS.has(tool.id)) {
                    state.identicalCalls.clear();
                }
                if (tool.id === SHELL_EXECUTION_FUNCTION_ID) {
                    state.lastRunFailed = commandFailed(result) ?? state.lastRunFailed;
                }
                if (DISK_WRITE_TOOLS.has(tool.id) && typeof result === 'string' && /^\s*success/i.test(result)) {
                    const notes = await this.notesAfterWrite(argString, state);
                    return notes ? `${result}\n\n${notes}` : result;
                }
                return result;
            }
        };
    }

    /**
     * Feedback appended to the result of a file write. A local model follows the result of the call it just made far more
     * closely than a rule in its system prompt, so this is where "does it parse", "now run it" and "you just changed a
     * failing test" are said.
     */
    protected async notesAfterWrite(argString: string, state: LoopGuardState): Promise<string | undefined> {
        const path = pathArgument(argString);
        if (!path) {
            return undefined;
        }
        const notes: string[] = [];
        const check = await this.checkSyntax(path);
        if (check?.checked) {
            notes.push(check.ok
                ? `Callisto syntax check (${check.checker}): OK.`
                : `Callisto syntax check (${check.checker}) FAILED. Fix this before anything else:\n${check.message ?? ''}`);
        }
        if (TEST_FILE.test(path) && state.lastRunFailed) {
            notes.push(TEST_CHANGED_NOTE);
        } else if (CODE_FILE.test(path) && check?.ok !== false) {
            notes.push(RUN_IT_NOTE);
        }
        return notes.length > 0 ? notes.join('\n') : undefined;
    }

    protected async checkSyntax(path: string): Promise<SyntaxCheckResult | undefined> {
        try {
            const uri = await this.workspaceScope.resolveAccessiblePath(path);
            return uri.scheme === 'file' ? await this.syntaxCheckService.check(uri.path.fsPath()) : undefined;
        } catch {
            // Unresolvable path or backend unavailable: the write itself succeeded, so just say nothing.
            return undefined;
        }
    }

    protected guardStateFor(request: MutableChatRequestModel): LoopGuardState {
        let state = this.loopGuards.get(request);
        if (!state) {
            state = { identicalCalls: new Map(), fullWrites: new Map(), totalCalls: 0, lastRunFailed: false };
            this.loopGuards.set(request, state);
        }
        return state;
    }
}

function isCarriedThinking(message: LanguageModelMessage): boolean {
    return message.type === 'thinking' && (message as { signature?: string }).signature === CALLISTO_REASONING_SIGNATURE;
}

/** LM Studio models, which Callisto registers as `lmstudio/<id>` on the OpenAI-compatible provider. */
function carriesReasoning(languageModel: LanguageModel): boolean {
    return languageModel.id.startsWith('lmstudio/');
}

/**
 * Whether the agent can send one request at a low thinking level and have the backend put the level back afterwards:
 * LM Studio models (served through Callisto's tool loop, which handles that) that offer a 'low' level.
 */
function supportsLowReasoning(languageModel: LanguageModel | undefined): boolean {
    return !!languageModel && carriesReasoning(languageModel) && !!languageModel.reasoningSupport?.supportedLevels.includes('low');
}

/** Models served on this machine (LM Studio, Ollama), where a long chat costs minutes to read again. */
function isLocalModel(languageModel: LanguageModel): boolean {
    return languageModel.id.startsWith(LM_STUDIO_PREFIX) || languageModel.id.startsWith('ollama/');
}

function isCallistoSummary(part: ChatResponseContent): part is CompactionChatResponseContent {
    return CompactionChatResponseContent.is(part) && part.provider === CALLISTO_SUMMARY_PROVIDER;
}

/** The latest Callisto summary among the given requests: the one in the response of the request it covers up to. */
function latestSummary(requests: readonly ChatRequestModel[]): ChatSummary | undefined {
    for (let index = requests.length - 1; index >= 0; index--) {
        const content = requests[index].response.response.content;
        for (let i = content.length - 1; i >= 0; i--) {
            const part = content[i];
            if (isCallistoSummary(part) && isCallistoSummaryData(part.data) && part.data.coveredRequestId === requests[index].id) {
                return { part, data: part.data, index };
            }
        }
    }
    return undefined;
}

/**
 * Tokens of the part of the chat no summary covers yet: what the latest model call after the latest summary read plus
 * wrote, which is what the next call starts from. Undefined when no call after the summary reported its usage.
 */
function unsummarizedTokens(requests: readonly ChatRequestModel[]): number | undefined {
    const summary = latestSummary(requests);
    for (let index = requests.length - 1; index > (summary?.index ?? -1); index--) {
        const usage = latestUsage(requests[index].response);
        if (usage && usage.inputTokens > 0) {
            return usage.inputTokens + usage.outputTokens;
        }
    }
    return undefined;
}

/** Usage of the response's latest model call. Theia keeps every call's usage, but its interface exposes only the latest. */
function latestUsage(response: ChatResponseModel): ResponseTokenUsage | undefined {
    const entries = (response as { tokenUsageEntries?: readonly ResponseTokenUsage[] }).tokenUsageEntries;
    return entries?.[entries.length - 1] ?? response.tokenUsage;
}

/** Arguments of every call that changed a file, in order. */
function fileChangeArguments(requests: readonly ChatRequestModel[]): string[] {
    return requests.flatMap(request => request.response.response.content
        .filter(part => ToolCallChatResponseContent.is(part) && FILE_CHANGE_TOOLS.has(part.name ?? '') && !!part.arguments)
        .map(part => (part as ToolCallChatResponseContent).arguments as string));
}

/** The model's latest todo list in the given requests. */
function latestTodos(requests: readonly ChatRequestModel[]): TodoItem[] | undefined {
    for (let index = requests.length - 1; index >= 0; index--) {
        const content = requests[index].response.response.content;
        for (let i = content.length - 1; i >= 0; i--) {
            const part = content[i];
            if (ToolCallChatResponseContent.is(part) && part.name === TODO_WRITE_FUNCTION_ID) {
                const todos = parseTodos(part.arguments);
                if (todos) {
                    return todos;
                }
            }
        }
    }
    return undefined;
}

/**
 * The text of the model's reply to the summary instruction. Gives up (empty text) when the model reasons far longer
 * than a summary needs, which means it went back to the task, and stops reading once there is more than a summary.
 */
async function readSummaryReply(response: LanguageModelResponse, source: CancellationTokenSource): Promise<string> {
    if (isLanguageModelTextResponse(response)) {
        return response.text;
    }
    if (!isLanguageModelStreamResponse(response)) {
        return '';
    }
    let text = '';
    let thinking = 0;
    for await (const part of response.stream) {
        if (isThinkingResponsePart(part)) {
            thinking += part.thought.length;
            if (thinking > MAX_SUMMARY_THINKING_CHARS) {
                source.cancel();
                return '';
            }
        } else if (isTextResponsePart(part)) {
            text += part.content;
            if (text.length > MAX_SUMMARY_CHARS * 2) {
                source.cancel();
                break;
            }
        }
    }
    return text;
}

function whenCancelled(token: CancellationToken): Promise<void> {
    return new Promise(resolve => {
        if (token.isCancellationRequested) {
            resolve();
        } else {
            token.onCancellationRequested(() => resolve());
        }
    });
}

/** Takes one part out of a response (the response has no API for that). */
function removeContent(request: MutableChatRequestModel, part: ChatResponseContent): void {
    const response = request.response.response;
    const rest = response.content.filter(other => other !== part);
    if (rest.length !== response.content.length) {
        response.clearContent();
        if (rest.length > 0) {
            response.addContents(rest);
        }
    }
}

/** The request's images, as Theia's own history adds them. */
function imageMessages(request: ChatRequestModel): LanguageModelMessage[] {
    const fromContext = request.context.variables
        .filter(variable => ImageContextVariable.isResolvedImageContext(variable))
        .map(variable => ImageContextVariable.parseResolved(variable))
        .filter((image): image is NonNullable<typeof image> => image !== undefined);
    const seen = new Set(fromContext.map(image => image.data));
    const inline = ImageContextVariable.extractInlineImages(request.message.parts).filter(image => !seen.has(image.data));
    return [...fromContext, ...inline].map((image): LanguageModelMessage => ({
        actor: 'user', type: 'image', image: { base64data: image.data, mimeType: image.mimeType }
    }));
}

/** The same arguments in a different key order or spacing count as the same call. */
function normalizeArguments(argString: string): string {
    try {
        return JSON.stringify(sortKeys(JSON.parse(argString)));
    } catch {
        return argString.trim();
    }
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
    }
    return value;
}

function pathArgument(argString: string): string | undefined {
    try {
        const args = JSON.parse(argString) as { path?: unknown; file?: unknown };
        const path = args.path ?? args.file;
        return typeof path === 'string' ? path.replace(/^\.\//, '') : undefined;
    } catch {
        return undefined;
    }
}
