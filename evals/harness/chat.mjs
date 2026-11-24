// Reads the chat Callisto saves to disk (<config>/workspace-metadata/<workspace>/chatSessions/<session>.json): the
// eval follows the agent's progress there instead of scraping the UI.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The most recently saved chat session under a Theia config dir, parsed; undefined until one is saved. */
export function latestSession(configDir) {
    const root = join(configDir, 'workspace-metadata');
    if (!existsSync(root)) {
        return undefined;
    }
    let newest;
    for (const workspace of readdirSync(root)) {
        const dir = join(root, workspace, 'chatSessions');
        if (!existsSync(dir)) {
            continue;
        }
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.json') || name === 'index.json') {
                continue;
            }
            const path = join(dir, name);
            const mtime = statSync(path).mtimeMs;
            if (!newest || mtime > newest.mtime) {
                newest = { path, mtime };
            }
        }
    }
    if (!newest) {
        return undefined;
    }
    try {
        return { path: newest.path, data: JSON.parse(readFileSync(newest.path, 'utf8')) };
    } catch {
        // Caught mid-write: try again on the next poll.
        return undefined;
    }
}

/** Requests and their responses, in order. */
export function turns(session) {
    const model = session?.data?.model;
    if (!model) {
        return [];
    }
    const responses = new Map((model.responses ?? []).map(response => [response.requestId, response]));
    return (model.requests ?? []).map(request => ({ request, response: responses.get(request.id) }));
}

/** The text the agent answered with in a response (its markdown parts). */
export function answerText(response) {
    return (response?.content ?? [])
        .filter(part => part.kind === 'markdownContent' || part.kind === 'text')
        .map(part => part.data?.content ?? '')
        .join('\n')
        .trim();
}

/** Callisto's summary of the chat, if it wrote one in this response. */
export function summaryIn(response) {
    const part = (response?.content ?? []).find(p => p.kind === 'compaction' && p.data?.provider === 'callisto');
    return part ? { text: part.data.summary ?? '', data: part.data.data ?? {} } : undefined;
}

/** What one response did, for the results table. */
export function responseStats(response) {
    const content = response?.content ?? [];
    const toolCalls = content.filter(part => part.kind === 'toolCall');
    const notices = content.filter(part => part.kind === 'informational').map(part => noticeText(part));
    const byTool = {};
    for (const call of toolCalls) {
        const name = call.data?.name ?? '?';
        byTool[name] = (byTool[name] ?? 0) + 1;
    }
    const errorPart = content.find(part => part.kind === 'error');
    return {
        complete: response?.isComplete === true,
        error: response?.isError || errorPart ? (response?.errorMessage ?? errorPart?.data?.message ?? 'error') : undefined,
        toolCalls: toolCalls.length,
        byTool,
        interruptions: notices.filter(text => text.startsWith('Callisto interrupted')).length,
        // "Callisto stopped the model" is the same hand-back in older builds.
        pausedForUser: notices.some(text => text.startsWith('Callisto paused') || text.startsWith('Callisto stopped')),
        lastPromptTokens: response?.tokenUsage?.inputTokens,
        lastOutputTokens: response?.tokenUsage?.outputTokens,
        reasoningChars: content.filter(part => part.kind === 'thinking').reduce((sum, part) => sum + (part.data?.content?.length ?? 0), 0),
        summary: summaryIn(response) ? { words: summaryIn(response).text.split(/\s+/).filter(Boolean).length, tokensBefore: summaryIn(response).data.tokensBefore } : undefined
    };
}

function noticeText(part) {
    const content = part.data?.content;
    return typeof content === 'string' ? content : (content?.value ?? '');
}
