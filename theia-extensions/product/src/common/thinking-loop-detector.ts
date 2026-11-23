/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Watches a model's reasoning as it streams and reports when it stops making progress:
 *
 * - **Repetition**: a self-review that cycles through the same checks over and over ("wait no, after castling the
 *   king goes to g1 …"), until the user stops it. Seen with Inkling 2 Mini on the first chess-app run: 76k characters
 *   of the same move-history checks.
 * - **Too long**: one block of reasoning longer than a limit. The agent sets that limit from the room left in the
 *   context window (and an optional user cap), not from how long planning "should" take: left alone, Inkling plans for
 *   up to ~150k characters and then acts, and interrupting it earlier only made it plan again from scratch.
 */

export interface ThinkingLoopVerdict {
    kind: 'repetition' | 'too-long';
    /** Characters of reasoning in the current block when the verdict was reached. */
    chars: number;
    /** For 'repetition': a few of the sentences that kept coming back. */
    repeated?: string[];
    /** For 'repetition': where in the block the loop began (the first occurrence of a repeated sentence). */
    loopStart?: number;
}

export interface ThinkingLoopDetectorOptions {
    /** A single block of reasoning longer than this is reported as 'too-long'. 0 disables the check. */
    maxChars: number;
    /** Only the most recent reasoning is checked for repetition, so earlier legitimate recaps do not count. */
    windowChars?: number;
    /** How often to check, in characters of new reasoning. */
    checkEveryChars?: number;
    /** Shorter sentences ("Good.", "Fine.") repeat naturally and are ignored. */
    minSentenceChars?: number;
}

const DEFAULTS = { windowChars: 16000, checkEveryChars: 1500, minSentenceChars: 40 };

/**
 * A sentence seen this often inside the window counts as repeated. Tuned on the saved chess-app chats: with 3, a model
 * second-guessing one table of values ("A pawn on rank 2 is fine …" three times) was cut off at 39k characters of
 * otherwise productive planning; with 4 the real 76k-character loop is still caught, at 48k.
 */
const REPEATS_PER_SENTENCE = 4;
/** Repetition is reported when this many different sentences repeat (a cycle of checks)... */
const DISTINCT_REPEATED_SENTENCES = 3;
/** ...or when any single sentence comes back this often. */
const REPEATS_OF_ONE_SENTENCE = 6;

export class ThinkingLoopDetector {

    protected text = '';
    protected checkedAt = 0;
    protected readonly options: Required<ThinkingLoopDetectorOptions>;

    constructor(options: ThinkingLoopDetectorOptions) {
        this.options = { ...DEFAULTS, ...options };
    }

    /** Characters in the current block of reasoning. */
    get length(): number {
        return this.text.length;
    }

    /** The current block of reasoning. */
    get reasoning(): string {
        return this.text;
    }

    /** Adds streamed reasoning; returns a verdict when the reasoning should be interrupted. */
    push(chunk: string): ThinkingLoopVerdict | undefined {
        this.text += chunk;
        if (this.text.length - this.checkedAt < this.options.checkEveryChars) {
            return undefined;
        }
        this.checkedAt = this.text.length;
        return this.check();
    }

    /** The model did something other than reason (wrote text, called a tool): a new block starts. */
    reset(): void {
        this.text = '';
        this.checkedAt = 0;
    }

    check(): ThinkingLoopVerdict | undefined {
        // Code is removed from the whole block before the window is cut, so a window that starts inside a code block
        // cannot pair the fences the wrong way round; the result then does not depend on how the stream was chunked.
        const repeated = this.findRepeatedSentences(withoutCode(this.text).slice(-this.options.windowChars));
        if (repeated) {
            const starts = repeated.map(sentence => this.text.indexOf(sentence)).filter(index => index >= 0);
            return { kind: 'repetition', chars: this.text.length, repeated, loopStart: starts.length > 0 ? Math.min(...starts) : undefined };
        }
        if (this.options.maxChars > 0 && this.text.length > this.options.maxChars) {
            return { kind: 'too-long', chars: this.text.length };
        }
        return undefined;
    }

    /** The repeated sentences, most repeated first, as they were written (trimmed); undefined when there is no loop. */
    protected findRepeatedSentences(prose: string): string[] | undefined {
        const counts = new Map<string, { count: number; original: string }>();
        for (const original of prose.split(/(?<=[.!?])\s+|\n+/)) {
            const key = normalizeSentence(original);
            if (key.length < this.options.minSentenceChars || looksLikeCode(original)) {
                continue;
            }
            const entry = counts.get(key);
            if (entry) {
                entry.count++;
            } else {
                counts.set(key, { count: 1, original: original.trim() });
            }
        }
        const repeated = [...counts.values()].filter(entry => entry.count >= REPEATS_PER_SENTENCE).sort((a, b) => b.count - a.count);
        const loops = repeated.length >= DISTINCT_REPEATED_SENTENCES || (repeated[0]?.count ?? 0) >= REPEATS_OF_ONE_SENTENCE;
        return loops ? repeated.slice(0, 3).map(entry => entry.original) : undefined;
    }
}

/**
 * Debugging means quoting the same few lines of code again and again while tracing them, which is progress, not a loop:
 * on the chess-app bug fix Inkling quoted `var E = … root.ChessEngine;` five times on its way to finding that `root` is
 * undefined there, and was interrupted for "repeating" just before writing the fix. Only prose counts, so fenced
 * blocks (also one still being written) and inline code are left out.
 */
export function withoutCode(text: string): string {
    return text
        .replace(/```[\s\S]*?(```|$)/g, '\n')
        .replace(/`[^`\n]*`/g, '');
}

/**
 * A line of code or data quoted without backticks: `if (x) {`, `var e = …;`, `return evaluate(state, color);`, or a
 * row of a table of values (`rank8: [-20, -10, -10, …]`, which Inkling wrote out several times while designing
 * piece-square tables on the third chess-app run).
 */
function looksLikeCode(sentence: string): boolean {
    const text = sentence.trim();
    if (/[;{}]$/.test(text) || /^(var|let|const|function|return|if|for|while|else|import|export|class|def)\b/.test(text)) {
        return true;
    }
    const symbols = text.replace(/[^(){}[\];=<>&|]/g, '').length;
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    return symbols / text.length > 0.08 || letters / text.length < 0.5;
}

/** Ignores list numbering, bullets, case, spacing and trailing punctuation, so "157. Good." and "163. good" match. */
function normalizeSentence(sentence: string): string {
    return sentence
        .toLowerCase()
        .replace(/^\s*(\d+[.)]|[-*•]|#+)\s*/, '')
        .replace(/\s+/g, ' ')
        .replace(/[.!?:;,\s]+$/, '')
        .trim();
}
