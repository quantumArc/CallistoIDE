// Starts Callisto's browser build on a scratch workspace and config dir, and drives its chat with Puppeteer.
//
// The browser build is used, never the Electron app: the Electron app allows a single instance, so starting it would
// reach into the user's own window. Each task gets its own server, config and workspace, so nothing carries over.

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { latestSession, turns } from './chat.mjs';

export const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const BROWSER_APP = join(REPO, 'applications', 'browser');

/**
 * Starts the backend and resolves once it is listening. Readiness is read from this server's own log: answering HTTP
 * is not enough, since the previous task's server can still hold the port for a moment while it shuts down.
 */
export async function startServer({ workspace, configDir, port, logFile }) {
    if (!await waitForPortFree(port, 30_000)) {
        throw new Error(`Port ${port} is still in use`);
    }
    const out = openSync(logFile, 'a');
    const child = spawn('yarn', ['-s', 'start', workspace, '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: BROWSER_APP,
        env: { ...process.env, THEIA_CONFIG_DIR: configDir },
        detached: true,
        stdio: ['ignore', out, out]
    });
    closeSync(out);
    let exited = false;
    child.on('exit', () => { exited = true; });
    const listening = `listening on http://127.0.0.1:${port}`;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        if (exited) {
            throw new Error(`The Callisto backend exited during startup; see ${logFile}`);
        }
        const log = readFileSync(logFile, 'utf8');
        if (log.includes('EADDRINUSE')) {
            await stopServer(child);
            throw new Error(`Port ${port} was taken while the backend started; see ${logFile}`);
        }
        if (log.includes(listening)) {
            return child;
        }
        await sleep(1000);
    }
    await stopServer(child);
    throw new Error(`The Callisto backend did not answer on port ${port} within 3 minutes`);
}

/**
 * Stops the backend and everything it started (plugin hosts, language servers): the whole process group, since `yarn`
 * can exit before the Node backend under it does.
 */
export async function stopServer(child) {
    if (!child) {
        return;
    }
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        return;
    }
    for (let i = 0; i < 20 && groupAlive(child.pid); i++) {
        await sleep(250);
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        // Already gone.
    }
}

function groupAlive(pgid) {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Resolves true once nothing accepts connections on the port. */
export async function waitForPortFree(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const inUse = await new Promise(resolve => {
            const socket = connect({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
        });
        if (!inUse) {
            return true;
        }
        await sleep(500);
    }
    return false;
}

export async function openBrowser() {
    return puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 1000 }, args: ['--no-first-run'] });
}

/** Loads the workspace in a new page and opens a new chat. */
export async function openChat(browser, { port, workspace }) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/#${workspace}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('#theia-app-shell', { timeout: 180_000 });
    // The shell is there before the workbench is usable; give contributions a moment to start.
    await sleep(4000);
    await runCommand(page, 'Chat: New Chat');
    await page.waitForSelector('.theia-ChatInput-Editor', { visible: true, timeout: 60_000 });
    return page;
}

/** Runs a command through the command palette, by its label. */
export async function runCommand(page, label) {
    await page.keyboard.press('F1');
    await page.waitForSelector('.quick-input-widget input', { visible: true, timeout: 20_000 });
    await page.keyboard.sendCharacter(label);
    await sleep(800);
    await page.keyboard.press('Enter');
    await sleep(1000);
}

/**
 * Sends a chat message and waits until the session on disk shows the request. Inserted in one piece, so the editor's
 * bracket auto-closing never runs on it; the mention of @Callisto is parsed from the text on send.
 */
export async function sendMessage(page, configDir, text) {
    const before = turns(latestSession(configDir)).length;
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.click('.theia-ChatInput-Editor');
        await page.keyboard.sendCharacter(text);
        await sleep(500);
        await page.keyboard.press('Enter');
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            if (turns(latestSession(configDir)).length > before) {
                return;
            }
            await sleep(1000);
        }
        // Not sent (e.g. a suggestion popup took the Enter): clear the input and try once more.
        await page.click('.theia-ChatInput-Editor');
        await page.keyboard.down('Meta');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Meta');
        await page.keyboard.press('Backspace');
    }
    throw new Error('The chat message was not sent');
}

/** Waits until the response to the given turn (0-based) is complete; returns the session, or undefined on timeout. */
export async function waitForResponse(configDir, turnIndex, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const session = latestSession(configDir);
        const turn = turns(session)[turnIndex];
        if (turn?.response?.isComplete) {
            return session;
        }
        await sleep(2000);
    }
    return undefined;
}

/** Waits until Callisto has stored a summary in the chat; returns the session, or undefined on timeout. */
export async function waitForSummary(configDir, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const session = latestSession(configDir);
        if (turns(session).some(turn => (turn.response?.content ?? []).some(part => part.kind === 'compaction' && part.data?.provider === 'callisto'))) {
            return session;
        }
        await sleep(2000);
    }
    return undefined;
}

/** Presses the chat's stop button, for a turn that ran out of time. */
export async function stopResponse(page) {
    try {
        await runCommand(page, 'Chat: Cancel');
    } catch {
        // The page may be gone; the server is stopped next anyway.
    }
}
