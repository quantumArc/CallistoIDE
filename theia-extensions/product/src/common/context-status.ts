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
    /** The context length the user chose (`callisto.localModels.contextLength`), when they chose one. */
    preferredContext?: number;
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
    const { usedTokens, loadedContext, maxContext, model, preferredContext } = input;
    const lines: string[] = [];
    if (!loadedContext) {
        lines.push(`This chat's last model call used ${count(usedTokens)} tokens${model ? ` on ${model}` : ''}.`,
            'The context length is unknown: the model is not loaded in LM Studio, or is not an LM Studio model.');
        return { text: `$(layers) ${short(usedTokens)} ctx`, tooltip: lines.join('\n'), level: 'ok' };
    }
    const ratio = usedTokens / loadedContext;
    const percent = Math.min(999, Math.round(ratio * 100));
    let level: ContextStatus['level'] = ratio >= CONTEXT_FULL_RATIO ? 'full' : ratio >= CONTEXT_WARN_RATIO ? 'warn' : 'ok';
    lines.push(`Context window: ${count(usedTokens)} of ${count(loadedContext)} tokens (${percent}%) used by this chat${model ? ` on ${model}` : ''}.`,
        'It holds Callisto\'s instructions, the whole chat and the model\'s reasoning, so a full one leaves the model little room to think. '
        + 'Every message re-sends the whole chat, so a fuller context also means slower replies.');
    const mismatch = !!preferredContext && preferredContext !== loadedContext;
    if (mismatch) {
        level = level === 'full' ? 'full' : 'warn';
        lines.push('', `LM Studio has the model loaded with ${count(loadedContext)} tokens, but your setting is ${count(preferredContext!)}. `
            + `Click to reload it with ${count(preferredContext!)}.`);
    } else if (level === 'full') {
        lines.push('', 'Nearly full: start a new chat, or click to choose a longer context length.');
    } else if (level === 'warn') {
        lines.push('', 'Getting full: start a new chat for the next task, or click to choose a longer context length.');
    } else {
        lines.push('', 'Click to change the context length.');
    }
    if (level !== 'ok' && maxContext && maxContext > loadedContext && !mismatch) {
        lines.push(`The model supports up to ${count(maxContext)}; a longer context uses more memory.`);
    }
    const icon = level === 'ok' ? '$(layers)' : '$(warning)';
    const setting = mismatch ? ` · set ${short(preferredContext!)}` : '';
    return { text: `${icon} ${short(usedTokens)} / ${short(loadedContext)} ctx (${percent}%)${setting}`, tooltip: lines.join('\n'), level };
}

/** Context lengths Callisto offers, up to what a model supports. */
export const CONTEXT_LENGTHS = [32_768, 65_536, 131_072, 196_608, 262_144, 393_216, 524_288, 1_048_576];

/**
 * The context length to suggest when a chat of `used` tokens has filled a window of `loaded`: the smallest offered
 * length with room for the chat twice over (so the model has as much room to think as the chat takes), and at least
 * the next step up. Undefined when the model supports nothing larger.
 */
export function suggestedContextLength(loaded: number, max: number | undefined, used: number): number | undefined {
    const ceiling = max ?? CONTEXT_LENGTHS[CONTEXT_LENGTHS.length - 1];
    const larger = CONTEXT_LENGTHS.filter(length => length > loaded && length <= ceiling);
    if (larger.length === 0) {
        return ceiling > loaded ? ceiling : undefined;
    }
    return larger.find(length => length >= used * 2) ?? larger[larger.length - 1];
}

function count(tokens: number): string {
    return tokens.toLocaleString('en-US');
}

function short(tokens: number): string {
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}
