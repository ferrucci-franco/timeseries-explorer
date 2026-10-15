// Data Tools a lazy file runs in the chunked executor: the moving average and
// the moving-average detrend, written to a sink and read back over the file.
//
//   node scripts/test-lazy-sink-tools.mjs
//
// A CSV loaded lazily through the app's DuckDbSource on a real DuckDB-WASM
// engine (the Node build of the package the app ships), against the kernel run
// on the arrays the in-memory path holds. Bit for bit, because the job runs the
// kernel's own incremental form:
//
//   · created the way the panel creates them, windows wider than the file
//     included, and through the executor in chunks of 1 to 5000 rows;
//   · a file whose profile filters rows out, with rows that have no time, and
//     one with a generated time axis — the sink keeps a row for every row of
//     the file as read, or the join by position would shift;
//   · read by a zoom, joined by position with no side materialized, and with
//     the sink's row numbers equal to the file's;
//   · chains: a moving average of a derivative (a window under the source), a
//     derivative and a formula over a moving average, a moving average of one;
//   · cancel, the memory budget, an edit, a delete and closing the file each
//     drop the sink; a session runs the job again.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { runChunkedJob } = await import(new URL('../src/data/chunk-executor.js', import.meta.url));
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const { computeMovingAverage } = await import(new URL('../src/compute/kernels/moving-average.js', import.meta.url));
const { computeDetrend } = await import(new URL('../src/compute/kernels/detrend.js', import.meta.url));

// ── An app with the Data Tools and derived-variable methods, and no DOM ─────
class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        this.dataToolVariablesByFile = new Map();
        this.derivedByFile = new Map();
        this.messages = [];
        this.plotManager = { files: this.files, updateFileData() {}, plots: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
    }
}
installDataToolsMethods(Harness);
installLazyDataToolsMethods(Harness);
installDerivedMethods(Harness);
Object.assign(Harness.prototype, {
    _renderFilteredTree() {},
    _syncDataTools() {},
    _setOutlierMessage(message, type) { this.messages.push([typeof message === 'function' ? message() : message, type]); },
});

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 5;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 30011;
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    const a = i % 13 === 0 ? '' : String(Math.round((Math.sin(i / 300) * 10 + random() + i / 5000) * 1e4) / 1e4);
    // Near the double range: a running sum overflows to ±∞ and comes back.
    const b = i % 29 === 0 ? (i % 58 === 0 ? '1.5e308' : '-1.6e308') : String(Math.round(random() * 1e6) / 7);
    lines.push(`${(i * 0.01 + (i % 3) * 0.001).toFixed(4)},${a},${b}`);
}
// A file whose profile keeps the rows tagged `keep`, with rows that have no
// time: the rows the lazy queries serve are not the rows of the file.
const filteredLines = ['tag,t,v'];
for (let i = 0; i < 12007; i++) {
    const tag = i % 5 === 2 ? 'drop' : 'keep';
    const t = i % 41 === 7 ? '' : (i * 0.5).toFixed(1);
    const v = i % 11 === 4 ? '' : String(Math.round(Math.cos(i / 70) * 1e5) / 1e3);
    filteredLines.push(`${tag},${t},${v}`);
}
// The last rows are dropped by the filter: the sink ends before the file.
filteredLines.push('drop,9999,1', 'drop,10000,2');
const filteredProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['tag', 't', 'v'],
    headers: [{ name: 'tag' }, { name: 't' }, { name: 'v' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2],
    sampleRows: [],
    timeSource: { ok: true, kind: 'numeric', strategy: 'numeric', sourceIndexes: [1], name: 't' },
    rowFilter: { enabled: true, columnIndex: 0, operator: '==', value: 'keep' },
};
const generatedProfile = {
    ...filteredProfile,
    numericColumnIndexes: [2],
    timeSource: { ok: true, strategy: 'generated-index', name: 'index' },
};

const require = createRequire(import.meta.url);
// One Arrow for the whole process — see test-column-stream.mjs.
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
db.registerFileText('sig.csv', lines.join('\n') + '\n');
db.registerFileText('filtered.csv', filteredLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'sig.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_sinks_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
// The same file as the in-memory path holds it: the rows the lazy queries serve.
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName);
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const concat = (pick) => {
        const out = new Float64Array(chunks.reduce((n, c) => n + c.x.length, 0));
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    const data = structuredClone({ metadata: lazy.metadata, variables: Object.fromEntries(
        Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])) });
    data.variables[lazy.metadata.timeName].data = concat(c => c.x);
    for (const name of names) data.variables[name].data = concat(c => c.yByVar.get(name));
    return data;
}
function app(data) {
    const h = new Harness();
    h.files.set('f', { data });
    return h;
}
async function create(h, sourceName, outputName, config, options = {}) {
    const data = h.files.get('f').data;
    return h._applyLazyDataToolCreateMode({
        fileId: 'f', data, sourceName, sourceVariable: data.variables[sourceName], outputName,
        targetMode: 'create', tool: config.tool, lazy: true,
    }, config, { silent: true, ...options });
}
async function readAll(data, name) {
    const out = [];
    for await (const chunk of streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return Float64Array.from(out);
}
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, the kernel gives ${expected[i]}`);
    }
}
const sinkTables = async () => duck._arrowRowsToObjects(await duck.query(
    "SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '%\\_sink\\_%' ESCAPE '\\'")).map(row => row.table_name).sort();
const pending = (h) => Promise.all([...(h._lazyToolStatsPending || [])]);
// A formula, registered the way the formula editor registers it, so an edit
// upstream recomputes it.
const derive = (hh, data, name, formula) => {
    const result = hh._evaluateDerivedFormula(formula, data);
    const variable = hh._formulaDerivedVariable(name, formula, result);
    data.variables[name] = variable;
    if (!hh.derivedByFile.has('f')) hh.derivedByFile.set('f', new Map());
    hh.derivedByFile.get('f').set(name, { name, formula, variable });
    return variable;
};

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.ok(lazy._duckdb.viewMode, 'the fixture loads as a view, the way a large file does');
assert.equal(eager.variables.t.data.length, ROWS, 'the in-memory copy has every row');
const h = app(lazy);
const eh = app(eager);

// ── Created from the panel ──────────────────────────────────────────────────
for (const [source, window] of [['a', 21], ['a', 500], ['b', 7], ['b', 2], ['a', 100000]]) {
    const name = `ma_${source}_${window}`;
    const result = await create(h, source, name, { tool: 'movingAverage', params: { window } });
    assert.equal(result.name, name, `${name}: created`);
    const variable = lazy.variables[name];
    assert.ok(variable._duckdbExpr && variable._duckdbWindows?.[0]?.sink, `${name}: reads a sink`);
    assert.equal(variable.dataTool.window, window, `${name}: the window it was asked for`);
    assertBitwise(await readAll(lazy, name), computeMovingAverage(eager.variables[source].data, { window }), name);
    assert.ok(Number.isFinite(variable.data[100]), `${name}: the overview is read from the sink`);
}
{
    const params = { method: 'movingAverage', order: 2, window: 101 };
    await create(h, 'a', 'dt_ma', { tool: 'detrend', params });
    const expected = computeDetrend(eager.variables.a.data, null, params);
    assertBitwise(await readAll(lazy, 'dt_ma'), expected.values, 'moving-average detrend');
    assert.equal(lazy.variables.dt_ma.dataTool.fitPoints, expected.fitPoints, 'and its fit points');
}
console.log('lazy sink tools: moving average and moving-average detrend match the kernel bit for bit (windows wider than the file, overflow)');

// ── Through the executor, cut anywhere ──────────────────────────────────────
for (const chunkRows of [1, 777, 5000]) {
    const sink = await duck.createSink(lazy);
    const kernel = h._lazySinkKernel({ tool: 'movingAverage', sourceName: 'a', params: { window: 333 } });
    const progress = [];
    const { rows } = await runChunkedJob({
        data: lazy, sourceNames: ['a'], kernel, sink, chunkRows, onProgress: p => progress.push(p.rows),
    });
    assert.equal(rows, ROWS, `chunks of ${chunkRows}: every row read`);
    assert.ok(progress.length >= Math.min(3, Math.ceil(ROWS / Math.max(chunkRows, 2048))), `chunks of ${chunkRows}: progress per chunk`);
    lazy.variables.cut = { ...lazy.variables.ma_a_21, _duckdbExpr: `"${sink.columns[0].column}"`, _duckdbWindows: [sink.columns[0]] };
    assertBitwise(await readAll(lazy, 'cut'), computeMovingAverage(eager.variables.a.data, { window: 333 }), `chunks of ${chunkRows}`);
    delete lazy.variables.cut;
    await duck.dropSink(lazy, sink.table);
}
console.log('lazy sink tools: the job gives the same doubles in chunks of 1, 777 and 5000 rows');

// ── Read back: zoom, plan, alignment ────────────────────────────────────────
{
    const expected = computeMovingAverage(eager.variables.a.data, { window: 21 });
    const t0 = eager.variables.t.data[12000];
    const t1 = eager.variables.t.data[12100];
    const raw = await duck.getRawColumnsRange(lazy, ['ma_a_21', 'a'], t0, t1, 1e6);
    const from = eager.variables.t.data.findIndex(v => v >= t0);
    assert.equal(raw.x.length, 101, 'a zoom reads every row in it');
    for (let i = 0; i < raw.x.length; i++) {
        assert.ok(same(raw.yByVar.get('ma_a_21')[i], expected[from + i]), `zoomed row ${from + i}`);
        assert.ok(same(raw.yByVar.get('a')[i], eager.variables.a.data[from + i]), `zoomed source row ${from + i}`);
    }
    const plan = duck._arrowRowsToObjects(await duck.query(`EXPLAIN SELECT * FROM ${duck._fromSql(lazy, [lazy.variables.ma_a_21, lazy.variables.ma_b_7])}`))
        .map(row => Object.values(row).join('\n')).join('\n');
    assert.match(plan, /POSITIONAL_SCAN/, 'the file and the sinks are read side by side');
    assert.doesNotMatch(plan, /POSITIONAL_JOIN|ORDER_BY|HASH_JOIN/, 'with nothing materialized and no sort');
    assert.equal(duck._fromSql(lazy, [lazy.variables.a]), lazy._duckdb.tableName, 'a query that reads no sink reads the file as before');
    // The sink's own row numbers are the file's, after the join.
    const sink = lazy.variables.ma_a_21._duckdbWindows[0].sink;
    const rn = lazy._duckdb.sinks.get(sink).rnColumn;
    const [check] = duck._arrowRowsToObjects(await duck.query(`
        SELECT COUNT(*)::BIGINT AS n, COUNT(*) FILTER (WHERE "${rn}" <> rr)::BIGINT AS misplaced
        FROM (SELECT *, ROW_NUMBER() OVER () - 1 AS rr FROM ${duck._rawRelationSql(lazy._duckdb)} POSITIONAL JOIN ${sink})`));
    assert.equal(Number(check.n), ROWS, 'one sink row per file row');
    assert.equal(Number(check.misplaced), 0, 'each in its place');
}
console.log('lazy sink tools: a zoom is exact, and the sink is joined by position without materializing anything');

// ── Chains ──────────────────────────────────────────────────────────────────
{
    await create(h, 'a', 'd_a', { tool: 'derivative', params: { method: 'centered' } });
    const derivative = eh._computeDerivativeValues(eager.variables.a.data, eager, { method: 'centered' }).values;
    await create(h, 'd_a', 'ma_d', { tool: 'movingAverage', params: { window: 15 } });
    assertBitwise(await readAll(lazy, 'ma_d'), computeMovingAverage(derivative, { window: 15 }), 'moving average of a derivative');

    const ma = computeMovingAverage(eager.variables.a.data, { window: 21 });
    await create(h, 'ma_a_21', 'd_ma', { tool: 'derivative', params: { method: 'backward' } });
    eager.variables.ma_a_21 = { ...eager.variables.a, name: 'ma_a_21', data: ma };
    assertBitwise(await readAll(lazy, 'd_ma'), eh._computeDerivativeValues(ma, eager, { method: 'backward' }).values, 'derivative of a moving average');

    const formula = derive(h, lazy, 'f_ma', 'ma_a_21 * 2 - a');
    assert.ok(formula._duckdbExpr && formula._duckdbWindows.some(w => w.sink), 'a formula over a moving average carries its sink');
    assertBitwise(await readAll(lazy, 'f_ma'), Float64Array.from(ma, (v, i) => v * 2 - eager.variables.a.data[i]), 'formula over a moving average');

    await create(h, 'ma_a_21', 'ma_ma', { tool: 'movingAverage', params: { window: 5 } });
    assertBitwise(await readAll(lazy, 'ma_ma'), computeMovingAverage(ma, { window: 5 }), 'moving average of a moving average');
    const both = await duck.getRawColumnsRange(lazy, ['ma_ma', 'ma_a_21', 'b'], eager.variables.t.data[500], eager.variables.t.data[520], 1e6);
    const at = eager.variables.t.data.findIndex(v => v >= eager.variables.t.data[500]);
    for (let i = 0; i < both.x.length; i++) {
        assert.ok(same(both.yByVar.get('ma_a_21')[i], ma[at + i]), `two sinks in one query, row ${at + i}`);
    }
}
console.log('lazy sink tools: chains of moving averages, derivatives and formulas are exact');

// ── Rows the lazy queries do not serve ──────────────────────────────────────
for (const [label, profile] of [['row filter and rows without time', filteredProfile], ['generated time axis', generatedProfile]]) {
    const data = await loadLazy('filtered.csv', profile);
    const reference = await eagerFrom(data);
    const fh = app(data);
    const servedRows = label.startsWith('row') ? filteredLines.slice(1).filter(l => l.startsWith('keep,') && l.split(',')[1] !== '').length
        : filteredLines.slice(1).filter(l => l.startsWith('keep,')).length;
    assert.equal(reference.variables.v.data.length, servedRows, `${label}: the rows served`);
    await create(fh, 'v', 'ma_v', { tool: 'movingAverage', params: { window: 9 } });
    assertBitwise(await readAll(data, 'ma_v'), computeMovingAverage(reference.variables.v.data, { window: 9 }), label);
    const t0 = reference.variables[data.metadata.timeName].data[3000];
    const t1 = reference.variables[data.metadata.timeName].data[3050];
    const raw = await duck.getRawColumnsRange(data, ['ma_v', 'v'], t0, t1, 1e6);
    const expected = computeMovingAverage(reference.variables.v.data, { window: 9 });
    const from = reference.variables[data.metadata.timeName].data.findIndex(v => v >= t0);
    for (let i = 0; i < raw.x.length; i++) {
        assert.ok(same(raw.yByVar.get('ma_v')[i], expected[from + i]), `${label}: zoomed row ${from + i}`);
        assert.ok(same(raw.yByVar.get('v')[i], reference.variables.v.data[from + i]), `${label}: zoomed source row ${from + i}`);
    }
    await duck.release(data);
}
console.log('lazy sink tools: the sink lines up with the file through filtered rows, rows without time and a generated axis');

// ── Cancel, budget, edit, delete, close ─────────────────────────────────────
{
    const before = await sinkTables();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await create(h, 'a', 'never', { tool: 'movingAverage', params: { window: 9 } }, { signal: controller.signal });
    assert.equal(cancelled, null, 'a cancelled job creates nothing');
    assert.equal(lazy.variables.never, undefined, 'no variable');
    assert.deepEqual(await sinkTables(), before, 'and leaves no sink');

    // Cancelled half-way, through the executor.
    const sink = await duck.createSink(lazy);
    const halfway = new AbortController();
    await assert.rejects(runChunkedJob({
        data: lazy, sourceNames: ['a'], sink, chunkRows: 4096, signal: halfway.signal,
        kernel: h._lazySinkKernel({ tool: 'movingAverage', sourceName: 'a', params: { window: 9 } }),
        onProgress: ({ rows }) => { if (rows > 8000) halfway.abort(); },
    }), err => err.name === 'AbortError', 'a job cancelled half-way stops');
    assert.deepEqual(await sinkTables(), before, 'and drops what it wrote');

    // Past the budget: refused while writing (a CSV's size is unknown)…
    duck.sinkBudgetBytes = duck.sinkBudget().used + 1000;
    await assert.rejects(create(h, 'a', 'big', { tool: 'movingAverage', params: { window: 9 } }),
        err => /Results in memory/.test(err.message), 'past the budget, the job stops with an explanation');
    assert.deepEqual(await sinkTables(), before, 'and drops its sink');
    // …and before reading anything when it is known.
    lazy._duckdb.totalRows = ROWS;
    let read = false;
    const stream = duck.streamJobColumns;
    duck.streamJobColumns = function (...args) { read = true; return stream.apply(this, args); };
    await assert.rejects(create(h, 'a', 'big', { tool: 'movingAverage', params: { window: 9 } }), /Results in memory/);
    assert.equal(read, false, 'a file of known size is refused before it is read');
    duck.streamJobColumns = stream;
    delete lazy._duckdb.totalRows;
    duck.sinkBudgetBytes = Infinity;
    assert.ok(h._lazySinkErrorMessage('x', { code: 'SINK_BUDGET', limit: 1048576, used: 0 }).includes('1 MB'), 'the limit is quoted in MB');

    // An edit writes a new sink and drops the old one once nothing reads it;
    // what is built on the output follows it.
    const old = lazy.variables.ma_a_21._duckdbWindows[0].sink;
    await create(h, 'a', 'ma_a_21', { tool: 'movingAverage', params: { window: 31 } });
    // A moving average built on it is a job of its own, run again in the
    // background.
    await pending(h);
    const ma31 = computeMovingAverage(eager.variables.a.data, { window: 31 });
    assertBitwise(await readAll(lazy, 'ma_a_21'), ma31, 'an edited moving average');
    assert.ok(!(await sinkTables()).includes(old), 'the edited output\'s old sink is dropped');
    assertBitwise(await readAll(lazy, 'ma_ma'), computeMovingAverage(ma31, { window: 5 }), 'a moving average built on it follows');
    assertBitwise(await readAll(lazy, 'f_ma'), Float64Array.from(ma31, (v, i) => v * 2 - eager.variables.a.data[i]), 'so does a formula');

    // Edited into a tool written as SQL, under the same name: the sink goes too.
    const switched = lazy.variables.ma_b_7._duckdbWindows[0].sink;
    await create(h, 'b', 'ma_b_7', { tool: 'derivative', params: { method: 'forward' } });
    assert.ok(!lazy.variables.ma_b_7._duckdbWindows.some(w => w.sink), 'the output is SQL now');
    assert.ok(!(await sinkTables()).includes(switched), 'and its old sink is dropped');

    // A delete drops the sink.
    const doomed = lazy.variables.ma_b_2._duckdbWindows[0].sink;
    h._removeDataToolVariable('f', lazy, 'ma_b_2');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(!(await sinkTables()).includes(doomed), 'a deleted output\'s sink is dropped');
}
console.log('lazy sink tools: cancel, the memory budget, an edit and a delete leave no sink behind');

// ── A session runs the job again ────────────────────────────────────────────
{
    const restored = await loadLazy();
    const rh = app(restored);
    rh.dataToolVariablesByFile.set('f', new Map([
        ['ma', { name: 'ma', tool: 'movingAverage', targetMode: 'create', sourceName: 'a', method: null, params: { window: 21 }, replacement: '' }],
        ['d_ma', { name: 'd_ma', tool: 'derivative', targetMode: 'create', sourceName: 'ma', method: 'centered', params: { method: 'centered' }, replacement: '' }],
        ['dt', { name: 'dt', tool: 'detrend', targetMode: 'create', sourceName: 'a', method: 'movingAverage', params: { method: 'movingAverage', order: 2, window: 51 }, replacement: '' }],
    ]));
    rh._reapplyDataToolVariables('f', restored);
    assert.ok(restored.variables.ma && !restored.variables.ma._duckdbExpr, 'the output exists at once, waiting for its job');
    await pending(rh);
    await pending(rh);
    const ma = computeMovingAverage(eager.variables.a.data, { window: 21 });
    assertBitwise(await readAll(restored, 'ma'), ma, 'a moving average restored from a session');
    assertBitwise(await readAll(restored, 'd_ma'), eh._computeDerivativeValues(ma, eager, { method: 'centered' }).values,
        'and the derivative built on it');
    assertBitwise(await readAll(restored, 'dt'), computeDetrend(eager.variables.a.data, null, { method: 'movingAverage', window: 51 }).values,
        'a moving-average detrend restored');

    // Reapplied with nothing changed, the sink is read as it is.
    const table = restored.variables.ma._duckdbWindows[0].sink;
    rh._reapplyDataToolVariables('f', restored);
    await pending(rh);
    assert.equal(restored.variables.ma._duckdbWindows[0].sink, table, 'an unchanged source keeps its sink');

    // Closing the file drops its sinks.
    const own = [...restored._duckdb.sinks.keys()];
    assert.equal(own.length, 2, 'two sinks for the restored file');
    await duck.release(restored);
    const left = await sinkTables();
    assert.ok(own.every(name => !left.includes(name)), 'closing the file drops them');
}
console.log('lazy sink tools: a session runs the job again, and closing the file drops its sinks');

console.log('lazy sink tools: moving averages run over every row of a lazy file, exactly');
