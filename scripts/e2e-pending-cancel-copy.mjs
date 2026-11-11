// End-to-end check of two small conveniences, in a real browser:
//
// 1. The Cancel of a half-built 2D/3D pair. After the first variable of a pair
//    is dropped, the panel says which one comes next; Cancel forgets what was
//    dropped so far — on an empty panel (the placeholder) and over a chart
//    that already has pairs (the pending overlay, which otherwise lets every
//    pointer event through to the plot).
// 2. The copy buttons of the analyses whose results are text: the curve fit's
//    results and the Σ statistics dialog.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:pending-cancel-copy`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const rows = ['time,a,b,c'];
for (let i = 0; i < 50; i++) rows.push(`${i * 0.1},${i},${2 * i + 1},${Math.sin(i)}`);
const file = { name: 'pairs.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n') + '\n') };

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const panelId = await page.evaluate(() => document.querySelector('.layout-panel').dataset.id);
    const panel = page.locator(`.layout-panel[data-id="${panelId}"]`);
    const drop = (names) => page.evaluate(([id, list]) => {
        const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
        return window.app.plotManager._handleVariableDrop(id, list, panelEl);
    }, [panelId, names]);
    const pending = () => page.evaluate(id => ({ ...window.app.plotManager.plots.get(id).phasePending }), panelId);

    // ── Empty panel: the placeholder offers Cancel once X is dropped ──
    await page.evaluate(id => window.app.plotManager.setModeAsync(id, 'phase2d'), panelId);
    assert.equal(await panel.locator('.layout-panel-placeholder .pending-cancel-btn').count(), 0, 'nothing to cancel yet');
    await drop(['a']);
    assert.equal((await pending()).x, 'a');
    await panel.locator('.layout-panel-placeholder .pending-cancel-btn').click();
    assert.equal((await pending()).x, null, 'Cancel forgets the X');
    assert.equal(await panel.locator('.layout-panel-placeholder .pending-cancel-btn').count(), 0, 'and the button goes with it');

    // ── A chart with a pair: the pending overlay offers Cancel ──
    await drop(['a']);
    await drop(['b']);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, panelId);
    await drop(['c']);
    const overlay = panel.locator('.drop-overlay');
    assert.ok(await overlay.evaluate(el => el.classList.contains('pending')), 'waiting for Y over the chart');
    await overlay.locator('.pending-cancel-btn').click();
    assert.equal((await pending()).x, null, 'Cancel over the chart forgets the X');
    assert.ok(!(await overlay.evaluate(el => el.classList.contains('active'))), 'the overlay is gone');
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id).phaseTraces.length, panelId), 1,
        'the finished pair is untouched');

    // ── 3D: two of three dropped, then Cancel ──
    await page.evaluate(id => window.app.plotManager.setModeAsync(id, 'phase3d'), panelId);
    await drop(['a']);
    await drop(['b']);
    const p3 = await pending();
    assert.deepEqual([p3.x, p3.y], ['a', 'b']);
    await panel.locator('.pending-cancel-btn:visible').first().click();
    assert.equal((await pending()).x, null, '3D: Cancel forgets X and Y');

    // ── Curve fit: copy the results ──
    // Leaving 3D for 2D does not carry pairs across: build one again.
    await page.evaluate(id => window.app.plotManager.setModeAsync(id, 'phase2d'), panelId);
    await drop(['a']);
    await drop(['b']);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, panelId);
    await page.evaluate(id => window.app.plotManager._togglePhase2dFit(id), panelId);
    await page.waitForSelector('.phase2d-fit-type-select');
    await page.selectOption('.phase2d-fit-type-select', 'linear');
    await page.waitForSelector('.phase2d-fit-equation');
    await page.locator('.phase2d-fit-copy-btn').click();
    await page.waitForSelector('.phase2d-fit-copy-btn.copied');
    const fitText = await page.evaluate(() => navigator.clipboard.readText());
    const fitLines = fitText.split('\n');
    assert.equal(fitLines[1], 'y = a·x + b', `the model, then its coefficients:\n${fitText}`);
    assert.equal(fitLines[2], 'a = 2', 'slope of b against a');
    assert.equal(fitLines[3], 'b = 1', 'intercept');
    assert.ok(fitLines.some(line => /^R².*: 1(\.0+)?$/.test(line)), `R² = 1 for an exact line:\n${fitText}`);

    // ── Σ statistics: Copy in the dialog, tab-separated ──
    await page.evaluate(id => window.app.plotManager._showPanelStats(id), panelId);
    await page.locator('.modal-dialog-stats .modal-copy-btn').click();
    await page.waitForSelector('.modal-dialog-stats .modal-copy-btn.copied');
    const statsText = await page.evaluate(() => navigator.clipboard.readText());
    const statsLines = statsText.split('\n');
    assert.ok(statsLines.length >= 3, `a header and one row per variable:\n${statsText}`);
    assert.ok(statsLines.every(line => line.split('\t').length >= 6), 'cells separated by tabs');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('pending cancel and results copy: ok');
} finally {
    await browser.close();
    await server.close();
}
