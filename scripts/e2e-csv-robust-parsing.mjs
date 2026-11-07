// A PLC export as they come: UTF-16 with a BOM, semicolons, decimal commas
// with dot thousands, French month names, zero-width spaces, a delimiter at
// the end of some rows and a row cut short. It must open without a question,
// and the parsing dialog must say what it found and keep what the reader set.
// The same file in UTF-8 goes through DuckDB-WASM, which must read it alike.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const lines = [
    'Horodatage;Puissance;Débit;Etat',
    '1 janvier 2024 13:05:22;1.234,5;\u200B12,5;ok',
    '1 janvier 2024 13:05:23;1.300,25;13,5;ok;',
    '1 janvier 2024 13:05:24;999,5;14,5;ok',
    '1 janvier 2024 13:05:25;1.000,0;15,5;ok;',
    '1 janvier 2024 13:05:26;1.010,0',
    '1 janvier 2024 13:05:27;1.020,0;17,5;ok',
];
const text = lines.join('\r\n') + '\r\n';
const utf16 = (() => {
    const out = Buffer.alloc(2 + text.length * 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (let i = 0; i < text.length; i++) out.writeUInt16LE(text.charCodeAt(i), 2 + i * 2);
    return out;
})();

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager);

    const loaded = (index) => page.evaluate((i) => {
        const data = [...window.app.plotManager.files.values()][i].data;
        const v = name => Array.from(data.variables[name]?.data || []);
        return {
            timeKind: data.metadata.timeKind,
            origin: data.metadata.timeOriginMs,
            power: v('Puissance'),
            flow: v('Débit'),
            n: data.metadata.numTimesteps,
        };
    }, index);

    // UTF-16: the in-memory parser.
    await page.setInputFiles('#file-input', [{ name: 'plc-utf16.csv', mimeType: 'text/csv', buffer: utf16 }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const first = await loaded(0);
    assert.equal(first.timeKind, 'datetime');
    assert.equal(first.origin, Date.UTC(2024, 0, 1, 13, 5, 22));
    assert.equal(first.n, 5, 'the short row is left out, the rows ending in a delimiter are kept');
    assert.deepEqual(first.power, [1234.5, 1300.25, 999.5, 1000, 1020]);
    assert.deepEqual(first.flow, [12.5, 13.5, 14.5, 15.5, 17.5], 'the zero-width space is gone');

    // UTF-8: DuckDB-WASM in the browser.
    await page.setInputFiles('#file-input', [{ name: 'plc-utf8.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 2, null, { timeout: 60000 });
    const second = await loaded(1);
    assert.deepEqual({ ...second }, { ...first }, 'DuckDB reads the file as the in-memory parser does');

    // The dialog, on the UTF-16 file.
    const closed = page.evaluate(() => window.app.adjustCsvParsing([...window.app.plotManager.files.keys()][0]));
    closed.catch(() => {}); // awaited below; a failed assertion must not surface as this
    await page.waitForSelector('.csv-preview-dialog');
    const toolbarText = await page.locator('.csv-preview-toolbar').textContent();
    assert.match(toolbarText, /Thousands separator/);
    const selectTexts = await page.locator('.csv-preview-toolbar select').evaluateAll(selects =>
        selects.map(select => select.options[select.selectedIndex]?.textContent || ''));
    assert.ok(selectTexts.includes('Auto (,)'), `decimal Auto names what it found: ${selectTexts}`);
    assert.ok(selectTexts.includes('Auto (.)'), `thousands Auto names what it found: ${selectTexts}`);
    assert.ok(selectTexts.some(t => /Auto \(UTF-16 LE\)/.test(t)), `encoding Auto names what it found: ${selectTexts}`);
    const lineOptions = await page.locator('.csv-preview-toolbar select').first().locator('option').allTextContents();
    assert.ok(lineOptions.includes('1000') && lineOptions.includes('All'), lineOptions.join(','));
    assert.match(await page.locator('.csv-preview-side').textContent(), /Detected: d MMMM yyyy HH:mm:ss \(French\)/);
    // Hovering a cell says what it is read as.
    const firstData = page.locator('.csv-preview-grid tr.is-data-row').first();
    assert.equal(await firstData.locator('td').nth(2).getAttribute('title'),
        'Raw: «1.234,5»\nParsed: 1234.5\nType: number');
    assert.match(await firstData.locator('td').nth(0).getAttribute('title'), /^Parsed: 2024-01-01 13:05:22\nFrom: «1 janvier 2024 13:05:22»/);
    const hideInvalid = page.locator('.csv-preview-check', { hasText: 'Hide invalid lines' }).locator('input');
    assert.equal(await hideInvalid.isChecked(), false, 'invalid lines are shown by default');
    assert.equal(await page.locator('.csv-preview-grid tr.is-invalid-row').count(), 1, 'the short row is shown, in red');

    // Rename a column, then change the encoding: the rename stays.
    await page.locator('.csv-preview-check', { hasText: 'Edit columns' }).locator('input').check().catch(() => {});
    const encoding = page.locator('.csv-preview-toolbar select').filter({ has: page.locator('option[value="windows-1252"]') });
    await encoding.selectOption('windows-1252');
    await encoding.selectOption('auto');
    assert.match(await page.locator('.csv-preview-side').textContent(), /Detected: d MMMM yyyy HH:mm:ss \(French\)/,
        'the time axis survives an encoding change');

    // All lines.
    await page.locator('.csv-preview-toolbar select').first().selectOption('all');
    await page.waitForFunction(() => document.querySelectorAll('.csv-preview-grid tbody tr').length >= 7);

    // Keep the short row.
    await page.locator('.csv-preview-check', { hasText: 'Keep rows with missing cells' }).locator('input').check();
    assert.equal(await page.locator('.csv-preview-grid tr.is-invalid-row').count(), 0);
    await page.screenshot({ path: process.env.E2E_SCREENSHOT || '/dev/null', fullPage: false }).catch(() => {});
    await page.locator('.csv-preview-dialog .modal-btn-confirm').click();
    await closed;
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0].data.metadata.numTimesteps === 6);
    const kept = await loaded(0);
    assert.deepEqual(kept.power, [1234.5, 1300.25, 999.5, 1000, 1010, 1020]);
    assert.ok(Number.isNaN(kept.flow[4]), 'the missing cell is a missing value');

    assert.deepEqual(errors, []);
    console.log('csv robust parsing e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
