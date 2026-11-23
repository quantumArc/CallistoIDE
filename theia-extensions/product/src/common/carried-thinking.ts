/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    ChatResponseContent, ErrorChatResponseContent, InformationalChatResponseContent, ThinkingChatResponseContent, ToolCallChatResponseContent
} from '@theia/ai-chat/lib/common';

/**
 * The thinking parts the backend tool loop sent back to the model: those of every model turn that ended in a tool call
 * (a turn's reasoning may be split by text, so all of it since the previous tool call counts). Reasoning that ended in
 * an interruption or in the final answer was never sent back, so it is not carried either.
 */
export function carriedThinking(content: readonly ChatResponseContent[]): Set<ChatResponseContent> {
    const carried = new Set<ChatResponseContent>();
    let turn: ChatResponseContent[] = [];
    for (const part of content) {
        if (ThinkingChatResponseContent.is(part) && !part.signature) {
            turn.push(part);
        } else if (ToolCallChatResponseContent.is(part)) {
            turn.forEach(thinking => carried.add(thinking));
            turn = [];
        } else if (InformationalChatResponseContent.is(part) || ErrorChatResponseContent.is(part)) {
            turn = [];
        }
    }
    return carried;
}
