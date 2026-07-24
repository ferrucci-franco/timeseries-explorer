// Tests for the per-axis auto-scale update builder (timeseries). Fit-X fits X to
// the full data extent; Fit-Y fits Y to the data VISIBLE in the current X window
// (the reason a separate Y button is worth having). The method is a PlotManager
// class method, so we slice it out and run it against a mock `this`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const startMarker = '    _autoScaleAxisUpdate(plot, axis) {';
const start = source.indexOf(startMarker);
assert.ok(start >= 0, '_autoScaleAxisUpdate is present');
const end = source.indexOf('\n    _autoScalePlotAxis(', start + 1);
assert.ok(end > start, 'method end located');
const methodText = source.slice(start, end)
    .replace(startMarker, 'proto._autoScaleAxisUpdate = function(plot, axis) {');

const proto = {};
vm.runInNewContext(methodText, { proto });

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
