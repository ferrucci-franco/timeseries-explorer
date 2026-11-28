// End-to-end check of an OpenModelica result (.mat) opened in memory-saving
// (lazy) mode, against the same file held in memory, in a real browser with
// the DuckDB-WASM the app ships (docs/any-size-files.md, "MAT results").
//
// A MAT file past its full-load limit used to be a question: load it whole, or
// not at all. A simulation result is now read by parts into the engine and
// opens like any file in memory-saving mode.
//
// One result of 15 MB (320 series, 6 000 steps: two tables in the engine; a
// negated alias, a boolean, a parameter) is opened twice: whole in one page
// (the MAT limit raised), lazily in the other (the limit set to 1 MB). Then:
//   · the lazy page asked nothing, shows the memory-saving notice and the
//     file's lazy mark; both pages list the same variables;
//   · a series of each table, the negated alias and the parameter are drawn;
//     zoomed onto ~60 rows with Samples on, the lazy traces draw the rows the
//     in-memory ones draw — same instants, same values;
//   · the histogram of a series of the second table has the same edges and
//     the same bars in both;
//   · a derivative made with the Data Tools panel on the lazy file is an
//     expression over the file, with values;
//   · reloading the file reads it by parts again and keeps the plots;
//   · a result under the limit is still loaded whole;
//   · cancelling the copy leaves no file and no table in the engine.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-mat`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
import { createServer } from 'vite';
import { trajectory } from './support/mat-v4-fixture.mjs';

const SERIES = 320;
const STEPS = 6000;
const FAR = SERIES - 1;                       // a series of the second table
const farName = `rotor${FAR % 5}.s${FAR}`;

function makeMat(steps = STEPS, series = SERIES) {
    const names = ['time'];
    const descriptions = ['Simulation time [s]'];
    const info = [[0, 1, 0, -1]];
    for (let row = 1; row < series; row++) {
        names.push(`rotor${row % 5}.s${row}`);
        descriptions.push(row % 2 ? 'speed [rad/s]' : '');
        info.push([2, row + 1, 1, -1]);
    }
    names.push('alias.negated', 'rotor0.J');
    descriptions.push('the last series, sign changed', 'inertia [kg.m2]');
    info.push([2, -series, 1, -1], [1, 1, 0, 0]);
    const value = (row, step) => {
        if (row === 0) return step * 0.01;
        if (row === 2) return step % 2;
        return Math.sin(step / (15 + row)) * (1 + row / 50) + ((step * 7 + row) % 11) / 40;
    };
    return {
        name: 'machine_res.mat',
        mimeType: 'application/octet-stream',
        buffer: trajectory({ names, descriptions, info, params: [0.125], series, steps, value }),
    };
}

async function boot(page, baseUrl, limitMb) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(mb => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, matlabFullLoadMb: mb }), limitMb);
}

async function open(page, baseUrl, mat, limitMb) {
    await boot(page, baseUrl, limitMb);
    await page.setInputFiles('#file-input', [mat]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 180000 });
    await page.waitForTimeout(500);
    const asked = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay .modal-dialog')].map(node => node.innerText));
    const notice = await page.evaluate(() => document.querySelector('.dismissible-notice')?.innerText || '');
    // "Got it", not "Open Settings".
    await page.evaluate(() => document.querySelectorAll('.dismissible-notice').forEach(node => node.querySelector('button')?.click()));
    const opened = await page.evaluate((names) => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        const fileId = [...app.plotManager.files.keys()][0];
        app.setActiveFile(fileId);
        for (const name of names) app.plotManager.addTrace(panelEl.dataset.id, name, panelEl);
        const data = app.plotManager.files.get(fileId).data;
        return {
            panelId: panelEl.dataset.id,
            lazy: !!data._duckdb,
            tables: data.metadata.ingest?.tables || 0,
            variables: Object.keys(data.variables),
            kinds: Object.values(data.variables).map(variable => `${variable.kind}:${variable.dataType}`),
            mark: !document.querySelector('.file-entry-lazy-indicator')?.hidden,
        };
    }, ['rotor1.s1', farName, 'alias.negated', 'rotor0.J']);
    return { ...opened, asked, notice };
}

async function settle(page) {
    await page.waitForTimeout(250);
    await page.evaluate(() => window.app.plotManager._lastLazyRefresh);
    await page.waitForFunction(() => !document.querySelector('.lazy-detail-indicator.active:not(.samples-zoom-indicator)'), null, { timeout: 120000 });
    await page.waitForTimeout(250);
}

// The rows each trace draws inside the visible window.
const drawn = (page, panelId) => page.evaluate((id) => {
    const plot = window.app.plotManager.plots.get(id);
    const [lo, hi] = plot.div.layout.xaxis.range.map(Number);
    return plot.div.data.map((trace) => {
        const rows = [];
        for (let i = 0; i < trace.x.length; i++) {
            const x = Number(trace.x[i]);
            if (x >= lo && x <= hi) rows.push([x, Number(trace.y[i])]);
        }
        return { name: trace.name, rows, first: Number(trace.y[0]) };
    });
}, panelId);

async function histogram(page, panelId) {
    await page.locator('.timeseries-analysis-menu-btn').first().click({ timeout: 15000 });
    await page.locator('.panel-analysis-menu .analysis-card[data-mark="histogram"]').click();
    try {
        await page.waitForFunction((id) => {
            const p = window.app.plotManager.plots.get(id);
            return p?._histSpec?.edges?.length && p.histogramDiv?.data?.length >= 3 && !p._analysisPill
                && p.histogramDiv.data.every(trace => trace.y?.length === p._histSpec.k);
        }, panelId, { timeout: 30000 });
    } catch (_) {
        assert.fail(`the histogram did not settle: ${await page.evaluate((id) => {
            const p = window.app.plotManager.plots.get(id);
            return JSON.stringify({ k: p?._histSpec?.k, edges: p?._histSpec?.edges?.length, traces: p?.histogramDiv?.data?.map(t => [t.name, t.y?.length]),
                pill: !!p?._analysisPill, status: p?.div?.closest('.layout-panel')?.querySelector('.histogram-status, [class*="status"]')?.textContent });
        }, panelId)}`);
    }
    return page.evaluate((id) => {
        const p = window.app.plotManager.plots.get(id);
        return {
            edges: Array.from(p._histSpec.edges),
            bars: p.histogramDiv.data.map(trace => ({ name: trace.name, y: Array.from(trace.y) })),
            finite: (p._histSummary || []).map(entry => entry.nFinite),
        };
    }, panelId);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const mat = makeMat();
    assert.ok(mat.buffer.length > 14e6, `the result is ${(mat.buffer.length / 1e6).toFixed(1)} MB`);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    const pages = {};
    for (const [name, limitMb] of [['memory', 4000], ['lazy', 1]]) {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(`${name}: ${e.stack || e.message}`));
        pages[name] = { page, ...(await open(page, baseUrl, mat, limitMb)) };
        await settle(page);
    }
    const { memory, lazy } = pages;
    assert.equal(memory.lazy, false, 'under its limit the result is in memory');
    assert.equal(lazy.lazy, true, 'past its limit it opens in memory-saving mode');
    assert.deepEqual(lazy.asked, [], 'and nothing is asked');
    assert.match(lazy.notice, /memory-saving mode/i, 'the notice says so');
    assert.equal(lazy.mark, true, 'the file carries the lazy mark');
    assert.equal(lazy.tables, 2, '320 series are two tables in the engine');
    assert.deepEqual(lazy.variables, memory.variables, 'the same variables, in the same order');
    assert.deepEqual(lazy.kinds, memory.kinds, 'of the same kinds and types');

    // Zoomed onto ~60 rows with Samples on: the rows of the file, in both.
    for (const { page, panelId } of [memory, lazy]) {
        await page.evaluate(id => window.app.plotManager._toggleSamples(id), panelId);
        await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [30, 30.6] }), panelId);
        await settle(page);
    }
    const rowsMemory = await drawn(memory.page, memory.panelId);
    const rowsLazy = await drawn(lazy.page, lazy.panelId);
    assert.deepEqual(rowsLazy.map(trace => trace.name), rowsMemory.map(trace => trace.name), 'the same traces');
    rowsMemory.forEach((trace, index) => {
        const got = rowsLazy[index].rows;
        if (trace.name.includes('J')) {
            assert.equal(rowsLazy[index].first, 0.125, 'the parameter is drawn at its value');
            return;
        }
        assert.ok(trace.rows.length >= 60, `${trace.name}: ~60 rows in the window (${trace.rows.length})`);
        assert.deepEqual(got, trace.rows, `${trace.name}: the lazy trace draws the rows the in-memory one draws`);
    });
    const far = rowsLazy.find(trace => trace.name === farName).rows;
    const negated = rowsLazy.find(trace => trace.name === 'alias.negated').rows;
    far.forEach((row, i) => assert.equal(negated[i][1], -row[1], 'the alias is the series with its sign changed'));

    // The histogram, over every row of the file.
    for (const { page, panelId } of [memory, lazy]) {
        await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.autorange': true }), panelId);
        await settle(page);
    }
    const histMemory = await histogram(memory.page, memory.panelId);
    const histLazy = await histogram(lazy.page, lazy.panelId);
    assert.deepEqual(histLazy.finite, histMemory.finite, 'the histogram counts every row');
    assert.equal(histMemory.finite[0], STEPS);
    assert.deepEqual(histLazy.edges, histMemory.edges, 'the same bins');
    assert.deepEqual(histLazy.bars, histMemory.bars, 'the same bars');

    // A data tool on the lazy result: an expression over the file.
    {
        const { page } = lazy;
        await page.locator('#data-tool-select').selectOption('derivative');
        await page.locator('#outlier-variable').selectOption(farName);
        await page.locator('#derivative-method').selectOption('centered');
        await page.locator('#outlier-output-name').fill('dfar');
        await page.locator('#outlier-output-name').dispatchEvent('input');
        await page.locator('#data-tool-create-plot').click();
        await page.waitForFunction(() => !![...window.app.plotManager.files.values()][0]?.data?.variables?.dfar?._duckdbExpr, null, { timeout: 120000 });
        await page.waitForFunction(() => !window.app._dataToolBusy, null, { timeout: 120000 });
        const values = await page.evaluate(async () => {
            const data = [...window.app.plotManager.files.values()][0].data;
            const result = await data._duckdb.source.getRawColumnsRange(data, ['dfar'], 10, 10.2, 1000);
            return Array.from(result.yByVar.get('dfar'));
        });
        assert.ok(values.length >= 20 && values.every(Number.isFinite), `the derivative is read from the file (${values.length} rows)`);

        // Reload (after simulating again): read by parts again, the plots and
        // the tool kept, and the tables of the copy it replaces dropped.
        const before = await page.evaluate(() => [...window.app.plotManager.files.values()][0].data._duckdb.tableName);
        await page.evaluate(() => window.app.reloadActiveFile());
        await page.waitForFunction(name => {
            const data = [...window.app.plotManager.files.values()][0]?.data;
            return !!data?._duckdb && data._duckdb.tableName !== name;
        }, before, { timeout: 120000 });
        await page.waitForFunction(async () => {
            const source = await window.app._getDuckDbSource();
            const left = await source.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE 'omv_ingest_%'");
            return Number(left.toArray()[0].n) === 2;
        }, null, { timeout: 60000 });
        const reloaded = await page.evaluate((id) => {
            const pm = window.app.plotManager;
            const data = [...pm.files.values()][0].data;
            return {
                lazy: !!data._duckdb,
                tool: !!data.variables.dfar?._duckdbExpr,
                traces: pm.plots.get(id).traces.map(trace => trace.varName),
                dialogs: document.querySelectorAll('.modal-overlay .modal-dialog').length,
            };
        }, lazy.panelId);
        assert.equal(reloaded.lazy, true, 'reloaded, it is still in memory-saving mode');
        assert.equal(reloaded.tool, true, 'the data tool is applied again');
        assert.ok(['rotor1.s1', farName, 'alias.negated', 'rotor0.J', 'dfar'].every(name => reloaded.traces.includes(name)), `the traces are kept (${reloaded.traces})`);
        assert.equal(reloaded.dialogs, 0, 'and nothing was asked');
    }
    assert.deepEqual(errors, [], 'no page error');

    // A result under the limit is loaded whole, as before.
    {
        const page = await context.newPage();
        const small = await open(page, baseUrl, makeMat(200, 12), 1);
        assert.equal(small.lazy, false, 'a small result is in memory');
        await page.close();
    }

    // Cancel while the copy runs: no file, and nothing left in the engine.
    {
        const page = await context.newPage();
        const cancelErrors = [];
        page.on('pageerror', e => cancelErrors.push(e.stack || e.message));
        await boot(page, baseUrl, 1);
        // Each block waits a little, so the copy is still running when Cancel is pressed.
        await page.evaluate(async () => {
            const slice = Blob.prototype.slice;
            let slowed = 0;
            Blob.prototype.slice = function (start, end, type) {
                const part = slice.call(this, start, end, type);
                if ((end - start) > 1e6) {
                    const arrayBuffer = part.arrayBuffer.bind(part);
                    part.arrayBuffer = async () => { slowed += 1; await new Promise(resolve => setTimeout(resolve, 1500)); return arrayBuffer(); };
                }
                return part;
            };
            window.__slowed = () => slowed;
        });
        await page.setInputFiles('#file-input', [mat]);
        await page.waitForFunction(() => /\d+ %/.test(document.getElementById('file-loading-progress')?.textContent || ''), null, { timeout: 120000 });
        await page.locator('#file-loading-cancel').click();
        await page.waitForFunction(() => !document.getElementById('file-loading-overlay')?.classList.contains('show'), null, { timeout: 120000 });
        await page.waitForTimeout(500);
        const after = await page.evaluate(async () => {
            const source = await window.app._getDuckDbSource();
            const left = await source.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE 'omv_ingest_%'");
            return {
                files: window.app.plotManager.files.size,
                tables: Number(left.toArray()[0].n),
                sinks: source._liveSinks.size,
                dialogs: document.querySelectorAll('.modal-overlay .modal-dialog').length,
            };
        });
        assert.deepEqual(after, { files: 0, tables: 0, sinks: 0, dialogs: 0 }, 'cancelled: no file, no table, no question');
        assert.deepEqual(cancelErrors, [], 'no page error on cancel');
    }

    console.log('Lazy MAT: a simulation result opens in memory-saving mode with the rows, the histogram and the tools of the file in memory.');
} finally {
    await browser.close();
    await server.close();
}
