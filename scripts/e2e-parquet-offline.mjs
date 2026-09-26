// Parquet with no internet, in a real browser with the DuckDB-WASM the app
// ships. extensions.duckdb.org is unreachable for the whole run.
//
// 1. With the module the build fetched (public/duckdb-extensions/): a CSV
//    converts to Parquet and that Parquet opens, and the engine asks the app for
//    the module, never the public host. Without that folder (a checkout that
//    never ran `npm run fetch:duckdb-extensions`) this part checks the wiring
//    only: the engine asks the app for exactly the file the build would put
//    there. OMV_REQUIRE_DUCKDB_EXTENSIONS=1 (CI) makes a missing folder fail.
// 2. With no module anywhere: opening a Parquet file shows the translated
//    explanation instead of the engine's "null function or function signature
//    mismatch", conversion fails with the same typed error, and a CSV still
//    opens afterwards.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:parquet-offline`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

import translations from '../src/i18n/translations.js';
import { DUCKDB_EXTENSIONS_DIR, DUCKDB_EXTENSIONS_MANIFEST, PARQUET_EXTENSION_UNAVAILABLE } from '../src/data/duckdb-extensions.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parquetFixture = path.join(projectRoot, 'test-files', 'parquet', 'timeseries-multiindex-2-levels.parquet');
const csvFixture = path.join(projectRoot, 'test-files', 'csv', '01_airline_passengers_monthly.csv');
const manifestPath = path.join(projectRoot, 'public', DUCKDB_EXTENSIONS_DIR, DUCKDB_EXTENSIONS_MANIFEST);
const required = /^(1|true|yes)$/i.test(process.env.OMV_REQUIRE_DUCKDB_EXTENSIONS || '');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
assert.ok(manifest || !required, `${path.relative(projectRoot, manifestPath)} is missing: run npm run fetch:duckdb-extensions`);

const LOCAL_MODULE = /\/duckdb-extensions\/v[^/]+\/wasm_(eh|mvp)\/parquet\.duckdb_extension\.wasm$/;
const REMOTE_HOST = 'extensions.duckdb.org';
const EXPLANATION = translations.en.loadErrorParquetUnavailable.split('\n')[0];
// Seconds and two signals: nothing for the reader to guess about.
const CSV_TEXT = ['time,a,b', ...Array.from({ length: 200 }, (_, i) => `${i * 0.5},${Math.sin(i / 10).toFixed(6)},${i % 7}`)].join('\n') + '\n';

const server = await createServer({ root: projectRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
// Unreachable at the resolver, for the page and for the engine's worker alike.
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${REMOTE_HOST} ~NOTFOUND`] });

async function openApp({ route = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const requests = [];
    context.on('request', request => requests.push(request.url()));
    if (route) await route(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    return { context, page, requests, errors };
}

// Resolves when the file is on the workspace or a dialog explains why not.
async function openFile(page, file) {
    const before = await page.evaluate(() => window.app.plotManager.files.size);
    await page.setInputFiles('#file-input', file);
    await page.waitForFunction(count => window.app.plotManager.files.size > count || !!document.querySelector('.modal-overlay .modal-message'),
        before, { timeout: 120000 });
    return page.evaluate(() => ({
        files: window.app.plotManager.files.size,
        dialog: document.querySelector('.modal-overlay')?.innerText || '',
        variables: Object.keys([...window.app.plotManager.files.values()].at(-1)?.data?.variables || {}).length,
    }));
}

// The in-browser CSV-to-Parquet conversion, without the save dialogs around it.
//
// Bounded from here, not from the page: reaching the engine's COPY with no
// Parquet module froze the page itself (the conversion overlay never went
// away), so a timer inside the page would never fire.
function convert(page) {
    const run = page.evaluate(async text => {
        const source = await window.app._getDuckDbSource();
        try {
            const bytes = await source.convertCsvBufferToParquet(new TextEncoder().encode(text));
            return { magic: new TextDecoder().decode(bytes.slice(0, 4)), bytes: [...bytes] };
        } catch (err) {
            return { code: err?.code || '', message: String(err?.message || err) };
        }
    }, CSV_TEXT);
    let timer = null;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the conversion neither finished nor failed within 90 s')), 90000);
    });
    return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}

const remoteRequests = requests => requests.filter(url => new URL(url).hostname === REMOTE_HOST);

try {
    // ─── 1. The module the app ships ─────────────────────────────────────────
    if (manifest) {
        const { context, page, requests, errors } = await openApp();
        // Written first, then read back: both directions, on a file whose
        // content is known.
        const converted = await convert(page);
        assert.equal(converted.magic, 'PAR1', `a CSV converts to Parquet (got ${JSON.stringify({ ...converted, bytes: undefined })})`);
        const opened = await openFile(page, {
            name: 'converted.parquet',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(converted.bytes),
        });
        assert.equal(opened.dialog, '', `the Parquet file opens with no dialog (got: ${opened.dialog.slice(0, 300)})`);
        assert.ok(opened.files === 1 && opened.variables > 0, 'with its columns');
        assert.ok(requests.some(url => LOCAL_MODULE.test(url)), 'the engine loaded the module from the app');
        assert.deepEqual(remoteRequests(requests), [], `no request to ${REMOTE_HOST}`);
        assert.deepEqual(errors, [], 'no page error');
        await context.close();
        console.log(`e2e parquet offline: Parquet opened and written from the bundled module (DuckDB ${manifest.duckdb})`);
    } else {
        // No bundled module in this checkout. A stand-in manifest makes the app
        // try it, and the request shows where the engine looks.
        const version = await (async () => {
            const { context, page } = await openApp();
            const v = await page.evaluate(async () => {
                const source = await window.app._getDuckDbSource();
                return String((await source.query('SELECT version() AS v')).toArray()[0].v);
            });
            await context.close();
            return v;
        })();
        const { context, page, requests } = await openApp({
            route: async ctx => {
                await ctx.route(/\/duckdb-extensions\/manifest\.json$/, r => r.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify({ duckdb: version, files: { [`${version}/wasm_eh/parquet.duckdb_extension.wasm`]: { bytes: 1, sha256: '' } } }),
                }));
                await ctx.route(LOCAL_MODULE, r => r.fulfill({ status: 404, body: '' }));
            },
        });
        await openFile(page, parquetFixture);
        const local = requests.filter(url => LOCAL_MODULE.test(url));
        assert.deepEqual(local, [`${baseUrl}duckdb-extensions/${version}/wasm_eh/parquet.duckdb_extension.wasm`],
            'the engine asks the app for the file the build step writes');
        await context.close();
        console.log('e2e parquet offline: bundled module not fetched in this checkout; checked where the engine looks for it');
    }

    // ─── 2. No module anywhere ─────────────────────────────────────────────
    {
        const { context, page, requests, errors } = await openApp({
            route: ctx => ctx.route(/\/duckdb-extensions\//, r => r.fulfill({ status: 404, body: '' })),
        });
        const opened = await openFile(page, parquetFixture);
        assert.equal(opened.files, 0, 'the Parquet file is not added');
        assert.ok(opened.dialog.includes(EXPLANATION), `the dialog explains it (got: ${opened.dialog.slice(0, 300)})`);
        assert.doesNotMatch(opened.dialog.split('Technical details')[0], /function signature mismatch|table index/i,
            'the engine words are left to the details pane');
        assert.ok(remoteRequests(requests).length > 0, 'the public download was the last try');

        const converted = await convert(page);
        assert.equal(converted.code, PARQUET_EXTENSION_UNAVAILABLE, `conversion fails with the typed error (got ${JSON.stringify(converted)})`);

        await page.locator('.modal-overlay .modal-btn').first().click();
        await page.waitForFunction(() => !document.querySelector('.modal-overlay .modal-message'), null, { timeout: 10000 });
        const csv = await openFile(page, csvFixture);
        assert.equal(csv.dialog, '', 'a CSV opens afterwards');
        assert.ok(csv.files === 1 && csv.variables > 0, 'with its columns');
        assert.deepEqual(errors, [], 'no page error');
        await context.close();
        console.log('e2e parquet offline: with no module, a translated explanation, and CSV still opens');
    }
} finally {
    await browser.close();
    await server.close();
}
