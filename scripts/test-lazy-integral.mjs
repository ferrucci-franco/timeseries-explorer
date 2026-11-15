// The Integral analysis of a lazy file reads every row in its range, on any
// time axis, and gives the in-memory totals bit for bit.
//
//   node scripts/test-lazy-integral.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as
// the arrays the in-memory path holds. The in-memory side runs the panel's own
// code, sliced out of src/plots/methods/integral-methods.js
// (_integralSeriesForTrace, _integralKernelParams, _integralEagerGroups) and
// fed to computeDefiniteIntegral as _recomputeIntegral does; the lazy side is
// _lazyIntegralResults (src/plots/methods/integral-lazy-methods.js). Checked,
// with Object.is on every number of every result:
//
//   · a calendar axis, a numeric axis and a row-number (generated) axis;
//   · total and grouped by day / week / month, over the whole file and over
//     a selection whose edges fall between samples;
//   · every missing-data policy, both methods, the trailing period, the
//     incomplete-ends trim, and 'discard the day for all signals' across two
//     signals;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//   · in chunks of a few thousand rows, and with the step median kept to a
//     few hundred steps, so the histogram and its further passes over the
//     steps run (src/utils/step-median.js); a NaN run longer than the rows a
//     pass holds is bridged without holding it;
//   · the streams stop early once the selection's rows are read; their bounds
//     come from the rows in memory with no query, and when those are not rows
//     of the stream (or there is none before the selection) the file is asked;
//   · Cancel (the signal) stops a run; an abort the run did not ask for (a
//     query interrupted by someone else, the run's signal untouched) starts
//     the run again in the panel and never shows a partial result.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { installPlotIntegralLazyMethods, createSliceRouter } = await import(new URL('../src/plots/methods/integral-lazy-methods.js', import.meta.url));
const { installPlotAnalysisBusyMethods } = await import(new URL('../src/plots/methods/analysis-busy-methods.js', import.meta.url));
const kernels = await import(new URL('../src/compute/kernels/definite-integral.js', import.meta.url));
const { computeDefiniteIntegral, collectMissingDays, calendarPeriodWindows } = kernels;
const { timeBaseForAxis } = await import(new URL('../src/utils/integral-presentation.js', import.meta.url));

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// PlotManager and integral-methods.js import Plotly, so the methods the paths
// need are sliced out of them (as scripts/test-lazy-curve-fit.mjs does).
const managerSource = read('src/plots/plot-manager.js');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const integralSource = read('src/plots/methods/integral-methods.js');
function sliceProto(name) {
    const start = integralSource.indexOf(`\nproto.${name} = `);
    assert.ok(start >= 0, `${name} is present`);
    const end = integralSource.indexOf('\n};\n', start);
    return integralSource.slice(start + 1, end + 3);
}
const sliced = {};
vm.runInNewContext([
    ...['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_extractUnit', '_traceName'].map(sliceMethod),
    ...['_integralSeriesForTrace', '_integralKernelParams', '_integralEagerGroups', '_runLazyIntegral'].map(sliceProto),
].join('\n'), {
    proto: sliced,
    console,
    computeDefiniteIntegral,
    text: (key) => key,
    i18n: { formatNumber: (n) => String(n) },
});

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
    }
}
installPlotDataMethods(Harness);
installPlotIntegralLazyMethods(Harness);
installPlotAnalysisBusyMethods(Harness);
Object.assign(Harness.prototype, sliced);

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 385;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 24007;
const STEP_MS = 60000;
const START = Date.UTC(2024, 2, 4, 6, 17, 0);
// One-minute samples over ~17 days: empty cells, an `inf`, a run of empty
// cells longer than a pass holds (BRIDGE_HOLD_ROWS: 4096), missing rows (a
// two-hour gap and single dropped rows), a second signal on another scale.
const calendar = ['time,a,b'];
const numeric = ['t,a,b'];
const plain = ['a,b'];
let t = START;
for (let i = 0; i < ROWS; i++) {
    t += STEP_MS;
    if (i === 9000) t += 2 * 3600000;
    if (i % 997 === 3) t += STEP_MS;
    const hour = ((t / 3600000) % 24 + 24) % 24;
    const a = 10 + 6 * Math.sin((hour / 24) * 2 * Math.PI) + random() * 2;
    const empty = i % 131 === 7 || (i > 15000 && i < 20000);
    const aText = empty ? '' : (i === 4321 ? 'inf' : String(Math.round(a * 1e6) / 1e6));
    const bText = i % 503 === 11 ? '' : String(Math.round((random() - 0.5) * 2000) / 100);
    calendar.push(`${new Date(t).toISOString()},${aText},${bText}`);
    numeric.push(`${((t - START) / 1000 / 7).toFixed(3)},${aText},${bText}`);
    plain.push(`${aText},${bText}`);
}
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['a', 'b'],
    headers: [{ name: 'a' }, { name: 'b' }],
    dataStartIndex: 1,
    numericColumnIndexes: [0, 1],
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
db.registerFileText('cal.csv', calendar.join('\n') + '\n');
db.registerFileText('num.csv', numeric.join('\n') + '\n');
db.registerFileText('gen.csv', plain.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle, csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_int_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
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
    if (lazy.metadata.timeName && data.variables[lazy.metadata.timeName]) data.variables[lazy.metadata.timeName].data = concat(c => c.x);
    for (const name of names) data.variables[name].data = concat(c => c.yByVar.get(name));
    data.metadata.numTimesteps = concat(c => c.x).length;
    return data;
}
function harness(data, transform = {}, inverted = []) {
    const h = new Harness();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}

// Every number compared with Object.is (NaN equals NaN, 0 ≠ −0); arrays and
// objects key by key.
let compared = 0;
function assertSame(got, want, label) {
    if (typeof want === 'number' || typeof got === 'number') {
        assert.ok(Object.is(got, want), `${label}: ${got}, in memory ${want}`);
        compared++;
        return;
    }
    if (want && typeof want === 'object') {
        assert.ok(got && typeof got === 'object', `${label}: missing`);
        const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
        for (const key of keys) assertSame(got[key], want[key], `${label}.${key}`);
        return;
    }
    assert.equal(got, want, label);
}

function candidatesOf(h, names) {
    const kind = h._canonicalFftKind('f');
    return names.map((varName, traceIndex) => ({
        trace: { fileId: 'f', varName },
        traceIndex,
        name: varName,
        base: timeBaseForAxis(kind, h._timeUnitLabel('f')),
    }));
}

// What _recomputeIntegral computes for in-memory traces.
function eagerIntegral(h, names, state, range, groupWindows) {
    const candidates = candidatesOf(h, names).map(candidate => {
        const selected = h._integralSeriesForTrace(candidate.trace, range);
        return { ...candidate, times: selected.times, values: selected.values };
    });
    let shared = null;
    if (state.missingPolicy === 'discard-day-all') {
        const union = new Set();
        for (const candidate of candidates) {
            if (candidate.base.kind !== 'datetime') continue;
            const params = h._integralKernelParams(state, candidate, range, null);
            for (const day of collectMissingDays(candidate.values, params.time, params.options).days) union.add(day);
        }
        shared = [...union];
    }
    return candidates.map(candidate => {
        const params = h._integralKernelParams(state, candidate, range, shared);
        const result = computeDefiniteIntegral(candidate.values, params.time, params.options);
        return {
            result,
            groups: groupWindows ? h._integralEagerGroups(state, candidate, groupWindows, shared, result) : null,
        };
    });
}

async function lazyIntegral(h, names, state, range, groupWindows, options = {}) {
    const candidates = candidatesOf(h, names);
    const out = await h._lazyIntegralResults(candidates, { state, range, groupWindows, eagerHoleDays: [], ...options });
    return candidates.map(candidate => out.byTrace.get(candidate.trace));
}

const baseState = {
    method: 'trapezoidal',
    missingPolicy: 'zero',
    discardIncompleteEnds: false,
    extendLastSample: false,
};
function domainOf(h) {
    const times = h._getTransformedTimeDataForVariable('f', 'a');
    let lo = Infinity, hi = -Infinity;
    for (const v of times) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
}

// ── The slice router ────────────────────────────────────────────────────────
{
    // The rows lowerBound − 1 … upperBound of each window, chunk by chunk.
    const times = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const windows = [[2.5, 4], [4, 4], [4.5, 4.6], [8.5, 20]];
    const want = windows.map(([lo, hi]) => {
        let start = times.findIndex(x => x >= lo);
        if (start < 0) start = times.length;
        let end = times.findIndex(x => x > hi);
        if (end < 0) end = times.length;
        return times.slice(Math.max(0, start - 1), Math.min(times.length, end + 1));
    });
    for (const size of [1, 2, 3, 10]) {
        const got = windows.map(() => []);
        const done = windows.map(() => false);
        const router = createSliceRouter(windows);
        let last = NaN;
        for (let at = 0; at < times.length; at += size) {
            const chunk = Float64Array.from(times.slice(at, at + size));
            router.route(chunk,
                (k, a, b) => got[k].push(...chunk.subarray(a, b)),
                (k) => got[k].push(last),
                (k) => { done[k] = true; });
            last = chunk[chunk.length - 1];
        }
        router.close((k) => { done[k] = true; });
        assert.deepEqual(got, want, `the router cuts the in-memory slices (chunks of ${size})`);
        assert.ok(done.every(Boolean), 'and closes every window');
    }
}

// ── Lazy against in memory ──────────────────────────────────────────────────
const AXES = [
    {
        name: 'calendar axis', handle: 'cal.csv', profile: null, calendar: true,
        transforms: [
            { name: 'no transform', transform: {}, inverted: [] },
            { name: 'every transform', transform: { gain: 2.5, yOffset: -1.25, timeShift: '00:20:00', cropStart: String(START + 86400000 * 1.3), cropEnd: String(START + 86400000 * 15.2) }, inverted: ['b'] },
        ],
    },
    {
        name: 'numeric axis', handle: 'num.csv', profile: null, calendar: false,
        transforms: [
            { name: 'no transform', transform: {}, inverted: [] },
            { name: 'every transform', transform: { gain: -0.75, yOffset: 3, timeShift: '12.5', cropStart: '1234.5', cropEnd: '190000.25' }, inverted: ['a'] },
        ],
    },
    {
        name: 'row-number axis', handle: 'gen.csv', profile: generatedProfile, calendar: false,
        transforms: [
            { name: 'no transform', transform: {}, inverted: [] },
            { name: 'every transform', transform: { gain: 1.5, yOffset: 0.5, cropStart: '211', cropEnd: '23001' }, inverted: ['b'] },
        ],
    },
];
const STATES = [
    { ...baseState },
    { ...baseState, method: 'rectangular' },
    { ...baseState, missingPolicy: 'interpolate' },
    { ...baseState, missingPolicy: 'interpolate', extendLastSample: true },
    { ...baseState, missingPolicy: 'discard-day-own', discardIncompleteEnds: true },
    { ...baseState, missingPolicy: 'discard-day-all', extendLastSample: true, discardIncompleteEnds: true },
];
// Small chunks, and a step median kept to 300 steps: its histogram and its
// further passes over the steps.
const STREAM = { chunkRows: 5003, collectLimit: 300 };

let runs = 0;
for (const axis of AXES) {
    const lazy = await loadLazy(axis.handle, axis.profile);
    const eager = await eagerFrom(lazy);
    assert.ok(lazy.variables.a.data.length < eager.variables.a.data.length / 10, `${axis.name}: what is in memory is an overview`);
    for (const { name, transform, inverted } of axis.transforms) {
        const hl = harness(lazy, transform, inverted);
        const he = harness(eager, transform, inverted);
        const kind = he._canonicalFftKind('f');
        assert.equal(kind, axis.calendar ? 'datetime' : (axis.handle === 'gen.csv' ? kind : 'numeric'), `${axis.name}: the axis kind`);
        const domain = domainOf(he);
        const span = domain[1] - domain[0];
        const selection = [domain[0] + span * 0.137, domain[0] + span * 0.861];
        for (const range of [null, selection]) {
            const groupings = axis.calendar ? ['none', 'day', 'week', 'month'] : ['none'];
            for (const groupBy of groupings) {
                const [lo, hi] = range || domain;
                const built = groupBy === 'none' ? null : calendarPeriodWindows(lo, hi, groupBy, { clip: !!range });
                const windows = built?.ok ? built.windows : null;
                for (const state of STATES) {
                    if (groupBy !== 'none' && state.method === 'rectangular') continue;
                    const label = `${axis.name}, ${name}, ${range ? 'selection' : 'whole file'}, group ${groupBy}, ${JSON.stringify(state)}`;
                    const want = eagerIntegral(he, ['a', 'b'], state, range, windows);
                    const got = await lazyIntegral(hl, ['a', 'b'], state, range, windows, STREAM);
                    assertSame(got, want, label);
                    runs++;
                }
            }
        }
        // The default stream (big chunks, every step kept up to the limit).
        const want = eagerIntegral(he, ['a', 'b'], { ...baseState, missingPolicy: 'interpolate' }, selection, null);
        const got = await lazyIntegral(hl, ['a', 'b'], { ...baseState, missingPolicy: 'interpolate' }, selection, null);
        assertSame(got, want, `${axis.name}, ${name}: default chunks`);
        assert.ok(want[0].result.ok && want[0].result.value !== 0, `${axis.name}, ${name}: a real total`);
        if (axis.calendar && !transform.cropStart) {
            assert.ok(want[0].result.hasNominalStep && want[0].result.gapCount > 0, `${axis.name}: the gap scan found the missing rows`);
            assert.ok(want[0].result.nanSegmentCount > 4096, `${axis.name}: and the long run of empty cells`);
        }
    }
}

// ── The streams ─────────────────────────────────────────────────────────────
{
    const lazy = await loadLazy('cal.csv');
    const h = harness(lazy);
    const eager = harness(await eagerFrom(lazy));
    const domain = domainOf(eager);
    // A selection near the start: the stream stops once the row after it is read.
    const range = [domain[0] + 3600000 * 5.5, domain[0] + 3600000 * 30.25];
    let rows = 0;
    let passes = 0;
    const got = await lazyIntegral(h, ['a'], baseState, range, null, {
        chunkRows: 1000,
        onProgress: (p) => { rows = p.rows; passes = p.pass; },
    });
    assertSame(got, eagerIntegral(eager, ['a'], baseState, range, null), 'a short selection');
    assert.equal(passes, 2, 'a regular axis: two streams (scan, quadrature)');
    assert.ok(rows < 2 * 4000, `each stream stops after the selection (${rows} rows read in all)`);
    // The stream's bounds come from rows the panel holds (the overview), with
    // no query; the file is asked for the exact neighbours only when those are
    // not the stream's rows, or there is none before the selection.
    const source = lazy._duckdb.source;
    const original = source.neighborTimes;
    let asked = 0;
    source.neighborTimes = function(...args) { asked++; return original.apply(this, args); };
    await lazyIntegral(h, ['a'], baseState, range, null);
    assert.equal(asked, 0, 'an interior selection needs no query for its neighbours');
    const timeName = lazy.metadata.timeName;
    const overview = lazy.variables[timeName].data;
    const shifted = Float64Array.from(overview, value => value + 1);
    lazy.variables[timeName].data = shifted;
    const savedStart = lazy.metadata.timeStart;
    lazy.metadata.timeStart = savedStart + 1;
    assertSame(await lazyIntegral(h, ['a'], baseState, range, null, { chunkRows: 1000 }),
        eagerIntegral(eager, ['a'], baseState, range, null), 'bounds that are not rows of the file: the same result');
    assert.equal(asked, 1, 'found out on the first chunk, and the file asked instead');
    lazy.variables[timeName].data = overview;
    lazy.metadata.timeStart = savedStart;
    const early = [domain[0] - 1000, domain[0] + 3600000 * 3];
    assertSame(await lazyIntegral(h, ['a'], baseState, early, null), eagerIntegral(eager, ['a'], baseState, early, null), 'a selection from before the first row');
    assert.equal(asked, 2, 'which asks the file');
    source.neighborTimes = original;
    // An axis whose steps differ in the last digit, its median found by the
    // histogram: one more stream over the steps, and the same total.
    const numericLazy = await loadLazy('num.csv');
    const hn = harness(numericLazy);
    const he = harness(await eagerFrom(numericLazy));
    let numericPasses = 0;
    const numericGot = await lazyIntegral(hn, ['a'], baseState, null, null, { collectLimit: 300, onProgress: (p) => { numericPasses = p.pass; } });
    assertSame(numericGot, eagerIntegral(he, ['a'], baseState, null, null), 'the numeric axis, median by histogram');
    assert.ok(numericPasses >= 3, `the median took further passes over the steps (${numericPasses} streams)`);
    await lazyIntegral(hn, ['a'], baseState, null, null, { onProgress: (p) => { numericPasses = p.pass; } });
    assert.equal(numericPasses, 2, 'with every step kept: two streams');
    // Cancel: the signal stops the run.
    const controller = new AbortController();
    const pending = h._lazyIntegralResults(candidatesOf(h, ['a']), {
        state: baseState, range: null, groupWindows: null, signal: controller.signal, chunkRows: 2000,
        onProgress: () => controller.abort(),
    });
    await assert.rejects(pending, error => error?.name === 'AbortError', 'Cancel stops a run');
}

// ── An abort nobody asked for means: run again ──────────────────────────────
{
    const lazy = await loadLazy('cal.csv');
    const h = harness(lazy);
    const eager = harness(await eagerFrom(lazy));
    const domain = domainOf(eager);
    // From before the first row: the neighbours are asked of the file.
    const range = [domain[0] - 1000, domain[0] + 86400000 * 9.1];
    // The neighbours' query, interrupted once by someone else's
    // cancelActiveQuery: an AbortError with the run's signal untouched.
    const source = lazy._duckdb.source;
    const original = source.neighborTimes;
    let interrupted = 0;
    source.neighborTimes = async function(...args) {
        if (!interrupted++) {
            const error = new Error('Query interrupted');
            error.name = 'AbortError';
            throw error;
        }
        return original.apply(this, args);
    };
    const plot = { _integralToken: 1 };
    const rescheduled = [];
    h._scheduleIntegralRecompute = (panelId, options) => rescheduled.push({ panelId, options });
    h._setIntegralComputing = () => {};
    const warnings = [];
    const state = { ...baseState };
    const candidates = candidatesOf(h, ['a']);
    const first = await h._runLazyIntegral('p', plot, 1, candidates, { state, range, groupWindows: null, eagerHoleDays: [], warnings });
    assert.equal(first.aborted, true, 'a foreign abort is not a result');
    assert.equal(first.byTrace.size, 0, 'nothing partial comes back from it');
    assert.equal(rescheduled.length, 1, 'the run is scheduled again');
    assert.equal(rescheduled[0].options?.immediate, true, 'at once');
    assert.equal(plot._integralToken, 2, 'and the interrupted run is dropped by its token');
    assert.deepEqual(warnings, [], 'and it says nothing went wrong');
    const second = await h._runLazyIntegral('p', plot, 2, candidates, { state, range, groupWindows: null, eagerHoleDays: [], warnings });
    assert.equal(second.aborted, false, 'the run again gives a result');
    assertSame(second.byTrace.get(candidates[0].trace), eagerIntegral(eager, ['a'], state, range, null)[0], 'the whole result');
    // An abort the run asked for (Cancel, or a newer run): silent, not again.
    source.neighborTimes = original;
    rescheduled.length = 0;
    h._abortAnalysisRun(plot, '_integralRunAbort');
    const cancelled = h._runLazyIntegral('p', plot, 2, candidates, { state, range, groupWindows: null, eagerHoleDays: [], warnings });
    plot._analysisAbort.abort();
    const third = await cancelled;
    assert.equal(third.aborted, true, 'a cancelled run is not a result');
    assert.equal(rescheduled.length, 0, 'and is not run again');
    // A signal with no SQL over the file is named, not integrated from the overview.
    lazy.variables.ov = { name: 'ov', data: new Float64Array(lazy.variables.a.data.length).fill(1), kind: 'variable', dataType: 'real', derived: true };
    const blocked = [];
    const none = await h._runLazyIntegral('p', { _integralToken: 5 }, 5, candidatesOf(h, ['ov']), { state, range, groupWindows: null, eagerHoleDays: [], warnings: blocked });
    assert.equal(none.byTrace.size, 0, 'an overview-only signal gets no bar');
    assert.deepEqual(blocked, ['ov: integralLazyUnsupported'], 'and is named');
}

console.log(`lazy integral: ${runs} configurations, ${compared} numbers equal to the in-memory ones`);
