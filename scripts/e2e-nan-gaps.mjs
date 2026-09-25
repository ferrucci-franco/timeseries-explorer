// End-to-end check of the Marks menu's NaN/Inf and Gaps tools and its line
// shape (docs/marks-menu-nan-gaps-design.md) in a real browser.
//
// One file, numeric time, 1 s step with ±2 % jitter, 3000 rows:
//   - a 10 s dropout at t ≈ 1000 and a one-sample dropout at t ≈ 2000;
//   - `v` has a NaN block (rows 500–520) and a single NaN (row 1500);
//   - `w` is clean.
// Checks: the line breaks across NaN with every toggle off; NaN/Inf draws a
// violet strip (pixel-high, top) with a hover and no full-height band; Gaps
// opens its panel already filled in (Δt ≈ 1 s, 1.5) with both dropouts banded;
// the threshold and a manual Δt change the bands; Auto goes back; the line
// shape radio sets stairs on every trace.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:nan-gaps`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,v,w'];
    let t = 0;
    for (let i = 0; i < 3000; i++) {
        if (i === 1000) t += 10;          // 10 s dropout (≈ 10 missing samples)
        if (i === 2000) t += 1;           // one missing sample
        const v = (i >= 500 && i <= 520) || i === 1500 ? 'NaN' : Math.sin(i / 40).toFixed(5);
        lines.push(`${t.toFixed(4)},${v},${Math.cos(i / 60).toFixed(5)}`);
        t += 1 + 0.02 * Math.sin(i * 1.3);
    }
    return { name: 'gaps.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

async function state(page, panelId) {
    return page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const shapes = plot.div.layout.shapes || [];
        const panelEl = plot.div.closest('.layout-panel');
        const gapsPanel = panelEl.querySelector('.gaps-panel');
        const marksBtn = panelEl.querySelector('.timeseries-marks-btn');
        return {
            marksText: marksBtn?.textContent,
            marksActive: marksBtn?.classList.contains('active'),
            strip: shapes.filter(s => s.ysizemode === 'pixel').map(s => ({ x0: s.x0, x1: s.x1, y0: s.y0, y1: s.y1 })),
            bands: shapes.filter(s => s.ysizemode !== 'pixel' && s.y0 === 0 && s.y1 === 1).map(s => [s.x0, s.x1]),
            vBroken: plot.div.data[0].y.some(y => Number.isNaN(Number(y)) || y === null),
            wBroken: !!plot.div.data[1]?.y?.some(y => Number.isNaN(Number(y)) || y === null),
            lineShapes: plot.div.data.map(d => d.line?.shape),
            panel: gapsPanel ? {
                step: gapsPanel.querySelector('.gaps-panel-step')?.value,
                unit: gapsPanel.querySelector('select.gaps-panel-unit')?.selectedOptions?.[0]?.textContent,
                factor: gapsPanel.querySelector('.gaps-panel-factor')?.value,
                detected: gapsPanel.querySelector('.gaps-panel-detected')?.textContent,
                result: gapsPanel.querySelector('.gaps-panel-result')?.textContent,
                auto: gapsPanel.querySelector('.gaps-panel-auto')?.getAttribute('aria-pressed'),
            } : null,
        };
    }, panelId);
}

async function mark(page, panelId, key) {
    await page.locator(`.layout-panel[data-id="${panelId}"] .timeseries-marks-btn`).click();
    await page.locator(`.timeseries-marks-menu[data-panel-id="${panelId}"] .marks-item-${key}`).click();
    // The menu stays open while toggling — except when Gaps opens its panel,
    // which takes over (and the focus, so an Escape here would close it).
    if (await page.locator('.timeseries-marks-menu').count()) await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
}

async function fill(page, panelId, selector, value) {
    const input = page.locator(`.layout-panel[data-id="${panelId}"] .gaps-panel ${selector}`);
    await input.fill(String(value));
    await input.press('Enter');
    await page.waitForTimeout(600);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.NAN_GAPS_SHOTS;
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'v', panelEl);
        app.plotManager.addTrace(panelEl.dataset.id, 'w', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(500);

    let s = await state(page, panelId);
    assert.equal(s.marksActive, false, 'nothing on: the Marks button is not active');
    assert.equal(s.vBroken, true, 'the line breaks across its NaN with every toggle off');
    assert.equal(s.wBroken, false, 'a clean trace is untouched');
    assert.equal(s.strip.length, 0, 'no strip yet');
    assert.equal(s.bands.length, 0, 'no bands yet');

    // NaN/Inf: the strip.
    await mark(page, panelId, 'nan');
    s = await state(page, panelId);
    assert.match(s.marksText, /\(1\)/, `the button counts one mark (${s.marksText})`);
    assert.ok(s.strip.length >= 2, `the block and the single NaN are on the strip (${s.strip.length})`);
    assert.ok(s.strip.every(r => r.y1 <= 0 && r.y0 < r.y1), 'the strip hangs from the top, in pixels');
    assert.equal(s.bands.length, 0, 'NaN/Inf draws no full-height band');
    const box = await page.evaluate((id) => {
        const div = window.app.plotManager.plots.get(id).div;
        const layout = div._fullLayout;
        const xa = layout.xaxis;
        const r = div.getBoundingClientRect();
        return { x: r.left + xa._offset + xa.l2p(510), y: r.top + layout._size.t + 2 };
    }, panelId);
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(200);
    const hover = await page.evaluate(() => {
        const label = document.querySelector('.nan-strip-hover-label');
        return label && label.style.display !== 'none' ? label.textContent : '';
    });
    assert.match(hover, /NaN\/Inf/, `hovering the strip explains it (${hover})`);
    await page.mouse.move(box.x, box.y + 300);
    if (shots) await page.screenshot({ path: `${shots}/nan-strip.png` });

    // Gaps: the panel opens by itself, filled in.
    await mark(page, panelId, 'gaps');
    s = await state(page, panelId);
    assert.ok(s.panel, 'the Gaps panel opens the first time');
    assert.ok(Math.abs(Number(s.panel.step) - 1) < 0.01, `Δt is detected (${s.panel.step})`);
    assert.equal(s.panel.unit, 's', 'in seconds');
    assert.equal(s.panel.factor, '1.5', 'threshold 1.5 by default');
    assert.equal(s.panel.auto, 'true', 'automatic');
    assert.match(s.panel.detected, /1 s/, `the detected step is shown (${s.panel.detected})`);
    assert.match(s.panel.result, /^2 /, `both dropouts are counted (${s.panel.result})`);
    assert.equal(s.bands.length, 2, 'and banded');
    if (shots) await page.screenshot({ path: `${shots}/gaps-panel.png` });

    // Threshold 5: the one-sample dropout is no longer a gap.
    await fill(page, panelId, '.gaps-panel-factor', 5);
    s = await state(page, panelId);
    assert.match(s.panel.result, /^1 /, `threshold 5 keeps only the long dropout (${s.panel.result})`);
    assert.equal(s.bands.length, 1);

    // A manual Δt of 4 s with threshold 5: nothing is longer than 20 s.
    await fill(page, panelId, '.gaps-panel-step', 4);
    s = await state(page, panelId);
    assert.equal(s.panel.auto, 'false', 'editing Δt switches to manual');
    assert.match(s.panel.result, /^0 /, `no step above 20 s (${s.panel.result})`);
    assert.equal(s.bands.length, 0);
    await page.locator(`.layout-panel[data-id="${panelId}"] .gaps-panel .gaps-panel-auto`).click();
    await page.waitForTimeout(600);
    s = await state(page, panelId);
    assert.equal(s.panel.auto, 'true', 'Auto goes back to the detected step');
    assert.ok(Math.abs(Number(s.panel.step) - 1) < 0.01);
    await fill(page, panelId, '.gaps-panel-factor', 1.5);

    // Closing the panel keeps the tool on; turning Gaps off removes the bands.
    await page.locator(`.layout-panel[data-id="${panelId}"] .gaps-panel .gaps-panel-close`).click();
    s = await state(page, panelId);
    assert.equal(s.panel, null, 'the panel closes');
    assert.equal(s.bands.length, 2, 'the bands stay');
    await mark(page, panelId, 'gaps');
    s = await state(page, panelId);
    assert.equal(s.bands.length, 0, 'Gaps off: no bands');
    assert.equal(s.panel, null, 'and the panel does not reopen by itself');
    await mark(page, panelId, 'gaps');
    s = await state(page, panelId);
    assert.equal(s.panel, null, 'the second time the panel stays closed');
    assert.equal(s.bands.length, 2);

    // Line shape: Stairs for every trace, then Auto.
    await page.locator(`.layout-panel[data-id="${panelId}"] .timeseries-marks-btn`).click();
    await page.locator(`.timeseries-marks-menu[data-panel-id="${panelId}"] .marks-line-hv`).click();
    await page.waitForTimeout(700);
    s = await state(page, panelId);
    assert.deepEqual(s.lineShapes, ['hv', 'hv'], 'Stairs applies to every trace');
    const checked = await page.evaluate((id) => document
        .querySelector(`.timeseries-marks-menu[data-panel-id="${id}"] .marks-menu-radio[aria-checked="true"]`)?.className, panelId);
    assert.match(checked || '', /marks-line-hv/, 'and the menu, still open, shows it');
    if (shots) await page.screenshot({ path: `${shots}/marks-menu.png` });
    await page.locator(`.timeseries-marks-menu[data-panel-id="${panelId}"] .marks-line-auto`).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    s = await state(page, panelId);
    assert.deepEqual(s.lineShapes, ['linear', 'linear'], 'Auto: numeric signals are linear');
    assert.equal(await page.locator('.timeseries-marks-menu').count(), 0, 'Escape closes the menu');

    // The same file in memory-saving mode (DuckDB view): the strip comes from
    // the bucket query, the step from a step histogram, the result line from a
    // gap summary query — and the bands match the in-memory ones.
    const lazyPage = await context.newPage();
    lazyPage.on('pageerror', e => errors.push(e.message));
    await lazyPage.goto(baseUrl);
    await lazyPage.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await lazyPage.evaluate(() => { window.app.advancedSettings = { ...(window.app.advancedSettings || {}), csvFullLoadMb: 0.01 }; });
    await lazyPage.setInputFiles('#file-input', [makeCsv()]);
    await lazyPage.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const lazyPanel = await lazyPage.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'v', panelEl);
        return panelEl.dataset.id;
    });
    await lazyPage.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, lazyPanel);
    await lazyPage.waitForTimeout(800);
    const viewMode = await lazyPage.evaluate(() => [...window.app.plotManager.files.values()][0].data?._duckdb?.viewMode);
    assert.equal(viewMode, true, 'the file is loaded in memory-saving mode');
    await mark(lazyPage, lazyPanel, 'nan');
    await lazyPage.waitForFunction(id => (window.app.plotManager.plots.get(id)._lazyNanRegions || []).length > 0, lazyPanel, { timeout: 30000 });
    await mark(lazyPage, lazyPanel, 'gaps');
    await lazyPage.waitForFunction(id => {
        const panel = document.querySelector(`.layout-panel[data-id="${id}"] .gaps-panel`);
        return panel && /^\d/.test(panel.querySelector('.gaps-panel-result')?.textContent || '');
    }, lazyPanel, { timeout: 30000 });
    await lazyPage.waitForTimeout(800);
    s = await state(lazyPage, lazyPanel);
    assert.ok(s.strip.length >= 2, `lazy: the NaN block and the single NaN are on the strip (${s.strip.length})`);
    assert.ok(Math.abs(Number(s.panel.step) - 1) < 0.01, `lazy: Δt from the step histogram (${s.panel.step})`);
    assert.match(s.panel.result, /^2 /, `lazy: the summary query counts both dropouts (${s.panel.result})`);
    assert.equal(s.bands.length, 2, 'lazy: both dropouts banded');
    if (shots) await lazyPage.screenshot({ path: `${shots}/gaps-lazy.png` });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('NaN/Inf and Gaps end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
