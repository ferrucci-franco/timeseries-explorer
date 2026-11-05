// Derived variables on a phone (src/app/methods/compact-derived-methods.js).
//
// Built end to end with a finger, the way the page is meant to be used: the
// formula written with its own keys (no system keyboard), a variable tapped
// in, a function wrapped round it, the preview checked, Create — and the new
// signal on the plot and in the tree. Then: Σ Combine several, a draft kept
// when the sheet is hidden, an edit (rename and new formula) from the tree's
// ✎, the editor from Analyze, delete, the Back gesture, and the page fitting
// every phone of the matrix upright and sideways with nothing poking out.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:compact-derived`.
// SHOTS_DIR=<dir> also saves screenshots of each step.
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
        // A strip that scrolls sideways on its own (the suggestions) may.
        if (el.closest('.compact-derived-suggestions')) continue;
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
    await page.screenshot({ path: `${shots}/derived-${name}.png` });
};

async function openPhone(viewport, { dark = false } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: shots ? 2 : 1 });
    const page = await context.newPage();
    if (process.env.CPU_THROTTLE) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
    }
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

const formula = page => page.locator('.compact-derived-formula').inputValue();
// The editor open and its sheet settled at full height (it slides there).
const editorReady = async (page) => {
    await page.waitForSelector('.compact-page-derived:not([hidden])');
    await page.waitForTimeout(350);
};
// The formula reads `expected` — said with what it does read, if not.
const formulaIs = async (page, expected, what) => {
    try {
        await page.waitForFunction(text => document.querySelector('.compact-derived-formula')?.value === text, expected, { timeout: 5000 });
    } catch (_) {
        assert.equal(await formula(page), expected, what);
    }
};
const tapKey = (page, key) => page.locator(`.compact-derived-keys [data-key="${key}"]`).tap();
const tapVar = (page, name) => page.locator(`.compact-derived-var[data-name="${name}"]`).tap();

try {
    // ── Upright phone, the whole journey ────────────────────────────────────
    const { context, page, errors } = await openPhone({ width: 390, height: 844 });
    await page.locator('.compact-nav-btn[data-sheet="data"]').tap();
    await page.waitForSelector('.compact-sheet.is-shown');
    const newBtn = page.locator('.compact-page-data .compact-derived-new');
    assert.equal(await newBtn.isVisible(), true, 'Data offers "New variable" beside Open file');
    // The old sidebar form stays out of the phone layout.
    assert.equal(await page.locator('.compact-sheet .derived-section').isVisible(), false, 'the desktop form is not shown');
    await shot(page, '01-data');
    await newBtn.tap();
    await editorReady(page);
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'New variable', 'the page says what it is');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact-sheet-full')), true,
        'and takes the whole height: a formula wants the room');
    assert.equal(await page.locator('.compact-sheet-back').isVisible(), true, 'with Back to Data');
    // The formula field opens on its own keys: a cursor, no system keyboard.
    assert.equal(await page.locator('.compact-derived-formula').getAttribute('inputmode'), 'none', 'the formula field asks for no keyboard');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('compact-derived-formula')), true,
        'and holds the focus, so its cursor shows');
    assert.equal(await page.locator('.compact-derived-submit').isDisabled(), true, 'Create waits for a name and a formula');
    assert.equal(await page.locator('.compact-derived-preview').isVisible(), false, 'nothing to preview yet');
    await shot(page, '02-editor-empty');
    assert.deepEqual(await sidewaysProblems(page), [], 'the empty editor fits the width');

    // ── Written with the keys ──
    await page.locator('.compact-derived-name').fill('power');
    await tapVar(page, 'voltage');
    await tapKey(page, '*');
    await tapVar(page, 'current');
    assert.equal(await formula(page), 'voltage * current', 'variables and an operator, tapped');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('compact-derived-formula')), true,
        'a key never takes the focus from the formula');
    // Tapped right after another, a variable is added with +.
    await tapVar(page, 'temp');
    assert.equal(await formula(page), 'voltage * current + temp', 'after an operand, a tap adds with +');
    // ⌫ takes a whole name back, then the operator with its spaces.
    await page.locator('.compact-derived-keys .is-backspace').tap();
    assert.equal(await formula(page), 'voltage * current + ', 'one ⌫ takes the whole name');
    await page.locator('.compact-derived-keys .is-backspace').tap();
    assert.equal(await formula(page), 'voltage * current', 'the next, the operator and its spaces');
    // A function from its tab, after an operand: it multiplies.
    await page.locator('.compact-derived-tab[data-tab="functions"]').tap();
    assert.equal(await page.locator('.compact-derived-fn[data-fn="sqrt"] .compact-derived-fn-text').innerText(), 'Square root',
        'each function says what it does');
    await page.locator('.compact-derived-fn[data-fn="abs"]').tap();
    assert.equal(await formula(page), 'voltage * current * abs()', 'a function after an operand multiplies, cursor inside');
    await page.locator('.compact-derived-tab[data-tab="variables"]').tap();
    await tapVar(page, 'voltage');
    assert.equal(await formula(page), 'voltage * current * abs(voltage)', 'the next tap lands between its brackets');
    // 123: digits and the cursor.
    await page.locator('.compact-derived-tab[data-tab="numbers"]').tap();
    await page.locator('.compact-derived-numpad [data-key="right"]').tap();
    await tapKey(page, '/');
    for (const key of ['1', '0']) await page.locator(`.compact-derived-numpad [data-key="${key}"]`).tap();
    assert.equal(await formula(page), 'voltage * current * abs(voltage) / 10', '→ leaves the call; digits from the pad');
    await page.waitForSelector('.compact-derived-status.is-ok');
    assert.match(await page.locator('.compact-derived-status').innerText(), /2/, 'valid, reading two variables');
    assert.equal(await page.locator('.compact-derived-preview').isVisible(), true, 'a valid formula is drawn');
    assert.match(await page.locator('.compact-derived-preview-count').innerText(), /2,?000 points/, 'over every sample');
    assert.equal(await page.locator('.compact-derived-submit').isEnabled(), true, 'Create is ready');
    assert.equal(await page.locator('.compact-derived-plot-chip').isVisible(), true, '"Plot 1" is offered beside Create');
    assert.equal(await page.locator('.compact-derived-plot-chip').getAttribute('aria-pressed'), 'true', 'on by default');
    await shot(page, '03-editor-valid');
    assert.deepEqual(await sidewaysProblems(page), [], 'the full editor fits the width');

    // An error is said at once, and Create waits.
    await tapKey(page, '(');
    await page.waitForSelector('.compact-derived-status.is-error');
    assert.equal(await page.locator('.compact-derived-submit').isDisabled(), true, 'an open bracket blocks Create');
    assert.equal(await page.locator('.compact-derived-preview').isVisible(), false, 'and there is nothing to draw');
    await shot(page, '04-editor-error');
    await page.locator('.compact-derived-keys .is-backspace').tap();
    await page.waitForSelector('.compact-derived-status.is-ok');

    // ── Suggestions while typing ──
    await page.locator('.compact-derived-keyboard').tap();
    assert.equal(await page.locator('.compact-derived-formula').getAttribute('inputmode'), 'text', '⌨ hands the field to the keyboard');
    await page.keyboard.type(' + te');
    await page.waitForSelector('.compact-derived-suggestion[data-name="temp"]');
    await shot(page, '05-suggestions');
    await page.locator('.compact-derived-suggestion[data-name="temp"]').tap();
    assert.equal(await formula(page), 'voltage * current * abs(voltage) / 10 + temp', 'a suggestion completes the name');
    await page.locator('.compact-derived-keyboard').tap();
    assert.equal(await page.locator('.compact-derived-formula').getAttribute('inputmode'), 'none', 'and ⌨ takes it back');

    // ── Create: on the plot, in the tree ──
    await page.waitForSelector('.compact-derived-status.is-ok');
    await page.locator('.compact-derived-submit').tap();
    await page.waitForFunction(() => window.app.plotManager.files.values().next().value.data.variables.power?.derived);
    await page.waitForSelector('.compact-page-data:not([hidden])');
    const values = await page.evaluate(() => Array.from(window.app.plotManager.files.values().next().value.data.variables.power.data.slice(0, 3)));
    const expected = await page.evaluate(() => {
        const v = window.app.plotManager.files.values().next().value.data.variables;
        return [0, 1, 2].map(i => v.voltage.data[i] * v.current.data[i] * Math.abs(v.voltage.data[i]) / 10 + v.temp.data[i]);
    });
    values.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `sample ${i} is the formula's value`));
    await page.waitForFunction(() => [...window.app.plotManager.plots.values()][0].traces.some(t => t.varName === 'power'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact-sheet-full')), false,
        'back in Data, the sheet is its old height again');
    assert.match(await page.locator('.compact-toast').innerText(), /power.*plot 1/, 'a toast says it was created, and where');
    assert.equal(await page.locator('#variables-tree .tree-item[data-var-name="power"].compact-on-plot').count(), 1,
        'the tree lists it, marked as on the plot');
    await shot(page, '06-created');

    // ── Σ Combine several ──
    await newBtn.tap();
    await editorReady(page);
    assert.equal(await formula(page), '', 'a new variable starts empty after a create');
    await page.locator('.compact-derived-name').fill('total');
    await page.locator('.compact-derived-combine').tap();
    await page.waitForSelector('.compact-page-derived-combine:not([hidden])');
    assert.equal(await page.locator('.compact-derived-combine-insert').isDisabled(), true, 'Insert waits for a variable');
    await page.locator('.compact-derived-combine-fns [data-fn="mean"]').tap();
    await page.locator('.compact-derived-pick[data-name="temp"]').tap();
    await page.locator('.compact-derived-pick[data-name="voltage"]').tap();
    assert.equal(await page.locator('.compact-derived-pick[data-name="temp"] .compact-derived-pick-box').innerText(), '1', 'the order is numbered');
    assert.equal(await page.locator('.compact-derived-combine-preview').innerText(), 'mean(temp, voltage)', 'and the call is shown before it is written');
    await shot(page, '07-combine');
    assert.deepEqual(await sidewaysProblems(page), [], 'the combine page fits the width');
    await page.locator('.compact-derived-combine-insert').tap();
    await editorReady(page);
    assert.equal(await formula(page), 'mean(temp, voltage)', 'Insert writes it and goes back to the formula');

    // ── A draft survives hiding the sheet ──
    await page.locator('.compact-sheet-close').tap();
    await page.waitForSelector('#compact-sheet', { state: 'hidden' });
    await page.locator('.compact-nav-btn[data-sheet="data"]').tap();
    await page.locator('.compact-page-data .compact-derived-new').tap();
    await editorReady(page);
    assert.equal(await page.locator('.compact-derived-name').inputValue(), 'total', 'the name is still there');
    assert.equal(await formula(page), 'mean(temp, voltage)', 'and the formula');
    // Cancel means it: no draft.
    await page.locator('.compact-derived-cancel').tap();
    await page.waitForSelector('.compact-page-data:not([hidden])');
    await page.locator('.compact-page-data .compact-derived-new').tap();
    assert.equal(await formula(page), '', 'after Cancel, a new variable starts empty');

    // ── Back closes the editor, not the sheet ──
    await page.goBack();
    await page.waitForSelector('.compact-page-data:not([hidden])');
    assert.equal(await page.locator('#compact-sheet').isVisible(), true, 'Back goes from the editor to Data');

    // ── Edit from the tree's ✎: rename and new formula ──
    const edit = page.locator('#variables-tree .tree-item[data-var-name="power"] .tree-derived-edit');
    const box = await edit.boundingBox();
    assert.ok(box.width >= 40 && box.height >= 40, `the ✎ is a finger's size (${box.width}×${box.height})`);
    await edit.tap();
    await editorReady(page);
    assert.equal(await page.locator('.compact-sheet-title').innerText(), 'Edit variable', 'the editor opens on the variable');
    assert.equal(await page.locator('.compact-derived-submit').innerText(), 'Update');
    assert.equal(await page.locator('.compact-derived-var[data-name="power"]').count(), 0, 'it cannot read itself');
    assert.equal(await page.locator('.compact-derived-plot-chip').isVisible(), false, 'an edit has no "add to plot"');
    await page.locator('.compact-derived-name').fill('p2');
    await page.locator('.compact-derived-formula').evaluate((input) => {
        input.value = 'voltage * 2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => /: 1$/.test(document.querySelector('.compact-derived-status.is-ok')?.textContent || ''));
    await shot(page, '08-edit');
    await page.locator('.compact-derived-submit').tap();
    await page.waitForFunction(() => {
        const vars = window.app.plotManager.files.values().next().value.data.variables;
        return vars.p2 && !vars.power;
    });
    assert.equal(await page.evaluate(() => [...window.app.plotManager.plots.values()][0].traces.some(t => t.varName === 'p2')), true,
        'the curve on the plot follows the rename');
    // voltage * 2 lies in [-2, 2], far from the old values: the plot's Y is
    // fitted to the new ones rather than left on an empty window.
    await page.waitForFunction(() => {
        const plot = [...window.app.plotManager.plots.values()][0];
        const range = plot.div?._fullLayout?.yaxis?.range;
        return range && range[0] < -1.5 && range[1] > 1.5 && range[1] < 5;
    }, null, { timeout: 5000 });

    // ── From Analyze ──
    await page.locator('.compact-nav-btn[data-sheet="analyze"]').tap();
    await page.waitForSelector('.compact-derived-analyze-row');
    assert.match(await page.locator('.compact-derived-analyze-row').innerText(), /1 in this file/, 'Analyze counts the formulas');
    await shot(page, '09-analyze');
    await page.locator('.compact-derived-analyze-row').tap();
    await editorReady(page);
    await page.locator('.compact-derived-name').fill('half');
    await formulaIs(page, '', 'from Analyze, a new variable starts empty');
    await tapVar(page, 'voltage');
    await formulaIs(page, 'voltage', 'a variable tapped in, from Analyze');
    await tapKey(page, '/');
    await formulaIs(page, 'voltage / ', 'an operator');
    await page.locator('.compact-derived-tab[data-tab="numbers"]').tap();
    await page.locator('.compact-derived-numpad [data-key="2"]').tap();
    await formulaIs(page, 'voltage / 2', 'a digit from the pad');
    await page.waitForSelector('.compact-derived-status.is-ok', { timeout: 5000 }).catch(async (err) => {
        throw new Error(`${err.message}\nformula: ${JSON.stringify(await formula(page))} status: ${await page.locator('.compact-derived-status').innerText()}`);
    });
    // The Analyze sheet redraws itself when the plot changes; the editor
    // over it must not be thrown away by that.
    await page.evaluate(() => window.app._renderCompactSheetContent());
    assert.equal(await formula(page), 'voltage / 2', 'a refresh of the sheet under it keeps the formula');
    await page.locator('.compact-derived-numpad .is-enter').tap();
    await page.waitForSelector('.compact-page-analyze:not([hidden])');
    assert.equal(await page.evaluate(() => !!window.app.plotManager.files.values().next().value.data.variables.half), true, 'created from Analyze');
    assert.match(await page.locator('.compact-derived-analyze-row').innerText(), /2 in this file/, 'and Analyze, refreshed, says so');

    // ── Delete from the editor ──
    await page.locator('.compact-nav-btn[data-sheet="data"]').tap();
    await page.locator('#variables-tree .tree-item[data-var-name="half"] .tree-derived-edit').tap();
    await page.waitForSelector('.compact-derived-delete');
    await page.locator('.compact-derived-delete').tap();
    await page.locator('.modal-btn-confirm').tap();
    await page.waitForFunction(() => !window.app.plotManager.files.values().next().value.data.variables.half);
    await page.waitForSelector('.compact-page-data:not([hidden])');

    // ── Help ──
    await page.locator('.compact-page-data .compact-derived-new').tap();
    await page.locator('.compact-derived-formula-head .compact-derived-head-btn').first().tap();
    await page.waitForSelector('.compact-page-derived-help:not([hidden])');
    assert.ok((await page.locator('.compact-derived-help .derived-help-row').count()) > 4, 'the formula help, as a page');
    await shot(page, '10-help');
    assert.deepEqual(await sidewaysProblems(page), [], 'the help fits the width');
    await page.locator('.compact-sheet-back').tap();
    await editorReady(page);

    assert.deepEqual(errors, [], 'no page errors');
    await context.close();

    // ── Every phone of the matrix, upright and sideways, light and dark ─────
    for (const [width, height] of [[320, 568], [360, 800], [412, 915], [568, 320], [844, 390]]) {
        const dark = width === 360 || width === 844;
        const phone = await openPhone({ width, height }, { dark });
        const p = phone.page;
        await p.locator('.compact-nav-btn[data-sheet="data"]').tap();
        await p.locator('.compact-page-data .compact-derived-new').tap();
        await editorReady(p);
        await p.locator('.compact-derived-name').fill('ratio');
        await p.locator('.compact-derived-var[data-name="voltage"]').tap();
        await p.locator('.compact-derived-keys [data-key="/"]').tap();
        await p.locator('.compact-derived-var[data-name="temp"]').tap();
        await p.waitForSelector('.compact-derived-status.is-ok');
        assert.deepEqual(await sidewaysProblems(p), [], `${width}×${height}: the editor fits`);
        // The keys are a finger's size, and in one row.
        const keys = await p.locator('.compact-derived-keys .compact-derived-key').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect()).map(r => ({ w: r.width, h: r.height, top: Math.round(r.top) })));
        assert.ok(keys.every(k => k.h >= 44), `${width}×${height}: keys are 44 px tall`);
        assert.equal(new Set(keys.map(k => k.top)).size, 1, `${width}×${height}: the operator keys share one row`);
        // Create is in reach without scrolling.
        const submit = await p.locator('.compact-derived-submit').boundingBox();
        assert.ok(submit && submit.y + submit.height <= height + 1, `${width}×${height}: Create is on screen`);
        await shot(p, `matrix-${width}x${height}`);
        for (const tab of ['functions', 'numbers']) {
            await p.locator(`.compact-derived-tab[data-tab="${tab}"]`).tap();
            assert.deepEqual(await sidewaysProblems(p), [], `${width}×${height}: the ${tab} tab fits`);
            await shot(p, `matrix-${width}x${height}-${tab}`);
        }
        assert.deepEqual(phone.errors, [], `${width}×${height}: no page errors`);
        await phone.context.close();
    }

    // ── Each language fits the narrowest phone ──────────────────────────────
    for (const lang of ['fr', 'es', 'it']) {
        const phone = await openPhone({ width: 320, height: 568 });
        const p = phone.page;
        await p.evaluate(l => window.app.setLanguage(l), lang);
        await p.locator('.compact-nav-btn[data-sheet="data"]').tap();
        await p.waitForSelector('.compact-page-data .compact-derived-new');
        assert.deepEqual(await sidewaysProblems(p), [], `${lang}: Open file and New variable fit 320 px`);
        for (const btn of await p.locator('.compact-data-actions button').all()) {
            const fits = await btn.evaluate(node => node.scrollWidth <= node.clientWidth + 1);
            assert.ok(fits, `${lang}: "${await btn.innerText()}" is not cut`);
        }
        await p.locator('.compact-page-data .compact-derived-new').tap();
        await editorReady(p);
        assert.deepEqual(await sidewaysProblems(p), [], `${lang}: the editor fits 320 px`);
        await p.locator('.compact-derived-combine').tap();
        assert.deepEqual(await sidewaysProblems(p), [], `${lang}: the combine page fits 320 px`);
        await shot(p, `lang-${lang}`);
        assert.deepEqual(phone.errors, [], `${lang}: no page errors`);
        await phone.context.close();
    }

    console.log('compact derived variables e2e passed');
} finally {
    await browser.close();
    await server.close();
}
