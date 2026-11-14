// The panel statistics (Σ) of a lazy file count every row of the file, and are
// the statistics the in-memory panel prints.
//
//   node scripts/test-lazy-panel-stats.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. Σ on the first runs _lazyPanelStats
// (stats-lazy-methods.js); on the second, what _showPanelStats runs in memory:
// seriesStats(_getTransformedVariableData(…)). Checked, exactly (Object.is):
// min, max, mean, RMS, the missing count and the total, for
//
//   · a signal with holes and ±∞, and a plain one;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//   · the time axis itself (a 2D plot of a signal against time), alone and
//     beside a signal, on a file's own time column and on a generated axis;
//   · variables of two files at once, and a formula over the file;
//   · a variable on the overview only: not read, reported by the caller;
//   · the rows reported while reading, and cancel stopping the read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { installPlotHistogramLazyMethods } = await import(new URL('../src/plots/methods/histogram-lazy-methods.js', import.meta.url));
const { installPlotStatsLazyMethods } = await import(new URL('../src/plots/methods/stats-lazy-methods.js', import.meta.url));
const { seriesStats, createSeriesStatsAccumulator } = await import(new URL('../src/utils/series-stats.js', import.meta.url));

// ── The panel reads lazy files through the lazy passes ──────────────────────
const managerSource = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
{
    const start = managerSource.indexOf('async _showPanelStats(panelId) {');
    assert.ok(start >= 0, 'panel statistics are built in plot-manager.js');
    const dialog = managerSource.slice(start, managerSource.indexOf('\n    _', start + 10));
    assert.match(dialog, /this\._isLazyStatsEntry\(entry\)/, 'Σ asks which variables live in a lazy file');
    assert.match(dialog, /await this\._readLazyPanelStats\(lazy\)/, 'and reads those from the file');
    assert.match(dialog, /statsLazyOverviewOnly/, 'and names the ones it cannot read, rather than summing the overview');
    const reader = managerSource.slice(managerSource.indexOf('async _readLazyPanelStats(entries) {'));
    assert.match(reader, /this\._lazyPanelStats\(entries, \{\s*signal: controller\.signal/, 'the read carries the Cancel');
    assert.match(reader, /onBusyOverlay\?\.\(\{ title: i18n\.t\('statsLazyComputing'\), token \}\)/, 'and the rows are counted on screen');
}

// The kernel fed in pieces is the kernel fed whole.
{
    const values = Float64Array.from({ length: 1001 }, (_, i) => (i % 97 === 5 ? NaN : i % 211 === 9 ? Infinity : Math.sin(i) * 1e3 + i / 7));
    const whole = seriesStats(values);
    for (const size of [1, 7, 100, 1000, 5000]) {
        const acc = createSeriesStatsAccumulator();
        for (let at = 0; at < values.length; at += size) acc.add(values.subarray(at, at + size));
        const pieces = acc.result();
        for (const key of Object.keys(whole)) assert.ok(Object.is(pieces[key], whole[key]), `chunks of ${size}: ${key}`);
    }
    assert.equal(createSeriesStatsAccumulator().result(), null, 'nothing fed, nothing to describe');
}

// PlotManager imports Plotly, so the few of its methods the data methods call
// are sliced out of it (as scripts/test-lazy-histogram.mjs does).
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const managerMethods = {};
vm.runInNewContext(['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_extractUnit', '_traceName'].map(sliceMethod).join('\n'), { proto: managerMethods, console });

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
    }
}
installPlotDataMethods(Harness);
installPlotHistogramLazyMethods(Harness);
installPlotStatsLazyMethods(Harness);
Object.assign(Harness.prototype, managerMethods);

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 41;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 40009;
// A signal with holes, ±∞ and a far tail; a second one on another scale.
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    let a = Math.exp(random() * 2) + Math.sin(i / 300);
    if (i % 997 === 3) a = 40 + random();
    const aText = i % 131 === 7 ? '' : (i % 4999 === 11 ? 'inf' : (i % 7919 === 13 ? '-inf' : String(Math.round(a * 1e6) / 1e6)));
    const b = String(Math.round((random() - 0.5) * 2000) / 100);
    lines.push(`${(i * 0.01).toFixed(2)},${aText},${b}`);
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
db.registerFileText('s.csv', lines.join('\n') + '\n');
db.registerFileText('s2.csv', lines.slice(0, 15001).join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 's.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_stats_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
// Every row of the lazy file, as the arrays an in-memory load holds.
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName && lazy._duckdb.source.hasSqlValue(lazy.variables[name]));
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
    data.metadata.numTimesteps = data.variables[lazy.metadata.timeName].data.length;
    return data;
}
function harness(files, transform = {}, inverted = []) {
    const h = new Harness();
    for (const [id, data] of Object.entries(files)) h.files.set(id, { data, transform, invertedVariables: new Set(inverted) });
    return h;
}

// What _showPanelStats computes in memory, and over the file.
const inMemory = (h, entries) => entries.map(({ fileId, varName }) => seriesStats(h._getTransformedVariableData(fileId, varName)));
async function overFile(h, entries, options = {}) {
    for (const entry of entries) assert.equal(h._isLazyStatsEntry(entry), true, `${entry.varName} lives in a lazy file`);
    const got = await h._lazyPanelStats(entries, options);
    return entries.map(entry => got.get(entry));
}
function assertSameStats(got, want, label) {
    assert.equal(got.length, want.length, `${label}: rows`);
    got.forEach((stats, i) => {
        assert.ok(stats && want[i], `${label}: row ${i} has statistics`);
        for (const key of ['min', 'max', 'mean', 'rms', 'missing', 'total']) {
            assert.ok(Object.is(stats[key], want[i][key]), `${label}: row ${i} ${key} is ${stats[key]}, in memory ${want[i][key]}`);
        }
    });
}

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
const timeName = lazy.metadata.timeName;
assert.ok(lazy.variables.a.data.length < ROWS / 10, 'what is in memory is an overview');
assert.equal(eager.variables.a.data.length, ROWS, 'the in-memory copy has every row');

// ── The overview would have been wrong ──────────────────────────────────────
{
    const lh = harness({ f: lazy });
    const fromOverview = seriesStats(lh._getTransformedVariableData('f', 'a'));
    const [want] = inMemory(harness({ f: eager }), [{ fileId: 'f', varName: 'a' }]);
    assert.notEqual(fromOverview.total, want.total, 'the overview counts other rows');
    assert.ok(!Object.is(fromOverview.mean, want.mean), 'and gives another mean: the defect this closes');
}

// ── Signals and the time axis, with and without every transform ─────────────
{
    let checks = 0;
    for (const [label, transform, inverted] of [
        ['no transform', {}, []],
        ['crop, shift, gain, offset, sign', { gain: 2.5, yOffset: -3, timeShift: 7, cropStart: 40, cropEnd: 330 }, ['b']],
        ['a crop past the ends, a negative gain', { gain: -0.75, yOffset: 1e6, cropStart: -50, cropEnd: 1e9 }, ['a']],
    ]) {
        const lh = harness({ f: lazy }, transform, inverted);
        const eh = harness({ f: eager }, transform, inverted);
        for (const names of [['a'], ['b'], ['a', 'b'], [timeName], [timeName, 'a'], ['a', 'a']]) {
            const entries = names.map(varName => ({ fileId: 'f', varName }));
            assertSameStats(await overFile(lh, entries), inMemory(eh, entries), `${label}, ${names.join(' + ')}`);
            checks++;
        }
    }
    const [a] = inMemory(harness({ f: eager }), [{ fileId: 'f', varName: 'a' }]);
    assert.ok(a.missing > 0 && a.total === ROWS, 'the holes are counted, and every row');
    console.log(`lazy panel stats: min, max, mean, RMS, missing and total are the in-memory ones (${checks} panels: signals, the time axis, with and without every transform)`);
}

// ── Two files, a formula over the file, a variable on the overview only ─────
{
    const other = await loadLazy('s2.csv');
    const otherEager = await eagerFrom(other);
    const lh = harness({ f: lazy, g: other });
    const eh = harness({ f: eager, g: otherEager });
    const entries = [{ fileId: 'f', varName: 'a' }, { fileId: 'g', varName: 'b' }, { fileId: 'f', varName: 'b' }, { fileId: 'g', varName: timeName }];
    assertSameStats(await overFile(lh, entries), inMemory(eh, entries), 'two files');

    lazy.variables.twice = { name: 'twice', description: '', kind: 'variable', dataType: 'real', data: new Float64Array(lazy.variables.a.data.length), _duckdbExpr: '(try_cast("a" AS DOUBLE) * 2)' };
    eager.variables.twice = { ...eager.variables.a, name: 'twice', data: Float64Array.from(eager.variables.a.data, v => v * 2) };
    const tw = [{ fileId: 'f', varName: 'twice' }];
    assert.equal(lh._lazyStatsEntryHasSource(tw[0]), true, 'a formula over the file has an exact source');
    assertSameStats(await overFile(lh, tw), inMemory(eh, tw), 'a formula over the file');

    lazy.variables.overviewOnly = { name: 'overviewOnly', description: '', kind: 'variable', data: new Float64Array(lazy.variables.a.data.length) };
    const mixed = [{ fileId: 'f', varName: 'overviewOnly' }, { fileId: 'f', varName: 'a' }];
    assert.equal(lh._lazyStatsEntryHasSource(mixed[0]), false, 'a variable on the overview only has no exact source');
    const got = await lh._lazyPanelStats(mixed);
    assert.equal(got.has(mixed[0]), false, 'it is not read (the panel names it instead)');
    assertSameStats([got.get(mixed[1])], inMemory(harness({ f: eager }), [mixed[1]]), 'the rest of the panel still is');

    delete lazy.variables.twice;
    delete lazy.variables.overviewOnly;
    delete eager.variables.twice;
    await duck.release(other);
    console.log('lazy panel stats: variables of two files, a formula over the file, and a variable on the overview only left out');
}

// ── A generated axis: the row is the time ───────────────────────────────────
{
    const generated = await loadLazy('s.csv', generatedProfile);
    const generatedEager = await eagerFrom(generated);
    const transform = { gain: 3, timeShift: -2, cropStart: 100, cropEnd: 30000.5 };
    for (const t of [{}, transform]) {
        const lh = harness({ f: generated }, t);
        const eh = harness({ f: generatedEager }, t);
        assert.ok(lh._isGeneratedIndexTime('f'), 'the axis is the row number');
        const entries = [{ fileId: 'f', varName: 'a' }, { fileId: 'f', varName: generated.metadata.timeName }];
        assertSameStats(await overFile(lh, entries), inMemory(eh, entries), `generated axis, ${JSON.stringify(t)}`);
    }
    await duck.release(generated);
    console.log('lazy panel stats: on a generated axis, the signal and the row-number axis');
}

// ── Rows reported; cancel stops the read ────────────────────────────────────
{
    const lh = harness({ f: lazy });
    const entries = [{ fileId: 'f', varName: 'a' }];
    let lastRows = 0;
    await lh._lazyPanelStats(entries, { onRows: rows => { lastRows = rows; } });
    assert.equal(lastRows, ROWS, 'the rows read are reported, up to every row of the file');

    const controller = new AbortController();
    let reported = 0;
    await assert.rejects(
        lh._lazyPanelStats(entries, { signal: controller.signal, onRows: () => { reported++; controller.abort(); } }),
        err => err?.name === 'AbortError',
        'a cancel stops the read with an AbortError',
    );
    assert.equal(reported, 1, 'and no chunk is read after it (nor any result kept from the one before)');
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(lh._lazyPanelStats(entries, { signal: aborted.signal }), err => err?.name === 'AbortError', 'one cancelled before it starts reads nothing');
    console.log('lazy panel stats: the rows read are reported, and Cancel stops the read');
}

await duck.release(lazy);
console.log('lazy panel stats: ok');
