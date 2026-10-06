// The formula editor, full size: a derived variable built with the mouse.
//
// The case it was made for: a sum of ten signals with long names. Typed in the
// side panel's one-line box, that is ten names from memory and nine pluses.
// Here: filter, "Select all shown", sum(…), Create. Checked end to end on the
// desktop layout, values included, along with the other ways in — a click per
// variable (joined with +), a function wrapping a selection, Escape and the
// minimise button going back to the side panel with the formula intact.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

const NAMES = Array.from({ length: 10 }, (_, i) => `Feeder ${i + 1} active power substation north`);
const lines = [['time', ...NAMES, 'ambient temperature'].join(',')];
for (let r = 0; r < 50; r++) {
    lines.push([r, ...NAMES.map((_, i) => (i + 1) * 10 + r), 20 + r / 10].join(','));
}

try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager);
    await page.setInputFiles('#file-input', [{ name: 'feeders.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const editor = '.formula-editor-overlay';
    const formula = () => page.locator('.formula-editor-formula').inputValue();
    const side = () => page.locator('#derived-formula').inputValue();

    await page.locator('#derived-toggle').click();
    assert.equal(await page.locator('#derived-expand').isVisible(), true, 'the side panel offers the full editor');
    await page.locator('#derived-name').fill('total');
    await page.locator('#derived-expand').click();
    await page.waitForSelector(`${editor}.show`);
    assert.equal(await page.locator('.formula-editor-name').inputValue(), 'total', 'it opens on what the side panel holds');
    assert.equal(await page.locator('.formula-editor-pill').count(), 12, 'every variable is a pill, the time axis included');

    // ── Click inserts: one click, one name; a second, joined with + ──
    await page.locator('.formula-editor-pill', { hasText: NAMES[0] }).click();
    await page.locator('.formula-editor-pill', { hasText: NAMES[1] }).click();
    assert.equal(await formula(), `\`${NAMES[0]}\` + \`${NAMES[1]}\``, 'clicked in a row, two pills write a sum');
    assert.equal(await side(), await formula(), 'the side panel follows every change');
    await page.locator('.formula-editor-pill', { hasText: NAMES[0] }).click();
    assert.match(await formula(), new RegExp(`\\+ \`${NAMES[0].replace(/[()]/g, '\\$&')}\`$`), 'clicked again, a pill is used again');
    await page.waitForFunction(() => document.querySelector('.formula-editor-status').classList.contains('ok'));
    assert.equal(await page.locator('.formula-editor-pill.is-used').count(), 2, 'the pills in the formula are marked');

    // A function wraps the selection in the formula.
    await page.locator('.formula-editor-formula').fill('ambient temperature');
    await page.locator('.formula-editor-formula').fill('');
    await page.locator('.formula-editor-pill', { hasText: 'ambient temperature' }).click();
    await page.locator('.formula-editor-formula').evaluate(el => el.setSelectionRange(0, el.value.length));
    await page.locator('.formula-editor-fn', { hasText: 'sqrt(' }).click();
    assert.equal(await formula(), 'sqrt(`ambient temperature`)', 'a function wraps what is selected');

    // A function can be dragged into the formula too.
    await page.locator('.formula-editor-formula').fill('');
    await page.locator('.formula-editor-fn', { hasText: 'mean(' }).dragTo(page.locator('.formula-editor-formula'));
    assert.equal(await formula(), 'mean()', 'a function dragged into the formula is written there');
    assert.equal(await side(), 'mean()', 'and reaches the side panel');
    await page.locator('.formula-editor-formula').fill('sqrt(`ambient temperature`)');

    // ── Minimise: back to the side panel, the formula intact ──
    await page.locator('.formula-editor-minimize').click();
    await page.waitForFunction(() => !document.querySelector('.formula-editor-overlay'));
    assert.equal(await side(), 'sqrt(`ambient temperature`)', 'minimising keeps the formula');
    assert.equal(await page.locator('#derived-name').inputValue(), 'total');

    // ── Click selects: the sum of ten, without typing a name ──
    await page.locator('#derived-expand').click();
    await page.waitForSelector(`${editor}.show`);
    await page.locator('.formula-editor-formula').fill('');
    await page.locator('.formula-editor-mode[data-mode="select"]').click();
    assert.equal(await page.locator('.formula-editor-selection-bar').isVisible(), true);
    await page.locator('.formula-editor-filter').fill('feeder');
    assert.equal(await page.locator('.formula-editor-pill:visible').count(), 10, 'the filter narrows the pills');
    await page.locator('.formula-editor-link-btn', { hasText: 'Select all shown' }).click();
    assert.equal(await page.locator('.formula-editor-pill.is-selected').count(), 10);
    // A second click deselects; a third selects it again, now last.
    await page.locator('.formula-editor-pill', { hasText: NAMES[0] }).click();
    assert.equal(await page.locator('.formula-editor-pill.is-selected').count(), 9, 'a second click deselects');
    await page.locator('.formula-editor-pill', { hasText: NAMES[0] }).click();
    assert.equal(await page.locator('.formula-editor-pill', { hasText: NAMES[0] }).locator('.formula-editor-pill-order').innerText(), '10',
        'the selection keeps its order');
    await page.locator('.formula-editor-list-btn[data-fn="sum"]').click();
    const written = await formula();
    assert.ok(written.startsWith('sum(') && written.endsWith(`\`${NAMES[0]}\`)`), `sum over the selection, in order (${written})`);
    assert.equal(await page.locator('.formula-editor-pill.is-selected').count(), 0, 'the selection is used up');
    await page.waitForFunction(() => document.querySelector('.formula-editor-status').classList.contains('ok'));

    // Ctrl+Enter creates, and the editor goes with the side panel's form.
    await page.locator('.formula-editor-formula').press('Control+Enter');
    await page.waitForFunction(() => !document.querySelector('.formula-editor-overlay'));
    const values = await page.evaluate(() => Array.from(window.app.plotManager.files.get(window.app.activeFileId).data.variables.total.data.slice(0, 3)));
    // Feeder i holds (i + 1) * 10 + row: the ten add up to 550 + 10 * row.
    assert.deepEqual(values, [550, 560, 570], 'the variable is the sum of the ten');

    // ── Escape goes back; an error is said in the editor ──
    await page.locator('#derived-toggle').click();
    await page.locator('#derived-name').fill('broken');
    await page.locator('#derived-expand').click();
    await page.waitForSelector(`${editor}.show`);
    await page.locator('.formula-editor-formula').fill('nosuchvariable + 1');
    await page.waitForFunction(() => document.querySelector('.formula-editor-status').classList.contains('error'));
    await page.locator('.formula-editor-create').click();
    assert.equal(await page.locator(editor).count(), 1, 'a formula that fails keeps the editor open');
    assert.match(await page.locator('.formula-editor-message').innerText(), /nosuchvariable/i, 'and says why there');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.formula-editor-overlay'));
    assert.equal(await side(), 'nosuchvariable + 1', 'Escape goes back with the formula as it was');

    assert.deepEqual(errors, []);
    console.log('formula editor e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
