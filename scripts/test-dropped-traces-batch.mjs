// Dropping several variables on a timeseries panel (#40).
//
// The app added them one at a time, and each add was its own Plotly.addTraces
// plus its own relayout over a chart that had just grown — so the cost per
// variable climbed as the drop went on. Measured in a browser: 20 variables
// over 100k rows blocked the thread for 2.6 s and produced NOT ONE frame;
// 60 over 200k took 17.3 s.
//
// Almost none of it was the data, which is worth recording because the report
// suspected otherwise ("the render function is not visually re-downsampling
// all variables"). On the same drop, building the decimated traces took 36 ms
// of 2656, and each drawn trace carried ~2k points from 100k rows. The
// remaining 2.6 s was Plotly, called 20 times instead of once.
//
// Batched, the same drops take 560 ms and 862 ms.
//
// plot-manager.js imports Plotly, so the method is sliced out and run against
// doubles — the technique test-fft-clean-range.mjs uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');

const startMarker = '    _addTimeseriesBatch(panelId, varNames, panelEl, plot, options = {}) {';
const start = source.indexOf(startMarker);
assert.ok(start >= 0, '_addTimeseriesBatch is present');
// To its own closing brace at four spaces — never to the name of whatever
// method happens to follow it.
const endMarker = '\n    }';
const end = source.indexOf(endMarker, start);
assert.ok(end > start, 'its end is findable');
const method = source.slice(start, end + endMarker.length)
    .replace(startMarker, 'proto.batch = function(panelId, varNames, panelEl, plot, options = {}) {');

const proto = {};
const calls = { addTraces: [], relayout: [], refresh: [], audio: [], createdVia: [] };
const Plotly = {
    addTraces: (div, traces, indices) => {
        // `indices` is built inside the vm and carries that realm's Array
        // prototype, which deepStrictEqual compares and rejects. Copy it here.
        calls.addTraces.push({ count: traces.length, indices: indices ? Array.from(indices) : null });
        div.data.push(...traces);
        return Promise.resolve();
    },
    relayout: (div, patch) => { calls.relayout.push(patch); return Promise.resolve(); },
};
vm.runInNewContext(method, { proto, console, Plotly });

const COLOURS = ['#1', '#2', '#3', '#4', '#5', '#6'];
const makeHost = ({ canAdd = true } = {}) => ({
    batch: proto.batch,
    activeFileId: 'f1',
    _canAddTraceWithFileTime: () => canAdd,
    _nextTraceColor: existing => COLOURS[existing.length % COLOURS.length],
    _buildTimeTrace: (state, range, plot, index) => ({ name: state.varName, _range: range, _index: index }),
    _addTimeseries: (panelId, varName, panelEl, plot, options) => {
        calls.createdVia.push(varName);
        plot.traces.push({ varName, color: COLOURS[plot.traces.length % COLOURS.length], fileId: 'f1', axis: options.axis });
        plot.div = { data: [{ name: varName }], _fullLayout: { xaxis: { range: [0, 1] } }, layout: {} };
    },
    _syncTimeseriesMarkerColors: () => {},
    _installLegendHoverHint: () => {},
    _expandTimeseriesYAxisForAddedTrace: () => {},
    _refreshTimeseriesVisuals: (panelId) => calls.refresh.push(panelId),
    _buildTimeLayout: () => ({ yaxis: { title: '' }, margin: {} }),
    _syncCursorDisplay: () => {},
    _syncAudioStrip: (panelId) => calls.audio.push(panelId),
});
const makePlot = (traces = [], div = null) => ({
    mode: 'timeseries', traces, div, markerTraceIdx: null, timeseriesY2Enabled: false,
});
const reset = () => { for (const key of Object.keys(calls)) calls[key].length = 0; };

// ── One call, whatever the count ────────────────────────────────────────────
// This IS the fix: the old path made one addTraces and one relayout per
// variable, over a chart that kept growing.
{
    reset();
    const host = makeHost();
    const plot = makePlot([], { data: [], _fullLayout: { xaxis: { range: [0, 5] } }, layout: {} });
    host.batch('p1', ['a', 'b', 'c', 'd'], null, plot, {});
    await Promise.resolve();
    assert.equal(calls.addTraces.length, 1, 'one addTraces for the whole drop');
    assert.equal(calls.addTraces[0].count, 4, 'carrying every variable');
    assert.equal(calls.relayout.length, 1, 'and one relayout');
    assert.deepEqual(plot.traces.map(t => t.varName), ['a', 'b', 'c', 'd']);
    assert.equal(new Set(plot.traces.map(t => t.color)).size, 4,
        'the colours still differ — they are assigned as the array grows');
    assert.deepEqual(calls.addTraces[0].indices, null, 'appended, with no marker to insert before');
}

// The follow-up work happens once, not once per variable.
{
    reset();
    const host = makeHost();
    const plot = makePlot([], { data: [], _fullLayout: {}, layout: {} });
    host.batch('p1', ['a', 'b', 'c'], null, plot, {});
    await Promise.resolve();
    assert.deepEqual(calls.refresh, ['p1'], 'the viewport is filled in once');
    assert.deepEqual(calls.audio, ['p1'], 'and the audio strip synced once');
}

// ── An empty panel has no chart to add to ───────────────────────────────────
// The first variable creates it through the ordinary path — a full render
// either way — and the rest join it in one call.
{
    reset();
    const host = makeHost();
    const plot = makePlot([], null);
    host.batch('p1', ['a', 'b', 'c'], null, plot, {});
    await Promise.resolve();
    assert.deepEqual(calls.createdVia, ['a'], 'the first variable creates the chart');
    assert.equal(calls.addTraces.length, 1, 'the other two arrive together');
    assert.equal(calls.addTraces[0].count, 2);
    assert.deepEqual(plot.traces.map(t => t.varName), ['a', 'b', 'c']);
}

// A lone variable onto an empty panel is just the ordinary path.
{
    reset();
    const host = makeHost();
    const plot = makePlot([], null);
    host.batch('p1', ['only'], null, plot, {});
    assert.deepEqual(calls.createdVia, ['only']);
    assert.equal(calls.addTraces.length, 0, 'nothing left to batch');
}

// ── What must not be added twice ────────────────────────────────────────────
{
    reset();
    const host = makeHost();
    const plot = makePlot([{ varName: 'a', fileId: 'f1', color: '#1', axis: 'y' }],
        { data: [{ name: 'a' }], _fullLayout: {}, layout: {} });
    host.batch('p1', ['a', 'b'], null, plot, {});
    await Promise.resolve();
    assert.deepEqual(plot.traces.map(t => t.varName), ['a', 'b'], 'the one already there is skipped');
    assert.equal(calls.addTraces[0].count, 1, 'only the new one is sent');
}
{
    reset();
    const host = makeHost();
    const plot = makePlot([{ varName: 'a', fileId: 'f1', color: '#1', axis: 'y' }],
        { data: [{ name: 'a' }], _fullLayout: {}, layout: {} });
    host.batch('p1', ['a'], null, plot, {});
    assert.equal(calls.addTraces.length, 0, 'a drop that adds nothing touches Plotly not at all');
    assert.equal(calls.relayout.length, 0);
}
{
    reset();
    const host = makeHost();
    const plot = makePlot([], { data: [], _fullLayout: {}, layout: {} });
    host.batch('p1', ['a', 'a', 'b'], null, plot, {});
    await Promise.resolve();
    assert.deepEqual(plot.traces.map(t => t.varName), ['a', 'b'],
        'the same name twice in one drop becomes one trace');
}

// ── A file whose time axis cannot share the panel ───────────────────────────
// Asked once for the whole drop: every variable comes from the active file, so
// the answer cannot differ between them.
{
    reset();
    const host = makeHost({ canAdd: false });
    const plot = makePlot([], { data: [], _fullLayout: {}, layout: {} });
    host.batch('p1', ['a', 'b'], null, plot, {});
    assert.equal(plot.traces.length, 0, 'nothing is added');
    assert.equal(calls.addTraces.length, 0);
}

// ── The marker trace ────────────────────────────────────────────────────────
// When a marker sits in the Plotly data, new traces go in before it and the
// stored index moves by however many arrived.
{
    reset();
    const host = makeHost();
    const plot = makePlot([{ varName: 'a', fileId: 'f1', color: '#1', axis: 'y' }],
        { data: [{ name: 'a' }, { name: 'marker' }], _fullLayout: {}, layout: {} });
    plot.markerTraceIdx = 1;
    host.batch('p1', ['b', 'c'], null, plot, {});
    await Promise.resolve();
    assert.deepEqual(calls.addTraces[0].indices, [1, 2], 'consecutive slots before the marker');
    assert.equal(plot.markerTraceIdx, 3, 'and the marker index follows');
}
// The guard is the one _addTimeseries uses, so the two paths cannot disagree
// about what counts as a marker: interaction-methods stores an ARRAY of marker
// indices, which both treat as "append".
{
    reset();
    const host = makeHost();
    const plot = makePlot([{ varName: 'a', fileId: 'f1', color: '#1', axis: 'y' }],
        { data: [{ name: 'a' }], _fullLayout: {}, layout: {} });
    plot.markerTraceIdx = [4, 5];
    host.batch('p1', ['b'], null, plot, {});
    await Promise.resolve();
    assert.equal(calls.addTraces[0].indices, null, 'an array of marker indices means append');
    assert.deepEqual(plot.markerTraceIdx, [4, 5], 'and is left alone');
}
assert.match(source, /_addTimeseries\(panelId, varName, panelEl, plot, options = \{\}\)[\s\S]*?Number\.isInteger\(plot\.markerTraceIdx\)/,
    'the per-variable path still uses the same guard');

// ── The second Y axis ───────────────────────────────────────────────────────
{
    reset();
    const host = makeHost();
    const plot = makePlot([], { data: [], _fullLayout: {}, layout: {} });
    plot.timeseriesY2Enabled = true;
    host.batch('p1', ['a', 'b'], null, plot, { axis: 'y2' });
    assert.deepEqual(plot.traces.map(t => t.axis), ['y2', 'y2'], 'a drop on the right lands on y2');
}
{
    reset();
    const host = makeHost();
    const plot = makePlot([], { data: [], _fullLayout: {}, layout: {} });
    host.batch('p1', ['a'], null, plot, { axis: 'y2' });
    assert.deepEqual(plot.traces.map(t => t.axis), ['y'], 'y2 is ignored when the panel has no second axis');
}

// ── Wiring ──────────────────────────────────────────────────────────────────
assert.match(source, /if \(plot\.mode === 'timeseries'\) \{\s*\n\s*this\._addTimeseriesBatch\(/,
    'the drop handler goes through the batch');
assert.doesNotMatch(source, /names\.forEach\(varName => this\.addTrace\(panelId, varName, panelEl, \{ axis/,
    'and not through one addTrace per variable');
// The decimation was never the problem; it must stay exactly where it was.
assert.match(source, /_addTimeseriesBatch[\s\S]*?this\._buildTimeTrace\(state, currentRange, plot/,
    'each trace is still built against the visible range');

console.log('Dropped-trace batching checks passed.');
