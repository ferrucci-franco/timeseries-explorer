// A logger report read the way it is written (dates "dd.MM.yyyy HH:mm", units
// in the second row, devices after a "|"), its folders changed in the parsing
// dialog, and the settings saved to a file and loaded back.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const FIXTURE = 'test-files/excel/units-row-dotted-dates-device-suffix.xlsx';
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const dir = mkdtempSync(join(tmpdir(), 'omv-csv-folders-'));

try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager);
    await page.setInputFiles('#file-input', [{
        name: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: readFileSync(FIXTURE),
    }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const folders = () => page.locator('#variables-tree .tree-node > .tree-item:not([data-var-name]) .tree-label').allTextContents();
    const loaded = () => page.evaluate(() => {
        const data = [...window.app.plotManager.files.values()][0].data;
        return {
            timeKind: data.metadata.timeKind,
            origin: data.metadata.timeOriginMs,
            grouping: data.metadata.csvGrouping?.mode,
            unit: data.variables['Courant AC L1 | Primo 5.0-1 (1)']?.description,
        };
    });
    const adjust = () => page.evaluate(() => window.app.adjustCsvParsing(window.app.activeFileId));

    assert.deepEqual(await loaded(), { timeKind: 'datetime', origin: Date.UTC(2026, 9, 8), grouping: 'separator', unit: '[A]' },
        'dates, units row and folders are found without asking');
    assert.deepEqual((await folders()).sort(), ['Primo 5.0-1 (1)', 'Primo 6.0-1 (1)', 'Sensor Card / Box (1)']);

    // Save the detected settings, then flatten the tree.
    let closed = adjust();
    await page.waitForSelector('.csv-preview-dialog');
    assert.match(await page.locator('.csv-preview-folder-summary').textContent(), /3 folder/);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('.csv-preview-footer-left button').nth(1).click(),
    ]);
    assert.equal(download.suggestedFilename(), 'report.parsing.json');
    const settingsPath = join(dir, download.suggestedFilename());
    await download.saveAs(settingsPath);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.format, 'timeseries-explorer-parsing-settings');
    assert.equal(settings.settings.unitsMode, 'row');

    await page.locator('.csv-preview-side select').filter({ has: page.locator('option[value="separator"]') }).selectOption('none');
    assert.match(await page.locator('.csv-preview-folder-summary').textContent(), /No folders/);
    await page.locator('.csv-preview-dialog .modal-btn-confirm').click();
    await closed;
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0].data.metadata.csvGrouping?.mode === 'none');
    assert.deepEqual(await folders(), [], 'Folders: none gives a flat list');

    // Load the saved settings: the folders come back.
    closed = adjust();
    await page.waitForSelector('.csv-preview-dialog');
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('.csv-preview-footer-left button').nth(2).click(),
    ]);
    await chooser.setFiles(settingsPath);
    await page.waitForFunction(() => /report\.parsing\.json/.test(document.querySelector('.csv-preview-status')?.textContent || ''));
    await page.locator('.csv-preview-dialog .modal-btn-confirm').click();
    await closed;
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0].data.metadata.csvGrouping?.mode === 'separator');
    assert.deepEqual((await folders()).sort(), ['Primo 5.0-1 (1)', 'Primo 6.0-1 (1)', 'Sensor Card / Box (1)']);

    assert.deepEqual(errors, []);
    console.log('csv folders e2e: ok');
} finally {
    rmSync(dir, { recursive: true, force: true });
    await browser.close();
    await server.close();
}
