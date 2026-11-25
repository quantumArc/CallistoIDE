// Looks at the reworked rook and knight with Callisto's own view3d service, as the agent could have. The crude fixture
// fails its checks: the rook is open at the top with battlements floating above it, its profile has 6 points, and the
// knight is a flat 7-point cut-out. The task passes when the agent looked with view3d and both pieces now pass the
// checks (no loose parts, holes, coarse profiles or flat slabs). Whether they look like Staunton pieces is judged by
// eye from the saved picture.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO } from '../../harness/app.mjs';

export default async function check({ workspace, turnResults }) {
    const byTool = turnResults[0]?.stats?.byTool ?? {};
    const looked = (byTool.view3d ?? 0) > 0;
    const notes = [`view3d ${byTool.view3d ?? 0}×, browser ${byTool.browser ?? 0}×`];
    await import(join(REPO, 'node_modules', 'reflect-metadata', 'Reflect.js'));
    const { BrowserServiceImpl } = await import(join(REPO, 'theia-extensions', 'product', 'lib', 'node', 'browser-service.js'));
    const service = new BrowserServiceImpl();
    try {
        const result = await service.view3d({
            root: workspace, file: join(workspace, 'src', 'pieces.js'), exportName: 'buildPiece', calls: [['rook'], ['knight']]
        });
        if (result.screenshot) {
            const picture = join(dirname(workspace), 'rook-and-knight.jpg');
            writeFileSync(picture, Buffer.from(result.screenshot.base64, 'base64'));
            notes.push(`picture: ${picture}`);
        }
        if (result.error || result.objects.length !== 2) {
            return { pass: false, notes: [...notes, `view3d failed: ${result.error ?? `${result.objects.length} objects`}`] };
        }
        let clean = true;
        for (const object of result.objects) {
            const problems = object.warnings.map(warning => warning.text);
            clean &&= problems.length === 0;
            notes.push(`${object.label}: ${object.sizeText}, ${object.parts} parts${problems.length ? `; ${problems.join(' | ')}` : ''}`);
        }
        return { pass: looked && clean, notes };
    } finally {
        await service.close();
    }
}
