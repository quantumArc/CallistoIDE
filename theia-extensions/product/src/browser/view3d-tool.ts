/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core';
import { ToolProvider, ToolRequest } from '@theia/ai-core';
import { WorkspaceFunctionScope } from '@theia/ai-ide/lib/browser/workspace-functions';
import { BrowserService, VIEW3D_FUNCTION_ID, VIEW3D_MODEL_EXTENSIONS } from '../common/browser-protocol.js';
import { formatView3dResult, normalizeCalls } from '../common/view3d-format.js';
import { BROWSER_ENABLED_PREF, BROWSER_EXECUTABLE_PREF } from './callisto-agent-preferences.js';

/**
 * Lets the agent see a 3D object it built. A model writes coordinates it cannot picture: Inkling's chess pieces had a
 * hollow rook, a cardboard knight and lumpy outlines, none of which shows in the numbers it checked. The tool draws the
 * object from the front, side, top and at an angle in one image, and checks its geometry for what is easy to miss in a
 * picture (parts that float, holes, coarse lathe profiles).
 */
@injectable()
export class View3dTool implements ToolProvider {

    @inject(BrowserService)
    protected readonly service: BrowserService;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(WorkspaceFunctionScope)
    protected readonly workspaceScope: WorkspaceFunctionScope;

    getTool(): ToolRequest {
        return {
            id: VIEW3D_FUNCTION_ID,
            name: VIEW3D_FUNCTION_ID,
            providerName: 'callisto',
            description: 'Shows a 3D object you built, so you can see whether it looks right: one image with front, side and top views '
                + '(orthographic, true proportions, on a grid in scene units) and a 3/4 view, plus checks for parts that do not touch, '
                + 'holes, and coarse curves. Pass a model file, or a JavaScript module and the exported function that builds the object '
                + 'with three.js (returning a THREE.Object3D or BufferGeometry). Several `calls` show several objects side by side at '
                + 'one scale.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `A .js/.mjs module of the workspace that builds the object, or a model file (${VIEW3D_MODEL_EXTENSIONS.join(', ')}).`
                    },
                    export: {
                        type: 'string',
                        description: 'Module only: the exported function (or object) to show, e.g. "buildPieceMesh". Default: the default export.'
                    },
                    calls: {
                        type: 'array',
                        description: 'Module only: argument lists, one object each, e.g. [["knight", "white"], ["rook", "white"]]; up to 8. '
                            + 'Default: one call with no arguments.',
                        items: { type: 'array' }
                    },
                    materials: {
                        type: 'boolean',
                        description: 'true draws the object\'s own materials; the default, plain grey, shows the shape best.'
                    }
                },
                required: ['path']
            },
            getArgumentsShortLabel: args => {
                const parsed = parse(args);
                const path = typeof parsed.path === 'string' ? parsed.path : undefined;
                const name = typeof parsed.export === 'string' ? parsed.export : undefined;
                const count = Array.isArray(parsed.calls) && parsed.calls.length > 1 ? `${parsed.calls.length} objects` : undefined;
                const label = [path && name ? `${path} → ${name}` : path, count].filter(Boolean).join(' · ');
                return label ? { label, hasMore: false } : undefined;
            },
            handler: async args => {
                if (this.preferences.get<boolean>(BROWSER_ENABLED_PREF, true) === false) {
                    return 'view3d draws in the browser, which is turned off in Callisto\'s settings (callisto.browser.enabled). Tell the '
                        + 'user the 3D object was not looked at.';
                }
                const parsed = parse(args);
                const path = typeof parsed.path === 'string' ? parsed.path.trim() : '';
                if (!path) {
                    return 'view3d: pass `path`, the module that builds the object or a model file.';
                }
                let uri;
                try {
                    uri = await this.workspaceScope.resolveAccessiblePath(path);
                } catch (error) {
                    return `view3d: ${error instanceof Error ? error.message : String(error)}`;
                }
                if (uri.scheme !== 'file') {
                    return `view3d: ${path} is not a file on this machine.`;
                }
                const root = this.workspaceScope.getContainingRoot(uri) ?? uri.parent;
                const { calls, note } = normalizeCalls(parsed.calls ?? parsed.args);
                const result = await this.service.view3d({
                    file: uri.path.fsPath(),
                    root: root.path.fsPath(),
                    exportName: typeof parsed.export === 'string' ? parsed.export : typeof parsed.exportName === 'string' ? parsed.exportName : undefined,
                    calls,
                    materials: parsed.materials === true,
                    executablePath: this.preferences.get<string>(BROWSER_EXECUTABLE_PREF, '') ?? ''
                });
                if (note) {
                    result.notes.unshift(note);
                }
                return formatView3dResult(result);
            }
        };
    }
}

function parse(args: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(args || '{}');
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}
