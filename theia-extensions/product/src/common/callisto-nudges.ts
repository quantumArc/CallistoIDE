/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ThinkingLoopVerdict } from './thinking-loop-detector.js';

/* What the Callisto agent tells the model when it interrupts it, and how it reads tool results. Kept free of browser code. */

/** Used to turn the token limit into characters; Inkling 2 Mini averages about 2.6 characters per token. */
export const CHARS_PER_TOKEN = 2.8;
/**
 * After an interruption, the model gets this much reasoning before its first action instead of the full limit. On the
 * chess-app task the first nudge was followed by another 47k characters of planning before anything was written.
 * (Forcing a tool call with `tool_choice: "required"` is not an option: LM Studio then makes Inkling emit garbage.)
 */
export const RESUME_THINKING_TOKENS = 4000;

export function describe(verdict: ThinkingLoopVerdict): string {
    return verdict.kind === 'repetition'
        ? 'kept going over the same points'
        : `ran for about ${Math.round(verdict.chars / CHARS_PER_TOKEN / 1000)}k tokens without acting`;
}

export interface NudgeContext {
    /** The current step of the model's todo list. */
    step?: string;
    /** The end of the model's reasoning before the interrupted block. */
    earlierReasoning?: string;
}

export function nudgeFor(verdict: ThinkingLoopVerdict, context: NudgeContext = {}): string {
    let text: string;
    if (verdict.kind === 'repetition') {
        const examples = (verdict.repeated ?? []).map(sentence => `- "${sentence}"`).join('\n');
        text = '[Callisto] Your reasoning was interrupted because it was going in circles, repeating the same checks, for example:\n'
            + `${examples}\n`
            + 'Those points are settled: do not go over them again. Take the next concrete step now. If code needs checking, run it '
            + '(the tests, or a short script that exercises it) instead of re-reading it. If the task is done, write your final message.';
    } else {
        text = `[Callisto] Your reasoning was interrupted after about ${Math.round(verdict.chars / CHARS_PER_TOKEN / 1000)}k tokens without `
            + 'any action. Stop planning in your head and take the first concrete step now: write or edit one file, or run something. '
            + 'Do not write code in your reasoning; put it straight into the file. Plan the rest as you go.';
    }
    if (context.step) {
        text += `\n\nYour current step (from your todo list): ${context.step}. Do that now.`;
    }
    if (context.earlierReasoning) {
        text += '\n\nWhat you worked out earlier in this task (settled: build on it, do not work it out again):\n'
            + `<earlier-reasoning>\n${context.earlierReasoning}\n</earlier-reasoning>`;
    }
    return text + `\n\nKeep your reasoning short now: Callisto interrupts again after about ${RESUME_THINKING_TOKENS / 1000}k tokens `
        + 'without an action.';
}

/** Whether a shell tool result reports a failed command; undefined when it cannot tell (e.g. cancelled). */
export function commandFailed(result: unknown): boolean | undefined {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    if (!value || typeof value !== 'object' || 'canceled' in value) {
        return undefined;
    }
    const { success, exitCode } = value as { success?: unknown; exitCode?: unknown };
    if (typeof exitCode === 'number') {
        return exitCode !== 0;
    }
    return typeof success === 'boolean' ? !success : undefined;
}
