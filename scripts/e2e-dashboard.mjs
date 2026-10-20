// End-to-end check of the Dashboard mode (src/plots/methods/dashboard-methods.js)
// in a real browser:
//
//   - a time-series panel turned into a dashboard keeps its signals, as cards;
//     a text signal dropped on it gets a card too;
//   - the cards show the last value, or the one at the instant of the slider;
//     "Latest" goes back to following the last value;
//   - a card's title, colour and decimals are its own; its unit is the
//     signal's, and the plots show it too;
//   - cards are reordered by dragging one onto another;
//   - a Live Update append changes the values in place, without rebuilding
//     the cards;
//   - a saved view brings the dashboard back as it was, units included;
//   - turned back into a plot, the panel keeps the signals it can draw.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:dashboard`. Not part
// of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const lines = ['time,temp,pressure,flow,state'];
for (let i = 0; i < 300; i++) {
    lines.push(`${i / 10},${(20 + i * 0.01).toFixed(2)},${(1013 + i * 0.1).toFixed(2)},${(i % 7) * 0.5},${i % 2 ? 'ON' : 'OFF'}`);
}
const csv = { name: 'lab.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };

const cards = page => page.evaluate(() => [...document.querySelectorAll('.dashboard-card')].map(card => ({
    title: card.querySelector('.dashboard-card-title').textContent,
    value: card.querySelector('.dashboard-card-number').textContent,
    unit: card.querySelector('.dashboard-card-unit').textContent,
    foot: card.querySelector('.dashboard-card-foot').textContent,
    bg: card.style.backgroundColor,
})));

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [csv]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const panelId = await page.evaluate(() => {
        const app = window.app;
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        const panel = document.querySelector('.layout-panel');
        for (const name of ['temp', 'pressure', 'flow']) app.plotManager.addTrace(panel.dataset.id, name, panel);
        return panel.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, panelId);

    // ── A plot turned into a dashboard: its signals become cards ──
    await page.click(`.layout-panel[data-id="${panelId}"] .mode-btn[data-mode="dashboard"]`);
    await page.waitForSelector('.dashboard-card');
    let c = await cards(page);
    assert.deepEqual(c.map(card => card.title), ['temp', 'pressure', 'flow'], 'the plot\'s signals, in order');
    assert.equal(c[0].value, '22.99', 'the last value read');
    assert.equal(c[1].value, '1042.9');
    assert.match(c[0].foot, /29\.9/, 'and when it was read');
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id).div, panelId), null, 'nothing drawn by Plotly');

    // A text signal gets a card too.
    await page.evaluate(id => {
        const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager._addDroppedVariables(id, ['state'], panel);
    }, panelId);
    c = await cards(page);
    assert.equal(c.length, 4);
    assert.equal(c[3].value, 'ON', 'a text signal shows its text');

    // ── The time slider: the value at an instant; Latest goes back ──
    await page.evaluate(() => {
        const slider = document.querySelector('.dashboard-slider');
        slider.value = '0';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    c = await cards(page);
    assert.equal(c[0].value, '20', 'at the start: the first sample');
    assert.equal(c[3].value, 'OFF');
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id).dashboard.follow, panelId), false);
    await page.evaluate(() => {
        const slider = document.querySelector('.dashboard-slider');
        slider.value = '500';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    c = await cards(page);
    assert.equal(c[0].value, '21.49', 'at the middle (t = 14.95): the sample at 14.9, the last one before it');
    await page.click('.dashboard-latest-btn');
    c = await cards(page);
    assert.equal(c[0].value, '22.99', 'Latest: the last value again');

    // ── A card of its own: title, colour, decimals; the signal's unit ──
    await page.locator('.dashboard-card >> nth=0').hover();
    await page.click('.dashboard-card >> nth=0 >> .dashboard-card-edit');
    await page.fill('.dashboard-editor-title', 'Temperatura');
    await page.fill('.dashboard-editor-unit', '°C');
    await page.selectOption('.dashboard-editor-decimals', '1');
    await page.click('.dashboard-card-editor .dashboard-swatch >> nth=3');
    await page.click('.dashboard-editor-done');
    assert.equal(await page.locator('.dashboard-card-editor').count(), 0, 'Done closes the editor');
    c = await cards(page);
    assert.equal(c[0].title, 'Temperatura');
    assert.equal(c[0].value, '23.0', 'one decimal');
    assert.equal(c[0].unit, '°C');
    assert.equal(c[0].bg, 'rgb(255, 152, 0)', 'the colour picked');
    assert.equal(await page.evaluate(() => window.app.plotManager._varUnit('temp')), '°C', 'the unit is the signal\'s');

    // ── Reordering: the first card dropped on the right half of the third ──
    const target = await page.locator('.dashboard-card >> nth=2').boundingBox();
    await page.dragAndDrop('.dashboard-card >> nth=0', '.dashboard-card >> nth=2', {
        targetPosition: { x: target.width * 0.8, y: target.height / 2 },
    });
    c = await cards(page);
    assert.deepEqual(c.map(card => card.title), ['pressure', 'flow', 'Temperatura', 'state'], 'dragged after the third card');

    // ── Live Update: values change in place ──
    const firstCard = await page.evaluateHandle(() => document.querySelector('.dashboard-card'));
    await page.evaluate(() => {
        const app = window.app;
        const fileId = [...app.plotManager.files.keys()][0];
        const data = app.plotManager.files.get(fileId).data;
        const parsed = app.csvParser.parseRowsWithProfile('30,25.5,1050.25,1.5,OFF\n', data.metadata.csvProfile, { startRowIndex: 300 });
        app._appendLiveUpdateColumns(data, parsed);
        app._updateLiveUpdateMetadata(data, parsed.timeValues);
        app.plotManager.updateFileData(fileId, data, { liveAppend: true });
    });
    c = await cards(page);
    assert.equal(c[0].value, '1050.25', 'the appended row');
    assert.equal(c[2].value, '25.5');
    assert.match(c[0].foot, /\b30\b/);
    assert.equal(await page.evaluate(card => card.isConnected, firstCard), true, 'the cards were not rebuilt');

    // ── A saved view brings it all back ──
    await page.evaluate(id => window.app.plotManager._setDashboardSize(id, 'l'), panelId);
    const viewJson = await page.evaluate(() => JSON.stringify(window.app._createSessionSnapshot({ includeData: false })));
    const view = JSON.parse(viewJson);
    assert.deepEqual(view.files[0].unitOverrides, { temp: '°C' }, 'the unit is saved with the file');
    assert.equal(view.plots[0].mode, 'dashboard');
    assert.equal(view.plots[0].dashboard.size, 'l');
    assert.equal(view.plots[0].traces[2].card.title, 'Temperatura');
    await page.evaluate(() => {
        window.app.plotManager.setUnitOverrides([...window.app.plotManager.files.keys()][0], {});
        window.app.plotManager.clearAll?.();
    });
    assert.equal(await page.evaluate(() => window.app.plotManager._varUnit('temp')), '', 'the file\'s own unit back');
    const applying = page.evaluate(json => window.app.loadSessionOrProjectFile(new File([json], 'view.json')), viewJson);
    await page.waitForSelector('.modal-dialog-alert');
    await page.click('.modal-dialog-alert .modal-btn');
    assert.equal(await applying, true);
    await page.waitForSelector('.dashboard-card');
    c = await cards(page);
    assert.deepEqual(c.map(card => card.title), ['pressure', 'flow', 'Temperatura', 'state'], 'the cards, in their order');
    assert.equal(c[2].unit, '°C', 'with the unit');
    assert.equal(c[2].bg, 'rgb(255, 152, 0)', 'and the colour');
    assert.equal(await page.evaluate(() => document.querySelector('.dashboard-grid').classList.contains('size-l')), true, 'and the size');

    // ── Back to a plot: the signals it can draw ──
    const restoredId = await page.evaluate(() => document.querySelector('.layout-panel').dataset.id);
    await page.click(`.layout-panel[data-id="${restoredId}"] .mode-btn[data-mode="timeseries"]`);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, restoredId);
    const traces = await page.evaluate(id => window.app.plotManager.plots.get(id).traces.map(t => t.varName), restoredId);
    assert.deepEqual(traces, ['pressure', 'flow', 'temp'], 'the text signal stays behind');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Dashboard end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
