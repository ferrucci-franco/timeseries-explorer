#!/usr/bin/env node
// DuckDB-WASM with its database in OPFS, measured in the app's own bundle.
//
//   node bench/opfs-database.mjs [--rows 20000000] [--limit 100MB]
//
// Runs Chromium (Playwright) against the Vite dev server and, on the engine
// the app instantiates, measures what phase 4b of docs/any-size-files.md
// needs to know about the browser's Origin Private File System:
//
//   1. a database opened at opfs://, a table larger than memory_limit written
//      by CREATE TABLE AS: does DuckDB page it to disk, how fast, how big;
//   2. reload the page and reopen: is it still there;
//   3. a second tab on the same file: the exclusive lock;
//   4. the same table in an in-memory database under the same limit;
//   5. the 4b shape: chunked inserts into a sink table, reads by rn ranges
//      joined with a view over "the file", the naive whole-table join, a TEMP
//      table's catalog, ATTACH of a second OPFS database;
//   6. deleting the file while it is open, after reopening in memory, and
//      from another tab once the owner is gone.
//
// Numbers are for one thread and this machine; the point is what works and
// what fails, and the orders of magnitude.

import { chromium } from 'playwright';
import { createServer } from 'vite';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ROWS = Number(arg('rows', 20000000));
const LIMIT = arg('limit', '100MB');
const CHUNK = 262144;
const DB = 'opfs://omv-bench.db';
// Reopening a name this worker already opened once, after a spell in memory,
// comes back read-only ("File is not opened in write mode"); every open in a
// worker gets a fresh name.
const DB2 = 'opfs://omv-bench-5.db';
const DB3 = 'opfs://omv-bench-6.db';

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const show = (label, value) => console.log(label, typeof value === 'string' ? value : JSON.stringify(value));

async function openApp(context) {
    const page = await context.newPage();
    page.on('pageerror', e => console.log('PAGEERROR', e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    return page;
}

const opfsFiles = page => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out = {};
    for await (const [name, handle] of root.entries()) if (handle.kind === 'file') out[name] = (await handle.getFile()).size;
    return out;
});
const opfsClear = page => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) { try { await root.removeEntry(name, { recursive: true }); } catch { /* locked by an open handle */ } }
});

// Everything below runs inside the page, on the app's engine.
const engine = async ({ db, limit }) => {
    const source = await window.app._getDuckDbSource();
    await source.init();
    const t0 = performance.now();
    try {
        await source._db.open(db ? { path: db, accessMode: 3 /* READ_WRITE */ } : {});
    } catch (e) { return { openError: String(e?.message || e).split('\n')[0] }; }
    const conn = await source._db.connect();
    await conn.query(`PRAGMA memory_limit='${limit}'`);
    await conn.query('PRAGMA threads=1');
    await conn.query('PRAGMA preserve_insertion_order=false');
    window.__bench = { conn, source };
    return { openMs: Math.round(performance.now() - t0) };
};
const sql = async (query) => {
    const { conn } = window.__bench;
    const t0 = performance.now();
    try {
        // BigInt (a BIGINT count) does not serialise; Number is enough here.
        const rows = (await conn.query(query)).toArray().map(r => JSON.parse(JSON.stringify(r.toJSON(), (_, v) => (typeof v === 'bigint' ? Number(v) : v))));
        return { ms: Math.round(performance.now() - t0), rows: rows.slice(0, 3) };
    } catch (e) { return { ms: Math.round(performance.now() - t0), error: String(e?.message || e).split('\n')[0] }; }
};
const MEMORY = "SELECT tag, memory_usage_bytes::DOUBLE AS bytes FROM duckdb_memory() WHERE memory_usage_bytes > 0";

try {
    const context = await browser.newContext();
    let page = await openApp(context);
    await opfsClear(page);
    show('quota', await page.evaluate(async () => { const e = await navigator.storage.estimate(); return { quotaMB: Math.round(e.quota / 1e6), usageMB: Math.round(e.usage / 1e6) }; }));

    console.log(`\n--- 1. database in OPFS, memory_limit ${LIMIT}, CREATE TABLE AS with ${ROWS} rows`);
    show('open', await page.evaluate(engine, { db: DB, limit: LIMIT }));
    show('create', await page.evaluate(sql, `CREATE OR REPLACE TABLE t AS SELECT i AS rn, i * 0.5 AS t, sin(i::DOUBLE) AS y FROM range(${ROWS}) r(i)`));
    show('checkpoint', await page.evaluate(sql, 'CHECKPOINT'));
    show('memory', await page.evaluate(sql, MEMORY));
    show('count+sum', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS n, sum(y) AS s FROM t'));
    show('zoom by rn', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS n FROM t WHERE rn BETWEEN 10000000 AND 10001000'));
    show('files', await opfsFiles(page));

    console.log('\n--- 2. reload the page, reopen the same file');
    await page.reload();
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    show('open', await page.evaluate(engine, { db: DB, limit: LIMIT }));
    show('count+sum', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS n, sum(y) AS s FROM t'));

    console.log('\n--- 3. a second tab opens the same file');
    const other = await openApp(context);
    show('open', await other.evaluate(engine, { db: DB, limit: LIMIT }));
    await other.close();

    console.log(`\n--- 4. the same CREATE TABLE AS in an in-memory database, memory_limit ${LIMIT}`);
    show('open', await page.evaluate(engine, { db: null, limit: LIMIT }));
    show('create', await page.evaluate(sql, `CREATE OR REPLACE TABLE t AS SELECT i AS rn, i * 0.5 AS t, sin(i::DOUBLE) AS y FROM range(${ROWS}) r(i)`));

    console.log('\n--- 5. the phase 4b shape, in a new OPFS database');
    show('reopen the first file in this worker', await page.evaluate(engine, { db: DB, limit: LIMIT }));
    show('write to it', await page.evaluate(sql, 'CREATE OR REPLACE TABLE probe AS SELECT 1 AS x'));
    show('open', await page.evaluate(engine, { db: DB2, limit: LIMIT }));
    show('attach another OPFS db', await page.evaluate(sql, "ATTACH 'opfs://omv-bench-2.db' AS other"));
    show('registered CSV', await page.evaluate(async () => {
        const { conn, source } = window.__bench;
        const csv = new File([`time,a\n${Array.from({ length: 1000 }, (_, i) => `${i},${i * 2}`).join('\n')}\n`], 'bench.csv');
        await source._db.registerFileHandle('bench.csv', csv, 2 /* BROWSER_FILEREADER */, true);
        const rows = (await conn.query("SELECT count(*)::DOUBLE AS n FROM read_csv('bench.csv')")).toArray().map(r => Number(r.toJSON().n));
        await source._db.dropFile('bench.csv');
        return rows;
    }));
    show('view over "the file"', await page.evaluate(sql, `CREATE OR REPLACE VIEW f AS SELECT i AS rn, i * 0.5 AS t, cos(i::DOUBLE) AS a FROM range(${ROWS}) r(i)`));
    show('sink table', await page.evaluate(sql, 'CREATE OR REPLACE TABLE s (rn BIGINT, t DOUBLE, y DOUBLE)'));
    show('chunked inserts', await page.evaluate(async ({ rows, chunk }) => {
        const { conn } = window.__bench;
        const t0 = performance.now();
        try {
            for (let start = 0; start < rows; start += chunk) {
                const end = Math.min(rows, start + chunk);
                // The executor will hand an Arrow chunk to a temp table; the
                // hand-over into the sink is this INSERT … SELECT either way.
                await conn.query(`CREATE OR REPLACE TEMP TABLE chunk AS SELECT i AS rn, i * 0.5 AS t, sin(i::DOUBLE) AS y FROM range(${start}, ${end}) r(i)`);
                await conn.query('INSERT INTO s SELECT * FROM chunk');
            }
            await conn.query('DROP TABLE chunk');
            return { ms: Math.round(performance.now() - t0), chunks: Math.ceil(rows / chunk) };
        } catch (e) { return { ms: Math.round(performance.now() - t0), error: String(e?.message || e).split('\n')[0] }; }
    }, { rows: ROWS, chunk: CHUNK }));
    show('checkpoint', await page.evaluate(sql, 'CHECKPOINT'));
    show('memory', await page.evaluate(sql, MEMORY));
    show('files', await opfsFiles(page));
    show('physical order = rn', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS out_of_order FROM (SELECT rn, row_number() OVER () - 1 AS pos FROM s) WHERE rn <> pos'));
    show('sink alone, count+sum', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS n, sum(y) AS s FROM s'));
    show('sink alone, zoom', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS n FROM s WHERE rn BETWEEN 10000000 AND 10001000'));
    const both = (lo, hi) => `SELECT count(*)::DOUBLE AS n, sum(f.a * s.y) AS s FROM (SELECT * FROM f WHERE rn BETWEEN ${lo} AND ${hi}) f POSITIONAL JOIN (SELECT * FROM s WHERE rn BETWEEN ${lo} AND ${hi}) s`;
    show('file x sink, zoom, both sides cut by rn', await page.evaluate(sql, both(10000000, 10001000)));
    show('file x sink, whole file by chunks', await page.evaluate(async ({ rows, chunk, both }) => {
        const { conn } = window.__bench;
        const t0 = performance.now();
        let n = 0;
        try {
            for (let lo = 0; lo < rows; lo += chunk) {
                const q = both.replace(/LO/g, lo).replace(/HI/g, Math.min(rows, lo + chunk) - 1);
                n += Number((await conn.query(q)).toArray()[0].toJSON().n);
            }
            return { ms: Math.round(performance.now() - t0), rows: n };
        } catch (e) { return { ms: Math.round(performance.now() - t0), error: String(e?.message || e).split('\n')[0] }; }
    }, { rows: ROWS, chunk: CHUNK, both: both('LO', 'HI') }));
    show('file x sink, whole file, one join', await page.evaluate(sql, 'SELECT count(*)::DOUBLE AS n, sum(f.a * s.y) AS s FROM f POSITIONAL JOIN s'));
    show('temp table catalog', await page.evaluate(sql, "CREATE TEMP TABLE scratch AS SELECT 1 AS x; SELECT database_name, temporary FROM duckdb_tables() WHERE table_name = 'scratch'"));

    console.log('\n--- 6. deleting the file');
    await opfsClear(page);
    show('while open', await opfsFiles(page));
    show('reopen in memory, dropFile', await page.evaluate(async names => {
        const { source } = window.__bench;
        await source._db.open({});
        const out = {};
        for (const name of names) {
            try { await source._db.dropFile(name); out[name] = 'dropped'; } catch (e) { out[name] = String(e?.message || e).split('\n')[0]; }
        }
        return out;
    }, [DB, `${DB}.wal`, DB2, `${DB2}.wal`]));
    await opfsClear(page);
    show('after that', await opfsFiles(page));
    show('reopen and leave a file behind', await page.evaluate(engine, { db: DB3, limit: LIMIT }));
    await page.close();
    page = await openApp(context);
    await opfsClear(page);
    show('deleted from another tab once the owner is gone', await opfsFiles(page));
} finally {
    await browser.close();
    await server.close();
}
