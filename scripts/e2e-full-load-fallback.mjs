// A CSV or Parquet that does not fit whole opens in memory-saving mode, in a
// real browser with the DuckDB-WASM the app ships.
//
// 1. Default settings: a 300 MB limit, and a small CSV loads whole.
// 2. Limit 0: the same CSV still loads whole (0 means no limit).
// 3. Limit 0, with the engine's memory capped below what the whole file needs:
//    the whole load runs out of memory, the app retries in memory-saving mode,
//    the file opens, and the notice says it did not fit rather than that it was
//    over the limit. No page error.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:full-load-fallback`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

import translations from '../src/i18n/translations.js';

// Twenty one-digit columns: two bytes of text per value, eight as a number,
// so the whole table needs about four times the file while memory-saving mode
// only needs the engine's read buffers. That gap is what lets one memory cap
// stop the whole load and let the other through.
function makeCsv(rows, columns = 20) {
    const names = Array.from({ length: columns }, (_, c) => `c${c}`);
    const lines = [['time', 'a', ...names].join(',')];
    for (let i = 0; i < rows; i++) {
        const digits = Array.from({ length: columns }, (_, c) => (i + c) % 10);
        lines.push(`${i},${i % 7},${digits.join(',')}`);
    }
    return Buffer.from(lines.join('\n') + '\n');
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

async function openApp(settings = null) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    if (settings) await page.evaluate(s => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, ...s }), settings);
    return { context, page, errors };
}

async function load(page, name, buffer) {
    await page.setInputFiles('#file-input', [{ name, mimeType: 'text/csv', buffer }]);
    await page.waitForFunction(() => window.app.plotManager.files.size > 0 || !!document.querySelector('.modal-overlay .modal-message'),
        null, { timeout: 180000 });
    return page.evaluate(() => {
        const data = [...window.app.plotManager.files.values()][0]?.data;
        return {
            loaded: !!data,
            dialog: document.querySelector('.modal-overlay')?.innerText || '',
            lazy: !!data?._duckdb,
            reason: data?.metadata?.lazyReason || '',
            rows: data?.variables?.a?.data?.length || 0,
            notice: document.querySelector('.dismissible-notice-body')?.textContent || '',
        };
    });
}

const small = makeCsv(20000);
// Under the 50 MB Playwright can hand to a file input: ~48 MB of text,
// 22 M values, ~180 MB as a table.
const big = makeCsv(1000000);

try {
    {
        const { context, page, errors } = await openApp();
        const limit = await page.evaluate(() => window.app._csvFullLoadLimitBytes());
        assert.equal(limit, 300 * 1024 * 1024, 'the default CSV limit is 300 MB');
        const r = await load(page, 'small.csv', small);
        assert.ok(r.loaded && !r.lazy && r.rows === 20000, `a small CSV loads whole by default (${JSON.stringify(r)})`);
        assert.deepEqual(errors, []);
        await context.close();
    }
    {
        const { context, page, errors } = await openApp({ csvFullLoadMb: 0 });
        assert.equal(await page.evaluate(() => window.app.advancedSettings.csvFullLoadMb), 0, '0 survives the Settings normalizer');
        const r = await load(page, 'small.csv', small);
        assert.ok(r.loaded && !r.lazy && r.rows === 20000, `limit 0 loads whole (${JSON.stringify(r)})`);
        assert.deepEqual(errors, []);
        await context.close();
    }
    {
        const { context, page, errors } = await openApp({ csvFullLoadMb: 0 });
        // Cap the engine below what the whole file needs (~180 MB as a
        // table) and above what memory-saving mode needs (two 32 MB read
        // buffers and a 10 000-row overview).
        await page.evaluate(async () => {
            const source = await window.app._getDuckDbSource();
            await source.query("PRAGMA memory_limit='128MB'");
        });
        const r = await load(page, 'big.csv', big);
        assert.equal(r.dialog, '', `no error dialog (got: ${r.dialog.slice(0, 200)})`);
        assert.ok(r.loaded && r.lazy, `the file opens in memory-saving mode (${JSON.stringify({ ...r, notice: undefined })})`);
        assert.equal(r.reason, 'memory', 'because it did not fit');
        await page.waitForFunction(() => !!document.querySelector('.dismissible-notice-body'), null, { timeout: 10000 });
        const notice = await page.evaluate(() => document.querySelector('.dismissible-notice-body')?.textContent || '');
        const expected = translations.en.lazyFileNoticeBodyMemory.replace('{file}', 'big.csv').split('.')[0];
        assert.ok(notice.startsWith(expected), `the notice says it did not fit (got: ${notice})`);
        assert.deepEqual(errors, [], 'no page error');
        await context.close();
    }
    console.log('e2e full-load fallback: 300 MB default, 0 loads whole, and a file that does not fit opens in memory-saving mode');
} finally {
    await browser.close();
    await server.close();
}
