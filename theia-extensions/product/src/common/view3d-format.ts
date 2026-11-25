/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ToolCallContent, ToolCallContentResult } from '@theia/ai-core';
import type { View3dResult } from './browser-protocol.js';

/**
 * `calls` as a list of argument lists. A flat list (`["n", "w"]`) is taken as the arguments of one call, which is what a
 * model means by it more often than one call per item.
 */
export function normalizeCalls(value: unknown): { calls?: unknown[][]; note?: string } {
    if (!Array.isArray(value) || value.length === 0) {
        return {};
    }
    if (value.every(Array.isArray)) {
        return { calls: value as unknown[][] };
    }
    if (value.some(Array.isArray)) {
        return { calls: value.map(item => Array.isArray(item) ? item : [item]) };
    }
    return {
        calls: [value],
        note: '`calls` was a flat list, so it was used as the arguments of one call. For several objects pass a list of lists, e.g. '
            + `${JSON.stringify(value.slice(0, 2).map(item => [item]))}.`
    };
}

/** The result as the model reads it: what each object is and what the checks found, and the picture. */
export function formatView3dResult(result: View3dResult): ToolCallContent | string {
    const lines: string[] = [];
    const what = result.workspacePath ? `${result.workspacePath}${result.exportName ? ` → ${result.exportName}` : ''}` : '(nothing)';
    if (result.error && result.objects.length === 0) {
        lines.push(`view3d ${what}: ${result.error}`);
    } else {
        const three = result.revision ? ` · three r${result.revision}${result.threeFrom ? ` from ${result.threeFrom}` : ''}` : '';
        const look = result.materials ? 'own materials' : 'plain grey (materials: true shows its own)';
        lines.push(`view3d ${what} · ${result.objects.length} object${result.objects.length === 1 ? '' : 's'}${three} · ${look}`);
        const single = result.objects.length === 1;
        const fixesGiven = new Set<string>();
        result.objects.forEach((object, index) => {
            lines.push('', `${index + 1}. ${object.label}: ${object.sizeText}; base at y ${object.bottomText}, centred on ${object.centerText}.`);
            if (object.parts > 0) {
                lines.push(`   ${object.parts} part${object.parts === 1 ? '' : 's'} (${object.partTypes}), ${object.triangles.toLocaleString('en-US')} triangles.`);
            }
            if (single && object.parts > 1) {
                object.partList.forEach(part => lines.push(`   - ${part}`));
                if (object.partsOmitted > 0) {
                    lines.push(`   - … ${object.partsOmitted} more parts`);
                }
            }
            if (object.warnings.length > 0) {
                lines.push('   Problems:');
                for (const warning of object.warnings) {
                    const fix = !warning.fix ? '' : fixesGiven.has(warning.fix) ? ' (Fix as above.)' : ` ${warning.fix}`;
                    if (warning.fix) {
                        fixesGiven.add(warning.fix);
                    }
                    lines.push(`   - ${warning.text}${fix}`);
                }
            } else {
                lines.push('   Checks: no loose parts, holes or coarse curves found. Judge the look from the image.');
            }
        });
        if (result.notes.length > 0) {
            lines.push('', 'Across objects:');
            result.notes.forEach(note => lines.push(`- ${note}`));
        }
        if (result.error) {
            lines.push('', `Problem: ${result.error}`);
        }
    }
    if (result.log.length > 0) {
        lines.push('', 'Console and errors while building it:');
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
    if (!result.screenshot) {
        return lines.join('\n');
    }
    lines.push('', result.objects.length === 1
        ? 'Image attached: front (seen from +z), side (from −x, +z to the right) and top (from +y, +z down), orthographic so proportions '
        + 'are true, on a grid in scene units; and a 3/4 view from the front right. Compare it with the real thing: silhouette, '
        + 'proportions, and the details that make it recognisable.'
        : 'Image attached: top row, the front of each object in the order above, at one scale on a shared floor (orthographic, grid in '
        + 'scene units); bottom row, the same objects from the front right. Compare them with the real things and with each other.');
    const content: ToolCallContentResult[] = [
        { type: 'text', text: lines.join('\n') },
        { type: 'image', base64data: result.screenshot.base64, mimeType: result.screenshot.mimeType }
    ];
    return { content };
}
