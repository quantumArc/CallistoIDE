// The results table: one line per task while a run goes, and the markdown table at the end.

export function totals(result) {
    const sum = key => result.turns.reduce((total, turn) => total + (key(turn) ?? 0), 0);
    return {
        modelCalls: sum(turn => turn.lmStudio.modelCalls),
        toolCalls: sum(turn => turn.stats.toolCalls),
        reread: sum(turn => turn.lmStudio.promptTokensRead),
        written: sum(turn => turn.lmStudio.generatedTokens),
        turnSeconds: sum(turn => turn.seconds),
        lastPrompt: result.turns.at(-1)?.stats.lastPromptTokens,
        interruptions: sum(turn => turn.stats.interruptions),
        paused: result.turns.some(turn => turn.stats.pausedForUser),
        timedOut: result.turns.some(turn => turn.timedOut),
        errors: result.turns.map(turn => turn.stats.error).filter(Boolean),
        background: result.turns.filter(turn => turn.background.modelCalls > 0)
            .map(turn => `${turn.background.modelCalls} background call(s), ${turn.background.seconds} s, ${fmt(turn.background.promptTokensRead)} re-read`)
    };
}

export function formatLine(result) {
    const t = totals(result);
    if (result.skipped) {
        return `SKIP  ${result.id.padEnd(18)}          ${result.notes.join('; ')}`;
    }
    return `${result.pass ? 'PASS' : 'FAIL'}  ${result.id.padEnd(18)} ${duration(t.turnSeconds).padStart(7)}  `
        + `${t.modelCalls} model calls, ${t.toolCalls} tool calls, ${fmt(t.reread)} tokens re-read, ${fmt(t.written)} written`
        + `${t.interruptions ? `, ${t.interruptions} interruption(s)` : ''}${t.paused ? ', handed back' : ''}${t.timedOut ? ', TIMED OUT' : ''}`
        + `\n      ${result.notes.filter(note => !note.includes('\n')).join('; ')}`;
}

export function markdownTable(run) {
    const rows = run.tasks.map(result => {
        const t = totals(result);
        const notes = [
            ...(t.interruptions ? [`${t.interruptions} loop-breaker interruption(s)`] : []),
            ...(t.paused ? ['handed back to the user'] : []),
            ...(t.timedOut ? ['timed out'] : []),
            ...t.errors.map(error => `error: ${error}`),
            ...t.background,
            ...result.notes.filter(note => !note.includes('\n') && !/tests: pass$/.test(note))
        ].join('; ').replace(/\|/g, '\\|');
        if (result.skipped) {
            return `| ${result.id} | skipped | | | | | | | ${notes} |`;
        }
        return `| ${result.id} | ${result.pass ? 'pass' : '**fail**'} | ${duration(t.turnSeconds)} | ${t.modelCalls} | ${t.toolCalls} `
            + `| ${fmt(t.reread)} | ${fmt(t.written)} | ${fmt(t.lastPrompt)} | ${notes} |`;
    });
    const ran = run.tasks.filter(result => !result.skipped);
    const passed = ran.filter(result => result.pass).length;
    const skipped = run.tasks.length - ran.length;
    const totalSeconds = run.tasks.reduce((sum, result) => sum + totals(result).turnSeconds, 0);
    return [
        `**${passed}/${ran.length} passed**${skipped ? ` (${skipped} skipped)` : ''} in ${duration(totalSeconds)} of agent time. `
        + `${run.harness}; ${run.lmStudio.key} (${run.lmStudio.quantization ?? '?'}, context ${fmt(run.lmStudio.contextLength)}), `
        + `reasoning ${run.reasoning}; run ${run.runId}${run.label ? ` (${run.label})` : ''}.`,
        '',
        '| Task | Result | Time | Model calls | Tool calls | Prompt tokens re-read | Tokens written | Last prompt | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        ''
    ].join('\n');
}

export function duration(seconds) {
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

export function fmt(value) {
    return typeof value === 'number' ? value.toLocaleString('en-US') : '–';
}
