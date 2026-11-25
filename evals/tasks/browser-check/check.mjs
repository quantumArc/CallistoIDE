// The bugs: app.js imports `remaining`, which store.js does not export (it is `countRemaining`), so the module fails to
// link and nothing runs; and the form's submit handler does not call preventDefault, so the page reloads and the new
// to-do is gone. Neither shows without running the page in a browser (`node --check` passes both files). The task also
// requires that the agent looked at the page with its browser tool.
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from '../../harness/app.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export default async function check({ workspace, turnResults }) {
    const byTool = turnResults[0]?.stats?.byTool ?? {};
    const looked = (byTool.browser ?? 0) > 0;
    const notes = [`browser ${byTool.browser ?? 0}×`];
    let behaviour;
    try {
        behaviour = await exercise(workspace);
    } catch (error) {
        return { pass: false, notes: [...notes, `could not run the page: ${error.message}`] };
    }
    notes.push(...behaviour.notes);
    return { pass: looked && behaviour.ok, notes };
}

async function exercise(workspace) {
    const require = createRequire(join(REPO, 'theia-extensions', 'product', 'package.json'));
    await import(join(REPO, 'node_modules', 'reflect-metadata', 'Reflect.js'));
    const { findBrowser } = await import(join(REPO, 'theia-extensions', 'product', 'lib', 'node', 'browser-service.js'));
    const { launch } = require('puppeteer-core');
    const found = findBrowser('');
    if (!found) {
        throw new Error('no Chrome found to check the page with');
    }
    const root = resolve(workspace);
    const server = createServer((request, response) => {
        const path = resolve(join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname)));
        const file = path === root ? join(root, 'index.html') : path;
        if (!file.startsWith(root + sep) || !existsSync(file)) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        createReadStream(file).pipe(response);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const browser = await launch({ executablePath: found.path, headless: true });
    const notes = [];
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
        const items = () => page.$$eval('#todo-list li', lis => lis.map(li => ({ text: li.innerText.trim(), done: li.classList.contains('done') })));
        const counter = () => page.$eval('#count', el => el.textContent.trim());
        await page.type('#new-todo', 'buy milk');
        await page.click('#add-form button');
        await new Promise(done => setTimeout(done, 400));
        await page.type('#new-todo', 'walk the dog');
        await page.keyboard.press('Enter');
        await new Promise(done => setTimeout(done, 400));
        const added = await items();
        const countAfterAdd = await counter();
        if (added.length > 0) {
            await page.click('#todo-list li input[type=checkbox]');
            await new Promise(done => setTimeout(done, 200));
        }
        const afterTick = await items();
        const countAfterTick = await counter();
        const addOk = added.length === 2 && added[0].text === 'buy milk' && added[1].text === 'walk the dog';
        const countOk = countAfterAdd === '2 items left' && countAfterTick === '1 item left';
        const tickOk = afterTick[0]?.done === true && afterTick[1]?.done === false;
        notes.push(`add ${addOk ? 'works' : `BROKEN (${JSON.stringify(added)})`}`,
            `counter ${countOk ? 'works' : `BROKEN ("${countAfterAdd}", then "${countAfterTick}")`}`,
            `tick ${tickOk ? 'works' : 'BROKEN'}`);
        if (errors.length > 0) {
            notes.push(`page errors: ${errors.join('; ')}`);
        }
        return { ok: addOk && countOk && tickOk && errors.length === 0, notes };
    } finally {
        await browser.close();
        server.close();
    }
}
