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
    // ── No desktop flash while the app loads ────────────────────────────────
    // The app's code (Plotly included) takes a moment on a phone; until it
    // runs, the page must already be the phone layout, not the desktop one.
    {
        const boot = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const bootPage = await boot.newPage();
        await bootPage.route('**/app.js', async route => {
            await new Promise(resolve => setTimeout(resolve, 2500));
            await route.continue();
        });
        await bootPage.goto(baseUrl, { waitUntil: 'commit' });
        await bootPage.waitForSelector('#drop-zone', { state: 'attached' });
        await bootPage.waitForTimeout(300);
        assert.equal(await bootPage.evaluate(() => typeof window.app), 'undefined', 'the app has not started yet');
        assert.equal(await bootPage.evaluate(() => document.documentElement.classList.contains('compact')), true, 'yet the page is already the phone layout');
        assert.equal(await bootPage.locator('.top-bar').isVisible(), false, 'no desktop top bar flashes');
        assert.equal(await bootPage.locator('#sidebar').isVisible(), false, 'no desktop sidebar flashes');
        if (shots) await bootPage.screenshot({ path: `${shots}/compact-boot.png` });
        await bootPage.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
        assert.equal(await bootPage.locator('#compact-nav').isVisible(), true, 'and the app takes over without a flip');
        await boot.close();
    }

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

    assert.equal(
        await page.evaluate(() => getComputedStyle(document.body).userSelect || getComputedStyle(document.body).webkitUserSelect),
        'none',
        'a finger held down does not select text',
    );

    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    // ── The empty plot speaks the phone's language ──────────────────────────
    const placeholderText = await page.locator('.compact-active-panel .layout-panel-placeholder').innerText();
    assert.doesNotMatch(placeholderText, /Ctrl|Shift|[Dd]rop/, 'no drag, Ctrl or Shift instructions on a phone');
    await page.locator('.compact-active-panel .compact-placeholder-btn').click();
    await page.waitForFunction(() => window.app._compact.sheet === 'data');
    await page.locator('.compact-sheet-close').click();
    await page.waitForFunction(() => window.app._compact.sheet === null);

    // ── A large dialog takes the screen, with a ✕ ───────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="data"]').click();
    await page.locator('#variables-tree .tree-item[data-var-name="time"]').click();
    await page.waitForSelector('.modal-overlay.compact-fullscreen-overlay .compact-dialog-close');
    const box = await page.locator('.compact-fullscreen-dialog').boundingBox();
    assert.ok(box.width >= 389 && box.height >= 843, 'the time-axis inspector fills the screen');
    await page.locator('.compact-dialog-close').click();
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
    await page.locator('.compact-sheet-close').click();

    // ── Data: tap to plot, tap again to remove ──────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="data"]').click();
    await page.waitForFunction(() => document.querySelector('.compact-sheet #sidebar'));
    const leaf = name => page.locator(`#variables-tree .tree-item[data-var-name="${name}"]`);
    assert.match(await page.locator('.compact-data-target').innerText(), /Signals you tap go to:/, 'Data says which plot a tap goes to');
    assert.equal(await page.locator('.compact-target-chip.is-active').innerText(), 'Plot 1', 'as a chip, even when it is the only plot');
    assert.equal(await page.locator('.compact-target-chip').count(), 1);
    await leaf('voltage').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 1);
    assert.equal(await page.locator('.compact-toast.is-shown').innerText(), 'Added to plot 1: voltage', 'and what a tap did');
    await page.waitForFunction(() => document.querySelector('#variables-tree .tree-item[data-var-name="voltage"]')?.classList.contains('compact-on-plot'));
    await leaf('voltage').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 0);
    await leaf('voltage').click();
    await leaf('current').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 2);
    s = await state();
    assert.deepEqual(s.traces, ['voltage', 'current'], 'a tap puts a signal on the plot, a second tap takes it off');
    {
        const edge = await page.evaluate(() => {
            const panel = document.querySelector('.compact-active-panel');
            const r = panel.getBoundingClientRect();
            return { left: r.left, right: r.right, width: innerWidth, radius: getComputedStyle(panel).borderTopLeftRadius };
        });
        assert.ok(edge.left === 0 && edge.right === edge.width && edge.radius === '0px', `the plot runs edge to edge (${JSON.stringify(edge)})`);
    }
    await shot(page, 'data');

    // ── Back closes the sheet and stays on the page ─────────────────────────
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => window.app._compact.sheet === null);
    assert.equal(await page.evaluate(() => window.app.plotManager.files.size), 1, 'Back did not leave the app');
    assert.equal(await page.locator('#sidebar').isVisible(), false, 'the sidebar went back where it came from');

    // ── On the plot: fit buttons and the slow double tap ────────────────────
    {
        await page.waitForTimeout(400);
        const fitButtons = page.locator('.compact-active-panel .compact-fit-group:not([hidden]) .compact-fit-btn');
        assert.equal(await fitButtons.count(), 3, 'a plot with signals has fit X, fit Y and fit both');
        const xRange = () => page.evaluate(() => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            return plot.div._fullLayout.xaxis.range.map(Number);
        });
        const full = await xRange();
        const area = await page.evaluate(() => {
            const div = window.app.plotManager.plots.get(window.app._compactActivePanelId()).div;
            const r = div.getBoundingClientRect();
            const { xaxis, yaxis } = div._fullLayout;
            return { left: r.left + xaxis._offset, width: xaxis._length, top: r.top + yaxis._offset, height: yaxis._length };
        });
        const cdp = await context.newCDPSession(page);
        const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
        const x0 = area.left + area.width * 0.3;
        const y0 = area.top + area.height * 0.6;
        // Tap … tap (slowly) … drag.
        await touch('touchStart', x0, y0); await page.waitForTimeout(60); await touch('touchEnd');
        await page.waitForTimeout(420);
        await touch('touchStart', x0, y0); await page.waitForTimeout(60); await touch('touchEnd');
        await page.waitForSelector('.touch-window-zoom-hint');
        await touch('touchStart', x0, y0);
        for (let i = 1; i <= 8; i++) { await touch('touchMove', x0 + i * 15, y0); await page.waitForTimeout(16); }
        assert.equal(await page.locator('.touch-window-zoom-band').count(), 1, 'the drag draws the window');
        await touch('touchEnd');
        await page.waitForFunction(() => !document.querySelector('.touch-window-zoom-band'));
        await page.waitForTimeout(300);
        const zoomed = await xRange();
        assert.ok(zoomed[0] > full[0] && zoomed[1] < full[1], `the plot zoomed into the window (${zoomed} within ${full})`);
        assert.ok(zoomed[1] - zoomed[0] < (full[1] - full[0]) * 0.6, 'to about the width that was drawn');
        await page.waitForTimeout(400);
        assert.equal(
            await page.locator('.compact-active-panel .hoverlayer .hovertext').count(),
            0,
            'the first tap\'s value label does not come back after the zoom',
        );
        await shot(page, 'window-zoom');
        await page.locator('.compact-active-panel .compact-fit-btn[data-axis="x"]').tap();
        await page.waitForFunction(([lo, hi]) => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            const range = plot.div._fullLayout.xaxis.range.map(Number);
            return Math.abs(range[0] - lo) < 1e-6 && Math.abs(range[1] - hi) < 1e-6;
        }, full);
        // One finger alone still pans.
        await page.waitForTimeout(800);
        await touch('touchStart', x0, y0);
        for (let i = 1; i <= 6; i++) { await touch('touchMove', x0 + i * 12, y0); await page.waitForTimeout(16); }
        await touch('touchEnd');
        await page.waitForTimeout(300);
        const panned = await xRange();
        assert.ok(panned[0] < full[0] && Math.abs((panned[1] - panned[0]) - (full[1] - full[0])) < 1e-6, 'one finger pans, the width unchanged');
        // A single tap reads a value.
        await page.waitForTimeout(800);
        await touch('touchStart', x0, y0); await page.waitForTimeout(60); await touch('touchEnd');
        await page.waitForSelector('.compact-active-panel .hoverlayer .hovertext');
        await page.waitForTimeout(800);
        await page.locator('.compact-active-panel .compact-fit-btn[data-axis="all"]').tap();
        await cdp.detach();
    }

    // ── Plot sheet: more signals come from Data ─────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
    await page.locator('.compact-add-signals-btn').click();
    await page.waitForFunction(() => window.app._compact.sheet === 'data');
    await page.locator('.compact-sheet-close').click();
    await page.waitForFunction(() => window.app._compact.sheet === null);

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
    // Sizes a finger and an eye can use: no control under 40 px tall, no text
    // under 14 px, in the sheet with the most desktop pieces in it (the FFT
    // options) and in the Data sheet.
    const sizeProblems = (target = page) => target.evaluate(() => {
        const visible = el => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        };
        const sheet = document.querySelector('.compact-sheet-body');
        const problems = [];
        for (const el of sheet.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]):not([type=range])')) {
            if (!visible(el) || el.matches('.fft-help-btn, .compact-icon-btn')) continue;
            const h = el.getBoundingClientRect().height;
            if (h < 40) problems.push(`${el.className || el.tagName} is ${Math.round(h)} px tall`);
        }
        const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const text = walker.currentNode.textContent.trim();
            const parent = walker.currentNode.parentElement;
            if (!text || !visible(parent) || parent.closest('svg, .tree-time-axis-inspect')) continue;
            const size = parseFloat(getComputedStyle(parent).fontSize);
            if (size < 14) problems.push(`"${text.slice(0, 30)}" is ${size} px`);
        }
        return problems;
    });
    assert.deepEqual(await sizeProblems(), [], 'the FFT options are phone-sized');
    await page.locator('.compact-sheet-close').click();
    await page.waitForFunction(() => window.app._compact.sheet === null);
    assert.equal(
        await page.evaluate(() => !!document.querySelector('.fft-workspace > .fft-options')),
        true,
        'closing the sheet gives the FFT its options panel back',
    );
    s = await state();
    assert.deepEqual(s.traces, ['voltage', 'current'], 'switching to FFT kept the signals');
    assert.equal(
        await page.locator('.compact-active-panel .compact-fit-group:not([hidden])').count(),
        2,
        'the time pane and the spectrum each have their fit buttons',
    );

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
    // Data offers both plots as targets; choosing one there makes it the plot on screen.
    await page.locator('.compact-page-plot .compact-primary-btn', { hasText: 'Choose signals' }).click();
    await page.waitForFunction(() => window.app._compact.sheet === 'data');
    assert.equal(await page.locator('.compact-target-chip').count(), 2, 'Data offers both plots');
    assert.equal(await page.locator('.compact-target-chip.is-active').innerText(), 'Plot 2');
    await page.locator('.compact-target-chip', { hasText: 'Plot 1' }).click();
    s = await state();
    assert.equal(s.appBar, 'Plot 1 of 2', 'choosing a target in Data puts that plot on screen');
    assert.equal(await page.locator('#variables-tree .tree-item[data-var-name="voltage"]').evaluate(n => n.classList.contains('compact-on-plot')), true,
        'and the marks follow it');
    await page.locator('.compact-target-chip', { hasText: 'Plot 2' }).click();
    await page.locator('.compact-data-done').click();
    await page.waitForFunction(() => window.app._compact.sheet === 'plot');
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

    // ── 2D (x–y): a tap is an X, then a Y ───────────────────────────────────
    await page.locator('.compact-plot-selector').click();
    assert.equal(await page.locator('.compact-sheet-close').getAttribute('aria-label'), 'Hide', 'a sheet is hidden, not closed');
    await page.locator('.compact-plot-types [data-plot-type="phase2d"]').click();
    // The time series on it would be lost: asked first.
    await page.locator('.modal-overlay .modal-btn-confirm').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.mode === 'phase2d');
    assert.match(await page.locator('.compact-active-panel .layout-panel-placeholder').innerText(), /X signal/, 'the empty 2D plot says what it needs');
    await page.locator('.compact-nav-btn[data-sheet="data"]').click();
    assert.match(await page.locator('.compact-phase-banner').innerText(), /X signal, then the Y/, 'the Data sheet explains the order');
    await leaf('voltage').click();
    await page.waitForFunction(() => /x = voltage/.test(document.querySelector('.compact-phase-banner')?.textContent || ''));
    assert.equal(await leaf('voltage').getAttribute('data-compact-role'), 'x …', 'the chosen X is marked as waiting');
    await leaf('current').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.phaseTraces?.length === 1);
    assert.deepEqual(
        await page.evaluate(() => window.app.plotManager.plots.get(window.app._compactActivePanelId()).phaseTraces.map(p => [p.x, p.y])),
        [['voltage', 'current']],
        'the second tap completes the pair',
    );
    await page.waitForFunction(() => document.querySelector('#variables-tree .tree-item[data-var-name="current"]')?.dataset.compactRole === 'y');
    assert.equal(await leaf('voltage').getAttribute('data-compact-role'), 'x');
    // An X chosen by mistake is taken back by tapping it again.
    await leaf('temp').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.phasePending?.x === 'temp');
    await leaf('temp').click();
    await page.waitForFunction(() => !window.app.plotManager.plots.get(window.app._compactActivePanelId())?.phasePending?.x);
    await shot(page, '2d-data');
    await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
    assert.equal(await page.locator('.compact-page-plot .compact-trace-name', { hasText: 'voltage / current' }).count(), 1, 'the Plot sheet lists the pair');
    await shot(page, '2d-plot-sheet');
    await page.locator('.compact-page-plot .compact-trace-remove').first().click();
    await page.waitForFunction(() => !window.app.plotManager.plots.get(window.app._compactActivePanelId())?.phaseTraces?.length);
    // Back to a time series, empty: nothing to confirm.
    await page.locator('.compact-plot-types [data-plot-type="timeseries"]').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.mode === 'timeseries');
    await page.locator('.compact-sheet-close').click();

    // ── More: the menus survive taps inside the sheet ───────────────────────
    await page.locator('.compact-nav-btn[data-sheet="more"]').click();
    await page.locator('.compact-switch-row input').click();
    await page.locator('.compact-switch-row input').click();
    // Examples and the menu are phone lists, not the desktop dropdowns.
    assert.equal(await page.locator('.compact-sheet #example-menu, .compact-sheet #extra-menu').count(), 0, 'the desktop menus are not lent');
    assert.equal(await page.locator('.compact-sheet .compact-menu-btn', { hasText: 'Lorenz Attractor' }).isVisible(), true, 'the examples stay listed after a tap elsewhere in the sheet');
    for (const title of ['Project', 'Tools', 'Help and feedback']) {
        assert.equal(await page.locator('.compact-page-more .compact-section-title', { hasText: title }).count(), 1, `the menu has its ${title} group`);
    }
    assert.match(await page.locator('.compact-menu-btn', { hasText: 'Save view' }).innerText(), /visual configuration/,
        'each item says what it does, as a tooltip would on the desktop');
    assert.equal(
        await page.locator('.compact-sheet .compact-menu-btn', { hasText: /desktop|standalone/i }).count(),
        0,
        'a phone is not offered a desktop application',
    );
    // An example's model actions are one level below loading it.
    const pendulum = page.locator('.compact-menu-item', { hasText: 'Simple Pendulum' });
    assert.equal(await pendulum.locator('.compact-menu-subactions').isVisible(), false);
    await pendulum.locator('.compact-menu-more').click();
    assert.equal(await pendulum.locator('.compact-menu-subactions .compact-menu-btn').count(), 2, 'download and copy the model');
    await page.locator('.compact-menu-btn', { hasText: /^Help$/ }).click();
    await page.waitForSelector('.help-modal');
    await page.locator('.help-modal-close').click();
    await page.waitForFunction(() => !document.querySelector('.help-modal'));
    await page.locator('.compact-nav-btn[data-sheet="more"]').click();
    await page.waitForFunction(() => window.app._compact.sheet === 'more');
    await page.locator('.compact-sheet-close').click();

    // ── Feedback: files are chosen, not pasted or dragged ───────────────────
    await page.evaluate(() => window.app.showFeedbackForm());
    await page.waitForSelector('.feedback-overlay .feedback-file-button');
    assert.equal(await page.locator('.feedback-paste-zone').isVisible(), false, 'no paste-or-drag zone on a phone');
    assert.equal(await page.locator('.feedback-file-button').isVisible(), true, 'the file chooser stays');
    await page.locator('.feedback-overlay .compact-dialog-close').click();
    await page.waitForFunction(() => !document.querySelector('.feedback-overlay.show'));

    // ── Help takes the whole screen ─────────────────────────────────────────
    await page.evaluate(() => window.app.showHelp());
    await page.waitForSelector('.help-modal');
    await page.waitForTimeout(400); // its entrance animation
    {
        const helpBox = await page.locator('.help-modal').boundingBox();
        assert.ok(helpBox.x <= 0.5 && helpBox.y <= 0.5 && helpBox.width >= 389 && helpBox.height >= 843, 'help fills the screen');
    }
    await page.locator('.help-modal-close').click();
    await page.waitForFunction(() => !document.querySelector('.help-modal'));

    // ── The navigation's icons are in colour ────────────────────────────────
    {
        const colours = await page.evaluate(() => [...document.querySelectorAll('.compact-nav-btn .compact-btn-icon')]
            .map(icon => getComputedStyle(icon).color));
        assert.equal(new Set(colours).size, 4, `each destination has its own colour (${colours.join(', ')})`);
    }

    // ── The user can ask for the full layout, and back ──────────────────────
    await page.evaluate(() => window.app._setCompactLayoutOverride('full'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact')), false, 'Full overrides the phone layout');
    assert.equal(await page.locator('.top-bar').isVisible(), true);
    await page.evaluate(() => window.app._setCompactLayoutOverride('auto'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact')), true);

    assert.deepEqual(errors, [], 'no page errors on the phone');
    await context.close();

    // ── Temporal profile, like FFT: chosen in Analyze, options in the sheet ─
    {
        const profileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const profilePage = await profileContext.newPage();
        const profileErrors = [];
        profilePage.on('pageerror', e => profileErrors.push(e.message));
        await profilePage.goto(baseUrl);
        await profilePage.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
        // Hourly, two months, calendar time: what a temporal profile is for.
        const rows = ['timestamp,load,temp'];
        const start = Date.UTC(2024, 0, 1);
        for (let i = 0; i < 24 * 60; i++) {
            const date = new Date(start + i * 3600e3);
            const hour = date.getUTCHours();
            rows.push(`${date.toISOString().slice(0, 19).replace('T', ' ')},${(50 + 30 * Math.sin((hour - 6) / 24 * 2 * Math.PI)).toFixed(2)},${(15 + 8 * Math.sin((hour - 9) / 24 * 2 * Math.PI)).toFixed(2)}`);
        }
        await profilePage.setInputFiles('#file-input', [{ name: 'load.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n') + '\n') }]);
        await profilePage.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        const profilePlot = () => profilePage.evaluate(() => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            return { mode: plot?.mode, traces: (plot?.traces || []).map(t => t.varName) };
        });
        await profilePage.locator('.compact-nav-btn[data-sheet="data"]').click();
        await profilePage.locator('#variables-tree .tree-item[data-var-name="load"]').click();
        await profilePage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 1);
        await profilePage.locator('.compact-nav-btn[data-sheet="analyze"]').click();
        await profilePage.locator('.compact-radio', { hasText: 'Temporal profile' }).click();
        await profilePage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.mode === 'temporal-profile');
        await profilePage.waitForFunction(() => document.querySelector('.compact-sheet .temporal-profile-options'), null, { timeout: 15000 });
        await profilePage.waitForFunction(() => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            return plot?.temporalProfileDiv?.data?.length > 0;
        }, null, { timeout: 30000 });
        assert.equal(await profilePage.locator('.temporal-profile-container .hist-topbar-group').first().isVisible(), false,
            'the profile\'s own buttons are in the sheet, not over the plot');
        assert.ok(await profilePage.locator('.compact-page-analyze .compact-secondary-btn', { hasText: 'V/H' }).isVisible(), 'its layout switch is');
        assert.deepEqual(await sizeProblems(profilePage), [], 'the profile options are phone-sized');
        await shot(profilePage, 'analyze-profile');
        await profilePage.locator('.compact-sheet-close').click();
        await profilePage.waitForFunction(() => window.app._compact.sheet === null);
        assert.equal(await profilePage.evaluate(() => !!document.querySelector('.temporal-profile-container .hist-workspace > .hist-options')), true,
            'closing the sheet gives the profile its options panel back');
        await profilePage.waitForTimeout(400);
        assert.equal(await profilePage.locator('.compact-active-panel .compact-fit-group:not([hidden])').count(), 2,
            'the time pane and the profile each have their fit buttons');
        await shot(profilePage, 'profile');
        // Signals come and go from Data as on a time series.
        await profilePage.locator('.compact-nav-btn[data-sheet="data"]').click();
        await profilePage.locator('#variables-tree .tree-item[data-var-name="temp"]').click();
        await profilePage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 2);
        await profilePage.locator('#variables-tree .tree-item[data-var-name="load"]').click();
        await profilePage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 1);
        assert.deepEqual(await profilePlot(), { mode: 'temporal-profile', traces: ['temp'] }, 'a tap adds to the profile and takes off it');
        await profilePage.locator('.compact-nav-btn[data-sheet="plot"]').click();
        assert.equal(await profilePage.locator('.compact-trace-row').count(), 1, 'the Plot sheet lists the profile\'s signals');

        // The integral, the same way: chosen in Analyze, options in the sheet.
        await profilePage.locator('.compact-nav-btn[data-sheet="analyze"]').click();
        await profilePage.locator('.compact-radio', { hasText: 'Integral' }).click();
        await profilePage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.mode === 'integral');
        await profilePage.waitForFunction(() => document.querySelector('.compact-sheet .integral-options'), null, { timeout: 15000 });
        await profilePage.waitForFunction(() => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            return plot?.integralDiv?.data?.length > 0;
        }, null, { timeout: 30000 });
        assert.equal(await profilePage.locator('.integral-container .hist-topbar-group').first().isVisible(), false,
            'the integral\'s own buttons are in the sheet, not over the plot');
        assert.deepEqual(await sizeProblems(profilePage), [], 'the integral options are phone-sized');
        await shot(profilePage, 'analyze-integral');
        await profilePage.locator('.compact-sheet-close').click();
        await profilePage.waitForFunction(() => window.app._compact.sheet === null);
        assert.equal(await profilePage.evaluate(() => !!document.querySelector('.integral-container .hist-workspace > .hist-options')), true,
            'closing the sheet gives the integral its options panel back');
        await profilePage.waitForTimeout(400);
        assert.equal(await profilePage.locator('.compact-active-panel .compact-fit-group:not([hidden])').count(), 2,
            'the time pane and the bars each have their fit buttons');
        await shot(profilePage, 'integral');
        await profilePage.locator('.compact-nav-btn[data-sheet="data"]').click();
        await profilePage.locator('#variables-tree .tree-item[data-var-name="load"]').click();
        await profilePage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 2);
        assert.deepEqual(await profilePlot(), { mode: 'integral', traces: ['temp', 'load'] }, 'a tap adds to the integral');
        assert.deepEqual(profileErrors, [], 'no page errors with the temporal profile');
        await profileContext.close();
    }

    // ── 3D, and 2D and 3D animations: signals in roles, one tap each ───────
    {
        const rolesContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const rolesPage = await rolesContext.newPage();
        const rolesErrors = [];
        rolesPage.on('pageerror', e => rolesErrors.push(e.message));
        await rolesPage.goto(baseUrl);
        await rolesPage.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
        const rows = ['time,x,y,z'];
        for (let i = 0; i < 1500; i++) { const t = i / 100; rows.push(`${t},${Math.sin(t)},${Math.sin(2 * t)},${Math.cos(3 * t)}`); }
        await rolesPage.setInputFiles('#file-input', [{ name: 'xyz.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n') + '\n') }]);
        await rolesPage.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        const rolesState = () => rolesPage.evaluate(() => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            return {
                mode: plot.mode,
                dim: plot.mode === 'state-anim' ? plot.stateAnimDim : undefined,
                curves: (plot.phaseTraces || []).map(t => [t.x, t.y, t.z].filter(Boolean).join('/')),
                slots: plot.stateSlots?.x || [],
                drawn: !!plot.div,
            };
        });
        const tapSignal = async (name) => {
            await rolesPage.locator(`#variables-tree .tree-item[data-var-name="${name}"]`).click();
            await rolesPage.waitForTimeout(250);
        };
        const choosePlotType = async (type) => {
            await rolesPage.locator('.compact-nav-btn[data-sheet="plot"]').click();
            await rolesPage.locator(`.compact-plot-types [data-plot-type="${type}"]`).click();
            if (await rolesPage.locator('.modal-overlay .modal-btn-confirm').count()) await rolesPage.locator('.modal-overlay .modal-btn-confirm').click();
            await rolesPage.locator('.compact-nav-btn[data-sheet="data"]').click();
            await rolesPage.waitForFunction(() => window.app._compact.sheet === 'data');
        };

        // 3D: x, y, z make one curve.
        await choosePlotType('phase3d');
        await tapSignal('x');
        await tapSignal('y');
        assert.equal(await rolesPage.locator('#variables-tree .tree-item[data-var-name="y"]').getAttribute('data-compact-role'), 'y …',
            'the curve being chosen marks its signals');
        assert.match(await rolesPage.locator('.compact-phase-text').innerText(), /Z signal/, 'and says the Z is next');
        await tapSignal('z');
        await rolesPage.waitForFunction(() => !!window.app.plotManager.plots.get(window.app._compactActivePanelId())?.div);
        assert.deepEqual((await rolesState()).curves, ['x/y/z'], 'x, y, z: one 3D curve');

        // A slow double tap, then a drag, pans the scene; one finger alone
        // still orbits it.
        await rolesPage.locator('.compact-sheet-close').click();
        await rolesPage.waitForFunction(() => window.app._compact.sheet === null);
        await rolesPage.waitForTimeout(600);
        const sceneBox = await rolesPage.evaluate(() => {
            const r = window.app.plotManager.plots.get(window.app._compactActivePanelId()).div._fullLayout.scene._scene.container.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const camera = () => rolesPage.evaluate(() => {
            const { eye, center } = window.app.plotManager.plots.get(window.app._compactActivePanelId()).div._fullLayout.scene._scene.getCamera();
            return { eye, center };
        });
        const sceneCdp = await rolesContext.newCDPSession(rolesPage);
        const finger = (type, x, y) => sceneCdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
        const lookOf = (cam) => [cam.eye.x - cam.center.x, cam.eye.y - cam.center.y, cam.eye.z - cam.center.z];
        const cosine = (a, b) => (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
        const panOnce = async (slow) => {
            const before = await camera();
            await finger('touchStart', sceneBox.x, sceneBox.y); await rolesPage.waitForTimeout(60); await finger('touchEnd');
            await rolesPage.waitForTimeout(420);
            if (slow) {
                await finger('touchStart', sceneBox.x, sceneBox.y); await rolesPage.waitForTimeout(60); await finger('touchEnd');
                await rolesPage.waitForSelector('.touch-window-zoom-hint');
            }
            await finger('touchStart', sceneBox.x, sceneBox.y);
            for (let i = 1; i <= 8; i++) { await finger('touchMove', sceneBox.x + i * 8, sceneBox.y + i * 4); await rolesPage.waitForTimeout(16); }
            await finger('touchEnd');
            await rolesPage.waitForTimeout(400);
            const after = await camera();
            const moved = Math.hypot(after.center.x - before.center.x, after.center.y - before.center.y, after.center.z - before.center.z);
            return { moved, cos: cosine(lookOf(before), lookOf(after)) };
        };
        for (const slow of [false, true]) {
            const { moved, cos } = await panOnce(slow);
            assert.ok(moved > 1e-3, `${slow ? 'two slow taps, then a drag' : 'a tap, then a drag'}: the 3D scene pans`);
            assert.ok(cos > 0.9999, `and does not rotate (cos = ${cos})`);
        }
        await rolesPage.waitForTimeout(800);
        const beforeOrbit = await camera();
        await finger('touchStart', sceneBox.x, sceneBox.y);
        for (let i = 1; i <= 8; i++) { await finger('touchMove', sceneBox.x + i * 10, sceneBox.y); await rolesPage.waitForTimeout(16); }
        await finger('touchEnd');
        await rolesPage.waitForTimeout(400);
        assert.ok(cosine(lookOf(beforeOrbit), lookOf(await camera())) < 0.9999, 'one finger alone still orbits');
        await sceneCdp.detach();
        await rolesPage.locator('.compact-nav-btn[data-sheet="data"]').click();
        await rolesPage.waitForFunction(() => window.app._compact.sheet === 'data');

        // 2D animation: x₁, x₂; a third tap is refused, a tap on one takes it off.
        await choosePlotType('state-anim-2d');
        assert.equal((await rolesState()).mode, 'state-anim');
        await tapSignal('x');
        await tapSignal('y');
        await rolesPage.waitForFunction(() => !!window.app.plotManager.plots.get(window.app._compactActivePanelId())?.div);
        assert.deepEqual((await rolesState()).slots, ['x', 'y'], 'x₁ and x₂, in the order tapped');
        assert.equal(await rolesPage.locator('#variables-tree .tree-item[data-var-name="x"]').getAttribute('data-compact-role'), 'x₁');
        await tapSignal('z');
        assert.match(await rolesPage.locator('.compact-toast').innerText(), /2 state variables/, 'a full state says so');
        assert.deepEqual((await rolesState()).slots, ['x', 'y']);
        await rolesPage.locator('.compact-sheet-close').click();
        await rolesPage.waitForFunction(() => window.app._compact.sheet === null);
        const play = rolesPage.locator('.compact-active-panel .sa-play-btn');
        assert.ok((await play.boundingBox()).height >= 44, 'play is finger-sized');
        assert.equal(await rolesPage.locator('.compact-active-panel .sa-toggle').first().isVisible(), false,
            'the display checkboxes leave the bar');
        await shot(rolesPage, 'anim-2d');
        // Playing, it keeps still under a finger (Safari drops a tap's click
        // when the page changes during it), and pause stops it at one tap.
        const animFrame = () => rolesPage.evaluate(() => window.app.plotManager.plots.get(window.app._compactActivePanelId()).animFrame);
        const animPlaying = () => rolesPage.evaluate(() => !!window.app.plotManager.plots.get(window.app._compactActivePanelId()).animPlaying);
        if (!(await animPlaying())) await play.tap();
        await rolesPage.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId()).animFrame > 5);
        const touchCdp = await rolesContext.newCDPSession(rolesPage);
        await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 300 }] });
        const heldAt = await animFrame();
        await rolesPage.waitForTimeout(500);
        assert.equal(await animFrame(), heldAt, 'a finger on the screen holds the animation still');
        await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await rolesPage.waitForFunction((at) => window.app.plotManager.plots.get(window.app._compactActivePanelId()).animFrame !== at, heldAt, { timeout: 5000 });
        await touchCdp.detach();
        await play.tap();
        assert.equal(await animPlaying(), false, 'pause stops it at the first tap');
        const pausedAt = await animFrame();
        await rolesPage.waitForTimeout(400);
        assert.equal(await animFrame(), pausedAt, 'and it stays stopped');
        // …for switches in the Plot sheet, which set the animation's own.
        await rolesPage.locator('.compact-nav-btn[data-sheet="plot"]').click();
        const fullSwitch = rolesPage.locator('.compact-state-display .compact-switch-row', { hasText: 'full trajectory' }).locator('input');
        assert.equal(await fullSwitch.isChecked(), true);
        await fullSwitch.click();
        assert.equal(await rolesPage.evaluate(() => document.querySelector('.compact-active-panel .sa-chk-full').checked), false,
            'a switch sets the animation\'s own checkbox');
        await rolesPage.locator('.compact-nav-btn[data-sheet="data"]').click();
        await tapSignal('x');
        assert.deepEqual((await rolesState()).slots, ['y'], 'a tap on an assigned signal takes it off');

        // 3D animation: x₁, x₂, x₃.
        await choosePlotType('state-anim-3d');
        await tapSignal('x');
        await tapSignal('y');
        await tapSignal('z');
        await rolesPage.waitForFunction(() => !!window.app.plotManager.plots.get(window.app._compactActivePanelId())?.div);
        const anim3 = await rolesState();
        assert.equal(anim3.dim, 3);
        assert.deepEqual(anim3.slots, ['x', 'y', 'z'], 'a 3D animation from three taps');
        assert.deepEqual(rolesErrors, [], 'no page errors with 3D and the animations');
        await rolesContext.close();
    }

    // ── iOS: nothing may zoom the page in ───────────────────────────────────
    // Safari zooms in when a field under 16 px takes focus and stays zoomed,
    // the layout cut at the right (seen on an iPhone with the animation speed
    // selector). WebKit's GestureEvent is what the app detects iOS by.
    const ios = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    await ios.addInitScript(() => { window.GestureEvent = function GestureEvent() {}; });
    const ipage = await ios.newPage();
    const ierrors = [];
    ipage.on('pageerror', e => ierrors.push(e.message));
    await ipage.goto(baseUrl);
    await ipage.waitForFunction(() => window.app?.plotManager && document.documentElement.classList.contains('compact'));
    assert.match(
        await ipage.evaluate(() => document.querySelector('meta[name="viewport"]').content),
        /maximum-scale=1/,
        'on iOS the phone layout stops the zoom on focus',
    );
    // The Lorenz example: a 3D state animation, with its speed selector.
    await ipage.locator('.compact-try-example').click();
    await ipage.locator('.compact-sheet .compact-menu-btn', { hasText: 'Lorenz' }).first().click();
    await ipage.waitForFunction(() => document.querySelector('.state-anim-controls .sa-speed'), null, { timeout: 60000 });
    await ipage.waitForTimeout(800);
    const small = await ipage.evaluate(() => [...document.querySelectorAll('input, select, textarea')]
        .filter(el => !['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(el.type))
        .filter(el => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map(el => el.className || el.id || el.tagName));
    assert.deepEqual(small, [], 'no field is small enough for iOS to zoom into');
    assert.equal(
        await ipage.evaluate(() => getComputedStyle(document.querySelector('.plots-area')).touchAction),
        'none',
        'a pinch on the plot is the plot\'s, not the page\'s',
    );
    assert.equal(await ipage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    if (shots) await ipage.screenshot({ path: `${shots}/compact-ios-lorenz.png` });
    assert.deepEqual(ierrors, [], 'no page errors on iOS');
    await ios.close();

    // ── Desktop: untouched ──────────────────────────────────────────────────
    const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const dpage = await desktop.newPage();
    const derrors = [];
    dpage.on('pageerror', e => derrors.push(e.message));
    await dpage.goto(baseUrl);
    await dpage.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    assert.equal(await dpage.evaluate(() => document.documentElement.classList.contains('compact')), false, 'a desktop window keeps the desktop layout');
    assert.doesNotMatch(await dpage.evaluate(() => document.querySelector('meta[name="viewport"]').content), /maximum-scale/);
    assert.equal(await dpage.locator('#compact-nav').isVisible(), false);
    assert.equal(await dpage.locator('#compact-appbar').isVisible(), false);
    assert.equal(await dpage.locator('.top-bar').isVisible(), true);
    assert.equal(await dpage.locator('#sidebar').isVisible(), true);
    assert.equal(await dpage.locator('.layout-panel-toolbar').first().isVisible(), true);
    assert.equal(await dpage.locator('.compact-try-example').isVisible(), false);

    // ── From the desktop to the phone layout, and back ──────────────────────
    await dpage.locator('#extra-menu-btn').click();
    await dpage.locator('#extra-menu .extra-menu-item', { hasText: 'Mobile version' }).click();
    await dpage.waitForFunction(() => document.documentElement.classList.contains('compact'));
    assert.equal(await dpage.locator('#compact-nav').isVisible(), true, 'the menu switches a desktop window to the phone layout');
    assert.equal(await dpage.locator('.top-bar').isVisible(), false);
    if (shots) await dpage.screenshot({ path: `${shots}/compact-desktop-switched.png` });
    await dpage.locator('.compact-nav-btn[data-sheet="more"]').click();
    assert.equal(
        await dpage.locator('.compact-sheet .compact-menu-btn', { hasText: 'Mobile version' }).count(),
        0,
        'the phone layout does not offer itself',
    );
    await dpage.locator('.compact-segment', { hasText: 'Automatic' }).click();
    await dpage.waitForFunction(() => !document.documentElement.classList.contains('compact'));
    assert.equal(await dpage.locator('.top-bar').isVisible(), true, 'Automatic brings the desktop layout back');
    assert.equal(await dpage.locator('#sidebar').isVisible(), true, 'with its sidebar where it was');
    assert.deepEqual(derrors, [], 'no page errors on the desktop');
    await desktop.close();

    console.log('compact layout e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
