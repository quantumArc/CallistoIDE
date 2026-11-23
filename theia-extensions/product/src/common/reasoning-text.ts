/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

const OMITTED = '[… earlier reasoning omitted …]\n';

/**
 * Marks thinking that the Callisto agent hands back to a local model in later requests (see the agent's `getMessages`
 * and the backend's `CallistoOpenAiModelUtils`). Real providers sign their thinking; this is not a signature, so
 * messages carrying it are only ever sent to LM Studio models.
 */
export const CALLISTO_REASONING_SIGNATURE = 'callisto:local-reasoning';

/** Reasoning kept from one model turn while the task's budget lasts: its end, where the model settles on what to do. */
export const MAX_REASONING_CHARS_PER_TURN = 6000;
/** Reasoning budget for a whole conversation. */
export const MAX_REASONING_CHARS_TOTAL = 24000;
/** Once the budget is spent, each further turn keeps only this much, so recent steps still connect. */
export const REASONING_CHARS_AFTER_BUDGET = 800;

/**
 * The end of a block of reasoning, at most `max` characters, starting at a line or sentence boundary where possible.
 * The end is kept because that is where a model settles on what to do next.
 */
export function keepEnd(text: string, max: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= max) {
        return trimmed;
    }
    let tail = trimmed.slice(trimmed.length - Math.max(0, max - OMITTED.length));
    const boundary = tail.search(/[\n.!?]\s/);
    if (boundary >= 0 && boundary < 400) {
        tail = tail.slice(boundary + 1).trimStart();
    }
    return OMITTED + tail;
}

/**
 * The reasoning to keep for one turn, given how much earlier turns already keep. Decided once per turn and never
 * revised: rewriting an earlier message would make LM Studio re-read the prompt from there (its prompt cache only
 * reuses an unchanged prefix). The backend tool loop and the rebuilt chat history both call this on the same
 * sequence of turns, so they produce the same prompt.
 */
export function budgetReasoning(text: string, usedSoFar: number): string | undefined {
    if (!text.trim()) {
        return undefined;
    }
    const max = usedSoFar < MAX_REASONING_CHARS_TOTAL ? MAX_REASONING_CHARS_PER_TURN : REASONING_CHARS_AFTER_BUDGET;
    return keepEnd(text, max);
}
