/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** A model server's refusal of a request that does not fit in the model's context window. */
export interface ContextOverflow {
    /** Tokens the request needed, when the server says. */
    requested?: number;
    /** Context length the model is loaded with. */
    available: number;
}

/**
 * Recognizes "the request does not fit" errors:
 * - LM Studio and llama.cpp: `request (8502 tokens) exceeds the available context size (8192 tokens), try increasing it`
 * - vLLM and OpenAI: `This model's maximum context length is 8192 tokens. However, you requested 8502 tokens …`
 */
export function parseContextOverflow(message: string | undefined): ContextOverflow | undefined {
    if (!message) {
        return undefined;
    }
    const llamaCpp = message.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i);
    if (llamaCpp) {
        return { requested: Number(llamaCpp[1]), available: Number(llamaCpp[2]) };
    }
    const openAi = message.match(/maximum context length is (\d+) tokens/i);
    if (openAi) {
        const requested = message.match(/(?:you requested|resulted in) (\d+) tokens/i);
        return { requested: requested ? Number(requested[1]) : undefined, available: Number(openAi[1]) };
    }
    return undefined;
}

export interface ContextOverflowAdvice {
    /** Display name of the model. */
    model?: string;
    /** Most context the model supports, when known. */
    maxContext?: number;
    /** Whether the chat had earlier requests: if not, even a fresh chat does not fit, and only a longer context helps. */
    chatHasHistory: boolean;
    /** Whether the model runs in LM Studio. */
    lmStudio: boolean;
}

/**
 * What to tell the user instead of the server's raw 400. Callisto's system prompt and tools alone take about 8.5k
 * tokens, so a model that LM Studio loaded on its own, with its default 8,192-token context, fails on the very first
 * message of a new chat: there the only fix is a longer context. In a long chat, a new chat is the usual fix.
 */
export function contextOverflowMessage(overflow: ContextOverflow, advice: ContextOverflowAdvice): string {
    const model = advice.model ?? 'The model';
    const needs = overflow.requested ? ` and this request needs ${count(overflow.requested)}` : '';
    const facts = `${model} is loaded with a context of ${count(overflow.available)} tokens${needs}.`;
    const canGrow = advice.maxContext === undefined || advice.maxContext > overflow.available;
    const supports = advice.maxContext && advice.maxContext > overflow.available ? ` (it supports up to ${count(advice.maxContext)})` : '';
    const where = advice.lmStudio ? 'in LM Studio ' : '';
    const reload = `reload the model ${where}with a longer context length${supports}`;
    if (!advice.chatHasHistory) {
        return canGrow
            ? `${facts} Callisto's instructions and tools alone take about 8,500 tokens, so even a new chat does not fit. `
            + `To fix it, ${reload}, then send your message again. 32,768 or more works well.`
            : `${facts} That is the most this model supports, and Callisto's instructions and tools alone take about 8,500 tokens. `
            + 'Choose a model with a longer context.';
    }
    return canGrow
        ? `${facts} This chat no longer fits. Start a new chat, or ${reload} and send your message again.`
        : `${facts} This chat no longer fits. Start a new chat.`;
}

function count(tokens: number): string {
    return tokens.toLocaleString('en-US');
}
