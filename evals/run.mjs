#!/usr/bin/env node
// Runs the Callisto harness evals: each task in its own scratch workspace and config, against the browser build and
// the model loaded in LM Studio, then prints and saves a results table. See evals/README.md.
//
//   node evals/run.mjs [--tasks fix-bug,rename] [--reasoning low] [--model lmstudio/<id>] [--port 3100] [--label text]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import * as lmLog from './harness/lmstudio-log.mjs';
import { formatLine, markdownTable } from './harness/report.mjs';
import { latestSession, turns, answerText, responseStats } from './harness/chat.mjs';
import {
    REPO, openBrowser, openChat, sendMessage, startServer, stopResponse, stopServer, waitForPortFree, waitForResponse, waitForSummary
} from './harness/app.mjs';

const EVALS = join(REPO, 'evals');
const TASKS = join(EVALS, 'tasks');
const LM_STUDIO = 'http://127.0.0.1:1234';
/** The SearXNG the web tasks search through: Callisto's default address. */
const SEARXNG = process.env.CALLISTO_EVAL_SEARXNG_URL ?? 'http://127.0.0.1:8888';

const { values: options } = parseArgs({
    options: {
        tasks: { type: 'string' },
        reasoning: { type: 'string', default: 'low' },
        model: { type: 'string' },
        'lmstudio-model': { type: 'string', default: 'thinkingmachines/inkling-2-mini' },
        port: { type: 'string', default: '3100' },
        label: { type: 'string', default: '' },
        'allow-unloaded': { type: 'boolean', default: false }
    }
});
const port = Number(options.port);

/** Tools that would otherwise ask before running. The evals run unattended, in scratch folders. */
const AUTO_APPROVED_TOOLS = ['shellExecute', 'writeFileContent', 'writeFileReplacements', 'runTask', 'runLaunchConfiguration',
    'stopLaunchConfiguration', 'suggestFileContent', 'suggestFileReplacements', 'clearFileChanges'];

async function main() {
    const taskIds = (options.tasks ? options.tasks.split(',') : readdirSync(TASKS).filter(id => existsSync(join(TASKS, id, 'task.json'))))
        .map(id => id.trim()).filter(Boolean);
    const model = await preflight();
    const runId = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const resultsDir = join(EVALS, 'results', runId);
    const workRoot = join(realpathSync(tmpdir()), 'callisto-evals', runId);
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(workRoot, { recursive: true });
    const run = {
        runId,
        label: options.label,
        started: new Date().toISOString(),
        harness: gitDescribe(),
        reasoning: options.reasoning,
        model: options.model ?? 'default (Callisto\'s default/code alias)',
        lmStudio: model,
        tasks: []
    };
    console.log(`Callisto evals ${runId}: ${taskIds.length} tasks, reasoning ${options.reasoning}, ${run.harness}`);
    console.log(`  LM Studio: ${model.key}, context ${model.contextLength ?? '?'}; scratch: ${workRoot}\n`);
    const browser = await openBrowser();
    try {
        for (const id of taskIds) {
            const result = await runTask(id, browser, { workRoot, resultsDir });
            run.tasks.push(result);
            console.log(formatLine(result));
            writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(run, undefined, 2));
        }
    } finally {
        await browser.close();
    }
    run.finished = new Date().toISOString();
    writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(run, undefined, 2));
    const table = markdownTable(run);
    writeFileSync(join(resultsDir, 'results.md'), table);
    console.log(`\n${table}\nSaved to ${resultsDir}`);
}

async function runTask(id, browser, { workRoot, resultsDir }) {
    const taskDir = join(TASKS, id);
    const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'));
    const fixtureDir = join(taskDir, 'fixture');
    const workspace = join(workRoot, id, 'workspace');
    const configDir = join(workRoot, id, 'config');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    if (existsSync(fixtureDir)) {
        cpSync(fixtureDir, workspace, { recursive: true });
    }
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settingsFor(workspace, task), undefined, 4));

    const result = { id, title: task.title, turns: [], pass: false, notes: [] };
    const missing = await missingRequirements(task.requires ?? []);
    if (missing.length > 0) {
        return { ...result, skipped: true, seconds: 0, notes: [`skipped: ${missing.join('; ')}`] };
    }
    if (Array.isArray(task.setup) && task.setup.length > 0) {
        // e.g. installing the fixture's dependencies, which are not committed with it.
        try {
            execFileSync(task.setup[0], task.setup.slice(1), { cwd: workspace, stdio: 'pipe', timeout: 5 * 60_000 });
        } catch (error) {
            return { ...result, skipped: true, seconds: 0, notes: [`skipped: setup \`${task.setup.join(' ')}\` failed: ${String(error.message).split('\n')[0]}`] };
        }
    }
    const started = Date.now();
    let server;
    let page;
    try {
        server = await startServer({ workspace, configDir, port, logFile: join(resultsDir, `${id}.server.log`) });
        page = await openChat(browser, { port, workspace });
        for (const [index, turn] of task.turns.entries()) {
            result.turns.push(await runTurn(page, configDir, index, turn, join(resultsDir, `${id}.turn${index + 1}.lmstudio.log`)));
        }
    } catch (error) {
        result.notes.push(`harness error: ${error.message}`);
    } finally {
        await page?.close().catch(() => undefined);
        await stopServer(server);
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    const session = latestSession(configDir);
    if (session) {
        copyFileSync(session.path, join(resultsDir, `${id}.chat.json`));
    }
    const answers = result.turns.map(turn => turn.answer);
    try {
        const { default: check } = await import(pathToFileURL(join(taskDir, 'check.mjs')).href);
        const verdict = await check({ workspace, fixtureDir, answers, turnResults: result.turns, chat: session?.data });
        result.pass = verdict.pass && !result.notes.some(note => note.startsWith('harness error'));
        result.notes.push(...verdict.notes);
    } catch (error) {
        result.notes.push(`check error: ${error.message}`);
    }
    result.workspace = workspace;
    return result;
}

async function runTurn(page, configDir, index, turn, logCopy) {
    const timeoutMs = (turn.timeoutMinutes ?? 15) * 60_000;
    const before = lmLog.mark();
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    await sendMessage(page, configDir, turn.message);
    let session = await waitForResponse(configDir, index, timeoutMs);
    const timedOut = !session;
    if (timedOut) {
        await stopResponse(page);
        session = await waitForResponse(configDir, index, 60_000) ?? latestSession(configDir);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const turnLog = lmLog.readSince(before);
    const afterTurn = lmLog.mark();

    // Work the model server does after the reply, such as the summary Callisto writes in the background.
    const backgroundStarted = Date.now();
    if (turn.waitForSummary) {
        await waitForSummary(configDir, 10 * 60_000);
    }
    await lmLog.waitForIdle(afterTurn);
    const backgroundLog = lmLog.readSince(afterTurn);
    const [turnStats, background] = lmLog.summarizeSplit(turnLog, backgroundLog);
    // Kept for re-analysis: the turn, then what followed it.
    writeFileSync(logCopy, `${turnLog}\n===== after the reply =====\n${backgroundLog}`);
    session = latestSession(configDir) ?? session;
    const response = turns(session)[index]?.response;
    return {
        message: turn.message,
        startedAt,
        seconds,
        timedOut,
        answer: answerText(response),
        stats: responseStats(response),
        lmStudio: turnStats,
        background: { ...background, seconds: background.modelCalls ? Math.round((Date.now() - backgroundStarted) / 1000) : 0 }
    };
}

/** What a task needs that is not there, e.g. a running SearXNG for the web tasks. */
async function missingRequirements(requires) {
    const missing = [];
    if (requires.includes('searxng')) {
        try {
            const response = await fetch(`${SEARXNG}/healthz`, { signal: AbortSignal.timeout(3000) });
            if (!response.ok) {
                missing.push(`SearXNG at ${SEARXNG} answered ${response.status}`);
            }
        } catch {
            missing.push(`SearXNG is not running at ${SEARXNG} (start it, e.g. \`searxng start\`)`);
        }
    }
    return missing;
}

function settingsFor(workspace, task) {
    const callisto = { reasoning: { level: options.reasoning } };
    if (options.model) {
        callisto.languageModelRequirements = [{ purpose: 'chat', identifier: options.model }];
    }
    return {
        'security.workspace.trust.trustedFolders': [pathToFileURL(workspace).href],
        'ai-features.agentSettings': {
            Callisto: callisto,
            // Titles cost a model call per chat, which would be counted against the task.
            'Chat Session Naming': { enable: false }
        },
        'ai-features.chat.defaultToolConfirmation': 'always_allow',
        'ai-features.chat.toolConfirmation': Object.fromEntries(AUTO_APPROVED_TOOLS.map(tool => [tool, 'always_allow'])),
        'callisto.webSearch.searxngUrl': SEARXNG,
        ...task.settings
    };
}

async function preflight() {
    if (!existsSync(join(REPO, 'applications', 'browser', 'lib', 'backend', 'main.js'))) {
        fail('The browser build is missing. Build it first: yarn --cwd applications/browser build (see evals/README.md).');
    }
    // A run started right after another finds its server still shutting down for a few seconds.
    if (!await waitForPortFree(port, 20_000)) {
        fail(`Port ${port} is already in use. Stop whatever runs there, or pass --port.`);
    }
    let models;
    try {
        models = await (await fetch(`${LM_STUDIO}/api/v1/models`)).json();
    } catch {
        fail(`LM Studio does not answer at ${LM_STUDIO}. Start its server first.`);
    }
    const key = options['lmstudio-model'];
    const entry = (models.models ?? models.data ?? []).find(model => model.key === key || model.id === key);
    const instance = entry?.loaded_instances?.[0];
    if (!instance && !options['allow-unloaded']) {
        fail(`${key} is not loaded in LM Studio. Load it with the context length you use, e.g.\n`
            + `  ~/.cache/lm-studio/bin/lms load ${key} --context-length 99584 -y\n`
            + 'or pass --allow-unloaded to let LM Studio load it on demand (with its default context length).');
    }
    try {
        execFileSync('pgrep', ['-f', 'applications/electron/lib/backend/main.js']);
        console.warn('Warning: Callisto (Electron) is running. Its model calls would be counted against the evals and slow them down.\n');
    } catch {
        // Not running.
    }
    return {
        key,
        contextLength: instance?.config?.context_length,
        parallel: instance?.config?.parallel,
        quantization: entry?.quantization?.name
    };
}

function gitDescribe() {
    try {
        const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
        const dirty = execFileSync('git', ['status', '--porcelain', '--', 'theia-extensions'], { cwd: REPO, encoding: 'utf8' }).trim();
        return `harness ${commit}${dirty ? ' + uncommitted changes' : ''}`;
    } catch {
        return 'harness (git unavailable)';
    }
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

await main();
await sleep(100);
