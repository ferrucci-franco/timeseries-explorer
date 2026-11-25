// The Repeated marks of a lazy file are the marks the in-memory path draws.
//
//   node scripts/test-lazy-repeated-marks.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// time column the in-memory path holds. In memory: the runs of the column
// (repeatedTimestampRuns) reduced by repeatedMarksForView. Lazy:
// getRepeatedColumns (src/data/repeated-buckets-sql.js) reduced by the same
// repeatedMarksForView, which merges DuckDB's column marks like a source's.
//
// Checked, exactly — marks (instant, how many instants, longest run) and bars:
//   · the whole file and windows of it, at several plot widths, with runs of
//     2 to 7 rows, runs side by side, a run at the first and at the last row,
//     ties for the longest run of a column;
//   · rows with no time, and a time column out of order that comes back to
//     an instant later (counted again, as the kernel does);
//   · a longer shortest run (minRun);
//   · the number of repeated instants in the whole file, from any window;
//   · a file with none; a time axis generated from the row number;
//   · a lazy file merged with an in-memory one on the same panel;
//   · the pass is streamed: no sort and no hash of the rows in its plan;
//   · cancel stops it.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { repeatedTimestampRuns } = await import(new URL('../src/utils/repeated-timestamps.js', import.meta.url));
const { repeatedMarksForView, repeatedMarkColumns } = await import(new URL('../src/utils/repeated-marks.js', import.meta.url));
const { buildRepeatedColumnsSql } = await import(new URL('../src/data/repeated-buckets-sql.js', import.meta.url));

// ── Fixtures ──────────────────────────────────────────────────────
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 50000;
function makeLines({ repeats = true, disorder = false, blanks = false } = {}) {
    const lines = ['t,a'];
    let t = 0;
    let hold = 0;
    for (let i = 0; i < ROWS; i++) {
        if (hold > 0) hold -= 1;
        else {
            t = Math.round((t + 0.01) * 100) / 100;
            // Runs of 2…7 rows, some right after another run.
            if (repeats && (random() < 0.004 || i === 0 || i === ROWS - 3)) hold = 1 + Math.floor(random() * 6);
            if (repeats && i === 20000) hold = 1;
            if (repeats && i === 20002) hold = 1;       // a run right after a run
        }
        let stamp = t;
        // Out of order: a stretch that goes back over instants already seen.
        if (disorder && i >= 30000 && i < 30400) stamp = Math.round((t - 50) * 100) / 100;
        const text = blanks && i % 911 === 4 ? '' : stamp.toFixed(2);
        lines.push(`${text},${(Math.sin(i / 60)).toFixed(5)}`);
    }
    return lines;
}
const generatedProfile = {
    delimiter: ',', decimalSeparator: '.', rawHeaders: ['t', 'a'],
    headers: [{ name: 't' }, { name: 'a' }], dataStartIndex: 1, numericColumnIndexes: [1],
    sampleRows: [], timeSource: { ok: true, strategy: 'generated-index', name: 'index' },
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
const files = {
    'rep.csv': makeLines(),
    'messy.csv': makeLines({ disorder: true, blanks: true }),
    'clean.csv': makeLines({ repeats: false }),
};
for (const [name, lines] of Object.entries(files)) db.registerFileText(name, lines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();
let tableId = 0;
const loadLazy = (handle, csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_rep_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
// The time column as the in-memory path holds it: every row that has a time.
async function timesOf(lazy) {
    const name = Object.keys(lazy.variables).find(key => key !== lazy.metadata.timeName);
    const parts = [];
    for await (const chunk of streamColumns(lazy, [name])) parts.push(chunk.x);
    const out = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

async function compare(lazy, times, lo, hi, width, label, { minRun = 2 } = {}) {
    const runs = repeatedTimestampRuns(times, minRun);
    const want = repeatedMarksForView([{ key: 'f', times, runs }], lo, hi, width);
    const got = await duck.getRepeatedColumns(lazy, lo, hi, repeatedMarkColumns(width), { minRun });
    const view = repeatedMarksForView([], lo, hi, width, undefined, got.marks.map(mark => ({ ...mark, key: 'f' })));
    assert.equal(got.total, runs.count, `${label}: the repeated instants of the whole file (${got.total} vs ${runs.count})`);
    assert.equal(view.marks.length, want.marks.length, `${label}: as many marks (${view.marks.length} vs ${want.marks.length})`);
    view.marks.forEach((mark, i) => {
        assert.deepEqual(mark, want.marks[i], `${label}: mark ${i}`);
    });
    assert.deepEqual(view.regions, want.regions, `${label}: the bars`);
    return want;
}

// ── A file with runs of every kind ────────────────────────────────
const lazy = await loadLazy('rep.csv');
const times = await timesOf(lazy);
assert.equal(times.length, ROWS);
const allRuns = repeatedTimestampRuns(times);
assert.ok(allRuns.count > 150, `the fixture repeats instants (${allRuns.count})`);
assert.ok(Math.max(...allRuns.lengths) >= 6, 'with long runs');
assert.equal(allRuns.starts[0], 0, 'one at the first row');
const tMin = times[0];
const tMax = times[times.length - 1];
for (const width of [1200, 640, 37, 3]) {
    const whole = await compare(lazy, times, tMin, tMax, width, `whole file, ${width} px`);
    assert.ok(whole.marks.length > 0);
}
// Windows: wide, narrow, one that holds a single run, one that holds none,
// and one whose edges fall on repeated instants.
const some = Number(times[allRuns.starts[40]]);
const next = Number(times[allRuns.starts[41]]);
for (const [lo, hi, label] of [
    [tMin + 30, tMin + 260, 'a wide window'],
    [some - 0.5, some + 0.5, 'a narrow window'],
    [some - 0.005, some + 0.005, 'a window around one run'],
    [some + 0.004, some + 0.006, 'a window with none'],
    [some, next, 'edges on repeated instants'],
    [next, some, 'a reversed range'],
    [tMax - 5, tMax + 5, 'past the end of the file'],
]) {
    await compare(lazy, times, lo, hi, 900, label);
}
await compare(lazy, times, some, some, 900, 'a window of no width');
// Ties for the longest run of a column, and columns that hold several.
const wide = await compare(lazy, times, tMin, tMax, 60, 'many instants per column');
assert.ok(wide.marks.some(mark => mark.instants > 3), 'columns holding several instants');
// A longer shortest run.
for (const minRun of [3, 5]) await compare(lazy, times, tMin, tMax, 900, `runs of ${minRun} or more`, { minRun });
console.log(`lazy repeated marks: ${allRuns.count} repeated instants, the same marks and bars as in memory`);

// ── Rows with no time, and a column out of order ──────────────────
{
    const messy = await loadLazy('messy.csv');
    const messyTimes = await timesOf(messy);
    assert.ok(messyTimes.length < ROWS, 'rows with no time are not rows of the series');
    let backwards = 0;
    for (let i = 1; i < messyTimes.length; i++) if (messyTimes[i] < messyTimes[i - 1]) backwards += 1;
    assert.ok(backwards > 0, 'the column goes back in time');
    const lo = Math.min(...messyTimes);
    const hi = Math.max(...messyTimes);
    for (const width of [1100, 90]) await compare(messy, messyTimes, lo, hi, width, `out of order, ${width} px`);
    await compare(messy, messyTimes, messyTimes[29990], messyTimes[30500], 900, 'the stretch that goes back');
    console.log('lazy repeated marks: rows with no time and a column out of order');
}

// ── None; a generated axis ────────────────────────────────────────
{
    const clean = await loadLazy('clean.csv');
    const cleanTimes = await timesOf(clean);
    await compare(clean, cleanTimes, cleanTimes[0], cleanTimes[cleanTimes.length - 1], 900, 'a file with none');
    assert.deepEqual(await duck.getRepeatedColumns(clean, 0, 100, 300), { marks: [], total: 0 });
    const generated = await loadLazy('rep.csv', generatedProfile);
    assert.equal(generated._duckdb.generatedTime, true);
    let asked = 0;
    const original = duck._interactiveQuery.bind(duck);
    duck._interactiveQuery = (...args) => { asked += 1; return original(...args); };
    assert.deepEqual(await duck.getRepeatedColumns(generated, 0, 1000, 300), { marks: [], total: 0 }, 'row numbers repeat nothing');
    assert.equal(asked, 0, 'and the file is not read to say so');
    duck._interactiveQuery = original;
}

// ── A lazy file and an in-memory one on the same panel ────────────
{
    const other = Float64Array.from({ length: 4000 }, (_, i) => tMin + Math.floor(i / (i % 500 === 7 ? 1 : 1)) * 0.1);
    for (const at of [100, 101, 2500, 2501, 2502]) other[at] = other[99 + (at > 2000 ? 2400 : 0)];
    const otherRuns = repeatedTimestampRuns(other);
    assert.ok(otherRuns.count >= 2);
    const lo = tMin;
    const hi = tMin + 400;
    const width = 300;
    const want = repeatedMarksForView([
        { key: 'memory', times: other, runs: otherRuns },
        { key: 'lazy', times, runs: allRuns },
    ], lo, hi, width);
    const got = await duck.getRepeatedColumns(lazy, lo, hi, repeatedMarkColumns(width));
    const view = repeatedMarksForView([{ key: 'memory', times: other, runs: otherRuns }], lo, hi, width, undefined,
        got.marks.map(mark => ({ ...mark, key: 'lazy' })));
    assert.deepEqual(view.regions, want.regions, 'mixed panel: the bars');
    assert.equal(view.marks.length, want.marks.length);
    view.marks.forEach((mark, i) => {
        assert.equal(mark.instants, want.marks[i].instants, `mixed panel: mark ${i} counts both files`);
        assert.equal(mark.longest, want.marks[i].longest, `mixed panel: mark ${i} longest run`);
        assert.deepEqual([...mark.keys].sort(), [...want.marks[i].keys].sort(), `mixed panel: mark ${i} names its files`);
    });
    assert.ok(view.marks.some(mark => mark.keys.length === 2), 'a column both files mark');
}

// ── Streamed: no sort, no hash of the rows ────────────────────────
{
    const sql = buildRepeatedColumnsSql(duck._timeExpressionSql(lazy, lazy._duckdb), lazy._duckdb.tableName,
        v => duck._numericLiteral(v), tMin, tMax, 300);
    const plan = duck._conn.query(`EXPLAIN ${sql}`).toArray().map(row => String(row.explain_value ?? Object.values(row.toJSON()).join(' '))).join('\n');
    assert.match(plan, /STREAMING_WINDOW/, 'the runs are found by streamed windows');
    assert.doesNotMatch(plan, /\bWINDOW\b(?<!STREAMING_WINDOW)/, 'none of them materialised');
    // The one sort is of the answer (a row per column), above the aggregate.
    assert.equal((plan.match(/ORDER_BY/g) || []).length, 1, 'one sort');
    assert.ok(plan.indexOf('ORDER_BY') < plan.indexOf('HASH_GROUP_BY') && plan.indexOf('HASH_GROUP_BY') < plan.indexOf('STREAMING_WINDOW'),
        'of the grouped answer, not of the rows');
}

// ── Cancel ────────────────────────────────────────────────────────
{
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(duck.getRepeatedColumns(lazy, tMin, tMax, 300, { signal: controller.signal }),
        error => error?.name === 'AbortError', 'an aborted request reads nothing');
}

console.log('lazy repeated marks: mixed panels, a generated axis, streamed and cancellable.');
process.exit(0);
