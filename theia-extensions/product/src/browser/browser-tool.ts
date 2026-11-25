/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core';
import { ToolCallContent, ToolCallContentResult, ToolProvider, ToolRequest } from '@theia/ai-core';
import { WorkspaceFunctionScope } from '@theia/ai-ide/lib/browser/workspace-functions';
import {
    BROWSER_FUNCTION_ID, BrowserAction, BrowserActionKind, BrowserRequest, BrowserResult, BrowserService
} from '../common/browser-protocol.js';
import { BROWSER_ENABLED_PREF, BROWSER_EXECUTABLE_PREF } from './callisto-agent-preferences.js';

const ACTIONS: BrowserActionKind[] = ['click', 'type', 'press', 'select', 'hover', 'drag', 'scroll', 'wait'];

/** Opens a page of the workspace or of a server on this machine in a headless browser, uses it, and reports what it shows. */
@injectable()
export class BrowserTool implements ToolProvider {

    @inject(BrowserService)
    protected readonly service: BrowserService;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(WorkspaceFunctionScope)
    protected readonly workspaceScope: WorkspaceFunctionScope;

    getTool(): ToolRequest {
        return {
            id: BROWSER_FUNCTION_ID,
            name: BROWSER_FUNCTION_ID,
            providerName: 'callisto',
            description: 'Opens a web page in a headless browser and reports what a user would get: console errors, uncaught '
                + 'exceptions, failed requests, the visible text, the buttons and other controls with their positions, and a '
                + 'screenshot. Use it to check web UI you built: open the page, then click, type or press keys as a user would, and '
                + 'look again. The page stays open between calls: leave out `path` and `url` to keep using it, give one to load '
                + '(or reload, after an edit) a page.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'An HTML file of the workspace, e.g. "index.html" or "dist/index.html". Callisto serves its '
                            + 'folder over http, so ES modules and fetch work. A page that imports packages by bare name '
                            + '("three", "react") needs its bundler: open the built page or the dev server\'s url instead.'
                    },
                    url: {
                        type: 'string',
                        description: 'A page served on this machine, e.g. "http://localhost:5173/" from a dev server you started.'
                    },
                    actions: {
                        type: 'array',
                        description: 'Steps to do on the page, in order, after it loads. Act on an element by `selector` (CSS) or '
                            + '`text` (its visible label), or on a point by `x` and `y` in screenshot pixels (for a canvas). '
                            + 'Examples: {"action":"click","text":"New Game"}, {"action":"click","x":640,"y":400}, '
                            + '{"action":"type","selector":"#name","value":"Ada"}, {"action":"press","key":"Enter"}, '
                            + '{"action":"select","selector":"#level","value":"Hard"}, '
                            + '{"action":"drag","x":600,"y":400,"toX":700,"toY":400}, {"action":"wait","ms":1000}.',
                        items: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', enum: ACTIONS },
                                selector: { type: 'string', description: 'CSS selector of the element.' },
                                text: { type: 'string', description: 'Visible text of the element, e.g. a button label.' },
                                x: { type: 'number' },
                                y: { type: 'number' },
                                toX: { type: 'number', description: 'drag: where to let go.' },
                                toY: { type: 'number' },
                                value: { type: 'string', description: 'type: the text. select: the option\'s value or label.' },
                                key: { type: 'string', description: 'press: e.g. "Enter", "Escape", "ArrowLeft", "a".' },
                                deltaY: { type: 'number', description: 'scroll: pixels down; negative scrolls up. Default 400.' },
                                ms: { type: 'number', description: 'wait: milliseconds, at most 10000.' }
                            },
                            required: ['action']
                        }
                    },
                    evaluate: {
                        type: 'string',
                        description: 'A JavaScript expression evaluated in the page after the actions; its value comes back as JSON. '
                            + 'E.g. "document.querySelectorAll(\'.cell.filled\').length" or "window.game.turn".'
                    },
                    screenshot: { type: 'boolean', description: 'Default true. false skips the screenshot when only the log or text matters.' },
                    width: { type: 'number', description: 'Viewport width in CSS pixels; default 1280.' },
                    height: { type: 'number', description: 'Viewport height in CSS pixels; default 800.' }
                }
            },
            getArgumentsShortLabel: args => {
                const parsed = parse(args);
                const target = typeof parsed.path === 'string' ? parsed.path : typeof parsed.url === 'string' ? parsed.url : undefined;
                const steps = Array.isArray(parsed.actions) && parsed.actions.length > 0
                    ? `${parsed.actions.length} action${parsed.actions.length === 1 ? '' : 's'}` : undefined;
                const label = [target, steps].filter(Boolean).join(' · ');
                return label ? { label, hasMore: false } : undefined;
            },
            handler: async args => {
                if (this.preferences.get<boolean>(BROWSER_ENABLED_PREF, true) === false) {
                    return 'The browser is turned off in Callisto\'s settings (callisto.browser.enabled). Check your work another way, '
                        + 'and tell the user it was not checked in a browser.';
                }
                const parsed = parse(args);
                let open: BrowserRequest['open'];
                try {
                    open = await this.target(parsed);
                } catch (error) {
                    return error instanceof Error ? error.message : String(error);
                }
                const result = await this.service.run({
                    open,
                    actions: Array.isArray(parsed.actions) ? parsed.actions.filter(isAction) : undefined,
                    evaluate: typeof parsed.evaluate === 'string' ? parsed.evaluate : undefined,
                    screenshot: parsed.screenshot !== false,
                    width: typeof parsed.width === 'number' ? parsed.width : undefined,
                    height: typeof parsed.height === 'number' ? parsed.height : undefined,
                    executablePath: this.preferences.get<string>(BROWSER_EXECUTABLE_PREF, '') ?? ''
                });
                return formatBrowserResult(result);
            }
        };
    }

    protected async target(args: Record<string, unknown>): Promise<BrowserRequest['open']> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (path && url) {
            throw new Error('browser: pass either `path` or `url`, not both.');
        }
        if (/^https?:\/\//i.test(path)) {
            return { url: path };
        }
        if (url && !/^https?:\/\//i.test(url)) {
            // A workspace file passed as `url`.
            return this.target({ path: url.replace(/^file:\/\//i, '') });
        }
        if (url) {
            return { url };
        }
        if (!path) {
            return undefined;
        }
        let uri;
        try {
            uri = await this.workspaceScope.resolveAccessiblePath(path);
        } catch (error) {
            throw new Error(`browser: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (uri.scheme !== 'file') {
            throw new Error(`browser: ${path} is not a file on this machine.`);
        }
        const root = this.workspaceScope.getContainingRoot(uri) ?? uri.parent;
        return { file: uri.path.fsPath(), root: root.path.fsPath() };
    }
}

/** The result as the model reads it: a text report, and the screenshot as an image. */
export function formatBrowserResult(result: BrowserResult): ToolCallContent | string {
    if (result.error && !result.url) {
        return `browser: ${result.error}`;
    }
    const lines: string[] = [];
    const where = result.workspacePath !== undefined ? `${result.workspacePath} (served at ${result.url})` : result.url ?? '(no page)';
    const status = result.status !== undefined ? ` · HTTP ${result.status}` : '';
    lines.push(`Page: ${where}${result.title ? ` · "${result.title}"` : ''}${status}`);
    lines.push(`Viewport ${result.viewport.width}×${result.viewport.height}${result.browser ? ` · ${result.browser}` : ''}`);

    if (result.actions.length > 0) {
        lines.push('', 'Actions:');
        result.actions.forEach((action, index) => lines.push(`${index + 1}. ${action.ok ? 'OK' : 'FAILED'} — ${action.message}`));
    }

    const problems = result.log.filter(entry => entry.kind === 'error' || entry.kind === 'exception' || entry.kind === 'network').length;
    lines.push('');
    if (result.log.length === 0) {
        lines.push('Console: nothing logged, no exceptions, no failed requests.');
    } else {
        lines.push(`Console and errors (${problems} error${problems === 1 ? '' : 's'}):`);
        for (const entry of result.log) {
            const source = entry.source ? ` ${entry.source}` : '';
            const times = entry.count > 1 ? ` (×${entry.count})` : '';
            const [first, ...rest] = entry.text.split('\n');
            lines.push(`- ${entry.kind.toUpperCase()}${source}: ${first}${times}`);
            rest.forEach(line => lines.push(`    ${line}`));
        }
        if (result.logOmitted > 0) {
            lines.push(`- … ${result.logOmitted} more entries left out.`);
        }
    }
    for (const hint of result.hints ?? []) {
        lines.push(`Hint: ${hint}`);
    }

    if (result.evaluate) {
        lines.push('', result.evaluate.ok ? `evaluate → ${result.evaluate.value}` : `evaluate threw: ${result.evaluate.value}`);
    }

    if (result.elements.length > 0) {
        lines.push('', 'Controls on screen (centre x, y):');
        for (const element of result.elements) {
            const label = element.label ? ` "${element.label}"` : '';
            const size = element.tag === 'canvas' || element.tag === 'video' ? ` ${element.width}×${element.height}` : '';
            const selector = element.selector ? ` ${element.selector}` : '';
            lines.push(`- ${element.tag}${label}${size} at (${element.x}, ${element.y})${selector}${element.disabled ? ' (disabled)' : ''}`);
        }
    }

    if (result.text !== undefined) {
        lines.push('', result.text ? `Visible text:\n${result.text}` : 'Visible text: none.');
    }
    if (result.error) {
        lines.push('', `Problem: ${result.error}`);
    }

    const content: ToolCallContentResult[] = [];
    if (result.screenshot) {
        lines.push('', `Screenshot attached (${result.viewport.width}×${result.viewport.height}; its pixels are the x/y used by actions).`);
        content.push({ type: 'text', text: lines.join('\n') });
        content.push({ type: 'image', base64data: result.screenshot.base64, mimeType: result.screenshot.mimeType });
        return { content };
    }
    return lines.join('\n');
}

function isAction(value: unknown): value is BrowserAction {
    return !!value && typeof value === 'object' && typeof (value as BrowserAction).action === 'string';
}

function parse(args: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(args || '{}');
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}
