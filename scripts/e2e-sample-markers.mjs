// End-to-end check of the Samples toggle (docs/sample-markers-design.md) in a
// real browser: the unit tests judge the decision against numbers; this checks
// that the panel actually draws dots when, and only when, the view is zoomed in
// far enough, and says so when it is not.
//
// Scenario: one CSV, numeric time, 10 000 rows, with a burst of three rows at a
// single instant. The panel starts zoomed out: turning Samples on draws no dots,
// shows the "zoom in" pill once for ~3 s and leaves the button pressed but
// "waiting". Zoomed onto ~60 samples: dots, the burst's three rows all drawn,
// button no longer waiting. Zoomed back out: dots gone, button waiting again,
// and no pill this time. Stacking disables the button.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:sample-markers`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 10000;
const BURST_AT = 5030;   // rows 5030, 5031, 5032 share t = 50.30

function makeCsv() {
    const lines = ['time,v'];
    let t = 0;
    for (let i = 0; i < ROWS; i++) {
        if (i <= BURST_AT || i > BURST_AT + 2) t = i / 100;
        lines.push(`${t.toFixed(2)},${Math.sin(i / 50).toFixed(6)}`);
    }
    return { name: 'burst.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

async function state(page, panelId) {
    return page.evaluate((id) => {
        const plot = window.app.plotManager.plots.get(id);
        const trace = plot.div.data[0];
        const panelEl = plot.div.closest('.layout-panel');
        const pill = panelEl.querySelector('.samples-zoom-indicator.active');
        const btn = panelEl.querySelector('.timeseries-samples-btn');
        return {
            mode: trace.mode,
            points: trace.x.length,
            burstRows: Array.from(trace.x).filter(x => Math.abs(x - 50.3) < 1e-9).length,
            dots: plot.div.querySelectorAll('.scatterlayer .trace .points path').length,
            pill: pill ? pill.textContent : null,
            pressed: btn?.getAttribute('aria-pressed'),
            waiting: !!btn?.classList.contains('samples-waiting'),
            title: btn?.title,
            disabled: !!btn?.disabled,
        };
    }, panelId);
}

async function zoom(page, panelId, range) {
    await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }),
        { id: panelId, range });
    await page.waitForTimeout(400);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SAMPLE_MARKERS_SHOTS;
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'v', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(300);

    let s = await state(page, panelId);
    assert.equal(s.pressed, 'false', 'Samples starts off');
    assert.equal(s.mode, 'lines', 'off: a plain line');

    await page.locator(`.layout-panel[data-id="${panelId}"] .timeseries-samples-btn`).click();
    await page.waitForFunction(id => window.app.plotManager.plots.get(id).showSamples, panelId);
    await page.waitForTimeout(600);
    s = await state(page, panelId);
    assert.equal(s.pressed, 'true', 'Samples turned on');
    assert.equal(s.mode, 'lines', 'zoomed out: 10 000 samples are decimated, so no dots');
    assert.ok(s.pill, 'right after the click: the pill says to zoom in');
    assert.equal(s.waiting, true, 'and the button reads as waiting');
    assert.equal(s.title, s.pill, 'with the same reason in its tooltip');
    if (shots) await page.screenshot({ path: `${shots}/samples-zoomed-out.png` });
    await page.waitForTimeout(3200);
    s = await state(page, panelId);
    assert.equal(s.pill, null, 'the pill goes by itself');
    assert.equal(s.waiting, true, 'the button keeps saying it is waiting');
    if (shots) await page.screenshot({ path: `${shots}/samples-waiting.png` });

    await zoom(page, panelId, [50.0, 50.6]);
    s = await state(page, panelId);
    assert.equal(s.mode, 'lines+markers', 'zoomed onto ~60 samples: dots');
    assert.equal(s.pill, null, 'no pill once dots are on screen');
    assert.equal(s.waiting, false, 'button no longer waiting');
    assert.equal(s.burstRows, 3, 'all three rows at the repeated instant are drawn');
    assert.ok(s.dots >= 60, `one dot per sample (${s.dots})`);
    if (shots) await page.screenshot({ path: `${shots}/samples-zoomed-in.png` });

    await zoom(page, panelId, [0, 99.99]);
    s = await state(page, panelId);
    assert.equal(s.mode, 'lines', 'zoomed back out: dots gone');
    assert.equal(s.waiting, true, 'the button is waiting again');
    assert.equal(s.pill, null, 'but the pill does not come back on a zoom');

    await page.locator(`.layout-panel[data-id="${panelId}"] .timeseries-stack-btn`).click();
    await page.waitForTimeout(600);
    s = await state(page, panelId);
    assert.equal(s.disabled, true, 'stacked: the Samples button is disabled');
    assert.equal(s.pill, null, 'stacked: no pill either');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Sample markers end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
