// End-to-end check of the overlay legend's show/hide button
// (ui/legend-toggle.js): on the phone the legend starts hidden and opens below
// the button, clear of the fit buttons; on a desktop it starts shown beside
// the button unless it is wide, keeps the reader's choice through a redraw,
// and comes back when the legend settings change in the sidebar.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:legend-toggle`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
import { createServer } from 'vite';

const LONG = 'plant_boiler_feedwater_pump_discharge_pressure_measured_at_header';

function makeCsv() {
    const lines = [`time,v,i,${LONG}`];
    for (let k = 0; k < 500; k++) {
        const t = k / 50;
        lines.push(`${t.toFixed(3)},${Math.sin(t).toFixed(4)},${Math.cos(t).toFixed(4)},${(t / 3).toFixed(4)}`);
    }
    return { name: 'legend.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// What the plot in this panel shows: its legend box (after any move) and the
// button, in page pixels.
const legendState = (page, panelId) => page.evaluate((id) => {
    const div = window.app.plotManager.plots.get(id)?.div;
    const legend = div?.querySelector('.infolayer .legend');
    const btn = div?.querySelector('.legend-toggle-btn');
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const fit = div?.querySelector('.compact-fit-group:not([hidden])');
    return {
        hasButton: !!btn,
        expanded: btn?.getAttribute('aria-expanded'),
        title: btn?.title,
        shown: !!legend && getComputedStyle(legend).display !== 'none',
        legend: legend && getComputedStyle(legend).display !== 'none' ? rect(legend.querySelector('rect.bg')) : null,
        button: btn ? rect(btn) : null,
        fit: fit ? rect(fit) : null,
    };
}, panelId);

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;

try {
    // ── Phone ───────────────────────────────────────────────────────────────
    {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
        await page.setInputFiles('#file-input', [makeCsv()]);
        await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        await page.locator('.compact-nav-btn[data-sheet="data"]').click();
        await page.locator(`#variables-tree .tree-item[data-var-name="${LONG}"]`).click();
        await page.locator('#variables-tree .tree-item[data-var-name="v"]').click();
        const panelId = await page.evaluate(() => window.app._compactActivePanelId());
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.length === 2, panelId);
        await page.locator('.compact-sheet-close').click();
        await page.waitForFunction(() => window.app._compact.sheet === null);
        await page.waitForTimeout(500);

        let s = await legendState(page, panelId);
        assert.equal(s.hasButton, true, 'the legend has its button on the phone');
        assert.equal(s.shown, false, 'and starts hidden');
        assert.equal(s.expanded, 'false');
        assert.ok(s.fit && s.button.right < s.fit.left, 'the button is at the left, clear of the fit buttons');
        if (shots) await page.screenshot({ path: `${shots}/legend-phone-closed.png` });

        await page.locator('.compact-active-panel .legend-toggle-btn').tap();
        s = await legendState(page, panelId);
        assert.equal(s.shown, true, 'a tap opens it');
        assert.equal(s.expanded, 'true');
        assert.ok(s.legend.top >= s.button.bottom, `below the button (${s.legend.top} ≥ ${s.button.bottom})`);
        if (shots) await page.screenshot({ path: `${shots}/legend-phone-open.png` });

        await page.locator('.compact-active-panel .legend-toggle-btn').tap();
        s = await legendState(page, panelId);
        assert.equal(s.shown, false, 'a second tap closes it');
        assert.deepEqual(errors, [], 'no page errors on the phone');
        await context.close();
    }

    // ── Desktop ─────────────────────────────────────────────────────────────
    {
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
        await page.setInputFiles('#file-input', [makeCsv()]);
        await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        const panelId = await page.evaluate(() => document.querySelector('.layout-panel').dataset.id);
        const add = name => page.evaluate(([id, varName]) => {
            const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
            window.app.plotManager.addTrace(id, varName, panelEl);
        }, [panelId, name]);
        await add('v');
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
        await page.waitForTimeout(400);

        let s = await legendState(page, panelId);
        assert.equal(s.hasButton, true, 'a desktop overlay legend has the button too');
        assert.equal(s.shown, true, 'a short legend starts shown');
        assert.ok(s.legend.left >= s.button.right, 'beside the button, not under it');
        assert.equal(s.title, 'Minimize legend');
        if (shots) await page.screenshot({ path: `${shots}/legend-desktop-open.png` });

        await page.locator('.legend-toggle-btn').click();
        s = await legendState(page, panelId);
        assert.equal(s.shown, false, 'the button minimizes it');
        assert.equal(s.title, 'Show legend');

        await add('i');
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?.data?.length >= 2, panelId);
        await page.waitForTimeout(400);
        s = await legendState(page, panelId);
        assert.equal(s.shown, false, 'and it stays minimized when a curve is added');

        await page.locator('#legend-corner-picker .legend-corner-btn[data-corner="tr"]').click();
        await page.waitForTimeout(400);
        s = await legendState(page, panelId);
        assert.equal(s.shown, true, 'a legend setting changed in the sidebar shows it again');
        assert.ok(s.legend.right <= s.button.left, 'at the right corner it sits left of the button');

        await page.locator('input[name="legend-pos"][value="above"]').check();
        await page.waitForTimeout(400);
        s = await legendState(page, panelId);
        assert.equal(s.hasButton, false, 'a legend above the plot has no button');
        await page.locator('input[name="legend-pos"][value="overlay"]').check();
        await page.locator('#legend-corner-picker .legend-corner-btn[data-corner="tl"]').click();

        // "Add units to the legends" relabels the legend, and that is all it
        // may do. The panels are rebuilt for it — the trace name is folded
        // into hovers, exports and legend-click identity, so a restyle would
        // desynchronise them — and a rebuild starts from the data's own
        // extent, so the zoom the reader was on used to go with the tick.
        await page.evaluate((id) => {
            const div = window.app.plotManager.plots.get(id).div;
            // The rebuild makes a new div; this tag is how the check knows the
            // panel really was rebuilt and not merely restyled.
            div.__beforeUnits = true;
            return window.Plotly.relayout(div, { 'xaxis.range': [2, 4], 'xaxis.autorange': false });
        }, panelId);
        const xRange = (id) => page.evaluate(
            (panel) => [...window.app.plotManager.plots.get(panel).div._fullLayout.xaxis.range].map(Number),
            id,
        );
        const zoomed = await xRange(panelId);
        assert.ok(Math.abs(zoomed[0] - 2) < 1e-6 && Math.abs(zoomed[1] - 4) < 1e-6,
            `the panel is zoomed in before the tick (${zoomed})`);
        await page.locator('#legend-units').check();
        await page.waitForFunction((id) => {
            const div = window.app.plotManager.plots.get(id)?.div;
            return !!div?._fullLayout?.xaxis && !div.__beforeUnits;
        }, panelId, { timeout: 15000 });
        assert.equal(await page.evaluate(() => window.app.plotManager.legendUnits), true,
            'the units setting is on');
        const kept = await xRange(panelId);
        assert.ok(Math.abs(kept[0] - zoomed[0]) < 1e-6 && Math.abs(kept[1] - zoomed[1]) < 1e-6,
            `the units checkbox keeps the view it was read at (${zoomed} → ${kept})`);
        await page.locator('#legend-units').uncheck();
        await page.waitForFunction(() => window.app.plotManager.legendUnits === false);

        await add(LONG);
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?.data?.length >= 3, panelId);
        // The panel takes the whole content area: a 65-character name is
        // still well under 40 % of it, so the wide case is checked narrower.
        await page.setViewportSize({ width: 900, height: 700 });
        await page.waitForTimeout(800);
        s = await legendState(page, panelId);
        assert.equal(s.shown, false, 'a legend wider than 40 % of the plot starts minimized');
        if (shots) await page.screenshot({ path: `${shots}/legend-desktop-long.png` });
        assert.deepEqual(errors, [], 'no page errors on the desktop');
        await context.close();
    }
    console.log('legend toggle e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
