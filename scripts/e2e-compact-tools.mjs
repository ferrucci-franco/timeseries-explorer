// Data tools on a phone (src/app/methods/compact-tools-methods.js).
//
// Driven with a finger, the way the pages are meant to be used: Analyze → Data
// tools, a tile, the signal chosen from its list, the source put on the plot
// from the page so the dotted preview appears above it, the window stepped with
// + (and held), Create — the result on the plot and a card on the hub. Then:
// the tree's ✎ editing it live and Back putting it back, an Update from the
// card, help as pages (nested too), a segmented choice, a blocked Create that
// says why, a draft kept when the sheet is hidden and resumed from Analyze, a
// new dataset from Resample deleted from its card, a chain deleted in one go,
// the language switched under an open page, the side panel's controls going
// home, and every phone of the matrix upright and sideways with nothing poking
// out. The desktop panel is checked to be untouched.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:compact-tools`.
// SHOTS_DIR=<dir> also saves screenshots of each step.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,voltage,current,temp'];
    for (let i = 0; i < 2000; i++) {
        const t = i / 100;
        // A spike every ~4 s: something for Remove outliers to find.
        const spike = i % 397 === 0 ? 5 : 0;
        lines.push(`${t.toFixed(3)},${(Math.sin(2 * Math.PI * 1.5 * t) + 0.15 * Math.sin(97 * t) + spike).toFixed(5)},${(0.5 * Math.cos(2 * Math.PI * 4 * t)).toFixed(5)},${(20 + t / 5).toFixed(3)}`);
    }
    return { name: 'signals.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// Nothing in the sheet may stick out past its right edge, and the body must
// not scroll sideways.
const sidewaysProblems = page => page.evaluate(() => {
    const body = document.querySelector('.compact-sheet-body');
    if (!body) return ['no sheet'];
    const problems = [];
    if (body.scrollWidth > body.clientWidth + 1) problems.push(`the sheet is ${body.scrollWidth - body.clientWidth} px wider than the screen`);
    const right = body.getBoundingClientRect().right;
    for (const el of body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || el.closest('svg')) continue;
        // A field scrolls its own text sideways.
        if (el.closest('input, select, textarea')) continue;
        if (r.right > right + 1 && el.parentElement.getBoundingClientRect().right <= right + 1) {
            problems.push(`${el.tagName}.${el.className} ends ${Math.round(r.right - right)} px past the edge`);
        }
    }
    return problems.slice(0, 12);
});

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;
const shot = async (page, name) => {
    if (!shots) return;
    await page.waitForTimeout(350); // the sheet's slide
    await page.screenshot({ path: `${shots}/tools-${name}.png` });
};

async function openPhone(viewport, { dark = false } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: shots ? 2 : 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    if (dark) await page.evaluate(() => { if (window.app.theme !== 'dark') window.app.toggleTheme(); });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    return { context, page, errors };
}

const fileData = page => page.evaluate(() => {
    const data = window.app.plotManager.files.get(window.app.activeFileId).data;
    return Object.keys(data.variables);
});
const plotTraces = page => page.evaluate(() => {
    const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
    return (plot?.traces || []).map(trace => trace.varName);
});
const sheetIsFull = page => page.evaluate(() => document.documentElement.classList.contains('compact-sheet-full'));
const toolPage = async (page) => {
    await page.waitForSelector('.compact-page-tool:not([hidden])');
    await page.waitForTimeout(300);
};
const hub = async (page) => {
    await page.waitForSelector('.compact-page-tools:not([hidden])');
    await page.waitForTimeout(250);
};
const openHub = async (page) => {
    await page.locator('.compact-nav-btn[data-sheet="analyze"]').tap();
    await page.waitForSelector('.compact-page-analyze:not([hidden])');
    await page.locator('.compact-tools-analyze-row').tap();
};
// The side panel's controls are back in the side panel.
const panelWhole = page => page.evaluate(() => {
    const section = document.querySelector('.data-tools-section');
    const missing = [];
    for (const selector of ['#outlier-method-wrap', '#outlier-replacement-wrap', '#outlier-output-wrap',
        '#data-tool-live-chain-wrap', '.data-tool-controls[data-tool-kind="movingAverage"]',
        '.data-tool-controls[data-tool-kind="filter"]', '.data-tool-controls[data-tool-kind="resample"]']) {
        if (!section.querySelector(selector)) missing.push(selector);
    }
    if (document.querySelector('.data-tools-section .compact-tool-step')) missing.push('a stepper was left behind');
    return missing;
});

try {
    // ── Upright phone, the whole journey ────────────────────────────────────
    const { context, page, errors } = await openPhone({ width: 390, height: 844 });
    await page.locator('.compact-nav-btn[data-sheet="analyze"]').tap();
    await page.waitForSelector('.compact-page-analyze:not([hidden])');
    const row = page.locator('.compact-tools-analyze-row');
    assert.equal(await row.isVisible(), true, 'Analyze offers Data tools among the new signals');
    assert.match(await row.innerText(), /Filter, smooth/, 'with what it is for');
    await row.tap();
    await hub(page);
    // The tiles: every tool, in its family, each saying what it does.
    const tiles = await page.locator('.compact-tool-tile').evaluateAll(nodes => nodes.map(n => ({
        tool: n.dataset.tool,
        desc: n.querySelector('.compact-tool-desc').textContent,
        h: n.getBoundingClientRect().height,
    })));
    assert.equal(tiles.length, 11, 'eleven tools');
    assert.ok(tiles.every(t => t.desc.length > 20 && t.h >= 100), 'each tile says what its tool does, at a finger\'s size');
    assert.deepEqual(await page.locator('.compact-page-tools .compact-section-title').allInnerTexts(),
        ['CLEAN', 'CALCULUS', 'SMOOTH AND FILTER', 'RESAMPLE AND COMPARE', 'TRANSFORMATIONS'], 'four families, then what was made');
    assert.match(await page.locator('.compact-tools-empty').innerText(), /Nothing made/, 'nothing made yet');
    assert.deepEqual(await sidewaysProblems(page), [], 'the hub fits');
    assert.equal(await page.locator('.compact-sheet .data-tools-section').count(), 0, 'the desktop panel stays out of the phone layout');
    await shot(page, '01-hub');

    // ── A tool, its signal chosen from the list ──
    await page.locator('.compact-tool-tile[data-tool="movingAverage"]').tap();
    await toolPage(page);
    assert.equal(await sheetIsFull(page), false, 'the page opens at half height: the plot stays above it');
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'Moving average');
    assert.match(await page.locator('.compact-tool-signal').innerText(), /Choose a signal/, 'nothing on the plot to start from: the list is offered');
    assert.equal(await page.locator('.compact-tool-submit').isDisabled(), true, 'Create waits for a signal');
    assert.match(await page.locator('.compact-tool-reason').innerText(), /variable/i, 'and says so');
    // The desktop's own slider is here, with − and + beside its number.
    assert.equal(await page.locator('.compact-tool-settings #moving-average-window-slider').count(), 1, 'the panel\'s slider, lent');
    assert.equal(await page.locator('.compact-tool-settings .compact-tool-step').count(), 2, '− and + by the window');
    assert.equal(await page.locator('#moving-average-window').getAttribute('inputmode'), 'numeric', 'a digits keypad for a count');
    await page.locator('.compact-tool-signal').tap();
    await page.waitForSelector('.compact-page-tool-signal:not([hidden])');
    assert.deepEqual(await page.locator('.compact-tool-signal-option .compact-derived-var-name').allInnerTexts(),
        ['current', 'temp', 'voltage'], 'the signals of the file');
    await shot(page, '02-signal-list');
    await page.locator('.compact-tool-signal-option[data-value="voltage"]').tap();
    await toolPage(page);
    assert.match(await page.locator('.compact-tool-signal').innerText(), /voltage\s+2,000 points/, 'the signal, and how many points');
    assert.equal(await page.locator('#outlier-output-name').inputValue(), 'voltage avg', 'a name is suggested');
    // Not on the plot: the strip says how to watch the result, and does it.
    assert.match(await page.locator('.compact-tool-preview').innerText(), /Put voltage on plot 1/);
    await page.locator('.compact-tool-preview-show').tap();
    await page.waitForFunction(() => {
        const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
        return plot.traces.some(trace => trace.varName === '__dataToolPreview__');
    }, null, { timeout: 8000 });
    assert.deepEqual(await plotTraces(page), ['voltage', '__dataToolPreview__'], 'the source on the plot, and the result dotted beside it');
    await page.waitForSelector('.compact-tool-preview.is-dashed');
    await shot(page, '03-preview');

    // + steps the window; held, it keeps stepping. The preview follows.
    await page.locator('.compact-tool-step-up').tap();
    await page.locator('.compact-tool-step-up').tap();
    assert.equal(await page.locator('#moving-average-window').inputValue(), '23', '+ twice: 21 → 23');
    assert.equal(await page.locator('#moving-average-window-slider').inputValue(), '23', 'the slider follows');
    const up = page.locator('.compact-tool-step-up');
    await up.dispatchEvent('pointerdown');
    await page.waitForTimeout(1000);
    await up.dispatchEvent('pointerup');
    const held = Number(await page.locator('#moving-average-window').inputValue());
    assert.ok(held >= 28, `held, + keeps stepping (${held})`);
    await page.locator('.compact-tool-step-down').tap();
    assert.equal(Number(await page.locator('#moving-average-window').inputValue()), held - 1, '− steps back');
    const windowSize = held - 1;
    await page.waitForTimeout(500);
    assert.deepEqual(await sidewaysProblems(page), [], 'the tool page fits');

    // A refresh of the sheet under the page keeps it.
    await page.evaluate(() => window.app._renderCompactSheetContent());
    assert.equal(await page.locator('.compact-tool-settings #moving-average-window').count(), 1, 'a sheet refresh keeps the page and its controls');

    // ── Create ──
    assert.match(await page.locator('.compact-tool-plot-chip').innerText(), /Plot 1/, 'the result goes on plot 1');
    await page.locator('.compact-tool-submit').tap();
    await hub(page);
    await page.waitForFunction(() => window.app.plotManager.files.get(window.app.activeFileId).data.variables['voltage avg']);
    await page.waitForFunction(() => {
        const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
        return plot.traces.some(trace => trace.varName === 'voltage avg') && !plot.traces.some(trace => trace.varName === '__dataToolPreview__');
    }, null, { timeout: 8000 });
    assert.deepEqual(await plotTraces(page), ['voltage', 'voltage avg'], 'created and on the plot; the preview gone');
    assert.equal(await page.evaluate(() => window.app.dataToolVariablesByFile.get(window.app.activeFileId).get('voltage avg').params.window), windowSize, 'with the window set by the steppers');
    const card = page.locator('.compact-tool-card[data-result="voltage avg"]');
    assert.equal(await card.count(), 1, 'a card for it on the hub');
    assert.match(await card.innerText(), /voltage avg\s+voltage\s+Moving average/);
    assert.equal(await card.locator('.compact-tool-card-plot.is-active').count(), 1, 'marked as on plot 1');
    assert.match(await page.locator('.compact-tools-message').innerText(), /voltage avg/, 'the panel\'s verdict, above the cards');
    assert.deepEqual(await panelWhole(page), [], 'every control went back to the side panel');
    await shot(page, '04-created');

    // ── Edit from the tree's ✎: live, and Back puts it back ──
    await page.locator('.compact-nav-btn[data-sheet="data"]').tap();
    await page.waitForSelector('.compact-page-data:not([hidden])');
    const pencil = page.locator('#variables-tree .tree-item[data-var-name="voltage avg"] .tree-derived-edit.is-tool');
    assert.equal(await pencil.isVisible(), true, 'a tool\'s output has its ✎ on the phone');
    const before = await page.evaluate(() => Array.from(window.app.plotManager.files.get(window.app.activeFileId).data.variables['voltage avg'].data.slice(100, 110)));
    await pencil.tap();
    await toolPage(page);
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'Edit voltage avg');
    assert.equal(await page.locator('#moving-average-window').inputValue(), String(windowSize), 'its settings');
    assert.match(await page.locator('.compact-tool-preview').innerText(), /follows your settings/, 'the curve on the plot is the one being edited');
    assert.equal(await page.locator('.compact-tool-delete-btn').isVisible(), true, 'and a way to delete it');
    for (let i = 0; i < 10; i++) await page.locator('.compact-tool-step-up').tap();
    await page.waitForFunction((b) => {
        const now = Array.from(window.app.plotManager.files.get(window.app.activeFileId).data.variables['voltage avg'].data.slice(100, 110));
        return now.some((v, i) => Math.abs(v - b[i]) > 1e-9);
    }, before, { timeout: 8000 });
    await shot(page, '05-edit-live');
    await page.goBack();
    await page.waitForSelector('.compact-page-data:not([hidden])');
    await page.waitForFunction((b) => {
        const now = Array.from(window.app.plotManager.files.get(window.app.activeFileId).data.variables['voltage avg'].data.slice(100, 110));
        return now.every((v, i) => Math.abs(v - b[i]) < 1e-12);
    }, before, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.app._dataToolEditing), null, 'Back abandons the edit, and the values are what they were');

    // ── Update from the card ──
    await openHub(page);
    await hub(page);
    await page.locator('.compact-tool-card[data-result="voltage avg"] .compact-tool-card-main').tap();
    await toolPage(page);
    await page.locator('.compact-tool-step-up').tap();
    assert.match(await page.locator('.compact-tool-submit').innerText(), /Update/);
    await page.locator('.compact-tool-submit').tap();
    await hub(page);
    assert.equal(await page.evaluate(() => window.app.dataToolVariablesByFile.get(window.app.activeFileId).get('voltage avg').params.window), windowSize + 1, 'updated');

    // ── Help, as pages ──
    await page.locator('.compact-tool-tile[data-tool="removeOutliers"]').tap();
    await toolPage(page);
    assert.match(await page.locator('.compact-tool-signal').innerText(), /voltage/, 'a signal on the plot is where a tool starts');
    await page.locator('.compact-tool-settings .data-tool-help-toggle').first().tap();
    await page.waitForSelector('.compact-page-tool-help:not([hidden])');
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'Outlier detection help');
    assert.ok((await page.locator('.compact-tool-help .derived-help-row').count()) >= 2, 'the help rows');
    assert.equal(await page.locator('#outlier-help-popover').isVisible(), false, 'never the popover');
    await page.locator('.compact-sheet-back').tap();
    await toolPage(page);
    // Replace with NaN | Interpolate: a segmented choice.
    const segments = await page.locator('.compact-tool-settings .data-tool-radio-group .radio-label').evaluateAll(nodes => nodes.map(n => Math.round(n.getBoundingClientRect().top)));
    assert.equal(new Set(segments).size, 1, 'the two choices side by side');
    await page.locator('.compact-tool-settings .data-tool-radio-group .radio-label').nth(1).tap();
    assert.equal(await page.locator('input[name="outlier-replacement"][value="interpolate"]').isChecked(), true, 'a tap chooses');
    await page.locator('.compact-tool-cancel').tap();
    await hub(page);
    assert.equal(await page.evaluate(() => document.getElementById('data-tool-select').value), '', '✕ clears the draft');

    await page.locator('.compact-tool-tile[data-tool="filter"]').tap();
    await toolPage(page);
    // A designed filter with no cut-off cannot be created, and says why.
    assert.equal(await page.locator('.compact-tool-submit').isDisabled(), true, 'no cut-off, no filter');
    assert.ok((await page.locator('.compact-tool-reason').innerText()).length > 5, 'the reason is written under the buttons');
    assert.match(await page.locator('.compact-tool-preview').innerText(), /once the settings are complete/, 'and the plot shows nothing yet, saying why');
    await page.locator('#filter-design-cutoff').fill('5');
    await page.locator('#filter-design-cutoff').dispatchEvent('change');
    await page.waitForFunction(() => !document.querySelector('.compact-tool-submit').disabled);
    await page.waitForSelector('.compact-tool-preview.is-dashed', { timeout: 8000 });
    await page.locator('.compact-tool-help-btn').tap();
    await page.waitForSelector('.compact-page-tool-help-index:not([hidden])');
    assert.ok((await page.locator('.compact-page-tool-help-index .compact-menu-btn').count()) >= 5, 'the filter\'s help topics, as a list');
    await page.locator('.compact-page-tool-help-index .compact-menu-btn').first().tap();
    await page.waitForSelector('.compact-page-tool-help:not([hidden])');
    await page.locator('.compact-tool-help-more').tap();
    await page.waitForFunction(() => document.querySelector('.compact-sheet-title').textContent === 'Long delays and echoes');
    await shot(page, '06-help-nested');
    for (let i = 0; i < 3; i++) await page.locator('.compact-sheet-back').tap();
    await toolPage(page);
    await page.locator('.compact-sheet-size').tap();
    await page.waitForTimeout(300);
    assert.equal(await sheetIsFull(page), true);
    assert.equal(await page.locator('.compact-tool-preview-see').isVisible(), true, 'full height: the strip offers the plot back');
    await page.locator('.compact-sheet-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
    assert.deepEqual(await sidewaysProblems(page), [], 'the filter page fits');
    await shot(page, '07-filter-full');
    await page.locator('.compact-tool-preview-see').tap().catch(async () => {
        await page.locator('.compact-sheet-body').evaluate(body => { body.scrollTop = 0; });
        await page.locator('.compact-tool-preview-see').tap();
    });
    await page.waitForTimeout(300);
    assert.equal(await sheetIsFull(page), false, '"See the plot" halves the sheet');

    // ── A draft kept when the sheet is hidden, resumed from Analyze ──
    await page.locator('.compact-sheet-close').tap();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.compact-nav-btn[data-sheet="analyze"].has-tool-draft').count(), 1, 'Analyze says a draft waits');
    assert.ok((await plotTraces(page)).includes('__dataToolPreview__'), 'its preview still on the plot, to be looked at');
    await page.locator('.compact-nav-btn[data-sheet="analyze"]').tap();
    await page.waitForSelector('.compact-page-analyze:not([hidden])');
    assert.match(await page.locator('.compact-tools-analyze-row').innerText(), /Digital filter, not created yet/);
    await page.locator('.compact-tools-analyze-row').tap();
    await toolPage(page);
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'Digital filter', 'straight back to the page');
    assert.equal(await page.locator('#filter-design-cutoff').inputValue(), '5', 'with what was set');
    await page.locator('.compact-sheet-back').tap();
    await hub(page);
    assert.equal(await page.locator('.compact-tools-resume').isVisible(), true, 'Back leaves the draft; the hub offers it');
    await page.locator('.compact-tools-discard').tap();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.compact-tools-resume').count(), 0, 'Discard ends it');
    assert.ok(!(await plotTraces(page)).includes('__dataToolPreview__'), 'and takes its preview off the plot');

    // ── A chain, deleted in one go ──
    await page.locator('.compact-tool-tile[data-tool="derivative"]').tap();
    await toolPage(page);
    await page.locator('.compact-tool-signal').tap();
    await page.locator('.compact-tool-signal-option[data-value="voltage avg"]').tap();
    await toolPage(page);
    assert.equal(await page.locator('#outlier-output-name').inputValue(), 'voltage avg ddt');
    await page.locator('.compact-tool-plot-chip').tap();
    assert.equal(await page.locator('.compact-tool-plot-chip').getAttribute('aria-pressed'), 'false', 'the chip turns plotting off');
    await page.locator('.compact-tool-submit').tap();
    await hub(page);
    assert.ok(!(await plotTraces(page)).includes('voltage avg ddt'), 'not plotted, as asked');
    assert.equal(await page.locator('.compact-tool-card').count(), 2);
    await page.locator('.compact-tool-card[data-result="voltage avg"] .compact-tool-card-delete').tap();
    assert.match(await page.locator('.compact-tool-card-question').innerText(), /1 built on it/, 'asked on the card, with the chain');
    await shot(page, '08-delete-chain');
    await page.locator('.compact-tool-card-yes').tap();
    await page.waitForTimeout(400);
    const left = await fileData(page);
    assert.ok(!left.includes('voltage avg') && !left.includes('voltage avg ddt'), 'both gone');
    assert.equal(await page.locator('.compact-tool-card').count(), 0);

    // ── A new dataset: Resample, then deleted from its card ──
    await page.locator('.compact-tool-tile[data-tool="resample"]').tap();
    await toolPage(page);
    assert.match(await page.locator('.compact-tool-signal').innerText(), /All variables \(3\)/, 'the whole file by default');
    assert.match(await page.locator('.compact-tool-preview').innerText(), /new dataset/, 'and where its result will go');
    await page.locator('#resample-step').fill('0.05');
    await page.locator('#resample-step').dispatchEvent('input');
    await page.locator('#resample-step').dispatchEvent('change');
    await page.waitForFunction(() => !document.querySelector('.compact-tool-submit').disabled);
    await page.locator('.compact-tool-submit').tap();
    await hub(page);
    await page.waitForFunction(() => window.app.files.size === 2);
    const datasetCard = page.locator('.compact-tool-card[data-key^="dataset:"]');
    assert.equal(await datasetCard.count(), 1, 'the dataset has its card');
    assert.match(await datasetCard.innerText(), /signals resampled\S*\s+all variables\s+Resample · dataset/i, 'named after the new file, from the whole of this one');
    await datasetCard.locator('.compact-tool-card-delete').tap();
    await page.locator('.compact-tool-card-yes').tap();
    await page.waitForFunction(() => window.app.files.size === 1, null, { timeout: 8000 });

    // ── The language switched under an open page ──
    await page.locator('.compact-tool-tile[data-tool="integrate"]').tap();
    await toolPage(page);
    await page.evaluate(() => window.app.setLanguage('es'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'Integral', 'relabelled');
    assert.match(await page.locator('.compact-tool-intro-text').innerText(), /Área acumulada/, 'in Spanish');
    assert.equal(await page.locator('.compact-tool-settings #integral-method').count(), 1, 'its controls still lent');
    await page.evaluate(() => window.app.setLanguage('en'));
    await page.locator('.compact-tool-cancel').tap();
    await hub(page);

    // ── Back from the hub, and the layout switched to the desktop ──
    await page.goBack();
    await page.waitForSelector('.compact-page-analyze:not([hidden])');
    await page.locator('.compact-tools-analyze-row').tap();
    await hub(page);
    await page.locator('.compact-tool-tile[data-tool="detrend"]').tap();
    await toolPage(page);
    await page.evaluate(() => window.app._setCompactLayoutOverride('full'));
    await page.waitForFunction(() => !document.documentElement.classList.contains('compact'));
    assert.deepEqual(await panelWhole(page), [], 'the full layout gets its whole panel back');
    assert.equal(await page.locator('.data-tools-section .data-tool-controls[data-tool-kind="detrend"]').isVisible(), true, 'with the draft on show');

    assert.deepEqual(errors, [], 'no page errors');
    await context.close();

    // ── The desktop panel is untouched ──────────────────────────────────────
    {
        const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const p = await desktop.newPage();
        const errs = [];
        p.on('pageerror', e => errs.push(e.message));
        await p.goto(baseUrl);
        await p.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
        await p.setInputFiles('#file-input', [makeCsv()]);
        await p.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
        await p.selectOption('#data-tool-select', 'movingAverage');
        assert.equal(await p.locator('.data-tools-section .data-tool-controls[data-tool-kind="movingAverage"]').isVisible(), true, 'the desktop form');
        assert.equal(await p.locator('.compact-tool-step').count(), 0, 'with no phone steppers');
        assert.equal(await p.locator('#moving-average-window').getAttribute('inputmode'), null);
        assert.deepEqual(errs, [], 'desktop: no page errors');
        await desktop.close();
    }

    // ── Every phone of the matrix, upright and sideways, light and dark ─────
    for (const [width, height] of [[320, 568], [360, 800], [390, 844], [412, 915], [568, 320], [800, 360], [844, 390], [915, 412]]) {
        const dark = width === 360 || width === 844;
        const phone = await openPhone({ width, height }, { dark });
        const p = phone.page;
        await openHub(p);
        await hub(p);
        assert.deepEqual(await sidewaysProblems(p), [], `${width}×${height}: the hub fits`);
        await shot(p, `matrix-${width}x${height}-hub`);
        for (const tool of ['filter', 'removeOutliers', 'resample', 'xcorr', 'interpolate']) {
            await p.locator(`.compact-tool-tile[data-tool="${tool}"]`).tap();
            await toolPage(p);
            if (tool === 'filter' || tool === 'removeOutliers' || tool === 'interpolate') {
                await p.locator('.compact-tool-signal').tap();
                await p.locator('.compact-tool-signal-option[data-value="voltage"]').tap();
                await toolPage(p);
            }
            await p.locator('.compact-sheet-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
            assert.deepEqual(await sidewaysProblems(p), [], `${width}×${height}: ${tool} fits`);
            // The footer is in reach, its buttons a finger's size.
            const buttons = await p.locator('.compact-tool-footer button:not([hidden])').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect()).map(r => ({ h: r.height, bottom: r.bottom })));
            assert.ok(buttons.length >= 2 && buttons.every(b => b.h >= 44), `${width}×${height}: ${tool}'s buttons are 44 px tall`);
            assert.ok(buttons.every(b => b.bottom <= height + 1), `${width}×${height}: ${tool}'s buttons are on screen`);
            const steppers = await p.locator('.compact-tool-settings .compact-tool-step').evaluateAll(nodes => nodes.filter(n => n.offsetParent).map(n => n.getBoundingClientRect().width));
            assert.ok(steppers.every(w => w >= 44), `${width}×${height}: ${tool}'s − and + are 44 px wide`);
            if (tool === 'filter') await shot(p, `matrix-${width}x${height}-filter`);
            await p.locator('.compact-tool-cancel').tap();
            await hub(p);
        }
        assert.deepEqual(phone.errors, [], `${width}×${height}: no page errors`);
        await phone.context.close();
    }

    // ── Each language fits the narrowest phone ──────────────────────────────
    for (const lang of ['fr', 'es', 'it']) {
        const phone = await openPhone({ width: 320, height: 568 });
        const p = phone.page;
        await p.evaluate(l => window.app.setLanguage(l), lang);
        await openHub(p);
        await hub(p);
        assert.deepEqual(await sidewaysProblems(p), [], `${lang}: the hub fits 320 px`);
        for (const tool of ['filter', 'resample']) {
            await p.locator(`.compact-tool-tile[data-tool="${tool}"]`).tap();
            await toolPage(p);
            await p.locator('.compact-sheet-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
            assert.deepEqual(await sidewaysProblems(p), [], `${lang}: ${tool} fits 320 px`);
            for (const btn of await p.locator('.compact-tool-footer button:not([hidden])').all()) {
                const fits = await btn.evaluate(node => node.scrollWidth <= node.clientWidth + 1);
                assert.ok(fits, `${lang}: "${await btn.innerText()}" is not cut`);
            }
            await shot(p, `lang-${lang}-${tool}`);
            await p.locator('.compact-tool-cancel').tap();
            await hub(p);
        }
        assert.deepEqual(phone.errors, [], `${lang}: no page errors`);
        await phone.context.close();
    }

    console.log('compact data tools e2e passed');
} finally {
    await browser.close();
    await server.close();
}
