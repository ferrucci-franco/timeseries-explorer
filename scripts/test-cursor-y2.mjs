// Regression test for the measurement-cursor dot on a secondary-axis (Y2) trace.
// _cursorOverlayGeometry mapped the y-value against the primary axis (Y1) for
// every trace, so a Y2 curve's dot landed on the Y1 scale instead of on the
// curve. It must map through the axis the trace actually lives on.
//
// The method is a prototype function in interaction-methods.js; we slice it out
// and run it against a mock `this` with a stubbed Plotly _fullLayout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../src/plots/methods/interaction-methods.js', import.meta.url),
    'utf8',
);
const marker = 'proto._cursorOverlayGeometry = function';
const start = source.indexOf(marker);
assert.ok(start >= 0, '_cursorOverlayGeometry is present');
const end = source.indexOf('\nproto.', start + marker.length);
const methodText = source.slice(start, end >= 0 ? end : source.length);

const proto = {};
vm.runInNewContext(methodText, { proto });

// Overlaying Y2: same plot-area offset/length as Y1, DIFFERENT range.
const fullLayout = {
    xaxis:  { range: [0, 10],  _length: 100, _offset: 50 },
    yaxis:  { range: [0, 100], _length: 200, _offset: 20 }, // Y1
    yaxis2: { range: [0, 1],   _length: 200, _offset: 20 }, // Y2
};

function makeHarness(interpolatedY) {
    return {
        _cursorOverlayGeometry: proto._cursorOverlayGeometry,
        _viewDiv: () => ({ _fullLayout: fullLayout }),
        _coerceAxisValue: v => Number(v),
        _cursorSeriesForTrace: () => ({ times: [0, 10], values: [interpolatedY, interpolatedY] }),
        _interpolateAt: () => interpolatedY,
        _cursorInterpolationMode: () => 'linear',
        _traceYAxis: (traceState, plot) =>
            (plot?.timeseriesY2Enabled && traceState?.axis === 'y2') ? 'y2' : 'y',
    };
}

const topAxis = 20;
const length = 200;
const pixelFor = (value, [lo, hi]) => topAxis + (1 - ((value - lo) / (hi - lo))) * length;

// ── Y2 trace: dot must map through Y2's range [0,1], not Y1's [0,100] ─────────
{
    const y2Value = 0.5;
    const h = makeHarness(y2Value);
    const view = { plot: { timeseriesY2Enabled: true } };
    const trace = { axis: 'y2', fileId: 'f', varName: 'v' };
    const g = h._cursorOverlayGeometry(view, trace, 5, {});
    assert.ok(g, 'geometry produced');
    assert.equal(g.top, pixelFor(y2Value, [0, 1]), 'Y2 dot uses the Y2 range (on the curve)');
    // Guard against the old bug: mapping 0.5 on the Y1 range would be ~219px.
    assert.notEqual(g.top, pixelFor(y2Value, [0, 100]), 'Y2 dot is NOT placed on the Y1 scale');
}

// ── Y1 trace: unchanged, maps through Y1's range ─────────────────────────────
{
    const y1Value = 25;
    const h = makeHarness(y1Value);
    const view = { plot: { timeseriesY2Enabled: true } };
    const trace = { axis: 'y', fileId: 'f', varName: 'v' };
    const g = h._cursorOverlayGeometry(view, trace, 5, {});
    assert.equal(g.top, pixelFor(y1Value, [0, 100]), 'Y1 dot uses the Y1 range');
}

// ── Y2 requested but Y2 disabled ⇒ falls back to Y1 (no crash) ────────────────
{
    const h = makeHarness(25);
    const view = { plot: { timeseriesY2Enabled: false } };
    const trace = { axis: 'y2', fileId: 'f', varName: 'v' };
    const g = h._cursorOverlayGeometry(view, trace, 5, {});
    assert.equal(g.top, pixelFor(25, [0, 100]), 'no Y2 ⇒ primary axis');
}

console.log('Cursor Y2 geometry tests passed.');
