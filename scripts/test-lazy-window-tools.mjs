// The data tools without state — the spike detector, outliers replaced by
// interpolation, the fill of missing samples, the integral bridging holes —
// run over every row of a lazy file, in the chunked executor, and give the
// doubles the in-memory tools give.
//
//   node scripts/test-lazy-window-tools.mjs
//
// A CSV loaded lazily through the app's DuckDbSource on a real DuckDB-WASM
// engine (the Node build of the package the app ships), against the tools
// built on the arrays the in-memory path holds (_buildDataToolResult). Bit for
// bit, with the counts and the notes the panel shows:
//
//   · spikes at every sensitivity, replaced by NaN and by interpolation; hard
//     bounds and IQR replaced by interpolation (IQR by NaN stays SQL); the
//     outlier count;
//   · the fill: the seven methods, gap limits, the ends held or left, on a
//     jittered axis (in time) and on one that goes backwards (on row numbers);
//     the counts and the note on what was left missing;
//   · the integral under 'interpolate': three methods, numeric and index axes,
//     the counts and the note on the span with no data;
//   · through the executor in chunks of 1, 777 and 5000 rows, with the sink
//     lined up with the file;
//   · a file whose profile filters rows out, with rows that have no time, and
//     one with a generated time axis;
//   · an edit that changes the replacement runs the job again; a cancelled job
//     leaves no sink.
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
const { installFilterMethods } = await import(new URL('../src/app/methods/filter-methods.js', import.meta.url));
const { INTERPOLATE_METHODS } = await import(new URL('../src/compute/kernels/interpolate.js', import.meta.url));

// ── An app with the Data Tools and derived methods, and no DOM ──────────────
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
installFilterMethods(Harness);
Object.assign(Harness.prototype, {
    _renderFilteredTree() {},
    _syncDataTools() {},
    _setOutlierMessage(message, type) { this.messages.push([typeof message === 'function' ? message() : message, type]); },
});

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 17;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 20011;
// A 10 ms grid with jitter and a few dropouts; `a` with holes (singles, runs,
// one long run, the first and last rows), spikes (single, in runs, beside a
// hole) and ±∞; `b` with no hole and a few spikes.
const lines = ['t,a,b'];
{
    let time = 0;
    for (let i = 0; i < ROWS; i++) {
        time += (i % 1499 === 700 ? 4 : 1) * 0.01 + (random() - 0.5) * 2e-5;
        let a = Math.sin(i / 37) * 4 + random();
        let hole = i % 211 === 17 || (i > 9000 && i < 9040) || i < 3 || i > ROWS - 3 || (i % 613 >= 300 && i % 613 < 305);
        if (i % 401 === 100 || (i % 401 === 101 && i % 3 === 0)) a = 60 + random() * 5;
        if (i % 401 === 250) { a = -50; }
        if (i % 401 === 251) hole = true;
        if (i % 401 === 252) a = -55;
        if (i % 2003 === 1000) a = 1e308;
        const aText = hole ? '' : (i % 2003 === 1000 ? '1e309' : String(Math.round(a * 1e5) / 1e5));
        let b = Math.cos(i / 90) * 2 + random() * 0.2;
        if (i % 977 === 10) b = 30;
        lines.push(`${time.toFixed(6)},${aText},${String(Math.round(b * 1e5) / 1e5)}`);
    }
}
// An axis that goes backwards once: the fill reads row numbers, not time.
const backwardsLines = ['t,v'];
for (let i = 0; i < 3001; i++) {
    const t = i === 1500 ? 10 : i * 0.5;
    const v = i % 29 === 3 || (i > 2000 && i < 2012) ? '' : String(Math.round(Math.sin(i / 50) * 1e4) / 1e4);
    backwardsLines.push(`${t},${v}`);
}
// A file whose profile keeps the rows tagged `keep`, with rows that have no
// time, and the same file read with a generated axis.
const filteredLines = ['tag,t,v'];
for (let i = 0; i < 6007; i++) {
    const tag = i % 5 === 2 ? 'drop' : 'keep';
    const t = i % 41 === 7 ? '' : (i * 0.5).toFixed(1);
    let v = i % 113 === 4 || (i > 3000 && i < 3020) ? '' : String(Math.round(Math.cos(i / 30) * 1e5) / 1e3);
    if (i % 307 === 50) v = '900';
    filteredLines.push(`${tag},${t},${v}`);
}
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
const generatedProfile = { ...filteredProfile, numericColumnIndexes: [2], timeSource: { ok: true, strategy: 'generated-index', name: 'index' } };

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
db.registerFileText('backwards.csv', backwardsLines.join('\n') + '\n');
db.registerFileText('filtered.csv', filteredLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'sig.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_window_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
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
async function create(h, sourceName, outputName, config) {
    const data = h.files.get('f').data;
    return h._applyLazyDataToolCreateMode({
        fileId: 'f', data, sourceName, sourceVariable: data.variables[sourceName], outputName,
        targetMode: 'create', tool: config.tool, lazy: true,
    }, config, { silent: true });
}
// The in-memory tool, built as the panel builds it.
function expected(eh, eagerData, sourceName, config) {
    const variable = eagerData.variables[sourceName];
    return eh._buildDataToolResult(variable.data, variable, { ...config, sourceName, targetName: 'expected', targetMode: 'create' }, eagerData);
}
async function readAll(data, name) {
    const out = [];
    for await (const chunk of streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return Float64Array.from(out);
}
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expectedValues, label) {
    assert.equal(actual.length, expectedValues.length, `${label}: length`);
    for (let i = 0; i < expectedValues.length; i++) {
        if (!same(actual[i], expectedValues[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, the kernel gives ${expectedValues[i]}`);
    }
}
const text = value => (typeof value === 'function' ? value() : (value || ''));
const tables = async (pattern) => duck._arrowRowsToObjects(await duck.query(
    `SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '${pattern}'`)).map(row => row.table_name);

// A tool created on the lazy file against the in-memory one: values, the
// fields of `dataTool` named, the count and the note.
async function check(h, eh, lazy, eagerData, sourceName, outputName, config, keys, label = outputName) {
    const result = await create(h, sourceName, outputName, config);
    assert.ok(result, `${label}: created`);
    const want = expected(eh, eagerData, sourceName, config);
    assertBitwise(await readAll(lazy, outputName), want.variable.data, label);
    const dataTool = lazy.variables[outputName].dataTool;
    for (const key of keys) assert.ok(same(dataTool[key], want.variable.dataTool[key]), `${label}: dataTool.${key} is ${dataTool[key]}, in memory ${want.variable.dataTool[key]}`);
    assert.equal(result.count, want.count, `${label}: the count the panel reports`);
    assert.equal(text(result.warning), text(want.warning), `${label}: the note the panel shows`);
    return { result, want };
}

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.equal(eager.variables.t.data.length, ROWS, 'the in-memory copy has every row');
const h = app(lazy);
const eh = app(eager);

// ── Outliers ────────────────────────────────────────────────────────────────
{
    let created = 0;
    let withNotes = 0;
    for (const source of ['a', 'b']) {
        for (const sensitivity of [1, 4, 6, 10]) {
            for (const replacement of ['nan', 'interpolate']) {
                const config = { tool: 'removeOutliers', method: 'spike', params: { sensitivity }, replacement };
                const { want } = await check(h, eh, lazy, eager, source, `sp_${source}_${sensitivity}_${replacement}`,
                    config, ['method', 'replacement', 'outlierCount']);
                if (want.count > 0) withNotes++;
                created++;
            }
        }
    }
    assert.ok(withNotes > 8, 'the fixture has spikes the detector finds');
    // Hard bounds and IQR replaced by interpolation run in the executor too;
    // IQR replaced by NaN stays SQL (scripts/test-lazy-data-tools.mjs).
    for (const [method, params] of [['bounds', { lower: -20, upper: 20 }], ['bounds', { lower: null, upper: 3 }], ['iqr', { factor: 1.5 }]]) {
        for (const replacement of ['interpolate', 'nan']) {
            if (method === 'bounds' && replacement === 'nan') continue;
            const config = { tool: 'removeOutliers', method, params, replacement };
            await check(h, eh, lazy, eager, 'a', `o_${method}_${params.lower ?? 'x'}_${replacement}`, config, ['method', 'replacement', 'outlierCount']);
            created++;
        }
    }
    const sinkRun = h.dataToolVariablesByFile.get('f').get('o_iqr_x_interpolate');
    assert.ok(sinkRun.lazySink, 'an interpolating IQR run has a sink');
    assert.ok(!h.dataToolVariablesByFile.get('f').get('o_iqr_x_nan').lazySink, 'an IQR run replacing with NaN is SQL');
    console.log(`lazy window tools: outliers match the in-memory tool bit for bit (${created} runs: spikes at every sensitivity, bounds and IQR, NaN and interpolated)`);
}

// ── The fill ────────────────────────────────────────────────────────────────
{
    const keys = ['method', 'maxGap', 'edges', 'window', 'filledCount', 'filledRuns', 'skippedCount', 'skippedRuns', 'missingCount'];
    let created = 0;
    for (const method of INTERPOLATE_METHODS) {
        for (const [maxGap, edges] of [[0, 'leave'], [0, 'hold'], [10, 'leave'], [3, 'hold']]) {
            const params = { method, maxGap, edges, window: method === 'smooth' ? 41 : 21 };
            const { result, want } = await check(h, eh, lazy, eager, 'a', `fill_${method}_${maxGap}_${edges}`, { tool: 'interpolate', params }, keys);
            assert.ok(result.count > 0 && (maxGap === 0 ? true : text(want.warning)), `fill ${method}: fills something${maxGap ? ', and says what it left' : ''}`);
            created++;
        }
    }
    const axis = await h._lazyAxisSteps(lazy);
    assert.equal(axis.usableAxis, true, 'the jittered axis is finite and never decreases: bridges are drawn in time');
    console.log(`lazy window tools: the fill matches the in-memory tool bit for bit, counts and note included (${created} runs, 7 methods)`);

    // An axis that goes backwards: row numbers, and the note says so.
    const backwards = await loadLazy('backwards.csv');
    const bEager = await eagerFrom(backwards);
    const bh = app(backwards);
    assert.equal((await bh._lazyAxisSteps(backwards)).usableAxis, false, 'an axis that goes backwards is not usable');
    const { want } = await check(bh, app(bEager), backwards, bEager, 'v', 'fill_back', { tool: 'interpolate', params: { method: 'pchip', maxGap: 0, edges: 'leave' } }, keys);
    assert.equal(want.variable.dataTool.filledCount > 0, true, 'and holes were filled');
    assert.match(text(want.warning), /row|fila|ligne|riga|index|índice|indice/i, 'the note says the bridge was drawn on row numbers');
    await duck.release(backwards);
    console.log('lazy window tools: on an axis that goes backwards the fill reads row numbers, as in memory');
}

// ── The integral bridging holes ─────────────────────────────────────────────
{
    const keys = ['method', 'gapPolicy', 'initial', 'negativeDtCount', 'gapCount', 'nanSegmentCount', 'uncoveredTime', 'hasNominalStep'];
    let created = 0;
    for (const method of ['trapezoidal', 'rectangular', 'sum']) {
        for (const initial of [0, 2.5]) {
            for (const source of ['a', 'b']) {
                const params = { method, gapPolicy: 'interpolate', initial };
                const { want } = await check(h, eh, lazy, eager, source, `int_${method}_${initial}_${source}`, { tool: 'integrate', params }, keys);
                if (source === 'a' && method !== 'sum') assert.ok(text(want.warning), `${method} on a: the note on the span with no data`);
                created++;
            }
        }
    }
    const sinkRun = h.dataToolVariablesByFile.get('f').get('int_trapezoidal_0_a');
    assert.ok(sinkRun.lazySink, 'the interpolating integral has a sink');
    assert.ok(sinkRun.lazySink.report.gapCount > 0, 'and found the dropouts of the axis');
    console.log(`lazy window tools: the integral bridging holes matches the in-memory tool bit for bit, counts and note included (${created} runs)`);
}

// ── Through the executor, in chunks ─────────────────────────────────────────
{
    const axis = await h._lazyAxisSteps(lazy);
    const jobs = [
        ['spikes', { tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'interpolate', sourceName: 'a' }],
        ['fill', { tool: 'interpolate', params: { method: 'akima', maxGap: 0, edges: 'hold', window: 21 }, sourceName: 'a' }],
        ['integral', { tool: 'integrate', params: { method: 'trapezoidal', gapPolicy: 'interpolate', initial: 0 }, sourceName: 'a' }],
    ];
    for (const [name, definition] of jobs) {
        const want = expected(eh, eager, 'a', definition).variable.data;
        for (const chunkRows of [1, 777, 5000]) {
            const kernel = h._lazySinkKernel(lazy, definition, { axis });
            const sink = await duck.createSink(lazy);
            const { rows } = await runChunkedJob({ data: lazy, sourceNames: ['a'], kernel, sink, chunkRows, withTime: !!kernel.withTime });
            assert.equal(rows, ROWS, `${name}, chunks of ${chunkRows}: every row read`);
            lazy.variables.zz = { ...lazy.variables.a, _duckdbExpr: `"${sink.columns[0].column}"`, _duckdbWindows: [sink.columns[0]] };
            assertBitwise(await readAll(lazy, 'zz'), want, `${name}, chunks of ${chunkRows}`);
            const [row] = duck._arrowRowsToObjects(await duck.query(`
                SELECT COUNT(*) FILTER (WHERE "${sink.rnColumn}" <> rr)::BIGINT AS misplaced
                FROM (SELECT *, ROW_NUMBER() OVER () - 1 AS rr FROM ${duck._rawRelationSql(lazy._duckdb)} POSITIONAL JOIN ${sink.table})`));
            assert.equal(Number(row.misplaced), 0, `${name}, chunks of ${chunkRows}: the sink lines up with the file`);
            delete lazy.variables.zz;
            await duck.dropSink(lazy, sink.table);
        }
    }
    console.log('lazy window tools: spikes, fill and integral through the executor in chunks of 1, 777 and 5000 rows, the sink lined up');

    // Cancelled part-way: no sink is left.
    const before = await tables('%sink%');
    const kernel = h._lazySinkKernel(lazy, jobs[0][1], { axis });
    const sink = await duck.createSink(lazy);
    const controller = new AbortController();
    await assert.rejects(runChunkedJob({
        data: lazy, sourceNames: ['a'], kernel, sink, chunkRows: 2000, signal: controller.signal,
        onProgress: p => { if (p.rows > 6000) controller.abort(); },
    }), err => err.name === 'AbortError', 'a cancelled job stops');
    assert.deepEqual(await tables('%sink%'), before, 'and drops its sink');
    console.log('lazy window tools: a cancelled job leaves no sink behind');
}

// ── Rows the lazy queries do not serve ──────────────────────────────────────
for (const [label, profile] of [['row filter and rows without time', filteredProfile], ['generated time axis', generatedProfile]]) {
    const data = await loadLazy('filtered.csv', profile);
    const reference = await eagerFrom(data);
    const fh = app(data);
    const rh = app(reference);
    await check(fh, rh, data, reference, 'v', 'sp', { tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'interpolate' }, ['outlierCount'], `${label}: spikes`);
    await check(fh, rh, data, reference, 'v', 'fi', { tool: 'interpolate', params: { method: 'linear', maxGap: 0, edges: 'leave', window: 21 } }, ['filledCount', 'skippedCount'], `${label}: fill`);
    await check(fh, rh, data, reference, 'v', 'ii', { tool: 'integrate', params: { method: 'trapezoidal', gapPolicy: 'interpolate', initial: 0 } }, ['nanSegmentCount', 'gapCount', 'uncoveredTime'], `${label}: integral`);
    await duck.release(data);
}
console.log('lazy window tools: the sink lines up with the file through filtered rows, rows without time and a generated axis');

// ── An edit that changes the replacement is another run ─────────────────────
{
    const nan = { name: 'x', tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'nan', sourceName: 'a' };
    const interpolated = { ...nan, replacement: 'interpolate' };
    assert.notEqual(h._lazySinkSignature(lazy, nan), h._lazySinkSignature(lazy, interpolated), 'NaN and interpolation are different runs');
    const sinks = (await tables('%sink%')).length;
    await create(h, 'a', 'edit', { tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'nan' });
    const first = h.dataToolVariablesByFile.get('f').get('edit').lazySink.table;
    await create(h, 'a', 'edit', { tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'interpolate' });
    const second = h.dataToolVariablesByFile.get('f').get('edit').lazySink.table;
    assert.notEqual(first, second, 'the edit ran the job again');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await tables('%sink%')).length, sinks + 1, 'and the first sink is gone');
    assertBitwise(await readAll(lazy, 'edit'), expected(eh, eager, 'a', interpolated).variable.data, 'the edited output');
    console.log('lazy window tools: an edit that changes the replacement runs the job again and drops the old sink');
}

console.log('lazy window tools: the tools without state run over every row of a lazy file, exactly');
