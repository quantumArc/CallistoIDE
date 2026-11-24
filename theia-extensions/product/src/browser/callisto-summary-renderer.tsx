/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { injectable } from '@theia/core/shared/inversify';
import { ChatResponseContent, CompactionChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { CALLISTO_SUMMARY_PROVIDER, isCallistoSummaryData, wordCount } from '../common/conversation-summary.js';

/**
 * Marks the place in the chat up to which the Callisto agent summarized it, and shows the summary on click. Theia's own
 * marker ("Conversation compacted") stays for other providers' compaction.
 */
@injectable()
export class CallistoSummaryRenderer implements ChatResponsePartRenderer<CompactionChatResponseContent> {

    canHandle(response: ChatResponseContent): number {
        return CompactionChatResponseContent.is(response) && response.provider === CALLISTO_SUMMARY_PROVIDER ? 11 : -1;
    }

    render(response: CompactionChatResponseContent): React.ReactNode {
        const summary = response.summary ?? '';
        const tokens = isCallistoSummaryData(response.data) ? response.data.tokensBefore : undefined;
        const size = tokens ? ` (${tokens.toLocaleString('en-US')} tokens)` : '';
        return <details className='callisto-summary'>
            <summary>
                <span className='codicon codicon-fold' />
                <span>
                    Callisto summarized the conversation up to here{size}. From now on the model gets
                    this {wordCount(summary).toLocaleString('en-US')}-word summary instead of the messages above, so each request starts
                    short. The messages stay here for you.
                </span>
            </summary>
            <div className='callisto-summary-text'>{summary}</div>
        </details>;
    }
}
