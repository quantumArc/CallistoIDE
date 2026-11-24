// The bug: `[...values].sort()` sorts as strings, so [3, 10, 2] becomes [10, 2, 3].
import { fileURLToPath } from 'node:url';
import { changedFixtureFiles, runNodeTests } from '../../harness/check-utils.mjs';

export default async function check({ workspace, fixtureDir }) {
    const notes = [];
    const testsChanged = changedFixtureFiles(fixtureDir, workspace, ['test/stats.test.js']).length > 0;
    if (testsChanged) {
        notes.push('the visible test file was changed');
    }
    const visible = runNodeTests(workspace);
    notes.push(`visible tests: ${visible.ok ? 'pass' : 'FAIL'}`);
    const hidden = runNodeTests(workspace, [fileURLToPath(new URL('./hidden/stats.hidden.test.js', import.meta.url))], { WORKSPACE: workspace });
    notes.push(`hidden tests: ${hidden.ok ? 'pass' : 'FAIL'}`);
    if (!hidden.ok) {
        notes.push(hidden.output);
    }
    return { pass: !testsChanged && visible.ok && hidden.ok, notes };
}
