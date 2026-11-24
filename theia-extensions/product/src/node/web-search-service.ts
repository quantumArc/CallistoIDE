/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { promises as dns } from 'dns';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { isIP } from 'net';
import { join } from 'path';
import {
    WebPage, WebPageOptions, WebSearchConfig, WebSearchHit, WebSearchOptions, WebSearchResponse, WebSearchService
} from '../common/web-search-protocol.js';
import { htmlToText } from '../common/html-to-text.js';

const CATEGORIES = { web: 'general', code: 'it', news: 'news' } as const;
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const SNIPPET_CHARS = 300;
/** Places a "code" search keeps for Stack Overflow, GitHub, MDN and the like, after the web results. */
const CODE_SOURCE_PLACES = 2;
const SEARCH_TIMEOUT_MS = 20_000;
/** How long `<control script> start` may take. A fresh install's first start takes ~15 s; later ones ~2 s. */
const STARTUP_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_PAGE_CHARS = 12_000;
const MAX_PAGE_CHARS = 40_000;
const CACHED_PAGES = 10;
const PAGE_CACHE_MS = 10 * 60_000;
/** Sites serve their normal pages to browsers; some refuse unknown clients outright. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

interface CachedPage {
    page: Omit<WebPage, 'text' | 'offset' | 'nextOffset'>;
    fullText: string;
    fetchedAt: number;
}

/**
 * Web search through the user's own SearXNG (see docs/web-search.md). When it is not running and the user named a
 * control script, Callisto starts it with that script on the first search and stops it again when Callisto exits; a
 * SearXNG the user started is left alone. Pages are fetched here too, as text, and only from the public internet: a
 * page the model read could otherwise steer it into probing services on this machine or the local network (LM Studio's
 * API, a router's admin page).
 */
@injectable()
export class WebSearchServiceImpl implements WebSearchService, BackendApplicationContribution {

    /** The control script Callisto started SearXNG with; it is stopped with the same script when Callisto exits. */
    protected startedWith: string | undefined;
    protected starting: Promise<void> | undefined;
    protected readonly pages = new Map<string, CachedPage>();

    onStop(): void {
        if (this.startedWith) {
            // Synchronous: the backend is shutting down and would not wait for a callback.
            spawnSync(this.startedWith, ['stop'], { timeout: 10_000, stdio: 'ignore' });
            this.startedWith = undefined;
        }
    }

    async search(query: string, options: WebSearchOptions, config: WebSearchConfig): Promise<WebSearchResponse> {
        const empty: WebSearchResponse = { query, results: [], answers: [], suggestions: [], unresponsiveEngines: [] };
        if (!query.trim()) {
            return { ...empty, error: 'The search query is empty.' };
        }
        const base = config.searxngUrl.replace(/\/+$/, '');
        try {
            await this.ensureSearxng(base, config);
        } catch (error) {
            return { ...empty, error: errorMessage(error) };
        }
        // "code" asks the web engines and the programming sources (Stack Overflow, GitHub, MDN …) side by side. The latter
        // run the sites' own keyword search, which on natural queries put unrelated questions first, so the web results
        // lead and the programming sources get the last few places.
        const categories = CATEGORIES[options.category ?? 'web'] ?? 'general';
        const lists = options.category === 'code' ? ['general', categories] : [categories];
        let responses: SearxngResponse[];
        try {
            responses = await Promise.all(lists.map(list => querySearxng(base, query, list, options.timeRange)));
        } catch (error) {
            return { ...empty, error: errorMessage(error) };
        }
        const limit = Math.min(Math.max(1, Math.round(options.maxResults ?? DEFAULT_RESULTS)), MAX_RESULTS);
        const [main, extra = []] = responses.map(data => (data.results ?? []).filter(hit => isWebUrl(hit.url)));
        const leading = Math.max(1, limit - Math.min(CODE_SOURCE_PLACES, extra.length));
        const ordered = [...main.slice(0, leading), ...extra, ...main.slice(leading)];
        const seen = new Set<string>();
        const results: WebSearchHit[] = [];
        for (const result of ordered) {
            if (results.length >= limit) {
                break;
            }
            const key = result.url!.replace(/[#?].*$/, '').replace(/\/+$/, '');
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            results.push({
                title: clean(result.title || result.url!),
                url: result.url!,
                snippet: shorten(clean(result.content ?? ''), SNIPPET_CHARS),
                engines: result.engines ?? (result.engine ? [result.engine] : []),
                publishedDate: typeof result.publishedDate === 'string' ? result.publishedDate : undefined
            });
        }
        const all = <T>(pick: (data: SearxngResponse) => T[] | undefined): T[] => responses.flatMap(data => pick(data) ?? []);
        return {
            query,
            results,
            answers: [...new Set(all(data => data.answers).map(answer => clean(typeof answer === 'string' ? answer : answer?.answer ?? '')).filter(Boolean))],
            suggestions: [...new Set(all(data => data.suggestions).filter((suggestion): suggestion is string => typeof suggestion === 'string'))].slice(0, 5),
            unresponsiveEngines: [...new Set(all(data => data.unresponsive_engines)
                .map(entry => Array.isArray(entry) ? `${entry[0]} (${entry[1]})` : String(entry)))]
        };
    }

    async fetchPage(url: string, options: WebPageOptions): Promise<WebPage> {
        const offset = Math.max(0, Math.round(options.offset ?? 0));
        const maxChars = Math.min(Math.max(1000, Math.round(options.maxChars ?? DEFAULT_PAGE_CHARS)), MAX_PAGE_CHARS);
        let cached = this.pages.get(url);
        if (!cached || Date.now() - cached.fetchedAt > PAGE_CACHE_MS) {
            try {
                cached = await this.download(url);
            } catch (error) {
                return { url, text: '', offset, totalChars: 0, error: errorMessage(error) };
            }
            this.pages.delete(url);
            this.pages.set(url, cached);
            while (this.pages.size > CACHED_PAGES) {
                this.pages.delete(this.pages.keys().next().value!);
            }
        }
        const text = cached.fullText.slice(offset, offset + maxChars);
        const end = offset + text.length;
        return { ...cached.page, text, offset, nextOffset: end < cached.fullText.length ? end : undefined };
    }

    // ---------------------------------------------------------------- SearXNG process

    /**
     * Makes sure SearXNG answers at `base`. When it does not and the user named a control script, runs `<script> start`
     * (the script is expected to start SearXNG in the background and return once it answers, as `searxng.sh` does).
     */
    protected async ensureSearxng(base: string, config: WebSearchConfig): Promise<void> {
        if (await healthy(base)) {
            return;
        }
        const script = expandHome(config.controlScript.trim());
        if (!script) {
            throw new Error(`SearXNG is not running at ${base}. Ask the user to start it (for example with \`searxng start\`), `
                + 'or to set callisto.webSearch.controlScript so that Callisto starts it when needed.');
        }
        if (!isLoopbackUrl(base)) {
            throw new Error(`No SearXNG answers at ${base}. Callisto only starts SearXNG on this machine.`);
        }
        if (!existsSync(script)) {
            throw new Error(`SearXNG is not running at ${base}, and the control script ${script} (callisto.webSearch.controlScript) does not exist.`);
        }
        this.starting ??= this.startSearxng(base, script).finally(() => { this.starting = undefined; });
        await this.starting;
    }

    protected async startSearxng(base: string, script: string): Promise<void> {
        const { code, output } = await runScript(script, 'start', STARTUP_TIMEOUT_MS);
        if (code !== 0) {
            throw new Error(`\`${script} start\` failed (exit code ${code}): ${shorten(output.trim(), 400)}`);
        }
        // The script returns once SearXNG answers; give it a moment more in case it returns earlier.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            if (await healthy(base)) {
                this.startedWith = script;
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error(`\`${script} start\` finished, but nothing answers at ${base}.`);
    }

    // ---------------------------------------------------------------- pages

    protected async download(url: string): Promise<CachedPage> {
        let current = parsePublicUrl(url);
        const signal = AbortSignal.timeout(PAGE_TIMEOUT_MS);
        for (let redirects = 0; ; redirects++) {
            await assertPublicHost(current.hostname);
            const response = await fetch(current, {
                redirect: 'manual',
                signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5',
                    'Accept-Language': 'en'
                }
            });
            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
                if (redirects >= MAX_REDIRECTS) {
                    throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
                }
                // Every hop is checked again: a public page may redirect to a local address.
                current = parsePublicUrl(new URL(response.headers.get('location')!, current).href);
                continue;
            }
            if (!response.ok) {
                throw new Error(`The site answered ${response.status} ${response.statusText}.`);
            }
            const contentType = response.headers.get('content-type') ?? '';
            const mime = contentType.split(';')[0].trim().toLowerCase();
            const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '';
            const isText = mime.startsWith('text/') || /json|xml|javascript|yaml|markdown/.test(mime);
            if (!isHtml && !isText) {
                throw new Error(`This is a ${mime || 'binary'} file, which Callisto cannot read as text.`);
            }
            const body = decode(await readLimited(response), contentType);
            const finalUrl = current.href;
            const converted = isHtml ? htmlToText(body, finalUrl) : { title: undefined, text: body.trim() };
            return {
                page: { url, finalUrl: finalUrl !== url ? finalUrl : undefined, title: converted.title, contentType: mime, totalChars: converted.text.length },
                fullText: converted.text,
                fetchedAt: Date.now()
            };
        }
    }
}

interface SearxngResponse {
    results?: { title?: string; url?: string; content?: string; engine?: string; engines?: string[]; publishedDate?: unknown }[];
    answers?: (string | { answer?: string })[];
    suggestions?: unknown[];
    unresponsive_engines?: unknown[];
}

async function querySearxng(base: string, query: string, categories: string, timeRange: string | undefined): Promise<SearxngResponse> {
    const url = new URL(`${base}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', categories);
    url.searchParams.set('safesearch', '0');
    if (timeRange) {
        url.searchParams.set('time_range', timeRange);
    }
    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    } catch (error) {
        throw new Error(`Searching through SearXNG at ${base} failed: ${errorMessage(error)}`);
    }
    if (response.status === 403) {
        throw new Error(`SearXNG at ${base} refused the JSON format. Add "json" under search.formats in its settings.yml.`);
    }
    if (!response.ok) {
        throw new Error(`SearXNG at ${base} answered ${response.status} ${response.statusText}.`);
    }
    return await response.json() as SearxngResponse;
}

/** An http(s) URL with a real host name. Some engines hand back redirect links without one (`http:///go/v1/…`). */
function isWebUrl(url: unknown): url is string {
    if (typeof url !== 'string') {
        return false;
    }
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.includes('.');
    } catch {
        return false;
    }
}

/** Runs `<script> <command>` and collects its output; a script that hangs is killed after `timeoutMs`. */
function runScript(script: string, command: string, timeoutMs: number): Promise<{ code: number; output: string }> {
    return new Promise(resolve => {
        let output = '';
        let child: ChildProcess;
        try {
            child = spawn(script, [command], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ code: -1, output: errorMessage(error) });
            return;
        }
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            output += `\n(timed out after ${timeoutMs / 1000} s)`;
        }, timeoutMs);
        child.stdout?.on('data', chunk => { output += String(chunk); });
        child.stderr?.on('data', chunk => { output += String(chunk); });
        child.on('error', error => { output += error.message; });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, output });
        });
    });
}

function expandHome(path: string): string {
    return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

async function healthy(base: string): Promise<boolean> {
    try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
        return response.ok;
    } catch {
        return false;
    }
}

function isLoopbackUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
        return host === 'localhost' || host === '::1' || /^127\./.test(host);
    } catch {
        return false;
    }
}

function parsePublicUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new Error(`"${raw}" is not a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https pages can be fetched.');
    }
    if (url.username || url.password) {
        throw new Error('URLs with credentials are not fetched.');
    }
    return url;
}

/** Refuses hosts on this machine or a private network: by name, by literal address, and by every address they resolve to. */
async function assertPublicHost(hostname: string): Promise<void> {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || !host.includes('.') && !isIP(host)) {
        throw new Error(`${hostname} is on this machine or the local network; Callisto only fetches pages on the public internet.`);
    }
    const addresses = isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => {
        throw new Error(`Could not resolve ${hostname}.`);
    })).map(entry => entry.address);
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
        throw new Error(`${hostname} resolves to ${blocked}, which is on this machine or a private network; `
            + 'Callisto only fetches pages on the public internet.');
    }
}

export function isPrivateAddress(address: string): boolean {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    const ip = mapped ? mapped[1] : address.toLowerCase();
    if (isIP(ip) === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
}

async function readLimited(response: Response): Promise<Uint8Array> {
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_PAGE_BYTES) {
        throw new Error(`The page is too large (${Math.round(length / 1024 / 1024)} MB).`);
    }
    if (!response.body) {
        return new Uint8Array();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > MAX_PAGE_BYTES) {
            await reader.cancel();
            throw new Error(`The page is larger than ${MAX_PAGE_BYTES / 1024 / 1024} MB.`);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return bytes;
}

function decode(bytes: Uint8Array, contentType: string): string {
    const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, '') ?? 'utf-8';
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

function clean(text: string): string {
    return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function shorten(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const cause = (error as { cause?: unknown }).cause;
        return cause instanceof Error && cause.message && !error.message.includes(cause.message) ? `${error.message} (${cause.message})` : error.message;
    }
    return String(error);
}
