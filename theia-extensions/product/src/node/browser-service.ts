/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { createReadStream, existsSync, promises as fs, readdirSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { homedir } from 'os';
import { extname, join, relative, resolve, sep } from 'path';
import { launch } from 'puppeteer-core';
import type { Browser, ConsoleMessage, Dialog, HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';
import {
    BrowserAction, BrowserElementSummary, BrowserLogEntry, BrowserRequest, BrowserResult, BrowserService
} from '../common/browser-protocol.js';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_SIZE = 200;
const MAX_SIZE = 2560;
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Pages that keep loading (analytics, long polling) are looked at anyway after this. */
const NETWORK_IDLE_TIMEOUT_MS = 3_000;
const DEFAULT_SETTLE_AFTER_LOAD_MS = 500;
const SETTLE_AFTER_ACTION_MS = 200;
const MAX_WAIT_MS = 10_000;
const ELEMENT_TIMEOUT_MS = 3_000;
const MAX_ACTIONS = 20;
/** The browser and its file servers are shut down after this long without a call. */
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_LOG_ENTRIES = 40;
const MAX_LOG_TEXT = 600;
const MAX_EVALUATE_CHARS = 4_000;
const MAX_TEXT_CHARS = 1_500;
const MAX_ELEMENTS = 40;
const SCREENSHOT_QUALITY = 70;

/**
 * Chrome's own diagnostics, which say nothing about the page: SwiftShader's warning every time a screenshot reads the
 * WebGL canvas back, for example.
 */
const NOISE = [/^Failed to load resource:/, /GL Driver Message/, /GPU stall due to ReadPixels/, /^\[\.WebGL-0x[0-9a-f]+\]/i, /Automatic fallback to software WebGL/];

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
    '.bmp': 'image/bmp', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream', '.hdr': 'application/octet-stream', '.ktx2': 'image/ktx2', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.csv': 'text/csv; charset=utf-8'
};

/**
 * Serves one folder over HTTP on 127.0.0.1, so that a page opened from the workspace behaves as it does on a web
 * server: ES modules, `fetch` and workers are all blocked on `file://`.
 */
class FolderServer {

    protected server: Server | undefined;
    protected port = 0;
    /**
     * Folders (relative to the root) of the pages opened through this server, most recent first. A built page such as
     * `dist/index.html` asks for `/assets/…` from the site root; when that is not in the root, it is looked up here.
     */
    protected readonly pageDirs: string[] = [];

    constructor(readonly root: string) { }

    async start(): Promise<void> {
        if (this.server) {
            return;
        }
        const server = createServer((request, response) => {
            this.handle(request, response).catch(() => {
                if (!response.headersSent) {
                    response.writeHead(500);
                }
                response.end();
            });
        });
        await new Promise<void>((resolvePromise, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolvePromise());
        });
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
    }

    /** The URL of a file inside the root, remembering its folder for root-relative requests. */
    urlFor(file: string): string {
        const path = relative(this.root, file).split(sep);
        const dir = path.slice(0, -1).join('/');
        const known = this.pageDirs.indexOf(dir);
        if (known >= 0) {
            this.pageDirs.splice(known, 1);
        }
        if (dir) {
            this.pageDirs.unshift(dir);
        }
        return `http://127.0.0.1:${this.port}/${path.map(encodeURIComponent).join('/')}`;
    }

    /** The workspace path a URL of this server stands for, or undefined for other URLs. */
    describe(url: string): string | undefined {
        const prefix = `http://127.0.0.1:${this.port}/`;
        return url.startsWith(prefix) ? decodeURIComponentSafe(url.slice(prefix.length).split(/[?#]/)[0]) : undefined;
    }

    close(): void {
        this.server?.close();
        this.server?.closeAllConnections?.();
        this.server = undefined;
    }

    protected async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        const pathname = decodeURIComponentSafe(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
        for (const base of ['', ...this.pageDirs]) {
            const file = await this.find(join(this.root, base, pathname));
            if (file) {
                const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
                // The agent opens the page again after every edit: it must never see a cached copy.
                response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
                if (request.method === 'HEAD') {
                    response.end();
                } else {
                    createReadStream(file).pipe(response);
                }
                return;
            }
        }
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(`Not found: ${pathname}`);
    }

    /** The file to serve for a path: the path itself, or its `index.html`; nothing outside the root. */
    protected async find(candidate: string): Promise<string | undefined> {
        const path = resolve(candidate);
        if (path !== this.root && !path.startsWith(this.root + sep)) {
            return undefined;
        }
        try {
            const stat = await fs.stat(path);
            if (stat.isFile()) {
                return path;
            }
            if (stat.isDirectory()) {
                const index = join(path, 'index.html');
                return (await fs.stat(index)).isFile() ? index : undefined;
            }
        } catch {
            // Not there.
        }
        return undefined;
    }
}

/** Console messages, exceptions and failed requests, with repeats counted instead of listed. */
class LogCollector {
    readonly entries: BrowserLogEntry[] = [];
    omitted = 0;
    protected readonly byKey = new Map<string, BrowserLogEntry>();

    add(kind: string, text: string, source?: string): void {
        const trimmed = text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text;
        const key = `${kind}\u0000${trimmed}\u0000${source ?? ''}`;
        const known = this.byKey.get(key);
        if (known) {
            known.count++;
        } else if (this.entries.length < MAX_LOG_ENTRIES * 4) {
            const entry: BrowserLogEntry = { kind, text: trimmed, source, count: 1 };
            this.byKey.set(key, entry);
            this.entries.push(entry);
        } else {
            this.omitted++;
        }
    }

    /** Errors first, then warnings, then the rest, each group in the order it happened; at most {@link MAX_LOG_ENTRIES}. */
    report(): { log: BrowserLogEntry[]; omitted: number } {
        const rank = (entry: BrowserLogEntry) =>
            entry.kind === 'exception' || entry.kind === 'error' || entry.kind === 'network' ? 0 : entry.kind === 'warning' ? 1 : 2;
        const sorted = this.entries.map((entry, index) => ({ entry, index }))
            .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
            .map(({ entry }) => entry);
        return { log: sorted.slice(0, MAX_LOG_ENTRIES), omitted: this.omitted + Math.max(0, sorted.length - MAX_LOG_ENTRIES) };
    }
}

interface PageState {
    browser: Browser;
    page: Page;
    label: string;
    log: LogCollector;
    viewport: { width: number; height: number };
}

/**
 * The agent's browser: a headless Chrome driven through Puppeteer, with one page that stays open between calls so the
 * agent can open its app, use it, and look again. Pages come from the workspace (served by {@link FolderServer}) or from
 * a server on this machine; the agent cannot browse the internet with it (that is what `fetchWebPage` is for, as text).
 */
@injectable()
export class BrowserServiceImpl implements BrowserService, BackendApplicationContribution {

    protected state: PageState | undefined;
    protected launching: Promise<PageState> | undefined;
    protected readonly servers = new Map<string, FolderServer>();
    protected queue: Promise<unknown> = Promise.resolve();
    protected idleTimer: ReturnType<typeof setTimeout> | undefined;

    onStop(): void {
        this.shutDown();
    }

    run(request: BrowserRequest): Promise<BrowserResult> {
        // One page: calls take turns.
        const next = this.queue.then(() => this.doRun(request));
        this.queue = next.catch(() => undefined);
        return next;
    }

    async close(): Promise<void> {
        await this.queue;
        this.shutDown();
    }

    protected async doRun(request: BrowserRequest): Promise<BrowserResult> {
        this.scheduleIdleClose();
        const viewport = {
            width: clamp(request.width ?? this.state?.viewport.width ?? DEFAULT_WIDTH, MIN_SIZE, MAX_SIZE),
            height: clamp(request.height ?? this.state?.viewport.height ?? DEFAULT_HEIGHT, MIN_SIZE, MAX_SIZE)
        };
        const result: BrowserResult = { viewport, actions: [], log: [], logOmitted: 0, elements: [] };

        let target: string | undefined;
        if (request.open) {
            try {
                target = await this.targetUrl(request.open);
            } catch (error) {
                return { ...result, error: errorMessage(error) };
            }
        } else if (!this.state) {
            return { ...result, error: 'No page is open. Pass `path` (an HTML file in the workspace) or `url` (a page on this machine).' };
        }

        let state: PageState;
        try {
            state = await this.ensurePage(request.executablePath);
        } catch (error) {
            return { ...result, error: errorMessage(error) };
        }
        result.browser = state.label;
        if (state.viewport.width !== viewport.width || state.viewport.height !== viewport.height) {
            await state.page.setViewport({ ...viewport, deviceScaleFactor: 1 });
            state.viewport = viewport;
        }

        if (!target && state.page.url() === 'about:blank') {
            return { ...result, error: 'No page is open (the last one did not load). Pass `path` or `url`.' };
        }
        const hints = new Set<string>();
        if (target) {
            // What the previous page logged is of no interest once another is loaded.
            state.log = new LogCollector();
            try {
                const response = await state.page.goto(target, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
                result.status = response?.status();
            } catch (error) {
                const message = errorMessage(error);
                // The failed request is in the error; the next call starts from a clean log and no page.
                await state.page.goto('about:blank').catch(() => undefined);
                state.log = new LogCollector();
                if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(message)) {
                    return {
                        ...result, error: `Nothing answered at ${target} (${message.match(/net::\w+/)?.[0] ?? message}). Start the server first `
                            + '(a launch configuration for a dev server), or open an HTML file of the workspace with `path`.'
                    };
                }
                if (!/timeout/i.test(message)) {
                    return { ...result, error: `Could not open ${target}: ${message}` };
                }
                state.log.add('warning', `The page had not finished loading after ${NAVIGATION_TIMEOUT_MS / 1000} s; it is shown as it was then.`);
            }
            await state.page.waitForNetworkIdle({ idleTime: 300, timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
            await sleep(clamp(request.waitMs ?? DEFAULT_SETTLE_AFTER_LOAD_MS, 0, MAX_WAIT_MS));
        }

        const actions = (request.actions ?? []).slice(0, MAX_ACTIONS);
        for (let index = 0; index < actions.length; index++) {
            const outcome = await this.perform(state.page, actions[index]);
            result.actions.push(outcome);
            if (!outcome.ok) {
                if (index < actions.length - 1) {
                    outcome.message += ` The ${actions.length - 1 - index} action(s) after it were not run.`;
                }
                break;
            }
            await sleep(SETTLE_AFTER_ACTION_MS);
        }
        if ((request.actions?.length ?? 0) > MAX_ACTIONS) {
            result.actions.push({ ok: false, message: `Only the first ${MAX_ACTIONS} actions are run per call.` });
        }
        if (!target && request.waitMs) {
            await sleep(clamp(request.waitMs, 0, MAX_WAIT_MS));
        }

        if (request.evaluate?.trim()) {
            result.evaluate = await this.evaluate(state.page, request.evaluate);
        }

        try {
            result.url = state.page.url();
            result.title = await state.page.title();
            const summary = await inPage(state.page, summarizePage, MAX_TEXT_CHARS, MAX_ELEMENTS);
            result.text = summary.text;
            result.elements = summary.elements;
            if (request.screenshot !== false) {
                const base64 = await state.page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY, encoding: 'base64' });
                result.screenshot = { base64, mimeType: 'image/jpeg' };
            }
        } catch (error) {
            result.error = `Could not read the page: ${errorMessage(error)}`;
        }

        const { log, omitted } = state.log.report();
        state.log = new LogCollector();
        const server = this.serverOf(result.url);
        const origin = server && result.url ? new URL(result.url).origin + '/' : undefined;
        result.log = log.map(entry => ({
            ...entry,
            // Stack traces name workspace files the way the agent knows them.
            text: origin ? entry.text.split(origin).join('') : entry.text,
            source: entry.source && this.shorten(entry.source, server)
        }));
        result.logOmitted = omitted;
        for (const entry of log) {
            if (/Failed to resolve module specifier/i.test(entry.text) && server) {
                hints.add('The page imports a package by its bare name, which only works through the project\'s bundler: build it '
                    + '(e.g. `npm run build`) and open the built page (often `dist/index.html`), or start its dev server and open its `url`.');
            }
        }
        if (result.status !== undefined && result.status >= 400) {
            hints.add(`The page itself answered HTTP ${result.status}.`);
        }
        if (hints.size > 0) {
            result.hints = [...hints];
        }
        result.workspacePath = server?.describe(result.url ?? '');
        return result;
    }

    /** The URL to load for a request: a workspace file through its folder's server, or a page on this machine. */
    protected async targetUrl(open: NonNullable<BrowserRequest['open']>): Promise<string> {
        if ('file' in open) {
            const root = resolve(open.root);
            let file = resolve(open.file);
            if (file !== root && !file.startsWith(root + sep)) {
                throw new Error(`${open.file} is outside ${open.root}.`);
            }
            if (!existsSync(file)) {
                throw new Error(`There is no file ${open.file}.`);
            }
            if ((await fs.stat(file)).isDirectory()) {
                // Opened as `dist/index.html`, so that the page's relative links resolve inside the folder.
                file = join(file, 'index.html');
                if (!existsSync(file)) {
                    throw new Error(`${open.file} is a folder without an index.html: pass the HTML file to open.`);
                }
            }
            let server = this.servers.get(root);
            if (!server) {
                server = new FolderServer(root);
                this.servers.set(root, server);
            }
            await server.start();
            return server.urlFor(file);
        }
        let url: URL;
        try {
            url = new URL(open.url);
        } catch {
            throw new Error(`"${open.url}" is not a URL. Pass e.g. "http://localhost:5173/", or a workspace file as \`path\`.`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error(`Only http and https pages can be opened (not ${url.protocol}). For a workspace file pass \`path\` instead.`);
        }
        if (!isLoopback(url.hostname)) {
            throw new Error(`The browser only opens pages on this machine (localhost), not ${url.hostname}: it is for checking your own `
                + 'work. Read pages on the internet with fetchWebPage.');
        }
        return url.href;
    }

    protected async ensurePage(executablePath: string | undefined): Promise<PageState> {
        if (this.state?.browser.connected && !this.state.page.isClosed()) {
            return this.state;
        }
        this.state = undefined;
        if (!this.launching) {
            this.launching = this.launchPage(executablePath).finally(() => this.launching = undefined);
        }
        this.state = await this.launching;
        return this.state;
    }

    protected async launchPage(configuredPath: string | undefined): Promise<PageState> {
        const found = findBrowser(configuredPath);
        if (!found) {
            throw new Error('No Chrome or Chromium was found to run the page in. Install one with '
                + '`npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer`, or set '
                + '`callisto.browser.executablePath` to a Chrome, Chromium, Edge or Brave executable.');
        }
        if (configuredPath?.trim() && found.path !== expandHome(configuredPath.trim())) {
            throw new Error(`callisto.browser.executablePath points to ${configuredPath}, which does not exist.`);
        }
        const browser = await launch({
            executablePath: found.path,
            headless: true,
            // The backend shuts its children down itself; Puppeteer's own signal handlers would get in the way.
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            defaultViewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, deviceScaleFactor: 1 },
            args: [
                '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
                // WebGL without a GPU (SwiftShader); Chrome otherwise refuses software WebGL since version 137.
                '--enable-unsafe-swiftshader',
                '--autoplay-policy=no-user-gesture-required'
            ]
        });
        const page = (await browser.pages())[0] ?? await browser.newPage();
        await page.setCacheEnabled(false);
        const version = (await browser.version()).replace(/^HeadlessChrome\//, '');
        const state: PageState = {
            browser, page, label: `${found.name} ${version}`, log: new LogCollector(),
            viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
        };
        page.on('console', (message: ConsoleMessage) => {
            const text = message.text();
            if (NOISE.some(pattern => pattern.test(text))) {
                return;
            }
            const location = message.location();
            const source = location?.url ? `${location.url}${location.lineNumber !== undefined ? `:${location.lineNumber + 1}` : ''}` : undefined;
            const type = message.type();
            state.log.add(type === 'warn' ? 'warning' : type === 'assert' ? 'error' : type, text, source);
        });
        page.on('pageerror', (error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error));
            const frames = (err.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).map(line => line.trim());
            state.log.add('exception', [`${err.name}: ${err.message}`, ...frames].join('\n'));
        });
        page.on('requestfailed', (request: HTTPRequest) => {
            const reason = request.failure()?.errorText ?? 'failed';
            // Requests cut short by a navigation or by the page itself are not errors of the page.
            if (reason !== 'net::ERR_ABORTED') {
                state.log.add('network', `${reason}: ${request.method()} ${request.url()}`);
            }
        });
        page.on('response', (response: HTTPResponse) => {
            const status = response.status();
            if (status >= 400 && !/\/favicon\.ico(\?|$)/.test(response.url())) {
                state.log.add('network', `HTTP ${status} ${response.statusText()}: ${response.request().method()} ${response.url()}`);
            }
        });
        page.on('dialog', (dialog: Dialog) => {
            state.log.add('dialog', `${dialog.type()}(${JSON.stringify(dialog.message())}) — answered OK automatically`);
            dialog.accept(dialog.type() === 'prompt' ? dialog.defaultValue() : undefined).catch(() => undefined);
        });
        browser.on('disconnected', () => {
            if (this.state?.browser === browser) {
                this.state = undefined;
            }
        });
        return state;
    }

    protected async perform(page: Page, action: BrowserAction): Promise<{ ok: boolean; message: string }> {
        try {
            switch (action.action) {
                case 'click': {
                    const target = await this.locate(page, action);
                    await page.mouse.click(target.x, target.y);
                    return { ok: true, message: `clicked ${target.description}` };
                }
                case 'hover': {
                    const target = await this.locate(page, action);
                    await page.mouse.move(target.x, target.y);
                    return { ok: true, message: `moved the mouse over ${target.description}` };
                }
                case 'type': {
                    if (typeof action.value !== 'string') {
                        return { ok: false, message: 'type needs `value`, the text to type.' };
                    }
                    let into = 'the focused element';
                    if (action.selector || action.text || hasPoint(action)) {
                        const target = await this.locate(page, action);
                        await page.mouse.click(target.x, target.y);
                        into = target.description;
                    }
                    await page.keyboard.type(action.value, { delay: 5 });
                    return { ok: true, message: `typed ${JSON.stringify(action.value)} into ${into}` };
                }
                case 'press': {
                    const key = normalizeKey(action.key ?? action.value);
                    if (!key) {
                        return { ok: false, message: 'press needs `key`, e.g. "Enter", "Escape", "ArrowLeft" or "a".' };
                    }
                    await page.keyboard.press(key as Parameters<Page['keyboard']['press']>[0]);
                    return { ok: true, message: `pressed ${key}` };
                }
                case 'select': {
                    if (!action.selector || typeof action.value !== 'string') {
                        return { ok: false, message: 'select needs `selector` (the <select>) and `value` (an option\'s value or label).' };
                    }
                    const chosen = await inPage(page, selectOption, action.selector, action.value);
                    return 'error' in chosen
                        ? { ok: false, message: `select on ${action.selector}: ${chosen.error}.` }
                        : { ok: true, message: `selected ${JSON.stringify(chosen.label)} in ${action.selector}` };
                }
                case 'drag': {
                    const from = await this.locate(page, action);
                    if (typeof action.toX !== 'number' || typeof action.toY !== 'number') {
                        return { ok: false, message: 'drag needs `toX` and `toY`, where to let go.' };
                    }
                    await page.mouse.move(from.x, from.y);
                    await page.mouse.down();
                    await page.mouse.move(action.toX, action.toY, { steps: 12 });
                    await page.mouse.up();
                    return { ok: true, message: `dragged from ${from.description} to (${Math.round(action.toX)}, ${Math.round(action.toY)})` };
                }
                case 'scroll': {
                    const deltaY = typeof action.deltaY === 'number' ? action.deltaY : 400;
                    let over = '';
                    if (action.selector || action.text || hasPoint(action)) {
                        const target = await this.locate(page, action);
                        await page.mouse.move(target.x, target.y);
                        over = ` over ${target.description}`;
                    }
                    await page.mouse.wheel({ deltaY });
                    return { ok: true, message: `scrolled ${deltaY >= 0 ? 'down' : 'up'} ${Math.abs(deltaY)} px${over}` };
                }
                case 'wait': {
                    const ms = clamp(action.ms ?? 1000, 0, MAX_WAIT_MS);
                    await sleep(ms);
                    return { ok: true, message: `waited ${ms} ms` };
                }
                default:
                    return {
                        ok: false, message: `Unknown action ${JSON.stringify((action as { action?: unknown }).action)}; use click, type, press, select, `
                            + 'hover, drag, scroll or wait.'
                    };
            }
        } catch (error) {
            return { ok: false, message: `${action.action ?? 'action'} failed: ${errorMessage(error)}` };
        }
    }

    /** Where to act: a point given in screenshot pixels, an element by CSS selector, or an element by its visible text. */
    protected async locate(page: Page, action: BrowserAction): Promise<{ x: number; y: number; description: string }> {
        if (hasPoint(action)) {
            const x = Math.round(action.x!);
            const y = Math.round(action.y!);
            const hit = await inPage(page, describePoint, x, y);
            return { x, y, description: `(${x}, ${y}) on ${hit}` };
        }
        if (action.selector) {
            const handle = await page.waitForSelector(action.selector, { visible: true, timeout: ELEMENT_TIMEOUT_MS }).catch(() => undefined);
            if (!handle) {
                throw new Error(`no visible element matches the selector ${JSON.stringify(action.selector)}`);
            }
            await handle.scrollIntoView().catch(() => undefined);
            const box = await handle.boundingBox();
            await handle.dispose();
            if (!box) {
                throw new Error(`the element ${JSON.stringify(action.selector)} has no size on screen`);
            }
            const x = Math.round(box.x + box.width / 2);
            const y = Math.round(box.y + box.height / 2);
            return { x, y, description: `${action.selector} at (${x}, ${y})` };
        }
        if (action.text) {
            const found = await inPage(page, findByText, action.text);
            if (!found) {
                throw new Error(`no visible element with the text ${JSON.stringify(action.text)}; the controls are listed in the result.`);
            }
            return { x: found.x, y: found.y, description: `${found.tag} "${found.label}" at (${found.x}, ${found.y})` };
        }
        throw new Error('say what to act on: `selector`, `text`, or `x` and `y`');
    }

    protected async evaluate(page: Page, expression: string): Promise<{ ok: boolean; value: string }> {
        const serialize = `(value) => {
            if (value === undefined) return 'undefined';
            if (typeof value === 'function') return 'a function';
            const seen = new WeakSet();
            try {
                const json = JSON.stringify(value, (key, item) => {
                    if (typeof item === 'bigint') return item.toString();
                    if (item instanceof Element) return '<' + item.tagName.toLowerCase() + (item.id ? '#' + item.id : '') + '>';
                    if (item instanceof Map) return Object.fromEntries(item);
                    if (item instanceof Set) return Array.from(item);
                    if (item && typeof item === 'object') { if (seen.has(item)) return '[circular]'; seen.add(item); }
                    return item;
                }, 1);
                return json === undefined ? String(value) : json;
            } catch (error) { return String(value); }
        }`;
        const asExpression = `(async () => (${serialize})(await (${expression}\n)))()`;
        const asBody = `(async () => (${serialize})(await (async () => {\n${expression}\n})()))()`;
        let source = asExpression;
        try {
            // Only parsed here, never run: statements (`const a = …; return a`) do not parse as an expression.
            // eslint-disable-next-line no-new-func
            new Function(`return (async () => (${expression}\n));`);
        } catch {
            source = asBody;
        }
        try {
            const value = String(await page.evaluate(source));
            return { ok: true, value: value.length > MAX_EVALUATE_CHARS ? `${value.slice(0, MAX_EVALUATE_CHARS)}… (cut)` : value };
        } catch (error) {
            return { ok: false, value: errorMessage(error).split('\n')[0] };
        }
    }

    protected serverOf(url: string | undefined): FolderServer | undefined {
        return url ? [...this.servers.values()].find(server => server.describe(url) !== undefined) : undefined;
    }

    /** Sources as the agent knows them: workspace paths for files Callisto serves, paths without the origin otherwise. */
    protected shorten(source: string, server: FolderServer | undefined): string {
        const [, url, line] = source.match(/^(.*?)(:\d+)?$/) ?? [source, source, undefined];
        const path = server?.describe(url);
        return path !== undefined ? path + (line ?? '') : source;
    }

    protected scheduleIdleClose(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
        this.idleTimer.unref?.();
    }

    protected shutDown(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        const browser = this.state?.browser;
        this.state = undefined;
        browser?.close().catch(() => browser.process()?.kill('SIGKILL'));
        for (const server of this.servers.values()) {
            server.close();
        }
        this.servers.clear();
    }
}

/**
 * Runs one of the page functions below in the page. Puppeteer sends a function as its source text, and the backend
 * bundler (esbuild, keeping names) rewrites named inner functions as `__name(fn, "fn")`, a helper the page does not have:
 * `findByText` failed with "__name is not defined" in the bundled app. The page gets a local stand-in for it.
 */
function inPage<A extends unknown[], R>(page: Page, fn: (...params: A) => R, ...args: A): Promise<Awaited<R>> {
    const source = `(() => { const __name = target => target; return (${fn.toString()})(...${JSON.stringify(args)}); })()`;
    return page.evaluate(source) as Promise<Awaited<R>>;
}

/** Runs in the page: what is at a point, e.g. `button#add "Add"` or `canvas`. */
function describePoint(x: number, y: number): string {
    const element = document.elementFromPoint(x, y);
    if (!element) {
        return 'nothing';
    }
    const id = element.id ? `#${element.id}` : '';
    const label = (element.getAttribute('aria-label') ?? (element as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${element.tagName.toLowerCase()}${id}${label && element.tagName !== 'CANVAS' && element.tagName !== 'BODY' ? ` "${label}"` : ''}`;
}

/** Runs in the page: picks an option of a `<select>` by value or label, as a user would, firing `input` and `change`. */
function selectOption(selector: string, wanted: string): { label: string } | { error: string } {
    const element = document.querySelector(selector);
    if (!element) {
        return { error: 'no element matches it' };
    }
    if (!(element instanceof HTMLSelectElement)) {
        return { error: `${element.tagName.toLowerCase()} is not a <select>` };
    }
    const options = Array.from(element.options);
    const option = options.find(o => o.value === wanted)
        ?? options.find(o => o.label.trim().toLowerCase() === String(wanted).trim().toLowerCase());
    if (!option) {
        return { error: `no option ${JSON.stringify(wanted)}; the options are ${options.map(o => JSON.stringify(o.label)).join(', ')}` };
    }
    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { label: option.label };
}

/** Runs in the page: its visible text and the controls a user could use, top to bottom. */
function summarizePage(maxText: number, maxElements: number): { text: string; elements: BrowserElementSummary[] } {
    const text = (document.body?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const selector = 'button, a[href], input:not([type=hidden]), select, textarea, summary, canvas, video, '
        + '[role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=menuitem], [role=switch], [role=slider], '
        + '[contenteditable=""], [contenteditable=true], [onclick]';
    const elements: BrowserElementSummary[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewHeight || rect.left >= viewWidth) {
            continue;
        }
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
            continue;
        }
        const tag = element.tagName.toLowerCase();
        let label = '';
        if (element instanceof HTMLSelectElement) {
            label = element.selectedOptions[0]?.label ?? '';
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            label = element.value || element.placeholder || '';
        } else if (tag !== 'canvas' && tag !== 'video') {
            label = element.innerText ?? '';
        }
        label = (label || element.getAttribute('aria-label') || element.title || '').trim().replace(/\s+/g, ' ');
        let unique: string | undefined;
        if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
            unique = `#${CSS.escape(element.id)}`;
        } else {
            const name = element.getAttribute('name');
            if (name && document.querySelectorAll(`${tag}[name="${CSS.escape(name)}"]`).length === 1) {
                unique = `${tag}[name="${name}"]`;
            }
        }
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.right, viewWidth);
        const bottom = Math.min(rect.bottom, viewHeight);
        const type = element instanceof HTMLInputElement ? `[type=${element.type}]` : '';
        elements.push({
            tag: tag + type,
            label: label.length > 60 ? `${label.slice(0, 60)}…` : label,
            selector: unique,
            x: Math.round((left + right) / 2),
            y: Math.round((top + bottom) / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            disabled: (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true' || undefined
        });
    }
    elements.sort((a, b) => a.y - b.y || a.x - b.x);
    return { text: text.length > maxText ? `${text.slice(0, maxText)}…` : text, elements: elements.slice(0, maxElements) };
}

/** Runs in the page: the element a user would mean by this text, scrolled into view, and its centre. */
function findByText(wanted: string): { x: number; y: number; tag: string; label: string } | undefined {
    const norm = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
    const target = norm(wanted);
    const interactive = 'button, a, summary, label, option, input[type=button], input[type=submit], input[type=reset], '
        + '[role=button], [role=link], [role=tab], [role=menuitem], [role=option], [onclick]';
    const labelOf = (element: HTMLElement) => element instanceof HTMLInputElement
        ? element.value
        : element.innerText || element.getAttribute('aria-label') || element.title || '';
    const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    let best: { element: HTMLElement; score: number; area: number } | undefined;
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
        const label = norm(labelOf(element));
        if (!label || (label !== target && !label.includes(target)) || !visible(element)) {
            continue;
        }
        const rect = element.getBoundingClientRect();
        // Exact text first, then real controls, then the smallest (most specific) element.
        const score = (label === target ? 0 : 2) + (element.matches(interactive) ? 0 : 1);
        const area = rect.width * rect.height;
        if (!best || score < best.score || (score === best.score && area < best.area)) {
            best = { element, score, area };
        }
    }
    if (!best) {
        return undefined;
    }
    best.element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = best.element.getBoundingClientRect();
    return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        tag: best.element.tagName.toLowerCase(),
        label: labelOf(best.element).trim().replace(/\s+/g, ' ').slice(0, 40)
    };
}

interface FoundBrowser {
    path: string;
    /** For the result header, e.g. "chrome-headless-shell". */
    name: string;
}

/**
 * The browser to run pages in: the configured one; else the newest Chrome Puppeteer has downloaded (the headless shell
 * first: it starts fastest and is made for this); else an installed Chrome, Chromium, Edge or Brave.
 */
export function findBrowser(configuredPath: string | undefined): FoundBrowser | undefined {
    const configured = configuredPath?.trim() ? expandHome(configuredPath.trim()) : undefined;
    if (configured) {
        return existsSync(configured) ? { path: configured, name: 'Chrome' } : undefined;
    }
    const cache = process.env.PUPPETEER_CACHE_DIR || join(homedir(), '.cache', 'puppeteer');
    const platform = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac_arm' : 'mac')
        : process.platform === 'win32' ? 'win64' : 'linux';
    const folder = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
        : process.platform === 'win32' ? 'win64' : 'linux64';
    const exe = process.platform === 'win32' ? '.exe' : '';
    const downloaded: [string, (dir: string) => string][] = [
        ['chrome-headless-shell', dir => join(dir, `chrome-headless-shell-${folder}`, `chrome-headless-shell${exe}`)],
        ['chrome', dir => process.platform === 'darwin'
            ? join(dir, `chrome-${folder}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
            : join(dir, `chrome-${folder}`, `chrome${exe}`)]
    ];
    for (const [name, executable] of downloaded) {
        const base = join(cache, name);
        let versions: string[] = [];
        try {
            versions = readdirSync(base).filter(dir => dir.startsWith(`${platform}-`));
        } catch {
            continue;
        }
        versions.sort((a, b) => compareVersions(b.slice(platform.length + 1), a.slice(platform.length + 1)));
        for (const version of versions) {
            const path = executable(join(base, version));
            if (existsSync(path)) {
                return { path, name };
            }
        }
    }
    const installed: [string, string][] = process.platform === 'darwin' ? [
        ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
        ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
        ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
    ] : process.platform === 'win32' ? [
        ['Google Chrome', join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')],
        ['Microsoft Edge', join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    ] : [
        ['Google Chrome', '/usr/bin/google-chrome'], ['Chromium', '/usr/bin/chromium'], ['Chromium', '/usr/bin/chromium-browser'],
        ['Chromium', '/snap/bin/chromium'], ['Microsoft Edge', '/usr/bin/microsoft-edge']
    ];
    const match = installed.find(([, path]) => existsSync(path));
    return match ? { name: match[0], path: match[1] } : undefined;
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

export function isLoopback(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

function hasPoint(action: BrowserAction): boolean {
    return typeof action.x === 'number' && typeof action.y === 'number';
}

/** Key names as models tend to write them, in Puppeteer's spelling. */
function normalizeKey(key: string | undefined): string | undefined {
    if (!key) {
        return undefined;
    }
    const aliases: Record<string, string> = {
        enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', space: 'Space', spacebar: 'Space', ' ': 'Space', tab: 'Tab',
        backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
        arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End',
        pageup: 'PageUp', pagedown: 'PageDown', shift: 'Shift', control: 'Control', ctrl: 'Control', alt: 'Alt', meta: 'Meta', cmd: 'Meta'
    };
    return aliases[key.toLowerCase()] ?? key;
}

function expandHome(path: string): string {
    return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function decodeURIComponentSafe(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
