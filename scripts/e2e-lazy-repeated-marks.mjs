// End-to-end check of the Repeated toggle on a file read in memory-saving
// (lazy) mode, against the same file held in memory, in a real browser with
// the DuckDB-WASM the app ships (docs/repeated-timestamps-indicator-design.md,
// "Lazy files").
//
// The marks come from the runs of the time column: consecutive rows at one
// instant. In memory the column is there. A lazy file has an overview, not its
// rows, so the item used to wait with "not marked yet for files loaded in
// memory-saving mode". Now DuckDB finds the runs in the file.
//
// One CSV of 12 MB (420 000 rows, numeric time, repeated instants here and
// there, one of them three rows long) is opened twice: whole in one page,
// lazily in another. In both, Repeated is turned on and the view goes through
// the same windows:
//   · zoomed out: the red bars along the top are the same bars, and their
//     hover says the same;
//   · a narrower window: the same again;
//   · zoomed onto ~60 rows: no bars, and the dots of the repeated rows are
//     ringed — the same rings, with the same "×3 at this instant";
//   · zoomed back out: the bars are back.
// And a lazy file with no repeated instant: turned on, the item ends up saying
// there are none, and can still be turned off.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-repeated-marks`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
import { createServer } from 'vite';

const ROWS = 420000;
const BURST_AT = 200030;   // rows 200030, 200031, 200032 share t = 2000.30

function makeCsv(repeats = true) {
    const lines = ['time,v,w'];
    let t = 0;
    for (let i = 0; i < ROWS; i++) {
        const held = repeats && (i === BURST_AT + 1 || i === BURST_AT + 2 || (i % 9973 === 12) || (i % 31013 === 5));
        if (!held) t = i / 100;
        lines.push(`${t.toFixed(2)},${(Math.sin(i / 50) + (i % 7) / 100).toFixed(6)},${(i / 1000).toFixed(6)}`);
    }
    return { name: repeats ? 'repeats-large.csv' : 'plain-large.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
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

// Everything the view asked the file for has been drawn.
async function settle(page, panelId) {
    await page.waitForTimeout(300);
    await page.evaluate(() => window.app.plotManager._lastLazyRefresh);
    await page.waitForFunction((id) => {
        const plot = window.app.plotManager.plots.get(id);
        const reading = [...(plot._repeatedLazy?.values() || [])].some(entry => entry.pendingKey);
        return !reading && !document.querySelector('.lazy-detail-indicator.active:not(.samples-zoom-indicator):not(.repeated-hint-indicator)');
    }, panelId, { timeout: 120000 });
    await page.waitForTimeout(300);
}

async function zoom(page, panelId, range) {
    await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }), { id: panelId, range });
    await settle(page, panelId);
}

async function state(page, panelId) {
    return page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const trace = plot.div.data[0];
        const panelEl = plot.div.closest('.layout-panel');
        pm._openMarksMenu(id, panelEl.querySelector('.timeseries-marks-btn'));
        const item = document.querySelector(`.timeseries-marks-menu[data-panel-id="${id}"] .marks-item-repeated`);
        const menu = { waiting: !!item?.classList.contains('marks-waiting'), title: item?.title, checked: item?.getAttribute('aria-checked'), disabled: !!item?.disabled };
        pm._closeMarksMenu();
        const [lo, hi] = plot.div.layout.xaxis.range.map(Number);
        const rings = [];
        const widths = Array.isArray(trace.marker?.line?.width) ? trace.marker.line.width : [];
        for (let i = 0; i < trace.x.length; i++) {
            const x = Number(trace.x[i]);
            if (x >= lo && x <= hi && widths[i] > 0) rings.push([x, Number(trace.y[i]), String(trace.text?.[i] ?? '')]);
        }
        return {
            ...menu,
            mode: trace.mode,
            bars: (plot._repeatedShapes || []).map(shape => [Number(shape.x0), Number(shape.x1)]),
            drawnBars: (plot.div.layout.shapes || []).filter(shape => shape.y1 === 1 && shape.y0 === 0.985).length,
            hover: (plot._repeatedHoverMarks || []).map(mark => [Number(mark.x), mark.text]),
            rings,
            template: String(trace.hovertemplate || ''),
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
        await settle(page, panelId);
        // The same view in both: the whole file.
        await zoom(page, panelId, [0, 4199.99]);
        const before = await state(page, panelId);
        assert.equal(before.disabled, false, `${name}: the item can be turned on`);
        await page.evaluate(id => window.app.plotManager._toggleRepeated(id), panelId);
        await settle(page, panelId);
    }

    const both = async (label, range, check) => {
        const out = {};
        for (const name of ['memory', 'lazy']) {
            const { page, panelId } = pages[name];
            if (range) await zoom(page, panelId, range);
            out[name] = await state(page, panelId);
            check(out[name], `${label}, ${name}`);
        }
        assert.deepEqual(out.lazy.bars, out.memory.bars, `${label}: the same bars`);
        assert.deepEqual(out.lazy.hover, out.memory.hover, `${label}: the same hover marks`);
        assert.deepEqual(out.lazy.rings, out.memory.rings, `${label}: the same rings`);
        assert.equal(out.lazy.title, out.memory.title, `${label}: the item says the same`);
        return out;
    };

    const out = await both('zoomed out', null, (s, label) => {
        assert.equal(s.checked, 'true', `${label}: Repeated is on`);
        assert.equal(s.waiting, false, `${label}: not waiting`);
        assert.ok(s.bars.length > 30, `${label}: bars along the top (${s.bars.length})`);
        assert.equal(s.drawnBars, s.bars.length, `${label}: all of them drawn`);
        assert.equal(s.rings.length, 0, `${label}: no rings without dots`);
    });
    assert.ok(out.lazy.hover.some(([, text]) => /3/.test(text)), 'a hover that names the run of three');

    await both('a narrower window', [1500, 2600], (s, label) => {
        assert.ok(s.bars.length > 5, `${label}: bars (${s.bars.length})`);
        assert.equal(s.drawnBars, s.bars.length, `${label}: drawn`);
    });

    const inside = await both('zoomed in', [2000, 2000.6], (s, label) => {
        assert.equal(s.mode, 'lines+markers', `${label}: dots`);
        assert.equal(s.bars.length, 0, `${label}: the dotted file is off the strip`);
        assert.equal(s.rings.length, 3, `${label}: the three rows of the instant are ringed`);
        assert.ok(s.rings.every(ring => ring[0] === 2000.3 && /3/.test(ring[2])), `${label}: and say ×3`);
        assert.ok(s.template.includes('%{text}'), `${label}: the hover carries it`);
    });
    assert.equal(inside.lazy.rings.length, 3);

    await both('zoomed out again', [0, 4199.99], (s, label) => {
        assert.equal(s.mode, 'lines', `${label}: dots gone`);
        assert.ok(s.bars.length > 30, `${label}: the bars are back (${s.bars.length})`);
        assert.equal(s.drawnBars, s.bars.length, `${label}: drawn`);
    });

    // Turned off: nothing left, in both.
    for (const name of ['memory', 'lazy']) {
        const { page, panelId } = pages[name];
        await page.evaluate(id => window.app.plotManager._toggleRepeated(id), panelId);
        await settle(page, panelId);
        const s = await state(page, panelId);
        assert.equal(s.checked, 'false', `${name}: off`);
        assert.equal(s.drawnBars, 0, `${name}: no bars left`);
    }

    // A lazy file with no repeated instant.
    {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(`plain: ${e.message}`));
        const { panelId, lazy } = await open(page, baseUrl, makeCsv(false), 10);
        assert.equal(lazy, true);
        await settle(page, panelId);
        let s = await state(page, panelId);
        assert.equal(s.disabled, false, 'not read yet: the item can be turned on');
        await page.evaluate(id => window.app.plotManager._toggleRepeated(id), panelId);
        await settle(page, panelId);
        s = await state(page, panelId);
        assert.equal(s.checked, 'true');
        assert.equal(s.bars.length, 0, 'nothing to mark');
        assert.match(s.title, /No repeated/i, 'and the item says there are none');
        assert.equal(s.disabled, false, 'while it is on it can be turned off');
        await page.evaluate(id => window.app.plotManager._toggleRepeated(id), panelId);
        await settle(page, panelId);
        s = await state(page, panelId);
        assert.equal(s.checked, 'false');
        assert.equal(s.disabled, true, 'off, it is disabled like an in-memory file with none');
    }

    assert.deepEqual(errors, [], 'no page error');
    console.log('Lazy repeated marks: the same bars, hovers and rings as in memory.');
} finally {
    await browser.close();
    await server.close();
}
