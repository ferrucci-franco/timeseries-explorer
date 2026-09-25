// End-to-end check of Ctrl+Z (back to the previous zoom/pan view), in a real
// browser, with real mouse gestures.
//
// Scenario: one CSV, one time-series panel. A box zoom and then a burst of
// wheel zoom are two steps: Ctrl+Z undoes the wheel burst in one go, then the
// box zoom. "Last view" in the View menu does the same, and shows the
// shortcut. Ctrl+Z typed in a text field is left to the field.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:view-undo`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 2000;

function makeCsv() {
    const lines = ['time,wave'];
    for (let i = 0; i < ROWS; i++) {
        const t = i / 200;                                  // 0 … 10 s
        lines.push(`${t.toFixed(3)},${Math.sin(2 * Math.PI * 0.5 * t).toFixed(6)}`);
    }
    return { name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const SETTLE = 700;   // the history records a step once relayouts settle (350 ms)

const xRange = (page, id) => page.evaluate(
    panelId => Array.from(window.app.plotManager.plots.get(panelId).div._fullLayout.xaxis.range).map(Number),
    id,
);
const near = (a, b, tol = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol * Math.max(1, Math.abs(b[i])));

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
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
        app.plotManager.addTrace(panelEl.dataset.id, 'wave', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(SETTLE);

    const initial = await xRange(page, panelId);
    const lastViewDisabled = () => page.evaluate(id => {
        const pm = window.app.plotManager;
        return pm._viewMenuModel(id, pm.plots.get(id)).find(item => item.key === 'lastview')?.disabled;
    }, panelId);
    assert.equal(await lastViewDisabled(), true, 'nothing to go back to on a fresh chart');

    // The plotting area, from Plotly's own drag layer.
    const box = await page.locator(`.layout-panel[data-id="${panelId}"] .nsewdrag`).first().boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

    // ── Step 1: box zoom with the mouse ──
    await page.mouse.move(...at(0.3, 0.2));
    await page.mouse.down();
    await page.mouse.move(...at(0.45, 0.6), { steps: 8 });
    await page.mouse.move(...at(0.6, 0.8), { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE);
    const zoomed = await xRange(page, panelId);
    assert.ok(zoomed[1] - zoomed[0] < (initial[1] - initial[0]) * 0.5, `the box zoom narrowed X (${zoomed})`);
    assert.equal(await lastViewDisabled(), false, 'Last view is enabled once the view changed');

    // ── Step 2: a burst of wheel zoom ──
    await page.mouse.move(...at(0.5, 0.5));
    for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(40);
    }
    await page.waitForTimeout(SETTLE);
    const wheeled = await xRange(page, panelId);
    assert.ok(!near(wheeled, zoomed), `the wheel zoomed further (${wheeled})`);

    // ── Ctrl+Z, with the mouse over the panel ──
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(SETTLE);
    let now = await xRange(page, panelId);
    assert.ok(near(now, zoomed), `Ctrl+Z undoes the whole wheel burst in one step (${now} vs ${zoomed})`);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(SETTLE);
    now = await xRange(page, panelId);
    assert.ok(near(now, initial), `a second Ctrl+Z undoes the box zoom (${now} vs ${initial})`);
    assert.equal(await lastViewDisabled(), true, 'and the history is empty again');

    // Undoing is not a step of its own: nothing left to undo.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(SETTLE);
    assert.ok(near(await xRange(page, panelId), initial), 'a third Ctrl+Z leaves the view alone');

    // ── Last view, from the View menu ──
    await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [2, 3] }), panelId);
    await page.waitForTimeout(SETTLE);
    await page.locator(`.layout-panel[data-id="${panelId}"] .panel-view-btn`).click();
    const item = page.locator(`.panel-view-menu[data-panel-id="${panelId}"] .marks-item-lastview`);
    assert.match(await item.textContent(), /Ctrl\+Z|⌘Z/, 'the menu item shows the shortcut');
    await item.click();
    await page.waitForTimeout(SETTLE);
    now = await xRange(page, panelId);
    assert.ok(near(now, initial), `Last view restores the view (${now})`);
    assert.equal(await item.isDisabled(), true, 'and greys out when there is nothing left');
    await page.keyboard.press('Escape');

    // ── Ctrl+Z in a text field is the field's ──
    await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [4, 5] }), panelId);
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'e2e-undo-field';
        document.body.appendChild(input);
        input.focus();
    });
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(SETTLE);
    assert.ok(near(await xRange(page, panelId), [4, 5]), 'Ctrl+Z while typing does not touch the plot');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('View undo end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
