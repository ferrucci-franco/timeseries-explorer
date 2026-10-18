// End-to-end check that the mouse and the fingers do the same thing on every
// 3D view: 3D, 2D+t and the 3D state animation (ui/plot-3d-gestures.js).
//
// Plotly's gl3d scene keeps its zoom in two places — the camera distance in
// perspective, the aspect ratio in orthographic (the app's default) — and it
// answers the mouse its own way: no double-click reset, a middle or Alt drag
// that zooms the camera distance (invisible in orthographic), a sideways wheel
// that rolls the camera. Each check below runs on all three views, in both
// projections where the projection matters.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:3d-view-gestures`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,x,y,z'];
    for (let i = 0; i < 1500; i++) {
        const t = i / 100;
        lines.push(`${t.toFixed(3)},${Math.cos(t).toFixed(6)},${Math.sin(t).toFixed(6)},${(t / 15).toFixed(6)}`);
    }
    return { name: 'helix.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// SOFT=1 reports every failing check instead of stopping at the first.
const failures = [];
const check = (condition, message) => {
    if (condition) return;
    if (!process.env.SOFT) assert.fail(message);
    failures.push(message);
    console.log(`FAIL ${message}`);
};

const VIEWS = [
    { label: '3D', mode: 'phase3d', vars: ['x', 'y', 'z'] },
    { label: '2D+t', mode: 'phase2dt', vars: ['x', 'y'] },
    { label: '▶x 3D', mode: 'state-anim', dim: 3, vars: ['x', 'y', 'z'] },
];

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
    await context.addInitScript(() => localStorage.setItem('omv_touch_hint_seen', '1'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        const app = window.app;
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        return document.querySelector('.layout-panel').dataset.id;
    });
    assert.equal(await page.evaluate(() => !!window.app._compact?.active), false, 'the desktop layout, on a touch screen');
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: i })),
    });

    const open = async (view, projection) => {
        await page.evaluate(({ id, view, projection }) => {
            const pm = window.app.plotManager;
            const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
            const plot = pm.plots.get(id);
            if (plot?.animPlaying) pm._stateAnimTogglePlay(id);
            pm.plots.get(id).projection = projection;
            pm._setMode(id, view.mode, view.dim || null);
            const now = pm.plots.get(id);
            const has = view.mode === 'state-anim' ? (now.stateSlots?.x?.length || 0) : (now.phaseTraces?.length || 0);
            if (!has) for (const name of view.vars) pm.addTrace(id, name, panelEl);
        }, { id: panelId, view, projection });
        await page.waitForFunction(({ id, mode }) => {
            const plot = window.app.plotManager.plots.get(id);
            return plot?.mode === mode && plot.div?._fullLayout?.scene?._scene
                && plot.div.data?.some(t => t.type === 'scatter3d' && t.x?.length > 100);
        }, { id: panelId, mode: view.mode }, { timeout: 30000 });
        await page.waitForTimeout(900);
    };
    const readView = () => page.evaluate(id => {
        const scene = window.app.plotManager.plots.get(id).div._fullLayout.scene._scene;
        const cam = scene.getCamera();
        return { eye: cam.eye, center: cam.center, aspect: scene.glplot.getAspectratio(), ortho: !!scene.camera._ortho };
    }, panelId);
    const centre = () => page.evaluate(id => {
        const r = window.app.plotManager.plots.get(id).div._fullLayout.scene._scene.container.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, panelId);
    // How far the view is zoomed in, whichever projection keeps it.
    const zoomOf = (v) => (v.ortho ? v.aspect.x : 1 / Math.hypot(v.eye.x - v.center.x, v.eye.y - v.center.y, v.eye.z - v.center.z));
    const sameView = (a, b, eps = 1e-3) => ['x', 'y', 'z'].every(k => Math.abs(a.eye[k] - b.eye[k]) < eps
        && Math.abs(a.center[k] - b.center[k]) < eps && Math.abs(a.aspect[k] - b.aspect[k]) < eps);
    const wheelZoomIn = async () => {
        const c = await centre();
        await page.mouse.move(c.x, c.y);
        for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -60);
        await page.waitForTimeout(500);
    };
    const orbit = async () => {
        const c = await centre();
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        await page.mouse.move(c.x + 80, c.y + 30, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(400);
    };
    const settled = () => page.waitForTimeout(700);

    for (const projection of ['orthographic', 'perspective']) {
        for (const view of VIEWS) {
            const tag = `${view.label} (${projection})`;
            await open(view, projection);
            const home = await readView();
            assert.equal(home.ortho, projection === 'orthographic', `${tag}: opens in its projection`);

            // ── Double click: back to the opening view, zoom included ──
            await wheelZoomIn();
            await orbit();
            let v = await readView();
            check(zoomOf(v) > zoomOf(home) * 1.2, `${tag}: the wheel zooms in (${zoomOf(home)} → ${zoomOf(v)})`);
            check(!sameView(v, home), `${tag}: the drag orbits`);
            const c = await centre();
            await page.mouse.dblclick(c.x, c.y);
            await settled();
            v = await readView();
            check(sameView(v, home), `${tag}: a double click goes back to the opening view\n  ${JSON.stringify(home)}\n  ${JSON.stringify(v)}`);

            // ── Home button: the same view ──
            await wheelZoomIn();
            await orbit();
            await page.evaluate(id => window.app.plotManager._autoScalePlot(id), panelId);
            await settled();
            v = await readView();
            check(sameView(v, home), `${tag}: Home goes back to the opening view, zoom included\n  ${JSON.stringify(home)}\n  ${JSON.stringify(v)}`);

            // ── A sideways wheel (trackpad swipe, Shift+wheel) neither rolls nor jumps ──
            await page.mouse.move(c.x, c.y);
            for (let i = 0; i < 6; i++) await page.mouse.wheel(60, 0);
            await settled();
            v = await readView();
            check(sameView(v, home), `${tag}: a sideways wheel leaves the view alone\n  ${JSON.stringify(home)}\n  ${JSON.stringify(v)}`);

            // ── Middle drag and Alt+drag zoom, in either projection (down zooms in, as Plotly's) ──
            for (const how of ['middle', 'alt']) {
                const before = await readView();
                await page.mouse.move(c.x, c.y);
                if (how === 'alt') await page.keyboard.down('Alt');
                await page.mouse.down({ button: how === 'middle' ? 'middle' : 'left' });
                await page.mouse.move(c.x, c.y + 120, { steps: 10 });
                await page.mouse.up({ button: how === 'middle' ? 'middle' : 'left' });
                if (how === 'alt') await page.keyboard.up('Alt');
                await settled();
                v = await readView();
                const dirA = Math.hypot(before.eye.x - before.center.x, before.eye.y - before.center.y, before.eye.z - before.center.z);
                const dirB = Math.hypot(v.eye.x - v.center.x, v.eye.y - v.center.y, v.eye.z - v.center.z);
                const cos = ['x', 'y', 'z'].reduce((acc, k) => acc + (before.eye[k] - before.center[k]) * (v.eye[k] - v.center[k]), 0) / dirA / dirB;
                check(cos > 0.999, `${tag}: a ${how} drag does not orbit (cos = ${cos})`);
                check(zoomOf(v) > zoomOf(before) * 1.2, `${tag}: a ${how} drag downward zooms in (${zoomOf(before)} → ${zoomOf(v)})`);
                const layoutAspect = await page.evaluate(id => window.app.plotManager.plots.get(id).div.layout.scene.aspectratio, panelId);
                if (v.ortho) check(Math.abs(layoutAspect.x - v.aspect.x) < 1e-6, `${tag}: a ${how} zoom reaches the layout`);
            }

            // ── A quick double tap: the opening view, as on a 2D plot ──
            await page.evaluate(id => window.app.plotManager._autoScalePlot(id), panelId);
            await settled();
            await wheelZoomIn();
            for (let i = 0; i < 2; i++) {
                await touch('touchStart', [[c.x, c.y]]);
                await touch('touchEnd', []);
                await page.waitForTimeout(90);
            }
            await settled();
            v = await readView();
            check(sameView(v, home), `${tag}: a double tap goes back to the opening view\n  ${JSON.stringify(home)}\n  ${JSON.stringify(v)}`);

            // ── A view preset is a fresh view from that side, in either projection ──
            await wheelZoomIn();
            await page.evaluate(id => window.app.plotManager._setCamera(id, 'top'), panelId);
            await settled();
            const top1 = await readView();
            await page.evaluate(id => window.app.plotManager._autoScalePlot(id), panelId);
            await settled();
            await page.evaluate(id => window.app.plotManager._setCamera(id, 'top'), panelId);
            await settled();
            const top2 = await readView();
            check(sameView(top1, top2), `${tag}: the Top view does not depend on the zoom before it`);

            // ── A slow double tap, then a drag, pans: in the desktop layout too ──
            // One finger orbits and two zoom, so this is the only way a finger
            // moves the view; it used to exist only in the phone layout.
            await page.evaluate(id => window.app.plotManager._autoScalePlot(id), panelId);
            await settled();
            const beforePan = await readView();
            await touch('touchStart', [[c.x, c.y]]);
            await touch('touchEnd', []);
            await page.waitForTimeout(450);
            await touch('touchStart', [[c.x, c.y]]);
            for (let step = 1; step <= 8; step++) await touch('touchMove', [[c.x + step * 12, c.y + step * 6]]);
            await touch('touchEnd', []);
            await settled();
            v = await readView();
            const rel = (w) => ['x', 'y', 'z'].map(k => w.eye[k] - w.center[k]);
            const [r0, r1] = [rel(beforePan), rel(v)];
            const cosPan = r0.reduce((acc, value, i) => acc + value * r1[i], 0) / Math.hypot(...r0) / Math.hypot(...r1);
            const shift = Math.hypot(...['x', 'y', 'z'].map(k => v.center[k] - beforePan.center[k]));
            check(cosPan > 0.999, `${tag}: the drag after a slow double tap does not orbit (cos = ${cosPan})`);
            check(shift > 0.05, `${tag}: the drag after a slow double tap pans (centre moved ${shift})`);
            check(Math.abs(zoomOf(v) / zoomOf(beforePan) - 1) < 1e-3, `${tag}: the pan leaves the zoom alone`);

            if (view.mode !== 'state-anim') {
                // ── Ctrl+Z takes back a zoom in either projection ──
                await page.evaluate(id => window.app.plotManager._autoScalePlot(id), panelId);
                await settled();
                await wheelZoomIn();
                await settled();
                const undone = await page.evaluate(id => window.app.plotManager.undoView(id), panelId);
                check(undone, `${tag}: there is a zoom to undo`);
                await settled();
                v = await readView();
                check(sameView(v, home), `${tag}: Ctrl+Z takes the zoom back\n  ${JSON.stringify(home)}\n  ${JSON.stringify(v)}`);

                // ── A rebuild keeps the zoom (adding a trace, a live update, a theme change) ──
                await wheelZoomIn();
                const zoomed = await readView();
                await page.evaluate(id => {
                    const pm = window.app.plotManager;
                    pm._rebuildPanel(id, { restoreView: pm._capturePlotView(pm.plots.get(id)) });
                }, panelId);
                await page.waitForTimeout(1200);
                v = await readView();
                check(sameView(v, zoomed), `${tag}: a rebuild keeps the zoom\n  ${JSON.stringify(zoomed)}\n  ${JSON.stringify(v)}`);
            }
            console.log(`ok  ${tag}`);
        }
    }

    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(failures, [], `${failures.length} checks failed`);
    console.log('3D view gestures end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
