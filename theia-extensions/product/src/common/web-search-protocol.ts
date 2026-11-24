/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const WEB_SEARCH_PATH = '/services/callisto/web-search';

/** The agent's tools for the web. */
export const WEB_SEARCH_FUNCTION_ID = 'webSearch';
export const FETCH_WEB_PAGE_FUNCTION_ID = 'fetchWebPage';

export const WebSearchService = Symbol('WebSearchService');

/** What to search: the web at large, programming sources (Stack Overflow, GitHub, MDN, package registries), or news. */
export type WebSearchCategory = 'web' | 'code' | 'news';

export interface WebSearchOptions {
    category?: WebSearchCategory;
    /** Only results from the last day, week, month or year. */
    timeRange?: 'day' | 'week' | 'month' | 'year';
    /** At most this many results (default 8, at most 20). */
    maxResults?: number;
}

export interface WebSearchHit {
    title: string;
    url: string;
    snippet: string;
    engines: string[];
    publishedDate?: string;
}

export interface WebSearchResponse {
    query: string;
    results: WebSearchHit[];
    /** Direct answers some engines give (a definition, a conversion). */
    answers: string[];
    suggestions: string[];
    /** Engines that did not answer in time, with the reason. */
    unresponsiveEngines: string[];
    /** Set when the search could not run at all; `results` is then empty. */
    error?: string;
}

export interface WebPageOptions {
    /** Character offset to start from, for reading a long page in parts. */
    offset?: number;
    /** Characters to return (default 12,000, at most 40,000). */
    maxChars?: number;
}

export interface WebPage {
    url: string;
    /** Where the page ended up after redirects. */
    finalUrl?: string;
    title?: string;
    contentType?: string;
    /** The page as plain text (headings, lists, links and code kept), from `offset` on. */
    text: string;
    offset: number;
    totalChars: number;
    /** Offset of the next part, when the page has more. */
    nextOffset?: number;
    /** Set when the page could not be fetched or read; `text` is then empty. */
    error?: string;
}

/** Where Callisto finds its search engine; comes from the user's settings with every call. */
export interface WebSearchConfig {
    /** Base URL of a SearXNG instance with the JSON format enabled. */
    searxngUrl: string;
    /**
     * A script that takes `start` and `stop` (`~` allowed), run when nothing answers at `searxngUrl`; empty when the user
     * starts SearXNG themselves.
     */
    controlScript: string;
}

/**
 * Web search for the agent through the user's own SearXNG, and a reader for web pages. Runs in the backend: the browser
 * cannot reach SearXNG or arbitrary sites across origins, and the backend can start SearXNG when needed.
 */
export interface WebSearchService {
    search(query: string, options: WebSearchOptions, config: WebSearchConfig): Promise<WebSearchResponse>;
    /** Fetches a page on the public internet as text. Addresses on this machine or a private network are refused. */
    fetchPage(url: string, options: WebPageOptions): Promise<WebPage>;
}
