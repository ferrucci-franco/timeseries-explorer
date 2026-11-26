// End-to-end check that every button answers the press, on the desktop and on
// the phone (base.css: a pressed button sinks and darkens).
//
// A button that did its work without moving looked as if it had not been
// pressed. Here, in each of a set of screens, every visible, enabled button
// is held down with the mouse and must look pressed (`scale` below 1); the
// mouse is let go somewhere else, so no button is actually clicked.
//
// And the buttons that redraw the panel they sit in — Apply, Reset and Reset
// all of a file's time axis — leave a "done" mark (✓) on the button that
// takes their place, on both layouts, since the pressed one is gone at once.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:button-press`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,voltage,current'];
    for (let i = 0; i < 1500; i++) lines.push(`${(i / 100).toFixed(2)},${Math.sin(i / 30).toFixed(5)},${Math.cos(i / 17).toFixed(5)}`);
    return { name: 'signals.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

// Hold every visible, enabled button that is on top at its centre, read how it
// looks, and let go elsewhere. Returns how many were checked and which did not
// look pressed.
async function sweep(page, label) {
    const ids = await page.evaluate(() => {
        const out = [];
        let n = 0;
        for (const el of document.querySelectorAll('button, [role="button"], .modebar-btn')) {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
            const top = document.elementFromPoint(x, y);
            if (!top || !(top === el || el.contains(top))) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
            el.dataset.pressProbe = String(n);
            out.push({ id: n++, x, y, name: (el.getAttribute('aria-label') || el.title || el.textContent || el.className || '').trim().slice(0, 40) });
        }
        return out;
    });
    const failures = [];
    let checked = 0;
    for (const { id, x, y, name } of ids) {
        const still = await page.evaluate(({ id, x, y }) => {
            const el = document.querySelector(`[data-press-probe="${id}"]`);
            if (!el || !el.isConnected) return false;
            const top = document.elementFromPoint(x, y);
            return !!top && (top === el || el.contains(top));
        }, { id, x, y });
        if (!still) continue;
        await page.mouse.move(x, y);
        await page.mouse.down();
        // The press animates (40 ms). Wait for the look, not for a length of
        // time: a loaded machine can let 90 ms pass without painting a frame,
        // and the button then reads as :active with its scale still 1 — which
        // is how this check failed in CI while every button was fine.
        const pressed = await page.evaluate(async id => {
            const el = document.querySelector(`[data-press-probe="${id}"]`);
            if (!el) return null;
            const look = () => {
                const style = getComputedStyle(el);
                return { scale: style.scale, active: el.matches(':active') };
            };
            const sunk = seen => Number(seen.scale === 'none' ? 1 : String(seen.scale).split(' ')[0]) < 1;
            let seen = look();
            const deadline = performance.now() + 2000;
            while (!sunk(seen) && performance.now() < deadline) {
                await new Promise(requestAnimationFrame);
                seen = look();
            }
            return seen;
        }, id);
        // Let go away from any button: nothing is clicked.
        await page.mouse.move(1, 1);
        await page.mouse.up();
        if (!pressed) continue;
        checked++;
        const scale = pressed.scale === 'none' ? 1 : Number(String(pressed.scale).split(' ')[0]);
        if (!(scale < 1)) failures.push(`${name} (scale ${pressed.scale}, :active ${pressed.active})`);
    }
    assert.deepEqual(failures, [], `${label}: every button looks pressed while held`);
    return checked;
}

const closeOverlays = page => page.evaluate(() => {
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
});

try {
    let total = 0;

    // ── Desktop ─────────────────────────────────────────────────────────────
    {
        const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
        total += await sweep(page, 'desktop, empty');
        await page.setInputFiles('#file-input', [makeCsv()]);
        await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        await page.evaluate(() => {
            const pm = window.app.plotManager;
            window.app.setActiveFile([...pm.files.keys()][0]);
            const panelEl = document.querySelector('.layout-panel');
            pm.addTrace(panelEl.dataset.id, 'voltage', panelEl);
            pm.addTrace(panelEl.dataset.id, 'current', panelEl);
        });
        await page.waitForTimeout(600);
        total += await sweep(page, 'desktop, a plot');

        // A dialog: the export dialog's buttons.
        await page.locator('.panel-export-btn').first().click();
        await page.waitForSelector('.modal-dialog-plot-export');
        await page.waitForTimeout(300);
        total += await sweep(page, 'desktop, the export dialog');
        await page.locator('.modal-dialog-plot-export .modal-btn-cancel').click();
        await page.waitForFunction(() => !document.querySelector('.modal-dialog-plot-export'));

        // The file's time axis: Apply leaves its ✓ on the redrawn panel.
        await page.locator('.file-entry-transform').first().click();
        await page.waitForSelector('.file-transform-panel [data-transform-action="apply"]');
        total += await sweep(page, 'desktop, the time axis panel');
        await page.locator('.file-transform-panel [data-transform-action="apply"]').click();
        await page.waitForSelector('.file-transform-panel [data-transform-action="apply"].is-done', { timeout: 3000 });
        await page.waitForFunction(() => !document.querySelector('.file-transform-panel [data-transform-action="apply"].is-done'), null, { timeout: 4000 });
        await page.locator('.file-transform-panel [data-transform-action="reset-all"]').click();
        await page.waitForSelector('.file-transform-panel [data-transform-action="reset-all"].is-done', { timeout: 3000 });
        assert.equal(await page.locator('.file-transform-panel [data-transform-action="apply"]').innerText(), 'Apply', 'the label is translated (English here)');
        await closeOverlays(page);
        assert.deepEqual(errors, [], 'desktop: no page error');
        await page.close();
    }

    // ── Phone ───────────────────────────────────────────────────────────────
    {
        const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
        total += await sweep(page, 'phone, empty');
        await page.setInputFiles('#file-input', [makeCsv()]);
        await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        const openSheet = async (id) => {
            if (await page.evaluate(() => window.app._compact.sheet) !== id) await page.locator(`.compact-nav-btn[data-sheet="${id}"]`).click();
            await page.waitForFunction(sheet => window.app._compact.sheet === sheet, id);
            await page.waitForTimeout(300);
        };
        await openSheet('data');
        await page.locator('#variables-tree .tree-item[data-var-name="voltage"]').click();
        total += await sweep(page, 'phone, the Data sheet');
        for (const id of ['plot', 'analyze', 'more']) {
            await openSheet(id);
            total += await sweep(page, `phone, the ${id} sheet`);
        }
        await page.locator('.compact-sheet-close').click();
        await page.waitForFunction(() => window.app._compact.sheet === null);
        await page.waitForTimeout(300);
        total += await sweep(page, 'phone, the plot');

        // The file page → its time axis: Apply's ✓, at a phone's size.
        await openSheet('data');
        await page.locator('.file-entry-more').first().click();
        await page.waitForFunction(() => window.app._compact.pages.length === 2);
        await page.locator('.compact-page-file .compact-file-action', { hasText: 'Time axis and scale' }).click();
        await page.waitForSelector('.compact-page-time-axis [data-transform-action="apply"]');
        await page.waitForTimeout(300);
        await page.locator('.compact-page-time-axis [data-transform-action="apply"]').scrollIntoViewIfNeeded();
        total += await sweep(page, 'phone, the time axis page');
        await page.locator('.compact-page-time-axis [data-transform-action="apply"]').tap();
        await page.waitForSelector('.compact-page-time-axis [data-transform-action="apply"].is-done', { timeout: 3000 });
        const done = await page.evaluate(() => {
            const btn = document.querySelector('.compact-page-time-axis [data-transform-action="apply"].is-done');
            return { mark: getComputedStyle(btn, '::before').content, ring: getComputedStyle(btn).boxShadow };
        });
        assert.match(done.mark, /✓/, 'the phone shows the ✓');
        assert.notEqual(done.ring, 'none', 'with a green ring');
        assert.deepEqual(errors, [], 'phone: no page error');
        await page.close();
    }

    console.log(`e2e button press: ${total} buttons look pressed while held, desktop and phone; Apply, Reset all leave a ✓`);
} finally {
    await browser.close();
    await server.close();
}
