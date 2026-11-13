// The Trend analysis of a file in memory-saving (lazy) mode reads every row in
// each segment's range, and reports what the in-memory path reports.
//
//   node scripts/test-lazy-trend.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. Checked:
//
//   · the aggregate path (DuckDbSource.getTrendStats) lands on the kernel's
//     numbers: the counts, the extremes and the span of t′ EXACTLY, the mean,
//     the spread, the line and its metrics to 1e-9 relative, the parabola to
//     1e-6 (the sums are added in another order — docs/any-size-files.md);
//   · every segment of a file is summarised in ONE pass whatever its range:
//     the batched call gives what one call per segment gives;
//   · the value band drops the same rows in SQL as in the kernel, and the
//     counts say how many;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//     over the whole signal and over a selection;
//   · on a generated (row-number) time axis, which has no time column to
//     filter in SQL, the kernel is streamed over the rows instead and matches
//     the in-memory numbers BIT FOR BIT;
//   · the exponential asked for on a segment is the in-memory fit of the rows
//     the band keeps, bit for bit;
//   · a cancelled run stops;
//   · a signal that exists only in the overview is refused, not summarised
//     from the overview.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { installPlotFitLazyMethods } = await import(new URL('../src/plots/methods/fit-lazy-methods.js', import.meta.url));
const { installPlotTrendLazyMethods } = await import(new URL('../src/plots/methods/trend-lazy-methods.js', import.meta.url));
const { trendSteps } = await import(new URL('../src/utils/trend-fit.js', import.meta.url));
const { runPassesOnArrays } = await import(new URL('../src/utils/fit-passes.js', import.meta.url));
const { fitPair } = await import(new URL('../src/utils/regression.js', import.meta.url));
const { rangeIndices, shiftedTime } = await import(new URL('../src/plots/curve-fit-state.js', import.meta.url));
const { defaultTrendSegment } = await import(new URL('../src/plots/trend-state.js', import.meta.url));

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// PlotManager imports Plotly, so the few of its methods the data methods call
// are sliced out of it (as scripts/test-lazy-curve-fit.mjs does).
const managerSource = read('src/plots/plot-manager.js');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const managerMethods = {};
vm.runInNewContext(
    ['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_extractUnit', '_traceName', '_isVisible']
        .map(sliceMethod).join('\n'),
    { proto: managerMethods, console },
);

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        this.plots = new Map();
    }
}
installPlotDataMethods(Harness);
installPlotFitLazyMethods(Harness);
installPlotTrendLazyMethods(Harness);
Object.assign(Harness.prototype, managerMethods);

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 2027;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 50021;
// a: a ramp that bends, with holes and two spikes; b: a decay to an offset,
// with an `inf`.
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    const t = i * 0.01;
    const a = 3 + 0.42 * t - 0.00061 * t * t + (random() - 0.5) * 0.35;
    const b = 1.5 + 9 * Math.exp(-t / 120) + (random() - 0.5) * 0.03;
    let aText = i % 197 === 11 ? '' : String(Math.round(a * 1e6) / 1e6);
    if (i % 7919 === 3) aText = '250';          // a spike above any band
    if (i % 7919 === 4) aText = '-250';         // and one below
    const bText = i === 31337 ? 'inf' : String(Math.round(b * 1e6) / 1e6);
    lines.push(`${t.toFixed(2)},${aText},${bText}`);
}
const CSV = lines.join('\n') + '\n';
// The same rows with no time column of their own: its axis is the row number,
// which SQL cannot filter or shift, so the kernel is streamed instead.
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['t', 'a', 'b'],
    headers: [{ name: 't' }, { name: 'a' }, { name: 'b' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2, 3],
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
db.registerFileText('trend.csv', CSV);
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (csvProfile = null) =>
    duck._loadIntoLegacy('trend.csv', `omv_trend_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });

// The arrays the in-memory path would hold, read from the file itself.
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables)
        .filter(name => name !== lazy.metadata.timeName && lazy._duckdb.source.hasSqlValue(lazy.variables[name]));
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const concat = (pick) => {
        const out = new Float64Array(chunks.reduce((n, c) => n + c.x.length, 0));
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    const data = structuredClone({
        metadata: lazy.metadata,
        variables: Object.fromEntries(Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])),
    });
    data.variables[lazy.metadata.timeName].data = concat(c => c.x);
    for (const name of names) data.variables[name].data = concat(c => c.yByVar.get(name));
    data.metadata.numTimesteps = data.variables[lazy.metadata.timeName].data.length;
    return data;
}
function harness(data, transform = {}, inverted = []) {
    const h = new Harness();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}
const plotFor = (segments) => ({
    mode: 'trend',
    traces: segments.map(s => ({ varName: s.varName, fileId: 'f', axis: 'y' })),
    trend: {
        // Every segment names its file: a segment whose signal is not on the
        // panel falls back to the first one, which would quietly change what
        // is being compared.
        segments: segments.map(s => defaultTrendSegment({ fileId: 'f', ...s })),
        activeSegment: 0,
    },
});

// Every number the table and the drawer read from one segment.
const NUMBERS = ['n', 'nScope', 'nOutliers', 'nMissing', 'mean', 'std', 'meanRmse', 'minY', 'maxY', 'minX', 'maxX'];
const LINEAR = ['b0', 'b1', 'r', 'r2', 'rmse', 'n', 'status'];
const QUAD = ['a', 'b', 'c', 'r2', 'rmse', 'status'];

const rel = (want, factor) => Math.abs(want) * factor + factor;
function assertTrendParity(got, want, label, { exact = false } = {}) {
    // What must agree exactly either way: the rows read, and the extremes,
    // which are comparisons and not sums.
    for (const key of ['n', 'nScope', 'nOutliers', 'nMissing', 'minY', 'maxY']) {
        assert.ok(Object.is(got[key], want[key]), `${label}.${key}: ${got[key]} vs ${want[key]}`);
    }
    for (const key of NUMBERS) {
        if (exact) {
            assert.ok(Object.is(got[key], want[key]), `${label}.${key}: ${got[key]} vs ${want[key]} (bit for bit)`);
            continue;
        }
        if (!Number.isFinite(want[key])) {
            assert.ok(!Number.isFinite(got[key]), `${label}.${key} is not a number either`);
            continue;
        }
        assert.ok(Math.abs(got[key] - want[key]) <= rel(want[key], 1e-9), `${label}.${key}: ${got[key]} vs ${want[key]}`);
    }
    for (const key of LINEAR) {
        const a = got.linear?.[key];
        const b = want.linear?.[key];
        if (typeof b === 'string' || b === null || b === undefined || exact) {
            assert.ok(Object.is(a, b) || a === b, `${label}.linear.${key}: ${a} vs ${b}`);
            continue;
        }
        if (!Number.isFinite(b)) { assert.ok(!Number.isFinite(a), `${label}.linear.${key} is not a number either`); continue; }
        assert.ok(Math.abs(a - b) <= rel(b, 1e-9), `${label}.linear.${key}: ${a} vs ${b}`);
    }
    for (const key of QUAD) {
        const a = got.quadratic?.[key];
        const b = want.quadratic?.[key];
        if (typeof b === 'string' || b === null || b === undefined || exact) {
            assert.ok(Object.is(a, b) || a === b, `${label}.quadratic.${key}: ${a} vs ${b}`);
            continue;
        }
        if (!Number.isFinite(b)) { assert.ok(!Number.isFinite(a), `${label}.quadratic.${key} is not a number either`); continue; }
        assert.ok(Math.abs(a - b) <= rel(b, 1e-6), `${label}.quadratic.${key}: ${a} vs ${b}`);
    }
}

// The in-memory trend of a segment: the rows _trendEagerRows takes, through
// the kernel.
function eagerTrend(h, segment, trace, range, info) {
    const times = h._getTransformedTimeDataForVariable('f', trace.varName);
    const values = h._getTransformedVariableData('f', trace.varName);
    const [start, end] = rangeIndices(times, range[0], range[1]);
    const tPrime = shiftedTime(times.slice(start, end), range[0], info.scale);
    const band = segment.bandOn ? { lower: segment.lower, upper: segment.upper } : null;
    return runPassesOnArrays(trendSteps({ band }), tPrime, values.slice(start, end));
}

// Wait for every lazy segment of a panel to settle, then hand back the
// results. More than one round because a pass can end by asking for something
// the panel needs first (the row count of a generated axis), which the panel
// answers by recomputing.
async function lazyTrends(h, plot, rounds = 4) {
    let results = h._computeTrends(plot);
    for (let round = 0; round < rounds; round++) {
        await h._refreshTrendLazy('p', plot, results);
        results = h._computeTrends(plot);
        if (results.every(r => !r.lazy || r.result || r.lazyStatus !== 'pending')) break;
    }
    return results;
}

const lazyData = await loadLazy();
const eagerData = await eagerFrom(lazyData);
const totalRows = eagerData.metadata.numTimesteps;
assert.equal(totalRows, ROWS, 'the file was read whole');
console.log(`  fixture: ${ROWS} rows, ${(CSV.length / 1e6).toFixed(1)} MB`);

// ── The aggregate path against the kernel ───────────────────────────────────
const TRANSFORMS = [
    { name: 'no transform', transform: {}, inverted: [] },
    { name: 'every transform', transform: { gain: 2.5, yOffset: -1.25, timeShift: '3.5', cropStart: '12.3', cropEnd: '420.77' }, inverted: ['b'] },
];
const CASES = [
    { name: 'a, a stretch', varName: 'a', pick: (lo, hi) => [lo + (hi - lo) * 0.2, lo + (hi - lo) * 0.55] },
    { name: 'a, the whole signal', varName: 'a', rangeFull: true },
    { name: 'a, a stretch with a band', varName: 'a', pick: (lo, hi) => [lo + (hi - lo) * 0.1, lo + (hi - lo) * 0.9], bandOn: true, lower: -5, upper: 60 },
    { name: 'a, a band open above', varName: 'a', pick: (lo, hi) => [lo, lo + (hi - lo) * 0.5], bandOn: true, lower: 0, upper: null },
    { name: 'b, the tail', varName: 'b', pick: (lo, hi) => [lo + (hi - lo) * 0.6, hi] },
    { name: 'b, a short stretch', varName: 'b', pick: (lo) => [lo + 1, lo + 1.5] },
];

for (const { name: tName, transform, inverted } of TRANSFORMS) {
    const hLazy = harness(lazyData, transform, inverted);
    const hEager = harness(eagerData, transform, inverted);
    for (const kase of CASES) {
        const segment = {
            varName: kase.varName,
            fileId: 'f',
            rangeFull: !!kase.rangeFull,
            bandOn: !!kase.bandOn,
            lower: kase.lower ?? null,
            upper: kase.upper ?? null,
        };
        const plot = plotFor([segment]);
        const domain = hEager._trendDomain(plot);
        if (kase.pick) {
            const [x1, x2] = kase.pick(domain.min, domain.max);
            plot.trend.segments[0].x1 = x1;
            plot.trend.segments[0].x2 = x2;
        }
        const eagerPlot = plotFor([segment]);
        eagerPlot.trend.segments[0] = { ...plot.trend.segments[0] };
        const trace = { varName: kase.varName, fileId: 'f', axis: 'y' };
        // The stretch the LAZY panel reads, so both paths are asked the same
        // question. On a lazy file "Full" is the file's own time range (its
        // scan's MIN and MAX), not the extent of the overview.
        const range = hLazy._trendRange(plot, plot.trend.segments[0]);
        const info = hLazy._trendTimeInfo(plot, trace);
        assert.deepEqual(range, hEager._trendRange(eagerPlot, eagerPlot.trend.segments[0]),
            `${tName} / ${kase.name}: the lazy panel reads the same stretch as the in-memory one`);
        const want = eagerTrend(hEager, eagerPlot.trend.segments[0], trace, range, info);

        const [result] = await lazyTrends(hLazy, plot);
        assert.ok(result.result, `${tName} / ${kase.name}: the lazy segment settled (${result.lazyStatus})`);
        assertTrendParity(result.result.trend, want, `${tName} / ${kase.name}`);
        // The curves the pane draws exist as soon as the numbers do.
        assert.ok(result.result.curves.mean?.x?.length === 2, `${tName} / ${kase.name}: a mean line`);
        if (want.linear.status === 'ok') assert.ok(result.result.curves.linear?.x?.length === 2, `${tName} / ${kase.name}: a trend line`);
        if (want.quadratic.status === 'ok') assert.ok(result.result.curves.quadratic?.x?.length > 2, `${tName} / ${kase.name}: a parabola`);
        if (kase.bandOn) {
            assert.ok(want.nOutliers > 0, `${tName} / ${kase.name}: the band had something to drop`);
        }
        // Full means the whole file, not the sampled overview.
        if (kase.rangeFull && tName === 'no transform') {
            assert.equal(result.result.trend.nScope, ROWS, 'Full covers every row of the file');
        }
    }
    console.log(`  aggregate path, ${tName}: ok`);
}

// ── Every segment of a file in one pass ─────────────────────────────────────
{
    const hLazy = harness(lazyData);
    const hOne = harness(lazyData);
    const domain = harness(eagerData)._trendDomain(plotFor([{ varName: 'a' }]));
    const span = domain.max - domain.min;
    const specs = [
        { varName: 'a', x1: domain.min, x2: domain.min + span * 0.3 },
        { varName: 'b', x1: domain.min + span * 0.25, x2: domain.min + span * 0.6, bandOn: true, lower: 2, upper: 9 },
        { varName: 'a', x1: domain.min + span * 0.7, x2: domain.max },
    ];
    const batchedPlot = plotFor(specs);
    const batched = await lazyTrends(hLazy, batchedPlot);
    assert.equal(batched.length, 3, 'three segments');
    // Each segment kept the signal it was given.
    assert.deepEqual(batched.map(r => r.trace.varName), specs.map(s => s.varName), 'the segments read their own signals');
    for (let i = 0; i < specs.length; i++) {
        const alone = await lazyTrends(hOne, plotFor([specs[i]]));
        assertTrendParity(batched[i].result.trend, alone[0].result.trend, `segment ${i + 1} batched`, { exact: true });
    }
    console.log('  one pass for every segment: ok');
}

// ── The file in memory: the panel's own path ────────────────────────────────
// _computeTrends over the arrays, which is what an eager file runs: the same
// kernel, so the same numbers, and the curves the panes draw.
{
    const hEager = harness(eagerData);
    const specs = [
        { varName: 'a', x1: 30, x2: 300 },
        // b falls from ~5.4 to ~2.5 over this stretch: the band cuts its tail.
        { varName: 'b', x1: 100, x2: 260, bandOn: true, lower: 3, upper: 9, expModel: 'exponential-offset' },
    ];
    const plot = plotFor(specs);
    const results = hEager._computeTrends(plot);
    assert.equal(results.length, 2, 'one result per segment');
    for (const r of results) {
        assert.ok(!r.lazy, 'an in-memory file computes in place');
        assert.ok(r.result, 'and has its numbers at once');
        const want = eagerTrend(hEager, r.segment, r.trace, r.result.range, r.info ?? hEager._trendTimeInfo(plot, r.trace));
        assertTrendParity(r.result.trend, want, `in memory / ${r.segment.varName}`, { exact: true });
        // The curves the panes draw: the mean is a line across the stretch.
        assert.equal(r.result.curves.mean.x.length, 2, 'a mean line');
        assert.equal(r.result.curves.linear.x.length, 2, 'a trend line');
        assert.ok(r.result.curves.quadratic.x.length > 2, 'a parabola');
    }
    assert.ok(results[1].result.exp?.status === 'ok', 'the exponential of the segment that asked for one');
    assert.ok(results[1].result.curves.exp?.x.length > 2, 'and its curve');
    assert.ok(results[1].result.trend.nOutliers > 0, 'the band took something out in memory too');
    // Asked again with nothing changed, the numbers come from the cache.
    const again = hEager._computeTrends(plot);
    assert.equal(again[0].result, results[0].result, 'the same result object, not a second computation');
    console.log('  in memory, the panel path: ok');
}

// ── A generated time axis is refused, not answered from the overview ────────
{
    const lazyGen = await loadLazy(generatedProfile);
    assert.equal(duck.timeValueSql(lazyGen), null, 'a generated axis has no time column to shift');
    assert.equal(lazyGen._duckdb.generatedTime, true, 'and it is marked as generated');
    const h = harness(lazyGen);
    const results = await lazyTrends(h, plotFor([{ varName: 'a', rangeFull: true }]));
    assert.equal(results[0].result, null, 'nothing is reported for an axis that numbers the overview');
    assert.equal(results[0].lazyStatus, 'generatedAxis', 'and it says why');
    console.log('  generated axis refused: ok');
}

// ── Without the regression aggregates, the kernel is streamed ───────────────
// Bit for bit the in-memory numbers: the same kernel, fed the file's rows a
// chunk at a time instead of the whole arrays.
{
    const hLazy = harness(lazyData);
    const hEager = harness(eagerData);
    const was = duck._regrCapable;
    duck._regrCapable = false;
    try {
        const domain = hEager._trendDomain(plotFor([{ varName: 'a' }]));
        const span = domain.max - domain.min;
        const specs = [
            { varName: 'a', x1: domain.min + span * 0.15, x2: domain.min + span * 0.75 },
            { varName: 'b', x1: domain.min + span * 0.3, x2: domain.min + span * 0.8, bandOn: true, lower: 2, upper: 9 },
        ];
        for (const spec of specs) {
            const plot = plotFor([spec]);
            const [got] = await lazyTrends(hLazy, plot);
            assert.ok(got.result, `streamed / ${spec.varName}: settled (${got.lazyStatus})`);
            const trace = { varName: spec.varName, fileId: 'f', axis: 'y' };
            const info = hLazy._trendTimeInfo(plot, trace);
            const want = eagerTrend(hEager, plot.trend.segments[0], trace, got.result.range, info);
            assertTrendParity(got.result.trend, want, `streamed / ${spec.varName}`, { exact: true });
        }
    } finally {
        duck._regrCapable = was;
    }
    console.log('  streamed kernel, bit for bit: ok');
}

// ── The exponential asked for on a segment ──────────────────────────────────
{
    const hLazy = harness(lazyData);
    const hEager = harness(eagerData);
    const domain = hEager._trendDomain(plotFor([{ varName: 'b' }]));
    for (const band of [null, { lower: 2, upper: 9 }]) {
        const spec = {
            varName: 'b',
            x1: domain.min,
            x2: domain.min + (domain.max - domain.min) * 0.8,
            expModel: 'exponential-offset',
            bandOn: !!band,
            lower: band?.lower ?? null,
            upper: band?.upper ?? null,
        };
        const plot = plotFor([spec]);
        const eagerPlot = plotFor([spec]);
        const trace = { varName: 'b', fileId: 'f', axis: 'y' };
        const range = hLazy._trendRange(plot, plot.trend.segments[0]);
        const info = hLazy._trendTimeInfo(plot, trace);
        const rows = hEager._trendEagerRows(trace, range);
        const tPrime = shiftedTime(rows.times, range[0], info.scale);
        const wantExp = hEager._trendExpFromRows(eagerPlot.trend.segments[0], band, tPrime, rows.values);
        const [got] = await lazyTrends(hLazy, plot);
        assert.ok(got.result?.exp, `exponential (band ${!!band}): computed`);
        for (const key of ['a', 'b', 'c', 'r2', 'rmse', 'timeConstant', 'n', 'status']) {
            assert.ok(Object.is(got.result.exp[key], wantExp[key]) || got.result.exp[key] === wantExp[key],
                `exponential (band ${!!band}).${key}: ${got.result.exp[key]} vs ${wantExp[key]}`);
        }
        assert.ok(got.result.curves.exp?.x?.length > 2, 'an exponential curve to draw');
        // The fit of the masked rows, for the record: the band really moved it.
        if (band) {
            const unmasked = fitPair('exponential-offset', tPrime, rows.values);
            assert.notEqual(unmasked.a, wantExp.a, 'the band changed the exponential');
        }
    }
    console.log('  exponential on demand, bit for bit: ok');
}

// ── Cancel stops the work ───────────────────────────────────────────────────
{
    const hLazy = harness(lazyData);
    const plot = plotFor([{ varName: 'a', rangeFull: true }]);
    const results = hLazy._computeTrends(plot);
    const pending = hLazy._refreshTrendLazy('p', plot, results);
    // The jobs are registered synchronously; stopping them aborts the queries.
    assert.ok(plot._trendLazyJobs.size > 0, 'a job is in flight');
    hLazy._stopLazyTrends(plot);
    await pending;
    assert.equal(plot._trendLazyJobs.size, 0, 'nothing is left running');
    const after = hLazy._computeTrends(plot);
    assert.equal(after[0].result, null, 'and nothing was painted from the cancelled run');
    console.log('  cancel: ok');
}

// ── A signal that lives only in the overview is refused ─────────────────────
{
    const lazyOverviewOnly = await loadLazy();
    // A variable with no SQL of its own: what a formula the translator cannot
    // write leaves behind (derivedLazyOverviewOnly).
    lazyOverviewOnly.variables.ghost = {
        name: 'ghost',
        kind: 'variable',
        data: new Float64Array([1, 2, 3]),
    };
    const h = harness(lazyOverviewOnly);
    const plot = plotFor([{ varName: 'ghost', rangeFull: true }]);
    const results = await lazyTrends(h, plot);
    assert.equal(results[0].result, null, 'nothing is reported for an overview-only signal');
    assert.equal(results[0].lazyStatus, 'unsupported', 'and it says why');
    console.log('  overview-only signal refused: ok');
}

console.log('lazy trend analysis: ok');
