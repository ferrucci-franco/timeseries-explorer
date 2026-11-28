// End-to-end check of the legend's context menu (#372, #371): every action
// has its icon; Colour… recolours the trace and the analyses drawn from it
// (the FFT's spectrum), and a saved view keeps it; the moves reorder the
// traces and the legend, the ones that would do nothing disabled. On a phone,
// a trace's row in the Plot sheet offers the same through its swatch and ⋯.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:legend-trace-style`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
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

// How many times a panel is rebuilt from here on: a colour being looked for
// must rebuild nothing, and Apply once.
const countRebuilds = page => page.evaluate(() => {
    const pm = window.app.plotManager;
    if (!pm.__rebuildCounted) {
        const original = pm._rebuildPanel;
        pm._rebuildPanel = function(...args) {
            window.__rebuilds += 1;
            return original.apply(this, args);
        };
        pm.__rebuildCounted = true;
    }
    window.__rebuilds = 0;
});
const rebuilds = page => page.evaluate(() => window.__rebuilds);

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
        assert.equal(await page.locator('.trace-color-popover .trace-color-custom-toggle').count(), 1, 'a colour of one\'s own is offered');
        assert.equal(await page.locator('.trace-color-popover input[type="color"]').count(), 0, 'not through the browser\'s picker');
        assert.equal(await page.locator('.trace-color-popover .trace-color-custom').isVisible(), false, 'its picker is folded until asked for');
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
        await page.waitForSelector('.trace-color-popover .trace-color-custom-toggle');
        await page.locator('.trace-color-popover .trace-color-custom-toggle').click();
        await page.waitForSelector('.trace-color-popover .trace-color-area');
        const colourBefore = (await traceState(page, panelId))[2].color;
        await countRebuilds(page);
        // Sliding the mouse over the square looks for a colour: the preview
        // follows, the plot does not.
        const areaBox = await page.locator('.trace-color-area').boundingBox();
        await page.mouse.move(areaBox.x + 10, areaBox.y + 10);
        await page.mouse.down();
        const seen = new Set();
        for (let k = 1; k <= 12; k++) {
            await page.mouse.move(areaBox.x + 10 + k * 12, areaBox.y + 10 + k * 6);
            seen.add(await page.locator('.trace-color-popover').getAttribute('data-color'));
        }
        // Past the box: the slide goes on, held at the edge.
        await page.mouse.move(areaBox.x + areaBox.width + 60, areaBox.y - 40);
        await page.mouse.up();
        assert.ok(seen.size >= 8, `the preview follows the slide (${seen.size} colours)`);
        const corner = await page.locator('.trace-color-popover').getAttribute('data-color');
        const hueBox = await page.locator('.trace-color-hue').boundingBox();
        await page.mouse.click(hueBox.x + hueBox.width / 3, hueBox.y + hueBox.height / 2);
        assert.equal(await page.locator('.trace-color-popover').getAttribute('data-color'), '#00ff00', 'the strip sets the hue');
        assert.notEqual(corner, '#00ff00');
        assert.equal((await traceState(page, panelId))[2].color, colourBefore, 'nothing is applied while looking');
        assert.equal(await rebuilds(page), 0, 'and the panel is not rebuilt');
        // Cancel leaves the trace as it was.
        await page.locator('.trace-color-popover .trace-color-cancel').click();
        assert.equal(await page.locator('.trace-color-popover').count(), 0, 'Cancel closes the picker');
        assert.equal((await traceState(page, panelId))[2].color, colourBefore, 'with nothing changed');
        // A typed colour, then Apply.
        await (await page.evaluateHandle(([id, index]) =>
            window.app.plotManager.plots.get(id).fftDiv.querySelectorAll('.legend .traces')[index], [panelId, fftIndex]))
            .asElement().click({ button: 'right' });
        await page.locator('.timeseries-axis-menu button[data-icon="color"]').click();
        await page.locator('.trace-color-popover .trace-color-custom-toggle').click();
        await page.locator('.trace-color-popover .trace-color-hex').fill('#12345');
        assert.equal(await page.locator('.trace-color-hex.is-invalid').count(), 1, 'a half-typed code is marked, not applied');
        await page.locator('.trace-color-popover .trace-color-hex').fill('#123456');
        assert.equal(await page.locator('.trace-color-popover').getAttribute('data-color'), '#123456');
        assert.equal((await traceState(page, panelId))[2].color, colourBefore, 'typing applies nothing either');
        await page.locator('.trace-color-popover .trace-color-apply').click();
        await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.traces[2]?.color === '#123456', panelId);
        assert.equal(await page.locator('.trace-color-popover').count(), 0, 'Apply closes the picker');
        assert.equal(await rebuilds(page), 1, 'Apply rebuilds the panel once');
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

        // A colour of one's own, with a finger: slide over the square to look
        // for it, then Apply. This is what closed the browser on a phone when
        // the picker was the browser's own and every move of the finger
        // rebuilt the panel.
        await page.locator('.compact-trace-row .compact-trace-color').first().tap();
        await page.waitForSelector('.trace-color-popover');
        await page.locator('.trace-color-popover .trace-color-custom-toggle').tap();
        await page.waitForSelector('.trace-color-popover .trace-color-area');
        if (shots) await page.screenshot({ path: `${shots}/legend-phone-custom.png` });
        const fits = await page.evaluate(() => {
            const r = document.querySelector('.trace-color-popover').getBoundingClientRect();
            const b = document.querySelector('.trace-color-apply').getBoundingClientRect();
            const h = document.querySelector('.trace-color-hue').getBoundingClientRect();
            return {
                inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
                applyHeight: b.height, hueHeight: h.height,
                touchAction: getComputedStyle(document.querySelector('.trace-color-area')).touchAction,
            };
        });
        assert.equal(fits.inside, true, 'the open picker fits the phone\'s screen');
        assert.ok(fits.applyHeight >= 44, `Apply is a finger\'s target (${fits.applyHeight})`);
        assert.ok(fits.hueHeight >= 28, `so is the hue strip (${fits.hueHeight})`);
        assert.equal(fits.touchAction, 'none', 'a slide is the picker\'s, not a scroll');
        await countRebuilds(page);
        const touch = await context.newCDPSession(page);
        // A finger stops on the colour it found before it lifts. Lifted at
        // full speed, Chromium takes the slide for a fling and swallows the
        // tap that follows it at once, which no finger does.
        const finger = async (type, x, y) => {
            if (type === 'touchEnd') await page.waitForTimeout(200);
            return touch.send('Input.dispatchTouchEvent', {
                type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
            });
        };
        const square = await page.locator('.trace-color-area').boundingBox();
        const scrollBefore = await page.evaluate(() => [window.scrollX, window.scrollY]);
        await finger('touchStart', square.x + 12, square.y + square.height - 12);
        const slid = new Set();
        for (let k = 1; k <= 40; k++) {
            await finger('touchMove', square.x + 12 + k * (square.width - 24) / 40, square.y + square.height - 12 - k * (square.height - 24) / 40);
            slid.add(await page.locator('.trace-color-popover').getAttribute('data-color'));
        }
        await finger('touchEnd');
        assert.ok(slid.size >= 20, `the preview follows the finger (${slid.size} colours)`);
        const band = await page.locator('.trace-color-hue').boundingBox();
        await finger('touchStart', band.x + 8, band.y + band.height / 2);
        for (let k = 1; k <= 20; k++) await finger('touchMove', band.x + 8 + k * (band.width * 2 / 3 - 8) / 20, band.y + band.height / 2);
        await finger('touchEnd');
        const looked = await page.locator('.trace-color-popover').getAttribute('data-color');
        assert.match(looked, /^#[0-9a-f]{6}$/);
        assert.notEqual(looked, '#009688', 'the finger found another colour');
        assert.equal(await page.locator('.trace-color-popover').count(), 1, 'the picker stays open while looking');
        assert.equal((await traceState(page, panelId))[0].color, '#009688', 'the trace keeps its colour until Apply');
        assert.equal(await rebuilds(page), 0, 'sliding rebuilds nothing');
        assert.deepEqual(await page.evaluate(() => [window.scrollX, window.scrollY]), scrollBefore, 'and scrolls nothing');
        await page.locator('.trace-color-popover .trace-color-apply').tap();
        await page.waitForFunction(([id, color]) => window.app.plotManager.plots.get(id)?.traces[0]?.color === color, [panelId, looked]);
        assert.equal(await page.locator('.trace-color-popover').count(), 0, 'Apply closes the picker');
        assert.equal(await rebuilds(page), 1, 'and rebuilds the panel once');
        assert.deepEqual(errors, [], 'no page errors on the phone');
        await context.close();
    }
    console.log('legend trace style e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
