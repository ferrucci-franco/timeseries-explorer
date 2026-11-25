// End-to-end check of the Samples toggle on a file read in memory-saving
// (lazy) mode, against the same file held in memory, in a real browser with
// the DuckDB-WASM the app ships (docs/sample-markers-design.md, "Lazy files").
//
// A dot marks a row of the file. In memory the rows are there; a lazy file is
// drawn from an overview and, zoomed in, from min/max buckets — neither is its
// rows — so Samples used to answer "not shown yet for files loaded in
// memory-saving mode". Now a window with few rows is read as its rows.
//
// One CSV of 12 MB (420 000 rows, numeric time, a burst of three rows at one
// instant) is opened twice: whole in one page, lazily in another (the
// full-load limit set to 10 MB there). In both, Samples is turned on and the
// view goes through the same windows:
//   · zoomed out: no dots, the item waits with "zoom in" (not "memory-saving");
//   · zoomed onto ~60 rows: dots, and the lazy trace draws the same rows as
//     the in-memory one — same instants, same values, the three rows of the
//     burst included;
//   · panned inside the rows already read: dots, with no new query;
//   · zoomed back out: dots gone, waiting again.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-sample-markers`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 420000;
const BURST_AT = 200030;   // rows 200030, 200031, 200032 share t = 2000.30

function makeCsv() {
    const lines = ['time,v,w'];
    let t = 0;
    for (let i = 0; i < ROWS; i++) {
        if (i <= BURST_AT || i > BURST_AT + 2) t = i / 100;
        lines.push(`${t.toFixed(2)},${(Math.sin(i / 50) + (i % 7) / 100).toFixed(6)},${(i / 1000).toFixed(6)}`);
    }
    return { name: 'burst-large.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

async function open(page, baseUrl, csv, limitMb) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(mb => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: mb }), limitMb);
    await page.setInputFiles('#file-input', [csv]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 180000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelectorAll('.modal-overlay .modal-btn').forEach(button => button.click()));
    return page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'v', panelEl);
        return { panelId: panelEl.dataset.id, lazy: !![...app.plotManager.files.values()][0].data._duckdb };
    });
}

async function settle(page) {
    await page.waitForTimeout(250);
    await page.evaluate(() => window.app.plotManager._lastLazyRefresh);
    await page.waitForFunction(() => !document.querySelector('.lazy-detail-indicator.active:not(.samples-zoom-indicator)'), null, { timeout: 120000 });
    await page.waitForTimeout(250);
}

async function zoom(page, panelId, range) {
    await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }), { id: panelId, range });
    await settle(page);
}

// What is drawn inside the visible window, and what the Samples item says.
async function state(page, panelId) {
    return page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const trace = plot.div.data[0];
        const panelEl = plot.div.closest('.layout-panel');
        pm._openMarksMenu(id, panelEl.querySelector('.timeseries-marks-btn'));
        const item = document.querySelector(`.timeseries-marks-menu[data-panel-id="${id}"] .marks-item-samples`);
        const menu = { waiting: !!item?.classList.contains('marks-waiting'), title: item?.title, checked: item?.getAttribute('aria-checked') };
        pm._closeMarksMenu();
        const [lo, hi] = plot.div.layout.xaxis.range.map(Number);
        const rows = [];
        for (let i = 0; i < trace.x.length; i++) {
            const x = Number(trace.x[i]);
            if (x >= lo && x <= hi) rows.push([x, Number(trace.y[i])]);
        }
        return {
            ...menu,
            mode: trace.mode,
            rows,
            dots: plot.div.querySelectorAll('.scatterlayer .trace .points path').length,
        };
    }, panelId);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const csv = makeCsv();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    const pages = {};
    for (const [name, limitMb] of [['memory', 4000], ['lazy', 10]]) {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
        const { panelId, lazy } = await open(page, baseUrl, csv, limitMb);
        assert.equal(lazy, name === 'lazy', `${name}: the file is ${name === 'lazy' ? 'in memory-saving mode' : 'in memory'}`);
        pages[name] = { page, panelId };
        await settle(page);
        await page.evaluate(id => window.app.plotManager._toggleSamples(id), panelId);
        await settle(page);
    }

    const both = async (label, range, check) => {
        const out = {};
        for (const name of ['memory', 'lazy']) {
            const { page, panelId } = pages[name];
            if (range) await zoom(page, panelId, range);
            out[name] = await state(page, panelId);
            check(out[name], `${label}, ${name}`);
        }
        return out;
    };
    const sameRows = (got, want, label) => {
        assert.equal(got.length, want.length, `${label}: as many rows (${got.length} vs ${want.length})`);
        got.forEach((row, i) => {
            assert.equal(row[0], want[i][0], `${label}: row ${i} at the same instant`);
            assert.equal(row[1], want[i][1], `${label}: row ${i} with the same value`);
        });
    };

    // Zoomed out: no dots, and the reason is the zoom — for the lazy file too.
    const out = await both('zoomed out', null, (s, label) => {
        assert.equal(s.checked, 'true', `${label}: Samples is on`);
        assert.equal(s.mode, 'lines', `${label}: no dots`);
        assert.equal(s.waiting, true, `${label}: the item waits`);
    });
    assert.equal(out.lazy.title, out.memory.title, 'the lazy file waits for the same reason: zoom in');

    // ~60 rows around the burst: dots, on the same rows.
    const inside = await both('zoomed in', [2000, 2000.6], (s, label) => {
        assert.equal(s.mode, 'lines+markers', `${label}: dots`);
        assert.equal(s.waiting, false, `${label}: not waiting`);
        assert.ok(s.dots >= 60, `${label}: a dot per row (${s.dots})`);
        assert.equal(s.rows.filter(row => row[0] === 2000.3).length, 3, `${label}: the three rows of the burst`);
    });
    sameRows(inside.lazy.rows, inside.memory.rows, 'zoomed in');

    // Panned inside the rows the lazy page already read: no new query.
    const queriesBefore = await pages.lazy.page.evaluate(() => {
        const source = [...window.app.plotManager.files.values()][0].data._duckdb.source;
        window.__rangeCalls = 0;
        const original = source._queryColumnsRange.bind(source);
        source._queryColumnsRange = (...args) => { window.__rangeCalls += 1; return original(...args); };
        return window.__rangeCalls;
    });
    assert.equal(queriesBefore, 0);
    const panned = await both('panned', [2000.2, 2000.8], (s, label) => {
        assert.equal(s.mode, 'lines+markers', `${label}: dots`);
    });
    sameRows(panned.lazy.rows, panned.memory.rows, 'panned');
    assert.equal(await pages.lazy.page.evaluate(() => window.__rangeCalls), 0, 'the rows already read are reused');

    // A window with more rows than have room: lines, in both.
    const wide = await both('zoomed half out', [1990, 2010], (s, label) => {
        assert.equal(s.mode, 'lines', `${label}: too many rows for dots`);
        assert.equal(s.waiting, true, `${label}: waiting again`);
    });
    sameRows(wide.lazy.rows, wide.memory.rows, 'zoomed half out (rows without dots)');

    await both('zoomed out again', [0, 4199.99], (s, label) => {
        assert.equal(s.mode, 'lines', `${label}: dots gone`);
        assert.equal(s.waiting, true, `${label}: waiting`);
    });

    assert.deepEqual(errors, [], 'no page error');
    console.log('Lazy sample markers: the same dots as in memory, on the rows of the file.');
} finally {
    await browser.close();
    await server.close();
}
