/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Watches a model's reasoning as it streams and reports when it stops making progress. Two patterns, both seen
 * with Inkling 2 Mini on a long coding task:
 *
 * - **Repetition**: a self-review that cycles through the same checks over and over ("wait no, after castling the
 *   king goes to g1 …", ten times), until the user stops it.
 * - **Too long**: one uninterrupted block of reasoning far beyond what choosing the next step needs, typically the
 *   whole program being drafted in the reasoning before any of it is written to a file.
 */

export interface ThinkingLoopVerdict {
    kind: 'repetition' | 'too-long';
    /** Characters of reasoning in the current block when the verdict was reached. */
    chars: number;
    /** For 'repetition': a few of the sentences that kept coming back. */
    repeated?: string[];
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

/** A sentence seen this often inside the window counts as repeated. */
const REPEATS_PER_SENTENCE = 3;
/** Repetition is reported when this many different sentences repeat (a cycle of checks)... */
const DISTINCT_REPEATED_SENTENCES = 3;
/** ...or when any single sentence comes back this often. */
const REPEATS_OF_ONE_SENTENCE = 5;

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
        const repeated = this.findRepeatedSentences(this.text.slice(-this.options.windowChars));
        if (repeated) {
            return { kind: 'repetition', chars: this.text.length, repeated };
        }
        if (this.options.maxChars > 0 && this.text.length > this.options.maxChars) {
            return { kind: 'too-long', chars: this.text.length };
        }
        return undefined;
    }

    protected findRepeatedSentences(window: string): string[] | undefined {
        const counts = new Map<string, { count: number; original: string }>();
        for (const original of window.split(/(?<=[.!?])\s+|\n+/)) {
            const key = normalizeSentence(original);
            if (key.length < this.options.minSentenceChars) {
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
        return loops ? repeated.slice(0, 3).map(entry => entry.original.slice(0, 160)) : undefined;
    }
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
