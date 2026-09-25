// Tests for the per-axis auto-scale update builder (timeseries). Fit-X fits X to
// the full data extent; Fit-Y fits Y to the data VISIBLE in the current X window
// (the reason a separate Y button is worth having). The method is a PlotManager
// class method, so we slice it out and run it against a mock `this`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
// Matched by name rather than by a full signature: the parameter list grows
// (it has already taken an options bag) and the slice should survive that.
const signature = source.match(/^ {4}_autoScaleAxisUpdate\(([^)]*)\) \{$/m);
assert.ok(signature, '_autoScaleAxisUpdate is present');
const start = signature.index;
const end = source.indexOf('\n    _autoScalePlotAxis(', start + 1);
assert.ok(end > start, 'method end located');
const methodText = source.slice(start, end)
    .replace(signature[0], `proto._autoScaleAxisUpdate = function(${signature[1]}) {`);

const proto = {};
vm.runInNewContext(methodText, { proto });

// The log-axis helpers the builder leans on, sliced the same way.
const classMethod = (name) => {
    const sig = source.match(new RegExp(`^ {4}${name}\\(([^)]*)\\) \\{$`, 'm'));
    assert.ok(sig, `${name} is present`);
    const stop = source.indexOf('\n    }', sig.index) + '\n    }'.length;
    return source.slice(sig.index, stop).replace(sig[0], `proto.${name} = function(${sig[1]}) {`);
};
vm.runInNewContext(['_axisIsLog', '_extentInAxisUnits', '_padAxisRange'].map(classMethod).join('\n'), { proto });

class Harness {
    constructor() {
        this.files = new Map([['f', { data: { variables: { A: {}, B: {}, C: {} } } }]]);
        this._x = {};
        this._y = {};
    }
    _isVisible() { return true; }
    _getTransformedTimeDataForVariable(_f, v) { return this._x[v]; }
    _getTransformedVariableData(_f, v) { return this._y[v]; }
    _traceYAxis(t) { return t.axis === 'y2' ? 'y2' : 'y'; }
    _getTimeVar() { return {}; }
    _timeDisplayModeForVar() { return 'numeric'; }
    _exactRange(a, b) { return [a, b]; }
    _plotlyTimeArray(_f, r) { return r; }
    _padRange(a, b) { return [a, b]; }              // identity → predictable assertions
    _finiteExtent(arrays) {
        let min = Infinity, max = -Infinity;
        for (const arr of arrays) for (const v of (arr || [])) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
        return Number.isFinite(min) ? { min, max } : null;
    }
    _timeseriesYExtentForSeries(_plot, series, _yArrays, xRange) {  // non-stacked, view-aware
        const lo = xRange ? Math.min(xRange[0], xRange[1]) : -Infinity;
        const hi = xRange ? Math.max(xRange[0], xRange[1]) : Infinity;
        let min = Infinity, max = -Infinity;
        for (const s of series) {
            const n = Math.min(s.x.length, s.y.length);
            for (let i = 0; i < n; i++) {
                if (s.x[i] < lo || s.x[i] > hi) continue;
                const y = s.y[i];
                if (Number.isFinite(y)) { if (y < min) min = y; if (y > max) max = y; }
            }
        }
        return Number.isFinite(min) ? { min, max } : null;
    }
}
Harness.prototype._autoScaleAxisUpdate = proto._autoScaleAxisUpdate;
Harness.prototype._axisIsLog = proto._axisIsLog;
Harness.prototype._extentInAxisUnits = proto._extentInAxisUnits;
Harness.prototype._padAxisRange = proto._padAxisRange;
Harness.prototype._axisDataRange = function(axis) {
    const [lo, hi] = axis.range.map(Number);
    return axis.type === 'log' ? [10 ** lo, 10 ** hi] : [lo, hi];
};

function tsPlot(range, { y2 = false } = {}) {
    const traces = [{ fileId: 'f', varName: 'A' }, { fileId: 'f', varName: 'B' }];
    if (y2) traces.push({ fileId: 'f', varName: 'C', axis: 'y2' });
    return { mode: 'timeseries', timeseriesY2Enabled: y2, traces, div: { _fullLayout: { xaxis: { range } } } };
}

const h = new Harness();
// x=0 (y=100/-50) is OUTSIDE the [1,3] window, so a view-aware Y must exclude it.
h._x = { A: [0, 1, 2, 3, 4], B: [0, 1, 2, 3, 4], C: [0, 1, 2, 3, 4] };
h._y = { A: [100, 20, 5, 30, 15], B: [-50, -5, 8, 2, 1], C: [1000, 200, 300, 400, 500] };

// ── Fit X → full X extent, Y untouched ───────────────────────────────────────
{
    const u = h._autoScaleAxisUpdate(tsPlot([1, 3]), 'x');
    assert.deepEqual(u['xaxis.range'], [0, 4], 'Fit X uses the full X extent');
    assert.equal(u['xaxis.autorange'], false);
    assert.ok(!('yaxis.range' in u) && !('yaxis.autorange' in u), 'Fit X leaves Y untouched');
}

// ── Fit Y → Y extent of points inside the current X window [1,3] ──────────────
{
    const u = h._autoScaleAxisUpdate(tsPlot([1, 3]), 'y');
    assert.deepEqual(u['yaxis.range'], [-5, 30], 'Fit Y uses only points with x in [1,3]');
    assert.ok(!('xaxis.range' in u) && !('xaxis.autorange' in u), 'Fit Y leaves X untouched');
}

// ── Fit Y over the full window differs (proves view-awareness) ───────────────
{
    const u = h._autoScaleAxisUpdate(tsPlot([0, 4]), 'y');
    assert.deepEqual(u['yaxis.range'], [-50, 100], 'a wider X window includes the extremes at x=0');
}

// ── Fit Y with Y2 enabled fits both axes from their own traces ───────────────
{
    const u = h._autoScaleAxisUpdate(tsPlot([1, 3], { y2: true }), 'y');
    assert.deepEqual(u['yaxis.range'], [-5, 30], 'primary Y from A/B in window');
    assert.deepEqual(u['yaxis2.range'], [200, 400], 'Y2 from C in window [1,3]');
}

// ── Log axes: ranges in log10, fitted to the positive values only ────────────
// Plotly keeps a log axis's range as log10 of the window. The builder answers
// in those units, from the values a log axis can draw (> 0).
{
    const logH = new Harness();
    logH._x = { A: [0, 1, 2, 3], B: [0, 1, 2, 3], C: [0, 1, 2, 3] };
    logH._y = { A: [-3, 10, 1000, 0], B: [0, 0, 0, 0], C: [0.01, 0.1, 1, 10] };
    logH._timeseriesYExtentForSeries = function(plot, series, _yArrays, _xRange, axis = 'y') {
        const isLog = this._axisIsLog(plot, axis);
        const all = series.flatMap(item => Array.from(item.y));
        return this._extentInAxisUnits(this._finiteExtent([all.filter(v => !isLog || v > 0)]), isLog);
    };
    const plot = tsPlot([0, 3], { y2: true });
    plot.timeseriesYLog = true;
    plot.timeseriesY2Log = true;
    const u = logH._autoScaleAxisUpdate(plot, 'y');
    assert.deepEqual(u['yaxis.range'], [1, 3], 'log Y: 10…1000 is 1…3 decades; 0 and -3 are left out');
    assert.deepEqual(u['yaxis2.range'], [-2, 1], 'log Y2 fits its own traces, in decades');

    plot.timeseriesY2Enabled = false;
    assert.equal(logH._axisIsLog(plot, 'y2'), false, 'a Y2 log flag means nothing while Y2 is off');

    // 2D: log X is fitted in decades too, and a log X window is read back to
    // data units before the Y fit looks at which points are inside it.
    const flat = Array.from(logH._padAxisRange({ min: 2, max: 2 }, true)); // from the vm realm
    assert.deepEqual(flat, [1.5, 2.5], 'a flat positive signal gets half a decade either side');
    assert.equal(logH._extentInAxisUnits({ min: -1, max: 5 }, true), null, 'a non-positive extent has no log range');
}

// ── An analysis panel can borrow the builder for its time pane ───────────────
// Fit-Y in Fourier mode fits the spectrum AND the signal drawn above it. That
// upper pane holds ordinary time traces, so it asks for them by name; the mode
// alone would send the builder looking for phase traces it does not have.
{
    const fftPlot = { ...tsPlot([1, 3]), mode: 'fft' };
    const u = h._autoScaleAxisUpdate(fftPlot, 'y', { treatAsTimeseries: true });
    assert.deepEqual(u['yaxis.range'], [-5, 30], 'the option reads the panel time traces');
    assert.throws(() => h._autoScaleAxisUpdate(fftPlot, 'y'),
        'without the option the mode decides, and fft has no phase traces');
}

// ── Lazy files: Fit Y fits the curve on screen, not the overview (#172) ──────
// A lazy file's variable data is an overview of the whole record; after a zoom
// the chart draws the viewport detail DuckDB sent. Fit Y must fit that.
{
    const drawnStart = source.indexOf('    _drawnLazySeries(plot, trace, index) {');
    assert.ok(drawnStart >= 0, '_drawnLazySeries is present');
    const drawnEnd = source.indexOf('\n    }', drawnStart) + '\n    }'.length;
    const drawnText = source.slice(drawnStart, drawnEnd)
        .replace('    _drawnLazySeries(plot, trace, index) {', 'proto._drawnLazySeries = function(plot, trace, index) {');
    vm.runInNewContext(drawnText, { proto });

    const lazy = new Harness();
    lazy._drawnLazySeries = proto._drawnLazySeries;
    lazy._traceName = (varName) => varName;
    lazy.files = new Map([['f', { data: { _duckdb: {}, variables: { A: {}, B: {} } } }]]);
    // The overview never saw the spike at x=2.
    lazy._x = { A: [0, 1, 2, 3, 4], B: [0, 1, 2, 3, 4] };
    lazy._y = { A: [0, 1, 1, 1, 0], B: [0, 1, 1, 1, 0] };
    const plot = tsPlot([1.5, 2.5]);
    plot.traces = [{ fileId: 'f', varName: 'A' }];
    // What the chart draws for the zoom: the detail, spike included.
    plot.div.data = [{ name: 'A', x: [1.5, 1.8, 2, 2.2, 2.5], y: [1, 1.2, 50, 1.1, 1] }];

    let u = lazy._autoScaleAxisUpdate(plot, 'y');
    assert.deepEqual(u['yaxis.range'], [1, 50], 'Fit Y fits the drawn detail, spike included');

    // Fit X still spans the whole record, not the zoomed detail.
    u = lazy._autoScaleAxisUpdate(plot, 'x');
    assert.deepEqual(u['xaxis.range'], [0, 4], 'Fit X keeps the full extent');

    // A chart that does not hold this trace where expected: the file's values.
    plot.div.data = [{ name: 'something else', x: [2], y: [50] }];
    u = lazy._autoScaleAxisUpdate(plot, 'y');
    assert.deepEqual(u['yaxis.range'], [1, 1], 'falls back to the file\'s values');

    // An in-memory file is never read from the chart: its own values are exact.
    lazy.files = new Map([['f', { data: { variables: { A: {} } } }]]);
    plot.div.data = [{ name: 'A', x: [2], y: [50] }];
    u = lazy._autoScaleAxisUpdate(plot, 'y');
    assert.deepEqual(u['yaxis.range'], [1, 1], 'eager files fit their own data');
}

// ── Per-axis auto-fit is wired for the split analysis modes (source checks) ───
// The update-builder above only covers timeseries/phase2d; the analysis modes
// dispatch to their own pane-specific methods and each renders its own buttons.
{
    const pm = source; // plot-manager.js already read above
    assert.match(pm, /if \(plot\.mode === 'fft'\) return this\._autoScaleFftAxis/, 'dispatch: fft');
    assert.match(pm, /if \(plot\.mode === 'histogram'\) return this\._autoScaleHistogramAxis/, 'dispatch: histogram');
    assert.match(pm, /if \(plot\.mode === 'heatmap'\) return this\._autoScaleHeatmapAxis/, 'dispatch: heatmap');
    assert.match(pm, /if \(plot\.mode === 'temporal-profile'\) return this\._autoScaleTemporalProfileAxis/, 'dispatch: temporal-profile');
    assert.match(pm, /if \(plot\.mode === 'correlation'\) return this\._autoScaleCorrelationAxis/, 'dispatch: correlation');

    const read = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');
    // Heatmap's per-axis method fits X only (vertical axis is fixed categorical).
    assert.match(read('plots/methods/heatmap-methods.js'), /_autoScaleHeatmapAxis = function\(plot, axis\) \{\s*\n\s*if \(axis !== 'x'/,
        'heatmap per-axis fits X only');
    assert.match(read('plots/methods/fft-methods.js'), /_autoScaleFftAxis = function/, 'fft per-axis method exists');
    assert.match(read('plots/methods/fft-methods.js'), /_autoScaleAxisUpdate\(plot, 'y', \{ treatAsTimeseries: true \}\)/,
        'fft fit-Y also fits the time pane above the spectrum');
    assert.match(read('plots/methods/temporal-profile-methods.js'), /_autoScaleTemporalProfileAxis = function/, 'profile per-axis method exists');

    // Button visibility: the whole timeseries family gets the X button; every
    // mode but heatmap also gets Y; correlation joins phase2d for the 2D group.
    const inter = read('plots/methods/interaction-methods.js');
    assert.match(inter, /timeseriesToolsGroup\.appendChild\(createAutoscaleAxisButton\('x'\)\);\s*\n\s*if \(currentMode !== 'heatmap'\)/,
        'timeseries family: X always, Y unless heatmap');
    assert.match(inter, /if \(currentMode === 'phase2d' \|\| currentMode === 'correlation'\) \{\s*\n\s*viewGroup\.appendChild\(createAutoscaleAxisButton\('x'\)\)/,
        '2D group: phase2d and correlation get per-axis buttons');
}

console.log('Per-axis auto-scale tests passed.');
