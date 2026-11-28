// End-to-end check that the ticks of a calendar time axis never all read the
// same, in a real browser.
//
// A calendar axis labelled its ticks "%H:%M" whatever the span, so a record of
// under a minute — or a long one zoomed down to a few seconds — showed "08:00"
// on every tick. The format now follows the step Plotly picks between ticks
// (tickformatstops, `getCalendarTimeFormats` in
// src/plots/methods/data-methods.js): seconds under a minute, fractions of a
// second under a second, and the hours and minutes of before for the rest.
// Only Plotly knows the step it picks, so this is checked on the drawn labels:
//   * a 40-second file, one row per second: every tick label differs and
//     carries its seconds;
//   * a two-hour file: hours and minutes as before; zoomed to six seconds,
//     seconds; to half a second, fractions; zoomed back out, hours and minutes
//     again;
//   * the same with the AM/PM clock.
//
// Needs a Chromium for Playwright: `npx playwright install chromium`.
// Run with `npm run e2e:calendar-tick-seconds`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
import { createServer } from 'vite';

const pad = n => String(n).padStart(2, '0');
const stamp = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
        + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const csv = (name, startMs, rows) => {
    const lines = ['time,temp'];
    for (let i = 0; i < rows; i++) lines.push(`${stamp(startMs + i * 1000)},${(20 + 5 * Math.sin(i / 7)).toFixed(4)}`);
    return { name, mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) };
};

const SHORT_START = Date.UTC(2026, 2, 2, 8, 0, 0);
const LONG_START = Date.UTC(2026, 2, 2, 8, 0, 0);
const SHORT = csv('forty-seconds.csv', SHORT_START, 40);
const LONG = csv('two-hours.csv', LONG_START, 7200);

// The first line of every x tick label drawn (the second line is the date,
// which Plotly writes only where it changes).
async function tickLabels(page, panelId) {
    return page.evaluate((id) => {
        const div = window.app.plotManager.plots.get(id).div;
        return [...div.querySelectorAll('.xaxislayer-above .xtick text')].map((text) => {
            const line = text.querySelector('tspan.line');
            return (line || text).textContent.trim();
        });
    }, panelId);
}

function assertDistinct(labels, pattern, label) {
    assert.ok(labels.length >= 2, `${label}: at least two ticks are drawn (${JSON.stringify(labels)})`);
    assert.equal(new Set(labels).size, labels.length, `${label}: every tick reads differently (${JSON.stringify(labels)})`);
    for (const text of labels) assert.match(text, pattern, `${label}: "${text}"`);
}

async function plotFile(page, baseUrl, file) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        const panelEl = document.querySelector('.layout-panel');
        window.app.plotManager.addTrace(panelEl.dataset.id, 'temp', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0
        && window.app.plotManager.plots.get(id).div._fullLayout.xaxis.type === 'date', panelId);
    await page.waitForTimeout(300);
    return panelId;
}

async function zoomTo(page, panelId, fromMs, toMs) {
    const iso = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    await page.evaluate(({ id, range }) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': range }),
        { id: panelId, range: [iso(fromMs), iso(toMs)] });
    await page.waitForTimeout(400);
}

async function setAmPm(page, panelId) {
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const fileId = pm.plots.get(id).traces[0].fileId;
        window.app._updateFileTransform(fileId, { calendarTimeFormat: 'ampm' }, { rerender: true });
    }, panelId);
    await page.waitForFunction(id => /%p/.test(window.app.plotManager.plots.get(id).div.layout.xaxis.tickformat || ''), panelId);
    await page.waitForTimeout(300);
}

const HM = /^\d\d:\d\d$/;
const HMS = /^\d\d:\d\d:\d\d$/;
const HMS_FRACTION = /^\d\d:\d\d:\d\d\.\d+$/;
const AMPM_HM = /^\d{1,2}:\d\d [AP]M$/;
const AMPM_HMS = /^\d{1,2}:\d\d:\d\d [AP]M$/;
const AMPM_HMS_FRACTION = /^\d{1,2}:\d\d:\d\d\.\d+ [AP]M$/;

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // A record of under a minute.
    let panelId = await plotFile(page, baseUrl, SHORT);
    assertDistinct(await tickLabels(page, panelId), HMS, '40 s file');
    await setAmPm(page, panelId);
    assertDistinct(await tickLabels(page, panelId), AMPM_HMS, '40 s file, AM/PM');
    console.log('  ok  a 40-second file names its seconds');

    // A long record, zoomed in and back out.
    panelId = await plotFile(page, baseUrl, LONG);
    const whole = await tickLabels(page, panelId);
    assertDistinct(whole, HM, '2 h file, whole');
    const mid = LONG_START + 3600e3;
    await zoomTo(page, panelId, mid, mid + 6000);
    assertDistinct(await tickLabels(page, panelId), HMS, '2 h file, zoomed to 6 s');
    await zoomTo(page, panelId, mid, mid + 500);
    assertDistinct(await tickLabels(page, panelId), HMS_FRACTION, '2 h file, zoomed to 0.5 s');
    await zoomTo(page, panelId, mid, mid + 2);
    assertDistinct(await tickLabels(page, panelId), HMS_FRACTION, '2 h file, zoomed to 2 ms');
    await zoomTo(page, panelId, LONG_START, LONG_START + 7199e3);
    assert.deepEqual(await tickLabels(page, panelId), whole, '2 h file: zooming back out returns the hours and minutes');
    console.log('  ok  a two-hour file follows the zoom, in and back out');

    await setAmPm(page, panelId);
    assertDistinct(await tickLabels(page, panelId), AMPM_HM, '2 h file, AM/PM, whole');
    await zoomTo(page, panelId, mid, mid + 6000);
    assertDistinct(await tickLabels(page, panelId), AMPM_HMS, '2 h file, AM/PM, zoomed to 6 s');
    await zoomTo(page, panelId, mid, mid + 500);
    assertDistinct(await tickLabels(page, panelId), AMPM_HMS_FRACTION, '2 h file, AM/PM, zoomed to 0.5 s');
    console.log('  ok  the AM/PM clock does the same');

    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
    console.log('Calendar tick seconds end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
