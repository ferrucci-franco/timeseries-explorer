// Results kept from one session to the next, with the database on disk: a
// job run again over the same file, read the same way, adopts what an earlier
// session computed instead of running — and gives the same values.
//
//   node scripts/test-lazy-kept-results.mjs
//
// The app's DuckDbSource on a real DuckDB-WASM engine (the Node build). Node
// has no OPFS, so the engine is told its database is on disk and each file is
// given its fingerprint by hand; Chromium checks the real thing
// (scripts/e2e-lazy-disk-results.mjs). Checked:
//
//   · a sink job, then the file closed and opened again as another session
//     opens it (new table names), the same job: adopted under the same
//     table, no row read, the variable's values and the panel's counts the
//     same as a run over the file;
//   · a job over a kept result (a moving average of a filled signal) kept and
//     adopted in turn, and a resample and a collapse (lazy datasets);
//   · another file, or the same file read another way, or other settings: run;
//   · a database opened again: the leftovers of the session before dropped, the
//     kept results and their catalog not; a listed table that is gone leaves
//     the catalog;
//   · the room: past it the least recently used kept results go, never one a
//     file reads now; clearing; a kept result continued by a live update is no
//     longer kept;
//   · in memory nothing is kept.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const CsvParser = (await import(new URL('../src/parsers/csv-parser.js', import.meta.url))).default;
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installLazyDatasetMethods } = await import(new URL('../src/app/methods/lazy-dataset-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const { installFilterMethods } = await import(new URL('../src/app/methods/filter-methods.js', import.meta.url));
const { installResampleMethods } = await import(new URL('../src/app/methods/resample-methods.js', import.meta.url));
const { installCollapseMethods } = await import(new URL('../src/app/methods/collapse-methods.js', import.meta.url));

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
// "On disk": what the engine is when its database opened in OPFS.
duck.storage = { kind: 'opfs', path: 'opfs://omv-db-0.db', slot: 0, reason: '' };
duck.keptResultsVersion = 'test-build';

// ── The file ────────────────────────────────────────────────────────────────
let seed = 5;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 9000;
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    const t = (i - (i % 499 === 7 ? 1 : 0)) * 0.01; // a repeated stamp now and then, for the collapse
    const hole = i % 173 === 9 || (i >= 4000 && i < 4030);
    lines.push(`${t.toFixed(2)},${hole ? '' : (Math.sin(i / 60) + random() * 0.1).toFixed(6)},${(random() * 10).toFixed(3)}`);
}
const csvText = `${lines.join('\n')}\n`;
const profile = new CsvParser().inspectSample(new TextEncoder().encode(csvText).buffer);
let tableId = 0;
async function open(fingerprint = 'file-A', text = csvText, csvProfile = profile) {
    const handle = `kept_${tableId}.csv`;
    db.registerFileText(handle, text);
    const data = await duck._loadIntoLegacy(handle, `omv_kr_t_${tableId++}`, { lazy: true, overviewPoints: 200, format: 'csv', csvProfile: structuredClone(csvProfile) });
    // What _parseFile sets for a file of the browser or the desktop.
    data._duckdb.fingerprint = fingerprint;
    data._duckdb.readKey = JSON.stringify(['csv', data._duckdb.csvProfile || null, data._duckdb.projectionSql || '', data._duckdb.readWhere || '', data._duckdb.timeExprSql || '', !!data._duckdb.generatedTime]);
    return data;
}

class App {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        this.dataToolVariablesByFile = new Map();
        this.derivedByFile = new Map();
        this.plotManager = { files: this.files, updateFileData() {}, plots: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
    }
}
installDataToolsMethods(App);
installLazyDataToolsMethods(App);
installLazyDatasetMethods(App);
installDerivedMethods(App);
installFilterMethods(App);
installResampleMethods(App);
installCollapseMethods(App);
Object.assign(App.prototype, { _renderFilteredTree() {}, _syncDataTools() {}, _setOutlierMessage() {}, _setDerivedMessage() {}, _refreshLazyOverviewSoon() {} });
// Every run, adopted or computed.
const runs = [];
const runJob = App.prototype._runLazySinkJob;
App.prototype._runLazySinkJob = async function(data, definition, options) {
    const out = await runJob.call(this, data, definition, options);
    runs.push({ name: definition.name, reused: !!out?.reused });
    return out;
};

const settle = async (app) => {
    for (let k = 0; k < 20 && app._lazyToolStatsPending?.size; k++) await Promise.all([...app._lazyToolStatsPending]);
};
async function create(app, data, { tool, source = 'a', name, method = null, params = {}, replacement = 'nan' }) {
    app.files.set('f', { data });
    const ctx = { fileId: 'f', data, sourceName: source, sourceVariable: data.variables[source], outputName: name, targetMode: 'create', tool, lazy: true };
    const result = await app._applyLazyDataToolCreateMode(ctx, { tool, method, params, replacement }, { silent: true });
    assert.ok(result, `${name}: created`);
    await settle(app);
    return app.dataToolVariablesByFile.get('f').get(name);
}
async function readVariable(data, name) {
    const out = [];
    for await (const chunk of duck.streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return out;
}
const sameDouble = (a, b) => Object.is(a, b) || ((a == null || Number.isNaN(a)) && (b == null || Number.isNaN(b)));
const assertSameValues = (got, want, label) => {
    assert.equal(got.length, want.length, `${label}: length`);
    got.forEach((v, i) => { if (!sameDouble(v, want[i])) assert.fail(`${label}: row ${i} is ${v}, ${want[i]} computed`); });
};
const tableExists = async (name) => Number((await duck.query(`SELECT COUNT(*)::BIGINT AS n FROM information_schema.tables WHERE table_name = '${name}'`)).toArray()[0].toJSON().n) > 0;

const TOOLS = [
    { name: 'ma', tool: 'movingAverage', params: { window: 15 } },
    { name: 'nf', tool: 'interpolate', params: { method: 'pchip', maxGap: 0, edges: 'leave', window: 21 } },
    { name: 'sp', tool: 'removeOutliers', method: 'spike', params: { sensitivity: 5 }, replacement: 'interpolate' },
    { name: 'ff', tool: 'filter', params: { source: 'manual', b: [0.2, 0.3], a: [1, -0.5], mode: 'forward', advance: 0, restartGap: 0, init: 'steady', initState: [] } },
    // Over a kept result: a moving average of the filled signal.
    { name: 'mn', tool: 'movingAverage', source: 'nf', params: { window: 9 } },
];

// ── Session 1: computed and kept ───────────────────────────────────────────
const first = await open();
const app1 = new App();
for (const spec of TOOLS) await create(app1, first, spec);
assert.deepEqual(runs.map(r => r.reused), TOOLS.map(() => false), 'the first session computes every job');
const tables = new Map(TOOLS.map(spec => [spec.name, app1.dataToolVariablesByFile.get('f').get(spec.name).lazySink.table]));
for (const [name, table] of tables) assert.match(table, /^omv_kept_[0-9a-f]{32}$/, `${name}: written under the name of its key`);
const values1 = new Map();
for (const spec of TOOLS) values1.set(spec.name, await readVariable(first, spec.name));
const reports1 = new Map(TOOLS.map(spec => [spec.name, app1.dataToolVariablesByFile.get('f').get(spec.name).lazySink]));
// Closing the file keeps the kept results.
await duck.release(first);
for (const [name, table] of tables) assert.ok(await tableExists(table), `${name}: kept when its file closes`);
console.log(`kept results: ${TOOLS.length} jobs computed and kept, their tables still there once the file is closed`);

// ── Session 2: the same file again, the same jobs, adopted ─────────────────
{
    runs.length = 0;
    const again = await open();
    assert.notEqual(again._duckdb.tableName, first._duckdb?.tableName, 'the file has new table names');
    const app2 = new App();
    for (const spec of TOOLS) await create(app2, again, spec);
    assert.deepEqual(runs.map(r => r.reused), TOOLS.map(() => true), `every job adopted, none run (${JSON.stringify(runs)})`);
    for (const spec of TOOLS) {
        const definition = app2.dataToolVariablesByFile.get('f').get(spec.name);
        assert.equal(definition.lazySink.table, tables.get(spec.name), `${spec.name}: the kept table`);
        assertSameValues(await readVariable(again, spec.name), values1.get(spec.name), `${spec.name} adopted`);
        assert.deepEqual(definition.lazySink.report, reports1.get(spec.name).report, `${spec.name}: the panel's counts`);
        assert.equal(definition.lazySink.rows, reports1.get(spec.name).rows, `${spec.name}: rows`);
    }
    // And they are what a run over the file gives, computed now (in memory).
    duck.storage = { kind: 'memory', path: null, slot: null, reason: 'memoryChosen' };
    const fresh = await open('file-A');
    const app3 = new App();
    for (const spec of TOOLS) {
        await create(app3, fresh, spec);
        assertSameValues(await readVariable(again, spec.name), await readVariable(fresh, spec.name), `${spec.name}: adopted = computed`);
        assert.doesNotMatch(app3.dataToolVariablesByFile.get('f').get(spec.name).lazySink.table, /^omv_kept_[0-9a-f]{32}$/, 'in memory nothing is kept');
    }
    await duck.release(fresh);
    duck.storage = { kind: 'opfs', path: 'opfs://omv-db-0.db', slot: 0, reason: '' };
    await duck.release(again);
    console.log('kept results: the same file opened again adopts every job (a job over a kept result too), the values and counts a run gives');
}

// ── What is not the same: run ──────────────────────────────────────────────
{
    const other = await open('file-B');
    const changedRead = await open('file-A', csvText, { ...profile, headers: profile.headers }); // same read
    runs.length = 0;
    const app = new App();
    await create(app, other, TOOLS[0]);
    assert.deepEqual(runs.map(r => r.reused), [false], 'another file: run');
    runs.length = 0;
    await create(app, changedRead, { ...TOOLS[0], params: { window: 17 } });
    assert.deepEqual(runs.map(r => r.reused), [false], 'other settings: run');
    // The same file, read with another row filter, is another file.
    changedRead._duckdb.readKey = JSON.stringify(['csv', 'another reading']);
    runs.length = 0;
    await create(new App(), changedRead, { ...TOOLS[0], name: 'ma3' });
    assert.deepEqual(runs.map(r => r.reused), [false], 'read another way: run');
    await duck.release(other);
    await duck.release(changedRead);
    console.log('kept results: another file, other settings, another reading: run');
}

// ── Datasets ────────────────────────────────────────────────────────────────
{
    const recipes = [
        ['resample', { tool: 'resample', sourceFileId: 'f', sourceName: '', params: { gridMode: 'step', method: 'mean', step: 0.05, gapPolicy: 'leave' } }],
        ['collapse', { tool: 'collapse', sourceFileId: 'f', sourceName: '', params: { aggregate: 'mean' } }],
    ];
    const datasetRuns = [];
    const runDataset = App.prototype._runLazyDatasetJob;
    App.prototype._runLazyDatasetJob = async function(...args) {
        const out = await runDataset.apply(this, args);
        datasetRuns.push(!!out?.reused);
        return out;
    };
    const compute = (app, data, [kind, recipe]) => (kind === 'resample'
        ? app._computeLazyResampleDataset('f', data, recipe, `${kind}-ds`)
        : app._computeLazyCollapseDataset('f', data, recipe, `${kind}-ds`));
    const one = await open();
    const app = new App();
    app.files.set('f', { data: one });
    const made = [];
    for (const recipe of recipes) made.push(await compute(app, one, recipe));
    const twice = await open();
    const appB = new App();
    appB.files.set('f', { data: twice });
    const again = [];
    for (const recipe of recipes) again.push(await compute(appB, twice, recipe));
    assert.deepEqual(datasetRuns, [false, false, true, true], 'computed once, adopted the second time');
    for (let k = 0; k < recipes.length; k++) {
        const a = made[k].data;
        const b = again[k].data;
        assert.equal(b._duckdb.tableName, a._duckdb.tableName, `${recipes[k][0]}: the kept table`);
        assert.equal(b.metadata.numTimesteps, a.metadata.numTimesteps, `${recipes[k][0]}: rows`);
        for (const name of made[k].names) assertSameValues(await readVariable(b, name), await readVariable(a, name), `${recipes[k][0]} ${name}`);
        assert.deepEqual(JSON.parse(JSON.stringify({ r: again[k].resampled ?? null, c: again[k].result ?? null })),
            JSON.parse(JSON.stringify({ r: made[k].resampled ?? null, c: made[k].result ?? null })), `${recipes[k][0]}: the counts`);
    }
    const keptTables = made.map(d => d.data._duckdb.tableName);
    for (const d of [...made, ...again]) await duck.release(d.data);
    for (const table of keptTables) assert.ok(await tableExists(table), `${table}: a kept dataset stays when its dataset is closed`);
    await duck.release(one);
    await duck.release(twice);
    App.prototype._runLazyDatasetJob = runDataset;
    console.log('kept results: a resample and a collapse adopted the second time, the same rows and counts');
}

// ── A database opened again ────────────────────────────────────────────────
{
    // A leftover of the session before: a table, and a view, named as this
    // session would name its own.
    await duck.query('CREATE TABLE omv_t_99_sink_1 (x DOUBLE)');
    await duck.query('CREATE VIEW omv_t_99 AS SELECT 1 AS x');
    // A listed table that is gone.
    await duck.query(`INSERT INTO omv_kept_results VALUES ('gone', 'omv_kept_gone', '{}', '{}', 1, 8, 0)`);
    await duck._prepareDiskDatabase();
    assert.equal(await tableExists('omv_t_99_sink_1'), false, 'a leftover table is dropped');
    assert.equal(await tableExists('omv_t_99'), false, 'a leftover view is dropped');
    for (const [name, table] of tables) assert.ok(await tableExists(table), `${name}: a kept result stays`);
    const listed = (await duck.query("SELECT key FROM omv_kept_results WHERE key = 'gone'")).toArray();
    assert.equal(listed.length, 0, 'a listed table that is gone leaves the catalog');
    const limit = (await duck.query("SELECT current_setting('memory_limit') AS v")).toArray()[0].toJSON().v;
    assert.match(String(limit), /GiB|MiB/, `the engine's memory is limited (${limit})`);
    console.log(`kept results: a database opened again drops what the session before left, keeps the kept results (memory_limit ${limit})`);
}

// ── The room ────────────────────────────────────────────────────────────────
{
    const size = await duck.keptResultsSize();
    assert.ok(size.count >= TOOLS.length + 2, `${size.count} kept results, ${size.bytes} bytes`);
    // One in use now, the others not; the room a little less than they take.
    const live = await open();
    const app = new App();
    await create(app, live, TOOLS[0]);
    const inUse = app.dataToolVariablesByFile.get('f').get('ma').lazySink.table;
    duck._diskQuota = { quota: 2 * (size.bytes - 1) };
    await duck._trimKeptResults();
    const after = await duck.keptResultsSize();
    assert.ok(after.bytes <= size.bytes - 1 || after.count < size.count, 'some went');
    assert.ok(await tableExists(inUse), 'never one a file reads now');
    // Clearing: everything no file reads goes; the one read is no longer kept.
    await duck.clearKeptResults();
    assert.deepEqual(await duck.keptResultsSize(), { count: 0, bytes: 0 }, 'cleared');
    assert.ok(await tableExists(inUse), 'the one read stays while it is read');
    await duck.release(live);
    assert.equal(await tableExists(inUse), false, 'and goes with its file');
    duck._diskQuota = null;
    console.log('kept results: past their room the least recently used go, never one in use; clearing');
}

// ── A kept result continued by a live update is no longer kept ─────────────
{
    const data = await open();
    const app = new App();
    await create(app, data, TOOLS[0]);
    const table = app.dataToolVariablesByFile.get('f').get('ma').lazySink.table;
    assert.ok(duck._liveSinks.get(table).kept, 'kept');
    await duck.forgetKeptResult(table);
    assert.equal(duck._liveSinks.get(table).kept, false, 'forgotten');
    assert.equal((await duck.query(`SELECT COUNT(*)::BIGINT AS n FROM omv_kept_results WHERE table_name = '${table}'`)).toArray()[0].toJSON().n, 0n, 'not listed');
    await duck.release(data);
    assert.equal(await tableExists(table), false, 'dropped with its file, as any sink');
    // A file that updates live keeps nothing: resumable runs are not kept.
    const liveData = await open();
    const liveApp = new App();
    liveApp.files.set('f', { data: liveData, liveUpdate: { enabled: true } });
    const ctx = { fileId: 'f', data: liveData, sourceName: 'a', sourceVariable: liveData.variables.a, outputName: 'ml', targetMode: 'create', tool: 'movingAverage', lazy: true };
    await liveApp._applyLazyDataToolCreateMode(ctx, { tool: 'movingAverage', params: { window: 15 } }, { silent: true });
    assert.doesNotMatch(liveApp.dataToolVariablesByFile.get('f').get('ml').lazySink.table, /^omv_kept_[0-9a-f]{32}$/, 'a live file keeps nothing');
    await duck.release(liveData);
    console.log('kept results: a result about to be continued stops being kept; a live file keeps nothing');
}

console.log('test-lazy-kept-results: OK');
