// End-to-end check of Ctrl+Z (back to the previous zoom/pan view) in the
// modes with two charts: Fourier, Histogram, Heatmap, Profile, Integral,
// Correlation, and the 2D curve fit's time pane. Real browser, real mouse.
//
// In each mode: a box zoom on the result chart, then one on the time pane,
// are two steps. The first Ctrl+Z puts the time pane back, the second the
// result chart — back to autorange where it was on autorange.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:view-undo-modes`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Hourly for 60 days: calendar time, so Heatmap and Profile have days to show.
function makeCsv() {
    const lines = ['time,load,temp'];
    const t0 = Date.UTC(2024, 0, 1);
    for (let i = 0; i < 24 * 60; i++) {
        const iso = new Date(t0 + i * 3600e3).toISOString().replace('.000Z', 'Z');
        const h = i % 24;
        const load = 50 + 30 * Math.sin(2 * Math.PI * h / 24) + 5 * Math.sin(i / 17);
        const temp = 10 + 8 * Math.sin(2 * Math.PI * (h - 3) / 24) + 0.05 * i / 24;
        lines.push(`${iso},${load.toFixed(4)},${temp.toFixed(4)}`);
    }
    return { name: 'hourly.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const SETTLE = 900;   // the history records a step once relayouts settle (350 ms)

// The view of one chart, the way the history compares it: ranges of the
// axes not on autorange.
const viewOf = (page, id, divKey) => page.evaluate(({ id, divKey }) => {
    const div = window.app.plotManager.plots.get(id)?.[divKey];
    const fl = div?._fullLayout;
    if (!fl) return null;
    const out = {};
    for (const name of Object.keys(fl).filter(k => /^[xy]axis\d*$/.test(k)).sort()) {
        const axis = fl[name];
        out[name] = axis.autorange === false || axis.autorange === undefined
            ? Array.from(axis.range).map(v => (typeof v === 'string' ? Date.parse(v.replace(' ', 'T') + (v.length <= 19 ? 'Z' : '')) : Number(v)))
            : `auto:${axis.autorange}`;
    }
    return out;
}, { id, divKey });

const sameView = (a, b) => {
    if (!a || !b) return false;
    const keys = Object.keys(b);
    return keys.every(k => {
        const x = a[k];
        const y = b[k];
        if (typeof y === 'string' || typeof x === 'string') return x === y;
        return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= 1e-6 * Math.max(1, Math.abs(y[i])));
    });
};

async function boxZoom(page, id, divKey) {
    const handle = await page.evaluateHandle(({ id, divKey }) =>
        window.app.plotManager.plots.get(id)[divKey].querySelector('.nsewdrag'), { id, divKey });
    const box = await handle.asElement().boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    await page.mouse.move(...at(0.35, 0.3));
    await page.mouse.down();
    await page.mouse.move(...at(0.5, 0.5), { steps: 6 });
    await page.mouse.move(...at(0.65, 0.7), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE);
}

async function undo(page, id, divKey) {
    const handle = await page.evaluateHandle(({ id, divKey }) =>
        window.app.plotManager.plots.get(id)[divKey], { id, divKey });
    const box = await handle.asElement().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 4);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(SETTLE);
}

async function checkTwoPanes(page, id, mode, secondKey, timeKey = 'div') {
    await page.waitForTimeout(1500);
    const second0 = await viewOf(page, id, secondKey);
    const time0 = await viewOf(page, id, timeKey);
    assert.ok(second0 && time0, `${mode}: both panes drawn`);

    await boxZoom(page, id, secondKey);
    const second1 = await viewOf(page, id, secondKey);
    assert.ok(!sameView(second1, second0), `${mode}: the result chart zoomed (${JSON.stringify(second1)})`);

    await boxZoom(page, id, timeKey);
    const time1 = await viewOf(page, id, timeKey);
    assert.ok(!sameView(time1, time0), `${mode}: the time pane zoomed`);

    const lastView = await page.evaluate(id => {
        const pm = window.app.plotManager;
        return pm._viewMenuModel(id, pm.plots.get(id)).find(item => item.key === 'lastview');
    }, id);
    assert.ok(lastView && !lastView.disabled, `${mode}: Last view is in the View menu, enabled`);

    await undo(page, id, timeKey);
    assert.ok(sameView(await viewOf(page, id, timeKey), time0), `${mode}: the first Ctrl+Z puts the time pane back`);
    assert.ok(sameView(await viewOf(page, id, secondKey), second1), `${mode}: and leaves the result chart zoomed`);

    await undo(page, id, secondKey);
    const second2 = await viewOf(page, id, secondKey);
    assert.ok(sameView(second2, second0), `${mode}: the second Ctrl+Z puts the result chart back (${JSON.stringify(second2)} vs ${JSON.stringify(second0)})`);
    console.log(`  ${mode}: ok`);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const id = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'load', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, id);
    // Let the chart's first resize pass run before the mode changes under it.
    await page.waitForTimeout(1000);

    for (const [mode, secondKey] of [
        ['fft', 'fftDiv'],
        ['histogram', 'histogramDiv'],
        ['heatmap', 'heatmapDiv'],
        ['temporal-profile', 'temporalProfileDiv'],
        ['integral', 'integralDiv'],
    ]) {
        await page.evaluate(({ id, mode }) => window.app.plotManager._requestModeChange(id, mode), { id, mode });
        await page.waitForFunction(({ id, secondKey }) => window.app.plotManager.plots.get(id)?.[secondKey]?._fullLayout?.xaxis?._length > 0
            && window.app.plotManager.plots.get(id)[secondKey].querySelector('.nsewdrag'), { id, secondKey }, { timeout: 30000 });
        await checkTwoPanes(page, id, mode, secondKey);
    }

    // ── Correlation (from 2D) ──
    await page.evaluate(id => window.app.plotManager._setMode(id, 'phase2d'), id);
    await page.waitForTimeout(500);
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
        pm.addTrace(id, 'load', panelEl);
        pm.addTrace(id, 'temp', panelEl);
    }, id);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phaseTraces?.length > 0, id, { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.evaluate(id => window.app.plotManager._toggleCorrelationMode(id), id);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.correlationDiv?._fullLayout?.xaxis?._length > 0, id, { timeout: 30000 });
    const corrTime0 = await viewOf(page, id, 'div');
    await page.waitForTimeout(1500);
    await boxZoom(page, id, 'div');
    assert.ok(!sameView(await viewOf(page, id, 'div'), corrTime0), 'correlation: the time pane zoomed');
    await undo(page, id, 'div');
    assert.ok(sameView(await viewOf(page, id, 'div'), corrTime0), 'correlation: Ctrl+Z puts the time pane back');
    console.log('  correlation: ok');

    // ── 2D curve fit: its time pane beside the 2D chart ──
    await page.evaluate(id => window.app.plotManager._toggleCorrelationMode(id), id);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'phase2d'
        && window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, id, { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.evaluate(id => window.app.plotManager._togglePhase2dFit(id), id);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phase2dFitTimeDiv?._fullLayout?.xaxis?._length > 0
        && window.app.plotManager.plots.get(id).phase2dFitTimeDiv.querySelector('.nsewdrag'), id, { timeout: 30000 });
    // The time pane starts hidden when the panel is short; show it.
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        if (pm._ensurePhase2dState(pm.plots.get(id)).timeSeriesHidden) pm._togglePhase2dFitTimeSeries(id);
    }, id);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id).phase2dFitTimeDiv.getBoundingClientRect().height > 100, id);
    await checkTwoPanes(page, id, 'phase2d fit', 'div', 'phase2dFitTimeDiv');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('View undo in every mode: end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
