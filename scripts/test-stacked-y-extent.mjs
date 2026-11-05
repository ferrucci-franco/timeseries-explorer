// Tests for the vertical extent of a STACKED time-series panel.
//
// A stacked panel is drawn with Plotly `stackgroup` + `stackgaps: 'interpolate'`
// (see `_timeseriesStackAttrs`), so what is on screen is the sum of the traces
// INTERPOLATED onto the union of their time grids — not the sum of same-index
// samples. Two variables of one file share a sampling grid and the two readings
// agree; two files almost never do, and pairing by array position then reads a
// stack top that was never drawn (Fit-Y / double-click landing below the data).
//
// The extent methods are PlotManager class methods, so we slice them out of the
// source and run them against a mock `this`, the way test-autoscale-axis.mjs does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const interactionSource = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');

const proto = {};
// Matched by name rather than by a full signature: parameter lists grow, and
// the slice should survive that.
const classMethod = (name) => {
    const sig = source.match(new RegExp(`^ {4}${name}\\(([^)]*)\\) \\{$`, 'm'));
    assert.ok(sig, `${name} is present`);
    const stop = source.indexOf('\n    }', sig.index) + '\n    }'.length;
    return source.slice(sig.index, stop).replace(sig[0], `proto.${name} = function(${sig[1]}) {`);
};
vm.runInNewContext([
    '_finiteStackedYExtentInXRange',
    '_finiteYExtentInXRange',
    '_timeseriesYExtentForSeries',
    '_extentInAxisUnits',
    '_axisIsLog',
    '_padAxisRange',
    '_padRange',
].map(classMethod).join('\n'), { proto });

// _coerceAxisValue lives with the interaction methods (date strings → epoch ms).
{
    const start = interactionSource.indexOf('proto._coerceAxisValue = function(value) {');
    assert.ok(start >= 0, '_coerceAxisValue is present');
    const stop = interactionSource.indexOf('\n};', start) + '\n};'.length;
    vm.runInNewContext(interactionSource.slice(start, stop), { proto, Date, Number, String });
}

class Harness {}
for (const [name, fn] of Object.entries(proto)) Harness.prototype[name] = fn;
const h = new Harness();

// The sliced methods build their result in the vm realm, so it is copied back
// into this one before being compared (deepStrictEqual checks the prototype).
const own = (extent) => (extent ? { min: extent.min, max: extent.max } : extent);
const stackExtent = (series, xRange = null, options = {}) =>
    own(h._finiteStackedYExtentInXRange(series, xRange, options));

// ── The P/Q pair: two files, two grids, one shared peak ──────────────────────
// Both signals are 0 everywhere but t = 4, where each reaches 100, so the drawn
// stacked area reaches 200 there. P is sampled every 1 s, Q every 4 ms; pairing
// by array position puts P's peak (index 4) next to Q's sample at t = 0.016.
const P = { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 100] };
const Q = (() => {
    const n = 1001;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = i * 0.004;
    y[n - 1] = 100;
    return { x, y };
})();

{
    const extent = stackExtent([P, Q]);
    assert.deepEqual(extent, { min: 0, max: 200 },
        'two grids: the stack top is the sum of the traces interpolated onto a common time axis');

    // What Fit-Y / double-click actually hand Plotly, end to end.
    const plot = { mode: 'timeseries', timeseriesStacked: true };
    const yExtent = h._timeseriesYExtentForSeries(plot, [P, Q], [P.y, Q.y], null);
    assert.deepEqual(Array.from(h._padAxisRange(yExtent, false)), [-10, 210],
        'the fitted Y range clears the top of the drawn stack (5% padding)');
}

// ── The same two signals as two variables of ONE file, on a shared grid ──────
// This case was always exact; it stays exact.
{
    const a = { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 100] };
    const b = { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 100] };
    assert.deepEqual(stackExtent([a, b]), { min: 0, max: 200 },
        'one shared grid: same answer as the two-file pair');
}

// ── An interior maximum of the interpolated sum ──────────────────────────────
// A coarse ramp (0 → 100 over 10 s) under a bump that peaks at t = 6, where the
// ramp is at 60: the stack reaches 260, at a time only one of the traces samples.
{
    const ramp = { x: [0, 10], y: [0, 100] };
    const bump = { x: [0, 2, 4, 6, 8, 10], y: [0, 0, 0, 200, 0, 0] };
    assert.deepEqual(stackExtent([ramp, bump]), { min: 0, max: 260 },
        'the sum is read at the union of the two grids, ramp interpolated');

    // ── The xRange window filter ─────────────────────────────────────────────
    assert.deepEqual(stackExtent([ramp, bump], [5, 7]), { min: 0, max: 260 },
        'a window around the bump keeps its peak');
    assert.deepEqual(stackExtent([ramp, bump], [7, 5]), { min: 0, max: 260 },
        'a reversed window is read the same way');
    assert.deepEqual(stackExtent([ramp, bump], [0, 1]), { min: 0, max: 10 },
        'a window before the bump sees only the ramp, at its right edge');
    // No breakpoint of either trace lies strictly inside [7, 9] except t = 8;
    // the stack is still drawn across the whole window, highest at its left edge
    // (ramp 70 + bump interpolated 100).
    assert.deepEqual(stackExtent([ramp, bump], [7, 9]), { min: 0, max: 170 },
        'the window edges are part of the drawn stack, not only the samples in it');
    assert.equal(stackExtent([ramp, bump], [20, 30]), null,
        'a window past every trace has nothing to fit');
}

// ── Disjoint support: outside its own support a trace contributes 0 ──────────
// `_applyTimeseriesStackZeroPadding` zero-pads a trace at the stack boundary
// times outside its support, so the drawn stack never extrapolates a trace's
// first/last value sideways. The extent has to agree.
{
    const early = { x: [0, 1, 2], y: [10, 10, 10] };
    const late = { x: [5, 6, 7], y: [20, 20, 20] };
    assert.deepEqual(stackExtent([early, late]), { min: 0, max: 20 },
        'the two plateaus never overlap, so 30 is never drawn');
    assert.deepEqual(stackExtent([early, late], [5, 7]), { min: 0, max: 20 },
        'inside the late trace\'s window the early trace contributes 0, not 10');
}

// ── Negative layers and the zero baseline ───────────────────────────────────
{
    const up = { x: [0, 2], y: [30, 30] };
    const down = { x: [1], y: [-50] };
    assert.deepEqual(stackExtent([up, down]), { min: -50, max: 30 },
        'the negative side is summed on its own, and 0 is always in the extent');
}

// ── A log Y axis: positive values only, and a floor at the lowest layer ──────
{
    const ramp = { x: [0, 1], y: [2, 4] };
    const spike = { x: [0.5], y: [8] };
    assert.deepEqual(stackExtent([ramp, spike], null, { positive: true }), { min: 2, max: 11 },
        'log: the top is the interpolated sum (3 + 8) and the floor the lowest positive layer');
    assert.equal(stackExtent([{ x: [0, 1], y: [0, 0] }], null, { positive: true }), null,
        'log: a stack with nothing positive in it has no range');
}

// ── A date-string xRange, as a calendar axis reports it ─────────────────────
{
    const day = 86400000;
    const base = Date.UTC(2020, 0, 1);
    const a = { x: [base, base + day, base + 2 * day], y: [0, 10, 0] };
    const b = { x: [base, base + 2 * day], y: [0, 0] };
    assert.deepEqual(stackExtent([a, b], ['2020-01-01', '2020-01-03']), { min: 0, max: 10 },
        'ISO window bounds are coerced to epoch ms before the sweep');
    assert.deepEqual(stackExtent([a, b], ['2020-01-01', '2020-01-01T12:00']), { min: 0, max: 5 },
        'half a day in: the interpolated value at the window edge');
}

// ── Degenerate input ────────────────────────────────────────────────────────
{
    assert.equal(stackExtent([]), null, 'no traces, no extent');
    assert.equal(stackExtent([{ x: [], y: [] }]), null, 'an empty trace is skipped');
    assert.equal(stackExtent([{ x: [NaN, NaN], y: [1, 2] }]), null, 'no finite sample, no extent');
    assert.deepEqual(stackExtent([{ x: [0, 1, 2], y: [1, NaN, 3] }]), { min: 0, max: 3 },
        'an internal gap is interpolated across, the way stackgaps: interpolate draws it');
    assert.deepEqual(stackExtent([{ x: [0, 0, 1], y: [5, 5, 5] }]), { min: 0, max: 5 },
        'repeated timestamps do not double-count');
}

// ── The non-stacked path is unchanged: samples, no interpolation ─────────────
{
    const ramp = { x: [0, 10], y: [0, 100] };
    assert.deepEqual(own(h._finiteYExtentInXRange([ramp], [2, 8])), null,
        'the plain Y extent still reads samples only');
    assert.deepEqual(own(h._finiteYExtentInXRange([ramp], [0, 10])), { min: 0, max: 100 },
        'the plain Y extent spans the samples in the window');
}

console.log('Stacked Y extent tests passed.');
