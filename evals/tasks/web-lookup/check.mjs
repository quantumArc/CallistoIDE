// The answer is in SearXNG's search API docs (docs.searxng.org/dev/search_api.html): the `format` parameter, with
// json, csv and rss besides the default html. The task also requires that the agent searched and read a page, rather
// than answering from memory.
export default async function check({ answers, turnResults, chat }) {
    const answer = (answers[0] ?? '').toLowerCase();
    const byTool = turnResults[0]?.stats?.byTool ?? {};
    const searched = (byTool.webSearch ?? 0) > 0;
    const read = (byTool.fetchWebPage ?? 0) > 0;
    const formats = ['json', 'csv', 'rss'].filter(format => answer.includes(format));
    const right = /\bformat\b/.test(answer) && formats.length === 3;
    const notes = [
        `webSearch ${byTool.webSearch ?? 0}×, fetchWebPage ${byTool.fetchWebPage ?? 0}×`,
        `answer ${right ? 'right' : 'WRONG'} (formats named: ${formats.join(', ') || 'none'})`
    ];
    // A run during a network outage says nothing about the harness: every search and page read fails.
    const results = (chat?.model?.responses ?? []).flatMap(response => response.content ?? [])
        .filter(part => part.kind === 'toolCall').map(part => String(part.data?.result ?? ''));
    if (results.length > 0 && results.every(result => /connection error|Could not resolve|timeout|not running/i.test(result))) {
        notes.push('the web was unreachable for the whole run (every search and page read failed): run it again when online');
    }
    return { pass: searched && read && right, notes };
}
