// The chunked column reader: every row of a file, a chunk at a time, from a
// lazy DuckDB view or from arrays already in memory, and the same rows either
// way.
//
//   node scripts/test-column-stream.mjs
//
// The lazy half runs the app's own DuckDBSource against a real DuckDB-WASM
// engine (the Node build of the same package the app ships), so what is tested
// is the Arrow batch reader the browser gets, not a stand-in.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns, streamEagerColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));

const require = createRequire(import.meta.url);
// One Arrow for the whole process. The Node build of DuckDB-WASM require()s
// the CommonJS copy of apache-arrow, while duckdb-source.js imports the ES
// module copy; two copies means the batches the engine returns fail the app's
// `instanceof RecordBatch`, and `new arrow.Table(batches)` recurses until the
// stack runs out. Vite bundles a single copy, so the app never sees this.
// Seeding require's cache with the ES module the app uses makes it so here.
const esmArrow = await import('apache-arrow');
const arrowPath = require.resolve('apache-arrow');
require.cache[arrowPath] = { id: arrowPath, filename: arrowPath, loaded: true, exports: esmArrow };
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
}
function concat(chunks, key) {
    const parts = chunks.map(chunk => key === 'x' ? chunk.x : chunk.yByVar.get(key));
    const out = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}
function sameValues(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (Number.isNaN(expected[i])) assert.ok(Number.isNaN(actual[i]), `${label}[${i}] is NaN`);
        else assert.equal(actual[i], expected[i], `${label}[${i}]`);
    }
}

// ── The fixture: holes in a column, and rows with no time ───────────────────
const ROWS = 100003;
const t = new Float64Array(ROWS);
const a = new Float64Array(ROWS);
const b = new Float64Array(ROWS);
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    t[i] = i % 9973 === 5 ? NaN : i / 100;          // a time cell left empty now and then
    a[i] = Math.round(Math.sin(i) * 1e6) / 1e6;
    b[i] = i % 7 === 0 ? NaN : i * 3;               // a value cell left empty every seventh row
    lines.push(`${Number.isNaN(t[i]) ? '' : t[i]},${a[i]},${Number.isNaN(b[i]) ? '' : b[i]}`);
}
const csv = lines.join('\n') + '\n';
const keptRows = [...t].filter(Number.isFinite).length;

// ── Eager: the arrays in memory, cut into chunks ────────────────────────────
const eager = {
    metadata: { timeName: 't' },
    variables: { t: { data: t }, a: { data: a }, b: { data: Array.from(b) } },
};
{
    const chunks = await collect(streamEagerColumns(eager, ['a', 'b'], { chunkRows: 10000 }));
    assert.ok(chunks.length >= 10, 'a file larger than one chunk comes back in several');
    assert.ok(chunks.every(chunk => chunk.x.length <= 10000), 'no chunk is larger than asked for');
    const x = concat(chunks, 'x');
    assert.equal(x.length, keptRows, 'rows with no time are skipped');
    let expected = 0;
    for (const chunk of chunks) {
        assert.equal(chunk.rowStart, expected, 'rowStart counts the rows handed out so far');
        expected += chunk.x.length;
    }
    assert.ok(concat(chunks, 'b').some(Number.isNaN), 'a missing value arrives as NaN, from a plain Array too');
    assert.ok(chunks.some(chunk => chunk.yByVar.get('a').buffer === a.buffer),
        'a chunk with nothing to skip is a view, not a copy');

    const ranged = await collect(streamEagerColumns(eager, ['a'], { t0: 200, t1: 100, chunkRows: 4096 }));
    const rx = concat(ranged, 'x');
    assert.ok(rx.length > 0 && rx.every(v => v >= 100 && v <= 200), 'a range keeps [t0, t1], in either order');
    assert.equal(rx[0], 100, 'inclusive at the start');
    assert.equal(rx[rx.length - 1], 200, 'and at the end');

    assert.deepEqual(await collect(streamEagerColumns(eager, ['nope'])), [], 'unknown columns stream nothing');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => collect(streamEagerColumns(eager, ['a'], { signal: controller.signal })),
        err => err.name === 'AbortError', 'a cancelled stream throws AbortError');
    console.log('column stream: eager checks passed');
}

// ── Lazy: the same file, streamed from a DuckDB view ────────────────────────
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
db.registerFileText('fixture.csv', csv);

const source = new DuckDbSource();
source._db = db;
source._conn = db.connect();
const lazy = await source._loadIntoLegacy('fixture.csv', 'omv_stream_fixture', { lazy: true, overviewPoints: 100, format: 'csv' });
assert.ok(lazy._duckdb?.viewMode, 'the fixture is loaded the way a large file is: as a view');
{
    const chunks = await collect(streamColumns(lazy, ['a', 'b'], { chunkRows: 10000 }));
    assert.ok(chunks.length >= 10, 'the lazy file comes back in several chunks');
    assert.ok(chunks.slice(0, -1).every(chunk => chunk.x.length >= 10000), 'each chunk but the last is at least chunkRows');
    const eagerChunks = await collect(streamEagerColumns(eager, ['a', 'b']));
    sameValues(concat(chunks, 'x'), concat(eagerChunks, 'x'), 'lazy time vs eager time');
    sameValues(concat(chunks, 'a'), concat(eagerChunks, 'a'), 'lazy a vs eager a');
    sameValues(concat(chunks, 'b'), concat(eagerChunks, 'b'), 'lazy b vs eager b');

    const raw = await source.getRawColumnsRange(lazy, ['a', 'b'], 100, 200, 1e7);
    const ranged = await collect(streamColumns(lazy, ['a', 'b'], { t0: 100, t1: 200, chunkRows: 3000 }));
    sameValues(concat(ranged, 'x'), raw.x, 'a ranged stream vs getRawColumnsRange');
    sameValues(concat(ranged, 'b'), raw.yByVar.get('b'), 'the same rows of b');
    console.log('column stream: lazy rows match the eager arrays and getRawColumnsRange');
}

// ── Stopping early, cancelling, and not blocking the viewport ───────────────
{
    let seen = 0;
    for await (const chunk of streamColumns(lazy, ['a'], { chunkRows: 5000 })) {
        seen += chunk.x.length;
        if (seen >= 10000) break;
    }
    const again = await collect(streamColumns(lazy, ['a'], { chunkRows: 50000 }));
    assert.equal(concat(again, 'x').length, keptRows, 'a stream left early does not wedge the next one');

    const controller = new AbortController();
    let chunksBeforeAbort = 0;
    await assert.rejects(async () => {
        for await (const _chunk of streamColumns(lazy, ['a'], { chunkRows: 5000, signal: controller.signal })) {
            chunksBeforeAbort++;
            controller.abort();
        }
    }, err => err.name === 'AbortError', 'cancelling mid-stream throws AbortError');
    assert.equal(chunksBeforeAbort, 1, 'and no chunk is delivered after the abort');
    const after = await collect(streamColumns(lazy, ['b'], { chunkRows: 50000 }));
    assert.equal(concat(after, 'x').length, keptRows, 'the stream connection is usable after a cancel');

    // While a stream holds its connection open between chunks, a viewport
    // query on the shared connection must not wait for it.
    const iterator = streamColumns(lazy, ['a'], { chunkRows: 5000 })[Symbol.asyncIterator]();
    await iterator.next();
    const viewport = await Promise.race([
        source.getColumnsRange(lazy, 'a', 0, 500, 200).then(() => 'answered'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 5000)),
    ]);
    assert.equal(viewport, 'answered', 'a zoom is answered while a stream is open');
    assert.equal(source._streamConns.size, 1, 'an open stream holds one connection');
    assert.ok(!source._streamConns.has(source._conn), 'and it is not the shared one');
    await iterator.return();
    assert.equal(source._streamConns.size, 0, 'a stream left early closes its connection');
    console.log('column stream: early exit, cancel and concurrency checks passed');
}

// ── Two streams walked side by side ─────────────────────────────────────────
// An export of traces from two lazy files reads both a chunk at a time, in
// step. With one shared stream connection the second stream waited for the
// first to finish while the first waited for the second to advance: a hang.
{
    const other = await source._loadIntoLegacy('fixture.csv', 'omv_stream_fixture_2', { lazy: true, overviewPoints: 100, format: 'csv' });
    const first = streamColumns(lazy, ['a'], { chunkRows: 7000 })[Symbol.asyncIterator]();
    const second = streamColumns(other, ['b'], { chunkRows: 11000 })[Symbol.asyncIterator]();
    const a = [];
    const b = [];
    let firstDone = false;
    let secondDone = false;
    const walk = (async () => {
        while (!firstDone || !secondDone) {
            if (!firstDone) {
                const step = await first.next();
                if (step.done) firstDone = true; else a.push(step.value);
            }
            if (!secondDone) {
                const step = await second.next();
                if (step.done) secondDone = true; else b.push(step.value);
            }
        }
        return 'finished';
    })();
    const outcome = await Promise.race([walk, new Promise(resolve => setTimeout(() => resolve('hung'), 20000))]);
    assert.equal(outcome, 'finished', 'two streams advanced in step both finish');
    const eagerChunks = await collect(streamEagerColumns(eager, ['a', 'b']));
    sameValues(concat(a, 'a'), concat(eagerChunks, 'a'), 'the first stream, read in step');
    sameValues(concat(b, 'b'), concat(eagerChunks, 'b'), 'the second stream, read in step');
    assert.equal(source._streamConns.size, 0, 'and both connections are closed afterwards');
    console.log('column stream: two streams read side by side');
}
