// End-to-end check of the legend's context menu (#372, #371): every action
// has its icon; Colour… recolours the trace and the analyses drawn from it
// (the FFT's spectrum), and a saved view keeps it; the moves reorder the
// traces and the legend, the ones that would do nothing disabled. On a phone,
// a trace's row in the Plot sheet offers the same through its swatch and ⋯.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:legend-trace-style`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,v,i,w'];
    for (let k = 0; k < 1024; k++) {
        const t = k / 100;
        lines.push(`${t.toFixed(3)},${Math.sin(2 * Math.PI * 3 * t).toFixed(5)},${Math.cos(2 * Math.PI * 7 * t).toFixed(5)},${(0.5 * Math.sin(2 * Math.PI * 11 * t)).toFixed(5)}`);
    }
    return { name: 'style.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;

// The plot's traces, in order, with their colours; and the legend as drawn.
const traceState = (page, panelId) => page.evaluate((id) => {
    const plot = window.app.plotManager.plots.get(id);
    return plot.traces.map(t => ({ varName: t.varName, color: t.color }));
}, panelId);
const legendNames = (page, selector) => page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} .legend .traces .legendtext`)].map(el => el.textContent), selector);
// The colour a Plotly chart draws a series' line in, by legend name.
const lineColor = (page, panelId, divKey, name) => page.evaluate(([id, key, traceName]) => {
    const div = window.app.plotManager.plots.get(id)?.[key];
    const trace = (div?.data || []).find(t => t.name === traceName && t.showlegend !== false);
    return trace?.line?.color ?? null;
}, [panelId, divKey, name]);

try {
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
        const sel = `.layout-panel[data-id="${panelId}"]`;
        for (const name of ['v', 'i', 'w']) {
            await page.evaluate(([id, varName]) => {
                const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
                window.app.plotManager.addTrace(id, varName, panelEl);
            }, [panelId, name]);
        }
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?.data?.filter(t => t.showlegend !== false).length >= 3, panelId);
        await page.waitForTimeout(400);
        const names = await legendNames(page, sel);
        assert.equal(names.length, 3, `three legend entries (${names})`);
        const [vName, iName, wName] = names;

        const openMenu = async (legendIndex, scope = sel) => {
            await page.locator(`${scope} .legend .traces`).nth(legendIndex).click({ button: 'right' });
            await page.waitForSelector('.timeseries-axis-menu');
        };
        const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.timeseries-axis-menu button')].map(b => ({
            icon: b.dataset.icon || '',
            hasSvg: !!b.querySelector('.legend-menu-icon svg'),
            iconHidden: b.querySelector('.legend-menu-icon')?.getAttribute('aria-hidden'),
            label: b.querySelector('.legend-menu-label')?.textContent || '',
            disabled: b.disabled,
        })));

        // Icons (#372).
        await openMenu(0);
        let items = await menuItems();
        if (shots) await page.screenshot({ path: `${shots}/legend-menu.png` });
        assert.equal(items.length, 10, `show/hide, only, remove, axis, shape, colour and four moves (${items.length})`);
        for (const item of items) {
            assert.ok(item.icon && item.hasSvg, `"${item.label}" has its icon`);
            assert.equal(item.iconHidden, 'true', `"${item.label}": its icon is decorative`);
        }
        assert.deepEqual(items.slice(0, 3).map(item => item.icon), ['hide', 'only', 'remove']);
        const byIcon = Object.fromEntries(items.map(item => [item.icon, item]));
        assert.ok(byIcon.axisRight && byIcon.stairs, 'the time series\' own actions have icons too');
        // The first trace: up and first do nothing.
        assert.equal(byIcon.moveUp.disabled, true, 'the first trace cannot move up');
        assert.equal(byIcon.moveFirst.disabled, true, 'nor to first');
        assert.equal(byIcon.moveDown.disabled, false);
        assert.equal(byIcon.moveLast.disabled, false);
        assert.equal(byIcon.color.disabled, false);

        // Colour from the palette.
        await page.locator('.timeseries-axis-menu button[data-icon="color"]').click();
        await page.waitForSelector('.trace-color-popover');
        assert.equal(await page.locator('.timeseries-axis-menu').count(), 0, 'the menu gives way to the picker');
        assert.equal(await page.locator('.trace-color-popover input[type="color"]').count(), 1, 'a colour of one\'s own is offered');
        if (shots) await page.screenshot({ path: `${shots}/legend-color.png` });
        await page.locator('.trace-color-popover .trace-color-swatch[data-color="#e91e63"]').click();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces[0]?.color === '#e91e63', panelId);
        await page.waitForFunction(([id, n]) => {
            const div = window.app.plotManager.plots.get(id)?.div;
            return (div?.data || []).some(t => t.name === n && t.line?.color === '#e91e63');
        }, [panelId, vName]);
        assert.equal(await page.locator('.trace-color-popover').count(), 0, 'a pick closes the picker');

        // Order: the first to last, then the (new) last back to first.
        await openMenu(0);
        await page.locator('.timeseries-axis-menu button[data-icon="moveLast"]').click();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.map(t => t.varName).join() === 'i,w,v', panelId);
        await page.waitForFunction(([s, expected]) =>
            [...document.querySelectorAll(`${s} .legend .traces .legendtext`)].map(el => el.textContent).join('|') === expected,
            [sel, [iName, wName, vName].join('|')]);
        await openMenu(2);
        items = await menuItems();
        const lastItems = Object.fromEntries(items.map(item => [item.icon, item]));
        assert.equal(lastItems.moveDown.disabled, true, 'the last trace cannot move down');
        assert.equal(lastItems.moveLast.disabled, true, 'nor to last');
        assert.equal(lastItems.moveUp.disabled, false);
        await page.locator('.timeseries-axis-menu button[data-icon="moveUp"]').click();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.map(t => t.varName).join() === 'i,v,w', panelId);
        await openMenu(1);
        await page.locator('.timeseries-axis-menu button[data-icon="moveFirst"]').click();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.map(t => t.varName).join() === 'v,i,w', panelId);
        assert.deepEqual(await legendNames(page, sel), [vName, iName, wName], 'the legend follows the order');
        assert.equal(await lineColor(page, panelId, 'div', vName), '#e91e63', 'a move keeps the colour');

        // Escape closes the menu with nothing done.
        await openMenu(0);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.timeseries-axis-menu').count(), 0, 'Escape closes the menu');

        // The FFT drawn from the series follows its colour and order.
        await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'fft'), panelId);
        await page.waitForFunction(([id, n]) => {
            const div = window.app.plotManager.plots.get(id)?.fftDiv;
            return (div?.data || []).some(t => t.name === n && (t.x?.length || 0) > 0);
        }, [panelId, vName], { timeout: 60000 });
        assert.equal(await lineColor(page, panelId, 'fftDiv', vName), '#e91e63', 'the spectrum is drawn in the series\' colour');

        // Recolour from the FFT's own legend, with the browser's picker.
        const fftIndex = await page.evaluate(([id, n]) => {
            const div = window.app.plotManager.plots.get(id)?.fftDiv;
            return [...div.querySelectorAll('.legend .traces .legendtext')].map(el => el.textContent).indexOf(n);
        }, [panelId, wName]);
        assert.ok(fftIndex >= 0, 'the spectrum legend lists the series');
        const fftItem = await page.evaluateHandle(([id, index]) =>
            window.app.plotManager.plots.get(id).fftDiv.querySelectorAll('.legend .traces')[index], [panelId, fftIndex]);
        await fftItem.asElement().click({ button: 'right' });
        await page.waitForSelector('.timeseries-axis-menu button[data-icon="color"]');
        await page.locator('.timeseries-axis-menu button[data-icon="color"]').click();
        await page.waitForSelector('.trace-color-popover input[type="color"]');
        await page.locator('.trace-color-popover input[type="color"]').evaluate((input) => {
            input.value = '#123456';
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces[2]?.color === '#123456', panelId);
        await page.waitForFunction(([id, n]) => {
            const div = window.app.plotManager.plots.get(id)?.fftDiv;
            return (div?.data || []).some(t => t.name === n && t.line?.color === '#123456' && (t.x?.length || 0) > 0);
        }, [panelId, wName], { timeout: 60000 });
        assert.equal(await lineColor(page, panelId, 'div', wName), '#123456', 'and the time pane above it');

        // Moving from the analysis reorders its legends too.
        await page.evaluate(([id]) => {
            const pm = window.app.plotManager;
            const plot = pm.plots.get(id);
            pm._moveTraceStyle(plot.traces[2], 'first');
        }, [panelId]);
        await page.waitForFunction(([id, expected]) => {
            const div = window.app.plotManager.plots.get(id)?.fftDiv;
            return [...(div?.querySelectorAll('.legend .traces .legendtext') || [])].map(el => el.textContent).join('|') === expected;
        }, [panelId, [wName, vName, iName].join('|')], { timeout: 60000 });

        // A saved view keeps the colours and the order.
        const saved = await page.evaluate(id => window.app._capturePlotSessions()
            .find(p => p.panelId === id).traces.map(t => `${t.varName}:${t.color}`).join(), panelId);
        assert.equal(saved.startsWith('w:#123456,v:#e91e63,i:'), true, `the saved view has them (${saved})`);
        assert.deepEqual(errors, [], 'no page errors on the desktop');
        await context.close();
    }

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
        await page.locator('#variables-tree .tree-item[data-var-name="v"]').click();
        await page.locator('#variables-tree .tree-item[data-var-name="i"]').click();
        const panelId = await page.evaluate(() => window.app._compactActivePanelId());
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.length === 2, panelId);
        await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
        await page.waitForSelector('.compact-trace-row .compact-trace-style');
        assert.equal(await page.locator('.compact-trace-row .compact-trace-color').count(), 2, 'each row\'s swatch is a button');

        // ⋯ on the second row: Move to first.
        await page.locator('.compact-trace-row .compact-trace-style').nth(1).tap();
        await page.waitForSelector('.timeseries-axis-menu');
        const height = await page.locator('.timeseries-axis-menu button').first().evaluate(b => b.getBoundingClientRect().height);
        assert.ok(height >= 44, `the menu is at a finger's size (${height})`);
        if (shots) await page.screenshot({ path: `${shots}/legend-phone-menu.png` });
        assert.equal(await page.locator('.timeseries-axis-menu button[data-icon="moveDown"]').isDisabled(), true,
            'the last one cannot go down');
        await page.locator('.timeseries-axis-menu button[data-icon="moveFirst"]').tap();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces.map(t => t.varName).join() === 'i,v', panelId);
        await page.waitForFunction(() => document.querySelector('.compact-trace-row .compact-trace-name')?.textContent.includes('i'));

        // The swatch: a colour from the palette.
        await page.locator('.compact-trace-row .compact-trace-color').first().tap();
        await page.waitForSelector('.trace-color-popover');
        if (shots) await page.screenshot({ path: `${shots}/legend-phone-color.png` });
        await page.locator('.trace-color-popover .trace-color-swatch[data-color="#009688"]').tap();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces[0]?.color === '#009688', panelId);
        await page.waitForFunction(() => {
            const mark = document.querySelector('.compact-trace-row .compact-trace-color .compact-swatch');
            return mark && getComputedStyle(mark).backgroundColor === 'rgb(0, 150, 136)';
        });
        assert.deepEqual(errors, [], 'no page errors on the phone');
        await context.close();
    }
    console.log('legend trace style e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
