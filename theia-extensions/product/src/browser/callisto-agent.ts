/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { CancellationTokenSource, Disposable, PreferenceService } from '@theia/core';
import {
    ChatMode, InformationalChatResponseContentImpl, MutableChatRequestModel
} from '@theia/ai-chat/lib/common';
import {
    isLanguageModelStreamResponse, isTextResponsePart, isThinkingResponsePart, isToolCallResponsePart, LanguageModel, LanguageModelMessage,
    LanguageModelRequirement, LanguageModelResponse, LanguageModelStreamResponse, PromptVariantSet, ToolRequest
} from '@theia/ai-core';
import { AbstractModeAwareChatAgent } from '@theia/ai-ide/lib/browser/mode-aware-chat-agent';
import { RUN_TASK_FUNCTION_ID } from '@theia/ai-ide/lib/common/workspace-functions';
import {
    CLEAR_FILE_CHANGES_ID, SUGGEST_FILE_CONTENT_ID, SUGGEST_FILE_REPLACEMENTS_ID, WRITE_FILE_CONTENT_ID, WRITE_FILE_REPLACEMENTS_ID
} from '@theia/ai-ide/lib/common/file-changeset-function-ids';
import { SHELL_EXECUTION_FUNCTION_ID } from '@theia/ai-terminal/lib/common/shell-execution-server';
import {
    CALLISTO_AGENT_MODE_ID, CALLISTO_REVIEW_MODE_ID, CALLISTO_SYSTEM_PROMPT_ID, getCallistoAgentModePrompt, getCallistoReviewModePrompt
} from '../common/callisto-agent-prompts.js';
import { ThinkingLoopDetector, ThinkingLoopVerdict } from '../common/thinking-loop-detector.js';
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
/** Used to turn the token limit into characters; Inkling 2 Mini averages about 2.6 characters per token. */
const CHARS_PER_TOKEN = 2.8;

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

interface LoopGuardState {
    identicalCalls: Map<string, number>;
    fullWrites: Map<string, number>;
    totalCalls: number;
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
    }];
    protected override systemPromptId: string | undefined = CALLISTO_SYSTEM_PROMPT_ID;

    /** Per chat request; dropped with the request. */
    protected readonly loopGuards = new WeakMap<MutableChatRequestModel, LoopGuardState>();
    protected readonly llmCalls = new WeakMap<MutableChatRequestModel, LlmCall>();

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
        for (let resumes = 0; ; resumes++) {
            if (!isLanguageModelStreamResponse(response)) {
                await super.addContentsToResponse(response, request);
                return;
            }
            const verdict = await this.streamWithLoopBreaker(response, request);
            if (!verdict || request.response.cancellationToken.isCancellationRequested) {
                return;
            }
            if (resumes >= MAX_LOOP_RESUMES) {
                request.response.response.addContent(new InformationalChatResponseContentImpl(
                    `Callisto stopped the model: its reasoning ${describe(verdict)} again, after ${MAX_LOOP_RESUMES} nudges to act. `
                    + 'The work done so far is kept. Try a smaller step, a lower thinking level, or more specific instructions.'));
                return;
            }
            request.response.response.addContent(new InformationalChatResponseContentImpl(
                `Callisto interrupted the model because its reasoning ${describe(verdict)}, and asked it to take the next concrete step.`));
            response = await this.resume(request, verdict);
        }
    }

    /** Streams one model call into the response, cancelling it as soon as the reasoning loops. */
    protected async streamWithLoopBreaker(response: LanguageModelStreamResponse, request: MutableChatRequestModel): Promise<ThinkingLoopVerdict | undefined> {
        if (!this.preferences.get<boolean>(LOOP_BREAKER_PREF, true)) {
            await super.addStreamResponse(response, request);
            return undefined;
        }
        const maxTokens = this.preferences.get<number>(MAX_THINKING_TOKENS_PREF, 16000);
        const detector = new ThinkingLoopDetector({ maxChars: Math.round(maxTokens * CHARS_PER_TOKEN) });
        const call = this.llmCalls.get(request);
        let verdict: ThinkingLoopVerdict | undefined;
        async function* watched(): AsyncIterable<unknown> {
            for await (const part of response.stream) {
                if (isThinkingResponsePart(part)) {
                    verdict = detector.push(part.thought);
                } else if (isToolCallResponsePart(part) || (isTextResponsePart(part) && part.content.trim().length > 0)) {
                    // A tool call or answer text: the model acted, so a new block of reasoning starts after it. Other
                    // parts (empty deltas the OpenAI stream sends between reasoning chunks, usage) are not actions.
                    detector.reset();
                }
                yield part;
                if (verdict) {
                    call?.cancellation.cancel();
                    return;
                }
            }
        }
        await super.addStreamResponse({ ...response, stream: watched() } as LanguageModelStreamResponse, request);
        return verdict;
    }

    /**
     * Sends the request again with everything done so far in this task (tool calls and their results, text) but
     * without the looping reasoning, which has no signature and is therefore left out, plus a nudge to act.
     */
    protected async resume(request: MutableChatRequestModel, verdict: ThinkingLoopVerdict): Promise<LanguageModelResponse> {
        const call = this.llmCalls.get(request);
        if (!call) {
            throw new Error('Callisto: no model call to resume.');
        }
        const system = call.messages.filter(message => message.actor === 'system');
        const history = await this.getMessages(request.session, true);
        const nudge: LanguageModelMessage = { actor: 'user', type: 'text', text: nudgeFor(verdict) };
        return this.sendLlmRequest(
            request, [...system, ...history, nudge], call.tools, call.deferredToolIds, call.languageModel,
            call.promptVariantId, call.isPromptVariantCustomized
        );
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
                return result;
            }
        };
    }

    protected guardStateFor(request: MutableChatRequestModel): LoopGuardState {
        let state = this.loopGuards.get(request);
        if (!state) {
            state = { identicalCalls: new Map(), fullWrites: new Map(), totalCalls: 0 };
            this.loopGuards.set(request, state);
        }
        return state;
    }
}

function describe(verdict: ThinkingLoopVerdict): string {
    return verdict.kind === 'repetition'
        ? 'kept going over the same points'
        : `ran for about ${Math.round(verdict.chars / CHARS_PER_TOKEN / 1000)}k tokens without acting`;
}

function nudgeFor(verdict: ThinkingLoopVerdict): string {
    if (verdict.kind === 'repetition') {
        const examples = (verdict.repeated ?? []).map(sentence => `- "${sentence}"`).join('\n');
        return '[Callisto] Your reasoning was interrupted because it was going in circles, repeating the same checks, for example:\n'
            + `${examples}\n`
            + 'Those points are settled: do not go over them again. Take the next concrete step now. If code needs checking, run it '
            + '(the tests, or a short script that exercises it) instead of re-reading it. If the task is done, write your final message.';
    }
    return `[Callisto] Your reasoning was interrupted after about ${Math.round(verdict.chars / CHARS_PER_TOKEN / 1000)}k tokens without `
        + 'any action. Stop planning in your head and take the first concrete step now: write or edit one file, or run something. '
        + 'Do not write code in your reasoning; put it straight into the file. Plan the rest as you go.';
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
