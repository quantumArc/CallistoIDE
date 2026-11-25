/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { existsSync, promises as fs } from 'fs';
import { dirname, join, relative, sep } from 'path';

/** Packages followed from the project's dependencies, at most: enough for three.js and its add-on libraries. */
const MAX_PACKAGES = 300;

export interface ImportMapResult {
    /** Specifier → URL (root-relative path on the folder server, or an absolute URL from the project's own import map). */
    imports: Record<string, string>;
    /** Where "three" comes from, for the report; undefined when the project has no three.js the page can load. */
    threeFrom?: string;
}

/**
 * The import map that lets a browser load the project's modules as its bundler would: each package the project depends
 * on (and the packages those depend on) mapped to its ES module entry in node_modules, served from the workspace root.
 * When three.js is not installed there, the project's own import map (in an index.html) or the CDN URL the module
 * imports it from is used instead, so the page and the module share one copy of three.js.
 */
export async function importMapFor(root: string, moduleDir: string, moduleSource: string | undefined): Promise<ImportMapResult> {
    const imports: Record<string, string> = {};
    let threeFrom: string | undefined;

    // node_modules folders as Node looks them up: from the module's folder up to the workspace root.
    const moduleDirs: string[] = [];
    const manifests: string[] = [];
    for (let dir = moduleDir; ; dir = dirname(dir)) {
        if (existsSync(join(dir, 'node_modules'))) {
            moduleDirs.push(join(dir, 'node_modules'));
        }
        if (existsSync(join(dir, 'package.json'))) {
            manifests.push(join(dir, 'package.json'));
        }
        if (dir === root || !dir.startsWith(root) || dirname(dir) === dir) {
            break;
        }
    }

    const queue: string[] = ['three'];
    for (const manifest of manifests) {
        const pkg = await readJson(manifest);
        queue.push(...Object.keys(asRecord(pkg?.dependencies)), ...Object.keys(asRecord(pkg?.devDependencies)));
    }
    const seen = new Set<string>();
    while (queue.length > 0 && seen.size < MAX_PACKAGES) {
        const name = queue.shift()!;
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        const pkgDir = moduleDirs.map(dir => join(dir, ...name.split('/'))).find(dir => existsSync(join(dir, 'package.json')));
        if (!pkgDir) {
            continue;
        }
        const path = relative(root, pkgDir);
        if (path.startsWith('..')) {
            continue;
        }
        const pkg = await readJson(join(pkgDir, 'package.json'));
        if (!pkg) {
            continue;
        }
        const base = '/' + path.split(sep).map(encodeURIComponent).join('/') + '/';
        imports[`${name}/`] = base;
        const entry = moduleEntry(pkg);
        if (entry) {
            imports[name] = base + stripDot(entry);
        }
        for (const [key, target] of subpathPatterns(pkg)) {
            imports[`${name}/${key}`] = base + target;
        }
        if (name === 'three') {
            threeFrom = path.split(sep).join('/');
        }
        queue.push(...Object.keys(asRecord(pkg.dependencies)));
    }

    if (!imports.three) {
        const fromHtml = await projectImportMap(root, moduleDir);
        for (const [key, value] of Object.entries(fromHtml.imports)) {
            imports[key] ??= value;
        }
        threeFrom = imports.three ? fromHtml.from : undefined;
    }
    if (!imports.three && moduleSource) {
        // `import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js'`
        const url = moduleSource.match(/from\s+['"](https?:\/\/[^'"]*three[^'"]*\.js)['"]/)?.[1];
        if (url) {
            imports.three = url;
            threeFrom = url;
        }
    }
    if (imports.three && !imports['three/addons/']) {
        const base = imports.three.match(/^(.*)\/build\/three\.module(?:\.min)?\.js$/)?.[1];
        if (base) {
            imports['three/addons/'] = `${base}/examples/jsm/`;
        }
    }
    return { imports, threeFrom };
}

/** The import map of the nearest index.html from the module's folder up to the root, with relative URLs made root-relative. */
async function projectImportMap(root: string, moduleDir: string): Promise<{ imports: Record<string, string>; from?: string }> {
    for (let dir = moduleDir; ; dir = dirname(dir)) {
        const html = join(dir, 'index.html');
        if (existsSync(html)) {
            const text = await fs.readFile(html, 'utf8').catch(() => '');
            const json = text.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
            const parsed = json ? safeParse(json) : undefined;
            const imports = asRecord(asRecord(parsed).imports);
            if (Object.keys(imports).length > 0) {
                const page = new URL('/' + relative(root, html).split(sep).map(encodeURIComponent).join('/'), 'http://root');
                const resolved: Record<string, string> = {};
                for (const [key, value] of Object.entries(imports)) {
                    if (typeof value === 'string') {
                        const url = new URL(value, page);
                        resolved[key] = url.origin === 'http://root' ? url.pathname : url.href;
                    }
                }
                return { imports: resolved, from: `the import map in ${relative(root, html).split(sep).join('/')}` };
            }
        }
        if (dir === root || !dir.startsWith(root) || dirname(dir) === dir) {
            return { imports: {} };
        }
    }
}

/** A package's ES module entry, the way a browser bundler picks it. */
function moduleEntry(pkg: Record<string, unknown>): string | undefined {
    const exportsField = pkg.exports;
    let fromExports: string | undefined;
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
        fromExports = pickCondition(exportsField);
    } else if (exportsField && typeof exportsField === 'object') {
        const keys = Object.keys(exportsField);
        fromExports = pickCondition(keys.some(key => key.startsWith('.')) ? (exportsField as Record<string, unknown>)['.'] : exportsField);
    }
    const candidates = [fromExports, pkg.module, pkg.browser, pkg.main];
    return candidates.find((value): value is string => typeof value === 'string') ?? 'index.js';
}

/** `"./addons/*": "./examples/jsm/*"` → ["addons/", "examples/jsm/"]. */
function subpathPatterns(pkg: Record<string, unknown>): [string, string][] {
    const exportsField = pkg.exports;
    if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
        return [];
    }
    const patterns: [string, string][] = [];
    for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
        const target = pickCondition(value);
        if (key.startsWith('./') && key.endsWith('/*') && target?.endsWith('/*')) {
            const from = key.slice(2, -1);
            const to = stripDot(target.slice(0, -1));
            if (from !== to) {
                patterns.push([from, to]);
            }
        }
    }
    return patterns;
}

function pickCondition(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const picked = pickCondition(item);
            if (picked) {
                return picked;
            }
        }
        return undefined;
    }
    if (value && typeof value === 'object') {
        // `import` is the ES module build; `browser` is sometimes a UMD bundle, so it only comes after.
        for (const condition of ['import', 'module', 'browser', 'default']) {
            if (condition in value) {
                const picked = pickCondition((value as Record<string, unknown>)[condition]);
                if (picked) {
                    return picked;
                }
            }
        }
    }
    return undefined;
}

function stripDot(path: string): string {
    return path.replace(/^\.\//, '');
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
    try {
        return asRecord(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
        return undefined;
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
