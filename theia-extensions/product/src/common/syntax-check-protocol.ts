/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const SYNTAX_CHECK_PATH = '/services/callisto/syntax-check';

export const SyntaxCheckService = Symbol('SyntaxCheckService');

export interface SyntaxCheckResult {
    /** False when there is no checker for this kind of file, or the checker could not be run. */
    checked: boolean;
    /** What was run, for the message to the model, e.g. `node --check`. */
    checker?: string;
    ok?: boolean;
    /** The checker's error output, shortened. */
    message?: string;
}

/**
 * Parses a file without running it: `node --check` for JavaScript, Python's own parser for Python, `JSON.parse` for
 * JSON. Used by the Callisto agent to tell the model right after it writes a file whether the file even parses.
 */
export interface SyntaxCheckService {
    /** @param fsPath absolute file system path */
    check(fsPath: string): Promise<SyntaxCheckResult>;
}
