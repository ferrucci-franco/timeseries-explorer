// Kernel tests for the two sampling tools: filling holes without moving the
// samples (interpolate.js) and moving the samples onto a new grid (regrid.js).
import assert from 'node:assert/strict';
import {
    fillMissingValues,
    missingRuns,
    normalizeInterpolateParams,
    summariseMissing,
    INTERPOLATE_MAX_GAP_UNLIMITED,
} from '../src/compute/kernels/interpolate.js';
import {
    buildResampleGrid,
    detectRegularSampling,
    medianStep,
    normalizeResampleParams,
    planResampleGrid,
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
    // A REPEATED timestamp is not a broken axis. Every Modelica result has one at
    // the end of the simulation and two at every event, so rejecting ties sent
    // the app's own example down the row-number path and then blamed its clock.
    const time = [0, 1, 2, 2, 3, 4, 4];
    const r = fillMissingValues([0, 10, N, 20, 30, 40, 40], numericTime(time), { method: 'linear' });
    assert.equal(r.usedTimeAxis, true, 'a repeated timestamp keeps the time axis');
    assert.equal(r.filledCount, 1);
    assert.ok(Number.isFinite(r.values[2]), 'the hole beside the repeat is still filled');

    // And the cubic estimators must not build a secant across the zero-width
    // interval the repeat creates.
    for (const method of ['pchip', 'akima']) {
        const line = time.map(t => 3 * t + 1);
        line[2] = NaN;
        const filled = fillMissingValues(line, numericTime(time), { method });
        assert.ok(Math.abs(filled.values[2] - 7) < 1e-6,
            `${method} still reproduces a line across a repeated timestamp (got ${filled.values[2]})`);
    }
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

// ── Counting a fill without performing it ─────────────────────────────────

{
    const runs = missingRuns([N, 1, 2, N, N, 3, N, N, N, 4, N]);
    assert.deepEqual(runs, [
        { start: 0, length: 1, edge: true },
        { start: 3, length: 2, edge: false },
        { start: 6, length: 3, edge: false },
        { start: 10, length: 1, edge: true },
    ], 'runs, with the ones touching an end marked');
}

{
    // The live label in the panel is counted from the runs; the result comes from
    // the fill. If those two ever disagreed the panel would be lying, so they are
    // checked against each other across the whole parameter space that matters.
    const time = Array.from({ length: 24 }, (_, i) => i);
    const values = Array.from({ length: 24 }, (_, i) => i * 2);
    for (const hole of [[0, 1], [2, 3], [7, 1], [12, 5], [22, 2]]) {
        for (let k = 0; k < hole[1]; k++) values[hole[0] + k] = NaN;
    }
    const runs = missingRuns(values);
    for (const maxGap of [1, 2, 3, 5, 100, 0]) {
        for (const edges of ['leave', 'hold']) {
            const params = { method: 'linear', maxGap, edges };
            const predicted = summariseMissing(runs, params);
            const actual = fillMissingValues(values, numericTime(time), params);
            const label = `maxGap=${maxGap} edges=${edges}`;
            assert.equal(predicted.filled, actual.filledCount, `${label}: filled count`);
            assert.equal(predicted.skipped, actual.skippedCount, `${label}: skipped count`);
            assert.equal(predicted.runsFilled, actual.filledRuns, `${label}: filled runs`);
            assert.equal(predicted.runsSkipped, actual.skippedRuns, `${label}: skipped runs`);
            assert.equal(predicted.missing, actual.missingCount, `${label}: total missing`);
            assert.equal(predicted.edgeFilled, actual.edgeFilledCount, `${label}: edge filled`);
            assert.equal(predicted.edgeSkipped, actual.edgeSkippedCount, `${label}: edge skipped`);
            // The prediction must also match what the OUTPUT actually contains.
            let became = 0;
            for (let i = 0; i < values.length; i++) {
                if (!Number.isFinite(values[i]) && Number.isFinite(actual.values[i])) became++;
            }
            assert.equal(predicted.filled, became, `${label}: samples that really became finite`);
        }
    }
}

{
    // A series with nothing missing: no runs, and the summary says zero rather
    // than anything that could be mistaken for work done.
    const runs = missingRuns([1, 2, 3, 4]);
    assert.deepEqual(runs, []);
    const summary = summariseMissing(runs, { method: 'linear' });
    assert.equal(summary.missing, 0);
    assert.equal(summary.filled, 0);
    assert.equal(summary.runsFilled, 0);
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

// ── "Complete missing timestamps" only when Δt is beyond doubt ─────────────

{
    // The promise of the mode is that the file's own step is not a guess, so the
    // test is strict: every step must be a whole multiple of one Δt. Zero (a
    // repeated timestamp) and k (k−1 absent rows) qualify; 1.4Δt does not.
    const clean = detectRegularSampling(Float64Array.from([0, 1, 2, 3, 4]));
    assert.equal(clean.ok, true);
    assert.equal(clean.step, 1);
    assert.equal(clean.gaps, 0);
    assert.equal(clean.missing, 0);
    assert.equal(clean.repeats, 0);

    // The reported file: absent rows only.
    const gapped = detectRegularSampling(Float64Array.from([0, 1, 2, 3, 20, 21, 22]));
    assert.equal(gapped.ok, true, 'absent rows leave the step unambiguous');
    assert.equal(gapped.step, 1);
    assert.equal(gapped.gaps, 1);
    assert.equal(gapped.missing, 16);

    // A Modelica result: repeated final timestamp.
    const repeated = detectRegularSampling(Float64Array.from([0, 1, 2, 3, 4, 4]));
    assert.equal(repeated.ok, true, 'a repeated timestamp leaves the step unambiguous');
    assert.equal(repeated.repeats, 1);
    assert.equal(repeated.missing, 0);

    // Both at once, which is the general case this mode exists for.
    const both = detectRegularSampling(Float64Array.from([0, 1, 2, 2, 5, 6, 6]));
    assert.equal(both.ok, true);
    assert.equal(both.repeats, 2);
    assert.equal(both.gaps, 1);
    assert.equal(both.missing, 2, 't = 3 and 4 are absent');

    // And the cases where the step WOULD be a guess.
    assert.equal(detectRegularSampling(Float64Array.from([0, 1, 2.4, 3.4, 4.4])).ok, false,
        'a step of 1.4 Δt is on no sampling at all');
    assert.equal(detectRegularSampling(Float64Array.from([0, 1, 2.4, 3.4, 4.4])).reason, 'irregularStep');
    assert.equal(detectRegularSampling(Float64Array.from([0, 1, 0.5, 2])).reason, 'nonMonotonic');
    assert.equal(detectRegularSampling(Float64Array.from([0, 1])).reason, 'tooFewSamples');

    // The tolerance is tight on purpose. 0.05% of the step passes, 1% does not.
    assert.equal(detectRegularSampling(Float64Array.from([0, 1, 2, 3.0005, 4.0005])).ok, true,
        'ordinary rounding in a printed timestamp still passes');
    assert.equal(detectRegularSampling(Float64Array.from([0, 1, 2, 3.01, 4.01])).ok, false,
        'a per-cent-level wobble does not — the mode would be guessing');
}

{
    // The mode resamples at exactly the detected step, so the grid holds every
    // implied timestamp once: 7 rows spanning 0…22 become 23.
    const x = Float64Array.from([0, 1, 2, 3, 20, 21, 22]);
    const { grid, step } = buildResampleGrid(x, { gridMode: 'complete' });
    assert.equal(step, 1, 'the file’s own step, not one the user typed');
    assert.equal(grid.length, 23);
    assert.equal(grid[0], 0);
    assert.equal(grid[22], 22);

    // A repeated timestamp collapses, because a uniform grid has one point per step.
    const repeated = buildResampleGrid(Float64Array.from([0, 1, 2, 3, 4, 4]), { gridMode: 'complete' });
    assert.equal(repeated.grid.length, 5, 'six rows, five distinct timestamps');

    // With no usable step there is nothing to complete, and it says so rather than
    // inventing one.
    assert.throws(
        () => planResampleGrid({ span: 5, sourceStep: NaN, params: { gridMode: 'complete' } }),
        err => err.code === 'dataToolResampleNoStep',
    );
}

{
    // The timestamps must come back looking like the file's own. The step is
    // recovered as the median of parsed decimals, so it is really
    // 0.00099999999999989 — stepping out from the start multiplies that error by
    // the sample index and the last timestamp lands on 19.999999999997797, with
    // every one before it similarly frayed. A mode that promises the file's own
    // timestamps cannot ship that.
    const n = 20001;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Number((i * 0.001).toFixed(3));
    const { grid, step } = buildResampleGrid(x, { gridMode: 'complete' });
    assert.equal(grid.length, n);
    assert.equal(grid[0], 0, 'starts exactly where the file does');
    assert.equal(grid[n - 1], 20, 'and ends exactly where the file does');
    // Every point must match the value the file itself would have printed.
    for (const i of [1, 2899, 10000, 19999]) {
        assert.equal(grid[i], Number((i * 0.001).toFixed(3)), `grid[${i}] is the file's own timestamp`);
    }
    assert.ok(Math.abs(step - 0.001) < 1e-12);

    // A step-defined grid keeps the step the user asked for, exactly.
    const asked = buildResampleGrid(x, { gridMode: 'step', step: 0.25 });
    assert.equal(asked.step, 0.25, 'the typed step is authoritative, not the span');
    assert.equal(asked.grid[1], 0.25);
    assert.ok(asked.grid[asked.grid.length - 1] <= 20, 'and never runs past the source');

    // Number of samples is span-defined too, so it also pins both ends.
    const counted = buildResampleGrid(x, { gridMode: 'count', count: 5 });
    assert.equal(counted.grid[0], 0);
    assert.equal(counted.grid[4], 20);
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
    // Absent ROWS are not missing values, and a point method must reach across
    // them — a uniform grid has to have a value at every step. What it must not do
    // is stay quiet: bridgedCount is how the panel gets to say how much of the
    // result was reached for rather than measured. This is the shape of the file
    // that prompted "fill missing data does not work": no NaN anywhere, just a
    // stretch the logger skipped.
    const gappedX = Float64Array.from([0, 1, 2, 3, 20, 21, 22]);
    const gappedY = Float64Array.from([0, 1, 2, 3, 20, 21, 22]);
    const gapped = buildResampleGrid(gappedX, { gridMode: 'step', step: 1 });
    assert.equal(gapped.sourceStep, 1);
    // Targets at t = 4 … 19 all sit inside the one wide interval [3, 20].
    const GAP_TARGETS = 16;

    // The DEFAULT leaves them alone. That is what makes the point methods agree
    // with the bin methods, and what lets the NaN-filling tool own the bridging —
    // with a method, a length limit and an edge policy, none of which exist here.
    const left = resampleValues(gappedY, gappedX, gapped.grid, { method: 'linear', sourceStep: gapped.sourceStep });
    assert.equal(left.gapLeftCount, GAP_TARGETS, 'the gap is left empty by default');
    assert.equal(left.bridgedCount, 0, 'and nothing is reported as bridged');
    assert.equal(left.emptyCount, 0, 'this is not the NaN-surrounded case');
    for (let g = 0; g < gapped.grid.length; g++) {
        const t = gapped.grid[g];
        const inGap = t > 3 && t < 20;
        assert.equal(Number.isFinite(left.values[g]), !inGap, `t = ${t} ${inGap ? 'stays NaN' : 'has a value'}`);
    }

    // Asking for it explicitly still works, and is still counted.
    const bridged = resampleValues(gappedY, gappedX, gapped.grid,
        { method: 'linear', gapPolicy: 'bridge', sourceStep: gapped.sourceStep });
    assert.equal(bridged.bridgedCount, GAP_TARGETS, 'every target inside the gap is reported as bridged');
    assert.equal(bridged.gapLeftCount, 0);
    assert.ok(bridged.values.every(Number.isFinite), 'and they do get values');

    // Without the nominal step there is nothing to compare against, so no claim is
    // made rather than a wrong one — and nothing is refused on a guess.
    const blind = resampleValues(gappedY, gappedX, gapped.grid, { method: 'linear' });
    assert.equal(blind.bridgedCount, 0, 'no nominal step, no bridging claim');
    assert.equal(blind.gapLeftCount, 0, 'and no gap refused on a guess');
    assert.ok(blind.values.every(Number.isFinite));

    // An evenly sampled file has no gaps, so the policy changes nothing for it.
    const cleanX = Float64Array.from([0, 1, 2, 3, 4]);
    const cleanY = Float64Array.from([0, 1, 2, 3, 4]);
    const clean = buildResampleGrid(cleanX, { gridMode: 'step', step: 0.5 });
    for (const gapPolicy of ['leave', 'bridge']) {
        const r = resampleValues(cleanY, cleanX, clean.grid,
            { method: 'linear', gapPolicy, sourceStep: clean.sourceStep });
        assert.equal(r.bridgedCount, 0, `${gapPolicy}: nothing to reach across`);
        assert.equal(r.gapLeftCount, 0, `${gapPolicy}: nothing to leave`);
        assert.ok(r.values.every(Number.isFinite), `${gapPolicy}: a clean file is unaffected`);
    }

    // Bin methods never reach across anything, so the policy is a no-op for them:
    // an interval holding no samples was already empty.
    for (const gapPolicy of ['leave', 'bridge']) {
        const binned = resampleValues(gappedY, gappedX, gapped.grid,
            { method: 'mean', gapPolicy, sourceStep: gapped.sourceStep });
        assert.equal(binned.bridgedCount, 0, `mean/${gapPolicy}: never bridges`);
        assert.equal(binned.gapLeftCount, 0, `mean/${gapPolicy}: nothing attributed to the policy`);
        assert.ok(binned.emptyCount > 0, `mean/${gapPolicy}: reports the same gap as empty instead`);
    }

    // runResample threads the nominal step to every column, so they all judge
    // "wider than a sampling step" against the same number.
    const batch = runResample({
        columns: [gappedY, gappedY],
        time: { values: gappedX, kind: 'numeric' },
        params: { gridMode: 'step', step: 1, method: 'linear', gapPolicy: 'bridge' },
    });
    assert.deepEqual(batch.bridgedCounts, [GAP_TARGETS, GAP_TARGETS], 'every column is judged alike');
    const batchLeft = runResample({
        columns: [gappedY, gappedY],
        time: { values: gappedX, kind: 'numeric' },
        params: { gridMode: 'step', step: 1, method: 'linear' },
    });
    assert.deepEqual(batchLeft.gapLeftCounts, [GAP_TARGETS, GAP_TARGETS]);

    // And the pairing the default exists for: resample leaving the gap, then fill
    // the NaN it produced. This is the two-step path end to end.
    const filled = fillMissingValues(left.values, { values: gapped.grid, kind: 'numeric' },
        { method: 'linear', maxGap: 100 });
    assert.equal(filled.filledCount, GAP_TARGETS, 'the filler takes over exactly where resampling stopped');
    assert.ok(filled.values.every(Number.isFinite), 'and the series comes out complete');
    // ...and with a limit shorter than the gap, it refuses — which is the control
    // that bridging inside the resampler cannot offer at all.
    assert.equal(
        fillMissingValues(left.values, { values: gapped.grid, kind: 'numeric' },
            { method: 'linear', maxGap: 5 }).filledCount,
        0,
        'a limit shorter than the gap leaves it alone',
    );
}

{
    // A repeated timestamp is accepted; only a backwards one is refused. Every
    // Modelica result repeats its final timestamp, and two more at every event,
    // so this is the difference between supporting the app's home format and not.
    const repeated = Float64Array.from([0, 1, 1, 2]);
    assert.equal(resampleSourceAxis({ values: repeated, kind: 'numeric' }, 4).x, repeated,
        'a repeated timestamp is accepted');
    assert.throws(() => resampleSourceAxis({ values: Float64Array.from([0, 2, 1]), kind: 'numeric' }, 3), err =>
        err.code === 'dataToolResampleTimeNotAscending', 'a backwards timestamp is refused');
    assert.throws(() => resampleSourceAxis({ values: Float64Array.from([0, NaN, 2]), kind: 'numeric' }, 3), err =>
        err.code === 'dataToolResampleTimeInvalid', 'a non-numeric timestamp is refused');
    const synthetic = resampleSourceAxis({ values: null, kind: 'index' }, 4);
    close(synthetic.x, [0, 1, 2, 3], 'no axis means row numbers');
    assert.equal(synthetic.synthetic, true);
}

{
    // The shape a Modelica event writes: a step, sampled twice at the same
    // instant with the value before it and the value after it.
    const x = Float64Array.from([0, 1, 2, 2, 3, 4]);
    const y = Float64Array.from([0, 0, 0, 10, 10, 10]);
    const grid = Float64Array.from([0, 1, 2, 3, 4]);
    // At t = 2 the post-event value applies: a signal read at the instant it
    // switches has already switched.
    close(resampleValues(y, x, grid, { method: 'linear' }).values, [0, 0, 10, 10, 10],
        'a point method reads the value after the event');
    close(resampleValues(y, x, grid, { method: 'previous' }).values, [0, 0, 10, 10, 10],
        'hold previous agrees at the event');
    // Bin methods never had a problem: they just aggregate whatever is in range.
    assert.equal(resampleValues(y, x, grid, { method: 'mean' }).values[2], 5,
        'a bin straddling the event averages both sides of it');
    for (const method of ['pchip', 'akima']) {
        const r = resampleValues(y, x, grid, { method });
        assert.ok(r.values.every(Number.isFinite), `${method} survives a repeated timestamp`);
        assert.equal(r.emptyCount, 0);
    }
}

{
    // The pendulum's exact shape: a clean grid whose FINAL timestamp is repeated.
    const n = 201;
    const x = Float64Array.from([...Array.from({ length: n }, (_, i) => i * 0.1), 20]);
    const y = Float64Array.from([...Array.from({ length: n }, (_, i) => i), n - 1]);
    const { grid } = buildResampleGrid(x, { gridMode: 'step', step: 0.25 });
    const r = resampleValues(y, x, grid, { method: 'linear' });
    assert.equal(grid.length, 81);
    assert.equal(r.emptyCount, 0, 'a repeated final timestamp leaves no holes');
    assert.equal(r.values[0], 0);
    assert.equal(r.values[grid.length - 1], n - 1, 'the last grid point lands on the last sample');
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
