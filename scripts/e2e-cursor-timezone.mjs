// End-to-end check of the A|B cursors on a date axis, in a real browser, in
// time zones other than UTC (#176).
//
// The unit tests run the cursor code against hand-made axis stubs, so they can
// only catch what their author already expected. #176 was Plotly's own
// behaviour: `d2p` on a date axis reads a number of ms in the browser's local
// zone, while the app keeps floating times (wall clock read as UTC). Outside
// UTC the cursor lines were drawn hours away from their samples, and CI, which
// runs in UTC, could not see it. This test drives the real app in Chromium with
// the browser clock set to several zones.
//
// Scenario (the one reported): one variable continued across three CSV files
// with datetime timestamps, one trace per file in a single panel, view zoomed
// onto the third file. For each zone it checks that
//   * turning cursors on picks the trace that is on screen (file 3);
//   * each cursor line sits where Plotly itself puts that time (`c2p`, which
//     works in the same floating ms as the data and does not depend on the
//     zone), and its dot sits on the curve;
//   * the same still holds after a right-button drag pan is released (the
//     lines used to vanish at that moment).
//
// Needs a Chromium for Playwright: `npx playwright install chromium`.
// Run with `npm run e2e:cursor-timezone`. Not part of test:release, which
// stays offline and browser-free; CI runs it as its own step.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ZONES = [
    { id: 'America/Argentina/Buenos_Aires', offsetMin: 180 },
    { id: 'Europe/Paris', offsetMin: -120 },
    { id: 'Asia/Tokyo', offsetMin: -540 },
    { id: 'UTC', offsetMin: 0 },
];

// 2026-09-01 is summer time in Paris, so the offsets above are fixed for it.
const BASE_MS = Date.UTC(2026, 8, 1, 10, 0, 0);
const ROWS_PER_FILE = 2000; // 1 s per row
const FILE_COUNT = 3;
const tempAt = (t, k) => 20 + 5 * Math.sin(t / 200) + 3 * k;

function pad(n) {
    return String(n).padStart(2, '0');
}

function floatingStamp(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
        + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function makeCsvFiles() {
    const files = [];
    for (let k = 0; k < FILE_COUNT; k++) {
        const lines = ['time,temp'];
        for (let i = 0; i < ROWS_PER_FILE; i++) {
            const t = k * ROWS_PER_FILE + i;
            lines.push(`${floatingStamp(BASE_MS + t * 1000)},${tempAt(t, k).toFixed(6)}`);
        }
        files.push({ name: `run${k + 1}.csv`, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') });
    }
    return files;
}

// The curve value at a floating-ms time, for the file that holds it.
function expectedTemp(ms, fileIndex) {
    const t = (ms - BASE_MS) / 1000;
    const t0 = Math.floor(t);
    const t1 = t0 + 1;
    const y0 = tempAt(t0, fileIndex);
    const y1 = tempAt(t1, fileIndex);
    return y0 + (y1 - y0) * (t - t0);
}

// Where the cursors are, and where Plotly says they should be.
async function readCursors(page, panelId) {
    return page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const div = plot.div;
        const xa = div._fullLayout.xaxis;
        const ya = div._fullLayout.yaxis;
        const overlay = div.querySelector('.cursor-plot-overlay');
        const px = el => (el ? parseFloat(el.style.left) : null);
        const py = el => (el ? parseFloat(el.style.top) : null);
        const fileName = fid => pm.files.get(fid)?.name || pm.files.get(fid)?.data?.name || fid;
        const out = {
            overlayShown: !!overlay && overlay.style.display !== 'none',
            plotLeft: xa._offset,
            plotRight: xa._offset + xa._length,
        };
        for (const key of ['a', 'b']) {
            const trace = plot.cursors[key === 'a' ? 'traceA' : 'traceB'];
            const x = plot.cursors[key];
            out[key] = {
                x,
                fileId: trace?.fileId,
                file: trace ? fileName(trace.fileId) : null,
                lineLeft: px(overlay?.querySelector(`.cursor-overlay-line-${key}`)),
                dotLeft: px(overlay?.querySelector(`.cursor-overlay-dot-${key}`)),
                dotTop: py(overlay?.querySelector(`.cursor-overlay-dot-${key}`)),
                plotlyLeft: xa._offset + xa.c2p(x),
                yOffset: ya._offset,
                yRange: ya.range.slice(),
                yLength: ya._length,
            };
        }
        return out;
    }, panelId);
}

function checkCursors(state, fileIds, label) {
    for (const key of ['a', 'b']) {
        assert.equal(state[key].fileId, fileIds[2],
            `${label}: cursor ${key} reads the trace on screen (file 3), got ${state[key].file}`);
    }
    assert.ok(state.overlayShown, `${label}: cursor overlay is shown`);
    for (const key of ['a', 'b']) {
        const c = state[key];
        assert.ok(Number.isFinite(c.x), `${label}: cursor ${key} has a position`);
        assert.ok(c.plotlyLeft >= state.plotLeft && c.plotlyLeft <= state.plotRight,
            `${label}: cursor ${key} is inside the visible range`);
        assert.notEqual(c.lineLeft, null, `${label}: cursor ${key} line is drawn`);
        assert.ok(Math.abs(c.lineLeft - c.plotlyLeft) <= 1,
            `${label}: cursor ${key} line at ${c.lineLeft}px, Plotly puts that time at ${c.plotlyLeft}px`);
        assert.notEqual(c.dotTop, null, `${label}: cursor ${key} dot is drawn`);
        assert.ok(Math.abs(c.dotLeft - c.plotlyLeft) <= 1, `${label}: cursor ${key} dot is on its line`);
        const y = expectedTemp(c.x, 2);
        const [y0, y1] = c.yRange;
        const expectedTop = c.yOffset + (1 - (y - y0) / (y1 - y0)) * c.yLength;
        assert.ok(Math.abs(c.dotTop - expectedTop) <= 1.5,
            `${label}: cursor ${key} dot at ${c.dotTop}px, the curve is at ${expectedTop.toFixed(1)}px`);
    }
}

async function runZone(browser, baseUrl, zone, csvFiles) {
    const context = await browser.newContext({ timezoneId: zone.id, viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));

        // Guard: the zone really is in effect, or the test proves nothing.
        const offset = await page.evaluate(() => new Date(Date.UTC(2026, 8, 1, 12)).getTimezoneOffset());
        assert.equal(offset, zone.offsetMin, `browser runs in ${zone.id}`);

        await page.setInputFiles('#file-input', csvFiles);
        await page.waitForFunction(n => window.app.plotManager.files.size === n, FILE_COUNT, { timeout: 60000 });

        const { panelId, fileIds } = await page.evaluate(() => {
            const app = window.app;
            const pm = app.plotManager;
            const panelEl = document.querySelector('.layout-panel');
            const id = panelEl.dataset.id;
            const nameOf = fid => pm.files.get(fid)?.name || pm.files.get(fid)?.data?.name || '';
            const ids = [...pm.files.keys()].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }));
            for (const fid of ids) {
                app.setActiveFile(fid);
                pm.addTrace(id, 'temp', panelEl);
            }
            return { panelId: id, fileIds: ids };
        });
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0
            && window.app.plotManager.plots.get(id).traces.length === 3, panelId);

        // Look at the third file only.
        const start3 = BASE_MS + 2 * ROWS_PER_FILE * 1000;
        await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }),
            { id: panelId, range: [floatingStamp(start3 + 600e3), floatingStamp(start3 + 1800e3)] });
        await page.waitForTimeout(300);

        await page.locator(`.layout-panel[data-id="${panelId}"] .cursor-btn`).click();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id).cursors?.enabled, panelId);
        await page.waitForTimeout(300);
        checkCursors(await readCursors(page, panelId), fileIds, `${zone.id}, cursors on`);

        // Right-button drag pan, then release: the lines must stay on the curve.
        const before = await readCursors(page, panelId);
        const box = await page.evaluate((id) => {
            const r = window.app.plotManager.plots.get(id).div.querySelector('.nsewdrag').getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        }, panelId);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: 'right' });
        for (let i = 1; i <= 10; i++) {
            await page.mouse.move(cx - i * 15, cy);
            await page.waitForTimeout(20);
        }
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(600);
        const after = await readCursors(page, panelId);
        assert.ok(Math.abs((before.a.lineLeft - after.a.lineLeft) - 150) <= 2,
            `${zone.id}: cursor A followed the 150px pan (${before.a.lineLeft} -> ${after.a.lineLeft})`);
        checkCursors(after, fileIds, `${zone.id}, after pan`);

        assert.deepEqual(errors, [], `${zone.id}: no page errors`);
        console.log(`  ok  ${zone.id}`);
    } finally {
        await context.close();
    }
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const address = server.httpServer.address();
const baseUrl = `http://127.0.0.1:${address.port}/`;
const browser = await chromium.launch();
try {
    const csvFiles = makeCsvFiles();
    for (const zone of ZONES) await runZone(browser, baseUrl, zone, csvFiles);
    console.log('Cursor time-zone end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
