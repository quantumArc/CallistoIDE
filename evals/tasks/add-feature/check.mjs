import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeTests } from '../../harness/check-utils.mjs';

export default async function check({ workspace }) {
    const notes = [];
    const visible = runNodeTests(workspace);
    notes.push(`workspace tests: ${visible.ok ? 'pass' : 'FAIL'}`);
    let testsMentionRemove = false;
    try {
        testsMentionRemove = /\bremove\s*\(/.test(readFileSync(join(workspace, 'test', 'todo.test.js'), 'utf8'));
    } catch {
        // Missing file: counted as no tests.
    }
    notes.push(`tests for remove added: ${testsMentionRemove ? 'yes' : 'NO'}`);
    const hidden = runNodeTests(workspace, [fileURLToPath(new URL('./hidden/todo.hidden.test.js', import.meta.url))], { WORKSPACE: workspace });
    notes.push(`hidden tests: ${hidden.ok ? 'pass' : 'FAIL'}`);
    if (!hidden.ok) {
        notes.push(hidden.output);
    }
    return { pass: visible.ok && testsMentionRemove && hidden.ok, notes };
}
