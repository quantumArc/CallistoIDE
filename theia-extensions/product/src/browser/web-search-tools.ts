/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core';
import { ToolProvider, ToolRequest } from '@theia/ai-core';
import {
    FETCH_WEB_PAGE_FUNCTION_ID, WEB_SEARCH_FUNCTION_ID, WebPage, WebSearchCategory, WebSearchConfig, WebSearchResponse, WebSearchService
} from '../common/web-search-protocol.js';
import { WEB_SEARCH_CONTROL_SCRIPT_PREF, WEB_SEARCH_ENABLED_PREF, WEB_SEARCH_URL_PREF } from './callisto-agent-preferences.js';

const PROVIDER = 'callisto';
const TURNED_OFF = 'Web search is turned off in Callisto\'s settings (callisto.webSearch.enabled). Work without it, '
    + 'and tell the user if you needed it.';

@injectable()
abstract class WebTool implements ToolProvider {

    @inject(WebSearchService)
    protected readonly service: WebSearchService;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    abstract getTool(): ToolRequest;

    protected get enabled(): boolean {
        return this.preferences.get<boolean>(WEB_SEARCH_ENABLED_PREF, true) !== false;
    }

    protected get config(): WebSearchConfig {
        return {
            searxngUrl: this.preferences.get<string>(WEB_SEARCH_URL_PREF, 'http://127.0.0.1:8888') || 'http://127.0.0.1:8888',
            controlScript: this.preferences.get<string>(WEB_SEARCH_CONTROL_SCRIPT_PREF, '') ?? ''
        };
    }
}

/** Searches the web through the user's SearXNG and returns titles, links and snippets. */
@injectable()
export class WebSearchTool extends WebTool {

    getTool(): ToolRequest {
        return {
            id: WEB_SEARCH_FUNCTION_ID,
            name: WEB_SEARCH_FUNCTION_ID,
            providerName: PROVIDER,
            description: 'Searches the web and returns the top results: title, URL and a short snippet each. Use it for facts outside '
                + 'the workspace that you are unsure of or that change over time: a library\'s current API or version, an unfamiliar '
                + 'error message, official documentation. Then read the most promising result with fetchWebPage. '
                + 'Write queries like a developer would type them, e.g. "node test runner mock timers" or the exact error text.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for.' },
                    category: {
                        type: 'string',
                        enum: ['web', 'code', 'news'],
                        description: '"code" searches programming sources (Stack Overflow, GitHub, MDN, package registries); '
                            + '"news" recent news; "web" (default) the web at large.'
                    },
                    timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results from this recent period.' },
                    maxResults: { type: 'number', description: 'How many results to return: 1 to 20, default 8.' }
                },
                required: ['query']
            },
            getArgumentsShortLabel: args => {
                const query = parse(args).query;
                return typeof query === 'string' ? { label: query, hasMore: false } : undefined;
            },
            handler: async args => {
                if (!this.enabled) {
                    return TURNED_OFF;
                }
                const { query, category, timeRange, maxResults } = parse(args);
                if (typeof query !== 'string' || !query.trim()) {
                    return 'webSearch needs a non-empty "query".';
                }
                const response = await this.service.search(query, {
                    category: isCategory(category) ? category : undefined,
                    timeRange: isTimeRange(timeRange) ? timeRange : undefined,
                    maxResults: typeof maxResults === 'number' ? maxResults : undefined
                }, this.config);
                return formatSearch(response);
            }
        };
    }
}

/** Reads a web page as text, in parts for long pages. */
@injectable()
export class FetchWebPageTool extends WebTool {

    getTool(): ToolRequest {
        return {
            id: FETCH_WEB_PAGE_FUNCTION_ID,
            name: FETCH_WEB_PAGE_FUNCTION_ID,
            providerName: PROVIDER,
            description: 'Reads a web page on the public internet and returns its main content as text (headings, lists, links and code '
                + 'kept, navigation dropped). Long pages come in parts: call again with the offset given at the end to read on. '
                + 'Pages on this machine or a private network are not fetched.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The http or https URL, e.g. one from webSearch.' },
                    offset: { type: 'number', description: 'Character offset to continue a long page from. Default 0.' }
                },
                required: ['url']
            },
            getArgumentsShortLabel: args => {
                const url = parse(args).url;
                return typeof url === 'string' ? { label: url, hasMore: false } : undefined;
            },
            handler: async args => {
                if (!this.enabled) {
                    return TURNED_OFF;
                }
                const { url, offset } = parse(args);
                if (typeof url !== 'string' || !url.trim()) {
                    return 'fetchWebPage needs a "url".';
                }
                return formatPage(await this.service.fetchPage(url, { offset: typeof offset === 'number' ? offset : undefined }));
            }
        };
    }
}

export function formatSearch(response: WebSearchResponse): string {
    if (response.error) {
        return `Web search failed: ${response.error}`;
    }
    const lines: string[] = [];
    if (response.answers.length > 0) {
        lines.push(`Direct answer: ${response.answers.join(' / ')}`, '');
    }
    if (response.results.length === 0) {
        lines.push(`No results for "${response.query}".`);
        if (response.suggestions.length > 0) {
            lines.push(`Suggested searches: ${response.suggestions.join('; ')}`);
        }
    } else {
        lines.push(`Results for "${response.query}":`);
        response.results.forEach((result, index) => {
            const date = result.publishedDate ? ` (${result.publishedDate.slice(0, 10)})` : '';
            lines.push('', `${index + 1}. ${result.title}${date}`, `   ${result.url}`);
            if (result.snippet) {
                lines.push(`   ${result.snippet}`);
            }
        });
        lines.push('', 'Read a result with fetchWebPage before relying on it; snippets are often incomplete or out of date.');
    }
    if (response.unresponsiveEngines.length > 0) {
        lines.push(`(Engines that did not answer: ${response.unresponsiveEngines.join(', ')}.)`);
    }
    return lines.join('\n');
}

export function formatPage(page: WebPage): string {
    if (page.error) {
        return `Could not read ${page.url}: ${page.error}`;
    }
    const source = page.finalUrl ?? page.url;
    const range = page.totalChars > page.text.length
        ? ` (characters ${page.offset.toLocaleString('en-US')}–${(page.offset + page.text.length).toLocaleString('en-US')} of ${page.totalChars.toLocaleString('en-US')})`
        : '';
    const lines = [`# ${page.title ?? source}`, `Source: ${source}${range}`, '', page.text || '(The page has no readable text.)'];
    if (page.nextOffset !== undefined) {
        lines.push('', `[The page continues: call fetchWebPage with offset ${page.nextOffset} to read on.]`);
    }
    return lines.join('\n');
}

function parse(args: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(args || '{}');
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function isCategory(value: unknown): value is WebSearchCategory {
    return value === 'web' || value === 'code' || value === 'news';
}

function isTimeRange(value: unknown): value is 'day' | 'week' | 'month' | 'year' {
    return value === 'day' || value === 'week' || value === 'month' || value === 'year';
}
