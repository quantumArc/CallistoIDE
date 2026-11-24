import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeTests } from '../../harness/check-utils.mjs';

export default async function check({ workspace }) {
    if (!existsSync(join(workspace, 'wordfreq.js'))) {
        return { pass: false, notes: ['wordfreq.js was not created'] };
    }
    const hidden = runNodeTests(workspace, [fileURLToPath(new URL('./hidden/wordfreq.hidden.test.js', import.meta.url))], { WORKSPACE: workspace });
    return { pass: hidden.ok, notes: [`hidden tests: ${hidden.ok ? 'pass' : 'FAIL'}`, ...(hidden.ok ? [] : [hidden.output])] };
}
