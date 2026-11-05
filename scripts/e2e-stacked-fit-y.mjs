// End-to-end check of the vertical fit of a STACKED time panel holding traces
// from TWO files, in a real browser.
//
// Two files almost never share a sampling grid, and a stacked panel draws the
// sum of its traces interpolated onto the union of their grids (Plotly
// `stackgroup` + `stackgaps: 'interpolate'`). The unit tests judge the extent
// arithmetic (test:stacked-y-extent); this checks the whole path in the app —
// double-click Autoscale and the Fit-Y button — against Plotly's own autorange
// over the stack it drew, which is the only honest oracle for "what is on
// screen".
//
// Scenario: coarse.csv (5 rows, 1 s apart) and fine.csv (1001 rows, 4 ms
// apart) both run from 0 to 4 s, both flat at 0 but for a 100 at t = 4 s. The
// drawn stack therefore reaches 200 at its right edge. Before the time-aware
// extent, pairing the two files by array position put the coarse peak next to
// a sample at t = 16 ms and the fit stopped at ~105.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:stacked-fit-y`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PEAK = 100;
const STACK_TOP = 2 * PEAK;

function csv(name, rows, step) {
    const lines = ['time,signal'];
    for (let i = 0; i < rows; i++) {
        const t = i * step;
        lines.push(`${t.toFixed(3)},${i === rows - 1 ? PEAK : 0}`);
    }
    return { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const yRangeOf = (page, panelId) => page.evaluate((id) => {
    const plot = window.app.plotManager.plots.get(id);
    const axis = plot.div?._fullLayout?.yaxis;
    return {
        range: axis?.range ? Array.from(axis.range).map(Number) : null,
        stacked: !!plot.timeseriesStacked,
        traces: plot.div?.data?.length ?? 0,
        stackgroups: (plot.div?.data || []).map(trace => trace.stackgroup),
    };
}, panelId);

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.STACKED_FIT_Y_SHOTS;
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));

    // Two files, two grids over the same 0 … 4 s.
    await page.setInputFiles('#file-input', [csv('coarse.csv', 5, 1), csv('fine.csv', 1001, 0.004)]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 2, null, { timeout: 60000 });

    // One panel, one trace from each file.
    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        const ids = [...app.plotManager.files.keys()];
        for (const fileId of ids) {
            app.setActiveFile(fileId);
            app.plotManager.addTrace(panelEl.dataset.id, 'signal', panelEl);
        }
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(400);

    let state = await yRangeOf(page, panelId);
    assert.equal(state.traces, 2, 'the panel holds one trace from each file');
    assert.equal(state.stacked, false, 'it starts unstacked');
    assert.ok(state.range[1] >= PEAK && state.range[1] < 1.5 * PEAK,
        `unstacked, the fit stops at the taller signal (${state.range[1]})`);

    // ── Stacked ──
    await page.locator(`.layout-panel[data-id="${panelId}"] .panel-view-btn`).click();
    await page.locator(`.panel-view-menu[data-panel-id="${panelId}"] .marks-item-stack`).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);

    state = await yRangeOf(page, panelId);
    assert.equal(state.stacked, true, 'the panel is stacked');
    assert.deepEqual(state.stackgroups, ['timeseries-stack', 'timeseries-stack'],
        'both traces are in the stack group, so Plotly draws their sum');

    // Plotly's own autorange over the stack it drew: the oracle for how high
    // the filled area actually goes.
    const plotlyTop = await page.evaluate(async (id) => {
        const div = window.app.plotManager.plots.get(id).div;
        await Plotly.relayout(div, { 'yaxis.autorange': true });
        return Number(div._fullLayout.yaxis.range[1]);
    }, panelId);
    assert.ok(plotlyTop >= STACK_TOP,
        `Plotly draws the stack up to ${STACK_TOP} (its autorange tops out at ${plotlyTop})`);

    // Autoscale (what a double-click runs).
    await page.evaluate(id => window.app.plotManager._autoScalePlot(id), panelId);
    await page.waitForTimeout(500);
    state = await yRangeOf(page, panelId);
    assert.ok(state.range[1] >= STACK_TOP,
        `Autoscale clears the top of the drawn stack (${state.range[1]} ≥ ${STACK_TOP})`);
    assert.ok(state.range[1] <= plotlyTop * 1.1,
        `without overshooting Plotly's own autorange (${state.range[1]} vs ${plotlyTop})`);
    if (shots) await page.screenshot({ path: `${shots}/stacked-two-files-autoscale.png` });

    // Fit Y, on the whole record and then on a window around the peak.
    await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'yaxis.range': [0, 1] }), panelId);
    await page.evaluate(id => window.app.plotManager._autoScalePlotAxis(id, undefined, 'y'), panelId);
    await page.waitForTimeout(500);
    state = await yRangeOf(page, panelId);
    assert.ok(state.range[1] >= STACK_TOP, `Fit Y clears it too (${state.range[1]})`);

    await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [3.5, 4], 'yaxis.range': [0, 1] }), panelId);
    await page.evaluate(id => window.app.plotManager._autoScalePlotAxis(id, undefined, 'y'), panelId);
    await page.waitForTimeout(500);
    state = await yRangeOf(page, panelId);
    assert.ok(state.range[1] >= STACK_TOP, `Fit Y in a window around the peak clears it (${state.range[1]})`);

    // A window that cuts the peak off halfway up the coarse file's last
    // segment: that file ramps 0 → 100 between t = 3 s and t = 4 s, so at the
    // window's right edge the stack stands at 50 — which is on screen, even
    // though neither file samples there.
    await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [0, 3.5] }), panelId);
    await page.evaluate(id => window.app.plotManager._autoScalePlotAxis(id, undefined, 'y'), panelId);
    await page.waitForTimeout(500);
    state = await yRangeOf(page, panelId);
    assert.ok(state.range[1] >= PEAK / 2 && state.range[1] < 0.6 * PEAK,
        `a window cutting the ramp fits the stack it shows there (${state.range[1]})`);
    if (shots) await page.screenshot({ path: `${shots}/stacked-two-files-window.png` });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Stacked Fit-Y (two files) end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
