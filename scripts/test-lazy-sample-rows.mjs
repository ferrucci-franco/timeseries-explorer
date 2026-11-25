// The Samples marks of a lazy file sit on the rows of the file: a window that
// holds few rows is read as those rows, the same ones the in-memory path draws.
//
//   node scripts/test-lazy-sample-rows.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. A lazy CSV is a view whose rows are never
// counted, so the window query could not know a window was small and always
// answered with min/max buckets — two points per bucket, pairing the earliest
// instant with the smallest value. With `rows: true` it counts the rows of each
// bucket in the same scan and, when the window holds few, returns the rows.
//
// Checked, bit for bit against the rows of the file in that window:
//   · a window where every bucket holds one row (the rows come straight from
//     the buckets, with no second scan);
//   · a window with rows sharing an instant, holes and ±inf (a second scan
//     reads the rows), every row of each instant present;
//   · two signals read in one query;
//   · a file whose time axis is generated from the row number;
//   · a window with more rows than are drawn one by one stays buckets, and
//     says so; so does every window when the rows are not asked for, whose
//     answer is what it was before;
//   · the two kinds of answer are cached apart.
// And the panel side: _lazyCacheResult gives the Samples decision the window
// (exact, read from the file, distinct instants), and an overview never does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { countDistinctPositions, sampleMarkersVisible } = await import(new URL('../src/utils/sample-markers.js', import.meta.url));

// ── Fixture ───────────────────────────────────────────────────────
// 10 ms grid; now and then three rows at one instant; holes and an inf in `a`.
const ROWS = 60000;
const lines = ['t,a,b'];
let t = 0;
for (let i = 0; i < ROWS; i++) {
    if (!(i % 1000 === 501 || i % 1000 === 502)) t = i * 0.01;
    const a = i % 137 === 5 ? '' : (i === 30007 ? 'inf' : (Math.sin(i / 40) + (i % 9) / 50).toFixed(6));
    lines.push(`${t.toFixed(2)},${a},${(i / 1000 - Math.cos(i / 17)).toFixed(6)}`);
}
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['t', 'a', 'b'],
    headers: [{ name: 't' }, { name: 'a' }, { name: 'b' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2],
    sampleRows: [],
    timeSource: { ok: true, strategy: 'generated-index', name: 'index' },
};

const require = createRequire(import.meta.url);
const esmArrow = await import('apache-arrow');
const arrowPath = require.resolve('apache-arrow');
require.cache[arrowPath] = { id: arrowPath, filename: arrowPath, loaded: true, exports: esmArrow };
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
db.registerFileText('rows.csv', lines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (csvProfile = null) =>
    duck._loadIntoLegacy('rows.csv', `omv_rows_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });

// The file in memory: every row, in file order.
async function inMemory(lazy, names) {
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const concat = (pick) => {
        const out = new Float64Array(chunks.reduce((n, c) => n + c.x.length, 0));
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    return { x: concat(c => c.x), y: Object.fromEntries(names.map(name => [name, concat(c => c.yByVar.get(name))])) };
}
// The rows of [t0, t1] as the in-memory path has them. Rows sharing an instant
// come back from SQL in no promised order, so within an instant they are
// compared as a sorted set.
function windowRows(memory, name, t0, t1) {
    const rows = [];
    for (let i = 0; i < memory.x.length; i++) {
        if (memory.x[i] >= t0 && memory.x[i] <= t1) rows.push([memory.x[i], memory.y[name][i]]);
    }
    return rows;
}
const sameBits = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
const order = (rows) => [...rows].sort((p, q) => (p[0] - q[0])
    || ((Number.isNaN(p[1]) ? 1 : 0) - (Number.isNaN(q[1]) ? 1 : 0))
    || (p[1] - q[1]));
function assertSameRows(result, name, want, label) {
    const got = Array.from(result.x, (x, i) => [x, result.yByVar.get(name)[i]]);
    assert.equal(got.length, want.length, `${label}: as many rows (${got.length} vs ${want.length})`);
    for (let i = 1; i < got.length; i++) assert.ok(got[i][0] >= got[i - 1][0], `${label}: in time order`);
    const a = order(got);
    const b = order(want);
    a.forEach((row, i) => {
        assert.ok(sameBits(row[0], b[i][0]), `${label}: row ${i} at the same instant (${row[0]} vs ${b[i][0]})`);
        assert.ok(sameBits(row[1], b[i][1]), `${label}: row ${i} with the same value (${row[1]} vs ${b[i][1]})`);
    });
}

const lazy = await loadLazy();
assert.equal(lazy._duckdb.totalRows ?? null, null, 'a lazy CSV is a view: its rows are not counted');
const memory = await inMemory(lazy, ['a', 'b']);
assert.equal(memory.x.length, ROWS);
const MAX = 2000;

// ── One row per bucket: the rows come from the buckets themselves ──
{
    const [t0, t1] = [100.05, 100.95];   // 91 rows, no repeats
    const result = await duck.getColumnsRange(lazy, ['a'], t0, t1, MAX, { rows: true });
    assert.equal(result.exactRows, true, 'a small window is its rows');
    assert.equal(result._perf.mode, 'aggregate-rows', 'read in the one scan that counted them');
    assertSameRows(result, 'a', windowRows(memory, 'a', t0, t1), 'one row per bucket');
}

// ── Rows sharing an instant, holes and inf: a second scan reads them ──
{
    const [t0, t1] = [304.9, 305.2];     // rows 30490…30520: the burst at 305.00 and a hole
    const want = windowRows(memory, 'a', t0, t1);
    assert.ok(want.filter(row => row[0] === 305).length === 3, 'the fixture has three rows at 305.00');
    const result = await duck.getColumnsRange(lazy, ['a'], t0, t1, MAX, { rows: true });
    assert.equal(result.exactRows, true);
    assert.equal(result._perf.mode, 'aggregate+rows', 'a bucket with several rows: the rows are read');
    assertSameRows(result, 'a', want, 'rows sharing an instant');
    assert.equal(Array.from(result.x).filter(x => x === 305).length, 3, 'every row of the instant is there');

    const inf = await duck.getColumnsRange(lazy, ['a'], 300, 300.2, MAX, { rows: true });
    assertSameRows(inf, 'a', windowRows(memory, 'a', 300, 300.2), 'an infinite value and a hole');
    assert.ok(Array.from(inf.yByVar.get('a')).includes(Infinity), 'the infinite value is a row like any other');
}

// ── Two signals in one query ──
{
    const [t0, t1] = [10, 13];
    const result = await duck.getColumnsRange(lazy, ['a', 'b'], t0, t1, MAX, { rows: true });
    assert.equal(result.exactRows, true);
    assertSameRows(result, 'a', windowRows(memory, 'a', t0, t1), 'two signals, a');
    assertSameRows(result, 'b', windowRows(memory, 'b', t0, t1), 'two signals, b');
}

// ── More rows than are drawn one by one: buckets, and it says so ──
{
    const result = await duck.getColumnsRange(lazy, ['a'], 0, 500, MAX, { rows: true });
    assert.equal(result.exactRows, false, 'a wide window is buckets');
    assert.ok(result.x.length <= MAX, 'within the budget');
    // Just under the limit of rows drawn one by one (1.2 × the budget).
    const edge = await duck.getColumnsRange(lazy, ['b'], 0, 23.9, MAX, { rows: true });
    assert.equal(edge.exactRows, true, '2391 rows are still drawn as rows');
    assertSameRows(edge, 'b', windowRows(memory, 'b', 0, 23.9), 'just under the limit');
    const over = await duck.getColumnsRange(lazy, ['b'], 0, 24.1, MAX, { rows: true });
    assert.equal(over.exactRows, false, '2411 rows are not');
}

// ── Not asked for: the answer it always was, cached apart ──
{
    const [t0, t1] = [100.05, 100.95];
    const plain = await duck.getColumnsRange(lazy, ['a'], t0, t1, MAX);
    assert.equal(plain.exactRows, false, 'without `rows` a lazy CSV answers with buckets');
    assert.equal(plain._perf.mode, 'aggregate');
    const want = windowRows(memory, 'a', t0, t1);
    assert.equal(plain.x.length, want.length * 2, 'two points per bucket, as before');
    const again = await duck.getColumnsRange(lazy, ['a'], t0, t1, MAX, { rows: true });
    assert.equal(again.exactRows, true, 'and the rows are not served from that answer');
    assert.equal(again._perf.cacheHit, true, 'but from their own');
}

// ── A time axis generated from the row number ──
{
    const generated = await loadLazy(generatedProfile);
    assert.equal(generated._duckdb.generatedTime, true);
    // The rows of a generated axis are counted, so a small window is estimated
    // and read as rows either way.
    const result = await duck.getColumnsRange(generated, ['a'], 30500, 30520, MAX, { rows: true });
    assert.equal(result.exactRows, true);
    assert.deepEqual(Array.from(result.x), Array.from({ length: 21 }, (_, i) => 30500 + i), 'row numbers');
    Array.from(result.yByVar.get('a')).forEach((value, i) =>
        assert.ok(sameBits(value, memory.y.a[30500 + i]), `generated axis: row ${30500 + i}`));
}

// ── The panel side: what the Samples decision is given ──
{
    // The interaction methods import Plotly, so the three this needs are
    // sliced out of the source as they are (as scripts/test-lazy-histogram.mjs
    // does with the sampler).
    const source = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const slice = (name) => {
        const start = source.indexOf(`proto.${name} = function`);
        const end = source.indexOf('\n};\n', start);
        assert.ok(start >= 0 && end > start, `${name} is present`);
        return source.slice(start, end + 4);
    };
    const { visualPairForRange } = await import(new URL('../src/compute/kernels/resample.js', import.meta.url));
    const { SAMPLE_POSITION_SCAN_LIMIT } = await import(new URL('../src/utils/sample-markers.js', import.meta.url));
    const proto = {};
    vm.runInNewContext(['_lazyCacheResult', '_lazyCacheHasViewportDetail', '_visualFromSeriesRange'].map(slice).join('\n'),
        { proto, visualPairForRange, countDistinctPositions, SAMPLE_POSITION_SCAN_LIMIT, Float64Array, ArrayBuffer });
    {
        const panel = Object.create(proto);
        panel._lowerBound = (xs, value) => { let lo = 0, hi = xs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < value) lo = mid + 1; else hi = mid; } return lo; };
        panel._upperBound = (xs, value) => { let lo = 0, hi = xs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] <= value) lo = mid + 1; else hi = mid; } return lo; };
        panel.isVariableSignInverted = () => false;
        const [t0, t1] = [304.9, 305.2];
        const result = await duck.getColumnsRange(lazy, ['a'], 304, 306, MAX, { rows: true });
        const trace = { fileId: 'f', varName: 'a' };
        trace._lazyDetailCache = {
            fileId: 'f', varName: 'a', start: 304, end: 306, target: MAX,
            x: result.x, y: result.yByVar.get('a'), rowsAsked: true, exactRows: !!result.exactRows,
        };
        const hit = panel._lazyCacheResult(trace, 0, t0, t1, MAX, { rows: true });
        const want = windowRows(memory, 'a', t0, t1);
        assert.equal(hit.sampleWindow.exact, true, 'the window is drawn row for row');
        assert.equal(hit.sampleWindow.fromFile, true, 'from the file');
        assert.equal(hit.sampleWindow.visibleCount, want.length, 'with the rows of the window');
        assert.equal(hit.sampleWindow.visiblePositions, countDistinctPositions(Float64Array.from(want, row => row[0]), 0, want.length),
            'and its distinct instants: three rows at one count once');
        assert.equal(sampleMarkersVisible({ ...hit.sampleWindow, plotWidthPx: 1000 }), true, 'so the dots have room');
        // Rows read before Samples was on were not asked for: read again.
        trace._lazyDetailCache.rowsAsked = false;
        assert.equal(panel._lazyCacheResult(trace, 0, t0, t1, MAX, { rows: true }), null, 'a cache read without `rows` is not trusted for dots');
        // Buckets are never a sample window.
        trace._lazyDetailCache = { ...trace._lazyDetailCache, rowsAsked: true, exactRows: false };
        const buckets = panel._lazyCacheResult(trace, 0, 304, 306, MAX, { rows: true });
        assert.equal(buckets?.sampleWindow ?? null, null, 'buckets carry no sample window');
        console.log('lazy sample rows: the panel is given the window of the file');
    }
}

await duck._conn.close?.();
console.log('lazy sample rows: a small window of a lazy file is its rows, bit for bit.');
process.exit(0);
