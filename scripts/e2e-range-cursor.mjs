// End-to-end check of the pointer over a time-range selection, in every
// analysis that has one: FFT, Histogram, Calendar heatmap, Temporal profile,
// Integral, Correlation, the 2D Curve Fit and the time-series Curve fit.
//
// Plotly pins its own crosshair on the drag layer, so each mode's selection
// handler sets a class on its time pane and the stylesheet has to override that
// crosshair for that pane by name. A pane missing from the stylesheet keeps the
// crosshair — the edge can still be dragged, but nothing tells the user so,
// which is exactly how the Curve fit shipped. This drives a real mouse to the
// edge and to the middle of the green band and reads the cursor the browser
// actually shows there.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:range-cursor`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();

// The state object of each mode, the selection's state keys, and the pane the
// band is drawn on.
const MODES = [
    { mode: 'fft', state: 'fft' },
    { mode: 'histogram', state: 'histogram' },
    { mode: 'heatmap', state: 'heatmap' },
    { mode: 'temporal-profile', state: 'temporalProfile' },
    { mode: 'integral', state: 'integral' },
    { mode: 'curve-fit', state: 'curveFit' },
    { mode: 'correlation', state: 'correlation', pairs: true },
    { mode: 'phase2d-fit', state: 'phase2d', pairs: true },
];

try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    const lines = ['time,a,b'];
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 4000; i++) {
        lines.push(`${new Date(start + i * 3600000).toISOString().slice(0, 19).replace('T', ' ')},${Math.sin(i / 30).toFixed(4)},${Math.cos(i / 20).toFixed(4)}`);
    }
    await page.setInputFiles('#file-input', [{ name: 'hourly.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        window.app.setActiveFile([...window.app.plotManager.files.keys()][0]);
        return document.querySelector('.layout-panel').dataset.id;
    });

    for (const spec of MODES) {
        // Build the panel in the mode, with its selection on the middle third.
        // One step at a time, each drawn before the next, as a user's clicks are.
        const step = async (fn) => {
            await page.evaluate(fn, { id: panelId, spec });
            await page.waitForTimeout(700);
        };
        await step(({ id }) => window.app.plotManager._clearPanel(id));
        await step(({ id, spec }) => window.app.plotManager._requestModeChange(id, spec.pairs ? 'phase2d' : 'timeseries'));
        await step(({ id, spec }) => {
            const pm = window.app.plotManager;
            const el = document.querySelector('.layout-panel');
            pm.addTrace(id, 'a', el);
            if (spec.pairs) pm.addTrace(id, 'b', el);
        });
        await step(({ id, spec }) => {
            const pm = window.app.plotManager;
            if (spec.mode === 'correlation') pm._requestModeChange(id, 'correlation');
            else if (spec.mode === 'phase2d-fit') pm._togglePhase2dFit(id);
            else pm._toggleTimeseriesAnalysisMode(id, spec.mode);
        });
        await page.waitForTimeout(2000);
        const range = await page.evaluate(({ id, spec }) => {
            const pm = window.app.plotManager;
            const plot = pm.plots.get(id);
            const div = spec.mode === 'phase2d-fit' ? plot.phase2dFitTimeDiv : plot.div;
            const times = pm._getTransformedTimeDataForVariable(plot.traces[0]?.fileId || plot.phaseTraces[0].fileId, 'a');
            const t0 = times[0];
            const t1 = times[times.length - 1];
            const lo = t0 + (t1 - t0) / 3;
            const hi = t0 + 2 * (t1 - t0) / 3;
            if (spec.mode === 'curve-fit') {
                pm._updateCurveFitEntry(id, { rangeFull: false, x1: lo, x2: hi });
            } else if (spec.mode === 'phase2d-fit') {
                // Its time pane opens hidden; choosing Selection shows it.
                const state = pm._ensurePhase2dState(plot);
                state.rangeFull = false;
                state.x1 = lo;
                state.x2 = hi;
                if (state.timeSeriesHidden) pm._togglePhase2dFitTimeSeries(id);
                pm._updatePhase2dFitSelectionShapes(id, plot);
            } else {
                const state = plot[spec.state];
                state.rangeFull = false;
                state.x1 = lo;
                state.x2 = hi;
            }
            return { lo, hi, t0, t1 };
        }, { id: panelId, spec });
        // Let a pane that was just shown be laid out before measuring it.
        await page.waitForTimeout(700);
        const point = await page.evaluate(({ id, spec, range }) => {
            const { lo, hi, t0, t1 } = range;
            const plot = window.app.plotManager.plots.get(id);
            const div = spec.mode === 'phase2d-fit' ? plot.phase2dFitTimeDiv : plot.div;
            const xa = div._fullLayout.xaxis;
            const ya = div._fullLayout.yaxis;
            const rect = div.getBoundingClientRect();
            return {
                edge: [rect.left + xa._offset + xa.l2p(lo), rect.top + ya._offset + ya._length / 2],
                middle: [rect.left + xa._offset + xa.l2p((lo + hi) / 2), rect.top + ya._offset + ya._length / 2],
                outside: [rect.left + xa._offset + xa.l2p(t0 + (t1 - t0) / 12), rect.top + ya._offset + ya._length / 2],
            };
        }, { id: panelId, spec, range });
        await page.waitForTimeout(400);
        const cursorAt = async ([x, y]) => {
            await page.mouse.move(x - 30, y);
            await page.mouse.move(x, y, { steps: 3 });
            await page.waitForTimeout(80);
            return page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)).cursor, [x, y]);
        };
        const edge = await cursorAt(point.edge);
        const middle = await cursorAt(point.middle);
        const outside = await cursorAt(point.outside);
        assert.equal(edge, 'ew-resize', `${spec.mode}: on the edge of the range the pointer is a resize arrow`);
        assert.equal(middle, 'grab', `${spec.mode}: inside the range it offers to move it`);
        assert.ok(outside !== 'ew-resize' && outside !== 'grab', `${spec.mode}: away from the range it is Plotly's own (${outside})`);
        console.log(`  ${spec.mode}: edge ${edge}, middle ${middle}, outside ${outside}`);
    }
    assert.deepEqual(errors, [], 'no page errors');
    console.log('range cursor e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
