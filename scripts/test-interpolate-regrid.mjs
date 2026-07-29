// Kernel tests for the two sampling tools: filling holes without moving the
// samples (interpolate.js) and moving the samples onto a new grid (regrid.js).
import assert from 'node:assert/strict';
import {
    fillMissingValues,
    normalizeInterpolateParams,
    INTERPOLATE_MAX_GAP_UNLIMITED,
} from '../src/compute/kernels/interpolate.js';
import {
    buildResampleGrid,
    medianStep,
    normalizeResampleParams,
    resampleSourceAxis,
    resampleValues,
} from '../src/compute/kernels/regrid.js';
import { runResample, runDataToolStep } from '../src/compute/kernels/index.js';

const close = (actual, expected, label, tol = 1e-9) => {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (Number.isNaN(expected[i])) {
            assert.ok(Number.isNaN(actual[i]), `${label}[${i}] expected NaN, got ${actual[i]}`);
        } else {
            assert.ok(Math.abs(actual[i] - expected[i]) <= tol,
                `${label}[${i}] expected ${expected[i]}, got ${actual[i]}`);
        }
    }
};

const numericTime = (values) => ({ values, kind: 'numeric' });
const N = NaN;

// ── Filling holes ─────────────────────────────────────────────────────────

{
    const r = fillMissingValues([0, N, N, 3], numericTime([0, 1, 2, 3]), { method: 'linear' });
    close(r.values, [0, 1, 2, 3], 'linear fill on a uniform axis');
    assert.equal(r.filledCount, 2);
    assert.equal(r.filledRuns, 1);
    assert.equal(r.missingCount, 2);
    assert.equal(r.usedTimeAxis, true);
}

{
    // The bridge follows TIME, not row numbers: the hole sits at t = 10 out of a
    // [0, 100] interval, so it lands at 10 % of the rise, not at 50 %.
    const r = fillMissingValues([0, N, 100], numericTime([0, 10, 100]), { method: 'linear' });
    close(r.values, [0, 10, 100], 'linear fill respects an irregular axis');
}

{
    // With no usable axis the row number is the coordinate, and the same data
    // therefore lands in the middle.
    const r = fillMissingValues([0, N, 100], { values: null, kind: 'index' }, { method: 'linear' });
    close(r.values, [0, 50, 100], 'index axis bridges by row number');
    assert.equal(r.usedTimeAxis, false);
}

{
    // A backwards step makes the axis unusable, and it must not be trusted anyway.
    const r = fillMissingValues([0, N, 100], numericTime([0, 90, 10]), { method: 'linear' });
    assert.equal(r.usedTimeAxis, false, 'a non-ascending axis falls back to row numbers');
}

{
    const r = fillMissingValues([1, N, N, N, 5], numericTime([0, 1, 2, 3, 4]), { method: 'linear', maxGap: 2 });
    close(r.values, [1, N, N, N, 5], 'a run longer than maxGap is left alone');
    assert.equal(r.filledCount, 0);
    assert.equal(r.skippedRuns, 1);
    assert.equal(r.skippedCount, 3);
    assert.equal(r.longestSkipped, 3);
}

{
    const r = fillMissingValues([1, N, N, 4, N, 9], numericTime([0, 1, 2, 3, 4, 5]), { method: 'linear', maxGap: 1 });
    close(r.values, [1, N, N, 4, 6.5, 9], 'maxGap fills the short run and skips the long one');
    assert.equal(r.filledRuns, 1);
    assert.equal(r.skippedRuns, 1);
}

{
    const r = fillMissingValues([N, N, 3, 4], numericTime([0, 1, 2, 3]), { method: 'linear' });
    close(r.values, [N, N, 3, 4], 'a leading hole is extrapolation, so it is left alone');
    assert.equal(r.edgeSkippedCount, 2);

    const held = fillMissingValues([N, N, 3, 4, N], numericTime([0, 1, 2, 3, 4]), { method: 'linear', edges: 'hold' });
    close(held.values, [3, 3, 3, 4, 4], 'edges: hold extends the nearest known value');
    assert.equal(held.edgeFilledCount, 3);
}

{
    const previous = fillMissingValues([1, N, N, 4], numericTime([0, 1, 2, 3]), { method: 'previous' });
    close(previous.values, [1, 1, 1, 4], 'hold previous');
    const next = fillMissingValues([1, N, N, 4], numericTime([0, 1, 2, 3]), { method: 'next' });
    close(next.values, [1, 4, 4, 4], 'hold next');
    const nearest = fillMissingValues([1, N, N, 4], numericTime([0, 1, 2, 3]), { method: 'nearest' });
    close(nearest.values, [1, 1, 4, 4], 'nearest sample');
}

{
    // PCHIP's promise: never overshoot the values it joins. A step-like series is
    // where a natural spline would ring, so this is the case that proves it.
    const y = [0, 0, 0, 10, 10, 10];
    const withHole = [0, 0, N, 10, 10, 10];
    const r = fillMissingValues(withHole, numericTime([0, 1, 2, 3, 4, 5]), { method: 'pchip' });
    const filled = r.values[2];
    assert.ok(filled >= 0 && filled <= 10, `pchip stayed inside [0, 10] (got ${filled})`);
    assert.equal(y.length, 6);
}

{
    // On a straight line every method that claims to be exact for lines must be.
    const time = [0, 1, 2, 3, 4, 5, 6];
    const line = time.map(t => 3 * t + 1);
    for (const method of ['linear', 'pchip', 'akima', 'smooth']) {
        const holed = line.slice();
        holed[3] = NaN;
        const r = fillMissingValues(holed, numericTime(time), { method, window: 7 });
        assert.ok(Math.abs(r.values[3] - line[3]) < 1e-6,
            `${method} reproduces a straight line (got ${r.values[3]}, want ${line[3]})`);
    }
}

{
    // The smoothed fill is the one that ignores the two samples framing the hole
    // when they are noise. Endpoints pulled far off the trend must not drag the
    // bridge with them the way a linear one does.
    const time = Array.from({ length: 21 }, (_, i) => i);
    const trend = time.map(t => 2 * t);
    const noisy = trend.slice();
    // Both framing samples are off the same way, which is what a linear bridge
    // cannot recover from: it averages two errors instead of cancelling them.
    noisy[9] = trend[9] + 20;
    noisy[11] = trend[11] + 20;
    noisy[10] = NaN;

    const linear = fillMissingValues(noisy, numericTime(time), { method: 'linear' }).values[10];
    const smooth = fillMissingValues(noisy, numericTime(time), { method: 'smooth', window: 15 }).values[10];
    assert.ok(Math.abs(smooth - trend[10]) < Math.abs(linear - trend[10]),
        `smooth (${smooth}) is closer to the trend ${trend[10]} than linear (${linear})`);
}

{
    const r = fillMissingValues([1, 2, 3], numericTime([0, 1, 2]), { method: 'linear' });
    close(r.values, [1, 2, 3], 'a series with no holes is returned unchanged');
    assert.equal(r.filledCount, 0);
    assert.equal(r.missingCount, 0);
}

{
    const all = fillMissingValues([N, N, N], numericTime([0, 1, 2]), { method: 'linear', edges: 'hold' });
    close(all.values, [N, N, N], 'a series with nothing to anchor to stays missing');
}

{
    // Infinity is missing data too — a divide-by-zero upstream produces it, and it
    // is no more plottable than NaN.
    const r = fillMissingValues([0, Infinity, 2], numericTime([0, 1, 2]), { method: 'linear' });
    close(r.values, [0, 1, 2], 'non-finite is treated as missing');
}

{
    const p = normalizeInterpolateParams({ method: 'nope', maxGap: -3, edges: 'x', window: 2 });
    assert.equal(p.method, 'linear');
    assert.equal(p.maxGap, INTERPOLATE_MAX_GAP_UNLIMITED, 'a non-positive gap limit means no limit');
    assert.equal(p.edges, 'leave');
    assert.equal(p.window, 3, 'the window floor is three samples');
    assert.equal(normalizeInterpolateParams({ window: 5000 }).window, 1001, 'the window is capped');
}

{
    // The dispatch the worker and the fallback share must reach the same kernel.
    const step = runDataToolStep([0, N, 2], numericTime([0, 1, 2]), {
        tool: 'interpolate',
        params: { method: 'linear', maxGap: 10 },
    });
    close(step.values, [0, 1, 2], 'runDataToolStep routes the interpolate tool');
    assert.equal(step.meta.filledCount, 1);
}

// ── Resampling ────────────────────────────────────────────────────────────

{
    const x = Float64Array.from([0, 1, 2, 3, 4]);
    assert.equal(medianStep(x), 1);
    assert.equal(medianStep(Float64Array.from([0, 1, 2, 10])), 1, 'the median step ignores a gap');
}

{
    const x = Float64Array.from([0, 1, 2, 3, 4]);
    const { grid, step } = buildResampleGrid(x, { gridMode: 'step', step: 2 });
    close(grid, [0, 2, 4], 'a Δt that divides the span');
    assert.equal(step, 2);
}

{
    // The whole point of the tool: a Δt that is no fraction of the original one.
    const x = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { grid } = buildResampleGrid(x, { gridMode: 'step', step: 0.7 });
    assert.equal(grid.length, 15, 'floor(10 / 0.7) + 1 grid points');
    assert.ok(grid[grid.length - 1] <= 10, 'the last grid point never passes the last sample');
    close(Array.from(grid.slice(0, 3)), [0, 0.7, 1.4], 'a non-commensurate grid', 1e-12);
}

{
    const x = Float64Array.from([0, 1, 2, 3, 4]);
    const up = buildResampleGrid(x, { gridMode: 'factor', factor: 2 });
    assert.equal(up.step, 0.5, 'factor 2 halves the step');
    assert.equal(up.grid.length, 9);
    const down = buildResampleGrid(x, { gridMode: 'factor', factor: 0.5 });
    assert.equal(down.step, 2, 'factor 0.5 doubles it');

    const counted = buildResampleGrid(x, { gridMode: 'count', count: 5 });
    close(counted.grid, [0, 1, 2, 3, 4], 'an explicit sample count');
}

{
    const x = Float64Array.from([0, 1, 2, 3, 4]);
    for (const params of [{ gridMode: 'step', step: 0 }, { gridMode: 'step', step: -1 }]) {
        assert.throws(() => buildResampleGrid(x, params), /DataToolError|dataTool/,
            'a non-positive Δt is refused');
    }
    assert.throws(() => buildResampleGrid(x, { gridMode: 'step', step: 1e9 }), err =>
        err.code === 'dataToolResampleStepTooLarge', 'a Δt longer than the span is refused');
    assert.throws(() => buildResampleGrid(x, { gridMode: 'step', step: 1e-9 }), err =>
        err.code === 'dataToolResampleTooManyPoints', 'an absurd grid is refused');
}

{
    const x = Float64Array.from([0, 1, 2, 3, 4]);
    const y = Float64Array.from([0, 10, 20, 30, 40]);
    const { grid } = buildResampleGrid(x, { gridMode: 'step', step: 0.5 });
    const linear = resampleValues(y, x, grid, { method: 'linear' });
    close(linear.values, [0, 5, 10, 15, 20, 25, 30, 35, 40], 'upsampling a ramp is exact');
    assert.equal(linear.emptyCount, 0);

    for (const method of ['pchip', 'akima']) {
        const cubic = resampleValues(y, x, grid, { method });
        close(cubic.values, [0, 5, 10, 15, 20, 25, 30, 35, 40], `${method} is exact on a ramp`, 1e-9);
    }
}

{
    const x = Float64Array.from([0, 1, 2, 3]);
    const y = Float64Array.from([0, 10, 20, 30]);
    const grid = Float64Array.from([0, 0.4, 1.6, 3]);
    close(resampleValues(y, x, grid, { method: 'nearest' }).values, [0, 0, 20, 30], 'nearest');
    close(resampleValues(y, x, grid, { method: 'previous' }).values, [0, 0, 10, 30], 'hold previous');
}

{
    // Bin methods: ten source samples per output sample, bins centred on the grid.
    const x = Float64Array.from(Array.from({ length: 11 }, (_, i) => i));
    const y = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const grid = Float64Array.from([0, 5, 10]);
    // Bin around 5 spans [2.5, 7.5): samples 3..7 → mean 5, median 5, min 3, max 7.
    assert.equal(resampleValues(y, x, grid, { method: 'mean' }).values[1], 5);
    assert.equal(resampleValues(y, x, grid, { method: 'median' }).values[1], 5);
    assert.equal(resampleValues(y, x, grid, { method: 'min' }).values[1], 3);
    assert.equal(resampleValues(y, x, grid, { method: 'max' }).values[1], 7);
    // The first bin is half of one, and the last one closes on its right edge so
    // the final sample is never dropped.
    assert.equal(resampleValues(y, x, grid, { method: 'mean' }).values[0], 1, 'first bin [−2.5, 2.5)');
    assert.equal(resampleValues(y, x, grid, { method: 'max' }).values[2], 10, 'the last sample is included');
}

{
    // Aliasing, made concrete: a signal alternating ±1 every sample. Reading the
    // curve every second sample returns a constant +1 — a signal that is not
    // there. Averaging the bin returns ~0, which is what the fast component
    // actually contributes at that rate.
    const n = 101;
    const x = Float64Array.from(Array.from({ length: n }, (_, i) => i));
    const y = Float64Array.from(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1)));
    const grid = Float64Array.from(Array.from({ length: 26 }, (_, i) => i * 4));
    const point = resampleValues(y, x, grid, { method: 'nearest' }).values;
    const binned = resampleValues(y, x, grid, { method: 'mean' }).values;
    assert.ok(point.every(v => v === 1), 'point sampling aliases the alternation into a constant');
    for (const value of binned) assert.ok(Math.abs(value) < 0.5, 'bin averaging suppresses it');
}

{
    // A hole is not bridged: that is the interpolation tool's decision to make.
    const x = Float64Array.from([0, 1, 2, 3, 4]);
    const y = Float64Array.from([0, NaN, 20, 30, 40]);
    const grid = Float64Array.from([0, 0.5, 1.5, 2.5, 3.5]);
    const r = resampleValues(y, x, grid, { method: 'linear' });
    close(r.values, [0, NaN, NaN, 25, 35], 'target samples inside a hole come out missing');
    assert.equal(r.emptyCount, 2);
}

{
    const x = Float64Array.from([0, 1, 2, 3, 100]);
    const y = Float64Array.from([1, 1, 1, 1, 1]);
    // A bin between the last two samples has nothing in it at all.
    const grid = Float64Array.from([0, 20, 40, 60, 80, 100]);
    const r = resampleValues(y, x, grid, { method: 'mean' });
    assert.ok(Number.isNaN(r.values[2]), 'an empty bin is missing, not zero');
    assert.ok(r.emptyCount >= 1);
}

{
    const bad = Float64Array.from([0, 1, 1, 2]);
    assert.throws(() => resampleSourceAxis({ values: bad, kind: 'numeric' }, 4), err =>
        err.code === 'dataToolResampleTimeNotAscending', 'a duplicated timestamp is refused');
    assert.throws(() => resampleSourceAxis({ values: Float64Array.from([0, NaN, 2]), kind: 'numeric' }, 3), err =>
        err.code === 'dataToolResampleTimeInvalid', 'a non-numeric timestamp is refused');
    const synthetic = resampleSourceAxis({ values: null, kind: 'index' }, 4);
    close(synthetic.x, [0, 1, 2, 3], 'no axis means row numbers');
    assert.equal(synthetic.synthetic, true);
}

{
    // The batched entry point the worker and the inline fallback share.
    const time = { values: Float64Array.from([0, 1, 2, 3, 4]), kind: 'numeric' };
    const result = runResample({
        columns: [Float64Array.from([0, 10, 20, 30, 40]), Float64Array.from([0, 1, 4, 9, 16])],
        time,
        params: { gridMode: 'step', step: 2, method: 'linear' },
    });
    close(result.grid, [0, 2, 4], 'runResample builds one shared grid');
    assert.equal(result.columns.length, 2);
    close(result.columns[0], [0, 20, 40], 'first column');
    close(result.columns[1], [0, 4, 16], 'second column');
    assert.equal(result.sourceStep, 1);
    assert.deepEqual(result.emptyCounts, [0, 0]);
}

{
    const p = normalizeResampleParams({ gridMode: 'nope', method: 'nope', step: -1, factor: 0, count: 1 });
    assert.equal(p.gridMode, 'step');
    assert.equal(p.method, 'linear');
    assert.equal(p.step, 0);
    assert.equal(p.factor, 1);
    assert.equal(p.count, 0);
}

console.log('interpolate + regrid kernel tests passed');
