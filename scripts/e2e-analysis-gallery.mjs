// End-to-end check of the Analysis gallery of a time-series panel
// (plots/methods/marks-methods.js, plots/analysis-gallery.js), in a real
// browser.
//
// The Analysis button carries the accent colour and, until its menu has been
// opened once, a nudge. The menu is a gallery: a card per analysis, with a
// drawing and a line that says what it shows, the one that is on marked. A
// card switches the panel to its analysis; the first one goes back to the
// time series. The gallery stays inside the window, opening above the button
// of a lower panel.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:analysis-gallery`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,y'];
    const start = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 1500; i++) {
        const stamp = new Date(start + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
        lines.push(`${stamp},${Math.sin(i / 30).toFixed(4)}`);
    }
    return { name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const ORDER = ['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile', 'integral'];
const modeOf = (page, index = 0) => page.evaluate((i) => {
    const panel = document.querySelectorAll('.layout-panel')[i];
    return window.app.plotManager.plots.get(panel.dataset.id)?.mode;
}, index);
const insideWindow = async (page) => {
    const box = await page.locator('.panel-analysis-menu').boundingBox();
    const size = page.viewportSize();
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
};

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const load = async () => {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
        await page.setInputFiles('#file-input', [makeCsv()]);
        await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        await page.evaluate(() => {
            const app = window.app;
            const panelEl = document.querySelector('.layout-panel');
            app.setActiveFile([...app.plotManager.files.keys()][0]);
            app.plotManager.addTrace(panelEl.dataset.id, 'y', panelEl);
        });
        await page.locator('.timeseries-analysis-menu-btn').first().waitFor();
    };
    await load();
    const button = page.locator('.timeseries-analysis-menu-btn').first();

    // The button: never opened, so it nudges.
    assert.equal(await button.evaluate(node => node.classList.contains('analysis-nudge')), true);
    assert.equal(await button.getAttribute('aria-pressed'), 'false');

    // The gallery: a card per analysis, each with its drawing and its line.
    await button.click();
    const cards = page.locator('.panel-analysis-menu .analysis-card');
    assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.mark)), ORDER);
    for (const card of await cards.all()) {
        assert.equal(await card.locator('.analysis-card-art svg').count(), 1);
        assert.ok((await card.locator('.analysis-card-name').innerText()).trim());
        const desc = (await card.locator('.analysis-card-desc').innerText()).trim();
        assert.ok(desc && !desc.startsWith('analysisDesc_'), `a translated description (${desc})`);
    }
    assert.equal(await page.locator('.analysis-card.checked').getAttribute('data-mark'), 'timeseries');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.mark), 'timeseries', 'it opens on the one that is on');
    assert.equal(await insideWindow(page), true);
    // Opening it is finding it: the nudge is over, here and from now on.
    assert.equal(await button.evaluate(node => node.classList.contains('analysis-nudge')), false);

    // A card switches the panel and closes the gallery; the button names it.
    await page.locator('.analysis-card.marks-item-fft').click();
    await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
    assert.equal(await modeOf(page), 'fft');
    const pressed = page.locator('.timeseries-analysis-menu-btn').first();
    assert.equal(await pressed.getAttribute('aria-pressed'), 'true');
    assert.equal(await pressed.getAttribute('data-mode'), 'fft');

    // Keyboard: the arrows walk the cards, Enter picks, Escape leaves.
    await pressed.click();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.mark), 'fft');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.mark), 'temporal-profile', 'down is the card below');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.mark), 'timeseries');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.panel-analysis-menu').count(), 0);
    assert.equal(await modeOf(page), 'fft', 'Escape changes nothing');
    await page.locator('.timeseries-analysis-menu-btn').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
    assert.equal(await modeOf(page), 'timeseries', 'the first card goes back to the time series');

    // A lower panel: the gallery opens above its button, inside the window.
    await page.evaluate(() => window.app.layoutManager.splitPanel(document.querySelector('.layout-panel').dataset.id, 'h', false));
    await page.waitForFunction(() => document.querySelectorAll('.layout-panel').length === 2);
    await page.evaluate(() => {
        const panelEl = [...document.querySelectorAll('.layout-panel')].pop();
        window.app.plotManager.addTrace(panelEl.dataset.id, 'y', panelEl);
    });
    const lower = page.locator('.timeseries-analysis-menu-btn').last();
    await lower.waitFor();
    await lower.click();
    assert.equal(await insideWindow(page), true);
    const menuBox = await page.locator('.panel-analysis-menu').boundingBox();
    const lowerBox = await lower.boundingBox();
    assert.ok(menuBox.y + menuBox.height <= lowerBox.y, 'above the button');
    await page.locator('.analysis-card.marks-item-histogram').click();
    await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
    assert.equal(await modeOf(page, 1), 'histogram');
    assert.equal(await modeOf(page, 0), 'timeseries', 'the other panel is left alone');

    // The nudge does not come back.
    await load();
    assert.equal(await page.locator('.timeseries-analysis-menu-btn.analysis-nudge').count(), 0);

    assert.deepEqual(errors, []);
    console.log('analysis gallery: ok');
} finally {
    await browser.close();
    await server.close();
}
