// End-to-end check of the data tools' gallery in the side panel
// (src/app/methods/data-tool-gallery-methods.js), in a real browser.
//
// The tools are tiles in four families. With no file they are all off and say
// why; with a file a tile opens its tool — the same thing the dropdown's
// `change` did — and folds the gallery into a header with a way back. The
// select stays the one holder of which tool is open, so writing it (as the
// edit of a transformation and the session restore do) moves the gallery too.
// Two densities, kept across reloads; the first one follows the window height.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:data-tool-gallery`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

import { DATA_TOOL_GROUPS } from '../src/app/data-tool-catalog.js';
import { DATA_TOOL_GALLERY_MIN_HEIGHT, defaultDataToolDensity } from '../src/app/methods/data-tool-gallery-methods.js';

assert.equal(defaultDataToolDensity(DATA_TOOL_GALLERY_MIN_HEIGHT - 1), 'compact');
assert.equal(defaultDataToolDensity(DATA_TOOL_GALLERY_MIN_HEIGHT), 'gallery');
assert.equal(defaultDataToolDensity(undefined), 'gallery');

function makeCsv() {
    const lines = ['time,y'];
    for (let i = 0; i < 500; i++) lines.push(`${i},${Math.sin(i / 20).toFixed(4)}`);
    return { name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const ALL_TOOLS = DATA_TOOL_GROUPS.flatMap(group => group.tools);
const tile = (page, tool) => page.locator(`.data-tool-tile[data-tool="${tool}"]`);

async function open(browser, baseUrl, viewport) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    return { context, page, errors };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    // ── A tall window: tiles with names, in four families ──
    const { context, page, errors } = await open(browser, baseUrl, { width: 1920, height: 1080 });
    assert.deepEqual(
        await page.locator('.data-tool-tile').evaluateAll(nodes => nodes.map(node => node.dataset.tool)),
        ALL_TOOLS, 'one tile per tool, in the catalogue\'s order');
    assert.equal(await page.locator('.data-tool-family').count(), DATA_TOOL_GROUPS.length);
    assert.equal(await page.locator('#data-tool-gallery.density-compact').count(), 0, 'a tall window opens with names');
    assert.equal(await page.locator('.data-tool-tile-name').first().isVisible(), true);

    // No file: every tile is off, does nothing, and says why.
    assert.equal(await page.locator('.data-tool-tile[aria-disabled="true"]').count(), ALL_TOOLS.length);
    await tile(page, 'derivative').click({ force: true });
    assert.equal(await page.locator('#data-tool-select').inputValue(), '');
    await tile(page, 'integrate').hover();
    await page.locator('#data-tool-hovercard:not([hidden])').waitFor();
    const needsFile = await page.evaluate(async () => (await import('/src/i18n/index.js')).default.t('dataToolNeedsFile'));
    assert.ok((await page.locator('#data-tool-hovercard').innerText()).includes(needsFile), 'the card says a file is needed');

    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.data-tool-tile[aria-disabled="true"]'));

    // The card: what the tool does, beside the panel and inside the window.
    await tile(page, 'movingAverage').hover();
    await page.locator('#data-tool-hovercard:not([hidden])').waitFor();
    const card = await page.locator('#data-tool-hovercard').boundingBox();
    const panel = await page.locator('#sidebar').boundingBox();
    assert.ok(card.x >= panel.x + panel.width, 'the card sits beside the side panel');
    assert.ok(card.y >= 0 && card.y + card.height <= 1080, 'and inside the window');
    assert.equal(await page.locator('#data-tool-hovercard .data-tool-hovercard-note').count(), 0);

    // A tile opens its tool.
    await tile(page, 'movingAverage').click();
    assert.equal(await page.locator('#data-tool-select').inputValue(), 'movingAverage');
    assert.equal(await page.locator('#data-tool-gallery').isHidden(), true, 'the gallery folds away');
    assert.equal(await page.locator('#data-tool-hovercard').isHidden(), true);
    assert.equal(await page.locator('#data-tool-active').isVisible(), true);
    assert.equal(await page.locator('#data-tool-active-name').innerText(), await tile(page, 'movingAverage').locator('.data-tool-tile-name').textContent());
    assert.equal(await page.locator('.data-tool-controls[data-tool-kind="movingAverage"]').isVisible(), true, 'its form is open');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'outlier-variable', 'ready to pick the signal');

    // The header follows the language.
    const frName = await page.evaluate(() => { window.app.setLanguage('fr'); return document.getElementById('data-tool-active-name').textContent; });
    assert.equal(frName, 'Moyenne mobile');
    await page.evaluate(() => window.app.setLanguage('en'));

    // Back: the draft is dropped and the gallery returns, focus on the tile.
    await page.locator('#data-tool-active-close').click();
    assert.equal(await page.locator('#data-tool-select').inputValue(), '');
    assert.equal(await page.locator('#data-tool-gallery').isVisible(), true);
    assert.equal(await page.locator('#data-tool-active').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tool), 'movingAverage');

    // The arrows move along the tiles; Enter opens.
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tool), 'detrend');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#data-tool-select').inputValue(), 'detrend');

    // Creating returns to the gallery (a finished transformation is a finished job).
    await page.locator('#outlier-variable').selectOption('y');
    await page.locator('#data-tool-create').click();
    await page.waitForFunction(() => document.getElementById('data-tool-select').value === '');
    assert.equal(await page.locator('#data-tool-gallery').isVisible(), true);
    await page.locator('#data-tool-table .data-tool-row').first().waitFor();

    // Editing a transformation writes the select: the header follows.
    await page.locator('#data-tool-table .data-tool-row-edit').first().click();
    await page.waitForFunction(() => document.getElementById('data-tool-select').value === 'detrend');
    assert.equal(await page.locator('#data-tool-active').isVisible(), true);
    assert.equal(await page.locator('#data-tool-gallery').isHidden(), true);
    await page.locator('#data-tool-active-close').click();
    assert.equal(await page.locator('#data-tool-gallery').isVisible(), true);

    // Drawings only, and kept.
    await page.locator('#data-tool-density').click();
    assert.equal(await page.locator('#data-tool-gallery.density-compact').count(), 1);
    assert.equal(await page.locator('.data-tool-tile-name').first().isVisible(), false);
    assert.equal(await tile(page, 'xcorr').isVisible(), true);
    await page.reload();
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.data-tool-tile'));
    assert.equal(await page.locator('#data-tool-gallery.density-compact').count(), 1, 'the choice survives a reload');

    // Nothing of the gallery is wider than the panel, at any panel width.
    for (const width of [200, 320, 600]) {
        for (const density of ['gallery', 'compact']) {
            const overflow = await page.evaluate(({ width, density }) => {
                const sidebar = document.getElementById('sidebar');
                sidebar.style.transition = 'none';
                sidebar.style.width = `${width}px`;
                window.app._setDataToolDensity(density);
                const limit = document.querySelector('.data-tool-panel').getBoundingClientRect().right + 0.5;
                return [...document.querySelectorAll('#data-tool-gallery, .data-tool-tile')]
                    .filter(node => node.getBoundingClientRect().right > limit).length;
            }, { width, density });
            assert.equal(overflow, 0, `${density} fits a ${width}px panel`);
        }
    }
    assert.deepEqual(errors, []);
    await context.close();

    // ── A short window (a 1366 × 768 laptop): drawings only by default ──
    const short = await open(browser, baseUrl, { width: 1366, height: 650 });
    assert.equal(await short.page.locator('#data-tool-gallery.density-compact').count(), 1);
    const box = await short.page.locator('#data-tool-gallery').boundingBox();
    assert.ok(box.height <= 110, `the compact gallery is short (${box.height}px)`);
    assert.deepEqual(short.errors, []);
    await short.context.close();

    console.log('data tool gallery: ok');
} finally {
    await browser.close();
    await server.close();
}
