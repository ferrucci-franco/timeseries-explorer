// End-to-end check of the phone layout (docs/phone-web-specification.md):
// the app bar, the bottom navigation and its sheets, tap-to-plot, FFT with its
// options in the Analyze sheet, the CSV parsing dialog on a phone, Back closing
// sheets instead of leaving the site, rotation keeping the session, and the
// desktop layout left untouched on a large window.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:compact-layout`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,voltage,current,temp'];
    for (let i = 0; i < 2000; i++) {
        const t = i / 100;
        lines.push(`${t.toFixed(3)},${Math.sin(2 * Math.PI * 1.5 * t).toFixed(5)},${(0.5 * Math.cos(2 * Math.PI * 4 * t)).toFixed(5)},${(20 + t / 5).toFixed(3)}`);
    }
    return { name: 'signals.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/compact-${name}.png` }); };

try {
    // ── Phone, upright ──────────────────────────────────────────────────────
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); if (process.env.STACKS) console.log('STACK', e.stack); });
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));

    const state = () => page.evaluate(() => {
        const app = window.app;
        const panelId = app._compactActivePanelId();
        const plot = app.plotManager.plots.get(panelId);
        return {
            cls: document.documentElement.className,
            sheet: app._compact.sheet,
            mode: plot?.mode,
            traces: (plot?.traces || []).map(t => t.varName),
            panels: app._compactPanelIds().length,
            appBar: document.querySelector('.compact-plot-selector-label')?.textContent,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
    });

    let s = await state();
    assert.match(s.cls, /\bcompact\b/, 'a phone gets the compact layout');
    assert.equal(s.overflow, false, 'nothing is wider than the screen');
    assert.equal(await page.locator('.top-bar').isVisible(), false, 'the desktop top bar is gone');
    assert.equal(await page.locator('#compact-nav').isVisible(), true, 'the bottom navigation is shown');
    assert.equal(await page.locator('#sidebar').isVisible(), false, 'the sidebar waits for the Data sheet');
    assert.equal(await page.locator('.compact-try-example').isVisible(), true, 'the empty state offers an example');

    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    // ── Data: tap to plot, tap again to remove ──────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="data"]').click();
    await page.waitForFunction(() => document.querySelector('.compact-sheet #sidebar'));
    const leaf = name => page.locator(`#variables-tree .tree-item[data-var-name="${name}"]`);
    await leaf('voltage').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 1);
    await page.waitForFunction(() => document.querySelector('#variables-tree .tree-item[data-var-name="voltage"]')?.classList.contains('compact-on-plot'));
    await leaf('voltage').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 0);
    await leaf('voltage').click();
    await leaf('current').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 2);
    s = await state();
    assert.deepEqual(s.traces, ['voltage', 'current'], 'a tap puts a signal on the plot, a second tap takes it off');
    await shot(page, 'data');

    // ── Back closes the sheet and stays on the page ─────────────────────────
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => window.app._compact.sheet === null);
    assert.equal(await page.evaluate(() => window.app.plotManager.files.size), 1, 'Back did not leave the app');
    assert.equal(await page.locator('#sidebar').isVisible(), false, 'the sidebar went back where it came from');

    // ── Analyze: FFT, with its options in the sheet ─────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="analyze"]').click();
    await page.locator('.compact-radio', { hasText: 'FFT' }).click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.mode === 'fft');
    await page.waitForFunction(() => document.querySelector('.compact-sheet .fft-options'), null, { timeout: 15000 });
    await page.waitForFunction(() => {
        const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
        return plot?.fftDiv?.data?.length > 0;
    }, null, { timeout: 30000 });
    await shot(page, 'analyze-fft');
    await page.locator('.compact-sheet-close').click();
    await page.waitForFunction(() => window.app._compact.sheet === null);
    assert.equal(
        await page.evaluate(() => !!document.querySelector('.fft-workspace > .fft-options')),
        true,
        'closing the sheet gives the FFT its options panel back',
    );
    s = await state();
    assert.deepEqual(s.traces, ['voltage', 'current'], 'switching to FFT kept the signals');

    // ── Rotation keeps the session ──────────────────────────────────────────
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.documentElement.classList.contains('compact-landscape'));
    s = await state();
    assert.equal(s.mode, 'fft', 'rotating kept the analysis');
    assert.deepEqual(s.traces, ['voltage', 'current'], 'rotating kept the signals');
    assert.equal(s.overflow, false, 'sideways, nothing is wider than the screen');
    await shot(page, 'landscape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.documentElement.classList.contains('compact-landscape'));

    // ── Back to time series ─────────────────────────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="analyze"]').click();
    await page.locator('.compact-radio').first().click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.mode === 'timeseries');
    await page.locator('.compact-sheet-close').click();

    // ── Plots: one at a time, chosen from the Plot sheet ────────────────────
    await page.locator('.compact-plot-selector').click();
    await page.waitForFunction(() => window.app._compact.sheet === 'plot');
    await page.locator('.compact-page-plot .compact-secondary-btn', { hasText: 'New plot' }).click();
    s = await state();
    assert.equal(s.panels, 2, 'a new plot was added');
    assert.equal(s.appBar, 'Plot 2 of 2', 'and it is the one on screen');
    assert.equal(await page.locator('#plots-area .layout-panel:visible').count(), 1, 'one plot is shown at a time');
    await page.locator('.compact-page-plot .compact-secondary-btn', { hasText: 'Remove this plot' }).click();
    s = await state();
    assert.equal(s.panels, 1);
    assert.deepEqual(s.traces, ['voltage', 'current'], 'removing the new plot left the first one as it was');
    await page.locator('.compact-sheet-close').click();

    // ── File page → CSV parsing, phone layout ───────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="data"]').click();
    await page.locator('.file-entry-more').first().click();
    await page.waitForFunction(() => window.app._compact.pages.length === 2);
    assert.equal(await page.locator('.compact-sheet-back').isVisible(), true, 'a sub-page has a Back control');
    await page.locator('.compact-page-file .compact-list-btn', { hasText: 'Adjust CSV parsing' }).click();
    await page.waitForSelector('.csv-preview-compact.show');
    assert.equal(await page.locator('.csv-preview-tab').count(), 2, 'upright, preview and options are tabs');
    assert.equal(await page.locator('.csv-preview-options-pane').isVisible(), false, 'the preview tab comes first');
    await page.locator('.csv-preview-tab').nth(1).click();
    assert.equal(await page.locator('.csv-preview-options-pane').isVisible(), true);
    assert.equal(await page.locator('.csv-preview-grid-wrap').isVisible(), false);
    await page.locator('.csv-preview-tab').nth(0).click();
    await page.locator('.csv-preview-grid tr.is-tappable').nth(3).click();
    await page.locator('.modal-dialog-csv-row-actions .modal-btn', { hasText: 'First data row' }).click();
    await page.waitForFunction(() => /\b7\/7\b/.test(document.querySelector('.csv-preview-status-strip')?.textContent || ''));
    await shot(page, 'csv');
    await page.locator('.csv-preview-close').click();
    await page.waitForFunction(() => !document.querySelector('.csv-preview-overlay'));
    if (await page.evaluate(() => window.app._compact.sheet)) await page.locator('.compact-sheet-close').click();

    // ── The user can ask for the full layout, and back ──────────────────────
    await page.evaluate(() => window.app._setCompactLayoutOverride('full'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact')), false, 'Full overrides the phone layout');
    assert.equal(await page.locator('.top-bar').isVisible(), true);
    await page.evaluate(() => window.app._setCompactLayoutOverride('auto'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact')), true);

    assert.deepEqual(errors, [], 'no page errors on the phone');
    await context.close();

    // ── Desktop: untouched ──────────────────────────────────────────────────
    const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const dpage = await desktop.newPage();
    const derrors = [];
    dpage.on('pageerror', e => derrors.push(e.message));
    await dpage.goto(baseUrl);
    await dpage.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    assert.equal(await dpage.evaluate(() => document.documentElement.classList.contains('compact')), false, 'a desktop window keeps the desktop layout');
    assert.equal(await dpage.locator('#compact-nav').isVisible(), false);
    assert.equal(await dpage.locator('#compact-appbar').isVisible(), false);
    assert.equal(await dpage.locator('.top-bar').isVisible(), true);
    assert.equal(await dpage.locator('#sidebar').isVisible(), true);
    assert.equal(await dpage.locator('.layout-panel-toolbar').first().isVisible(), true);
    assert.equal(await dpage.locator('.compact-try-example').isVisible(), false);
    assert.deepEqual(derrors, [], 'no page errors on the desktop');
    await desktop.close();

    console.log('compact layout e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
