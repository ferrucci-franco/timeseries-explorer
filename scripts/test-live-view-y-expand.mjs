// Live Update, time-series "Expand if needed": the Y range only grows, on the
// side the new rows cross, and with headroom (a rising signal used to be drawn
// right along the frame, which read as "not expanding"). For a lazy file the
// expansion runs once more from the values actually drawn. The methods are
// PlotManager class methods, sliced out and run against a mock `this`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { expandedAxisRangeForExtent } from '../src/plots/methods/data-methods.js';

const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const classMethod = (name) => {
    const sig = source.match(new RegExp(`^ {4}${name}\\(([^)]*)\\) \\{$`, 'm'));
    assert.ok(sig, `${name} is present`);
    const stop = source.indexOf('\n    }', sig.index) + '\n    }'.length;
    return source.slice(sig.index, stop).replace(sig[0], `proto.${name} = function(${sig[1]}) {`);
};

const relayouts = [];
const Plotly = { relayout: (div, update) => { relayouts.push(update); return Promise.resolve(); } };
const proto = {};
vm.runInNewContext([
    '_timeseriesLiveAppendView',
    '_liveExpandedYRange',
    '_expandTimeseriesYToDrawnData',
    '_axisIsLog',
    '_extentInAxisUnits',
    '_padAxisRange',
].map(classMethod).join('\n'), { proto, Plotly, expandedAxisRangeForExtent });

class Harness {
    constructor({ lazy = false } = {}) {
        const variables = { A: {}, B: {} };
        this.files = new Map([['f', { data: { variables, ...(lazy ? { _duckdb: {} } : {}) } }]]);
        this._x = {};
        this._y = {};
        this._drawn = null;
    }
    _isVisible() { return true; }
    _getTransformedTimeDataForVariable(_f, v) { return this._x[v]; }
    _getTransformedVariableData(_f, v) { return this._y[v]; }
    _traceYAxis(t, plot) { return plot?.timeseriesY2Enabled && t.axis === 'y2' ? 'y2' : 'y'; }
    _getTimeVar() { return {}; }
    _timeDisplayModeForVar() { return 'numeric'; }
    _plotlyTimeArray(_f, r) { return r; }
    _coerceAxisValue(v) { return Number(v); }
    _padRange(a, b) { const p = (b - a) * 0.1 || 1; return [a - p, b + p]; }
    _drawnLazySeries(_plot, _t, index) { return this._drawn?.[index] || null; }
    _finiteExtent(arrays) {
        let min = Infinity, max = -Infinity;
        for (const arr of arrays) for (const v of (arr || [])) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
        return Number.isFinite(min) ? { min, max } : null;
    }
    _timeseriesYExtentForSeries(_plot, series, yArrays, xRange) {
        if (!xRange) return this._finiteExtent(yArrays);
        const lo = Math.min(xRange[0], xRange[1]);
        const hi = Math.max(xRange[0], xRange[1]);
        let min = Infinity, max = -Infinity;
        for (const s of series) {
            for (let i = 0; i < Math.min(s.x.length, s.y.length); i++) {
                if (s.x[i] < lo || s.x[i] > hi || !Number.isFinite(s.y[i])) continue;
                min = Math.min(min, s.y[i]);
                max = Math.max(max, s.y[i]);
            }
        }
        return Number.isFinite(min) ? { min, max } : null;
    }
}
Object.assign(Harness.prototype, proto);

const policy = (xMode = 'pin-start') => ({ xMode, yMode: 'expand', windowSeconds: 30 });
const plotWith = (traces, extra = {}) => ({ mode: 'timeseries', traces, ...extra });
const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// 1. A new peak above the range: the top grows past it, the bottom stays.
{
    const h = new Harness();
    h._x.A = seq(110, i => i);
    h._y.A = seq(110, i => (i === 105 ? 5 : Math.sin(i / 5)));
    const view = h._timeseriesLiveAppendView(plotWith([{ fileId: 'f', varName: 'A' }]), 'f',
        { mode: '2d', xRange: [0, 99], yRange: [-1.1, 1.1] }, policy());
    assert.equal(view.yRange[0], -1.1, 'expanding upward keeps the lower bound');
    assert.ok(view.yRange[1] > 5, `the new peak gets headroom, not the frame edge (got ${view.yRange[1]})`);
    assert.deepEqual([...view.xRange], [0, 109], 'pin-start follows the new rows');
}

// 2. New rows inside the range leave it exactly as it was (never shrinks).
{
    const h = new Harness();
    h._x.A = seq(110, i => i);
    h._y.A = seq(110, i => 0.5 * Math.sin(i / 5));
    const yRange = [-3, 3];
    const view = h._timeseriesLiveAppendView(plotWith([{ fileId: 'f', varName: 'A' }]), 'f',
        { mode: '2d', xRange: [0, 99], yRange }, policy());
    assert.equal(view.yRange, yRange, 'a range that already holds the data is kept as is');
}

// 3. A reversed axis keeps its direction; a dip grows the bottom only.
{
    const h = new Harness();
    h._x.A = seq(20, i => i);
    h._y.A = seq(20, i => (i === 19 ? -8 : 0));
    const view = h._timeseriesLiveAppendView(plotWith([{ fileId: 'f', varName: 'A' }]), 'f',
        { mode: '2d', xRange: [0, 18], yRange: [2, -2] }, policy());
    assert.equal(view.yRange[0], 2, 'the reversed top bound is kept');
    assert.ok(view.yRange[1] < -8, 'the reversed bottom bound grows past the dip');
}

// 4. Y2 expands on its own data, Y is untouched.
{
    const h = new Harness();
    h._x.A = seq(20, i => i);
    h._x.B = seq(20, i => i);
    h._y.A = seq(20, () => 0);
    h._y.B = seq(20, i => (i === 19 ? 900 : 100));
    const plot = plotWith([{ fileId: 'f', varName: 'A' }, { fileId: 'f', varName: 'B', axis: 'y2' }], { timeseriesY2Enabled: true });
    const yRange = [-1, 1];
    const view = h._timeseriesLiveAppendView(plot, 'f',
        { mode: '2d', xRange: [0, 18], yRange, y2Range: [90, 110] }, policy());
    assert.equal(view.yRange, yRange, 'Y keeps its range');
    assert.equal(view.y2Range[0], 90, 'Y2 keeps its lower bound');
    assert.ok(view.y2Range[1] > 900, 'Y2 grows past the new value');
}

// 5. Sliding window: only the visible rows count, but the range still never shrinks.
{
    const h = new Harness();
    h._x.A = seq(200, i => i);
    h._y.A = seq(200, i => (i < 50 ? 10 : 1));
    const yRange = [-11, 11];
    const view = h._timeseriesLiveAppendView(plotWith([{ fileId: 'f', varName: 'A' }]), 'f',
        { mode: '2d', xRange: [0, 199], yRange }, policy('sliding'));
    assert.deepEqual([...view.xRange], [169, 199], 'the window slides to the newest rows');
    assert.equal(view.yRange, yRange, 'an old peak leaving the window does not shrink Y');
}

// 6. No previous range (first frame): the data extent, padded.
{
    const h = new Harness();
    h._x.A = [0, 1, 2];
    h._y.A = [1, 2, 3];
    const view = h._timeseriesLiveAppendView(plotWith([{ fileId: 'f', varName: 'A' }]), 'f',
        { mode: '2d', xRange: [0, 2], yRange: null }, policy());
    assert.ok(view.yRange[0] < 1 && view.yRange[1] > 3, 'a missing range becomes the padded data extent');
}

// 7. Lazy file: the view asks for a second pass, and that pass reads what is drawn.
{
    const h = new Harness({ lazy: true });
    h._x.A = seq(110, i => i);
    h._y.A = seq(110, () => 0.5);                     // the thinned overview misses the spike
    const plot = plotWith([{ fileId: 'f', varName: 'A' }]);
    h._timeseriesLiveAppendView(plot, 'f', { mode: '2d', xRange: [0, 99], yRange: [-1, 1] }, policy());
    assert.equal(plot._liveExpandYAfterDetail, true, 'a lazy trace asks for a pass after the detail is drawn');

    h._drawn = [{ x: seq(110, i => i), y: seq(110, i => (i === 104 ? 7 : 0.5)) }];
    plot.div = { _fullLayout: { xaxis: { range: [0, 109] }, yaxis: { range: [-1, 1] } } };
    relayouts.length = 0;
    await h._expandTimeseriesYToDrawnData(plot);
    assert.equal(relayouts.length, 1, 'the drawn spike expands Y');
    assert.equal(relayouts[0]['yaxis.range'][0], -1, 'the lower bound stays');
    assert.ok(relayouts[0]['yaxis.range'][1] > 7, 'the drawn spike gets headroom');
    assert.equal(relayouts[0]['yaxis.autorange'], false);

    h._drawn = [{ x: seq(110, i => i), y: seq(110, () => 0.2) }];
    relayouts.length = 0;
    await h._expandTimeseriesYToDrawnData(plot);
    assert.equal(relayouts.length, 0, 'drawn values inside the range change nothing');
}

// 8. An in-memory file never asks for the lazy pass.
{
    const h = new Harness();
    h._x.A = [0, 1];
    h._y.A = [0, 1];
    const plot = plotWith([{ fileId: 'f', varName: 'A' }]);
    h._timeseriesLiveAppendView(plot, 'f', { mode: '2d', xRange: [0, 1], yRange: [-2, 2] }, policy());
    assert.equal(plot._liveExpandYAfterDetail, undefined, 'eager data is exact, no second pass');
}

console.log('Live view Y expand tests passed.');
