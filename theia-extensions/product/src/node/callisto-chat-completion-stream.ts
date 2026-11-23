/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { isThinkingResponsePart, LanguageModelMessage, LanguageModelStreamResponsePart } from '@theia/ai-core';
import { ChatCompletionStreamingAsyncIterator } from '@theia/ai-openai/lib/node/openai-chat-completion-stream';
import { OpenAiModelUtils } from '@theia/ai-openai/lib/node/openai-model-utils';
import { budgetReasoning, CALLISTO_REASONING_SIGNATURE, LOW_REASONING_UNTIL_ACTION_SETTING } from '../common/reasoning-text.js';

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

    protected override handleIncoming(message: LanguageModelStreamResponsePart): void {
        if (isThinkingResponsePart(message)) {
            this.turnReasoning += message.thought;
        }
        super.handleIncoming(message);
    }

    protected override processStream(): ReturnType<ChatCompletionStreamingAsyncIterator['processStream']> {
        this.turnReasoning = '';
        return super.processStream();
    }

    protected override async executeAndAppendToolCalls(...args: Parameters<ChatCompletionStreamingAsyncIterator['executeAndAppendToolCalls']>): Promise<void> {
        const reasoning = this.turnReasoning;
        const assistantIndex = this.messages.length;
        await super.executeAndAppendToolCalls(...args);
        const assistant = this.messages[assistantIndex] as MessageWithReasoning | undefined;
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
        const result = super.processMessages(...args);
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
