// End-to-end check of the Histogram on a file read in memory-saving (lazy)
// mode, in a real browser with the DuckDB-WASM the app ships.
//
// A 12 MB CSV (above the 10 MB full-load limit set here) opens lazily; its
// overview in memory is a few thousand rows. A panel drawing `a` is switched
// to Histogram: the bars count every row of the file — their counts add up to
// the file's finite values, and the summary says how many were finite and how
// many were not — with the whole file and with a selection; no warning says
// the file is not supported, and no page error. Before that, Σ on the time
// series prints the min, max, mean, RMS and holes of every row of the file.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-histogram`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { formatMissingCount } from '../src/utils/series-stats.js';

const ROWS = 420000;
function makeCsv() {
    const lines = ['time,a,b'];
    let finite = 0;
    let finiteInSelection = 0;
    const values = [];
    for (let i = 0; i < ROWS; i++) {
        const hole = i % 1201 === 600;
        const a = Math.sin(i / 500) * 3 + (i % 7) / 10;
        if (!hole) {
            finite++;
            if (i >= 100000 && i <= 200000) finiteInSelection++;
        }
        const aText = hole ? '' : a.toFixed(6);
        lines.push(`${(i * 0.01).toFixed(2)},${aText},${(i / 1000).toFixed(6)}`);
        if (!hole) values.push(Number(aText));
    }
    // What Σ must print for `a`: the in-memory kernel's sums over every row.
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        sum += v;
        sumSq += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const stats = {
        min: min.toPrecision(6),
        max: max.toPrecision(6),
        mean: (sum / values.length).toPrecision(6),
        rms: Math.sqrt(sumSq / values.length).toPrecision(6),
    };
    return {
        stats,
        file: { name: 'lazy-histogram.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') },
        finite,
        finiteInSelection,
        holes: ROWS - finite,
    };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const { file, finite, finiteInSelection, holes, stats } = makeCsv();
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 10 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    const overviewRows = await page.evaluate(() => [...window.app.plotManager.files.values()][0].data.variables.a.data.length);
    assert.ok(overviewRows < ROWS / 10, `what is in memory is an overview (${overviewRows} rows)`);

    const panelId = await page.evaluate(() => {
        const pm = window.app.plotManager;
        const fileId = [...pm.files.keys()][0];
        window.app.setActiveFile(fileId);
        const panelEl = document.querySelector('.layout-panel');
        const id = panelEl.dataset.id;
        pm.addTrace(id, 'a', panelEl);
        return id;
    });
    await page.waitForTimeout(500);

    // Σ reads the file, not the overview: every row's min, max, mean, RMS and
    // holes, with the rows counted while it reads.
    // The memory-saving notice lies over the toolbar; the button is pressed as it is.
    await page.locator(`.layout-panel[data-id="${panelId}"] .panel-stats-btn`).dispatchEvent('click');
    await page.waitForSelector('.modal-dialog-stats .stats-table', { timeout: 120000 });
    const shown = await page.evaluate(() => [...document.querySelectorAll('.modal-dialog-stats tbody tr td')].map(td => td.textContent.trim()));
    const missing = formatMissingCount(holes, ROWS);
    assert.deepEqual(shown.slice(2), [stats.min, stats.max, stats.mean, stats.rms, missing], 'Σ prints the figures of every row of the file');
    assert.equal(await page.locator('.stats-table-note').count(), 0, 'with nothing left out');
    await page.locator('.modal-dialog-stats .modal-btn-confirm').click();
    await page.waitForFunction(() => !document.querySelector('.modal-dialog-stats'));

    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'histogram'), panelId);

    const histogram = async () => page.waitForFunction(id => {
        const plot = window.app.plotManager.plots.get(id);
        const bars = plot?.histogramDiv?.data;
        if (!bars?.length || !plot._histSummary?.length || plot._histogramStatusKind === 'loading') return null;
        return {
            total: bars[0].y.reduce((sum, value) => sum + value, 0),
            summary: plot._histSummary[0],
            status: plot._histogramStatusKind,
            warning: plot._histogramWarningMessage || '',
        };
    }, panelId, { timeout: 120000, polling: 200 }).then(handle => handle.jsonValue());

    const whole = await histogram();
    assert.equal(whole.warning, '', `no warning (${whole.warning})`);
    assert.equal(whole.summary.nFinite, finite, `every finite value of the file is counted (${whole.summary.nFinite})`);
    assert.equal(whole.summary.nInvalid, holes, 'and every hole is reported');
    assert.equal(whole.total, finite, 'the bars add up to the file, not to the overview');

    // A selection: the rows of the file between 1000 s and 2000 s.
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const state = pm._ensureHistogramState(plot);
        state.rangeFull = false;
        state.x1 = 1000;
        state.x2 = 2000.005;
        plot._histSummary = [];
        pm._scheduleHistogramRecompute(id, { immediate: true });
    }, panelId);
    const selected = await histogram();
    assert.equal(selected.summary.nFinite, finiteInSelection, `the selection counts the file's rows in it (${selected.summary.nFinite})`);
    assert.equal(selected.total, finiteInSelection, 'and the bars add up to them');

    assert.deepEqual(errors, [], 'no page error');
    console.log(`e2e lazy histogram: ${finite} finite values of a lazy file counted from the panel, the whole file and a selection; Σ over every row`);
} finally {
    await browser.close();
    await server.close();
}
