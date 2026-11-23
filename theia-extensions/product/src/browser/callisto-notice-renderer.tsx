/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { injectable } from '@theia/core/shared/inversify';
import { ChatResponseContent, InformationalChatResponseContent } from '@theia/ai-chat/lib/common/chat-model';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';

/** Notices from the Callisto agent's harness start with this word. */
const CALLISTO_NOTICE_PREFIX = 'Callisto ';

/**
 * Shows the Callisto agent's own notices (e.g. "Callisto interrupted the model because …") in the chat. Theia renders
 * informational content as nothing at all; notices from anything else stay hidden as before. They are never sent to
 * the model either way.
 */
@injectable()
export class CallistoNoticeRenderer implements ChatResponsePartRenderer<InformationalChatResponseContent> {

    canHandle(response: ChatResponseContent): number {
        return InformationalChatResponseContent.is(response) && response.content.value.startsWith(CALLISTO_NOTICE_PREFIX) ? 11 : -1;
    }

    render(response: InformationalChatResponseContent): React.ReactNode {
        return <div className='callisto-notice'>
            <span className='codicon codicon-debug-pause' />
            <span>{response.content.value}</span>
        </div>;
    }
}
