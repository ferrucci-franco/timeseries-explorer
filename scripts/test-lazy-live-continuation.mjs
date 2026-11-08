// A sink tool over a lazy file that updates live goes on from where it
// stopped when rows are appended, and gives what a run over the whole grown
// file gives, bit for bit.
//
//   node scripts/test-lazy-live-continuation.mjs
//
// The same CSV, through the app's DuckDbSource on a real DuckDB-WASM engine
// (the Node build of the package the app ships): a first part opened lazily
// with live update on, then rows appended to it the way a live update appends
// them (appendCsvDelta) — one row, a few, thousands — and after each append the
// tool's outputs refreshed as the live update refreshes them
// (_reapplyDataToolVariables). Against: the file with as many rows opened
// afresh and the tool run over it from its first row. Checked, at every
// append:
//
//   · the sink's values and its rows, bit for bit, and the run's counts (the
//     panel's report), for every tool the chunked executor runs: the moving
//     average and its detrend, the forward filter (with a lead and a delay),
//     the integral bridging holes (three methods), the fill (linear,
//     pchip, smoothing, a gap limit), the time between edges, spikes (NaN and
//     interpolated), hard bounds interpolated;
//   · that it was a continuation — the kernel went on, the sink kept its table
//     — and not a run from the first row;
//   · the sink in the file's order after its tail was rewritten (the
//     positional join reads it by position), and read through the variable,
//     across the rows appended;
//   · a hole open at the end of the first part, closed by the appended rows: a
//     fill and an integral bridging it rewrite the rows they had left;
//   · what is not continued, run again from the first row and still right:
//     the zero-phase filter, an IQR run, a source that is a window over its
//     neighbours (a derivative), a file without live update;
//   · a continuation that fails leaves the sink as it was.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const CsvParser = (await import(new URL('../src/parsers/csv-parser.js', import.meta.url))).default;
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const { installFilterMethods } = await import(new URL('../src/app/methods/filter-methods.js', import.meta.url));

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
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();
// The Node build reads registered text, not a browser File: a live update's
// delta (appendCsvDelta registers it as a File) is registered as its text.
duck.registerFile = async function(name, file) {
    db.registerFileText(name, typeof file === 'string' ? file : await file.text());
    this._registered.add(name);
};
duck.unregisterFile = async function(name) {
    try { db.dropFile(name); } catch (_) { /* gone */ }
    this._registered.delete(name);
};

// ── The file ────────────────────────────────────────────────────────────────
let seed = 17;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const TOTAL = 12000;
const FIRST = 6007;
// Appends: one row, a few, a block that closes the hole left open at the end
// of the first part, the rest.
const APPENDS = [1, 37, 2500, TOTAL - FIRST - 1 - 37 - 2500];
const header = 't,a,b';
const lines = [];
for (let i = 0; i < TOTAL; i++) {
    // Holes in `a`: scattered single samples, a run of 40, and a run open at
    // the end of the first part (rows FIRST-12 … FIRST+25).
    const hole = i % 211 === 13 || (i >= 3000 && i < 3040) || (i >= FIRST - 12 && i < FIRST + 26);
    let a = Math.sin(i / 90) + 0.3 * Math.sin(i / 7) + random() * 0.05;
    if (i % 997 === 400) a += 6; // spikes
    const b = Math.round((random() - 0.5) * 200) / 10;
    lines.push(`${(i * 0.01).toFixed(2)},${hole ? '' : a.toFixed(6)},${b}`);
}
const csv = n => `${header}\n${lines.slice(0, n).join('\n')}\n`;
const profile = new CsvParser().inspectSample(new TextEncoder().encode(csv(TOTAL)).buffer);

let tableId = 0;
async function loadLazy(n) {
    const handle = `live_${tableId}.csv`;
    db.registerFileText(handle, csv(n));
    return duck._loadIntoLegacy(handle, `omv_live_${tableId++}`, { lazy: true, overviewPoints: 200, format: 'csv', csvProfile: structuredClone(profile) });
}

// ── The app, enough of it for the data tools on a lazy file ────────────────
class App {
    constructor(data, { live = true } = {}) {
        this.files = new Map([['f', { data, liveUpdate: { enabled: live } }]]);
        this.activeFileId = 'f';
        this.dataToolVariablesByFile = new Map();
        this.derivedByFile = new Map();
        this.plotManager = { files: this.files, updateFileData() {}, plots: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
    }
}
installDataToolsMethods(App);
installLazyDataToolsMethods(App);
installDerivedMethods(App);
installFilterMethods(App);
Object.assign(App.prototype, { _renderFilteredTree() {}, _syncDataTools() {}, _setOutlierMessage() {}, _setDerivedMessage() {}, _refreshLazyOverviewSoon() {} });
const continued = [];
const runContinuation = App.prototype._continueLazySinkTool;
App.prototype._continueLazySinkTool = async function(...args) {
    const out = await runContinuation.apply(this, args);
    continued.push({ name: args[2], out });
    return out;
};

const settle = async (app) => {
    for (let k = 0; k < 20 && app._lazyToolStatsPending?.size; k++) await Promise.all([...app._lazyToolStatsPending]);
};
async function create(app, { tool, source = 'a', name, method = null, params = {}, replacement = 'nan' }) {
    const data = app.files.get('f').data;
    const ctx = { fileId: 'f', data, sourceName: source, sourceVariable: data.variables[source], outputName: name, targetMode: 'create', tool, lazy: true };
    const result = await app._applyLazyDataToolCreateMode(ctx, { tool, method, params, replacement }, { silent: true });
    assert.ok(result, `${name}: created`);
    await settle(app);
    return app.dataToolVariablesByFile.get('f').get(name);
}

// A sink's rows, in its physical order and by rn.
async function sinkRows(table, column) {
    const rnColumn = duck._liveSinks.get(table).rnColumn;
    const physical = (await duck.query(`SELECT ${JSON.stringify(rnColumn)}::DOUBLE AS rn, ${JSON.stringify(column)} AS v FROM ${table}`)).toArray().map(r => r.toJSON());
    return physical;
}
const sameDouble = (a, b) => Object.is(a, b) || ((a == null || Number.isNaN(a)) && (b == null || Number.isNaN(b)));
async function assertSameSink(got, want, label) {
    const g = await sinkRows(got.table, got.column.column);
    const w = await sinkRows(want.table, want.column.column);
    assert.equal(g.length, w.length, `${label}: ${g.length} sink rows, a run over the whole file gives ${w.length}`);
    for (let i = 0; i < g.length; i++) {
        assert.equal(g[i].rn, i, `${label}: the sink is in the file's order (row ${i} holds ${g[i].rn})`);
        if (!sameDouble(g[i].v, w[i].v)) assert.fail(`${label}: row ${i} is ${g[i].v}, a run over the whole file gives ${w[i].v}`);
    }
}
async function readVariable(data, name) {
    const out = [];
    for await (const chunk of duck.streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return out;
}

const TOOLS = [
    { name: 'ma', tool: 'movingAverage', params: { window: 11 } },
    { name: 'ma2', tool: 'movingAverage', params: { window: 400 } },
    { name: 'dt', tool: 'detrend', params: { method: 'movingAverage', window: 21 } },
    { name: 'ff', tool: 'filter', params: { source: 'manual', b: [0.2, 0.3], a: [1, -0.5], mode: 'forward', advance: 0, restartGap: 0, init: 'steady', initState: [] } },
    { name: 'fl', tool: 'filter', params: { source: 'manual', b: [0.25, 0.5, 0.25], a: [1, -0.2, 0.05], mode: 'forward', advance: 2, restartGap: 3, init: 'zero', initState: [] } },
    { name: 'fd', tool: 'filter', params: { source: 'manual', b: [0.5, 0.5], a: [1, 0], mode: 'forward', advance: -3, restartGap: 0, init: 'steady', initState: [] } },
    // The integral is a sink when it bridges holes (the other policies are SQL).
    { name: 'ib', tool: 'integrate', params: { method: 'trapezoidal', gapPolicy: 'interpolate', initial: 0 } },
    { name: 'ir2', tool: 'integrate', params: { method: 'rectangular', gapPolicy: 'interpolate', initial: 2 } },
    { name: 'is', tool: 'integrate', params: { method: 'sum', gapPolicy: 'interpolate', initial: 0 } },
    { name: 'nl', tool: 'interpolate', params: { method: 'linear', maxGap: 0, edges: 'leave', window: 21 } },
    { name: 'np', tool: 'interpolate', params: { method: 'pchip', maxGap: 0, edges: 'leave', window: 21 } },
    { name: 'ns', tool: 'interpolate', params: { method: 'smooth', maxGap: 50, edges: 'nearest', window: 9 } },
    { name: 'ia', tool: 'interarrival', source: 'b', params: { edge: 'both', deadband: 3, output: 'interval', placement: 'hold', rateUnit: 'perSecond' } },
    { name: 'ir', tool: 'interarrival', source: 'b', params: { edge: 'rising', deadband: 1, output: 'rate', placement: 'edge', rateUnit: 'perSecond' } },
    { name: 'sn', tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'nan' },
    { name: 'si', tool: 'removeOutliers', method: 'spike', params: { sensitivity: 6 }, replacement: 'interpolate' },
    { name: 'bi', tool: 'removeOutliers', method: 'bounds', params: { lower: -1, upper: 1.2 }, replacement: 'interpolate' },
];

// ── Continued, at every append ──────────────────────────────────────────────
{
    const live = await loadLazy(FIRST);
    const app = new App(live);
    for (const spec of TOOLS) await create(app, spec);
    for (const spec of TOOLS) assert.ok(app.dataToolVariablesByFile.get('f').get(spec.name)?.lazySink, `${spec.name}: a sink (${JSON.stringify(Object.keys(app.dataToolVariablesByFile.get('f').get(spec.name) || {}))})`);
    const tables = new Map(TOOLS.map(spec => [spec.name, app.dataToolVariablesByFile.get('f').get(spec.name).lazySink.table]));
    let rows = FIRST;
    let checks = 0;
    for (const count of APPENDS) {
        await duck.appendCsvDelta(live, structuredClone(profile), lines.slice(rows, rows + count).join('\n'), {});
        rows += count;
        continued.length = 0;
        app._reapplyDataToolVariables('f', live);
        await settle(app);
        // A fresh file with as many rows, every tool run over it from row 0.
        const fresh = await loadLazy(rows);
        const reference = new App(fresh, { live: false });
        for (const spec of TOOLS) await create(reference, spec);
        for (const spec of TOOLS) {
            const label = `${spec.name} after ${rows} rows`;
            const got = app.dataToolVariablesByFile.get('f').get(spec.name);
            const want = reference.dataToolVariablesByFile.get('f').get(spec.name);
            assert.ok(continued.some(c => c.name === spec.name && c.out === true), `${label}: continued, not run again`);
            assert.equal(got.lazySink.table, tables.get(spec.name), `${label}: the sink kept its table`);
            await assertSameSink(got.lazySink, want.lazySink, label);
            assert.deepEqual(got.lazySink.report, want.lazySink.report, `${label}: the run's counts`);
            assert.equal(got.lazySink.rows, want.lazySink.rows, `${label}: rows read`);
            assert.equal(got.lazySink.fitPoints, want.lazySink.fitPoints, `${label}: fit points`);
            checks++;
        }
        // Read through the variables, across the appended rows (the sink
        // joined by position to the file and its appended rows).
        for (const name of ['ma', 'ib', 'si']) {
            const got = await readVariable(live, name);
            const want = await readVariable(fresh, name);
            assert.equal(got.length, want.length, `${name} read after ${rows} rows: length`);
            got.forEach((v, i) => { if (!sameDouble(v, want[i])) assert.fail(`${name} read after ${rows} rows: row ${i} is ${v}, ${want[i]} over the whole file`); });
        }
        for (const spec of TOOLS) {
            await duck.dropSink(fresh, reference.dataToolVariablesByFile.get('f').get(spec.name).lazySink.table);
        }
        await duck.release(fresh);
    }
    console.log(`live continuation: ${TOOLS.length} tools continued over ${APPENDS.length} appends (1, 37, 2500 and ${APPENDS[3]} rows), bit for bit with a run over the whole file (${checks} sinks)`);

    // ── A continuation that fails leaves the sink as it was ──
    {
        const definition = app.dataToolVariablesByFile.get('f').get('ma');
        const tableBefore = definition.lazySink.table;
        const entry = app._lazySinkResumes.get(definition.lazySink.table);
        const realPush = entry.resume.kernel.push;
        entry.resume.kernel.push = () => { throw new Error('injected failure'); };
        await duck.appendCsvDelta(live, structuredClone(profile), `${(TOTAL * 0.01).toFixed(2)},0.5,1`, {});
        continued.length = 0;
        await app._refreshLazySinkTool('f', 'ma');
        entry.resume.kernel.push = realPush;
        assert.ok(continued.some(c => c.name === 'ma' && c.out === null), 'the failed continuation says so');
        const after = app.dataToolVariablesByFile.get('f').get('ma');
        assert.notEqual(after.lazySink.table, tableBefore, 'a new sink, run from the first row');
        assert.equal(duck.hasSink(tableBefore), false, 'and the old one dropped');
        // It was run again from the first row: a new sink, every row.
        const fresh = await loadLazy(TOTAL);
        await duck.appendCsvDelta(fresh, structuredClone(profile), `${(TOTAL * 0.01).toFixed(2)},0.5,1`, {});
        const reference = new App(fresh, { live: false });
        await create(reference, TOOLS[0]);
        await assertSameSink(after.lazySink, reference.dataToolVariablesByFile.get('f').get('ma').lazySink, 'ma run again after a failed continuation');
        await duck.release(fresh);
        console.log('live continuation: a continuation that fails is rolled back, and the tool runs again from the first row');
    }
    await duck.release(live);
}

// ── A rewrite is one transaction: unseen until it commits, undone by abort ──
{
    const live = await loadLazy(FIRST);
    const app = new App(live);
    const definition = await create(app, TOOLS[0]);
    const before = await sinkRows(definition.lazySink.table, definition.lazySink.column.column);
    const sink = duck._liveSinks.get(definition.lazySink.table);
    const writer = duck.openSinkWriter(live, sink, { fromRow: 100, chunkRows: 1000 });
    // Past one buffer: the tail is deleted and rows inserted, uncommitted.
    const rows = Float64Array.from({ length: 2500 }, (_, i) => 100 + i);
    await writer.write(rows, [new Float64Array(rows.length).fill(42)]);
    const during = await sinkRows(definition.lazySink.table, definition.lazySink.column.column);
    assert.equal(during.length, before.length, 'a query meanwhile sees the sink as it was');
    during.forEach((r, i) => assert.ok(sameDouble(r.v, before[i].v), `row ${i} as it was, meanwhile`));
    await writer.abort();
    const after = await sinkRows(definition.lazySink.table, definition.lazySink.column.column);
    assert.equal(after.length, before.length, 'aborted: every row is there');
    after.forEach((r, i) => assert.ok(sameDouble(r.v, before[i].v), `row ${i} unchanged`));
    assert.equal(sink.rows, before.length, 'and the sink counts them');
    assert.ok(duck.hasSink(definition.lazySink.table), 'an aborted rewrite keeps the sink');
    await duck.release(live);
    console.log('live continuation: a rewrite is unseen until it commits, and an abort rolls it back');
}

// ── Not continued: run again from the first row, and right ─────────────────
{
    const notContinued = [
        { name: 'fz', tool: 'filter', params: { source: 'manual', b: [0.2, 0.3], a: [1, -0.5], mode: 'zeroPhase', advance: 0, restartGap: 0, init: 'steady', initState: [] } },
        { name: 'qi', tool: 'removeOutliers', method: 'iqr', params: { factor: 1.5 }, replacement: 'interpolate' },
        { name: 'dm', tool: 'movingAverage', source: 'da', params: { window: 5 } },
    ];
    const live = await loadLazy(FIRST);
    const app = new App(live);
    await create(app, { name: 'da', tool: 'derivative', params: { method: 'centered' } });
    for (const spec of notContinued) await create(app, spec);
    const tablesBefore = new Map(notContinued.map(spec => [spec.name, app.dataToolVariablesByFile.get('f').get(spec.name).lazySink.table]));
    await duck.appendCsvDelta(live, structuredClone(profile), lines.slice(FIRST, FIRST + 500).join('\n'), {});
    continued.length = 0;
    app._reapplyDataToolVariables('f', live);
    await settle(app);
    const fresh = await loadLazy(FIRST + 500);
    const reference = new App(fresh, { live: false });
    await create(reference, { name: 'da', tool: 'derivative', params: { method: 'centered' } });
    for (const spec of notContinued) await create(reference, spec);
    for (const spec of notContinued) {
        const got = app.dataToolVariablesByFile.get('f').get(spec.name);
        assert.ok(!continued.some(c => c.name === spec.name), `${spec.name}: not continued`);
        assert.notEqual(got.lazySink.table, tablesBefore.get(spec.name), `${spec.name}: a new sink, from the first row`);
        await assertSameSink(got.lazySink, reference.dataToolVariablesByFile.get('f').get(spec.name).lazySink, `${spec.name} run again`);
    }
    // Without live update nothing is kept to continue from.
    const still = await loadLazy(FIRST);
    const quiet = new App(still, { live: false });
    const definition = await create(quiet, TOOLS[0]);
    assert.equal(quiet._lazySinkResumes?.get(definition.lazySink.table), undefined, 'a file without live update keeps no kernel');
    await duck.release(live);
    await duck.release(fresh);
    await duck.release(still);
    console.log('live continuation: the zero-phase filter, an IQR run and a tool over a derivative run again from the first row, and match; a file without live update keeps no state');
}

console.log('test-lazy-live-continuation: OK');
