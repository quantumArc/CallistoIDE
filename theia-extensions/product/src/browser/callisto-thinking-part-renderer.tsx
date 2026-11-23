/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ChatResponseContent, ThinkingChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ThinkingPartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-renderer/thinking-part-renderer';
import { Spinner } from '@theia/ai-chat-ui/lib/browser/chat-response-renderer/spinner';
import { ResponseNode } from '@theia/ai-chat-ui/lib/browser/chat-tree-view/chat-view-tree-widget';
import { AiRunStatsService, formatDuration, formatRate, formatTokens } from './ai-run-stats.js';

/**
 * Theia's thinking renderer, with two changes while the model is thinking:
 * - the run's elapsed time, output tokens and speed on the 'Thinking' line: `Thinking · 1m 12s · ~2.3k tokens · 34 tok/s`;
 * - a live preview that scrolls smoothly line by line (see {@link ThinkingPreview}).
 * Finished thinking is rendered by Theia, unchanged.
 */
@injectable()
export class CallistoThinkingPartRenderer extends ThinkingPartRenderer {

    @inject(AiRunStatsService)
    protected readonly runStats: AiRunStatsService;

    override canHandle(response: ChatResponseContent): number {
        // One above Theia's renderer, which then never gets the thinking parts.
        return ThinkingChatResponseContent.is(response) ? 11 : -1;
    }

    override render(response: ThinkingChatResponseContent, parentNode?: ResponseNode): React.ReactNode {
        if (!parentNode || !this.isThinking(response, parentNode)) {
            return super.render(response, parentNode);
        }
        return <ThinkingWithStats runStats={this.runStats} responseId={parentNode.response.id}>
            <div className='theia-thinking active'>
                <div className='theia-thinking-status'><Spinner /> {nls.localizeByDefault('Thinking')}</div>
                <ThinkingPreview content={response.content} />
            </div>
        </ThinkingWithStats>;
    }
}

/**
 * The stats go onto the 'Thinking' status line through a CSS variable read by its `::after`, so the markup stays
 * Theia's.
 */
const ThinkingWithStats: React.FC<{ runStats: AiRunStatsService; responseId: string; children: React.ReactNode }> = (
    { runStats, responseId, children }
) => {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        const listener = runStats.onDidChange(() => setTick(tick => tick + 1));
        return () => listener.dispose();
    }, [runStats]);
    const stats = runStats.getStats(responseId);
    let text = '';
    if (stats) {
        text = ` · ${formatDuration(stats.elapsedMs)} · ${formatTokens(stats.tokens, stats.estimated)} tokens`;
        if (stats.tokensPerSecond !== undefined) {
            text += ` · ${formatRate(stats.tokensPerSecond)}`;
        }
    }
    return <div className='callisto-thinking-stats' style={{ '--callisto-thinking-stats': JSON.stringify(text) } as React.CSSProperties}>
        {children}
    </div>;
};

/** Trailing characters of the reasoning the preview keeps at least; far more than its visible lines. */
const PREVIEW_LENGTH = 2000;
/** Duration in milliseconds of the slide that moves the preview up when the text gains a line. */
const PREVIEW_SCROLL_DURATION = 600;

interface Paragraph {
    start: number;
    text: string;
}

/** The tail of the reasoning as its non-empty paragraphs; only whole paragraphs are dropped, so lines never re-wrap. */
function previewParagraphs(content: string): Paragraph[] {
    const cut = content.length - PREVIEW_LENGTH;
    let start = cut > 0 ? content.lastIndexOf('\n', cut) + 1 : 0;
    const paragraphs: Paragraph[] = [];
    for (const text of content.slice(start).split('\n')) {
        if (text.trim()) {
            paragraphs.push({ start, text });
        }
        start += text.length + 1;
    }
    return paragraphs;
}

/**
 * The last lines of the reasoning as it streams in, anchored to the bottom: when the text gains a line, the lines slide
 * up instead of jumping, and a slide that starts while another runs continues from where that one is.
 *
 * Theia's preview does the same but measured lines with `offsetTop`, whose reference changes while a slide runs: a
 * transformed element becomes the offset parent of its children, so mid-slide `offsetTop` was measured from the text,
 * otherwise from the preview box. New lines arriving mid-slide then measured no movement and jumped up a line, and the
 * first line after a slide ended measured hundreds of pixels and threw the text down a whole box height (seen in the
 * Callisto chat as constant jumping, worse on long reasoning). Here the text is positioned, so lines are always measured
 * from it, and the text's own `offsetTop` from the box; neither includes the slide's transform. Theia also let the
 * offsets of overlapping slides add up without limit, which blanked the preview during bursts of text; here a slide
 * starts at most one box height below.
 */
const ThinkingPreview: React.FC<{ content: string }> = ({ content }) => {
    const boxRef = React.useRef<HTMLDivElement | undefined>(undefined);
    const textRef = React.useRef<HTMLDivElement | undefined>(undefined);
    // The last paragraph of the previous render and its position in the box, before any slide.
    const anchorRef = React.useRef<{ start: number; top: number } | undefined>(undefined);
    const [overflowing, setOverflowing] = React.useState(false);
    const paragraphs = React.useMemo(() => previewParagraphs(content), [content]);
    React.useLayoutEffect(() => {
        const box = boxRef.current;
        const text = textRef.current;
        const last = text?.lastElementChild;
        if (!box || !text || !(last instanceof HTMLElement)) {
            return;
        }
        setOverflowing(text.offsetHeight > box.clientHeight);
        const topInBox = (line: HTMLElement): number => text.offsetTop + line.offsetTop;
        const previous = anchorRef.current;
        anchorRef.current = { start: Number(last.dataset.start), top: topInBox(last) };
        const anchor = previous && text.querySelector(`[data-start="${previous.start}"]`);
        if (!previous || !(anchor instanceof HTMLElement) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }
        const shift = Math.min(previous.top - topInBox(anchor), box.clientHeight);
        if (shift <= 0) {
            return;
        }
        // Where a running slide currently is, so that the next one picks up from there. Never more than a box height
        // below: when text arrives in bursts faster than the slides run, the offsets would otherwise add up until the
        // text sits far below the box (an empty preview) and then races back up.
        const transform = getComputedStyle(text).transform;
        const currentOffset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
        const from = Math.min(currentOffset + shift, box.clientHeight);
        text.getAnimations().forEach(animation => animation.cancel());
        text.animate([{ transform: `translateY(${from}px)` }, { transform: 'none' }],
            { duration: PREVIEW_SCROLL_DURATION, easing: 'ease-out' });
    }, [paragraphs]);
    return <div className={`theia-thinking-preview callisto-thinking-preview${overflowing ? ' overflowing' : ''}`} aria-hidden
        ref={element => { boxRef.current = element ?? undefined; }}>
        <div className='theia-thinking-preview-text' ref={element => { textRef.current = element ?? undefined; }}>
            {paragraphs.map(paragraph => <div key={paragraph.start} data-start={paragraph.start}>{paragraph.text}</div>)}
        </div>
    </div>;
};
