// Helpers for the tasks' check.mjs files.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Runs `node --test` on the given files (default: the workspace's own tests) with WORKSPACE set; never throws. */
export function runNodeTests(cwd, files = [], env = {}) {
    const result = spawnSync(process.execPath, ['--test', ...files], {
        cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return { ok: result.status === 0, output: tail(output, 1500) };
}

/** Runs a command in the workspace; never throws. */
export function run(cwd, command, args, { timeout = 60_000 } = {}) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Files of the fixture that are missing or different in the workspace, as paths relative to the fixture. */
export function changedFixtureFiles(fixtureDir, workspace, only) {
    return listFiles(fixtureDir)
        .map(file => relative(fixtureDir, file))
        .filter(path => !only || only.includes(path))
        .filter(path => !existsSync(join(workspace, path)) || hash(join(workspace, path)) !== hash(join(fixtureDir, path)));
}

/** Workspace files whose text matches the pattern, ignoring dependency and VCS folders. */
export function filesMatching(workspace, pattern) {
    return listFiles(workspace)
        .filter(file => pattern.test(readFileSync(file, 'utf8')))
        .map(file => relative(workspace, file));
}

export function listFiles(dir) {
    if (!existsSync(dir)) {
        return [];
    }
    const files = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === '.theia') {
            continue;
        }
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            files.push(...listFiles(path));
        } else {
            files.push(path);
        }
    }
    return files;
}

function hash(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function tail(text, max) {
    return text.length > max ? `…${text.slice(-max)}` : text;
}
