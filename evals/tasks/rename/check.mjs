import { fileURLToPath } from 'node:url';
import { filesMatching, runNodeTests } from '../../harness/check-utils.mjs';

export default async function check({ workspace }) {
    const notes = [];
    const leftovers = filesMatching(workspace, /\bareaOfCircle\b/);
    notes.push(leftovers.length ? `areaOfCircle still in: ${leftovers.join(', ')}` : 'no areaOfCircle left');
    const visible = runNodeTests(workspace);
    notes.push(`workspace tests: ${visible.ok ? 'pass' : 'FAIL'}`);
    const hidden = runNodeTests(workspace, [fileURLToPath(new URL('./hidden/rename.hidden.test.js', import.meta.url))], { WORKSPACE: workspace });
    notes.push(`hidden tests: ${hidden.ok ? 'pass' : 'FAIL'}`);
    if (!hidden.ok) {
        notes.push(hidden.output);
    }
    return { pass: leftovers.length === 0 && visible.ok && hidden.ok, notes };
}
