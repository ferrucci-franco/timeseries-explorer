// The FFT of a lazy file is the FFT of the same rows in memory, bit for bit,
// now that its rows are read as a stream and joined in the worker (#174).
//
//   node scripts/test-lazy-fft.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. Three ways to the spectrum are compared,
// every frequency and every amplitude:
//
//   · in memory: _fftSeriesForTrace's eager branch, then the transform;
//   · the lazy read as it was: getRawColumnsRange, _transformFetchedPhaseTrajectory
//     and selectFftRange on the whole result (the reference for the rows);
//   · the lazy read as it is: _fftLazySeries streaming the rows a chunk at a
//     time, handed as chunks to the real FFT worker module (fft-worker.js),
//     which joins them, cuts the range and transforms — and, below the worker
//     threshold, the same done on the main thread.
//
// With no transform and with every one on (crop, shift, gain, offset, sign),
// with "Full" and selections, on a real time column and a generated one
// (counted and not). "Full" reads every row of the file — not the span of the
// overview in memory, whose ends are a sample's — and the range controls'
// domain reaches the file's ends. On a generated axis the file is read whole
// and only the rows of a selection count against the row limit. Also: the worker's Y extent is the panel's _finiteExtent; past the row
// limit the read is refused, and stops; an abort ends the read at once, with
// an AbortError, and its connection is closed; a newer run's signal aborts the
// one it supersedes and Cancel aborts it too; and a NULL-holding column reads
// as the row-by-row Arrow loop reads it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const fft = await import(new URL('../src/utils/fft.js', import.meta.url));
const { computeAmplitudeSpectrum, selectFftRange } = fft;

// ── The FFT methods, sliced out of fft-methods.js (it imports Plotly) ───────
const fftSource = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function sliceBlock(startText, endText) {
    const start = fftSource.indexOf(startText);
    assert.ok(start >= 0, `${startText.trim()} is present`);
    const end = fftSource.indexOf(endText, start);
    assert.ok(end > start, `${startText.trim()} can be isolated`);
    return fftSource.slice(start, end + endText.length);
}
const methodNames = [
    '_fftSeriesForTrace', '_fftLazySeries', '_fftRunSignal', '_abortFftRun', '_settleFftRun',
    '_computeFftSpectrumForSeries', '_fftMaxRawRowsForState', '_fftComputationMaxNfft', '_fftLiveMaxNfft',
    '_fftWorkerThresholdNfft', '_fftHardMaxNfft', '_fftTimeKind', '_fftDomain',
];
const code = [
    sliceBlock('const FFT_LAZY_CHUNK_ROWS', ';\n'),
    sliceBlock('function yieldToBrowser()', '\n}\n'),
    sliceBlock('function abortError()', '\n}\n'),
    sliceBlock('function transferFftInputBuffers(input)', '\n}\n'),
    ...methodNames.map(name => sliceBlock(`proto.${name} = `, '\n};\n')),
    'return { transferFftInputBuffers, FFT_LAZY_CHUNK_ROWS };',
].join('\n');
const fftProto = {};
const scope = {
    ...fft,
    console,
};
// In this realm, so the typed arrays are the ones the rest of the test uses.
const sliced = new Function('proto', ...Object.keys(scope), code)(fftProto, ...Object.values(scope));
assert.match(fftSource, /series = await this\._fftSeriesForTrace\(trace, range, state, runSignal\);/, 'the panel reads each trace with its run\'s signal');
assert.match(fftSource, /const runSignal = this\._fftRunSignal\(plot\);/, 'and each run takes a signal of its own');
assert.match(fftSource, /proto\._scheduleFftRecompute = function[\s\S]*?this\._abortFftRun\(plot\);[\s\S]*?plot\._fftRecomputeTimer = setTimeout/, 'a newer request stops the run in flight');

// PlotManager imports Plotly too: the few methods used here, sliced out of it.
const managerSource = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const managerMethods = {};
new Function('proto', 'console', ['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_finiteExtent', '_extractUnit', '_traceName'].map(sliceMethod).join('\n'))(managerMethods, console);

// The worker, the real module, driven as a browser would drive it.
let workerHandler = null;
const workerReplies = [];
globalThis.self = {
    addEventListener: (type, handler) => { if (type === 'message') workerHandler = handler; },
    postMessage: (message) => workerReplies.push(message),
};
await import(new URL('../src/workers/fft-worker.js', import.meta.url));
assert.equal(typeof workerHandler, 'function', 'the worker listens for jobs');
let workerJobs = 0;
function runInWorker(input) {
    workerJobs++;
    // Posted as the panel posts it: the buffers moved, not copied.
    const message = structuredClone({ id: 'job', input }, { transfer: sliced.transferFftInputBuffers(input) });
    workerReplies.length = 0;
    workerHandler({ data: message });
    const reply = workerReplies.pop();
    assert.ok(reply?.ok, `the worker answers (${reply?.error?.message || ''})`);
    return reply.spectrum;
}

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        // Low, so every spectrum here takes the worker path unless a test says not.
        this.workerThreshold = 64;
        this.maxRows = null;
    }
    _canUseFftWorker() { return true; }
    _fftWorkerThresholdNfft() { return this.workerThreshold; }
    _computeFftSpectrumInWorker(plot, input) { return Promise.resolve(runInWorker(input)); }
    _analysisSignal(plot) {
        if (!plot._analysisAbort || plot._analysisAbort.signal.aborted) plot._analysisAbort = new AbortController();
        return plot._analysisAbort.signal;
    }
}
installPlotDataMethods(Harness);
Object.assign(Harness.prototype, managerMethods, fftProto);
// Restore the stubs the sliced methods would otherwise replace.
Harness.prototype._fftWorkerThresholdNfft = function() { return this.workerThreshold; };
const slicedMaxRows = fftProto._fftMaxRawRowsForState;
Harness.prototype._fftMaxRawRowsForState = function(state) {
    return this.maxRows ?? slicedMaxRows.call(this, state);
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const ROWS = 300007;
const lines = ['t,a,b'];
for (let i = 0; i < ROWS; i++) {
    const a = Math.sin(i * 0.0123) * 3 + Math.sin(i * 0.31) * 0.5 + ((i * 7919) % 101) / 500;
    const b = Math.cos(i * 0.002) * 10 + (i % 13) / 7;
    lines.push(`${(i * 0.001).toFixed(3)},${a.toFixed(6)},${b.toFixed(5)}`);
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
// A column with holes, for the NULL-aware column read.
const holeLines = ['t,a'];
for (let i = 0; i < 50000; i++) holeLines.push(`${i},${i % 7 === 3 ? '' : (i * 0.5).toFixed(1)}`);

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
db.registerFileText('f.csv', lines.join('\n') + '\n');
db.registerFileText('holes.csv', holeLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'f.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_fft_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
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
function harness(data, transform = {}, inverted = []) {
    const h = new Harness();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}

const state = { removeMean: true, windowType: 'hann', zeroPaddingFactor: 1, amplitudeScale: 'normal' };
const spectrumOf = (series) => computeAmplitudeSpectrum({
    times: series.times,
    values: series.values,
    timeKind: series.timeKind,
    removeMean: state.removeMean,
    windowType: state.windowType,
    zeroPaddingFactor: 1,
    amplitudeScale: 'normal',
    maxNfft: fft.FFT_MAX_POINTS_WEB,
});
function sameArray(got, want, label) {
    assert.equal(got.length, want.length, `${label}: length`);
    for (let i = 0; i < want.length; i++) {
        if (!Object.is(got[i], want[i])) assert.fail(`${label}: item ${i} is ${got[i]}, expected ${want[i]}`);
    }
}
function sameSpectrum(got, want, label) {
    assert.equal(got.ok, true, `${label}: a spectrum (${got.reason || ''})`);
    assert.equal(want.ok, true, `${label}: the reference is a spectrum (${want.reason || ''})`);
    for (const key of ['n', 'nfft', 'sampleRate', 'sampleInterval', 'meanRemoved', 'windowSum']) {
        assert.ok(Object.is(got[key], want[key]), `${label}: ${key} is ${got[key]}, expected ${want[key]}`);
    }
    sameArray(got.frequencies, want.frequencies, `${label}: frequencies`);
    sameArray(got.rawAmplitudes, want.rawAmplitudes, `${label}: amplitudes`);
}
// The lazy read as it was before #174: one result, transformed and cut whole.
async function previousLazySeries(h, trace, range) {
    const data = h.files.get(trace.fileId).data;
    const timeVar = h._getTimeVar(trace.fileId);
    const sourceRange = h._sourceRangeForDisplayRange(trace.fileId, range, timeVar);
    const raw = await data._duckdb.source.getRawColumnsRange(data, [trace.varName], sourceRange[0], sourceRange[1], h._fftMaxRawRowsForState(state));
    assert.equal(raw.truncated, false, 'the reference read is whole');
    const transformed = h._transformFetchedPhaseTrajectory(trace.fileId, raw.x, raw.rowIndex, raw.yByVar, [trace.varName]);
    const selected = selectFftRange(transformed.time, transformed.valuesByVar.get(trace.varName), range);
    return { times: selected.times, values: selected.values, timeKind: h._fftTimeKind(trace.fileId) };
}

// "Full" — the whole file — and selections, compared with the file in memory.
const FULL = 'full';

// ── The same spectrum three ways ────────────────────────────────────────────
for (const [axisLabel, profile, countRows] of [
    ['a real time column', null, false],
    ['a generated axis', generatedProfile, false],
    // As the app has it once it has counted the rows (_ensureLazyRowCount).
    ['a generated axis with its rows counted', generatedProfile, true],
]) {
    const lazy = await loadLazy('f.csv', profile);
    assert.ok(lazy.variables.a.data.length < ROWS / 10, `${axisLabel}: what is in memory is an overview`);
    const eager = await eagerFrom(lazy);
    assert.equal(eager.variables.a.data.length, ROWS, `${axisLabel}: the in-memory copy has every row`);
    if (countRows) {
        assert.equal(await harness(lazy)._ensureLazyRowCount('f'), ROWS, `${axisLabel}: the rows are counted`);
    }
    // The overview is a sample: its ends are not the file's (the gap "Full"
    // had, reading the overview's span).
    const overviewTime = harness(lazy)._getTransformedTimeDataForVariable('f', 'a');
    assert.ok(overviewTime.length < ROWS / 10, `${axisLabel}: the overview has few rows`);
    let checks = 0;
    for (const [label, transform, inverted] of [
        ['no transform', {}, []],
        // The crop in the axis's own unit: seconds, or rows on a generated one.
        ['crop, shift, gain, offset, sign', { gain: 2.5, yOffset: -3, timeShift: 7, ...(profile ? { cropStart: 2000, cropEnd: 280000 } : { cropStart: 20, cropEnd: 280 }) }, ['a']],
    ]) {
        const shift = transform.timeShift || 0;
        // A generated axis counts one unit per row.
        const ranges = profile
            ? [FULL, [2057.1234, 2211.5], [3000 + shift, 211500 + shift], [3000.5, 250000]]
            : [FULL, [57.1234, 211.5], [100 + shift, 211.5 + shift]];
        for (const range of ranges) {
            for (const varName of ['a', 'b']) {
                const trace = { fileId: 'f', varName };
                const full = range === FULL;
                const what = `${axisLabel}, ${label}, ${varName}, range ${JSON.stringify(range)}`;
                const lh = harness(lazy, transform, inverted);
                const eh = harness(eager, transform, inverted);
                const runState = full ? { ...state, rangeFull: true } : state;
                // What the panel hands over for "Full": its domain, which on a
                // lazy file now reaches the file's ends.
                const span = full ? [-1e12, 1e12] : range;
                const inMemory = await eh._fftSeriesForTrace(trace, span, runState);
                assert.equal(inMemory.ok, true, `${what}: in memory`);
                if (full) {
                    const rowsInMemory = eh._getTransformedTimeDataForVariable('f', varName).length;
                    assert.equal(inMemory.times.length, rowsInMemory, `${what}: in memory, every row`);
                }
                const want = spectrumOf(inMemory);
                // On a real time column, a selection reads the rows the single
                // read of before did: the same spectrum.
                if (!full && !profile) {
                    sameSpectrum(spectrumOf(await previousLazySeries(lh, trace, span)), want, `${what}: the single lazy read`);
                }

                // As the panel reads it now: chunks, into the worker.
                // (Full reads the whole file whatever the span; with the axis not yet
                // counted, a cropped generated axis may have no domain at all.)
                const lazyDomain = full ? lh._fftDomain({ traces: [trace] }) : null;
                const lazySpan = full ? (lazyDomain ? [lazyDomain.min, lazyDomain.max] : [0, 1]) : span;
                const series = await lh._fftSeriesForTrace(trace, lazySpan, runState, null);
                assert.equal(series.ok, true, `${what}: the stream`);
                if (full) {
                    assert.ok(series.parts.times.length > 1, `${what}: the rows came in several chunks`);
                    assert.equal(series.parts.length, inMemory.times.length, `${what}: "Full" reads every row of the file (${series.parts.length})`);
                }
                const before = workerJobs;
                const inWorker = await lh._computeFftSpectrumForSeries({}, series, runState);
                assert.equal(workerJobs, before + 1, `${what}: transformed in the worker`);
                sameSpectrum(inWorker, want, `${what}: streamed, joined and cut in the worker`);
                assert.deepEqual(inWorker.rawExtent, lh._finiteExtent([inWorker.rawAmplitudes]), `${what}: the worker's Y extent is the panel's`);

                // Below the worker threshold, the same on the main thread.
                const small = harness(lazy, transform, inverted);
                small.workerThreshold = Infinity;
                const onMain = await small._computeFftSpectrumForSeries({}, await small._fftSeriesForTrace(trace, lazySpan, runState, null), runState);
                assert.equal(workerJobs, before + 1, `${what}: a small transform stays on the main thread`);
                sameSpectrum(onMain, want, `${what}: streamed and joined on the main thread`);
                checks++;
            }
        }
    }
    // The domain the range controls offer reaches the file's ends too.
    if (!profile) {
        const domain = harness(lazy)._fftDomain({ traces: [{ fileId: 'f', varName: 'a' }] });
        assert.deepEqual([domain.min, domain.max], [0, Number(((ROWS - 1) * 0.001).toFixed(3))], `${axisLabel}: the domain is the file's, not the overview's`);
        assert.ok(overviewTime[0] > 0 || overviewTime[overviewTime.length - 1] < domain.max, `${axisLabel}: which the overview alone would not reach`);
    }
    await duck.release?.(lazy);
    console.log(`lazy fft: ${checks} spectra on ${axisLabel} identical in memory ("Full" and selections), streamed`);
}

// ── The row limit, an abort, a newer run ────────────────────────────────────
{
    const lazy = await loadLazy();
    const trace = { fileId: 'f', varName: 'a' };
    const h = harness(lazy);
    h.maxRows = 100000;
    const refused = await h._fftSeriesForTrace(trace, [-1e12, 1e12], state, null);
    assert.deepEqual(refused, { ok: false, reason: 'tooManyPoints' }, 'past the row limit the read is refused');
    assert.equal(duck._streamConns.size, 0, 'and its stream is closed');
    h.maxRows = null;

    // A row-number axis is read whole for a selection: only the rows in the
    // selection count against the limit, and past it the read stops.
    const generatedLazy = await loadLazy('f.csv', generatedProfile);
    const g = harness(generatedLazy);
    g.maxRows = 100000;
    const selection = await g._fftSeriesForTrace(trace, [1000, 50999], state, null);
    assert.equal(selection.ok, true, 'a selection under the limit on a row-number axis is read');
    assert.equal(selection.parts.length, 50000, 'with exactly its rows');
    const tooLong = await g._fftSeriesForTrace(trace, [0, 150000], state, null);
    assert.deepEqual(tooLong, { ok: false, reason: 'tooManyPoints' }, 'and one past it is refused');
    const wholeTooLong = await g._fftSeriesForTrace(trace, [0, 1], { ...state, rangeFull: true }, null);
    assert.deepEqual(wholeTooLong, { ok: false, reason: 'tooManyPoints' }, 'as is "Full" past it');
    assert.equal(duck._streamConns.size, 0, 'its streams are closed');
    await duck.release?.(generatedLazy);

    // Aborted between two chunks: the read ends there, with an AbortError.
    const controller = new AbortController();
    const realStream = duck.streamColumns.bind(duck);
    let delivered = 0;
    duck.streamColumns = async function* (...args) {
        for await (const chunk of realStream(...args)) {
            delivered++;
            if (delivered === 2) controller.abort();
            yield chunk;
        }
    };
    const started = Date.now();
    await assert.rejects(h._fftSeriesForTrace(trace, [-1e12, 1e12], state, controller.signal), err => err.name === 'AbortError', 'an aborted read throws AbortError');
    duck.streamColumns = realStream;
    assert.equal(delivered, 2, 'and reads no chunk past the abort');
    assert.ok(Date.now() - started < 10000, 'promptly');
    for (let i = 0; i < 100 && duck._streamConns.size; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(duck._streamConns.size, 0, 'its connection is closed');

    // An abort while DuckDB has not delivered a row yet ends the read at once,
    // without waiting for the batch.
    const early = new AbortController();
    const pending = duck.streamColumns(lazy, ['a'], { signal: early.signal })[Symbol.asyncIterator]();
    const first = pending.next();
    early.abort();
    await assert.rejects(first, err => err.name === 'AbortError', 'a stream aborted before its first batch throws AbortError');
    for (let i = 0; i < 100 && duck._streamConns.size; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(duck._streamConns.size, 0, 'and its connection is closed');

    // Each run's signal: the next run aborts it, so does Cancel (the panel's).
    const plot = {};
    const one = h._fftRunSignal(plot);
    const two = h._fftRunSignal(plot);
    assert.equal(one.aborted, true, 'a newer run aborts the one it supersedes');
    assert.equal(two.aborted, false, 'and runs');
    plot._analysisAbort.abort();
    assert.equal(two.aborted, true, 'Cancel aborts the run in flight');
    const three = h._fftRunSignal(plot);
    assert.equal(three.aborted, false, 'the run after a Cancel gets a fresh signal');
    h._settleFftRun(plot, three);
    assert.equal(plot._fftRunAbort, null, 'a finished run lets go of the panel signal');
    assert.equal(three.aborted, false, 'without aborting itself');
    console.log('lazy fft: the row limit, an abort and a superseded run stop the read');
}

// ── A column with NULLs reads as the Arrow loop reads it ────────────────────
{
    const holes = await loadLazy('holes.csv');
    const variable = holes.variables.a;
    const sql = duck._rawRowsSql(holes, [{ varName: 'a', variable }], { withRowIndex: true });
    const table = await duck._interactiveQuery(sql);
    for (const idx of [1, 2]) {
        const child = table.getChildAt(idx);
        assert.ok(Number(child.nullCount) > 0, `column ${idx} has NULLs`);
        const loop = new Float64Array(child.length);
        for (let i = 0; i < child.length; i++) {
            const v = child.get(i);
            loop[i] = v == null ? NaN : Number(v);
        }
        sameArray(duck._extractColumnAsFloat64(table, idx, 'DOUBLE'), loop, `column ${idx} with NULLs`);
    }
    assert.ok(Number(table.getChildAt(1).nullCount) === table.numRows, 'the row index of a real time column is all NULL');
    console.log('lazy fft: columns with NULLs read like the row-by-row loop');
}
