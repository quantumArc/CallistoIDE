/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { formatToolCallContentForModel, isToolCallContent, ToolCallImageResult, ToolCallResult } from '@theia/ai-core';

/**
 * Text of the message that carries the images tool calls returned (the browser's screenshots). Never change it: the
 * chat history is rebuilt with it for every later request, and LM Studio's prompt cache matches only identical text.
 */
export function toolImagesNote(count: number): string {
    return count === 1
        ? '[Callisto] The image returned by the tool call above, for you to look at:'
        : `[Callisto] The ${count} images returned by the tool calls above, in order, for you to look at:`;
}

/**
 * Chat Completions has no images in tool results. Theia turns an image a tool returns into JSON text, so the model got
 * ~100k characters of base64 instead of a picture. Callisto sends the tool result's text as the tool message and the
 * images right after the turn's tool messages, in a user message.
 */
export interface SplitToolResult {
    text: string;
    images: ToolCallImageResult[];
}

/** The tool result without its images, and the images; undefined when it has none. */
export function splitToolImages(result: ToolCallResult): SplitToolResult | undefined {
    if (!isToolCallContent(result)) {
        return undefined;
    }
    const images = result.content.filter((item): item is ToolCallImageResult => item.type === 'image' && !!(item as ToolCallImageResult).base64data);
    if (images.length === 0) {
        return undefined;
    }
    return { text: formatToolCallContentForModel({ content: result.content.filter(item => item.type !== 'image') }), images };
}

export interface ImagesMessage {
    role: 'user';
    content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
}

export function toolImagesMessage(images: readonly ToolCallImageResult[]): ImagesMessage {
    return {
        role: 'user',
        content: [
            { type: 'text', text: toolImagesNote(images.length) },
            ...images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.base64data}` } }))
        ]
    };
}

interface ChatMessage {
    role: string;
    tool_call_id?: string;
}

/**
 * Puts each run of tool messages' images right after the run, the way the tool loop sent them while the task ran.
 * @param images images by tool call id, taken out of the tool messages beforehand
 */
export function insertToolImages<T extends ChatMessage>(messages: T[], images: ReadonlyMap<string, ToolCallImageResult[]>): (T | ImagesMessage)[] {
    if (images.size === 0) {
        return messages;
    }
    const result: (T | ImagesMessage)[] = [];
    let run: ToolCallImageResult[] = [];
    for (const message of messages) {
        if (message.role !== 'tool' && run.length > 0) {
            result.push(toolImagesMessage(run));
            run = [];
        }
        result.push(message);
        if (message.role === 'tool' && message.tool_call_id) {
            run.push(...images.get(message.tool_call_id) ?? []);
        }
    }
    if (run.length > 0) {
        result.push(toolImagesMessage(run));
    }
    return result;
}

/** The result with its images replaced by a line saying why the model does not get them. */
export function withoutToolImages(result: ToolCallResult, reason: string): ToolCallResult {
    const split = splitToolImages(result);
    return split ? `${split.text}\n\n(${reason})` : result;
}

/**
 * Characters of the messages as text, with each image counted as {@link IMAGE_CHARS} rather than its base64 data,
 * for estimates of how much of the context window they fill.
 */
export function messagesChars(messages: unknown): number {
    return JSON.stringify(messages, (key, value) =>
        (key === 'base64data' || key === 'base64') && typeof value === 'string' ? IMAGE_PLACEHOLDER : value).length;
}

/** About what an image costs a vision model in tokens (≈1,500), at the estimate's 2.5 characters per token. */
const IMAGE_CHARS = 3750;
const IMAGE_PLACEHOLDER = 'x'.repeat(IMAGE_CHARS);
