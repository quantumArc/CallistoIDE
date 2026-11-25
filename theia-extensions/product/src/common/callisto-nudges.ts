/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ThinkingLoopVerdict } from './thinking-loop-detector.js';

/* What the Callisto agent tells the model when it interrupts it, and how it reads tool results. Kept free of browser code. */

/** Used to turn tokens into characters; Inkling 2 Mini averages about 2.6 characters per token. */
export const CHARS_PER_TOKEN = 2.8;

/**
 * How much of the interrupted reasoning goes back to the model with the nudge: its start (where a model states its
 * plan) and its end (its latest decisions). Without this the model plans everything again after each interruption,
 * as on the third chess-app run, where two resumes re-planned the app from scratch and never wrote a file.
 */
export const KEPT_REASONING_HEAD_CHARS = 3000;
export const KEPT_REASONING_TAIL_CHARS = 6000;

const OMITTED = '\n[… part of your reasoning omitted …]\n';

export function describe(verdict: ThinkingLoopVerdict, contextFull = false): string {
    if (verdict.kind === 'repetition') {
        return 'started going in circles';
    }
    const tokens = `about ${Math.round(verdict.chars / CHARS_PER_TOKEN / 1000)}k tokens`;
    // A full window is about the chat's size, not the model's: it reasoned only as far as the room left allowed.
    return contextFull ? `filled the room left in the context window (${tokens}; the chat takes the rest)` : `ran for ${tokens} without acting`;
}

/**
 * The part of an interrupted block of reasoning worth keeping: everything before the loop began (for repetition) or
 * all of it (when it ran too long), shortened to its start and end.
 */
export function keptReasoning(block: string, verdict: ThinkingLoopVerdict): string | undefined {
    const useful = (verdict.kind === 'repetition' && verdict.loopStart !== undefined ? block.slice(0, verdict.loopStart) : block).trim();
    if (useful.length < 200) {
        return undefined;
    }
    if (useful.length <= KEPT_REASONING_HEAD_CHARS + KEPT_REASONING_TAIL_CHARS + OMITTED.length) {
        return useful;
    }
    let head = useful.slice(0, KEPT_REASONING_HEAD_CHARS);
    const headEnd = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
    if (headEnd > KEPT_REASONING_HEAD_CHARS - 400) {
        head = head.slice(0, headEnd + 1);
    }
    let tail = useful.slice(useful.length - KEPT_REASONING_TAIL_CHARS);
    const tailStart = tail.search(/[\n.!?]\s/);
    if (tailStart >= 0 && tailStart < 400) {
        tail = tail.slice(tailStart + 1);
    }
    return head.trimEnd() + OMITTED + tail.trimStart();
}

export interface NudgeContext {
    /** The current step of the model's todo list. */
    step?: string;
    /** Whether the model has written a todo list in this task. */
    hasTodoList?: boolean;
    /** What is kept of the interrupted reasoning (see {@link keptReasoning}). */
    reasoning?: string;
    /** For 'too-long': the limit was the room left in the context window. */
    contextFull?: boolean;
    /** The last attempt before Callisto hands the task back to the user (sent at a low thinking level). */
    lastAttempt?: boolean;
    /** Callisto handed the task back to the user after this interruption; the user's next message follows it. */
    pausedForUser?: boolean;
}

export function nudgeFor(verdict: ThinkingLoopVerdict, context: NudgeContext = {}): string {
    let text: string;
    if (verdict.kind === 'repetition') {
        const examples = (verdict.repeated ?? []).map(sentence => `- "${sentence.slice(0, 160)}"`).join('\n');
        text = '[Callisto] Your reasoning was interrupted because it started going in circles, repeating the same points, for example:\n'
            + `${examples}\n`
            + 'Those points are settled: do not go over them again. If code needs checking, run it (the tests, or a short script that '
            + 'exercises it) instead of re-reading it. If the task is done, write your final message.';
    } else {
        text = `[Callisto] Your reasoning was interrupted: it ${describe(verdict, context.contextFull)}. `
            + 'Do not write code in your reasoning; put it straight into the file.';
    }
    if (context.reasoning) {
        text += '\n\nYour reasoning up to that point is below. It is settled: build on it, do not work it out again.\n'
            + `<your-reasoning>\n${context.reasoning}\n</your-reasoning>`;
    }
    const next = !context.hasTodoList
        ? 'call todoWrite with the plan you have settled on (its steps, the first one in progress), then start on that first step'
        : context.step
            ? `your current step from your todo list: ${context.step}. Write or edit the file, or run the command`
            : 'take the next concrete step: write or edit one file, or run something';
    text += `\n\nYour next action: ${next}.`;
    if (context.lastAttempt) {
        text += '\nAct right away, before planning anything further. A first version of a file is fine: improve it with later edits. '
            + 'If this attempt does not act either, Callisto hands the task back to the user.';
    } else {
        text += '\nKeep your reasoning short and act.';
    }
    if (context.pausedForUser) {
        text += '\n\nCallisto handed the task back to the user at this point. Follow the user\'s next message; if it says to continue, '
            + 'take the next action above right away.';
    }
    return text;
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
