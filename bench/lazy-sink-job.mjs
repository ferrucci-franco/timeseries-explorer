#!/usr/bin/env node
// The chunked executor of phase 4b-1, measured in the app's own bundle, and
// what a DuckDB memory_limit does to it and to the lazy passes that exist.
//
//   node bench/lazy-sink-job.mjs [--rows 20000000] [--configs memory,memory:2GB,memory:256MB,opfs:256MB]
//
// Runs Chromium (Playwright) against the Vite dev server, opens a generated CSV
// in memory-saving mode through the file input, and on the engine the app
// instantiates measures, per configuration (database in memory or in OPFS,
// with or without a memory_limit):
//
//   · a full scan of the CSV, and the statistics passes of phase 3b — exact
//     quartiles (IQR), the sums of a linear detrend, the sampling-gap
//     threshold of the integral;
//   · a moving average created the way the panel creates it: the job's time,
//     its rows, and the engine's memory before and after (the sink's bytes per
//     row, which the budget estimates);
//   · a zoom and an overview refresh that read the sink, and a zoom on the
//     file alone to read them against;
//   · the digital filter of 4b-2: the step of the time axis, a forward filter,
//     and a zero-phase one over a file with no hole — one stretch as long as
//     the file, done in two passes;
//   · the tools without state of 4b-3: the spike detector (its chunks in the
//     compute worker pool), replaced by NaN and by interpolation, the fill of
//     missing samples and the integral bridging holes, over `ah`: `a` with
//     its crests cut out by hard bounds (SQL over the file), runs of holes of
//     a few dozen rows;
//   · the file tools of 4b-4: a resample (bin mean, 10× down; linear, 2×
//     down) and a collapse of repeated timestamps, each a lazy dataset
//     written to a table; the cross-correlation's refusal past its budget.
//
// The CSV is `t,a` as for 4b-1 and 4b-2, with a spike in `a` every 5003 rows
// and a repeated timestamp every 997 rows (for the collapse). A third column
// would take a 20 M-row file past 500 MB, where the app offers to convert it to
// Parquet first — which needs the network here.
//
// docs/any-size-files.md §10 says what had to be measured before choosing
// where the database lives; the numbers are recorded there. One thread, this
// machine: the point is what works, what fails, and the orders of magnitude.

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ROWS = Number(arg('rows', 20000000));
const CONFIGS = arg('configs', 'memory,memory:2GB,memory:256MB,opfs:256MB').split(',').map(text => {
    const [db, limit = null] = text.split(':');
    return { db, limit };
});

const dir = await mkdtemp(path.join(tmpdir(), 'omv-sink-bench-'));
const csvPath = path.join(dir, 'sink-bench.csv');
{
    const out = createWriteStream(csvPath);
    let seed = 3;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    out.write('t,a\n');
    let block = '';
    for (let i = 0; i < ROWS; i++) {
        // A spike every 5003 rows, for the spike detector.
        const a = (Math.sin(i / 500) + random() * 0.1 + (i % 5003 === 7 ? 5 : 0)).toFixed(5);
        // A repeated stamp every 997 rows.
        const t = ((i % 997 === 500 ? i - 1 : i) * 0.001).toFixed(3);
        block += `${t},${a}\n`;
        if (block.length > 1 << 20) {
            if (!out.write(block)) await new Promise(resolve => out.once('drain', resolve));
            block = '';
        }
    }
    out.write(block);
    await new Promise(resolve => out.end(resolve));
}
console.log(`CSV: ${ROWS} rows, ${Math.round((await stat(csvPath)).size / 1e6)} MB`);

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const show = (label, value) => console.log(`  ${label}`, typeof value === 'string' ? value : JSON.stringify(value));

try {
    let opfsCount = 0;
    for (const { db, limit } of CONFIGS) {
        console.log(`\n--- database ${db === 'opfs' ? 'in OPFS' : 'in memory'}, memory_limit ${limit || 'none (the default)'}`);
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('pageerror', e => console.log('  PAGEERROR', e.message));
        page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  console.${m.type()}`, m.text().slice(0, 200)); });
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
        show('engine', await page.evaluate(async ({ db, limit, name }) => {
            const source = await window.app._getDuckDbSource();
            await source.init();
            if (db === 'opfs') {
                // The proposal of §10: the main database in OPFS. The app's
                // connection is replaced, with the app's own tuning.
                await source._db.open({ path: `opfs://${name}`, accessMode: 3 /* READ_WRITE */ });
                source._conn = await source._db.connect();
                // threads=2 is refused by a build without threads, as in the app.
                try { await source._conn.query('PRAGMA threads=2'); } catch (_) { /* best effort */ }
                await source._conn.query('PRAGMA preserve_insertion_order=false');
            }
            if (limit) await source._conn.query(`PRAGMA memory_limit='${limit}'`);
            const setting = (await source._conn.query("SELECT current_setting('memory_limit') AS v")).toArray()[0].toJSON().v;
            // The sinks' own budget out of the way: this measures the engine.
            source.sinkBudgetBytes = Infinity;
            window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 1, lazyResultsMb: 0 });
            return { memory_limit: setting };
        }, { db, limit, name: `omv-sink-bench-${Date.now()}-${opfsCount++}.db` }));

        const loadStarted = Date.now();
        await page.setInputFiles('#file-input', csvPath);
        try {
            await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 300000 });
        } catch (err) {
            // What the page shows instead: a dialog, an error.
            show('open lazily failed', await page.evaluate(() => [...document.querySelectorAll('.modal, [role=dialog], .example-loading-overlay')]
                .map(el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean)));
            await context.close();
            continue;
        }
        show('open lazily', `${Date.now() - loadStarted} ms`);

        const results = await page.evaluate(async (rows) => {
            const app = window.app;
            const fileId = [...app.plotManager.files.keys()][0];
            app.setActiveFile(fileId);
            const data = app.plotManager.files.get(fileId).data;
            const source = data._duckdb.source;
            const out = {};
            const memory = async () => {
                const rows = (await source._conn.query('SELECT SUM(memory_usage_bytes)::DOUBLE AS b FROM duckdb_memory()')).toArray();
                return Number(rows[0].toJSON().b);
            };
            // The tables alone (sinks, dataset tables): what the budget counts.
            // The engine's total also holds the scan's and the queries' buffers.
            const tableMemory = async () => {
                const rows = (await source._conn.query("SELECT COALESCE(SUM(memory_usage_bytes), 0)::DOUBLE AS b FROM duckdb_memory() WHERE tag = 'IN_MEMORY_TABLE'")).toArray();
                return Number(rows[0].toJSON().b);
            };
            const step = async (label, run) => {
                const t0 = performance.now();
                try {
                    const value = await run();
                    out[label] = { ms: Math.round(performance.now() - t0), ...(value && typeof value === 'object' ? value : {}) };
                } catch (e) {
                    out[label] = { ms: Math.round(performance.now() - t0), error: String(e?.message || e).split('\n')[0].slice(0, 160) };
                }
            };
            const context = (tool, sourceName, outputName) => ({
                fileId, data, sourceName, sourceVariable: data.variables[sourceName], outputName,
                targetMode: 'create', tool, lazy: true,
            });
            await step('full scan (COUNT)', async () => ({
                rows: Number((await source._conn.query(`SELECT COUNT(*)::DOUBLE AS n FROM ${data._duckdb.tableName}`)).toArray()[0].toJSON().n),
            }));
            await step('IQR quartiles (3b)', async () => {
                const { n } = await source.exactOrderStatistics(data, 'a', count => [count >> 2, (3 * count) >> 2]);
                return { n };
            });
            await step('linear detrend sums (3b)', async () => {
                const stats = await app._computeLazyToolStats(data, { name: 'x', tool: 'detrend', sourceName: 'a', params: { method: 'linear', order: 2, window: 101 } });
                return { fitPoints: stats.fitPoints };
            });
            await step('integral gap threshold (4a)', async () => {
                const gaps = await app._lazySamplingGapThreshold(data, source.timeValueSql(data));
                return { hasNominalStep: gaps.hasNominalStep };
            });
            // What a zoom costs without a sink, to read the one below against:
            // a CSV is scanned whole by every query either way.
            await step('zoom on the file alone (1000 rows)', async () => {
                const mid = Math.floor(rows / 2) * 0.001;
                const raw = await source.getRawColumnsRange(data, ['a'], mid, mid + 0.9995, 1e6);
                return { rows: raw.x.length };
            });
            const before = await memory();
            await step('moving average job (window 101)', async () => {
                const result = await app._applyLazyDataToolCreateMode(context('movingAverage', 'a', 'ma'), { tool: 'movingAverage', params: { window: 101 } }, { silent: true });
                if (!result) throw new Error(app._dataToolMessage?.message || 'not created');
                const definition = app.dataToolVariablesByFile.get(fileId).get('ma');
                return { rows: definition.lazySink.rows };
            });
            const after = await memory();
            out['engine memory'] = { beforeMB: Math.round(before / 1e6), afterMB: Math.round(after / 1e6) };
            const sinkRows = app.dataToolVariablesByFile.get(fileId)?.get('ma')?.lazySink?.rows;
            if (sinkRows) out['sink bytes per row'] = { value: Math.round(((after - before) / sinkRows) * 10) / 10 };
            if (sinkRows) {
                await step('zoom on the sink (1000 rows)', async () => {
                    const mid = Math.floor(rows / 2) * 0.001;
                    const raw = await source.getRawColumnsRange(data, ['ma', 'a'], mid, mid + 0.9995, 1e6);
                    return { rows: raw.x.length };
                });
                await step('overview refresh with the sink', async () => { await source.refreshOverview(data); return {}; });
            }
            // Phase 4b-2: the digital filter. The step of the time axis is
            // measured once per file, and cached for the filters after it.
            const filter = (mode) => ({ source: 'manual', b: [0.2, 0.3], a: [1, -0.5], mode, advance: 0, restartGap: 0, init: 'steady', initState: [] });
            await step('time-axis step over the whole file (4b-2)', async () => {
                const steps = await app._lazyAxisSteps(data);
                return { hasNominalStep: steps.hasNominalStep };
            });
            await step('filter, forward (4b-2)', async () => {
                const result = await app._applyLazyDataToolCreateMode(context('filter', 'a', 'ff'), { tool: 'filter', params: filter('forward') }, { silent: true });
                if (!result) throw new Error('not created');
                return { rows: result.count };
            });
            const beforeZero = await memory();
            await step('filter, zero phase: one stretch as long as the file, two passes (4b-2)', async () => {
                const result = await app._applyLazyDataToolCreateMode(context('filter', 'a', 'fz'), { tool: 'filter', params: filter('zeroPhase') }, { silent: true });
                if (!result) throw new Error('not created');
                return { rows: result.count };
            });
            out['engine memory after the zero-phase filter'] = { beforeMB: Math.round(beforeZero / 1e6), afterMB: Math.round(await memory() / 1e6) };

            // Phase 4b-3: the tools without state.
            out['compute worker pool'] = { available: typeof Worker !== 'undefined' };
            const create = async (label, tool, sourceName, name, config) => step(label, async () => {
                const result = await app._applyLazyDataToolCreateMode(context(tool, sourceName, name), { tool, ...config }, { silent: true });
                if (!result) throw new Error(app._dataToolMessage?.message || 'not created');
                return { count: result.count };
            });
            await create('spikes, NaN (4b-3)', 'removeOutliers', 'a', 'sn', { method: 'spike', params: { sensitivity: 6 }, replacement: 'nan' });
            await create('spikes, interpolated (4b-3)', 'removeOutliers', 'a', 'si', { method: 'spike', params: { sensitivity: 6 }, replacement: 'interpolate' });
            // `a` with holes: its crests cut by hard bounds, SQL over the file.
            await create('hard bounds (holes for the next ones)', 'removeOutliers', 'a', 'ah', { method: 'bounds', params: { lower: null, upper: 1.05 }, replacement: 'nan' });
            await create('fill missing, linear, no gap limit (4b-3)', 'interpolate', 'ah', 'fl', { params: { method: 'linear', maxGap: 0, edges: 'leave', window: 21 } });
            await create('fill missing, pchip (4b-3)', 'interpolate', 'ah', 'fp', { params: { method: 'pchip', maxGap: 0, edges: 'leave', window: 21 } });
            await create('integral, interpolate across holes (4b-3)', 'integrate', 'ah', 'ib', { params: { method: 'trapezoidal', gapPolicy: 'interpolate', initial: 0 } });

            // Phase 4b-4: the file tools, each a lazy dataset of its own.
            const dataset = (label, recipe, name) => step(label, async () => {
                const before = await memory();
                const tablesBefore = await tableMemory();
                const computed = recipe.tool === 'collapse'
                    ? await app._computeCollapseDataset(fileId, data, { ...recipe, sourceFileId: fileId }, name)
                    : await app._computeResampleDataset(fileId, data, { ...recipe, sourceFileId: fileId }, name);
                const rowsOut = computed.data.metadata.numTimesteps;
                const grown = (await memory()) - before;
                const table = (await tableMemory()) - tablesBefore;
                const t0 = performance.now();
                const mid = Number(computed.data.metadata.timeStart) + (Number(computed.data.metadata.timeEnd) - Number(computed.data.metadata.timeStart)) / 2;
                const zoom = await source.getRawColumnsRange(computed.data, ['a'], mid, mid + 1, 1e6);
                const zoomMs = Math.round(performance.now() - t0);
                await source.release(computed.data);
                // Every numeric variable of the file rides along: the file's
                // own and the outputs of the tools made before this one.
                const columns = computed.names.length;
                return {
                    rows: rowsOut,
                    columns,
                    tableBytesPerRow: rowsOut ? Math.round((table / rowsOut) * 10) / 10 : null,
                    tableBytesPerValue: rowsOut ? Math.round((table / rowsOut / (columns + 1)) * 10) / 10 : null,
                    engineGrowthMB: Math.round(grown / 1e6),
                    zoomRows: zoom.x.length,
                    zoomMs,
                };
            });
            await step('axis over the whole file: rows, repeats (4b-4)', async () => {
                const steps = await app._lazyRealAxisSteps(data);
                return { rows: steps.rows, repeats: steps.repeats };
            });
            await dataset('resample, bin mean, Δt 0.01 (10× down) (4b-4)', { tool: 'resample', sourceName: '', params: { gridMode: 'step', method: 'mean', step: 0.01, gapPolicy: 'leave' } }, 'rm');
            await dataset('resample, linear, Δt 0.002 (2× down) (4b-4)', { tool: 'resample', sourceName: '', params: { gridMode: 'step', method: 'linear', step: 0.002, gapPolicy: 'leave' } }, 'rl');
            await dataset('collapse repeated timestamps, mean (4b-4)', { tool: 'collapse', sourceName: '', params: { aggregate: 'mean' } }, 'cl');
            await step('cross-correlation past its budget: refused (4b-4)', async () => {
                try {
                    await app._computeXcorrDataset(fileId, data, { tool: 'xcorr', sourceFileId: fileId, sourceName: 'a', params: { second: 'ah', maxLag: 1, normalization: 'coeff', removeMean: true } });
                    return { refused: false };
                } catch (err) {
                    return { refused: true, code: err?.code || String(err?.message || err).slice(0, 80) };
                }
            });
            out['engine memory at the end'] = { MB: Math.round(await memory() / 1e6) };
            return out;
        }, ROWS);
        for (const [label, value] of Object.entries(results)) show(label, value);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
}
