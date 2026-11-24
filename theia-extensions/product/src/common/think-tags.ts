/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Inkling 2 Mini reasons in a channel of its own, which LM Studio streams as `reasoning_content`. Now and then it also
 * writes `<think>…</think>` as plain text, the way models trained on other models' output do: at the start of an answer
 * (10 of the 11 leaks found in saved chats, 2026-11-24) or around a remark before a tool call. LM Studio only knows
 * Inkling's own reasoning markers, so that text arrived as part of the answer, tags and all, and the chat showed it.
 * The same tags also turn up inside the reasoning channel itself (22 times), where they are just noise.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

export interface ThinkTagPart {
    kind: 'text' | 'thought';
    text: string;
}

/**
 * Splits streamed text into answer and reasoning at `<think>` and `</think>`, chunk by chunk, so the reasoning never
 * reaches the answer even for a moment. A tag split across chunks is held back until the next chunk shows whether it
 * is one. A closing tag with no opening one is dropped: the text before it has already streamed as answer.
 */
export class ThinkTagSplitter {

    protected inThought = false;
    /** The end of the last chunk, when it could be the start of a tag. */
    protected pending = '';

    push(chunk: string): ThinkTagPart[] {
        const parts: ThinkTagPart[] = [];
        let input = this.pending + chunk;
        this.pending = '';
        while (input) {
            const open = input.indexOf(OPEN);
            const close = input.indexOf(CLOSE);
            const at = open < 0 ? close : close < 0 ? open : Math.min(open, close);
            if (at < 0) {
                const keep = partialTagLength(input);
                this.emit(parts, input.slice(0, input.length - keep));
                this.pending = input.slice(input.length - keep);
                break;
            }
            this.emit(parts, input.slice(0, at));
            if (at === open) {
                this.inThought = true;
                input = input.slice(at + OPEN.length);
            } else {
                this.inThought = false;
                input = input.slice(at + CLOSE.length);
            }
        }
        return parts;
    }

    /** What is still held back, at the end of the stream or before something else (a tool call) is emitted. */
    flush(): ThinkTagPart[] {
        const parts: ThinkTagPart[] = [];
        this.emit(parts, this.pending);
        this.pending = '';
        return parts;
    }

    protected emit(parts: ThinkTagPart[], text: string): void {
        if (!text) {
            return;
        }
        const kind = this.inThought ? 'thought' : 'text';
        const last = parts[parts.length - 1];
        if (last?.kind === kind) {
            last.text += text;
        } else {
            parts.push({ kind, text });
        }
    }
}

/** The answer part of a complete text: `<think>` blocks and stray tags removed. */
export function withoutThinkBlocks(text: string): string {
    if (!text.includes('<think') && !text.includes('</think')) {
        return text;
    }
    const splitter = new ThinkTagSplitter();
    return [...splitter.push(text), ...splitter.flush()].filter(part => part.kind === 'text').map(part => part.text).join('').trimStart();
}

/** The text with the tags themselves removed and everything else kept, for reasoning that contains them. */
export function withoutThinkTags(text: string): string {
    return text.split(OPEN).join('').split(CLOSE).join('');
}

/** Length of the longest end of `text` that could be the beginning of a tag. */
function partialTagLength(text: string): number {
    for (let length = Math.min(CLOSE.length - 1, text.length); length > 0; length--) {
        const end = text.slice(-length);
        if (OPEN.startsWith(end) || CLOSE.startsWith(end)) {
            return length;
        }
    }
    return 0;
}
