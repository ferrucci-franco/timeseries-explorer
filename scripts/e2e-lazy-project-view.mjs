// End-to-end check of "Save complete project" with a file in memory-saving
// (lazy) mode, in a real browser with the DuckDB-WASM the app ships.
//
// A complete project copies every source file into its .zip. A lazy file is
// one that does not fit in memory, so it is not copied; the dialog used to
// stop there and advise raising the full-load limit, which nobody with such a
// file can do. Now it offers what does keep the work on a large file: a view.
//
// A 12 MB CSV opens lazily (the full-load limit is set to 10 MB). On it: a
// derivative and a linear detrend made with the Data Tools panel, both drawn,
// and a zoom. Then:
//   · Save complete project → the dialog names the file, does not mention
//     the full-load limit, and its button saves a view;
//   · Cancel saves nothing;
//   · the button downloads a .json that holds no data;
//   · in a fresh page, with the same file opened lazily again, loading that
//     view brings back both variables as expressions over the file, the
//     detrend's fitted line, the panel's traces and the zoom.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-project-view`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,a,b'];
    for (let i = 0; i < 420000; i++) {
        lines.push(`${(i * 0.01).toFixed(2)},${(Math.sin(i / 500) + (i % 7) / 100).toFixed(6)},${(i / 1000 + Math.cos(i / 90)).toFixed(6)}`);
    }
    return { name: 'lazy-project.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

async function createAndPlot(page, tool, source, output, configure = async () => {}) {
    await page.locator('#data-tool-select').selectOption(tool);
    await page.locator('#outlier-variable').selectOption(source);
    await configure();
    await page.locator('#outlier-output-name').fill(output);
    await page.locator('#outlier-output-name').dispatchEvent('input');
    await page.locator('#data-tool-create-plot').click();
    await page.waitForFunction(name => {
        const data = [...window.app.plotManager.files.values()][0]?.data;
        return !!data?.variables?.[name]?._duckdbExpr;
    }, output, { timeout: 120000 });
    await page.waitForFunction(() => !window.app._dataToolBusy, null, { timeout: 120000 });
}

async function openLazy(page, baseUrl, csv) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 10 }));
    await page.setInputFiles('#file-input', [csv]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    await page.evaluate(() => window.app.setActiveFile([...window.app.plotManager.files.keys()][0]));
    await page.waitForTimeout(500);
    // The "memory-saving mode" notice sits over the page; it is not what is tested.
    await page.evaluate(() => document.querySelectorAll('.modal-overlay .modal-btn').forEach(button => button.click()));
}

// What the work on the file is made of, read the same way before and after.
const workspace = page => page.evaluate(() => {
    const pm = window.app.plotManager;
    const data = [...pm.files.values()][0].data;
    const plot = [...pm.plots.values()].find(p => (p.traces || []).length);
    const range = plot?.div?.layout?.xaxis?.range || [];
    return {
        lazy: !!data._duckdb,
        derivative: !!data.variables.da?._duckdbExpr,
        detrend: !!data.variables.lb?._duckdbExpr,
        detrendMethod: data.variables.lb?.dataTool?.method || null,
        traces: (plot?.traces || []).map(trace => trace.varName).sort(),
        range: range.map(Number),
    };
});

// The first row of a variable in a window of the file: a value computed over
// the file, not read off the overview in memory.
const sample = (page, name) => page.evaluate(async (varName) => {
    const data = [...window.app.plotManager.files.values()][0].data;
    const result = await data._duckdb.source.getRawColumnsRange(data, [varName], 1000, 1010, 2000);
    const values = result?.yByVar?.get?.(varName) || result?.columns?.[varName] || result?.y?.[varName] || [];
    return Array.from(values).slice(0, 5);
}, name);

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const csv = makeCsv();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await openLazy(page, baseUrl, csv);

    await createAndPlot(page, 'derivative', 'a', 'da', () => page.locator('#derivative-method').selectOption('centered'));
    await createAndPlot(page, 'detrend', 'b', 'lb', () => page.locator('#detrend-method').selectOption('linear'));
    // A zoom, to be found again.
    await page.evaluate(() => {
        const plot = [...window.app.plotManager.plots.values()].find(p => (p.traces || []).length);
        return window.Plotly.relayout(plot.div, { 'xaxis.range': [1000, 1200] });
    });
    await page.waitForTimeout(800);
    const before = await workspace(page);
    assert.equal(before.lazy, true, 'the file is in memory-saving mode');
    assert.equal(before.derivative && before.detrend, true, 'both tools are expressions over the file');
    assert.ok(before.traces.includes('da') && before.traces.includes('lb'), `both are drawn (${before.traces})`);
    const detrendBefore = await sample(page, 'lb');
    assert.ok(detrendBefore.length > 0 && detrendBefore.every(Number.isFinite), `the detrend is read from the file (${detrendBefore})`);

    // Save complete project: the dialog offers the view.
    const dialog = page.locator('.modal-dialog-session-missing');
    let saving = page.evaluate(() => window.app.saveProjectSession());
    await dialog.waitFor({ timeout: 15000 });
    const text = await dialog.innerText();
    assert.match(text, /lazy-project\.csv/, 'the file that is not copied is named');
    assert.match(text, /view/i, 'the dialog speaks of the view');
    assert.doesNotMatch(text, /full-load limit/i, 'and gives no advice a large file cannot follow');
    assert.match(await dialog.locator('.modal-btn-confirm').innerText(), /view/i, 'its button saves a view');

    // Cancel: nothing is saved.
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await dialog.locator('.modal-btn-cancel').click();
    assert.equal(await saving, false, 'no complete project');
    await page.waitForTimeout(500);
    assert.equal(downloads, 0, 'Cancel downloads nothing');

    // The button: the view is downloaded.
    saving = page.evaluate(() => window.app.saveProjectSession());
    await dialog.waitFor({ timeout: 15000 });
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        dialog.locator('.modal-btn-confirm').click(),
    ]);
    assert.equal(await saving, false, 'still not a complete project');
    assert.match(download.suggestedFilename(), /-view-.*\.json$/, `a view was saved (${download.suggestedFilename()})`);
    const viewText = readFileSync(await download.path(), 'utf8');
    const view = JSON.parse(viewText);
    assert.equal(view.files.length, 1);
    assert.equal(view.files[0].archivePath, null, 'the view holds no data');
    assert.ok(viewText.length < 200000, `a few KB, not the file (${viewText.length} characters)`);
    assert.deepEqual(errors, [], 'no page error while saving');

    // A fresh page, the same file opened lazily again, and the view loaded.
    const page2 = await context.newPage();
    const errors2 = [];
    page2.on('pageerror', e => errors2.push(e.message));
    await openLazy(page2, baseUrl, csv);
    // Loading ends on a "Session loaded" notice, which is read and closed.
    const loading = page2.evaluate(async (json) => {
        const file = new File([json], 'saved-view.json', { type: 'application/json' });
        return window.app.loadSessionOrProjectFile(file);
    }, viewText);
    const notice = page2.locator('.modal-dialog-alert');
    await notice.waitFor({ timeout: 120000 });
    await notice.locator('.modal-btn').first().click();
    assert.notEqual(await loading, false, 'the view loads on the file');
    await page2.waitForFunction(() => {
        const data = [...window.app.plotManager.files.values()][0]?.data;
        return !!data?.variables?.da?._duckdbExpr && !!data?.variables?.lb?._duckdbExpr;
    }, null, { timeout: 120000 });
    await page2.waitForFunction(() => {
        const plot = [...window.app.plotManager.plots.values()].find(p => (p.traces || []).length);
        return (plot?.traces || []).length >= 2;
    }, null, { timeout: 60000 });
    await page2.waitForTimeout(1500);
    const after = await workspace(page2);
    assert.equal(after.lazy, true, 'still in memory-saving mode');
    assert.deepEqual(after.traces, before.traces, 'the same traces are drawn');
    assert.equal(after.detrendMethod, before.detrendMethod, 'the detrend kept its method');
    assert.ok(Math.abs(after.range[0] - before.range[0]) < 1e-6 && Math.abs(after.range[1] - before.range[1]) < 1e-6,
        `the zoom is back (${after.range} vs ${before.range})`);
    // The detrend's line is fitted over the whole file again: same values.
    const detrendAfter = await sample(page2, 'lb');
    assert.equal(detrendAfter.length, detrendBefore.length);
    detrendAfter.forEach((value, i) => assert.ok(Math.abs(value - detrendBefore[i]) <= 1e-9 * Math.max(1, Math.abs(detrendBefore[i])),
        `the restored detrend reads the same from the file (${value} vs ${detrendBefore[i]})`));
    assert.deepEqual(errors2, [], 'no page error while restoring');

    console.log('Lazy project: the dialog offers a view; saved and loaded on the same file, the work is back.');
} finally {
    await browser.close();
    await server.close();
}
