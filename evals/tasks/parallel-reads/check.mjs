// Exported by more than one file: format (a, b), render (b, c), validate (a, c). `parse` is a trap: c.js has one, but
// does not export it.
import { changedFixtureFiles } from '../../harness/check-utils.mjs';

const CANDIDATES = ['format', 'load', 'parse', 'render', 'slugify', 'validate'];
const EXPECTED = ['format', 'render', 'validate'];

export default async function check({ workspace, fixtureDir, answers }) {
    const notes = [];
    const answer = answers[0] ?? '';
    const named = CANDIDATES.filter(name => new RegExp(`\\b${name}\\b`).test(answer));
    const correct = named.length === EXPECTED.length && EXPECTED.every(name => named.includes(name));
    notes.push(`named: ${named.join(', ') || '(none)'}`);
    const changed = changedFixtureFiles(fixtureDir, workspace);
    if (changed.length) {
        notes.push(`changed files: ${changed.join(', ')}`);
    }
    return { pass: correct && changed.length === 0, notes };
}
