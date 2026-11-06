// The histogram of a lazy file counts every row of the file, and its bars are
// the bars the in-memory histogram draws.
//
//   node scripts/test-lazy-histogram.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. The lazy passes (histogram-lazy-methods.js)
// run on the first; on the second, the in-memory path: _histogramSamplesForTrace
// (taken from histogram-methods.js as it is) and the kernel of
// src/utils/histogram.js. Checked, exactly:
//
//   · the finite stats (rows in range, finite, invalid, min, max, quartiles)
//     and every count, underflow and overflow, for every bin mode, an
//     automatic and a manual value range, with the whole file and with a
//     selection;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//   · past the quartile limit, the in-memory kernel's stride sample (the limit
//     lowered for the test), and the extra pass that counts;
//   · several traces of one file read in one stream, and a trace of another;
//   · a variable with no exact source is refused; a data tool's output (SQL
//     over the file) is not;
//   · a generated axis (row numbers) read whole;
//   · cancel stops the passes;
//   · the selection's domain reaches the file's ends, not the overview's.
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
const histogram = await import(new URL('../src/utils/histogram.js', import.meta.url));
const {
    countHistogramBins,
    histogramFiniteStats,
    resolveHistogramEdges,
    HISTOGRAM_AUTO_MAX_BINS,
    HISTOGRAM_MANUAL_MAX_BINS,
} = histogram;

// The in-memory sampler, as the app has it.
const histogramSource = readFileSync(new URL('../src/plots/methods/histogram-methods.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const samplerStart = histogramSource.indexOf('proto._histogramSamplesForTrace = function');
const samplerEnd = histogramSource.indexOf('\nproto.', samplerStart + 1);
assert.ok(samplerStart >= 0 && samplerEnd > samplerStart, 'the in-memory sampler is present');
const sampler = {};
vm.runInNewContext(histogramSource.slice(samplerStart, samplerEnd), { proto: sampler });
// And the recompute reads the lazy passes.
assert.match(histogramSource, /this\._lazyHistogramStats\(lazy, range/, 'the panel reads lazy traces through the lazy passes');
assert.match(histogramSource, /this\._lazyHistogramCounts\(/, 'and counts them there');
assert.doesNotMatch(histogramSource, /histogramLazyUnsupported'\)\}`\);\n\s*\} else \{\n\s*eager\.push/, 'a lazy trace is no longer refused outright');

// PlotManager imports Plotly, so the few of its methods the data methods call
// are sliced out of it (as scripts/test-lazy-csv-export.mjs does).
const managerSource = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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
Object.assign(Harness.prototype, managerMethods);
Harness.prototype._histogramSamplesForTrace = sampler._histogramSamplesForTrace;

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 29;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 40009;
// A skewed signal with holes, ±∞ and a far tail; a second one on another scale.
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    let a = Math.exp(random() * 2) + Math.sin(i / 300);
    if (i % 997 === 3) a = 40 + random();
    const aText = i % 131 === 7 ? '' : (i % 4999 === 11 ? 'inf' : String(Math.round(a * 1e6) / 1e6));
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
db.registerFileText('h.csv', lines.join('\n') + '\n');
db.registerFileText('h2.csv', lines.slice(0, 15001).join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'h.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_hist_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
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

// The in-memory histogram of `traces` over `range`, step by step as
// _recomputeHistogram makes it.
function eagerHistogram(h, traces, range, options) {
    const per = traces.map(trace => {
        const samples = h._histogramSamplesForTrace(trace, range);
        return { trace, samples, stat: histogramFiniteStats(samples) };
    });
    const spec = resolveHistogramEdges(per.map(p => p.stat), { ...options, autoMaxBins: HISTOGRAM_AUTO_MAX_BINS, manualMaxBins: HISTOGRAM_MANUAL_MAX_BINS });
    const counts = spec.ok ? per.map(p => (p.stat.nFinite ? countHistogramBins(p.samples, spec) : null)) : [];
    return { stats: per.map(p => p.stat), spec, counts };
}
async function lazyHistogram(h, traces, range, options, extra = {}) {
    const stats = await h._lazyHistogramStats(traces, range, { needQuartiles: options.binMode === 'auto', ...extra });
    const spec = resolveHistogramEdges(traces.map(t => stats.get(t).stat), { ...options, autoMaxBins: HISTOGRAM_AUTO_MAX_BINS, manualMaxBins: HISTOGRAM_MANUAL_MAX_BINS });
    let counts = [];
    if (spec.ok) {
        const entries = traces.filter(t => stats.get(t).stat.nFinite).map(t => ({ trace: t, finite: stats.get(t).finite }));
        const counted = await h._lazyHistogramCounts(entries, range, spec, extra);
        counts = traces.map(t => counted.get(t) || null);
    }
    return { stats: traces.map(t => stats.get(t).stat), spec, counts };
}
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertSameHistogram(got, want, label, { quartiles = true } = {}) {
    assert.equal(got.stats.length, want.stats.length, `${label}: traces`);
    got.stats.forEach((stat, i) => {
        const keys = ['nScope', 'nFinite', 'nInvalid', 'min', 'max', 'quartilesApprox', ...(quartiles ? ['q1', 'q3'] : [])];
        for (const key of keys) assert.ok(same(stat[key], want.stats[i][key]), `${label}: trace ${i} ${key} is ${stat[key]}, in memory ${want.stats[i][key]}`);
    });
    assert.equal(got.spec.ok, want.spec.ok, `${label}: edges resolved alike`);
    if (!want.spec.ok) return;
    for (const key of ['k', 'lo', 'hi', 'width', 'method']) assert.ok(same(got.spec[key], want.spec[key]), `${label}: ${key} is ${got.spec[key]}, in memory ${want.spec[key]}`);
    got.counts.forEach((counted, i) => {
        const expected = want.counts[i];
        if (!expected) { assert.equal(counted, null, `${label}: trace ${i} has nothing to count`); return; }
        assert.deepEqual(Array.from(counted.counts), Array.from(expected.counts), `${label}: trace ${i} counts`);
        for (const key of ['underflow', 'overflow', 'nBinned']) assert.equal(counted[key], expected[key], `${label}: trace ${i} ${key}`);
    });
}

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.ok(lazy.variables.a.data.length < ROWS / 10, 'what is in memory is an overview');
assert.equal(eager.variables.a.data.length, ROWS, 'the in-memory copy has every row');

const binOptions = [
    { binMode: 'auto' },
    { binMode: 'count', binCount: 37 },
    { binMode: 'width', binWidth: 0.25 },
    { binMode: 'auto', valueRangeMode: 'manual', valueMin: 1, valueMax: 6 },
    { binMode: 'count', binCount: 10, valueRangeMode: 'manual', valueMin: -3, valueMax: 3 },
];

// ── Every bin mode, the whole file and a selection ──────────────────────────
{
    let checks = 0;
    for (const [label, transform, inverted] of [
        ['no transform', {}, []],
        ['crop, shift, gain, offset, sign', { gain: 2.5, yOffset: -3, timeShift: 7, cropStart: 40, cropEnd: 330 }, ['b']],
    ]) {
        const lh = harness({ f: lazy }, transform, inverted);
        const eh = harness({ f: eager }, transform, inverted);
        // A bound between samples, bounds ON samples (100.00 is a row; with the
        // shift of 7 it is row 93.00 + 7), and one past both ends.
        for (const range of [null, [57.123, 211.5], [100, 211.5], [-1000, 1e6]]) {
            for (const options of binOptions) {
                for (const traces of [[{ fileId: 'f', varName: 'a' }], [{ fileId: 'f', varName: 'a' }, { fileId: 'f', varName: 'b' }]]) {
                    const want = eagerHistogram(eh, traces, range, options);
                    const got = await lazyHistogram(lh, traces, range, options);
                    assertSameHistogram(got, want, `${label}, range ${JSON.stringify(range)}, ${JSON.stringify(options)}, ${traces.length} trace(s)`);
                    checks++;
                }
            }
        }
    }
    console.log(`lazy histogram: stats, edges and counts are the in-memory ones (${checks} histograms: 5 bin modes, 4 ranges, with and without every transform)`);
}

// ── Past the quartile limit: the stride sample, and a pass that counts ──────
{
    assert.equal(histogram.HISTOGRAM_EXACT_QUANTILE_MAX_N, 2_000_000, 'the limit the app runs with');
    // Over 40 009 rows the real limit is never reached, so the lazy module is
    // loaded again with the limit lowered — it is one line of the module — and
    // held to the in-memory kernel run with the same `maxExactQuantileN`.
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omv-hist-'));
    const original = readFileSync(new URL('../src/plots/methods/histogram-lazy-methods.js', import.meta.url), 'utf8');
    assert.ok(original.includes('const cap = HISTOGRAM_EXACT_QUANTILE_MAX_N;'), 'the limit is one line of the module');
    const root = new URL('../src/', import.meta.url).href;
    async function lowered(cap) {
        const file = path.join(dir, `histogram-lazy-${cap}.mjs`);
        writeFileSync(file, original
            .replace('const cap = HISTOGRAM_EXACT_QUANTILE_MAX_N;', `const cap = ${cap};`)
            .replace("from '../../data/column-stream.js'", `from '${root}data/column-stream.js'`)
            .replace("from '../../utils/histogram.js'", `from '${root}utils/histogram.js'`));
        const { installPlotHistogramLazyMethods: install } = await import(`file://${file}`);
        class Lowered { constructor() { this.files = new Map(); this.activeFileId = 'f'; } }
        installPlotDataMethods(Lowered);
        install(Lowered);
        Object.assign(Lowered.prototype, managerMethods);
        const h = new Lowered();
        h.files.set('f', { data: lazy, transform: {}, invertedVariables: new Set() });
        return h;
    }
    const eh = harness({ f: eager });
    const inMemory = (traces, range, cap, options = { binMode: 'auto' }) => {
        const samples = traces.map(trace => eh._histogramSamplesForTrace(trace, range));
        const stats = samples.map(values => histogramFiniteStats(values, { maxExactQuantileN: cap }));
        const spec = resolveHistogramEdges(stats, { ...options, autoMaxBins: HISTOGRAM_AUTO_MAX_BINS, manualMaxBins: HISTOGRAM_MANUAL_MAX_BINS });
        return { stats, spec, counts: samples.map(values => countHistogramBins(values, spec)) };
    };
    let rowsReported = 0;
    const counting = { onRows: () => { rowsReported++; } };
    const both = [{ fileId: 'f', varName: 'a' }, { fileId: 'f', varName: 'b' }];
    const h5000 = await lowered(5000);
    for (const range of [null, [11.5, 377.25]]) {
        const want = inMemory(both, range, 5000);
        assert.ok(want.stats.every(stat => stat.quartilesApprox), 'past the lowered limit the kernel samples');
        assertSameHistogram(await lazyHistogram(h5000, both, range, { binMode: 'auto' }, counting), want, `stride sample, range ${JSON.stringify(range)}`);
        // Without an automatic bin count there is no stride pass, and the
        // counting pass still runs.
        for (const options of [{ binMode: 'count', binCount: 40 }, { binMode: 'count', binCount: 40, valueRangeMode: 'manual', valueMin: 1, valueMax: 4 }]) {
            const want = inMemory(both, range, 5000, options);
            if (options.valueRangeMode) assert.ok(want.counts.some(c => c.underflow > 0) && want.counts.some(c => c.overflow > 0), 'a manual range leaves values out on both sides');
            assertSameHistogram(await lazyHistogram(h5000, both, range, options, counting), want, `counting pass, range ${JSON.stringify(range)}, ${JSON.stringify(options)}`, { quartiles: false });
        }
    }
    // The limit itself: exactly at it the quartiles are exact, one past it sampled.
    const range = [100, 211.5];
    const one = [{ fileId: 'f', varName: 'a' }];
    const n = histogramFiniteStats(eh._histogramSamplesForTrace(one[0], range)).nFinite;
    for (const cap of [n, n - 1]) {
        const want = inMemory(one, range, cap);
        assert.equal(want.stats[0].quartilesApprox, cap < n, `the kernel at a limit of ${cap} for ${n} finite values`);
        assertSameHistogram(await lazyHistogram(await lowered(cap), one, range, { binMode: 'auto' }), want, `a limit of ${cap} for ${n} finite values`);
    }
    assert.ok(rowsReported > 0, 'the passes report the rows they read');
    rmSync(dir, { recursive: true, force: true });
    console.log('lazy histogram: past the quartile limit, the stride sample and the counting pass match the in-memory kernel, at the limit and one past it');
}

// ── Two files, a refused variable, a data tool's output ─────────────────────
{
    const other = await loadLazy('h2.csv');
    const otherEager = await eagerFrom(other);
    const lh = harness({ f: lazy, g: other });
    const eh = harness({ f: eager, g: otherEager });
    const traces = [{ fileId: 'f', varName: 'a' }, { fileId: 'g', varName: 'b' }, { fileId: 'f', varName: 'b' }];
    for (const options of binOptions) {
        assertSameHistogram(await lazyHistogram(lh, traces, null, options), eagerHistogram(eh, traces, null, options), `two files, ${JSON.stringify(options)}`);
    }

    lazy.variables.overviewOnly = { name: 'overviewOnly', description: '', kind: 'variable', data: new Float64Array(lazy.variables.a.data.length) };
    assert.equal(lh._lazyHistogramTraceHasSource({ fileId: 'f', varName: 'overviewOnly' }), false, 'a variable on the overview only has no exact source');
    assert.equal(lh._lazyHistogramTraceHasSource({ fileId: 'f', varName: 'a' }), true, 'a column of the file has');
    delete lazy.variables.overviewOnly;

    // A formula over the file is SQL: histogrammed exactly too.
    lazy.variables.twice = { name: 'twice', description: '', kind: 'variable', dataType: 'real', data: new Float64Array(lazy.variables.a.data.length), _duckdbExpr: '(try_cast("a" AS DOUBLE) * 2)' };
    eager.variables.twice = { ...eager.variables.a, name: 'twice', data: Float64Array.from(eager.variables.a.data, v => v * 2) };
    assert.equal(lh._lazyHistogramTraceHasSource({ fileId: 'f', varName: 'twice' }), true, 'a formula over the file has an exact source');
    const tw = [{ fileId: 'f', varName: 'twice' }];
    assertSameHistogram(await lazyHistogram(lh, tw, [3, 300], { binMode: 'auto' }), eagerHistogram(eh, tw, [3, 300], { binMode: 'auto' }), 'a formula over the file');
    delete lazy.variables.twice;
    delete eager.variables.twice;
    await duck.release(other);
    console.log('lazy histogram: traces of two files, a formula over the file, and a variable with no exact source refused');
}

// ── A generated axis: the row is the time ───────────────────────────────────
{
    const generated = await loadLazy('h.csv', generatedProfile);
    const generatedEager = await eagerFrom(generated);
    const lh = harness({ f: generated });
    const eh = harness({ f: generatedEager });
    assert.ok(lh._isGeneratedIndexTime('f'), 'the axis is the row number');
    const traces = [{ fileId: 'f', varName: 'a' }];
    for (const range of [null, [1000, 30000.5]]) {
        for (const options of binOptions.slice(0, 3)) {
            assertSameHistogram(await lazyHistogram(lh, traces, range, options), eagerHistogram(eh, traces, range, options), `generated axis, range ${JSON.stringify(range)}, ${JSON.stringify(options)}`);
        }
    }
    await duck.release(generated);
    console.log('lazy histogram: a generated axis is read whole, each row at its index');
}

// ── Cancel, and the domain of the selection ─────────────────────────────────
{
    const lh = harness({ f: lazy });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(lh._lazyHistogramStats([{ fileId: 'f', varName: 'a' }], null, { signal: controller.signal }),
        err => err.name === 'AbortError', 'a cancelled pass stops');
    const extent = lh._lazyHistogramTimeExtent('f');
    assert.deepEqual(Array.from(extent), [eager.variables.t.data[0], eager.variables.t.data[ROWS - 1]], 'the selection reaches the ends of the file');
    const shifted = harness({ f: lazy }, { timeShift: 7 })._lazyHistogramTimeExtent('f');
    assert.ok(same(shifted[0], eager.variables.t.data[0] + 7), 'shifted with the file');
    console.log('lazy histogram: cancel stops the passes, and the selection spans the whole file');
}

console.log('lazy histogram: every row of a lazy file is counted, as in memory');
