#!/usr/bin/env node
// The results of the data tools on a lazy file past the engine's memory: the
// database in OPFS against the database in memory, in the app's own bundle.
//
//   node bench/disk-results.mjs [--rows 20000000] [--sinks 8] [--limit 512MB]
//
// Runs Chromium (Playwright) against the Vite dev server. A CSV `t,a` of
// `rows` rows on disk is opened lazily, with the app's own budget for
// results switched off (lazyResultsMb 0) so that the engine alone decides,
// and moving averages of every row are created one after another — each a
// sink as long as the file — until `sinks` of them or a failure. Per
// configuration, a tab of its own:
//
//   · disk: the database in OPFS with the app's memory_limit (1.5 GiB);
//   · disk:<limit>: the same with memory_limit <limit>;
//   · memory:<limit>: the database in memory with memory_limit <limit>.
//
// Then, with every sink: a zoom of 1000 rows reading all of them, and the
// overview's refresh. For the disk configurations, the page reloaded, the same
// file opened again and the first moving average created again: adopted from
// the disk (the results kept between sessions). Each step prints as it ends.
//
// Numbers are for one DuckDB thread and this machine.

import { createWriteStream } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ROWS = Number(arg('rows', 20000000));
const SINKS = Number(arg('sinks', 8));
const LIMIT = arg('limit', '512MB');
const CONFIGS = arg('configs', `disk,disk:${LIMIT},memory:${LIMIT}`).split(',').map(text => {
    const [storage, limit = ''] = text.split(':');
    return { storage, limit };
});

const dir = await mkdtemp(path.join(tmpdir(), 'omv-disk-bench-'));
const csvPath = path.join(dir, 'disk-bench.csv');
{
    const out = createWriteStream(csvPath);
    out.write('t,a\n');
    let block = '';
    for (let i = 0; i < ROWS; i++) {
        block += `${(i * 0.001).toFixed(3)},${(Math.sin(i / 500) + (i % 13) / 100).toFixed(5)}\n`;
        if (block.length > 1 << 20) {
            if (!out.write(block)) await new Promise(resolve => out.once('drain', resolve));
            block = '';
        }
    }
    out.write(block);
    await new Promise(resolve => out.end(resolve));
}
console.log(`CSV: ${ROWS} rows, ${Math.round((await stat(csvPath)).size / 1e6)} MB; up to ${SINKS} moving averages`);

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const show = (label, value) => console.log(`  ${label}`, typeof value === 'string' ? value : JSON.stringify(value));

async function openApp(page, settings) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    await page.evaluate(s => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 1, lazyResultsMb: 0, ...s }), settings);
}
async function openFile(page, limit) {
    const t0 = Date.now();
    await page.setInputFiles('#file-input', csvPath);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 600000 });
    return page.evaluate(async ({ limit, ms }) => {
        const fileId = [...window.app.plotManager.files.keys()][0];
        window.app.setActiveFile(fileId);
        const source = window.app.plotManager.files.get(fileId).data._duckdb.source;
        if (limit) await source._conn.query(`SET memory_limit='${limit}'`);
        const setting = (await source._conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0].toJSON().v;
        return { fileId, storage: source.storage.kind, slot: source.storage.slot, memory_limit: setting, openMs: ms };
    }, { limit, ms: Date.now() - t0 });
}
const measure = page => page.evaluate(async () => {
    const source = window.app._duckdbSource;
    const memory = Number((await source._conn.query('SELECT SUM(memory_usage_bytes)::DOUBLE AS b FROM duckdb_memory()')).toArray()[0].toJSON().b);
    let file = null;
    try {
        const root = await navigator.storage.getDirectory();
        const name = source.storage.path?.replace(/^opfs:\/\//, '');
        if (name) file = (await (await root.getFileHandle(name)).getFile()).size;
    } catch (_) { /* in memory */ }
    return { engineMB: Math.round(memory / 1e6), fileMB: file == null ? null : Math.round(file / 1e6) };
});
const createAverage = (page, fileId, k) => page.evaluate(async ({ fileId, k }) => {
    const app = window.app;
    const data = app.plotManager.files.get(fileId).data;
    const name = `m${k}`;
    const runs = [];
    const run = app._runLazySinkJob;
    app._runLazySinkJob = async function(...args) { const out = await run.apply(this, args); runs.push(!!out?.reused); return out; };
    const t0 = performance.now();
    try {
        const ctx = { fileId, data, sourceName: 'a', sourceVariable: data.variables.a, outputName: name, targetMode: 'create', tool: 'movingAverage', lazy: true };
        const result = await app._applyLazyDataToolCreateMode(ctx, { tool: 'movingAverage', params: { window: 11 + 2 * k } }, { silent: true });
        return { ok: !!result, ms: Math.round(performance.now() - t0), reused: runs[0] ?? null };
    } catch (err) {
        return { ok: false, ms: Math.round(performance.now() - t0), error: String(err?.message || err).split('\n')[0].slice(0, 200) };
    } finally {
        app._runLazySinkJob = run;
    }
}, { fileId, k });

try {
    for (const { storage, limit } of CONFIGS) {
        console.log(`\n--- results ${storage === 'disk' ? 'on disk (OPFS)' : 'in memory'}, memory_limit ${limit || "the app's"}`);
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('pageerror', e => console.log('  PAGEERROR', e.message));
        await openApp(page, { lazyResultsStorage: storage });
        const opened = await openFile(page, limit);
        show('engine', opened);
        let made = 0;
        for (let k = 1; k <= SINKS; k++) {
            const r = await createAverage(page, opened.fileId, k);
            show(`moving average ${k}`, { ...r, ...(await measure(page)) });
            if (!r.ok) break;
            made = k;
        }
        if (made) {
            const reads = await page.evaluate(async ({ fileId, made, rows }) => {
                const data = window.app.plotManager.files.get(fileId).data;
                const source = data._duckdb.source;
                const names = Array.from({ length: made }, (_, i) => `m${i + 1}`);
                const out = {};
                const mid = Math.floor(rows / 2) * 0.001;
                let t0 = performance.now();
                try {
                    const raw = await source.getRawColumnsRange(data, ['a', ...names], mid, mid + 0.9995, 1e6);
                    out.zoom = { ms: Math.round(performance.now() - t0), rows: raw.x.length, columns: names.length + 1 };
                } catch (err) { out.zoom = { error: String(err?.message || err).split('\n')[0].slice(0, 160) }; }
                t0 = performance.now();
                try {
                    await source.refreshOverview(data);
                    out.overview = { ms: Math.round(performance.now() - t0) };
                } catch (err) { out.overview = { error: String(err?.message || err).split('\n')[0].slice(0, 160) }; }
                return out;
            }, { fileId: opened.fileId, made, rows: ROWS });
            show(`with ${made} sinks`, { ...reads, ...(await measure(page)) });
        }
        if (storage === 'disk' && made) {
            await page.reload();
            await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
            const reopened = await openFile(page, limit);
            const r = await createAverage(page, reopened.fileId, 1);
            show('reloaded, the same file, moving average 1 again', { ...r, slot: reopened.slot });
        }
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
