// End-to-end check of the Repeated toggle
// (docs/repeated-timestamps-indicator-design.md) in a real browser.
//
// 1. A clean file: the button is disabled and says there is nothing to mark.
// 2. Numeric time, 10 000 rows, two bursts (t = 20 and t = 70). Turning
//    Repeated on turns Samples on with it. Zoomed out: a red bar per burst on
//    the top strip, with a hover. Zoomed in: the dots are drawn, the burst's
//    rows get red rings, and the strip is gone. Turning Repeated off turns the
//    Samples it switched on off again.
// 3. A datetime logger stamped to the second, ten rows a second (the case that
//    prompted the feature): zoomed out, one bar across the strip; zoomed in,
//    every row ringed, no bars.
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
        const ringWidths = Array.isArray(trace.marker?.line?.width) ? trace.marker.line.width : [];
        const samplesBtn = panelEl.querySelector('.timeseries-samples-btn');
        return {
            disabled: !!btn?.disabled,
            pressed: btn?.getAttribute('aria-pressed'),
            samplesPressed: samplesBtn?.getAttribute('aria-pressed'),
            waiting: !!btn?.classList.contains('repeated-waiting'),
            title: btn?.title,
            pill: pill ? pill.textContent : null,
            bars: (layout.shapes || []).filter(sh => sh.type === 'rect' && sh.y0 > 0.9).length,
            hovers: (plot._repeatedHoverMarks || []).map(m => ({ x: m.x, text: m.text })),
            rings: ringWidths.filter(w => w > 0).length,
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
    assert.equal(s.samplesPressed, 'true', 'Repeated turns Samples on with it');
    assert.equal(s.bars, 2, 'zoomed out: a red bar per burst on the strip');
    assert.deepEqual(s.hovers.map(m => m.x), [20, 70], 'each with a hover at its instant');
    assert.ok(s.hovers[1].text.includes('4'), `the t = 70 hover says 4 rows (${s.hovers[1].text})`);
    assert.equal(s.rings, 0, 'no dots zoomed out, so no rings');
    assert.equal(s.waiting, false);
    assert.equal(s.pill, null, 'no Repeated pill: something is drawn');
    await page.waitForTimeout(3200);
    if (shots) await page.screenshot({ path: `${shots}/repeated-zoomed-out.png` });

    // Hover over a bar shows its label (our own: shapes have no Plotly hover).
    const box = await page.evaluate((id) => {
        const div = window.app.plotManager.plots.get(id).div;
        const layout = div._fullLayout;
        const xa = layout.xaxis;
        const r = div.getBoundingClientRect();
        return { x: r.left + xa._offset + xa.l2p(xa.d2l(20)), y: r.top + layout._size.t + 4 };
    }, panelId);
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(200);
    const hoverText = await page.evaluate(() => {
        const label = document.querySelector('.repeated-hover-label');
        return label && label.style.display !== 'none' ? label.textContent : '';
    });
    assert.ok(hoverText.includes('3'), `hovering a bar shows its label (${hoverText})`);
    await page.mouse.move(box.x, box.y + 200);
    await page.waitForTimeout(100);
    const hidden = await page.evaluate(() => document.querySelector('.repeated-hover-label')?.style.display);
    assert.equal(hidden, 'none', 'and hides it away from the strip');

    await zoom(page, panelId, [19.7, 20.3]);
    s = await state(page, panelId);
    assert.equal(s.mode, 'lines+markers', 'zoomed in: dots');
    assert.equal(s.rings, 3, 'the three rows at t = 20 are ringed');
    assert.equal(s.bars, 0, 'and the strip gives way to the rings');
    if (shots) await page.screenshot({ path: `${shots}/repeated-rings.png` });

    await click(page, panelId, '.timeseries-repeated-btn');
    s = await state(page, panelId);
    assert.equal(s.pressed, 'false');
    assert.equal(s.samplesPressed, 'false', 'turning Repeated off turns off the Samples it turned on');
    assert.equal(s.bars, 0);

    // Samples the user had on stays on.
    await click(page, panelId, '.timeseries-samples-btn');
    await click(page, panelId, '.timeseries-repeated-btn');
    await click(page, panelId, '.timeseries-repeated-btn');
    s = await state(page, panelId);
    assert.equal(s.samplesPressed, 'true', 'Samples switched on by the user is left alone');

    // 3. Datetime logger, ten rows a second.
    ({ page, panelId } = await openPanel(context, errors, loggerCsv(), 'I'));
    await click(page, panelId, '.timeseries-repeated-btn');
    s = await state(page, panelId);
    assert.equal(s.bars, 1, 'zoomed out on 600 repeated seconds: one bar across the strip');
    assert.equal(s.waiting, false, 'the Repeated button does not wait: the bar says it');
    if (shots) await page.screenshot({ path: `${shots}/repeated-dense.png` });

    await zoom(page, panelId, ['2026-06-10 14:02:00', '2026-06-10 14:02:30']);
    s = await state(page, panelId);
    assert.equal(s.mode, 'lines+markers', 'zoomed in on 30 s: dots');
    assert.ok(s.rings >= 290, `every row shares its second with nine others: all ringed (${s.rings})`);
    assert.equal(s.bars, 0, 'no bars');
    if (shots) await page.screenshot({ path: `${shots}/repeated-logger.png` });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Repeated marks end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
