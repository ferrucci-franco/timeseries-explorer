// End-to-end check: the A|B cursor reads a curve drawn as stairs on the stairs.
//
// The drawing and the cursor each decided on their own whether a trace is a
// staircase. The drawing asks _variableDefaultsToStairs (booleans, and the
// time axis's sample index); the cursor only knew booleans. So on a sample
// index, drawn as stairs, the cursor dot floated on a linear chord between two
// steps (the index read 2475.4 halfway along a flat 2475).
//
// A datetime logger, one row every 2 s. The sample index is created the way the
// time-axis inspector does. Checks that
//   * the index is drawn as stairs, and the cursor dot sits on the step, not on
//     the chord, right after a sample and just before the next one;
//   * a measured variable drawn as a line is still read on the line;
//   * a trace switched to a straight line from the legend menu is read on the
//     line, and one switched to stairs is read on the stairs.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:cursor-stairs`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const BASE_MS = Date.UTC(2026, 5, 10, 9, 0, 0);
const STEP_S = 2;
const ROWS = 3000;
const valueAt = i => 14 + Math.sin(i / 40);

function pad(n) {
    return String(n).padStart(2, '0');
}

function stamp(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
        + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function loggerCsv() {
    const lines = ['Date Time,I'];
    for (let i = 0; i < ROWS; i++) lines.push(`${stamp(BASE_MS + i * STEP_S * 1000)},${valueAt(i).toFixed(6)}`);
    return { name: 'logger.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// Put cursor A at a time and read where its dot is, against the y the curve has
// there for a staircase and for a straight line.
async function dotAt(page, panelId, traceIdx, ms) {
    return page.evaluate(({ id, traceIdx, ms }) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const trace = plot.traces[traceIdx];
        plot.cursors.traceA = { fileId: trace.fileId, varName: trace.varName };
        plot.cursors.traceB = { fileId: trace.fileId, varName: trace.varName };
        plot.cursors.a = ms;
        pm._syncCursorDisplay(id, plot);
        const div = plot.div;
        const ya = div._fullLayout.yaxis;
        const dot = div.querySelector('.cursor-overlay-dot-a');
        const series = pm._traceInterpolationSeries(plot, trace);
        const px = y => ya._offset + ya.c2p(y);
        return {
            shape: div._fullData[traceIdx]?.line?.shape,
            dotTop: dot ? parseFloat(dot.style.top) : null,
            stepTop: px(pm._interpolateAt(series.times, series.values, ms, 'step')),
            lineTop: px(pm._interpolateAt(series.times, series.values, ms, 'linear')),
        };
    }, { id: panelId, traceIdx, ms });
}

function assertOn(r, which, label) {
    const other = which === 'step' ? 'lineTop' : 'stepTop';
    const want = which === 'step' ? 'stepTop' : 'lineTop';
    assert.notEqual(r.dotTop, null, `${label}: the dot is drawn`);
    assert.ok(Math.abs(r[want] - r[other]) > 3, `${label}: the test point tells stairs from a line`);
    assert.ok(Math.abs(r.dotTop - r[want]) <= 1,
        `${label}: dot at ${r.dotTop}px, ${which === 'step' ? 'the step' : 'the line'} is at ${r[want].toFixed(1)}px `
        + `(the ${which === 'step' ? 'chord' : 'step'} at ${r[other].toFixed(1)}px)`);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [loggerCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const { panelId, indexName } = await page.evaluate(() => {
        const app = window.app;
        const fileId = [...app.plotManager.files.keys()][0];
        app.setActiveFile(fileId);
        const variable = app._createOrUpdateTimeAxisVariable(fileId, 'index');
        const panelEl = document.querySelector('.layout-panel');
        app.plotManager.addTrace(panelEl.dataset.id, variable.name, panelEl);
        app.plotManager.addTrace(panelEl.dataset.id, 'I', panelEl);
        return { panelId: panelEl.dataset.id, indexName: variable.name };
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0
        && window.app.plotManager.plots.get(id).traces.length === 2, panelId);

    // Three samples on screen, as in the report.
    const s0 = BASE_MS + 1200 * STEP_S * 1000;
    await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }),
        { id: panelId, range: [stamp(s0 - 1000), stamp(s0 + 5000)] });
    await page.waitForTimeout(400);
    await page.locator(`.layout-panel[data-id="${panelId}"] .cursor-btn`).click();
    await page.waitForFunction(id => window.app.plotManager.plots.get(id).cursors?.enabled, panelId);
    await page.waitForTimeout(300);

    let r = await dotAt(page, panelId, 0, s0 + 1600);
    assert.equal(r.shape, 'hv', `${indexName} is drawn as stairs`);

    // Shown alone and zoomed on a few steps, the chord is far from the step
    // (next to the measured variable a unit step is under a pixel).
    await page.evaluate((id) => {
        const plot = window.app.plotManager.plots.get(id);
        plot.traces[1].visible = 'legendonly';
        return Plotly.restyle(plot.div, { visible: 'legendonly' }, [1]);
    }, panelId);
    await page.evaluate(({ id }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'yaxis.range': [1199.5, 1203.5] }), { id: panelId });
    await page.waitForTimeout(300);
    assertOn(await dotAt(page, panelId, 0, s0 + 1600), 'step', `${indexName}, late in a step`);
    assertOn(await dotAt(page, panelId, 0, s0 + 2000 + 400), 'step', `${indexName}, early in the next step`);

    // Legend menu: straight line wins over the variable's default, and back.
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        pm._setTimeseriesTraceLineShape(id, plot, plot.traces[0], 'linear');
    }, panelId);
    await page.waitForTimeout(500);
    r = await dotAt(page, panelId, 0, s0 + 1600);
    assert.equal(r.shape, 'linear', 'switched to a straight line from the legend');
    assertOn(r, 'linear', `${indexName} as a straight line`);

    // A measured variable is a line, and switched to stairs it is read on them.
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        plot.traces[0].visible = 'legendonly';
        plot.traces[1].visible = true;
        return Plotly.restyle(plot.div, { visible: ['legendonly', true] }, [0, 1]);
    }, panelId);
    await page.evaluate(({ id, lo, hi }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'yaxis.range': [lo, hi] }),
        { id: panelId, lo: valueAt(1201) - 0.02, hi: valueAt(1201) + 0.02 });
    await page.waitForTimeout(300);
    r = await dotAt(page, panelId, 1, s0 + 1600);
    assert.equal(r.shape, 'linear', 'the measured variable is a line');
    assertOn(r, 'linear', 'measured variable');
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        pm._setTimeseriesTraceLineShape(id, plot, plot.traces[1], 'hv');
    }, panelId);
    await page.waitForTimeout(500);
    await page.evaluate(({ id, lo, hi }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'yaxis.range': [lo, hi] }),
        { id: panelId, lo: valueAt(1201) - 0.02, hi: valueAt(1201) + 0.02 });
    await page.waitForTimeout(300);
    r = await dotAt(page, panelId, 1, s0 + 1600);
    assert.equal(r.shape, 'hv', 'switched to stairs from the legend');
    assertOn(r, 'step', 'measured variable as stairs');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Cursor stairs end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
