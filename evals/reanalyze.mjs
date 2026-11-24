#!/usr/bin/env node
// Recomputes a run's LM Studio numbers from the log excerpts it saved (results/<run>/<task>.turnN.lmstudio.log) and
// rewrites its results.json and results.md, e.g. after the log parser was improved. Pass/fail and times are kept.
//
//   node evals/reanalyze.mjs evals/results/<run id>

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeSplit } from './harness/lmstudio-log.mjs';
import { markdownTable } from './harness/report.mjs';

const SEPARATOR = '\n===== after the reply =====\n';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'results.json'))) {
    console.error('Usage: node evals/reanalyze.mjs evals/results/<run id>');
    process.exit(1);
}
const run = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
for (const task of run.tasks) {
    task.turns.forEach((turn, index) => {
        const file = join(dir, `${task.id}.turn${index + 1}.lmstudio.log`);
        if (!existsSync(file)) {
            return;
        }
        const text = readFileSync(file, 'utf8');
        const at = text.indexOf(SEPARATOR);
        const [turnStats, background] = at < 0
            ? summarizeSplit(text, '')
            : summarizeSplit(text.slice(0, at), text.slice(at + SEPARATOR.length));
        turn.lmStudio = turnStats;
        // Wall time of the background work when the run measured it, else the model server's own time for it.
        const measured = turn.background?.seconds || Math.round(background.promptSeconds + background.generateSeconds);
        turn.background = { ...background, seconds: background.modelCalls ? measured : 0 };
    });
}
run.reanalyzed = new Date().toISOString();
writeFileSync(join(dir, 'results.json'), JSON.stringify(run, undefined, 2));
const table = markdownTable(run);
writeFileSync(join(dir, 'results.md'), table);
console.log(table);
