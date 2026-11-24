// Reads LM Studio's server log to measure what each eval turn cost the model server.
//
// LM Studio writes one log per day to ~/.cache/lm-studio/server-logs/YYYY-MM/YYYY-MM-DD.N.log. A mark records the
// newest log and its size; reading from a mark returns only what was logged since, so nothing has to be matched by
// timestamp. Other clients of the same LM Studio (the user's own Callisto, say) would be counted too.

import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOG_ROOT = join(homedir(), '.cache', 'lm-studio', 'server-logs');

function logFiles() {
    if (!existsSync(LOG_ROOT)) {
        return [];
    }
    const files = [];
    for (const month of readdirSync(LOG_ROOT)) {
        const dir = join(LOG_ROOT, month);
        if (!statSync(dir).isDirectory()) {
            continue;
        }
        for (const name of readdirSync(dir)) {
            if (name.endsWith('.log')) {
                const path = join(dir, name);
                files.push({ path, mtime: statSync(path).mtimeMs });
            }
        }
    }
    return files.sort((a, b) => a.mtime - b.mtime);
}

/** Where the log is now: read from here later to get only what was logged in between. */
export function mark() {
    const files = logFiles();
    const newest = files[files.length - 1];
    return newest ? { path: newest.path, size: statSync(newest.path).size, time: Date.now() } : undefined;
}

/** Everything logged since the mark, including in log files started since (a new day). */
export function readSince(from) {
    if (!from) {
        return '';
    }
    let text = '';
    for (const file of logFiles()) {
        if (file.path === from.path) {
            text += readRange(file.path, from.size);
        } else if (file.mtime >= from.time && file.path > from.path) {
            text += readRange(file.path, 0);
        }
    }
    return text;
}

function readRange(path, start) {
    const size = statSync(path).size;
    if (size <= start) {
        return '';
    }
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try {
        readSync(fd, buffer, 0, buffer.length, start);
    } finally {
        closeSync(fd);
    }
    return buffer.toString('utf8');
}

/**
 * What the model server did in a stretch of log:
 * - `modelCalls`: chat completions started;
 * - `promptTokensRead`: prompt tokens it had to process (not taken from its cache), summed over those calls;
 * - `promptSeconds`: time spent processing them;
 * - `generatedTokens`, `generateSeconds`: tokens it wrote (reasoning included) and the time that took;
 * - `disconnects`: requests the client dropped (cancellations, timeouts);
 * - `errors`: lines logged at ERROR level.
 *
 * Every finished call ends with llama.cpp's `prompt eval time = … ms / N tokens` and `eval time = … ms / N tokens`
 * lines, which are exact. A call cut off before that only has the progress lines (`prompt processing, n_tokens = …`),
 * which appear every 2,048 tokens; those count for calls without a total.
 */
export function summarize(text) {
    return summarizeSplit(text, '')[0];
}

/**
 * Like {@link summarize}, for a turn and what followed it. Each model call is counted where it ended: a summary that
 * Callisto starts in the same second the reply completes belongs to what followed, not to the turn.
 */
export function summarizeSplit(turnText, afterText) {
    const parts = [turnText, afterText].map(text => text.split('\n'));
    // Per llama.cpp task (one per model call): its numbers and the part its last line is in.
    const calls = new Map();
    const call = id => {
        if (!calls.has(id)) {
            calls.set(id, { part: 0, prompt: undefined, progress: { tokens: 0, seconds: 0 }, generated: { tokens: 0, seconds: 0 } });
        }
        return calls.get(id);
    };
    const counts = parts.map(() => ({ started: 0, finished: 0, disconnects: 0, errors: 0 }));
    parts.forEach((lines, part) => {
        for (const line of lines) {
            if (line.includes('Running chat completion on conversation')) {
                counts[part].started++;
            } else if (line.includes('Finished streaming response')) {
                counts[part].finished++;
            } else if (line.includes('Client disconnected')) {
                counts[part].disconnects++;
            } else if (line.includes('[ERROR]')) {
                counts[part].errors++;
            }
            let match = line.match(/task (\d+) \|\s+prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/);
            if (match) {
                Object.assign(call(match[1]), { part, prompt: { tokens: Number(match[3]), seconds: Number(match[2]) / 1000 } });
                continue;
            }
            match = line.match(/task (\d+) \|\s+eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/);
            if (match) {
                Object.assign(call(match[1]), { part, generated: { tokens: Number(match[3]), seconds: Number(match[2]) / 1000 } });
                continue;
            }
            match = line.match(/task (\d+) \| prompt processing, n_tokens =\s*(\d+), progress = [\d.]+, t =\s*([\d.]+) s/);
            if (match) {
                const entry = call(match[1]);
                entry.part = part;
                entry.progress = {
                    tokens: Math.max(entry.progress.tokens, Number(match[2])), seconds: Math.max(entry.progress.seconds, Number(match[3]))
                };
            }
        }
    });
    return parts.map((_, part) => {
        const mine = [...calls.values()].filter(entry => entry.part === part);
        const prompt = mine.map(entry => entry.prompt ?? entry.progress);
        const sum = (list, key) => list.reduce((total, entry) => total + entry[key], 0);
        const { started, finished, disconnects, errors } = counts[part];
        return {
            modelCalls: mine.length,
            finished,
            inFlight: started - finished - disconnects,
            promptTokensRead: sum(prompt, 'tokens'),
            promptSeconds: round(sum(prompt, 'seconds')),
            generatedTokens: sum(mine.map(entry => entry.generated), 'tokens'),
            generateSeconds: round(sum(mine.map(entry => entry.generated), 'seconds')),
            disconnects,
            errors
        };
    });
}

function round(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Waits until the model server has finished every call started since the mark and logged nothing new for `quietMs`,
 * e.g. a summary Callisto writes in the background after a reply.
 */
export async function waitForIdle(from, { quietMs = 6000, timeoutMs = 15 * 60 * 1000 } = {}) {
    const started = Date.now();
    let lastLength = -1;
    let quietSince = Date.now();
    while (Date.now() - started < timeoutMs) {
        const text = readSince(from);
        const activity = text.split('\n').filter(line => !/GET to \/api\/v1\/models|Returning \d+ models/.test(line)).length;
        if (activity !== lastLength) {
            lastLength = activity;
            quietSince = Date.now();
        }
        if (summarize(text).inFlight <= 0 && Date.now() - quietSince >= quietMs) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}
