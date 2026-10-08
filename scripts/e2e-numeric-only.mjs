// The sidebar's 🔢 button: only numeric variables in the tree, text columns
// left out. Off by default, and it composes with the name filter. Also checked
// here: a press that slides across the tree does not select text — the app is
// driven by drags, and only fields can be selected.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

const lines = ['time,power,voltage,status,operator'];
for (let r = 0; r < 20; r++) lines.push([r, 100 + r, 230 - r / 10, r % 2 ? 'on' : 'off', `crew ${r % 3}`].join(','));

try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager);
    await page.setInputFiles('#file-input', [{ name: 'mixed.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const leaves = () => page.locator('#variables-tree .tree-item[data-var-name]').evaluateAll(items => items.map(i => i.dataset.varName).sort());
    const button = page.locator('#toggle-numeric-only');

    assert.deepEqual(await leaves(), ['operator', 'power', 'status', 'time', 'voltage'], 'off by default: text columns are listed');
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.match(await button.getAttribute('title'), /numeric/i, 'the button says what it does');

    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.ok(await button.evaluate(b => b.classList.contains('active')));
    assert.deepEqual(await leaves(), ['power', 'time', 'voltage'], 'on: only numeric variables');

    // "ta" names status (text) and voltage; the time axis may match through
    // its description, which is not what is checked here.
    await page.locator('#variable-filter').fill('ta');
    assert.deepEqual((await leaves()).filter(n => n !== 'time'), ['voltage'], 'and it composes with the name filter');
    await page.locator('#variable-filter').fill('');

    await button.click();
    assert.deepEqual(await leaves(), ['operator', 'power', 'status', 'time', 'voltage'], 'off again: everything is back');

    // A press that slides across the tree selects no text.
    const first = await page.locator('#variables-tree .tree-label', { hasText: 'operator' }).boundingBox();
    const last = await page.locator('#variables-tree .tree-label', { hasText: 'voltage' }).boundingBox();
    await page.mouse.move(first.x + 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => String(window.getSelection())), '', 'no text selected in the sidebar');
    // Fields stay selectable.
    await page.locator('#variable-filter').fill('voltage');
    await page.locator('#variable-filter').selectText();
    assert.equal(await page.locator('#variable-filter').evaluate(i => i.value.slice(i.selectionStart, i.selectionEnd)), 'voltage',
        'text in a field can still be selected');

    assert.deepEqual(errors, []);
    console.log('numeric-only e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
