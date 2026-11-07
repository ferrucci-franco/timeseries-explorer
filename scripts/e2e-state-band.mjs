// End-to-end check of the state bands (docs/state-band-design.md) in a real
// browser:
//
//   - a text column dropped on a time series becomes a band in its own lane,
//     under the curve, which keeps its Y axis; the time axis goes under the
//     lanes;
//   - one colour per value, the value written inside its run when it fits,
//     a blank where the cells are empty, chips naming the colours;
//   - a column with too many values alternates greys and says so;
//   - zooming in redraws the exact runs; the hover box reads the value
//     holding at the instant; the A|B readout reads it at both cursors;
//   - an analysis leaves the bands behind and the time series brings them
//     back; a dashboard shows them as cards;
//   - a saved view brings the bands back; the CSV export quotes the text;
//   - Shift+click on a lane's label takes the band off;
//   - the same column of a file read in memory-saving mode draws the same
//     runs, from DuckDB.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:state-band`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { encodeStateRuns } from '../src/utils/state-runs.js';

const fixture = { name: 'state-band.csv', mimeType: 'text/csv', buffer: readFileSync(new URL('../test-files/csv/state-band.csv', import.meta.url)) };
const ms = iso => Date.parse(`${iso}Z`);

// A file big enough to be read in memory-saving mode, with a state column.
function lazyCsv() {
    const lines = ['time,a,mode'];
    const modes = [];
    const cycle = ['AUTO', 'AUTO', 'MANUAL', '', 'SERVICE'];
    for (let i = 0; i < 400000; i++) {
        const mode = cycle[Math.floor(i / 7919) % cycle.length];
        modes.push(mode);
        lines.push(`${(i * 0.01).toFixed(2)},${Math.sin(i / 700).toFixed(5)},${mode}`);
    }
    return { modes, file: { name: 'state-lazy.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') } };
}

const bandInfo = (page, id) => page.evaluate(pid => {
    const plot = window.app.plotManager.plots.get(pid);
    const layout = plot.div._fullLayout;
    return {
        traces: plot.traces.map(t => t.varName),
        data: plot.div.data.filter(d => d.name !== '__hover__').map(d => ({
            type: d.type, name: d.name, yaxis: d.yaxis, n: (d.base || d.x || []).length,
            text: d.text, colors: d.marker?.color, base: d.base, x: d.x,
        })),
        yDomain: layout.yaxis.domain,
        y3Domain: layout.yaxis3?.domain,
        xAnchor: layout.xaxis.anchor,
        labels: (layout.annotations || []).map(a => a.text),
        chips: [...plot.div.querySelectorAll('.state-band-chip')].map(c => c.textContent),
    };
}, id);

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    let phase = 'load';
    page.on('pageerror', e => errors.push(process.env.STATE_BAND_DEBUG ? `${phase}: ${e.message}\n${e.stack}` : e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [fixture]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    // ── The tree lets a text series be dragged ──
    phase = 'The tree lets a text series be dragged';
    const leaf = await page.evaluate(() => {
        const app = window.app;
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        const item = document.querySelector('.tree-item[data-var-name="state"]');
        return { draggable: item?.getAttribute('draggable'), dim: item?.classList.contains('tree-item-nonplottable'), sign: !!item?.querySelector('.tree-sign-toggle') };
    });
    assert.deepEqual(leaf, { draggable: 'true', dim: false, sign: false }, 'a text series is draggable, with no sign toggle');

    // ── Dropped beside a curve: a band in its own lane ──
    phase = 'Dropped beside a curve: a band in its own lane';
    const panelId = await page.evaluate(() => {
        const panel = document.querySelector('.layout-panel');
        window.app.plotManager.addTrace(panel.dataset.id, 'temperature', panel);
        return panel.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, panelId);
    await page.evaluate(id => {
        const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager._addDroppedVariables(id, ['state', 'note'], panel);
    }, panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.yaxis3, panelId);
    await page.waitForSelector('.state-band-notice.active');
    let info = await bandInfo(page, panelId);
    assert.deepEqual(info.traces, ['temperature', 'state', 'note']);
    assert.deepEqual(info.data.map(d => [d.type, d.yaxis]), [['scatter', 'y'], ['bar', 'y3'], ['bar', 'y3']],
        'the curve on its axis, each band a bar trace on the lanes');
    assert.ok(info.y3Domain[0] === 0 && info.y3Domain[1] > 0.03 && info.y3Domain[1] < 0.2, `the lanes at the bottom (${info.y3Domain})`);
    assert.ok(info.yDomain[0] > info.y3Domain[1], 'the curve above them, not over them');
    assert.equal(info.xAnchor, 'y3', 'the time axis under the lanes');
    assert.deepEqual(info.labels, ['state', 'note'], 'each lane named');
    const state = info.data[1];
    assert.deepEqual(state.text, ['RUN', 'STOP', 'RUN', 'FAULT', 'IDLE', 'RUN', 'STOP', 'FAULT', 'RUN'],
        'one bar per run, the empty cells left blank');
    assert.equal(new Set(state.text.map((v, i) => `${v}:${state.colors[i]}`)).size, 4, 'one colour per value');
    assert.equal(state.colors[0], state.colors[2], 'RUN is RUN wherever it is');
    assert.equal(state.base[0].slice(0, 19), '2026-03-02T08:00:00', 'a run starts at its first row');
    assert.equal(state.x[0], 40 * 60000, 'and lasts until the next value: 40 min');
    assert.equal(state.x.at(-1), 17 * 60000, 'the last run reaches one step past the last row');
    assert.deepEqual(info.chips.slice(0, 4), ['RUN', 'STOP', 'FAULT', 'IDLE'], 'chips in order of appearance');
    assert.match(info.chips[4], /note/, 'and the band with too many values says what it shows');
    const note = info.data[2];
    assert.equal(note.n, 199, 'a value per row: a run per row (two rows share an instant)');
    assert.equal(new Set(note.colors).size, 2, 'too many values: two greys alternating');
    assert.match(await page.locator('.state-band-notice').textContent(), /note.*200 distinct values/);
    const labelsShown = await page.evaluate(id => window.app.plotManager.plots.get(id).div.querySelectorAll('.bars .bartext').length, panelId);
    assert.ok(labelsShown >= 5, `the values written inside the runs that fit them (${labelsShown})`);

    // ── Zoom in: the exact runs of the window ──
    phase = 'Zoom in: the exact runs of the window';
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        return pm._refreshTimeseriesVisuals(id, plot, ['2026-03-02 09:20:00', '2026-03-02 09:40:00']);
    }, panelId);
    info = await bandInfo(page, panelId);
    assert.deepEqual(info.data[1].text, ['RUN', 'FAULT', 'IDLE'], 'the run holding at the left edge, and those in view');

    // ── The shared hover box: the value holding at the instant ──
    phase = 'The shared hover box: the value holding at the instant';
    await page.evaluate(() => { window.app.plotManager.syncHover = true; });
    const hoverAt = async (iso, band = false) => {
        await page.evaluate(([id, at, isBand]) => {
            const pm = window.app.plotManager;
            pm._onHover(id, isBand
                ? { points: [{ x: 120000, data: { name: 'state', meta: { stateBand: true } } }], xvals: [at] }
                : { points: [{ x: at, data: { name: 'temperature' } }] });
        }, [panelId, iso, band]);
        return page.evaluate(id => document.querySelector(`.layout-panel[data-id="${id}"] .hover-info-box`)?.innerText || '', panelId);
    };
    assert.match(await hoverAt('2026-03-02 09:30:00'), /state = FAULT/, 'over the curve');
    assert.match(await hoverAt('2026-03-02 08:53:30'), /state = —/, 'an empty cell reads as nothing');
    assert.match(await hoverAt('2026-03-02 09:36:00', true), /state = IDLE/, 'over a bar: the time under the pointer, not its length');

    // ── A|B cursors: the value at each ──
    phase = 'A|B cursors: the value at each';
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        pm._toggleCursors(id);
        plot.cursors.a = Date.parse('2026-03-02T09:25:00Z');
        plot.cursors.b = Date.parse('2026-03-02T09:38:00Z');
        pm._syncCursorDisplay(id, plot);
    }, panelId);
    const cursorRows = await page.locator(`.layout-panel[data-id="${panelId}"] .cursor-state-row`).allInnerTexts();
    assert.equal(cursorRows.length, 2, 'a row per band');
    assert.match(cursorRows[0], /state: ■ RUN → ■ IDLE/);
    await page.evaluate(id => window.app.plotManager._toggleCursors(id), panelId);

    // ── An analysis leaves the bands behind; the time series brings them back ──
    phase = 'An analysis leaves the bands behind; the time series brings them back';
    await page.evaluate(id => window.app.plotManager._setMode(id, 'fft', null, { preserveTimeTraces: true }), panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'fft', panelId);
    assert.deepEqual(await page.evaluate(id => window.app.plotManager.plots.get(id).traces.map(t => t.varName), panelId), ['temperature']);
    assert.match(await page.locator('.state-band-notice').textContent(), /stay behind/);
    // Dropped on an analysis, a text column is refused, and says so.
    await page.evaluate(id => window.app.plotManager.addTrace(id, 'state', document.querySelector(`.layout-panel[data-id="${id}"]`)), panelId);
    assert.match(await page.locator('.state-band-notice').textContent(), /is text/);
    await page.evaluate(id => window.app.plotManager._setMode(id, 'timeseries', null, { preserveTimeTraces: true }), panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.yaxis3, panelId);
    assert.deepEqual(await page.evaluate(id => window.app.plotManager.plots.get(id).traces.map(t => t.varName), panelId),
        ['temperature', 'state', 'note'], 'back with the time series');

    // ── A dashboard reads them ──
    phase = 'A dashboard reads them';
    await page.evaluate(id => window.app.plotManager._setMode(id, 'dashboard', null, { preserveTimeTraces: true }), panelId);
    await page.waitForSelector('.dashboard-card');
    const cards = await page.$$eval('.dashboard-card', els => els.map(el => [
        el.querySelector('.dashboard-card-title').textContent, el.querySelector('.dashboard-card-number').textContent]));
    assert.deepEqual(cards.map(c => c[0]), ['temperature', 'state', 'note']);
    assert.equal(cards[1][1], 'RUN', 'the last value of the text');
    await page.evaluate(id => window.app.plotManager._setMode(id, 'timeseries', null, { preserveTimeTraces: true }), panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.yaxis3, panelId);

    // ── The CSV export quotes the text ──
    phase = 'The CSV export quotes the text';
    const dir = mkdtempSync(join(tmpdir(), 'state-band-'));
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(id => window.app.plotManager._exportCSV(id, { fileName: 'bands.csv', timeLayout: 'per-trace' }), panelId),
    ]);
    const csvPath = join(dir, 'bands.csv');
    await download.saveAs(csvPath);
    const exported = readFileSync(csvPath, 'utf8').split('\n');
    assert.match(exported[0], /temperature.*,state,note/);
    assert.match(exported[1], /,RUN,"operator note 000, shift A"$/, 'a comma inside a value is quoted');

    // ── A saved view brings them back ──
    phase = 'A saved view brings them back';
    const viewJson = await page.evaluate(() => JSON.stringify(window.app._createSessionSnapshot({ includeData: false })));
    await page.evaluate(() => window.app.plotManager.clearAll());
    const applying = page.evaluate(json => window.app.loadSessionOrProjectFile(new File([json], 'view.json')), viewJson);
    await page.waitForSelector('.modal-dialog-alert');
    await page.click('.modal-dialog-alert .modal-btn');
    assert.equal(await applying, true);
    const restoredId = await page.evaluate(() => document.querySelector('.layout-panel').dataset.id);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.yaxis3, restoredId);
    info = await bandInfo(page, restoredId);
    assert.deepEqual(info.traces, ['temperature', 'state', 'note'], 'the bands, in their lanes');

    // ── Shift+click on a lane's label takes the band off ──
    phase = "Shift+click on a lane's label takes the band off";
    await page.keyboard.down('Shift');
    await page.click(`.layout-panel[data-id="${restoredId}"] g.annotation[data-index="1"] text`);
    await page.keyboard.up('Shift');
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.length === 2, restoredId);
    info = await bandInfo(page, restoredId);
    assert.deepEqual(info.labels, ['state'], 'one lane left');

    // ── Dark theme: the dark steps of the palette ──
    phase = 'Dark theme: the dark steps of the palette';
    await page.evaluate(() => window.app.applyTheme('dark'));
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?.data?.[1]?.marker?.color?.[0] === '#3987e5', restoredId);
    await page.evaluate(() => window.app.applyTheme('light'));

    // ── Memory-saving: the same runs, from DuckDB ──
    phase = 'Memory-saving: the same runs, from DuckDB';
    const { modes, file } = lazyCsv();
    await page.evaluate(() => window.app.plotManager.clearAll());
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 1 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()].some(f => f.data?._duckdb), null, { timeout: 120000 });
    const lazyPanel = await page.evaluate(() => {
        const app = window.app;
        const [fileId] = [...app.plotManager.files.entries()].find(([, f]) => f.data?._duckdb);
        app.setActiveFile(fileId);
        const panel = document.querySelector('.layout-panel');
        app.plotManager.addTrace(panel.dataset.id, 'a', panel);
        app.plotManager.addTrace(panel.dataset.id, 'mode', panel);
        return panel.dataset.id;
    });
    await page.waitForFunction(id => {
        const plot = window.app.plotManager.plots.get(id);
        const band = plot?.traces.find(t => t.varName === 'mode');
        return plot?.div?._fullLayout?.yaxis3 && band?._stateLazy;
    }, lazyPanel, { timeout: 120000 });
    const lazyRuns = await page.evaluate(id => {
        const band = window.app.plotManager.plots.get(id).traces.find(t => t.varName === 'mode');
        return band._stateLazy.segments.map(s => [Math.round(s.t0 * 100), s.value]);
    }, lazyPanel);
    const enc = encodeStateRuns(modes);
    const expected = enc.starts
        .map((row, i) => [row, enc.codes[i] < 0 ? '' : enc.table[enc.codes[i]]])
        .filter(([, value]) => value !== '');
    // The run holding at the left edge starts, for DuckDB, at the edge row:
    // the query reads the view, not what came before it.
    const viewLo = await page.evaluate(id => {
        const pm = window.app.plotManager;
        return pm._coerceAxisValue(pm.plots.get(id).div._fullLayout.xaxis.range[0]);
    }, lazyPanel);
    assert.equal(lazyRuns[0][1], expected[0][1], 'the value holding at the left edge');
    assert.ok(lazyRuns[0][0] <= Math.max(0, Math.ceil(viewLo * 100)), `from the edge row on (${lazyRuns[0][0]})`);
    assert.deepEqual(lazyRuns.slice(1), expected.slice(1), 'every change of the file, as the in-memory reading gives them');
    const lazyChips = await page.$$eval(`.layout-panel[data-id="${lazyPanel}"] .state-band-chip`, els => els.map(e => e.textContent));
    assert.deepEqual(lazyChips, ['AUTO', 'MANUAL', 'SERVICE'], 'the values of the whole file, from DuckDB');

    assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
    console.log('e2e state band: ok');
} finally {
    await browser.close();
    await server.close();
}
