// End-to-end check of the 3D view: the Lines / Points / Lines+points display
// shared with 2D, and the two-finger pinch zoom (ui/plot-3d-gestures.js).
//
// Plotly's gl3d camera read a second finger as the first one jumping across
// the plot, so a pinch spun the scene. Here two fingers spread on the scene:
// the camera must not rotate, and the scene must zoom in.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:3d-display-pinch`.
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

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
    // A touch screen is greeted with a one-time hint that would cover the plot.
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
        const pm = app.plotManager;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...pm.files.keys()][0]);
        pm._setMode(panelEl.dataset.id, 'phase3d');
        pm.addTrace(panelEl.dataset.id, 'x', panelEl);
        pm.addTrace(panelEl.dataset.id, 'y', panelEl);
        pm.addTrace(panelEl.dataset.id, 'z', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => {
        const plot = window.app.plotManager.plots.get(id);
        return plot?.div?._fullLayout?.scene?._scene && plot.div.data?.some(t => t.type === 'scatter3d' && t.x?.length > 100);
    }, panelId, { timeout: 30000 });
    await page.waitForTimeout(800);

    // ── Display: the View menu offers the 2D display in 3D and restyles the traces ──
    const panelSel = `.layout-panel[data-id="${panelId}"]`;
    const openView = async () => {
        if (!(await page.locator(`.panel-view-menu[data-panel-id="${panelId}"]`).count())) {
            await page.locator(`${panelSel} .panel-view-btn`).click();
        }
    };
    const viewMenu = page.locator(`.panel-view-menu[data-panel-id="${panelId}"]`);
    await openView();
    assert.equal(await viewMenu.locator('.marks-display-markers').count(), 1, 'the 3D View menu offers Lines / Points / Lines+points');
    await viewMenu.locator('.marks-display-markers').click();
    await page.waitForTimeout(400);
    const dataTrace = () => page.evaluate(id => {
        const t = window.app.plotManager.plots.get(id).div.data.find(d => d.type === 'scatter3d' && !String(d.name).startsWith('__'));
        return { mode: t.mode, size: t.marker?.size, opacity: t.marker?.opacity };
    }, panelId);
    let trace = await dataTrace();
    assert.equal(trace.mode, 'markers', 'Points: markers only');
    assert.equal(trace.size, 4);
    await openView();
    const sizeInput = viewMenu.locator('.marks-item-marker-size input');
    await sizeInput.fill('7');
    await sizeInput.press('Enter');
    await page.waitForTimeout(300);
    trace = await dataTrace();
    assert.equal(trace.size, 7, 'the marker size reaches the 3D trace');
    const axisHelpers = await page.evaluate(id => window.app.plotManager.plots.get(id).div.data
        .filter(d => d.name === '__axis__').map(d => d.mode), panelId);
    assert.ok(axisHelpers.every(m => m === 'lines'), 'the origin axes stay lines');
    await openView();
    await viewMenu.locator('.marks-display-lines\\+markers').click();
    await page.waitForTimeout(300);
    assert.equal((await dataTrace()).mode, 'lines+markers', 'Lines+points');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (shots) await page.screenshot({ path: `${shots}/3d-lines-points.png` });

    // ── Pinch: two fingers spread on the scene ──
    const box = await page.evaluate(id => {
        const r = window.app.plotManager.plots.get(id).div._fullLayout.scene._scene.container.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }, panelId);
    const readView = () => page.evaluate(id => {
        const scene = window.app.plotManager.plots.get(id).div._fullLayout.scene._scene;
        const cam = scene.getCamera();
        return { eye: cam.eye, aspect: scene.glplot.getAspectratio(), ortho: !!scene.camera._ortho };
    }, panelId);
    const before = await readView();
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: i })),
    });
    // First finger lands alone (Plotly starts its orbit), then the second.
    await touch('touchStart', [[box.cx - 40, box.cy]]);
    await touch('touchStart', [[box.cx - 40, box.cy], [box.cx + 40, box.cy + 5]]);
    for (let step = 1; step <= 10; step++) {
        const d = 40 + step * 12;
        // Uneven moves, one finger at a time: what made the scene spin.
        await touch('touchMove', [[box.cx - d, box.cy], [box.cx + d - 6, box.cy + 5]]);
        await touch('touchMove', [[box.cx - d, box.cy], [box.cx + d, box.cy + 5]]);
    }
    await touch('touchEnd', [[box.cx + 160, box.cy + 5]]);
    // The remaining finger drifts before lifting: it must not rotate either.
    await touch('touchMove', [[box.cx + 190, box.cy + 40]]);
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
    const after = await readView();

    const dir = (e) => { const n = Math.hypot(e.x, e.y, e.z); return [e.x / n, e.y / n, e.z / n]; };
    const [a, b] = [dir(before.eye), dir(after.eye)];
    const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(cos > 0.999, `the camera did not rotate (cos = ${cos})`);
    if (after.ortho) {
        assert.ok(after.aspect.x > before.aspect.x * 1.5, `orthographic: the scene zoomed in (${before.aspect.x} → ${after.aspect.x})`);
    } else {
        assert.ok(Math.hypot(after.eye.x, after.eye.y, after.eye.z) < Math.hypot(before.eye.x, before.eye.y, before.eye.z) / 1.5, 'perspective: the camera moved closer');
    }
    const layoutAspect = await page.evaluate(id => window.app.plotManager.plots.get(id).div.layout.scene.aspectratio, panelId);
    if (after.ortho) assert.ok(Math.abs(layoutAspect.x - after.aspect.x) < 1e-9, 'the layout is brought in step after the gesture');

    // ── Wheel: proportional, many small ctrl-wheel events (a trackpad pinch) ──
    const beforeWheel = await readView();
    await page.mouse.move(box.cx, box.cy);
    await page.keyboard.down('Control');
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -2);
    await page.keyboard.up('Control');
    await page.waitForTimeout(400);
    const afterWheel = await readView();
    const ratio = afterWheel.ortho ? afterWheel.aspect.x / beforeWheel.aspect.x : 1;
    // 20 events × 2 px × 0.01 → e^0.4 ≈ 1.49, where a fixed 10 % step each was 6.7×.
    if (afterWheel.ortho) assert.ok(ratio > 1.2 && ratio < 2, `a trackpad pinch zooms smoothly (×${ratio.toFixed(2)})`);
    if (shots) await page.screenshot({ path: `${shots}/3d-after-pinch.png` });

    // ── Perspective: the same pinch moves the camera closer ──
    await page.evaluate(id => window.app.plotManager._toggleProjection(id, document.querySelector(`.layout-panel[data-id="${id}"]`)), panelId);
    await page.waitForFunction(id => !window.app.plotManager.plots.get(id).div._fullLayout.scene._scene.camera._ortho, panelId);
    await page.waitForTimeout(500);
    const beforePersp = await readView();
    await touch('touchStart', [[box.cx - 40, box.cy], [box.cx + 40, box.cy]]);
    for (let step = 1; step <= 8; step++) {
        const d = 40 + step * 15;
        await touch('touchMove', [[box.cx - d, box.cy], [box.cx + d, box.cy]]);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
    const afterPersp = await readView();
    const dist = (v) => Math.hypot(v.eye.x, v.eye.y, v.eye.z);
    const cosP = dir(beforePersp.eye).reduce((acc, c, i) => acc + c * dir(afterPersp.eye)[i], 0);
    assert.ok(cosP > 0.999, `perspective: no rotation (cos = ${cosP})`);
    assert.ok(dist(afterPersp) < dist(beforePersp) / 1.5, `perspective: the camera moved closer (${dist(beforePersp).toFixed(2)} → ${dist(afterPersp).toFixed(2)})`);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('3D display and pinch end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
