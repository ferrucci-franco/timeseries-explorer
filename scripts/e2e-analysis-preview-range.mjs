// End-to-end check of the range block after the automatic preview is widened
// back (#387), in every analysis that has the preview: Histogram, Calendar
// heatmap, Temporal profile, Integral, Correlation and the 2D Curve Fit, on a
// file in memory.
//
// A range that looks expensive is first computed over a preview of 262 144
// samples: the range block then says "Selection" with the bounds of the cut.
// That first pass is timed, and when the whole range proves affordable the
// range is put back and the analysis recomputes over all of it
// (_reconsiderAutoLimitedRange). The block has to follow: it used to go on
// showing the preview — "Selection" and the cut's bounds — under a result
// computed from the whole file.
//
// The preview only starts on files of millions of rows, so here its state is
// written as _autoLimitAnalysisRange writes it, over a small file; what is
// checked is the real path from there: the timed pass, the widening, and what
// the block shows once the result is in.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:analysis-preview-range`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();

// Each mode, and the prefix its range block's controls are named by.
const MODES = [
    { mode: 'histogram', prefix: 'hist' },
    { mode: 'heatmap', prefix: 'heatmap' },
    { mode: 'temporal-profile', prefix: 'profile' },
    { mode: 'integral', prefix: 'integral' },
    { mode: 'correlation', prefix: 'corr', pairs: true },
    { mode: 'phase2d-fit', prefix: 'p2d', pairs: true },
];

const ROWS = 6000;
const START = Date.UTC(2026, 0, 1);
// The file's first and last instants, as a datetime-local field shows them.
const FIRST = new Date(START).toISOString().slice(0, 16);
const LAST = new Date(START + (ROWS - 1) * 3600000).toISOString().slice(0, 16);

// What the range block shows: which of Full / Selection is pressed, and each
// bound's field and slider.
const readBlock = (page, spec) => page.evaluate(({ prefix }) => {
    const mine = (el, key) => el.isConnected && el.dataset[`${prefix}${key}`] !== undefined;
    const buttons = [...document.querySelectorAll('[data-analysis-range-full]')].filter(el => mine(el, 'RangeFull'));
    const controls = [...document.querySelectorAll('[data-analysis-range-key]')].filter(el => mine(el, 'Key'));
    return {
        pressed: buttons.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.analysisRangeFull === 'true' ? 'full' : 'selection'),
        active: buttons.filter(button => button.classList.contains('active')).map(button => button.dataset.analysisRangeFull === 'true' ? 'full' : 'selection'),
        controls: controls.map(control => ({
            key: control.dataset.analysisRangeKey,
            role: control.dataset.analysisRangeRole,
            value: control.value,
            disabled: control.disabled,
        })),
    };
}, spec);

try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    const lines = ['time,a,b'];
    for (let i = 0; i < ROWS; i++) {
        lines.push(`${new Date(START + i * 3600000).toISOString().slice(0, 19).replace('T', ' ')},${Math.sin(i / 30).toFixed(4)},${Math.cos(i / 20).toFixed(4)}`);
    }
    await page.setInputFiles('#file-input', [{ name: 'hourly.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        window.app.setActiveFile([...window.app.plotManager.files.keys()][0]);
        return document.querySelector('.layout-panel').dataset.id;
    });
    assert.equal(await page.evaluate(() => !![...window.app.plotManager.files.values()][0].data._duckdb), false, 'the file is in memory');

    for (const spec of MODES) {
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
        await page.waitForTimeout(1500);

        // The block as the analysis opens it over the whole file.
        const whole = await readBlock(page, spec);
        assert.deepEqual(whole.pressed, ['full'], `${spec.mode}: the analysis opens on the full range`);
        assert.equal(whole.controls.length, 4, `${spec.mode}: two bounds, each a field and a slider`);
        // The file's bounds: its first and last hour, not the epoch a range
        // that was never selected used to show (the correlation's block).
        assert.deepEqual(whole.controls.filter(control => control.role === 'input').map(control => control.value),
            [FIRST, LAST], `${spec.mode}: the full range shows the file's bounds`);

        // The automatic preview, as _autoLimitAnalysisRange leaves it: the
        // range cut to the first tenth of the file, what it was before, and a
        // first pass still to be timed.
        const cut = await page.evaluate(({ id, rows }) => {
            const pm = window.app.plotManager;
            const plot = pm.plots.get(id);
            const state = pm._analysisStateForMode(plot);
            const fileId = plot.traces?.[0]?.fileId || plot.phaseTraces?.[0]?.fileId;
            const times = pm._getTransformedTimeDataForVariable(fileId, 'a');
            const sample = Math.floor(rows / 10);
            state.autoRangePrevious = { rangeFull: !!state.rangeFull, x1: state.x1, x2: state.x2 };
            state.autoRangeFullCount = times.length;
            state.autoRangeSampleCount = sample;
            state.autoRangeMeasured = false;
            state.rangeFull = false;
            state.autoRangeLimited = true;
            state.autoRangeFocusPending = true;
            state.x1 = Number(times[0]);
            state.x2 = Number(times[sample - 1]);
            state.autoRangeWarning = 'preview';
            pm._syncAnalysisRangeUi(id, plot, plot.mode);
            return { mode: plot.mode, x1: state.x1, x2: state.x2, rows: times.length };
        }, { id: panelId, rows: ROWS });
        assert.equal(cut.rows, ROWS, `${spec.mode}: every row of the file is in memory`);
        const preview = await readBlock(page, spec);
        assert.deepEqual(preview.pressed, ['selection'], `${spec.mode}: the preview shows as a selection`);
        assert.ok(preview.controls.every(control => !control.disabled), `${spec.mode}: with its bounds editable`);

        // The pass over the preview, timed; it is cheap, so the range goes back
        // to the whole file and the analysis recomputes.
        await page.evaluate(({ id }) => {
            const pm = window.app.plotManager;
            pm._rescheduleAnalysisRecompute(id, pm.plots.get(id).mode);
        }, { id: panelId });
        await page.waitForFunction(({ id }) => {
            const pm = window.app.plotManager;
            const state = pm._analysisStateForMode(pm.plots.get(id));
            return state.autoRangeMeasured === true;
        }, { id: panelId }, { timeout: 30000 });
        await page.waitForTimeout(1500);
        const state = await page.evaluate(({ id }) => {
            const pm = window.app.plotManager;
            const state = pm._analysisStateForMode(pm.plots.get(id));
            return { rangeFull: state.rangeFull, limited: state.autoRangeLimited, warning: state.autoRangeWarning };
        }, { id: panelId });
        assert.deepEqual(state, { rangeFull: true, limited: false, warning: null },
            `${spec.mode}: the range is the whole file again`);

        const after = await readBlock(page, spec);
        assert.deepEqual(after.pressed, ['full'], `${spec.mode}: the range block says Full`);
        assert.deepEqual(after.active, ['full'], `${spec.mode}: and shows it pressed`);
        assert.deepEqual(after.controls, whole.controls,
            `${spec.mode}: with the file's bounds, as when the analysis opened on the whole file`);
        console.log(`  ${spec.mode}: Selection ${preview.controls.filter(c => c.role === 'input').map(c => c.value).join(' … ')} → Full ${after.controls.filter(c => c.role === 'input').map(c => c.value).join(' … ')}`);
    }
    assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
    console.log('analysis preview range e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
