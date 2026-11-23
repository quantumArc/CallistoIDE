/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationTokenSource, Disposable, PreferenceService } from '@theia/core';
import {
    ChatModel, ChatMode, ChatRequestModel, ChatResponseContent, ErrorChatResponseContent, InformationalChatResponseContent,
    InformationalChatResponseContentImpl, MutableChatRequestModel, ThinkingChatResponseContent, ToolCallChatResponseContent
} from '@theia/ai-chat/lib/common';
import { ImageContextVariable } from '@theia/ai-chat/lib/common/image-context-variable';
import {
    isLanguageModelStreamResponse, isTextResponsePart, isThinkingResponsePart, isToolCallResponsePart, LanguageModel, LanguageModelMessage,
    LanguageModelRequirement, LanguageModelResponse, LanguageModelStreamResponse, PromptVariantSet, ToolRequest
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
import { CALLISTO_REASONING_SIGNATURE, keepEnd } from '../common/reasoning-text.js';
import { carriedThinking } from '../common/carried-thinking.js';
import { CHARS_PER_TOKEN, commandFailed, describe, NudgeContext, nudgeFor, RESUME_THINKING_TOKENS } from '../common/callisto-nudges.js';
import { SyntaxCheckResult, SyntaxCheckService } from '../common/syntax-check-protocol.js';
import { LOOP_BREAKER_PREF, MAX_THINKING_TOKENS_PREF } from './callisto-agent-preferences.js';

export const CALLISTO_AGENT_ID = 'Callisto';

/** The same tool with the same arguments is answered from the guard from this call on, until something changes. */
const MAX_IDENTICAL_CALLS = 3;
/** Tool calls allowed for one chat request before the agent is told to stop and report. */
const MAX_TOOL_CALLS_PER_REQUEST = 100;
/** Full rewrites of one file allowed per chat request (writing it the first time counts). */
const MAX_FULL_WRITES_PER_FILE = 2;
/** Times one chat request may be interrupted and resumed for looping reasoning before Callisto stops it. */
const MAX_LOOP_RESUMES = 2;
/** Reasoning from earlier in the task that is handed back with the nudge, so the model does not plan everything again. */
const EARLIER_REASONING_NOTE_CHARS = 3000;

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

/**
 * Callisto's coding agent: a harness tuned for local models such as Inkling 2 Mini.
 *
 * On top of Theia's agent loop it adds:
 * - a short, loop-shaped system prompt (see `callisto-agent-prompts.ts`);
 * - a **loop breaker**: the reasoning is watched while it streams, and when it starts going in circles or runs far
 *   too long, the model call is cancelled and resumed with everything done so far plus a nudge to act. On a long
 *   chess-app task this would have cut a 16-minute self-review loop short;
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
        isPromptVariantCustomized?: boolean
    ): Promise<LanguageModelResponse> {
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
        const vendor = languageModel.vendor;
        const enabledServerTools = vendor
            ? (request.request.serverToolSelections?.[vendor] ?? []).filter(id => languageModel.serverTools?.some(tool => tool.id === id))
            : [];
        return this.languageModelService.sendRequest(languageModel, {
            messages,
            tools: tools.length > 0 ? tools : undefined,
            deferredToolIds,
            serverTools: enabledServerTools.length > 0 ? enabledServerTools : undefined,
            settings: { ...this.getLlmSettings(), ...providerSettings },
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

    protected override async addStreamResponse(languageModelResponse: LanguageModelStreamResponse, request: MutableChatRequestModel): Promise<void> {
        let response: LanguageModelResponse = languageModelResponse;
        let resumes = 0;
        for (; ; resumes++) {
            if (!isLanguageModelStreamResponse(response)) {
                await super.addContentsToResponse(response, request);
                return;
            }
            const { verdict, acted } = await this.streamWithLoopBreaker(response, request, resumes > 0);
            if (!verdict || request.response.cancellationToken.isCancellationRequested) {
                return;
            }
            if (acted) {
                // It made progress after the last nudge, so this is a new episode, not the same loop coming back.
                resumes = 0;
            }
            if (resumes >= MAX_LOOP_RESUMES) {
                request.response.response.addContent(new InformationalChatResponseContentImpl(
                    `Callisto stopped the model: its reasoning ${describe(verdict)} again, after ${MAX_LOOP_RESUMES} nudges to act. `
                    + 'The work done so far is kept. Try a smaller step, a lower thinking level, or more specific instructions.'));
                return;
            }
            const notice = new InformationalChatResponseContentImpl(
                `Callisto interrupted the model because its reasoning ${describe(verdict)}, and asked it to take the next concrete step.`);
            request.response.response.addContent(notice);
            response = await this.resume(request, verdict, notice);
        }
    }

    /**
     * Streams one model call into the response, cancelling it as soon as the reasoning loops. A call that resumes after
     * an interruption gets only {@link RESUME_THINKING_TOKENS} of reasoning before its first action.
     * @returns the verdict that stopped it, if any, and whether the model acted (called a tool or wrote text) before that.
     */
    protected async streamWithLoopBreaker(
        response: LanguageModelStreamResponse, request: MutableChatRequestModel, resumed: boolean
    ): Promise<{ verdict?: ThinkingLoopVerdict; acted: boolean }> {
        if (!this.preferences.get<boolean>(LOOP_BREAKER_PREF, true)) {
            await super.addStreamResponse(response, request);
            return { acted: true };
        }
        const maxTokens = this.preferences.get<number>(MAX_THINKING_TOKENS_PREF, 16000);
        const maxChars = Math.round(maxTokens * CHARS_PER_TOKEN);
        // 0 disables the length check; the tighter first-step budget must not switch it back on.
        const firstStepChars = resumed && maxChars > 0 ? Math.min(maxChars, Math.round(RESUME_THINKING_TOKENS * CHARS_PER_TOKEN)) : maxChars;
        let detector = new ThinkingLoopDetector({ maxChars: firstStepChars });
        const call = this.llmCalls.get(request);
        let verdict: ThinkingLoopVerdict | undefined;
        let acted = false;
        async function* watched(): AsyncIterable<unknown> {
            for await (const part of response.stream) {
                if (isThinkingResponsePart(part)) {
                    verdict = detector.push(part.thought);
                } else if (isToolCallResponsePart(part) || (isTextResponsePart(part) && part.content.trim().length > 0)) {
                    // A tool call or answer text: the model acted, so a new block of reasoning starts after it. Other
                    // parts (empty deltas the OpenAI stream sends between reasoning chunks, usage) are not actions.
                    if (acted) {
                        detector.reset();
                    } else {
                        acted = true;
                        detector = new ThinkingLoopDetector({ maxChars });
                    }
                }
                yield part;
                if (verdict) {
                    call?.cancellation.cancel();
                    return;
                }
            }
        }
        await super.addStreamResponse({ ...response, stream: watched() } as LanguageModelStreamResponse, request);
        return { verdict, acted };
    }

    /**
     * Sends the request again with everything done so far in this task (tool calls and their results, the reasoning
     * that led to them) but without the looping reasoning, plus a nudge to act. The nudge names the current step of the
     * todo list and hands back the end of the model's earlier reasoning, so that it does not plan the whole task again.
     * The nudge is tied to the interruption notice, so that `getMessages` replays it in that place from now on.
     */
    protected async resume(request: MutableChatRequestModel, verdict: ThinkingLoopVerdict, notice: object): Promise<LanguageModelResponse> {
        const call = this.llmCalls.get(request);
        if (!call) {
            throw new Error('Callisto: no model call to resume.');
        }
        const context: NudgeContext = { step: this.currentTodoStep(request), earlierReasoning: this.earlierReasoning(request) };
        this.nudges.set(notice, nudgeFor(verdict, context));
        const system = call.messages.filter(message => message.actor === 'system');
        const history = await this.getMessages(request.session, true);
        return this.sendLlmRequest(
            request, [...system, ...history], call.tools, call.deferredToolIds, call.languageModel,
            call.promptVariantId, call.isPromptVariantCustomized
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
        const requests = model.getRequests();
        const messages: LanguageModelMessage[] = [];
        for (const request of requests) {
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
            if (ErrorChatResponseContent.is(part)) {
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

    /** The end of the reasoning this task produced before the block that was just interrupted. */
    protected earlierReasoning(request: MutableChatRequestModel): string | undefined {
        const blocks = request.response.response.content
            .filter(ThinkingChatResponseContent.is)
            .map(part => part.content.trim())
            .filter(text => text.length > 0);
        // The last block is the one that looped: leave it out.
        const earlier = blocks.slice(0, -1).slice(-2).join('\n\n');
        return earlier ? keepEnd(earlier, EARLIER_REASONING_NOTE_CHARS) : undefined;
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
