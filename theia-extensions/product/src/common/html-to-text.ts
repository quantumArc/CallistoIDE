/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Turns a web page into text a model can read: the main content only (scripts, styles, navigation and footers
 * dropped), with headings, list items, links and code blocks kept in Markdown form. Not a full HTML parser: it is
 * built for documentation and articles, where it keeps what matters at a fraction of the page's size.
 */
export interface HtmlText {
    title?: string;
    text: string;
}

const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'head', 'nav', 'footer', 'aside', 'form', 'button', 'select'];
const BLOCK_ELEMENTS = [
    'p', 'div', 'section', 'article', 'main', 'header', 'table', 'thead', 'tbody', 'tfoot', 'ul', 'ol', 'dl', 'blockquote', 'figure',
    'figcaption', 'details', 'summary', 'hr'
];
const MIN_MAIN_CHARS = 400;

export function htmlToText(html: string, baseUrl?: string): HtmlText {
    const title = decodeEntities(stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')).replace(/\s+/g, ' ').trim() || undefined;
    let body = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of DROPPED_ELEMENTS) {
        body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    }
    body = mainContent(dropLinkMenus(body));

    // Code blocks keep their exact whitespace: set them aside before whitespace is collapsed.
    const blocks: string[] = [];
    body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
        const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n'))).replace(/^\n+|\s+$/g, '');
        blocks.push(code);
        return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
    });

    body = body
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) =>
            `\n\n${'#'.repeat(Number(level))} ${inline(inner, baseUrl)}\n\n`)
        .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attributes: string, inner: string) => link(attributes, inner, baseUrl))
        .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner: string) => `\`${stripTags(inner)}\``)
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '**$2**')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<(dt)\b[^>]*>/gi, '\n')
        .replace(/<(dd)\b[^>]*>/gi, '\n  ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(tr)\b[^>]*>/gi, '\n')
        .replace(/<\/(td|th)\s*>/gi, ' | ')
        .replace(new RegExp(`<\\/?(${BLOCK_ELEMENTS.join('|')})\\b[^>]*>`, 'gi'), '\n\n');

    let text = decodeEntities(stripTags(body))
        .replace(/[ \t\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `\`\`\`\n${blocks[Number(index)]}\n\`\`\``);
    return { title, text };
}

/** A list with at least this many items, nearly all link text, is navigation. */
const MENU_MIN_ITEMS = 6;
const MENU_LINK_SHARE = 0.75;

/**
 * Drops lists that are almost nothing but links: site menus, tables of contents, "related pages". Many documentation
 * sites build their sidebar from plain `<ul>`s rather than `<nav>`; on the Node.js API pages that sidebar filled the
 * first 12,000 characters. Lists that are kept are searched for such menus inside them.
 */
export function dropLinkMenus(html: string): string {
    let out = '';
    let depth = 0;
    let start = 0;
    let copied = 0;
    for (const match of html.matchAll(/<(\/?)(ul|ol)\b[^>]*>/gi)) {
        if (match[1] !== '/') {
            if (depth === 0) {
                start = match.index!;
            }
            depth++;
        } else if (depth > 0 && --depth === 0) {
            const end = match.index! + match[0].length;
            const list = html.slice(start, end);
            out += html.slice(copied, start) + (isLinkMenu(list) ? ' ' : keepList(list));
            copied = end;
        }
    }
    return out + html.slice(copied);
}

function keepList(list: string): string {
    const open = list.indexOf('>') + 1;
    const close = list.lastIndexOf('</');
    return list.slice(0, open) + dropLinkMenus(list.slice(open, close)) + list.slice(close);
}

function isLinkMenu(list: string): boolean {
    if ((list.match(/<li\b/gi) ?? []).length < MENU_MIN_ITEMS) {
        return false;
    }
    const total = visibleLength(list);
    const linked = [...list.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].reduce((sum, match) => sum + visibleLength(match[1]), 0);
    return total === 0 || linked / total >= MENU_LINK_SHARE;
}

function visibleLength(html: string): number {
    return decodeEntities(stripTags(html)).replace(/\s+/g, '').length;
}

/** The page's `<main>` or largest `<article>` when it has real content, else its `<body>`, else everything. */
function mainContent(html: string): string {
    const candidates = [
        ...[...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi)].map(match => match[1]),
        ...[...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map(match => match[1])
    ].filter(candidate => stripTags(candidate).trim().length >= MIN_MAIN_CHARS);
    if (candidates.length > 0) {
        return candidates.reduce((largest, candidate) => stripTags(candidate).length > stripTags(largest).length ? candidate : largest);
    }
    return html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? html;
}

function link(attributes: string, inner: string, baseUrl: string | undefined): string {
    const text = inline(inner, baseUrl);
    const href = decodeEntities(attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(Boolean) ?? '');
    if (!text) {
        return '';
    }
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) {
        return text;
    }
    let absolute = href;
    try {
        absolute = new URL(href, baseUrl).href;
    } catch {
        return text;
    }
    return /^https?:/i.test(absolute) ? `[${text}](${absolute})` : text;
}

function inline(html: string, baseUrl: string | undefined): string {
    return decodeEntities(stripTags(html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attributes: string, inner: string) =>
        link(attributes, inner, baseUrl)))).replace(/\s+/g, ' ').trim();
}

function stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, '');
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
    trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×',
    larr: '←', rarr: '→', uarr: '↑', darr: '↓', deg: '°', para: '¶', sect: '§'
};

export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
        if (code[0] === '#') {
            const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : entity;
        }
        return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    });
}
