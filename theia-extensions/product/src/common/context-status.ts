/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** From this share of the context window on, the status bar warns. */
export const CONTEXT_WARN_RATIO = 0.75;
/** From this share on, it tells you to start a new chat. */
export const CONTEXT_FULL_RATIO = 0.9;

export interface ContextStatusInput {
    /** Tokens the chat's latest model call read plus wrote: what the next call starts from. */
    usedTokens: number;
    /** Context length the model is loaded with in LM Studio. */
    loadedContext?: number;
    /** Most the model supports. */
    maxContext?: number;
    /** Display name of the model. */
    model?: string;
}

export interface ContextStatus {
    text: string;
    tooltip: string;
    level: 'ok' | 'warn' | 'full';
}

/**
 * What the status bar says about the active chat's context window. A chat never needs a model reload to free memory:
 * LM Studio reuses and evicts its prompt cache by itself. What fills up is the chat itself, since every message
 * re-sends all of it. The two ways out are a new chat, or reloading the model with a longer context, which only helps
 * when the model supports more than it is loaded with.
 */
export function contextStatus(input: ContextStatusInput): ContextStatus {
    const { usedTokens, loadedContext, maxContext, model } = input;
    const lines: string[] = [];
    if (!loadedContext) {
        lines.push(`This chat's last model call used ${count(usedTokens)} tokens${model ? ` on ${model}` : ''}.`,
            'The context length is unknown: the model is not loaded in LM Studio, or is not an LM Studio model.');
        return { text: `$(layers) ${short(usedTokens)} ctx`, tooltip: lines.join('\n'), level: 'ok' };
    }
    const ratio = usedTokens / loadedContext;
    const percent = Math.min(999, Math.round(ratio * 100));
    const level: ContextStatus['level'] = ratio >= CONTEXT_FULL_RATIO ? 'full' : ratio >= CONTEXT_WARN_RATIO ? 'warn' : 'ok';
    lines.push(`Context window: ${count(usedTokens)} of ${count(loadedContext)} tokens (${percent}%) used by this chat${model ? ` on ${model}` : ''}.`,
        'Every message re-sends the whole chat, so a fuller context also means slower replies.');
    if (level === 'full') {
        lines.push('', 'Nearly full: start a new chat now. Once the chat no longer fits, the model cannot see all of it.');
    } else if (level === 'warn') {
        lines.push('', 'Getting full: start a new chat for the next task.');
    }
    if (level !== 'ok' && maxContext && maxContext > loadedContext) {
        lines.push(`Or reload the model in LM Studio with a longer context length (it supports up to ${count(maxContext)}); `
            + 'that uses more memory.');
    }
    lines.push('', 'No reload is needed to free memory: LM Studio reuses and evicts its prompt cache on its own.');
    const icon = level === 'ok' ? '$(layers)' : '$(warning)';
    return { text: `${icon} ${short(usedTokens)} / ${short(loadedContext)} ctx (${percent}%)`, tooltip: lines.join('\n'), level };
}

function count(tokens: number): string {
    return tokens.toLocaleString('en-US');
}

function short(tokens: number): string {
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}
