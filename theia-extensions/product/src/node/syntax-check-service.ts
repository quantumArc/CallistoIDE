/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SyntaxCheckResult, SyntaxCheckService } from '../common/syntax-check-protocol.js';

const TIMEOUT_MS = 10000;
const MAX_MESSAGE_CHARS = 1200;
/** Larger files are not worth blocking the agent on. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Parses without compiling, so no `__pycache__` is written; prints the error the way a compiler would, not a traceback. */
const PYTHON_PARSE = [
    'import ast, sys',
    'p = sys.argv[1]',
    'try:',
    '    ast.parse(open(p, encoding="utf-8").read(), p)',
    'except SyntaxError as e:',
    '    sys.stderr.write("%s:%s:%s: %s\\n%s\\n" % (e.filename, e.lineno, e.offset, e.msg, (e.text or "").rstrip()))',
    '    sys.exit(1)'
].join('\n');

@injectable()
export class SyntaxCheckServiceImpl implements SyntaxCheckService {

    async check(fsPath: string): Promise<SyntaxCheckResult> {
        try {
            const stat = await fs.stat(fsPath);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                return { checked: false };
            }
        } catch {
            return { checked: false };
        }
        switch (path.extname(fsPath).toLowerCase()) {
            case '.js':
            case '.mjs':
            case '.cjs':
                // Electron's own binary acts as Node with this variable set; in the browser build it is Node already. Using it
                // avoids depending on a `node` on the PATH, which apps started from the Finder do not have.
                return this.run('node --check', process.execPath, ['--check', fsPath], { ELECTRON_RUN_AS_NODE: '1' });
            case '.py':
                return this.run('python3 (ast.parse)', 'python3', ['-I', '-c', PYTHON_PARSE, fsPath]);
            case '.json':
                return this.checkJson(fsPath);
            default:
                return { checked: false };
        }
    }

    protected async checkJson(fsPath: string): Promise<SyntaxCheckResult> {
        try {
            JSON.parse(await fs.readFile(fsPath, 'utf8'));
            return { checked: true, checker: 'JSON.parse', ok: true };
        } catch (error) {
            return { checked: true, checker: 'JSON.parse', ok: false, message: shorten(String((error as Error).message ?? error)) };
        }
    }

    protected run(checker: string, command: string, args: string[], env: Record<string, string> = {}): Promise<SyntaxCheckResult> {
        return new Promise(resolve => {
            execFile(command, args, { timeout: TIMEOUT_MS, env: { ...process.env, ...env }, windowsHide: true }, (error, _stdout, stderr) => {
                if (!error) {
                    resolve({ checked: true, checker, ok: true });
                } else if (typeof error.code === 'number') {
                    resolve({ checked: true, checker, ok: false, message: shorten(stderr || error.message) });
                } else {
                    // Not found, timed out or killed: say nothing rather than something misleading.
                    resolve({ checked: false });
                }
            });
        });
    }
}

function shorten(text: string): string {
    const trimmed = text.trim();
    return trimmed.length <= MAX_MESSAGE_CHARS ? trimmed : trimmed.slice(0, MAX_MESSAGE_CHARS) + '\n…';
}
