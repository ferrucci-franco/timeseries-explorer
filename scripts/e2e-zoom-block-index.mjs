// End-to-end check of the block min/max index (src/compute/kernels/block-index.js)
// in the real app: on a long signal held in memory, the curve Plotly draws
// after each zoom or pan, and the range an autoscale or a Fit Y sets, are the
// very ones the plain scans give.
//
// Scenario: 400 000 rows of two signals, loaded in memory — a sine with
// spikes, NaN cells and a flat stretch, and its quantized copy (ties
// everywhere). The panel is zoomed out, to 60 %, panned, zoomed to 5 % (where
// buckets are too narrow for the index and the scan runs) and back, at the
// default 2 000-point budget and at 500 points (wide buckets: the index); after
// each step every drawn trace is compared, point for point, with
// `visualPairForRange(..., { blockIndex: false })` run in the page on the
// same arrays (their finite points: the NaN the app inserts to break the line
// across a NaN run draws nothing). Then Fit Y on a window and the autoscale are compared with the
// extents the scan gives.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:zoom-block-index`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 400_000;
function makeCsv() {
    let state = 7;
    const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    const lines = ['time,wave,steps'];
    for (let i = 0; i < ROWS; i++) {
        const t = i / 1000;
        let v = Math.sin(t * 0.7) * 3 + Math.sin(t * 31) * 0.4 + (rand() - 0.5) * 0.2;
        if (i % 9973 === 0) v += (rand() < 0.5 ? -1 : 1) * 25;   // spikes: the extremes
        if (i >= 150_000 && i < 170_000) v = 1.25;                 // flat: every sample a tie
        const nan = (i % 4999 === 17) || (i >= 250_000 && i < 252_000);
        const wave = nan ? 'NaN' : v.toFixed(5);
        const steps = nan ? 'NaN' : (Math.round(v * 2) / 2).toFixed(1);
        lines.push(`${t.toFixed(3)},${wave},${steps}`);
    }
    return { name: 'long-signal.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

try {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 180000 });
    const panelId = await page.evaluate(() => {
        const pm = window.app.plotManager;
        const [fileId, entry] = [...pm.files.entries()][0];
        if (entry.data._duckdb) throw new Error('the file was opened in memory-saving mode; this check is of a file in memory');
        window.app.setActiveFile(fileId);
        const panelEl = document.querySelector('.layout-panel');
        pm.addTrace(panelEl.dataset.id, 'wave', panelEl);
        pm.addTrace(panelEl.dataset.id, 'steps', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?.data?.length >= 2, panelId, { timeout: 60000 });

    // The index is built while the page is idle; until then every query
    // scans. Wait for it, so that what follows is drawn through it.
    await page.evaluate(async () => { window.__blockIndex = await import('/src/compute/kernels/block-index.js'); });
    await page.waitForFunction((id) => {
        const pm = window.app.plotManager;
        return pm.plots.get(id).traces.every(t => !!window.__blockIndex.blockIndexFor(pm._getTransformedVariableData(t.fileId, t.varName)));
    }, panelId, { timeout: 60000, polling: 200 });

    // What is drawn, against the plain scan over the same arrays.
    const compare = (range) => page.evaluate(async ([id, range]) => {
        const { visualPairForRange, blockIndexFor } = await import('/src/compute/kernels/resample.js');
        const { BLOCK_BUCKET_MIN } = await import('/src/compute/kernels/block-index.js');
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        if (range) await Plotly.relayout(plot.div, { 'xaxis.range': range });
        await new Promise(resolve => setTimeout(resolve, 300));
        const view = plot.div._fullLayout.xaxis.range.map(Number);
        const out = [];
        plot.traces.forEach((trace, k) => {
            const x = pm._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
            const y = pm._getTransformedVariableData(trace.fileId, trace.varName);
            const start = Math.max(0, pm._lowerBound(x, Math.min(...view)) - 1);
            const end = Math.min(x.length, pm._upperBound(x, Math.max(...view)) + 1);
            const want = visualPairForRange(x, y, start, end, pm.timeseriesVisualMaxPoints, { blockIndex: false });
            // The app inserts a NaN point after a sample to break the line
            // across a NaN run (_applyLineBreaks); a NaN draws nothing, so the
            // curve is its finite points: those are compared, in order.
            const finite = (xs, ys) => {
                const out = [];
                for (let i = 0; i < ys.length; i++) if (Number.isFinite(ys[i])) out.push([xs[i], ys[i]]);
                return out;
            };
            const drawn = finite(plot.div.data[k].x, plot.div.data[k].y);
            const wanted = finite(want.x, want.y);
            let mismatch = null;
            const length = drawn.length;
            if (length !== wanted.length) mismatch = `finite points ${length} vs ${wanted.length}`;
            for (let i = 0; !mismatch && i < length; i++) {
                if (drawn[i][0] !== wanted[i][0] || !Object.is(drawn[i][1], wanted[i][1])) {
                    mismatch = `point ${i}: (${drawn[i]}) vs (${wanted[i]})`;
                }
            }
            const target = pm.timeseriesVisualMaxPoints;
            const bucket = Math.ceil((end - start - 2) / Math.max(1, Math.floor((target - 2) / 2)));
            out.push({
                name: trace.varName, points: length, visible: end - start, mismatch,
                indexed: !!blockIndexFor(y),
                // Whether this view's buckets are wide enough to be read through it.
                throughIndex: end - start > target && bucket >= BLOCK_BUCKET_MIN,
            });
        });
        return out;
    }, [panelId, range]);

    const steps = [
        ['zoomed out', null],
        ['60 % visible', [40, 280]],
        ['panned', [110, 350]],
        ['5 % visible', [200, 220]],
        ['back out', [0, ROWS / 1000]],
    ];
    // The default 2 000-point budget leaves buckets of ~400 samples here,
    // which are scanned; at 500 points (Settings → downsampling) they are
    // ~1 600 wide and read through the index. Both must draw the scan's curve.
    for (const limit of [2000, 500]) {
        await page.evaluate(([id, limit]) => window.app.plotManager.setTimeseriesDownsamplingLimit(limit), [panelId, limit]);
        let throughIndex = 0;
        for (const [label, range] of steps) {
            const traces = await compare(range);
            for (const t of traces) {
                assert.equal(t.mismatch, null, `${limit} points, ${label}, ${t.name}: the drawn curve is the scan's (${t.mismatch})`);
                assert.equal(t.indexed, true, `${label}, ${t.name}: a long signal in memory is indexed`);
                if (t.throughIndex) throughIndex++;
            }
            console.log(`  ${limit} points, ${label}: ${traces.map(t => `${t.name} ${t.points} of ${t.visible}${t.throughIndex ? ' (indexed)' : ''}`).join(', ')} — identical`);
        }
        if (limit === 500) assert.ok(throughIndex >= 4, `at 500 points the wide views went through the index (${throughIndex})`);
    }
    await page.evaluate(id => window.app.plotManager.setTimeseriesDownsamplingLimit(2000), panelId);

    // Fit Y on a window, and the autoscale: the scan's extents.
    const fit = await page.evaluate(async (id) => {
        const { scanFiniteExtent } = await import('/src/utils/finite-extent.js');
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const series = plot.traces.map(t => ({
            x: pm._getTransformedTimeDataForVariable(t.fileId, t.varName),
            y: pm._getTransformedVariableData(t.fileId, t.varName),
        }));
        const scanWindow = (lo, hi) => {
            let min = Infinity;
            let max = -Infinity;
            for (const s of series) {
                for (let i = 0; i < s.x.length; i++) {
                    if (s.x[i] < lo || s.x[i] > hi || !Number.isFinite(s.y[i])) continue;
                    if (s.y[i] < min) min = s.y[i];
                    if (s.y[i] > max) max = s.y[i];
                }
            }
            return { min, max };
        };
        await Plotly.relayout(plot.div, { 'xaxis.range': [123.4567, 189.0123] });
        const fitY = pm._autoScaleAxisUpdate(plot, 'y')['yaxis.range'];
        const wantFit = pm._padRange(scanWindow(123.4567, 189.0123).min, scanWindow(123.4567, 189.0123).max);
        await pm._autoScalePlot(id, plot);
        const auto = plot.div._fullLayout.yaxis.range;
        const whole = series.map(s => scanFiniteExtent(s.y));
        const wantAuto = pm._padRange(Math.min(...whole.map(e => e.min)), Math.max(...whole.map(e => e.max)));
        return { fitY, wantFit, auto, wantAuto };
    }, panelId);
    assert.deepEqual(fit.fitY, fit.wantFit, 'Fit Y on a window sets the range the scan gives');
    assert.deepEqual(fit.auto, fit.wantAuto, 'the autoscale sets the range the scan gives');
    console.log(`  Fit Y [${fit.fitY.map(v => v.toFixed(4))}], autoscale [${fit.auto.map(v => v.toFixed(4))}] — the scan's`);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('zoom block index e2e: passed');
} finally {
    await browser.close();
    await server.close();
}
