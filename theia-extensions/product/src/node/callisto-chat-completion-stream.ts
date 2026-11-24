/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { isTextResponsePart, isThinkingResponsePart, LanguageModelMessage, LanguageModelStreamResponsePart } from '@theia/ai-core';
import { ChatCompletionStreamingAsyncIterator } from '@theia/ai-openai/lib/node/openai-chat-completion-stream';
import { OpenAiModelUtils } from '@theia/ai-openai/lib/node/openai-model-utils';
import { budgetReasoning, CALLISTO_REASONING_SIGNATURE, LOW_REASONING_UNTIL_ACTION_SETTING } from '../common/reasoning-text.js';
import { ThinkTagPart, ThinkTagSplitter, withoutThinkBlocks } from '../common/think-tags.js';

/** The field LM Studio, llama.cpp, vLLM and DeepSeek use for reasoning, in streamed deltas and in input messages alike. */
const REASONING_FIELD = 'reasoning_content';

interface MessageWithReasoning {
    role: string;
    tool_calls?: { id: string }[];
    [REASONING_FIELD]?: string;
}

/**
 * Theia's OpenAI-compatible tool loop, but the model keeps its own reasoning from one tool step to the next.
 *
 * Theia runs the whole tool loop of a chat request here, in the backend, and appends each assistant turn without
 * the reasoning that led to it. A reasoning model therefore starts every step with no memory of its plan: on the
 * chess-app task Inkling 2 Mini planned the whole app for ~40k characters, called `todoWrite`, and then planned it
 * all over again. This subclass puts each turn's reasoning back on its assistant message, which LM Studio renders
 * into the prompt through the model's chat template.
 *
 * What is kept per turn is decided once by {@link budgetReasoning} and never changed afterwards, and
 * {@link CallistoOpenAiModelUtils} rebuilds the same thing from the chat history for the next request, so LM Studio's
 * prompt cache keeps matching. Only done for servers on this machine or the local network, and only when the server
 * sent reasoning in the first place, so hosted APIs never receive a field they do not expect.
 */
@injectable()
export class CallistoChatCompletionStream extends ChatCompletionStreamingAsyncIterator {

    protected turnReasoning = '';
    /**
     * The `reasoning_effort` to go back to after the model's first action (`''`: none), when the agent asked for this
     * request to start at a low thinking level to get a looping model to act; undefined otherwise.
     */
    protected restoreReasoningEffort: string | undefined;

    protected override init(): void {
        const settings: Record<string, unknown> = { ...this.options.settings };
        if (LOW_REASONING_UNTIL_ACTION_SETTING in settings) {
            if (settings[LOW_REASONING_UNTIL_ACTION_SETTING] === true) {
                this.restoreReasoningEffort = typeof settings.reasoning_effort === 'string' ? settings.reasoning_effort : '';
                settings.reasoning_effort = 'low';
            }
            // Callisto's own setting: never sent to the server.
            delete settings[LOW_REASONING_UNTIL_ACTION_SETTING];
        }
        if (isLocalEndpoint(this.options.openai.baseURL) && !settings.stream_options) {
            // Theia asks only api.openai.com models for token usage. LM Studio reports it too when asked, and Callisto
            // needs the exact counts: the context-window status bar and the run stats are based on them.
            settings.stream_options = { include_usage: true };
        }
        (this.options as { settings?: Record<string, unknown> }).settings = settings;
        super.init();
    }

    /** Splits `<think>` blocks the model writes into its answer off into reasoning (see think-tags.ts). */
    protected answerTags = new ThinkTagSplitter();
    /** Drops the same tags from the reasoning channel; a tag can be split across chunks there too. */
    protected reasoningTags = new ThinkTagSplitter();

    protected override handleIncoming(message: LanguageModelStreamResponsePart): void {
        if (isTextResponsePart(message)) {
            this.emitSplit(this.answerTags.push(message.content));
            return;
        }
        if (isThinkingResponsePart(message)) {
            this.emitThought(this.reasoningTags.push(message.thought).map(part => part.text).join(''), message.signature);
            return;
        }
        // A tool call or the usage comes after any text held back for a possible tag.
        this.flushTags();
        super.handleIncoming(message);
    }

    protected emitSplit(parts: ThinkTagPart[]): void {
        for (const part of parts) {
            if (part.kind === 'thought') {
                this.emitThought(part.text, '');
            } else {
                super.handleIncoming({ content: part.text });
            }
        }
    }

    protected emitThought(thought: string, signature: string | undefined): void {
        if (thought) {
            this.turnReasoning += thought;
            super.handleIncoming({ thought, signature: signature ?? '' });
        }
    }

    protected flushTags(): void {
        this.emitSplit(this.answerTags.flush());
        this.emitThought(this.reasoningTags.flush().map(part => part.text).join(''), '');
    }

    protected override async processStream(): ReturnType<ChatCompletionStreamingAsyncIterator['processStream']> {
        this.turnReasoning = '';
        this.answerTags = new ThinkTagSplitter();
        this.reasoningTags = new ThinkTagSplitter();
        const result = await super.processStream();
        this.flushTags();
        // The next tool step sees the answer as the chat keeps it, without the `<think>` block, which is in the
        // reasoning; CallistoOpenAiModelUtils rebuilds later requests the same way.
        return { ...result, assistantText: withoutThinkBlocks(result.assistantText) };
    }

    protected override async executeAndAppendToolCalls(...args: Parameters<ChatCompletionStreamingAsyncIterator['executeAndAppendToolCalls']>): Promise<void> {
        const reasoning = this.turnReasoning;
        const assistantIndex = this.messages.length;
        await super.executeAndAppendToolCalls(...args);
        const assistant = this.messages[assistantIndex] as MessageWithReasoning | undefined;
        if (assistant?.role === 'assistant') {
            rememberToolCallTurn((assistant.tool_calls ?? []).map(call => call.id));
        }
        if (assistant?.role === 'assistant' && isLocalEndpoint(this.options.openai.baseURL)) {
            const kept = budgetReasoning(reasoning, reasoningChars(this.messages.slice(0, assistantIndex) as MessageWithReasoning[]));
            if (kept) {
                assistant[REASONING_FIELD] = kept;
            }
        }
        if (this.restoreReasoningEffort !== undefined) {
            // The model acted: the rest of the task runs at the user's thinking level again. Each step's request body
            // is built from these settings, so the next step already uses it.
            const settings = this.options.settings as Record<string, unknown>;
            if (this.restoreReasoningEffort === '') {
                delete settings.reasoning_effort;
            } else {
                settings.reasoning_effort = this.restoreReasoningEffort;
            }
            this.restoreReasoningEffort = undefined;
        }
    }
}

/**
 * Turns the reasoning the Callisto agent marked in the chat history (thinking messages carrying
 * {@link CALLISTO_REASONING_SIGNATURE}) into `reasoning_content` on the assistant turn it led to, exactly as
 * {@link CallistoChatCompletionStream} did while the task ran. Without this, every follow-up message and every resume
 * after an interruption would differ from the cached prompt at the first earlier tool call, and LM Studio would
 * re-read the conversation from there.
 */
@injectable()
export class CallistoOpenAiModelUtils extends OpenAiModelUtils {

    override processMessages(...args: Parameters<OpenAiModelUtils['processMessages']>): ReturnType<OpenAiModelUtils['processMessages']> {
        const [messages] = args;
        // Reasoning of each turn, keyed by the id of the turn's first tool call.
        const reasoningByToolCall = new Map<string, string>();
        let pending = '';
        for (const message of messages) {
            if (isCarriedThinking(message)) {
                pending += message.thinking;
            } else if (LanguageModelMessage.isToolUseMessage(message)) {
                if (pending) {
                    reasoningByToolCall.set(message.id, pending);
                    pending = '';
                }
            } else if (message.actor === 'user' && message.type === 'text') {
                // A turn that ended in a text answer, or was interrupted: the tool loop kept none of it.
                pending = '';
            }
        }
        const result = regroupParallelToolCalls(super.processMessages(...args) as MessageWithReasoning[]) as ReturnType<OpenAiModelUtils['processMessages']>;
        if (reasoningByToolCall.size === 0) {
            return result;
        }
        let used = 0;
        for (const message of result as MessageWithReasoning[]) {
            if (message.role !== 'assistant') {
                continue;
            }
            const raw = message.tool_calls?.[0] && reasoningByToolCall.get(message.tool_calls[0].id);
            const kept = raw ? budgetReasoning(raw, used) : undefined;
            if (kept) {
                message[REASONING_FIELD] = kept;
                used += kept.length;
            }
        }
        return result;
    }
}

/**
 * Tool call id → id of the first call of the model turn it was made in, for turns with several calls at once. Filled
 * by the tool loop; kept for this backend's lifetime, oldest entries dropped first.
 */
const toolCallTurns = new Map<string, string>();
const MAX_REMEMBERED_TOOL_CALLS = 20000;

export function rememberToolCallTurn(ids: readonly string[]): void {
    if (ids.length < 2) {
        return;
    }
    for (const id of ids) {
        toolCallTurns.set(id, ids[0]);
    }
    for (const oldest of toolCallTurns.keys()) {
        if (toolCallTurns.size <= MAX_REMEMBERED_TOOL_CALLS) {
            break;
        }
        toolCallTurns.delete(oldest);
    }
}

/**
 * Puts tool calls the model made together back into one assistant message, followed by their results, as the tool loop
 * sent them. Theia's history has one tool call per assistant message (call, result, call, result …), so after a turn
 * with several calls at once the prompt no longer matched LM Studio's cache from that turn on: after a turn that read
 * six files, the next request re-read 16,500 of its 24,500 tokens. Turns this backend did not run are left as they are.
 */
export function regroupParallelToolCalls(messages: MessageWithReasoning[]): MessageWithReasoning[] {
    const result: MessageWithReasoning[] = [];
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const first = message.role === 'assistant' && message.tool_calls?.length === 1 ? message.tool_calls[0].id : undefined;
        if (!first || toolCallTurns.get(first) !== first) {
            result.push(message);
            continue;
        }
        const merged: MessageWithReasoning = { ...message, tool_calls: [...message.tool_calls!] };
        const toolResults: MessageWithReasoning[] = [];
        let next = i + 1;
        for (; next < messages.length; next++) {
            const candidate = messages[next] as MessageWithReasoning & { content?: unknown };
            if (candidate.role === 'tool') {
                toolResults.push(candidate);
            } else if (candidate.role === 'assistant' && candidate.tool_calls?.length === 1 && !candidate.content
                && toolCallTurns.get(candidate.tool_calls[0].id) === first) {
                merged.tool_calls!.push(candidate.tool_calls[0]);
            } else {
                break;
            }
        }
        result.push(merged, ...toolResults);
        i = next - 1;
    }
    return result;
}

function isCarriedThinking(message: LanguageModelMessage): message is LanguageModelMessage & { type: 'thinking'; thinking: string } {
    return message.type === 'thinking' && (message as { signature?: string }).signature === CALLISTO_REASONING_SIGNATURE;
}

function reasoningChars(messages: MessageWithReasoning[]): number {
    return messages.reduce((sum, message) => sum + (message.role === 'assistant' ? message[REASONING_FIELD]?.length ?? 0 : 0), 0);
}

/** True for servers on this machine or a private network: LM Studio, llama.cpp, vLLM and the like. */
export function isLocalEndpoint(baseURL: string | undefined): boolean {
    if (!baseURL) {
        return false;
    }
    let host: string;
    try {
        host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
        return false;
    }
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1'
        || host === 'host.docker.internal'
        || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
