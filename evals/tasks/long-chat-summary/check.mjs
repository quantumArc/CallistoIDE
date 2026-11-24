// The follow-up is answered from Callisto's summary of the first turn: the summary must exist, the answer must be
// right (js/ai.js, queen 900), and the follow-up should start short (few prompt tokens to re-read).
import { changedFixtureFiles } from '../../harness/check-utils.mjs';

export default async function check({ workspace, fixtureDir, answers, turnResults }) {
    const notes = [];
    const summary = turnResults[0]?.stats?.summary;
    notes.push(summary ? `summary: ${summary.words} words of ${summary.tokensBefore} tokens` : 'NO summary was written');
    const answer = answers[1] ?? '';
    const right = /ai\.js/.test(answer) && /\b900\b/.test(answer);
    notes.push(`follow-up answer ${right ? 'right' : 'WRONG'}: ${answer.slice(0, 160).replace(/\s+/g, ' ')}`);
    const followUp = turnResults[1];
    if (followUp) {
        notes.push(`follow-up re-read ${followUp.lmStudio.promptTokensRead} prompt tokens, ${followUp.stats.toolCalls} tool calls`);
    }
    const changed = changedFixtureFiles(fixtureDir, workspace);
    if (changed.length) {
        notes.push(`changed files: ${changed.join(', ')}`);
    }
    return { pass: !!summary && right && changed.length === 0, notes };
}
