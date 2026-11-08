// The file tools on a lazy file: a resample and a collapse of repeated
// timestamps become lazy datasets of their own, written to a table a chunk at
// a time; the cross-correlation reads the two columns whole, up to a budget.
// All three give what the in-memory tools give.
//
//   node scripts/test-lazy-datasets.mjs
//
// A CSV loaded lazily through the app's DuckDbSource on a real DuckDB-WASM
// engine (the Node build of the package the app ships), against the datasets
// the in-memory tools build from the arrays. Bit for bit:
//
//   · the resample: every method × grid mode × gap policy, on a jittered axis
//     with dropouts and repeated stamps, on a calendar axis and on a generated
//     one; the grid, every column, the counts the panel reports, the metadata
//     of the dataset;
//   · the collapse: every aggregate; the counts;
//   · the cross-correlation: against the in-memory kernel on the same columns,
//     its lag axis from the step measured over the whole file; the budget
//     refusal;
//   · the dataset is a lazy file: zoomed, given a data tool, read for its CSV,
//     registered under its source with its recipe; closed, its table goes;
//   · the panel's summaries read the axis measured over the whole file;
//   · cancel and the memory budget leave no table behind.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installDataToolsMethods, RESAMPLE_ALL_VARIABLES } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installLazyDatasetMethods, LAZY_XCORR_MAX_ROWS } = await import(new URL('../src/app/methods/lazy-dataset-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const { installFilterMethods } = await import(new URL('../src/app/methods/filter-methods.js', import.meta.url));
const { installResampleMethods } = await import(new URL('../src/app/methods/resample-methods.js', import.meta.url));
const { installCollapseMethods } = await import(new URL('../src/app/methods/collapse-methods.js', import.meta.url));
const { installXcorrMethods } = await import(new URL('../src/app/methods/xcorr-methods.js', import.meta.url));
const { installDerivedDatasetMethods } = await import(new URL('../src/app/methods/derived-dataset-methods.js', import.meta.url));
const { RESAMPLE_GRID_MODES, RESAMPLE_METHODS } = await import(new URL('../src/compute/kernels/regrid.js', import.meta.url));
const { COLLAPSE_AGGREGATES, timestampRuns } = await import(new URL('../src/compute/kernels/collapse-repeats.js', import.meta.url));
const { detectSamplingGaps } = await import(new URL('../src/utils/sampling-gaps.js', import.meta.url));

// ── An app with the data tools, the dataset tools and no DOM ────────────────
class Harness {
    constructor() {
        this.files = new Map();
        this._nextFileId = 1;
        this.plotManager = {
            files: new Map(),
            plots: new Map(),
            activeFileId: null,
            addFile(id, name, data, transform) { this.files.set(id, { name, data, transform, invertedVariables: new Set() }); this.activeFileId = id; },
            updateFileData(id, data) { this.files.get(id).data = data; },
            setActiveFile(id) { if (this.files.has(id)) this.activeFileId = id; },
            removeFile(id) { this.files.delete(id); },
            setFileTransform() {},
            hasTracesForFile() { return false; },
            withActiveFile(id, fn) { return fn(); },
            _extractUnit: description => (String(description || '').match(/\[([^\]]+)\]/) || [])[1] || '',
        };
        this.parser = {
            _detectDataType: () => 'real',
            _isConstantValues: () => false,
            _buildTree: variables => ({ _type: 'root', _children: {}, _variables: { ...variables } }),
        };
        this.derivedByFile = new Map();
        this.dataToolVariablesByFile = new Map();
        this._expandedFileTransforms = new Set();
        this.selectedVariables = new Set();
        this.messages = [];
        this.advancedSettings = {};
    }
    get activeFileId() { return this.plotManager.activeFileId; }
    _defaultFileTransform() { return {}; }
    _normalizeFileTransform(t) { return { ...(t || {}) }; }
    _cloneSerializable(v) { return JSON.parse(JSON.stringify(v)); }
    _fileDisplayName(e) { return `${e.name}${e.extension || ''}`; }
    _renderFilesList() {}
    renderVariablesTree() {}
    _renderDataToolTable() {}
    _renderFilteredTree() {}
    _updateTopBar() {}
    _updateActionButtons() {}
    _clearVariableSelection() {}
    _isDataToolVariablePlotted() { return false; }
    setActiveFile(id) { this.plotManager.setActiveFile(id); }
}
installDataToolsMethods(Harness);
installLazyDataToolsMethods(Harness);
installLazyDatasetMethods(Harness);
installDerivedMethods(Harness);
installFilterMethods(Harness);
installResampleMethods(Harness);
installCollapseMethods(Harness);
installXcorrMethods(Harness);
installDerivedDatasetMethods(Harness);
Harness.prototype._setOutlierMessage = function(message, kind) {
    this.messages.push([typeof message === 'function' ? message() : message, kind]);
};
Harness.prototype._syncDataTools = function() { this.synced = (this.synced || 0) + 1; };
Harness.prototype._renderFilteredTree = function() {};
// Hard bounds read the DOM for their method; the file tools never do.
Harness.prototype._getOutlierDetectorMethod = () => 'spike';
Harness.prototype._getOutlierReplacementMethod = () => 'nan';

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 23;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 20011;
// A jittered 10 ms axis with dropouts and repeated stamps (a Modelica event);
// `a` with holes and a run of them, `b` whole, `c` a parameter-like constant
// kept as a column.
const lines = ['t,a,b'];
const times = [];
{
    let time = 0;
    for (let i = 0; i < ROWS; i++) {
        if (i % 401 === 100 && i > 0) time = times[i - 1];
        else time += (i % 1499 === 700 ? 4 : 1) * 0.01 + (random() - 0.5) * 2e-5;
        times.push(time);
        const a = i % 211 === 17 || (i > 9000 && i < 9040) ? '' : String(Math.round((Math.sin(i / 37) * 4 + random()) * 1e5) / 1e5);
        const b = String(Math.round((Math.cos(i / 90) * 2 + random() * 0.2) * 1e5) / 1e5);
        lines.push(`${time.toFixed(6)},${a},${b}`);
    }
}
// A calendar axis at one second with a repeated stamp.
const calendarLines = ['time,v'];
for (let i = 0; i < 5003; i++) {
    const ms = 1.6e12 + (i - (i % 500 === 7 ? 1 : 0)) * 1000;
    calendarLines.push(`${new Date(ms).toISOString()},${Math.round(Math.sin(i / 20) * 1e4) / 1e4}`);
}
// A file read with a generated axis: the row number is the time.
const plainLines = ['tag,t,v'];
for (let i = 0; i < 4007; i++) plainLines.push(`keep,${(i * 0.5).toFixed(1)},${i % 113 === 4 ? '' : Math.round(Math.cos(i / 30) * 1e5) / 1e3}`);
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['tag', 't', 'v'],
    headers: [{ name: 'tag' }, { name: 't' }, { name: 'v' }],
    dataStartIndex: 1,
    numericColumnIndexes: [2],
    sampleRows: [],
    timeSource: { ok: true, strategy: 'generated-index', name: 'index' },
    rowFilter: { enabled: true, columnIndex: 0, operator: '==', value: 'keep' },
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
db.registerFileText('sig.csv', lines.join('\n') + '\n');
db.registerFileText('calendar.csv', calendarLines.join('\n') + '\n');
db.registerFileText('plain.csv', plainLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'sig.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_ds_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
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
    delete data._duckdb;
    return data;
}
function app(data) {
    const h = new Harness();
    h.plotManager.addFile('f', 'source', data, {});
    h.files.set('f', { name: 'source', extension: '.csv', data });
    return h;
}
async function readAll(data, name) {
    const out = [];
    for await (const chunk of streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return Float64Array.from(out);
}
async function readTime(data) {
    const out = [];
    for await (const chunk of streamColumns(data, [Object.keys(data.variables).find(n => n !== data.metadata.timeName)])) out.push(...chunk.x);
    return Float64Array.from(out);
}
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, in memory ${expected[i]}`);
    }
}
const tables = async (pattern) => duck._arrowRowsToObjects(await duck.query(
    `SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '${pattern}'`)).map(row => row.table_name);

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.equal(eager.variables.t.data.length, ROWS, 'the in-memory copy has every row');
const h = app(lazy);
const eh = app(eager);

// ── The axis, measured over the whole file ──────────────────────────────────
{
    assert.equal(h._lazyDatasetAxisNow(lazy), null, 'not measured yet: the panel waits');
    await Promise.all([...h._lazyAxisStepRuns.values()]);
    const axis = h._lazyDatasetAxisNow(lazy);
    assert.ok(axis, 'then measured');
    assert.equal(axis.rows, ROWS, 'the rows of the file');
    assert.ok(same(axis.first, eager.variables.t.data[0]) && same(axis.last, eager.variables.t.data[ROWS - 1]), 'the ends of the axis');
    const measured = eh._resampleAxisMeasure(eager.variables.t.data, ROWS);
    assert.ok(same(axis.sourceStep, measured.sourceStep), `the median step (${axis.sourceStep} vs ${measured.sourceStep})`);
    const repeats = timestampRuns(eager.variables.t.data).collapsed;
    assert.equal(axis.repeats, repeats, 'the repeated stamps, counted over the file');
    assert.ok(repeats > 40, 'the fixture has repeated stamps');
    const gaps = detectSamplingGaps(eager.variables.t.data);
    assert.deepEqual(axis.gaps, { count: gaps.count, missing: gaps.totalMissing }, 'the dropouts, as the detector counts them');
    assert.ok(gaps.count > 10, 'the fixture has dropouts');
    assert.ok(h.synced > 0, 'the panel was synced when the measurement came in');
    console.log('lazy datasets: the axis is measured over the whole file (rows, ends, step, repeats, gaps)');
}

// ── The resample ────────────────────────────────────────────────────────────
async function checkResample(lh, lazyData, eagerData, recipeParams, sourceName, label, options = {}) {
    const recipe = { tool: 'resample', sourceFileId: 'f', sourceName, params: recipeParams };
    const want = await app(eagerData)._computeResampleDataset('f', eagerData, recipe);
    const got = await lh._computeResampleDataset('f', lazyData, recipe, label);
    assert.ok(got.data._duckdb, `${label}: a lazy dataset`);
    assert.deepEqual(got.names, want.names, `${label}: the same variables`);
    const timeName = want.data.metadata.timeName;
    assert.equal(got.data.metadata.timeName, timeName, `${label}: the time name`);
    assertBitwise(await readTime(got.data), want.data.variables[timeName].data, `${label}: the grid`);
    for (const name of want.names) assertBitwise(await readAll(got.data, name), want.data.variables[name].data, `${label}: ${name}`);
    for (const key of ['emptyCounts', 'bridgedCounts', 'gapLeftCounts']) assert.deepEqual(got.resampled[key], want.resampled[key], `${label}: ${key}`);
    assert.ok(same(got.resampled.step, want.resampled.step), `${label}: step`);
    for (const key of ['numTimesteps', 'numTimevarying', 'timeKind', 'timeDisplayMode']) assert.equal(got.data.metadata[key], want.data.metadata[key], `${label}: metadata.${key}`);
    assert.deepEqual(got.data.metadata.resample, want.data.metadata.resample, `${label}: metadata.resample`);
    assert.ok(same(got.data.metadata.timeStart, want.data.metadata.timeStart) && same(got.data.metadata.timeEnd, want.data.metadata.timeEnd), `${label}: the span`);
    for (const name of want.names) {
        assert.equal(got.data.variables[name].displayName, want.data.variables[name].displayName, `${label}: ${name} label`);
        assert.equal(got.data.variables[name].source, 'resample', `${label}: ${name} source`);
        assert.ok(got.data.variables[name]._duckdbCol, `${label}: ${name} is a column of the table`);
    }
    if (!options.keep) await duck.release(got.data);
    return { got, want };
}
{
    let created = 0;
    for (const method of RESAMPLE_METHODS) {
        for (const gridMode of RESAMPLE_GRID_MODES) {
            if (gridMode === 'complete') continue;   // not offered on a lazy file (the regularity is judged in memory)
            for (const gapPolicy of ['leave', 'bridge']) {
                const params = { gridMode, method, gapPolicy, step: 0.0371, factor: 2.5, count: 1001 };
                await checkResample(h, lazy, eager, params, '', `resample ${method} ${gridMode} ${gapPolicy}`);
                created++;
            }
        }
    }
    await checkResample(h, lazy, eager, { gridMode: 'step', method: 'linear', step: 0.5, gapPolicy: 'leave' }, 'a', 'resample one variable');
    console.log(`lazy datasets: the resample matches the in-memory dataset bit for bit (${created + 1} runs: grid, columns, counts, metadata)`);
    assert.deepEqual(await tables('%dataset%'), [], 'every dataset table released');
}

// A calendar axis and a generated one.
{
    const calendar = await loadLazy('calendar.csv');
    const calendarEager = await eagerFrom(calendar);
    const ch = app(calendar);
    assert.equal(calendar.metadata.timeKind, 'datetime', 'a calendar axis');
    for (const method of ['linear', 'mean']) {
        await checkResample(ch, calendar, calendarEager, { gridMode: 'step', method, step: 2.5, gapPolicy: 'bridge' }, '', `calendar ${method}`);
    }
    const { got } = await checkResample(ch, calendar, calendarEager, { gridMode: 'count', method: 'pchip', count: 777 }, '', 'calendar pchip count', { keep: true });
    assert.equal(got.data.variables.time.timeKind, 'datetime', 'the dataset keeps a calendar axis');
    await duck.release(got.data);
    await duck.release(calendar);

    const plain = await loadLazy('plain.csv', generatedProfile);
    const plainEager = await eagerFrom(plain);
    const ph = app(plain);
    assert.ok(plain._duckdb.generatedTime, 'a generated axis');
    for (const method of ['linear', 'max']) {
        await checkResample(ph, plain, plainEager, { gridMode: 'factor', method, factor: 0.5, gapPolicy: 'leave' }, '', `generated ${method}`);
    }
    await duck.release(plain);
    console.log('lazy datasets: a calendar axis and a generated axis resample as in memory');
}

// ── The collapse ────────────────────────────────────────────────────────────
{
    for (const aggregate of COLLAPSE_AGGREGATES) {
        const recipe = { tool: 'collapse', sourceFileId: 'f', sourceName: '', params: { aggregate } };
        const want = await eh._computeCollapseDataset('f', eager, recipe);
        const got = await h._computeCollapseDataset('f', lazy, recipe, `collapse ${aggregate}`);
        assertBitwise(await readTime(got.data), want.data.variables.t.data, `collapse ${aggregate}: time`);
        for (const name of want.names) assertBitwise(await readAll(got.data, name), want.data.variables[name].data, `collapse ${aggregate}: ${name}`);
        assert.deepEqual(got.result, { groups: want.result.groups, collapsed: want.result.collapsed, aggregate }, `collapse ${aggregate}: the counts`);
        assert.deepEqual(got.data.metadata.collapse, want.data.metadata.collapse, `collapse ${aggregate}: metadata.collapse`);
        assert.deepEqual(got.data.metadata.datetimeRepeats, want.data.metadata.datetimeRepeats, `collapse ${aggregate}: no repeats left`);
        assert.equal(got.data.metadata.numTimesteps, want.data.metadata.numTimesteps, `collapse ${aggregate}: rows`);
        await duck.release(got.data);
    }
    const plan = h._collapsePlan(lazy, RESAMPLE_ALL_VARIABLES);
    const repeats = timestampRuns(eager.variables.t.data).collapsed;
    assert.deepEqual([plan.ok, plan.samples, plan.collapsed, plan.groups], [true, ROWS, repeats, ROWS - repeats], 'the panel counts the repeats over the whole file');
    console.log(`lazy datasets: the collapse matches the in-memory dataset bit for bit (${COLLAPSE_AGGREGATES.length} aggregates)`);
}

// ── The cross-correlation ───────────────────────────────────────────────────
{
    const axis = h._xcorrAxis(lazy);
    const want = eh._xcorrAxis(eager);
    assert.equal(axis.ok, want.ok, 'the lag axis judged the same way');
    assert.ok(same(axis.dt, want.dt) && axis.length === want.length && axis.unit === want.unit, `the same Δt, length and unit (${axis.dt} vs ${want.dt})`);
    for (const [x, y, maxLag] of [['a', 'b', 2], ['b', 'b', 0.5], ['a', 'a', 7]]) {
        const recipe = { tool: 'xcorr', sourceFileId: 'f', sourceName: x, params: { second: y, maxLag, normalization: 'coeff', removeMean: true } };
        const expected = await eh._computeXcorrDataset('f', eager, recipe);
        const got = await h._computeXcorrDataset('f', lazy, recipe);
        assert.ok(!got.data._duckdb, 'the correlation is an in-memory dataset');
        const name = x === y ? 'r_xx' : 'r_xy';
        assertBitwise(got.data.variables.lag.data, expected.data.variables.lag.data, `xcorr ${x}×${y}: lags`);
        assertBitwise(got.data.variables[name].data, expected.data.variables[name].data, `xcorr ${x}×${y}: ${name}`);
        assert.deepEqual(got.data.metadata.xcorr, expected.data.metadata.xcorr, `xcorr ${x}×${y}: metadata`);
    }
    await assert.rejects(h._computeLazyXcorrInputs(lazy, 'a', 'b', LAZY_XCORR_MAX_ROWS + 1), err => err.code === 'dataToolXcorrLazyTooLarge', 'past the budget the file is refused');
    console.log('lazy datasets: the cross-correlation reads the columns whole and matches the in-memory kernel bit for bit');
}

// ── The dataset is a lazy file ──────────────────────────────────────────────
{
    const recipe = { tool: 'resample', sourceFileId: 'f', sourceName: '', params: { gridMode: 'step', method: 'linear', step: 0.05, gapPolicy: 'leave' } };
    const sinksBefore = duck._liveSinks.size;
    const { data } = await h._computeResampleDataset('f', lazy, recipe, 'rs');
    const target = h._registerDerivedDataset(recipe, 'rs', data);
    const entry = h.files.get(target.fileId);
    assert.deepEqual(entry.derivedDataset.tool, 'resample', 'registered with its recipe');
    assert.equal(typeof entry.syntheticBytes, 'function', 'it can write itself out');
    const bytes = await entry.syntheticBytes();
    const text = new TextDecoder().decode(bytes);
    const rowsOut = text.trim().split('\n');
    assert.equal(rowsOut[0], 't,a,b', 'the CSV header');
    assert.equal(rowsOut.length - 1, data.metadata.numTimesteps, 'and every row of the table');
    // "Save as file" writes it a chunk at a time, into a Blob with no limit
    // but the disk's: the same text, and the rows counted as they go.
    assert.equal(typeof entry.syntheticBlob, 'function', 'a lazy dataset writes itself out by chunks');
    const counted = [];
    const blob = await entry.syntheticBlob({ onRows: rows => counted.push(rows) });
    assert.equal(await blob.text(), text, 'the Blob holds the same CSV');
    assert.equal(counted[counted.length - 1], data.metadata.numTimesteps, 'every row counted');
    // Past the size an array of the whole text can take, the bytes refuse and
    // the Blob does not: it was the cap that limited "Save as file".
    const big = { ...data, _duckdb: { ...data._duckdb, totalRows: 1e9 } };
    await assert.rejects(h._lazyDatasetCsvBytes(big), /too large/, 'the bytes are held to a size');

    // Zoomed: a narrow window returns its rows at full resolution.
    const zoom = await duck.getRawColumnsRange(data, ['a', 'b'], 10, 11, 1e6);
    assert.ok(zoom.x.length >= 19 && zoom.x.length <= 21, `a 1 s zoom at 0.05 s has about 20 rows (${zoom.x.length})`);

    // Given a data tool of its own: a derivative over the dataset, exact.
    const dh = app(data);
    const result = await dh._applyLazyDataToolCreateMode({
        fileId: 'f', data, sourceName: 'b', sourceVariable: data.variables.b, outputName: 'db', targetMode: 'create', tool: 'derivative', lazy: true,
    }, { tool: 'derivative', params: { method: 'centered' } }, { silent: true });
    assert.ok(result?.variable?._duckdbExpr, 'a derivative over the dataset is SQL over its table');
    const derivative = await readAll(data, 'db');
    assert.equal(derivative.length, data.metadata.numTimesteps, 'read over every row of the dataset');
    assert.ok(derivative.filter(Number.isFinite).length > derivative.length * 0.9, 'with values (NaN only around the dropouts the resample left)');

    // And a dataset of the dataset: a collapse of a grid has nothing to
    // collapse (the panel refuses it; the compute copies the rows, as in
    // memory); a resample runs.
    const copy = await dh._computeCollapseDataset('f', data, { tool: 'collapse', sourceFileId: 'f', sourceName: '', params: { aggregate: 'mean' } }, 'cc');
    assert.equal(copy.result.collapsed, 0, 'a collapse of a grid has nothing to do');
    assert.equal(copy.data.metadata.numTimesteps, data.metadata.numTimesteps, 'and copies every row');
    await duck.release(copy.data);
    const second = await dh._computeResampleDataset('f', data, { tool: 'resample', sourceFileId: 'f', sourceName: '', params: { gridMode: 'factor', method: 'mean', factor: 0.5 } }, 'rs2');
    assert.ok(second.data._duckdb && second.data.metadata.numTimesteps < data.metadata.numTimesteps, 'a resample of the dataset is a lazy dataset too');
    await duck.release(second.data);

    // Closing the dataset drops its table.
    await duck.release(data);
    assert.equal(duck._liveSinks.size, sinksBefore, 'its table is gone from the budget');
    assert.deepEqual(await tables('%dataset%'), [], 'and from the engine');
    console.log('lazy datasets: a dataset is a lazy file — zoomed, given tools, resampled again, written out, and released with its table');
}

// ── Cancel and the budget leave nothing behind ──────────────────────────────
{
    const before = await tables('%dataset%');
    const controller = new AbortController();
    const recipe = { tool: 'resample', sourceFileId: 'f', sourceName: '', params: { gridMode: 'step', method: 'linear', step: 0.02 } };
    const names = ['a', 'b'];
    const kernelHolder = {};
    const run = h._runLazyDatasetJob(lazy, {
        name: 'cancelled', sourceNames: names, timeColumn: 't', columns: names, estimatedRows: 1000,
        kernel: { push: chunk => { if (!kernelHolder.aborted) { kernelHolder.aborted = true; controller.abort(); } return { t: chunk.x, columns: names.map(n => chunk.yByVar.get(n)) }; }, flush: () => ({ t: new Float64Array(0), columns: [] }) },
    }, { signal: controller.signal });
    assert.equal(await run, null, 'a cancelled job returns nothing');
    assert.deepEqual(await tables('%dataset%'), before, 'and drops its table');
    h.advancedSettings = { lazyResultsMb: 0.001 };
    await assert.rejects(h._computeResampleDataset('f', lazy, recipe, 'big'), err => /big/.test(err.message), 'the budget refuses the job before it starts, naming the dataset');
    h.advancedSettings = {};
    duck.sinkBudgetBytes = Infinity;
    assert.deepEqual(await tables('%dataset%'), before, 'no table behind a refused job');
    console.log('lazy datasets: cancel and the memory budget leave no table behind');
}

console.log('lazy datasets: the file tools run on a lazy file as lazy datasets, exactly');
