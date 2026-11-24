// The answer is in SearXNG's search API docs (docs.searxng.org/dev/search_api.html): the `format` parameter, with
// json, csv and rss besides the default html. The task also requires that the agent searched and read a page, rather
// than answering from memory.
export default async function check({ answers, turnResults }) {
    const answer = (answers[0] ?? '').toLowerCase();
    const byTool = turnResults[0]?.stats?.byTool ?? {};
    const searched = (byTool.webSearch ?? 0) > 0;
    const read = (byTool.fetchWebPage ?? 0) > 0;
    const formats = ['json', 'csv', 'rss'].filter(format => answer.includes(format));
    const right = /\bformat\b/.test(answer) && formats.length === 3;
    return {
        pass: searched && read && right,
        notes: [
            `webSearch ${byTool.webSearch ?? 0}×, fetchWebPage ${byTool.fetchWebPage ?? 0}×`,
            `answer ${right ? 'right' : 'WRONG'} (formats named: ${formats.join(', ') || 'none'})`
        ]
    };
}
