// End-to-end check of the Repeated toggle
// (docs/repeated-timestamps-indicator-design.md) in a real browser.
//
// 1. A clean file: the button is disabled and says there is nothing to mark.
// 2. Numeric time, 10 000 rows, two bursts (t = 20 and t = 70): zoomed out,
//    one mark per burst on the top strip, with a hover; zoomed in, a guide line
//    too; with Samples on as well, the burst's dots get rings.
// 3. A datetime logger stamped to the second, ten rows a second (the case that
//    prompted the feature): zoomed out, too dense to mark — the strip is washed,
//    the button waits and the pill shows once; zoomed in, one mark per second,
//    placed on the date axis where the rows are.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:repeated-marks`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function csv(name, lines) {
    return { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

function cleanCsv() {
    const lines = ['time,v'];
    for (let i = 0; i < 500; i++) lines.push(`${(i / 10).toFixed(1)},${Math.sin(i / 20).toFixed(5)}`);
    return csv('clean.csv', lines);
}

function burstCsv() {
    const lines = ['time,v'];
    for (let i = 0; i < 10000; i++) {
        let t = i / 100;
        if (i >= 2000 && i <= 2002) t = 20;       // 3 rows at t = 20
        if (i >= 7000 && i <= 7003) t = 70;       // 4 rows at t = 70
        lines.push(`${t.toFixed(2)},${Math.sin(i / 50).toFixed(6)}`);
    }
    return csv('burst.csv', lines);
}

function loggerCsv() {
    const lines = ['Date Time,I'];
    const base = Date.UTC(2026, 5, 10, 14, 0, 0);
    const pad = n => String(n).padStart(2, '0');
    for (let i = 0; i < 6000; i++) {
        const d = new Date(base + Math.floor(i / 10) * 1000);
        const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
            + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        lines.push(`${stamp},${(14 + Math.sin(i / 300)).toFixed(4)}`);
    }
    return csv('logger.csv', lines);
}

// Each case gets a fresh page with just its file, so nothing carries over.
async function openPanel(context, errors, file, variable) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate((name) => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, name, panelEl);
        return panelEl.dataset.id;
    }, variable);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(400);
    // A datetime column with repeats announces itself on load; that dialog is
    // not what is under test here.
    const modalButton = page.locator('.modal-overlay.show button').first();
    if (await modalButton.count()) {
        await modalButton.click();
        await page.waitForTimeout(300);
    }
    return { page, panelId };
}

async function state(page, panelId) {
    return page.evaluate((id) => {
        const plot = window.app.plotManager.plots.get(id);
        const layout = plot.div.layout;
        const panelEl = plot.div.closest('.layout-panel');
        const btn = panelEl.querySelector('.timeseries-repeated-btn');
        const pill = panelEl.querySelector('.repeated-hint-indicator.active');
        const trace = plot.div.data[0];
        const symbols = Array.isArray(trace.marker?.symbol) ? trace.marker.symbol : [];
        return {
            disabled: !!btn?.disabled,
            pressed: btn?.getAttribute('aria-pressed'),
            waiting: !!btn?.classList.contains('repeated-waiting'),
            title: btn?.title,
            pill: pill ? pill.textContent : null,
            marks: (layout.annotations || []).map(a => ({ x: a.x, text: a.text, hover: a.hovertext })),
            guides: (layout.shapes || []).filter(s => s.type === 'line').length,
            washes: (layout.shapes || []).filter(s => s.type === 'rect' && s.y0 > 0.9).length,
            rings: symbols.filter(s => s === 'circle-open-dot').length,
            mode: trace.mode,
        };
    }, panelId);
}

async function click(page, panelId, selector) {
    await page.locator(`.layout-panel[data-id="${panelId}"] ${selector}`).click();
    await page.waitForTimeout(700);
}

async function zoom(page, panelId, range) {
    await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }),
        { id: panelId, range });
    await page.waitForTimeout(500);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.REPEATED_MARKS_SHOTS;
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const errors = [];

    // 1. Clean file.
    let { page, panelId } = await openPanel(context, errors, cleanCsv(), 'v');
    let s = await state(page, panelId);
    assert.equal(s.disabled, true, 'clean file: Repeated is disabled');
    assert.ok(s.title && s.title !== 'Repeated', `and says why (${s.title})`);

    // 2. Numeric bursts.
    ({ page, panelId } = await openPanel(context, errors, burstCsv(), 'v'));
    s = await state(page, panelId);
    assert.equal(s.disabled, false, 'bursts: Repeated is available');
    await click(page, panelId, '.timeseries-repeated-btn');
    s = await state(page, panelId);
    assert.equal(s.pressed, 'true');
    assert.deepEqual(s.marks.map(m => m.x), [20, 70], 'zoomed out: one mark per burst, at its instant');
    assert.ok(s.marks.every(m => m.text === '▼' && m.hover), 'marks are triangles with a hover');
    assert.ok(s.marks[1].hover.includes('4'), `the t = 70 mark says 4 rows (${s.marks[1].hover})`);
    assert.equal(s.waiting, false);
    assert.equal(s.pill, null, 'marks drawn: no pill');
    if (shots) await page.screenshot({ path: `${shots}/repeated-zoomed-out.png` });

    // Hover over a mark shows its label.
    const box = await page.evaluate((id) => {
        const el = window.app.plotManager.plots.get(id).div.querySelector('.annotation');
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, panelId);
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(300);
    const hoverText = await page.evaluate((id) => window.app.plotManager.plots.get(id).div.querySelector('.hoverlayer')?.textContent || '', panelId);
    assert.ok(hoverText.includes('3'), `hovering a mark shows its label (${hoverText})`);

    await zoom(page, panelId, [19.7, 20.3]);
    s = await state(page, panelId);
    assert.deepEqual(s.marks.map(m => m.x), [20]);
    assert.equal(s.guides, 1, 'zoomed in: a guide line down from the mark');

    await click(page, panelId, '.timeseries-samples-btn');
    await zoom(page, panelId, [19.7, 20.3]);
    s = await state(page, panelId);
    assert.equal(s.mode, 'lines+markers', 'Samples: dots');
    assert.equal(s.rings, 3, 'the three rows at t = 20 are ringed');
    if (shots) await page.screenshot({ path: `${shots}/repeated-rings.png` });

    // 3. Datetime logger, ten rows a second.
    ({ page, panelId } = await openPanel(context, errors, loggerCsv(), 'I'));
    await click(page, panelId, '.timeseries-repeated-btn');
    s = await state(page, panelId);
    assert.ok(s.washes >= 1, 'zoomed out on 600 repeated seconds: a wash on the strip');
    assert.equal(s.marks.length, 0, 'no individual marks');
    assert.equal(s.waiting, true, 'the button waits');
    assert.ok(s.pill, 'and the pill says why, once');
    if (shots) await page.screenshot({ path: `${shots}/repeated-dense.png` });

    await zoom(page, panelId, ['2026-06-10 14:02:00', '2026-06-10 14:02:30']);
    s = await state(page, panelId);
    assert.equal(s.washes, 0);
    assert.ok(s.marks.length >= 29 && s.marks.length <= 31, `zoomed in: one mark per second (${s.marks.length})`);
    assert.equal(s.waiting, false, 'not waiting any more');
    assert.equal(s.pill, null, 'and the pill does not come back');
    const first = String(s.marks[0].x);
    assert.ok(first.startsWith('2026-06-10') && first.includes('14:02:0'), `marks sit on the date axis (${first})`);
    assert.ok(s.marks[0].hover.includes('10'), 'each second holds ten rows');
    assert.equal(s.guides, 0, 'a repeat every second: no guide lines, they would hide the curve');
    if (shots) await page.screenshot({ path: `${shots}/repeated-logger.png` });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Repeated marks end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
