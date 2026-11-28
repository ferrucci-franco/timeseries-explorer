// End-to-end check of a netCDF whose series do not fit in memory: it opens in
// memory-saving (lazy) mode, in a real browser with the DuckDB-WASM the app
// ships (docs/any-size-files.md, "las series de un netCDF por trozos").
//
// Until now such a file was a question — load it whole, or not at all. Its
// series are read by parts in the parse worker now, handed over a block at a
// time, copied into the engine, and the file opens like any lazy file. There
// is nothing left to ask.
//
// The same fixture is opened twice: once as it always was (its series are
// well under the 250 MB limit), and once with that limit answered as 64 bytes,
// which is the one seam this test needs — a netCDF is judged by what its
// series would load, and no fixture in the repository loads more than a few
// kilobytes, while Settings takes the limit in whole megabytes. Everything
// downstream of the limit is the real thing: the worker, the blocks, the
// engine, the dataset. Then:
//   · the lazy page asked nothing, and shows the file's memory-saving mark;
//   · both pages hold the same dataset: the same variables in the same order,
//     with the same display names, kinds, data types and units, the same tree,
//     the same step count, and a calendar time axis in both;
//   · a series drawn on each page draws the same rows with the same values.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-netcdf`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const FIXTURE = 'generic-timeseries-classic.nc';
const bytes = readFileSync(new URL(`../test-files/netcdf/${FIXTURE}`, import.meta.url));
const upload = { name: FIXTURE, mimeType: 'application/octet-stream', buffer: bytes };

async function open(page, baseUrl, { lazy }) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    if (lazy) {
        // The limit this file's series are over. Settings takes megabytes; the
        // fixture's series are 96 bytes.
        await page.evaluate(() => { window.app._pypsaNetcdfEagerLimitBytes = () => 64; });
    }
    await page.setInputFiles('#file-input', [upload]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 180000 });
    await page.waitForTimeout(600);
    const asked = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay .modal-dialog')].map(node => node.innerText));
    const notice = await page.evaluate(() => document.querySelector('.dismissible-notice')?.innerText || '');
    await page.evaluate(() => document.querySelectorAll('.dismissible-notice').forEach(node => node.querySelector('button')?.click()));
    const opened = await page.evaluate(() => {
        const app = window.app;
        const fileId = [...app.plotManager.files.keys()][0];
        app.setActiveFile(fileId);
        const data = app.plotManager.files.get(fileId).data;
        const names = Object.keys(data.variables);
        const shape = (node) => ({
            variables: Object.keys(node?._variables || {}),
            children: Object.fromEntries(Object.entries(node?._children || {}).map(([key, child]) => [key, shape(child)])),
        });
        return {
            panelId: document.querySelector('.layout-panel').dataset.id,
            lazy: !!data._duckdb,
            format: data.metadata.format,
            rows: data.metadata.numTimesteps,
            timeKind: data.metadata.timeKind,
            timeName: data.metadata.timeName,
            generated: data.metadata.generatedSeriesCount,
            variables: names,
            details: names.map((name) => {
                const variable = data.variables[name];
                return [variable.displayName || '', variable.kind, variable.dataType, variable.units || ''].join('|');
            }),
            tree: JSON.stringify(shape(data.tree)),
            mark: !document.querySelector('.file-entry-lazy-indicator')?.hidden,
        };
    });
    return { ...opened, asked, notice };
}

// The rows one series draws.
async function drawn(page, state, variable) {
    await page.evaluate(({ panelId, name }) => {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        window.app.plotManager.addTrace(panelId, name, panelEl);
    }, { panelId: state.panelId, name: variable });
    await page.waitForTimeout(800);
    await page.waitForFunction(() => !document.querySelector('.lazy-detail-indicator.active'), null, { timeout: 120000 });
    await page.waitForTimeout(400);
    return page.evaluate(({ panelId }) => {
        const plot = window.app.plotManager.plots.get(panelId);
        const trace = plot.div.data[0];
        const rows = [];
        for (let i = 0; i < trace.x.length; i++) {
            const at = trace.x[i];
            const x = typeof at === 'string' ? new Date(at).getTime() : Number(at);
            rows.push([x, Number(trace.y[i])]);
        }
        return { rows };
    }, { panelId: state.panelId });
}

// The project's vite.config.js, as every other e2e server loads it: the build
// SHA the version check compares, `base`, the worker format. A server without
// it is a different app.
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const pages = {};
    for (const [name, lazy] of [['memory', false], ['lazy', true]]) {
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        page.on('pageerror', (error) => {
            // Without COOP/COEP headers there is no SharedArrayBuffer and
            // DuckDB-WASM says so; the single-threaded build still answers
            // every query. The app ships with the headers, so this is only
            // ever seen on a bare dev server.
            if (/compiled without threads/i.test(error.message || '')) return;
            assert.fail(`${name}: page error — ${error.message}`);
        });
        pages[name] = { page, ...(await open(page, baseUrl, { lazy })) };
    }
    const { memory, lazy } = pages;

    assert.equal(memory.lazy, false, 'under its limit the file is read whole');
    assert.equal(lazy.lazy, true, 'with its series over the limit it opens in memory-saving mode');
    assert.equal(lazy.format, 'netcdf-lazy', 'as a lazy netCDF dataset');
    assert.deepEqual(lazy.asked, [], 'and nothing is asked: there is no question left to ask');
    assert.ok(lazy.mark, "the file's memory-saving mark is shown");
    assert.match(lazy.notice, /./, 'with the notice that says what the mode is');

    assert.deepEqual(lazy.variables, memory.variables, 'the same variables, in the same order');
    assert.deepEqual(lazy.details, memory.details, 'each with the same display name, kind, data type and units');
    assert.equal(lazy.tree, memory.tree, 'and the same tree');
    assert.equal(lazy.rows, memory.rows, 'the same number of steps');
    assert.equal(lazy.timeKind, memory.timeKind, 'the time axis is a calendar in both');
    assert.equal(lazy.timeName, memory.timeName, 'under the same name');
    assert.equal(lazy.generated, memory.generated, 'the same number of series generated');

    const series = memory.variables.find((name, index) => memory.details[index].split('|')[1] === 'variable');
    assert.ok(series, 'the file has a series to draw');
    const inMemory = await drawn(memory.page, memory, series);
    const inEngine = await drawn(lazy.page, lazy, series);
    assert.ok(inMemory.rows.length > 1, `the panel drew the series (${inMemory.rows.length} rows)`);
    assert.deepEqual(inEngine.rows, inMemory.rows, 'the lazy panel draws the rows the in-memory panel draws');

    console.log(`e2e lazy netCDF: ${FIXTURE} opened in memory-saving mode — ${lazy.generated} series, ${lazy.rows} steps, ${inMemory.rows.length} rows compared`);
} finally {
    await browser.close();
    await server.close();
}
