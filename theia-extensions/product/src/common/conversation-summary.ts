/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Callisto's summaries of long chats with local models.
 *
 * Every message to a local model re-sends the whole chat, and LM Studio reads it again from the first difference to
 * its prompt cache. When the cache is gone (LM Studio restarted, or unloaded the model after an idle hour), a long
 * chat is read again from the start: 65k tokens took Inkling 2 Mini over 6 minutes. Once a chat is long, Callisto has
 * the model summarize it, while the cache is still warm, and from then on sends the summary instead of the messages it
 * covers. The summary is stored in the chat (as a compaction part, which Theia saves and restores), so it outlives
 * restarts; the chat itself stays visible.
 */

/** `provider` of the compaction parts Callisto writes; other providers' parts (Anthropic's server-side ones) are left to Theia. */
export const CALLISTO_SUMMARY_PROVIDER = 'callisto';

/** Default for `callisto.agent.summarizeAfterTokens`. About a third of Inkling's context; ~1½ minutes to read cold. */
export const DEFAULT_SUMMARIZE_AFTER_TOKENS = 32000;
/** Never summarize below this: Callisto's own instructions and tools take about 8,500 tokens of every chat. */
export const MIN_SUMMARIZE_AFTER_TOKENS = 16000;
/** Summarize by the time the chat fills this share of the loaded context, even if the setting is higher. */
const MAX_SHARE_OF_CONTEXT = 0.5;

/** Shortest text accepted as a summary; anything shorter is an error message or an empty reply. */
export const MIN_SUMMARY_CHARS = 200;
/** Longest summary kept; the instruction asks for under 800 words (about 5,500 characters). */
export const MAX_SUMMARY_CHARS = 16000;

/** What Callisto records with a summary, next to the model's text. */
export interface CallistoSummaryData {
    version: 1;
    /** The last request the summary covers: it replaces that request and everything before it. */
    coveredRequestId: string;
    /** Tokens the chat had when it was summarized, when known. */
    tokensBefore?: number;
    /** Files changed in the covered part of the chat, collected from the tool calls (not from the model's memory). */
    files: string[];
    /** The model's latest todo list in the covered part, if any. */
    todos?: TodoItem[];
}

export interface TodoItem {
    content: string;
    status: string;
}

export function isCallistoSummaryData(data: unknown): data is CallistoSummaryData {
    const d = data as Partial<CallistoSummaryData> | undefined;
    return !!d && d.version === 1 && typeof d.coveredRequestId === 'string' && Array.isArray(d.files);
}

/**
 * The chat size, in tokens, from which Callisto summarizes it: the setting, but no more than half the context the model
 * is loaded with, and never less than {@link MIN_SUMMARIZE_AFTER_TOKENS}. `undefined` when summaries are off (`0`).
 */
export function summarizeThreshold(settingTokens: number | undefined, loadedContext: number | undefined): number | undefined {
    const setting = settingTokens ?? DEFAULT_SUMMARIZE_AFTER_TOKENS;
    if (!(setting > 0)) {
        return undefined;
    }
    const byContext = loadedContext ? Math.floor(loadedContext * MAX_SHARE_OF_CONTEXT) : Infinity;
    return Math.max(MIN_SUMMARIZE_AFTER_TOKENS, Math.min(setting, byContext));
}

/** The request that asks the model for the summary, sent as the last message after the whole chat. */
export function summaryInstruction(hasEarlierSummary: boolean): string {
    const earlier = hasEarlierSummary
        ? ' The chat already starts with an earlier summary: fold what it says into this one, so that nothing from it is lost.'
        : '';
    return '[Callisto] Pause the task for a moment. This chat has become long, so Callisto will replace everything above with a '
        + 'summary that you write now. From then on you will see only your summary, not the messages above, so it must hold '
        + `everything needed to carry on.${earlier}\n\n`
        + 'Do not call any tools. Reply with the summary only, in this structure:\n\n'
        + '## User\'s requests\n'
        + 'Each request the user made, in order, in a sentence or two. Quote the latest one word for word. Include every preference, '
        + 'correction and constraint the user gave. Messages starting with [Callisto], like this one, come from Callisto, not the user: '
        + 'leave them out.\n\n'
        + '## Current state\n'
        + 'What exists now: the files you created or changed and what each one does, and how to run and test the project.\n\n'
        + '## Done and verified\n'
        + 'What works, and how it was checked.\n\n'
        + '## Not done or broken\n'
        + 'Open problems, known bugs and failing checks, with the exact error messages that matter.\n\n'
        + '## Decisions and lessons\n'
        + 'Important choices and why; approaches that failed and must not be tried again.\n\n'
        + '## Next step\n'
        + 'If the last task is unfinished, exactly what to do next. Otherwise: "Waiting for the user."\n\n'
        + 'Be specific: name files, functions, commands and errors. Do not copy whole files: they stay on disk. Keep it under 800 words.';
}

/** The message that stands in for the covered part of the chat, in every request from then on. Never changes once written. */
export function summaryMessage(summary: string, data: CallistoSummaryData): string {
    const lines = [
        '[Callisto] The earlier part of this chat was replaced by the summary below, which you wrote at the time. The files on disk '
        + 'are the source of truth: read a file again before you change it.',
        '',
        '<summary>',
        summary.trim(),
        '</summary>'
    ];
    if (data.files.length > 0) {
        lines.push('', `Files changed so far (from Callisto's record of your tool calls): ${data.files.join(', ')}`);
    }
    if (data.todos && data.todos.length > 0) {
        lines.push('', 'Your todo list at that point:', ...data.todos.map(todo => `- [${todo.status}] ${todo.content}`));
    }
    return lines.join('\n');
}

/**
 * The model's reply, cleaned up into a summary: reasoning that leaked into the text is dropped, and so is anything
 * before the first heading when the reply opens with chatter. `undefined` when what is left is too short to be one.
 */
export function cleanSummary(reply: string): string | undefined {
    let text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const firstHeading = text.search(/^#{1,3} /m);
    if (firstHeading > 0) {
        text = text.slice(firstHeading);
    }
    text = text.trim();
    if (text.length < MIN_SUMMARY_CHARS) {
        return undefined;
    }
    return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS).trimEnd()}\n…` : text;
}

/** Files named in the given write tool calls' arguments, in first-seen order, without duplicates. */
export function changedFiles(argumentStrings: readonly string[], earlier: readonly string[] = []): string[] {
    const files = new Set(earlier);
    for (const args of argumentStrings) {
        try {
            const parsed = JSON.parse(args) as { path?: unknown; file?: unknown };
            const path = parsed.path ?? parsed.file;
            if (typeof path === 'string' && path.trim()) {
                files.add(path.trim().replace(/^\.\//, ''));
            }
        } catch {
            // Arguments that are not JSON name no file.
        }
    }
    return [...files];
}

/** The todo list in a `todoWrite` call's arguments. */
export function parseTodos(args: string | undefined): TodoItem[] | undefined {
    if (!args) {
        return undefined;
    }
    try {
        const todos = (JSON.parse(args) as { todos?: { content?: unknown; status?: unknown }[] }).todos;
        if (!Array.isArray(todos)) {
            return undefined;
        }
        return todos
            .filter(todo => typeof todo.content === 'string')
            .map(todo => ({ content: todo.content as string, status: typeof todo.status === 'string' ? todo.status : 'pending' }));
    } catch {
        return undefined;
    }
}

/** Rough word count, for telling the user how long the summary is. */
export function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}
