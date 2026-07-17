// Behavioural tests for the timeseries "show missing data" feature and the
// shared missing-data helpers it borrows from the FFT pane. The methods live
// on the plot-manager prototype, so — like test-mode-toolbar — we extract each
// one from source and run it against a small mock `this`, exercising the real
// code rather than a copy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detectSamplingGaps, detectNaNRuns } from '../src/utils/fft.js';

const fftMethodsSource = readFileSync(
    new URL('../src/plots/methods/fft-methods.js', import.meta.url),
    'utf8',
);
const dataMethodsSource = readFileSync(
    new URL('../src/plots/methods/data-methods.js', import.meta.url),
    'utf8',
);
const interactionMethodsSource = readFileSync(
    new URL('../src/plots/methods/interaction-methods.js', import.meta.url),
    'utf8',
);

const methodSource = (name) => {
    const marker = `proto.${name} = function`;
    const start = fftMethodsSource.indexOf(marker);
    assert.ok(start >= 0, `${name} is present in fft-methods.js`);
    const next = fftMethodsSource.indexOf('\nproto.', start + marker.length);
    return fftMethodsSource.slice(start, next >= 0 ? next : fftMethodsSource.length);
};

class Harness {
    constructor({ times = {}, values = {}, sampled = [] } = {}) {
        this._times = times;   // fileId -> number[]
        this._values = values; // `${fileId}|${varName}` -> number[]
        this._sampled = new Set(sampled); // fileIds whose times are a lazy overview sample
    }
    _isVisible(t) { return t.visible !== false; }
    _hasTruthfulGapSeries(fileId) { return !this._sampled.has(fileId); }
    _getTimeVar() { return {}; }
    _getTransformedTimeData(fileId) { return this._times[fileId] || []; }
    _getTransformedVariableData(fileId, varName) { return this._values[`${fileId}|${varName}`] || []; }
    _coerceAxisValue(v) { return Number(v); }
    _plotlyTimeValue(fileId, v) { return v; }
}

const sandbox = { proto: Harness.prototype, detectSamplingGaps, detectNaNRuns };
vm.runInNewContext([
    methodSource('_applyLineBreaks'),
    methodSource('_missTraceKey'),
    methodSource('_missingDataInfo'),
    methodSource('_adaptiveGapBandShapes'),
].join('\n'), sandbox);

// Arrays/objects built inside the vm carry the sandbox realm's prototypes, so
// deepStrictEqual would reject them on prototype alone. Re-home them first.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── _applyLineBreaks: a NaN break is inserted across each interval ──
{
    const h = new Harness();
    const trace = { x: [0, 1, 2, 3], y: [10, 20, 30, 40], type: 'scattergl', __srcX: [0, 1, 2, 3] };
    h._applyLineBreaks(trace, [{ t0: 1, t1: 2 }]);
    assert.deepEqual(plain(trace.x), [0, 1, 1, 2, 3], 'break duplicates the x at the gap edge');
    assert.equal(trace.y.length, 5, 'one point is inserted');
    assert.ok(Number.isNaN(trace.y[2]), 'the inserted y is NaN so the line breaks');
    assert.deepEqual([...trace.y].filter(v => !Number.isNaN(v)), [10, 20, 30, 40], 'real samples are preserved');
    assert.equal(trace.type, 'scatter', 'WebGL is downgraded to SVG so the NaN gap renders');
    assert.ok(!('__srcX' in trace), 'the helper strips its scratch source-x before Plotly sees it');
}

// No intervals → the trace is untouched (and __srcX removed).
{
    const h = new Harness();
    const trace = { x: [0, 1, 2], y: [1, 2, 3], type: 'scattergl', __srcX: [0, 1, 2] };
    h._applyLineBreaks(trace, []);
    assert.deepEqual(trace.y, [1, 2, 3], 'no intervals leaves the line intact');
    assert.equal(trace.type, 'scattergl', 'no break means the renderer is left alone');
}

// A gap whose edges were dropped by downsampling is still bracketed.
{
    const h = new Harness();
    const trace = { x: [0, 500, 1000], y: [1, 2, 3], type: 'scatter', __srcX: [0, 500, 1000] };
    h._applyLineBreaks(trace, [{ t0: 100, t1: 400 }]);
    assert.ok(trace.y.some(Number.isNaN), 'a gap between two plotted points still breaks the line');
}

// ── _missingDataInfo: union of per-file time gaps and per-trace NaN runs ──
{
    // 8 samples, 10-min-ish step, one 4x jump (a sampling gap) between i=4 and i=5.
    const times = [0, 600, 1200, 1800, 2400, 4800, 5400, 6000];
    const h = new Harness({
        times: { f1: times },
        values: {
            'f1|a': [10, NaN, NaN, 40, 50, 60, 70, 80], // NaN run at i=1..2
            'f1|b': [1, 2, 3, 4, 5, 6, 7, 8],           // no NaN
        },
    });
    const plot = { traces: [
        { fileId: 'f1', varName: 'a' },
        { fileId: 'f1', varName: 'b' },
    ] };
    const info = h._missingDataInfo(plot);
    const keyA = h._missTraceKey(plot.traces[0]);
    const keyB = h._missTraceKey(plot.traces[1]);

    assert.deepEqual([...info.fileGaps.keys()], ['f1'], 'file gaps are computed once per file');
    assert.deepEqual(plain(info.fileGaps.get('f1').gaps), [{ t0: 2400, t1: 4800 }], 'the sampling gap is detected');

    // Trace "a": gap ∪ its NaN run, sorted by start.
    assert.deepEqual(
        plain(info.traceIntervals.get(keyA)),
        [{ t0: 0, t1: 1800 }, { t0: 2400, t1: 4800 }],
        'trace a breaks across both its NaN run and the shared gap',
    );
    // Trace "b": only the shared gap (no NaN of its own).
    assert.deepEqual(
        plain(info.traceIntervals.get(keyB)),
        [{ t0: 2400, t1: 4800 }],
        'trace b breaks only across the shared sampling gap',
    );

    // Bands are the union: one gap band + one NaN band.
    assert.equal(info.bandItems.length, 2, 'bands cover the gap once plus the NaN run');
    assert.ok(info.bandItems.some(b => b.t0 === 2400 && b.t1 === 4800), 'a band marks the sampling gap');
    assert.ok(info.bandItems.some(b => b.t0 === 0 && b.t1 === 1800), 'a band marks the NaN run');

    // Hidden traces contribute nothing.
    const info2 = h._missingDataInfo({ traces: [
        { fileId: 'f1', varName: 'a', visible: false },
        { fileId: 'f1', varName: 'b', visible: false },
    ] });
    assert.equal(info2.bandItems.length, 0, 'hidden traces are ignored');
}

// A perfectly clean series yields no missing-data intervals.
{
    const h = new Harness({
        times: { f1: [0, 600, 1200, 1800, 2400] },
        values: { 'f1|a': [1, 2, 3, 4, 5] },
    });
    const trace = { fileId: 'f1', varName: 'a' };
    const info = h._missingDataInfo({ traces: [trace] });
    assert.equal(info.bandItems.length, 0, 'clean data has no bands');
    assert.deepEqual(plain(info.traceIntervals.get(h._missTraceKey(trace))), [], 'clean data has no break intervals');
}

// A lazy overview (reservoir sample) has no truthful time spacing, so even
// though its irregular sample times + sparse NaNs would look like gaps
// everywhere, no bands or per-file gaps are produced for it.
{
    const times = [0, 600, 1200, 1800, 2400, 4800, 5400, 6000];
    const h = new Harness({
        times: { f1: times },
        values: { 'f1|a': [10, NaN, NaN, 40, 50, 60, 70, 80] },
        sampled: ['f1'],
    });
    const trace = { fileId: 'f1', varName: 'a' };
    const info = h._missingDataInfo({ traces: [trace] });
    assert.equal(info.bandItems.length, 0, 'a sampled overview yields no missing-data bands');
    assert.equal(info.fileGaps.size, 0, 'no per-file gaps are computed for a sampled overview');
    assert.equal(info.traceIntervals.get(h._missTraceKey(trace)), undefined, 'a sampled trace has no break intervals');
}

// ── _adaptiveGapBandShapes: appearance keys off on-screen width ──
{
    const h = new Harness();
    // 1 px per data unit.
    const plot = { div: { _fullLayout: { xaxis: { range: [0, 1000], _length: 1000 } } } };
    const shapes = h._adaptiveGapBandShapes(plot, [
        { fileId: 'f', timeVar: null, t0: 0, t1: 1 },     // 1 px  → narrow
        { fileId: 'f', timeVar: null, t0: 0, t1: 100 },   // 100 px → wide
    ]);
    assert.equal(shapes.length, 2, 'one band per interval');
    assert.ok(shapes.every(s => s.type === 'rect' && String(s.fillcolor).startsWith('rgba(229, 57, 53,')), 'bands are red rects');
    assert.ok(shapes[0].line.width > 0, 'a narrow (sub-pixel) band keeps a pixel-width stroke so it stays visible');
    assert.equal(shapes[1].line.width, 0, 'a wide band drops the stroke — no outline');

    // Empty input and no-axis fallback are safe.
    assert.equal(h._adaptiveGapBandShapes(plot, []).length, 0, 'no intervals → no shapes');
    const noAxis = h._adaptiveGapBandShapes({ div: {} }, [{ fileId: 'f', timeVar: null, t0: 0, t1: 1 }]);
    assert.equal(noAxis.length, 1, 'missing axis layout still produces a (narrow-styled) band');
    assert.ok(noAxis[0].line.width > 0, 'without axis metrics a band defaults to visible/narrow');
}

// ── Gating: with the flag off, nothing changes ──
// Behavioural guard: a trace built without the opt-in (no __srcX attached) is a
// no-op through the break helper, so the "off" path can never alter the line.
{
    const h = new Harness();
    const trace = { x: [0, 1, 2], y: [10, 20, 30], type: 'scattergl' };
    h._applyLineBreaks(trace, [{ t0: 0, t1: 1 }]);
    assert.deepEqual(trace.y, [10, 20, 30], 'no __srcX (flag off) leaves the line untouched');
    assert.equal(trace.type, 'scattergl', 'no __srcX (flag off) leaves the renderer untouched');
}

// Structural guard on the three wiring sites: bands and breaks are reached only
// under `plot.mode === 'timeseries' && plot.showMissingData` (default false),
// so the whole feature is inert unless the user turns it on.
assert.match(
    dataMethodsSource,
    /if \(plot\.mode === 'timeseries' && plot\.showMissingData\) \{\s*layout\.shapes = this\._missingDataBandShapes\(plot\);/,
    'timeseries layout adds missing-data bands only under the opt-in flag',
);
assert.match(
    dataMethodsSource,
    /const showMissing = plot\.mode === 'timeseries' && plot\.showMissingData;/,
    'timeseries trace build gates the line breaks behind the opt-in flag',
);
assert.match(
    interactionMethodsSource,
    /const showMissing = plot\.mode === 'timeseries' && plot\.showMissingData;/,
    'the authoritative restyle path gates missing-data work behind the opt-in flag',
);
assert.match(
    interactionMethodsSource,
    /if \(showMissing\) this\._applyLineBreaks\(built, missInfo\.traceIntervals\.get/,
    'restyle applies line breaks only when the flag is on',
);
assert.match(
    interactionMethodsSource,
    /if \(showMissing && plot\.div\) \{\s*Plotly\.relayout\(plot\.div, \{ shapes: this\._missingDataBandShapes\(plot\) \}\);/,
    'restyle re-applies bands (adaptive width) only when the flag is on',
);

console.log('Missing-data tests passed');
