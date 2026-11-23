/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ChatResponseContent, ThinkingChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ThinkingPartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-renderer/thinking-part-renderer';
import { ResponseNode } from '@theia/ai-chat-ui/lib/browser/chat-tree-view/chat-view-tree-widget';
import { AiRunStatsService, formatDuration, formatRate, formatTokens } from './ai-run-stats.js';

/**
 * Theia's thinking renderer, plus the run's elapsed time, output tokens and speed on the 'Thinking' line
 * while the model is thinking: `Thinking · 1m 12s · ~2.3k tokens · 34 tok/s`.
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
        const original = super.render(response, parentNode);
        if (!parentNode || !this.isThinking(response, parentNode)) {
            return original;
        }
        return <ThinkingWithStats runStats={this.runStats} responseId={parentNode.response.id}>{original}</ThinkingWithStats>;
    }
}

/**
 * The stats go onto the existing 'Thinking' status line through a CSS variable read by its `::after`, so
 * Theia's markup and its live reasoning preview stay untouched.
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
