// End-to-end check of the log scales in the View menu, in a real browser.
// The unit tests judge the range arithmetic; this checks that Plotly is
// actually handed log axes, with ranges in log10, and that the panel says how
// many values a log axis cannot draw.
//
// Scenario: one CSV with a decaying positive signal (1000·e^-t) and a sine
// that goes negative. Time series: log Y fits the decay in decades, adding
// the sine brings the "values ≤ 0" notice, log Y off removes it. 2D (a ramp
// from 0 against the decay): log X and log Y. Fourier: log frequency. Histogram: log counts.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:log-axes`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 2000;

function makeCsv() {
    const lines = ['time,decay,wave,ramp'];
    for (let i = 0; i < ROWS; i++) {
        const t = i / 200;                                  // 0 … 10 s
        // ramp is the time again, as a variable: 0 at the first row.
        lines.push(`${t.toFixed(3)},${(1000 * Math.exp(-t)).toPrecision(8)},${Math.sin(2 * Math.PI * 2 * t).toFixed(6)},${t.toFixed(3)}`);
    }
    return { name: 'decay.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

async function toggleView(page, panelId, key) {
    await page.locator(`.layout-panel[data-id="${panelId}"] .panel-view-btn`).click();
    await page.locator(`.panel-view-menu[data-panel-id="${panelId}"] .marks-item-${key}`).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
}

const axisOf = (page, panelId, divKey, axisKey) => page.evaluate(({ id, divKey, axisKey }) => {
    const plot = window.app.plotManager.plots.get(id);
    const axis = plot[divKey]?._fullLayout?.[axisKey];
    const notice = plot.div?.closest('.layout-panel')?.querySelector('.log-axis-notice');
    return {
        type: axis?.type,
        range: axis?.range ? Array.from(axis.range).map(Number) : null,
        notice: notice ? notice.textContent : null,
        viewLabel: plot.div?.closest('.layout-panel')?.querySelector('.panel-view-btn')?.textContent,
    };
}, { id: panelId, divKey, axisKey });

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.LOG_AXES_SHOTS;
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'decay', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(300);

    // ── Time series: log Y ──
    let s = await axisOf(page, panelId, 'div', 'yaxis');
    assert.equal(s.type, 'linear', 'the Y axis starts linear');
    await toggleView(page, panelId, 'ylog');
    s = await axisOf(page, panelId, 'div', 'yaxis');
    assert.equal(s.type, 'log', 'log Y: Plotly draws a log axis');
    // 1000·e^-10 ≈ 0.045 … 1000: about -1.3 … 3 decades, padded.
    assert.ok(s.range[0] < -1.3 && s.range[0] > -1.6, `the range starts near log10(0.045) (${s.range[0]})`);
    assert.ok(s.range[1] > 3 && s.range[1] < 3.3, `and ends near log10(1000) (${s.range[1]})`);
    assert.equal(s.notice, null, 'every value is positive: no notice');
    assert.equal(s.viewLabel, 'View (1) ▾', 'the View button counts log Y');

    // Zoomed: Fit Y fits the window, still in decades.
    await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [0, 2] }), panelId);
    await page.evaluate(id => window.app.plotManager._autoScalePlotAxis(id, undefined, 'y'), panelId);
    await page.waitForTimeout(400);
    s = await axisOf(page, panelId, 'div', 'yaxis');
    // 1000·e^-2 ≈ 135 → log10 ≈ 2.13
    assert.ok(s.range[0] > 2 && s.range[0] < 2.2, `Fit Y on [0, 2] s starts near log10(135) (${s.range[0]})`);

    // A signal that goes negative on the same axis: the notice counts it.
    await page.evaluate(id => {
        const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager.addTrace(id, 'wave', panelEl);
    }, panelId);
    await page.waitForTimeout(700);
    s = await axisOf(page, panelId, 'div', 'yaxis');
    assert.equal(s.type, 'log', 'adding a trace keeps the log axis');
    assert.match(s.notice || '', /≤ 0/, `the notice says values ≤ 0 are not shown (${s.notice})`);
    if (shots) await page.screenshot({ path: `${shots}/log-y-timeseries.png` });

    await toggleView(page, panelId, 'ylog');
    s = await axisOf(page, panelId, 'div', 'yaxis');
    assert.equal(s.type, 'linear', 'log Y off: linear again');
    assert.ok(s.range[0] < 0, 'and the fit takes the negative half of the sine back in');
    assert.equal(s.notice, null, 'the notice goes with the log axis');

    // ── Fourier: log frequency ──
    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'fft'), panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.fftDiv?._fullLayout?.xaxis?._length > 0, panelId, { timeout: 30000 });
    await page.waitForTimeout(800);
    s = await axisOf(page, panelId, 'fftDiv', 'xaxis');
    assert.equal(s.type, 'linear', 'the frequency axis starts linear');
    await toggleView(page, panelId, 'freqlog');
    await page.waitForTimeout(800);
    s = await axisOf(page, panelId, 'fftDiv', 'xaxis');
    assert.equal(s.type, 'log', 'log frequency: a log axis');
    // 2000 samples at 200 Hz: bins from 0.1 Hz to 100 Hz → -1 … 2 decades.
    assert.ok(s.range.every(Number.isFinite), 'with a finite range (DC left out)');
    assert.ok(s.range[0] >= -1.5 && s.range[0] <= -0.5, `starting at the first bin above DC (${s.range[0]})`);
    assert.ok(s.range[1] > 1.8 && s.range[1] < 2.2, `ending near 100 Hz (${s.range[1]})`);
    if (shots) await page.screenshot({ path: `${shots}/log-frequency.png` });

    // ── Histogram: log counts ──
    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'histogram'), panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.histogramDiv?._fullLayout?.yaxis?._length > 0, panelId, { timeout: 30000 });
    await page.waitForTimeout(800);
    await toggleView(page, panelId, 'countlog');
    s = await axisOf(page, panelId, 'histogramDiv', 'yaxis');
    assert.equal(s.type, 'log', 'log counts: a log axis');

    // ── 2D: log X and log Y ──
    await page.evaluate(id => window.app.plotManager._setMode(id, 'phase2d'), panelId);
    await page.waitForTimeout(500);
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
        pm.addTrace(id, 'ramp', panelEl);
        pm.addTrace(id, 'decay', panelEl);
    }, panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0
        && window.app.plotManager.plots.get(id).phaseTraces.length > 0, panelId, { timeout: 30000 });
    await page.waitForTimeout(500);
    await toggleView(page, panelId, 'ylog');
    s = await axisOf(page, panelId, 'div', 'yaxis');
    assert.equal(s.type, 'log', '2D log Y');
    assert.ok(s.range[1] > 3 && s.range[1] < 3.3, `in decades (${s.range[1]})`);
    let x = await axisOf(page, panelId, 'div', 'xaxis');
    assert.equal(x.type, 'linear', 'X stays linear');
    await toggleView(page, panelId, 'xlog');
    x = await axisOf(page, panelId, 'div', 'xaxis');
    assert.equal(x.type, 'log', '2D log X');
    // ramp = 0 at the first row cannot sit on a log axis: one point hidden.
    assert.match(x.notice || '', /^1 value /, `the ramp = 0 row is counted, in the singular (${x.notice})`);
    if (shots) await page.screenshot({ path: `${shots}/log-2d.png` });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Log axes end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
