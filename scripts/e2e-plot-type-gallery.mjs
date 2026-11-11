// End-to-end check of the plot-type gallery of a panel
// (plots/methods/marks-methods.js, plots/plot-type-gallery.js), in a real
// browser.
//
// What a panel draws is one button of its toolbar, which names the type that
// is on, and a gallery behind it: a card per type with a drawing and a line
// that says what it draws. A card switches the panel; an analysis is still a
// time series; one menu of the toolbar is open at a time.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:plot-type-gallery`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

import { PLOT_TYPES } from '../src/plots/plot-type-gallery.js';

function makeCsv() {
    const lines = ['time,y'];
    for (let i = 0; i < 800; i++) lines.push(`${i},${Math.sin(i / 30).toFixed(4)}`);
    return { name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const plotOf = (page, index = 0) => page.evaluate((i) => {
    const panel = document.querySelectorAll('.layout-panel')[i];
    const plot = window.app.plotManager.plots.get(panel.dataset.id);
    return { mode: plot?.mode, dim: plot?.stateAnimDim, traces: plot?.traces?.length ?? 0 };
}, index);
const typeButton = (page, index = 0) => page.locator('.layout-panel').nth(index).locator('.plot-type-btn');
const focused = page => page.evaluate(() => document.activeElement?.dataset?.mark);
async function pick(page, index, key) {
    await typeButton(page, index).click();
    await page.locator(`.panel-type-menu .analysis-card[data-mark="${key}"]`).click();
    await page.waitForFunction(() => !document.querySelector('.panel-type-menu'));
    await page.waitForFunction(([i, k]) => document.querySelectorAll('.layout-panel')[i].querySelector('.plot-type-btn')?.dataset.plotType === k, [index, key]);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });

    // An empty panel already says what it would draw, and offers the rest.
    assert.equal(await typeButton(page).getAttribute('data-plot-type'), 'timeseries');
    assert.equal(await page.locator('.layout-panel .mode-btn').count(), 0, 'no row of type buttons');

    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'y', panelEl);
    });
    await page.waitForFunction(() => document.querySelector('.layout-panel .js-plotly-plot'));

    // The gallery: a card per type, each with its drawing and its line.
    await typeButton(page).click();
    const cards = page.locator('.panel-type-menu .analysis-card');
    assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.mark)), PLOT_TYPES.map(type => type.key));
    for (const card of await cards.all()) {
        assert.equal(await card.locator('.analysis-card-art svg').count(), 1);
        assert.ok((await card.locator('.analysis-card-name').innerText()).trim());
        const desc = (await card.locator('.analysis-card-desc').innerText()).trim();
        assert.ok(desc && !desc.startsWith('plotTypeDesc_'), `a translated description (${desc})`);
    }
    assert.equal(await page.locator('.panel-type-menu .analysis-card.checked').getAttribute('data-mark'), 'timeseries');
    assert.equal(await focused(page), 'timeseries', 'it opens on the type that is on');
    const box = await page.locator('.panel-type-menu').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1366 && box.y + box.height <= 768, 'inside the window');

    // Keyboard: End, then Escape leaves without changing anything.
    await page.keyboard.press('End');
    assert.equal(await focused(page), 'state-anim-3');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.panel-type-menu').count(), 0);
    assert.equal((await plotOf(page)).mode, 'timeseries');

    // One menu at a time: opening Analysis closes the types, and back.
    await typeButton(page).click();
    await page.locator('.timeseries-analysis-menu-btn').click();
    assert.equal(await page.locator('.panel-type-menu').count(), 0);
    assert.equal(await page.locator('.panel-analysis-menu').count(), 1);
    assert.equal(await typeButton(page).getAttribute('aria-expanded'), 'false');

    // An analysis is still a time series.
    await page.locator('.analysis-card.marks-item-fft').click();
    await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
    assert.equal((await plotOf(page)).mode, 'fft');
    assert.equal(await typeButton(page).getAttribute('data-plot-type'), 'timeseries');
    await typeButton(page).click();
    assert.equal(await page.locator('.panel-type-menu .analysis-card.checked').getAttribute('data-mark'), 'timeseries');
    // ...and its card goes back to the plain time series.
    await page.locator('.panel-type-menu .analysis-card[data-mark="timeseries"]').click();
    await page.waitForFunction(() => !document.querySelector('.panel-type-menu'));
    assert.equal((await plotOf(page)).mode, 'timeseries');

    // The dashboard and back: the signals stay.
    await pick(page, 0, 'dashboard');
    assert.deepEqual(await plotOf(page), { mode: 'dashboard', dim: (await plotOf(page)).dim, traces: 1 });
    await pick(page, 0, 'timeseries');
    assert.equal((await plotOf(page)).traces, 1);

    // A second, empty panel through the other types.
    await page.evaluate(() => window.app.layoutManager.splitPanel(document.querySelector('.layout-panel').dataset.id, 'h', false));
    await page.waitForFunction(() => document.querySelectorAll('.layout-panel').length === 2);
    for (const type of PLOT_TYPES.filter(t => !['timeseries', 'dashboard'].includes(t.key))) {
        await pick(page, 1, type.key);
        const plot = await plotOf(page, 1);
        assert.equal(plot.mode, type.mode, `${type.key}: the panel is of that type`);
        if (type.dim) assert.equal(plot.dim, type.dim, `${type.key}: with its dimension`);
        assert.equal((await typeButton(page, 1).innerText()).trim(), `${type.short} ▾`, `${type.key}: the button names it`);
    }
    assert.equal((await plotOf(page, 0)).mode, 'timeseries', 'the other panel is left alone');
    // The gallery of the lower panel stays inside the window.
    await typeButton(page, 1).click();
    const lowerBox = await page.locator('.panel-type-menu').boundingBox();
    assert.ok(lowerBox.y >= 0 && lowerBox.y + lowerBox.height <= 768, 'the lower panel\'s gallery fits the window');
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, []);
    console.log('plot type gallery: ok');
} finally {
    await browser.close();
    await server.close();
}
