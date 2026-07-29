// Kernel tests for the detrend and digital-filter tools.
// The stability gate gets the most attention here: it is the one check whose
// failure mode is an output of ±Infinity rather than a wrong number.
import assert from 'node:assert/strict';
import {
    computeDetrend,
    normalizeDetrendParams,
    DETREND_MAX_ORDER,
} from '../src/compute/kernels/detrend.js';
import {
    applyFilter,
    denominatorPoles,
    filterInitialState,
    inspectFilter,
    normalizeFilterCoefficients,
    parseCoefficients,
    schurCohnStable,
} from '../src/compute/kernels/iir.js';
import { runDataToolStep } from '../src/compute/kernels/index.js';

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

// ── Detrend ───────────────────────────────────────────────────────────────

{
    const time = [0, 1, 2, 3, 4];
    const y = [10, 12, 14, 16, 18];   // exactly 10 + 2t
    const r = computeDetrend(y, numericTime(time), { method: 'linear' });
    close(r.values, [0, 0, 0, 0, 0], 'a straight line detrends to zero', 1e-9);
    assert.ok(Math.abs(r.slope - 2) < 1e-9, `slope reported in units per second (got ${r.slope})`);
    assert.equal(r.usedTimeAxis, true);
}

{
    // The residual plus the trend must reconstruct the input. That is what makes
    // "detrend" a subtraction rather than an unspecified transformation.
    const time = [0, 1, 2, 3, 4, 5];
    const y = [3, 9, 4, 11, 6, 13];
    const r = computeDetrend(y, numericTime(time), { method: 'linear' });
    let sum = 0;
    for (const value of r.values) sum += value;
    assert.ok(Math.abs(sum) < 1e-9, 'the least-squares residual has zero mean');
}

{
    const y = [1, 2, 3, 4];
    const r = computeDetrend(y, numericTime([0, 1, 2, 3]), { method: 'mean' });
    close(r.values, [-1.5, -0.5, 0.5, 1.5], 'mean removes the offset and nothing else');
    assert.equal(r.order, 0);
    assert.equal(r.slope, null, 'order 0 has no slope to report');
}

{
    const time = Array.from({ length: 11 }, (_, i) => i);
    const y = time.map(t => 5 + 2 * t - 0.5 * t * t);
    const r = computeDetrend(y, numericTime(time), { method: 'polynomial', order: 2 });
    for (const value of r.values) assert.ok(Math.abs(value) < 1e-8, `quadratic removed exactly (got ${value})`);
    // ...and a straight line cannot remove a quadratic, which is the reason the
    // order control exists.
    const linear = computeDetrend(y, numericTime(time), { method: 'linear' });
    assert.ok(Math.max(...Array.from(linear.values, Math.abs)) > 1,
        'a line leaves the curvature behind');
}

{
    // A datetime axis carries epoch milliseconds. Fitting on the raw abscissa
    // loses all precision; the centred and scaled one does not.
    const base = Date.UTC(2026, 0, 1);
    const time = Array.from({ length: 50 }, (_, i) => base + i * 60000);
    const y = time.map((t, i) => 100 + 0.5 * i);
    const r = computeDetrend(y, { values: time, kind: 'datetime' }, { method: 'linear' });
    for (const value of r.values) assert.ok(Math.abs(value) < 1e-6, `epoch-ms axis fits cleanly (got ${value})`);
    // 0.5 per sample at one sample per minute is 1/120 per second.
    assert.ok(Math.abs(r.slope - 0.5 / 60) < 1e-12, `slope converted out of milliseconds (got ${r.slope})`);
}

{
    const time = [0, 1, 2, 3, 4];
    const r = computeDetrend([10, N, 14, 16, 18], numericTime(time), { method: 'linear' });
    assert.ok(Number.isNaN(r.values[1]), 'a hole stays a hole');
    assert.equal(r.fitPoints, 4, 'the hole took no part in the fit');
    for (const i of [0, 2, 3, 4]) {
        assert.ok(Math.abs(r.values[i]) < 1e-9, 'the fit still lands on the line through the rest');
    }
}

{
    const r = computeDetrend([5, 7, 9], numericTime([0, 1, 2]), { method: 'firstSample' });
    close(r.values, [0, 2, 4], 'first sample zeroes the start');
}

{
    // Subtracting a moving-average baseline is a high-pass: a slow ramp with a
    // fast wiggle on top keeps the wiggle and loses the ramp.
    const n = 200;
    const y = Array.from({ length: n }, (_, i) => 0.05 * i + Math.sin(i));
    const r = computeDetrend(y, numericTime(Array.from({ length: n }, (_, i) => i)),
        { method: 'movingAverage', window: 21 });
    const middle = Array.from(r.values).slice(50, 150);
    const mean = middle.reduce((a, b) => a + b, 0) / middle.length;
    assert.ok(Math.abs(mean) < 0.05, `the ramp is gone (residual mean ${mean})`);
    assert.ok(Math.max(...middle.map(Math.abs)) > 0.5, 'the wiggle survives');
}

{
    const r = computeDetrend([], numericTime([]), { method: 'linear' });
    assert.equal(r.values.length, 0, 'an empty series is not an error');
    const constant = computeDetrend([4, 4, 4], numericTime([1, 1, 1]), { method: 'linear' });
    close(constant.values, [0, 0, 0], 'an axis with no spread still removes the mean');
}

{
    const p = normalizeDetrendParams({ method: 'nope', order: 99, window: 1 });
    assert.equal(p.method, 'linear');
    assert.equal(p.order, DETREND_MAX_ORDER, 'the order is capped');
    assert.equal(p.window, 3, 'the window floor is three samples');
}

{
    const step = runDataToolStep([10, 12, 14], numericTime([0, 1, 2]), {
        tool: 'detrend',
        params: { method: 'linear' },
    });
    close(step.values, [0, 0, 0], 'runDataToolStep routes the detrend tool');
    assert.ok(Math.abs(step.meta.slope - 2) < 1e-9);
}

// ── Coefficient parsing ───────────────────────────────────────────────────

{
    assert.deepEqual(parseCoefficients('1, -1.8, 0.81').values, [1, -1.8, 0.81]);
    assert.deepEqual(parseCoefficients('  1   -1.8\n0.81 ').values, [1, -1.8, 0.81], 'whitespace separated');
    assert.deepEqual(parseCoefficients('[1 -1.8 0.81]').values, [1, -1.8, 0.81], 'a MATLAB paste');
    assert.deepEqual(parseCoefficients('[1, -1.8, 0.81]').values, [1, -1.8, 0.81], 'a NumPy paste');
    assert.deepEqual(parseCoefficients('1e-3 2E2').values, [0.001, 200], 'exponents');
    const bad = parseCoefficients('1, x, 3');
    assert.equal(bad.values, null);
    assert.equal(bad.badToken, 'x', 'the offending token is named');
}

{
    const { b, a, order } = normalizeFilterCoefficients([2, 1], [4, 2]);
    close(b, [0.5, 0.25], 'b divided by a0');
    close(a, [1, 0.5], 'a normalized to a0 = 1');
    assert.equal(order, 1);
    // Both lists are padded to one length, which is what the recursion assumes.
    const padded = normalizeFilterCoefficients([1], [1, -0.5, 0.06]);
    assert.equal(padded.b.length, 3);
    close(padded.b, [1, 0, 0], 'b zero-padded');
    assert.throws(() => normalizeFilterCoefficients([1], [0, 1]), err =>
        err.code === 'dataToolFilterLeadingZero', 'a0 = 0 is not a difference equation');
}

// ── Stability: the gate ───────────────────────────────────────────────────

{
    // A pole at 0.9 is stable; the same filter with the pole pushed to 1.1 is not.
    assert.equal(schurCohnStable([1, -0.9]).stable, true, 'pole at 0.9');
    assert.equal(schurCohnStable([1, -1.1]).stable, false, 'pole at 1.1');
    // On the unit circle is NOT a pass: the recursion neither decays nor stays
    // bounded, and it is the singular point of the step-down itself.
    assert.equal(schurCohnStable([1, -1]).stable, false, 'pole exactly on the unit circle');
    assert.equal(schurCohnStable([1, 1]).stable, false, 'pole at -1');
    // A resonator just inside and just outside.
    assert.equal(schurCohnStable([1, -1.8, 0.81]).stable, true, 'double pole at 0.9');
    assert.equal(schurCohnStable([1, -2.2, 1.21]).stable, false, 'double pole at 1.1');
    assert.equal(schurCohnStable([1, -2, 1]).stable, false, 'double pole exactly on the circle');
    // An FIR has no poles at all and is stable by construction.
    assert.equal(schurCohnStable([1]).stable, true, 'FIR');
}

{
    // Schur–Cohn and root finding must agree about which side of the circle the
    // filter is on. They are computed by completely different routes, so this is
    // a real cross-check and not a tautology.
    const cases = [
        [1, -0.5], [1, 0.99], [1, -1.01], [1, -1.8, 0.81], [1, -2.2, 1.21],
        [1, -0.4, 0.3, -0.2], [1, 0.6, -1.4], [1, -2.4, 2.11, -0.72],
    ];
    for (const a of cases) {
        const schur = schurCohnStable(a).stable;
        const { maxRadius, converged } = denominatorPoles(a);
        assert.ok(converged, `root finder converged for [${a}]`);
        const byRoots = maxRadius < 1 - 1e-9;
        assert.equal(schur, byRoots, `[${a}]: Schur-Cohn says ${schur}, poles say ${byRoots} (max |z| = ${maxRadius})`);
    }
}

{
    const stable = inspectFilter([1], [1, -1.8, 0.81]);
    assert.equal(stable.stable, true);
    assert.equal(stable.code, '');
    assert.ok(Math.abs(stable.maxPoleRadius - 0.9) < 1e-6, `poles at 0.9 (got ${stable.maxPoleRadius})`);
    // H(1) = 1 / (1 - 1.8 + 0.81) = 100.
    assert.ok(Math.abs(stable.dcGain - 100) < 1e-6, `DC gain (got ${stable.dcGain})`);

    const unstable = inspectFilter([1], [1, -2.2, 1.21]);
    assert.equal(unstable.stable, false);
    assert.equal(unstable.code, 'dataToolFilterUnstable');
    assert.ok(Math.abs(unstable.maxPoleRadius - 1.1) < 1e-6,
        `the offending pole is located for the message (got ${unstable.maxPoleRadius})`);
}

{
    // The gate holds at the kernel too, not only in the panel: a definition
    // restored from a session cannot smuggle an unstable filter past it.
    assert.throws(() => applyFilter([1, 2, 3], { b: [1], a: [1, -1.1] }), err =>
        err.code === 'dataToolFilterUnstable', 'applyFilter refuses an unstable filter');
    assert.throws(() => runDataToolStep([1, 2, 3], { values: null, kind: 'index' }, {
        tool: 'filter', params: { b: [1], a: [1, -1.1] },
    }), err => err.code === 'dataToolFilterUnstable', 'the shared dispatch refuses it too');
}

// ── Running the filter ────────────────────────────────────────────────────

{
    // A pure FIR against the difference equation, computed by hand.
    const x = [1, 2, 3, 4, 5];
    const r = applyFilter(x, { b: [0.5, 0.5], a: [1], mode: 'forward' });
    // Steady-state initialization means the state starts as if x had been 1
    // forever, so y[0] = 1 rather than 0.5.
    close(r.values.slice(1), [1.5, 2.5, 3.5, 4.5], 'a two-tap average');
    assert.ok(Math.abs(r.values[0] - 1) < 1e-12, 'the first sample is not a step from zero');
    assert.equal(r.segments, 1);
    assert.equal(r.filteredCount, 5);
}

{
    // A constant in gives that constant out for any filter with unit DC gain —
    // the whole point of the steady-state initial conditions.
    const x = new Array(50).fill(300);
    for (const a of [[1, -0.9], [1, -1.8, 0.81]]) {
        const gain = a.reduce((sum, value) => sum + value, 0);
        const r = applyFilter(x, { b: [gain], a, mode: 'forward' });
        for (const value of r.values) {
            assert.ok(Math.abs(value - 300) < 1e-6, `constant 300 stays 300 (got ${value}) for a=[${a}]`);
        }
    }
}

{
    // An unstable filter would blow up here; a stable one must decay instead.
    const n = 4000;
    const x = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
    const r = applyFilter(x, { b: [1], a: [1, -0.99], mode: 'forward' });
    assert.ok(r.values.every(Number.isFinite), 'the impulse response stays finite');
    assert.ok(Math.abs(r.values[n - 1]) < Math.abs(r.values[10]), 'and decays');
}

{
    // Zero phase: a symmetric bump must come back symmetric and in the same
    // place. A forward-only pass moves it.
    const n = 101;
    const x = Array.from({ length: n }, (_, i) => Math.exp(-((i - 50) ** 2) / 50));
    const a = [1, -0.7];
    const b = [0.3];
    const zero = applyFilter(x, { b, a, mode: 'zeroPhase' }).values;
    const forward = applyFilter(x, { b, a, mode: 'forward' }).values;
    const argmax = list => { let best = 0; for (let i = 1; i < list.length; i++) if (list[i] > list[best]) best = i; return best; };
    assert.equal(argmax(zero), 50, 'zero phase leaves the peak where it was');
    assert.ok(argmax(forward) > 50, 'a forward pass moves it later');
    // Symmetry of the zero-phase result about the peak.
    for (let k = 1; k <= 20; k++) {
        assert.ok(Math.abs(zero[50 - k] - zero[50 + k]) < 1e-6, `zero-phase output is symmetric at ±${k}`);
    }
}

{
    // A hole restarts the recursion instead of poisoning everything after it.
    const x = [1, 1, 1, N, 1, 1, 1, 1];
    const r = applyFilter(x, { b: [1], a: [1, -0.5], mode: 'forward' });
    assert.ok(Number.isNaN(r.values[3]), 'the hole stays a hole');
    for (const i of [0, 1, 2, 4, 5, 6, 7]) {
        assert.ok(Number.isFinite(r.values[i]), `sample ${i} survives the hole`);
    }
    assert.equal(r.segments, 2, 'two runs filtered separately');
    assert.equal(r.skippedCount, 1);
    assert.equal(r.filteredCount, 7);
}

{
    const zi = filterInitialState(Float64Array.from([1, 0]), Float64Array.from([1, -0.5]));
    // For b = [1, 0], a = [1, -0.5]: (1 + a1)·zi = b1 − a1·b0 → 0.5·zi = 0.5.
    assert.ok(Math.abs(zi[0] - 1) < 1e-12, `steady state for a unit step (got ${zi[0]})`);
}

{
    // The identity filter.
    const x = [3, 1, 4, 1, 5];
    close(applyFilter(x, { b: [1], a: [1], mode: 'forward' }).values, x, 'b = a = 1 passes through');
}

// ── Initial conditions ────────────────────────────────────────────────────

{
    const x = new Array(40).fill(300);
    const b = [0.5];
    const a = [1, -0.5];   // unit DC gain

    const steady = applyFilter(x, { b, a, mode: 'forward', init: 'steady' }).values;
    assert.ok(Math.abs(steady[0] - 300) < 1e-9, 'steady state opens where the signal is');

    const zero = applyFilter(x, { b, a, mode: 'forward', init: 'zero' }).values;
    assert.ok(Math.abs(zero[0] - 150) < 1e-9, `at rest the first output is b0·x (got ${zero[0]})`);
    assert.ok(Math.abs(zero[39] - 300) < 1e-6, 'and it settles to the same place');
    assert.ok(zero[0] < zero[5] && zero[5] < zero[10], 'the startup transient is a real climb');

    // Manual reproduces either of them exactly, which is the check that the
    // vector really is the state and not something adjacent to it.
    const asZero = applyFilter(x, { b, a, mode: 'forward', init: 'manual', initState: [0] }).values;
    close(asZero, zero, 'manual [0] equals starting at rest');
    const ziForStep = filterInitialState(Float64Array.from([0.5, 0]), Float64Array.from([1, -0.5]));
    const asSteady = applyFilter(x, {
        b, a, mode: 'forward', init: 'manual', initState: [ziForStep[0] * 300],
    }).values;
    close(asSteady, steady, 'manual with the steady-state vector equals steady state', 1e-9);
}

{
    // A short manual state is padded rather than thrown: the panel refuses one,
    // but a session restored from an older file must still open.
    const r = applyFilter([1, 2, 3], { b: [1], a: [1, -0.5], init: 'manual', initState: [] });
    assert.ok(r.values.every(Number.isFinite), 'a missing manual state degrades to rest');
}

// ── Restarting across holes ───────────────────────────────────────────────

{
    const N9 = NaN;
    const values = [1, 1, 1, N9, 1, 1, 1];
    const b = [0.5];
    const a = [1, -0.5];

    // Default: rebuild after any hole. Both runs then start in steady state, so
    // both open at exactly 1.
    const restart = applyFilter(values, { b, a, mode: 'forward', restartGap: 0 });
    assert.equal(restart.restarts, 2);
    assert.equal(restart.carriedBreaks, 0);
    assert.ok(Math.abs(restart.values[4] - 1) < 1e-12, 'the second run opens in steady state');

    // Tolerating a one-sample hole carries the state straight over it.
    const carried = applyFilter(values, { b, a, mode: 'forward', restartGap: 1 });
    assert.equal(carried.restarts, 1, 'one continuous run');
    assert.equal(carried.carriedBreaks, 1, 'and the break is counted, not hidden');
    assert.ok(Number.isNaN(carried.values[3]), 'the hole is still a hole');

    // A hole longer than the tolerance still restarts.
    const longHole = [1, 1, 1, N9, N9, N9, 1, 1, 1];
    assert.equal(applyFilter(longHole, { b, a, restartGap: 1 }).restarts, 2, 'three missing > tolerance 1');
    assert.equal(applyFilter(longHole, { b, a, restartGap: 3 }).restarts, 1, 'three missing = tolerance 3');
}

{
    // A TIME gap with no missing rows: every row is present and finite, but the
    // clock jumped. This is the case that was invisible before — the recursion
    // cannot see it, so the axis has to be read for it.
    const values = [1, 1, 1, 1, 1, 1];
    const time = { values: Float64Array.from([0, 1, 2, 13, 14, 15]), kind: 'numeric' };
    const b = [0.5];
    const a = [1, -0.5];

    const seen = applyFilter(values, { b, a, time, restartGap: 0 });
    assert.equal(seen.restarts, 2, 'the ten-step jump is a break even with no NaN');
    assert.equal(seen.skippedCount, 0, 'and no sample was dropped');

    const tolerated = applyFilter(values, { b, a, time, restartGap: 20 });
    assert.equal(tolerated.restarts, 1, 'a large enough tolerance steps over it');
    assert.equal(tolerated.carriedBreaks, 1);

    // Without a time axis the same values look perfectly continuous.
    const blind = applyFilter(values, { b, a, restartGap: 0 });
    assert.equal(blind.restarts, 1, 'no axis, no visible break');
}

{
    // An irregular axis is reported, not refused: only the user knows whether a
    // cut-off that is not a fixed frequency matters for what they are doing.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const irregular = { values: Float64Array.from([0, 0.4, 1.9, 2.0, 5.5, 5.6, 9.9, 10.4, 17, 30]), kind: 'numeric' };
    const r = applyFilter(values, { b: [1], a: [1, -0.5], time: irregular });
    assert.equal(r.irregular, true, 'an irregular axis is flagged');
    assert.equal(r.irregularReason, 'irregularStep');
    assert.ok(r.values.every(Number.isFinite), 'but the filter still ran');

    const uniform = { values: Float64Array.from(Array.from({ length: 10 }, (_, i) => i)), kind: 'numeric' };
    assert.equal(applyFilter(values, { b: [1], a: [1, -0.5], time: uniform }).irregular, false);
}

{
    // Zero phase pads each contiguous run itself, so the restart threshold has
    // nothing to act on and every run is independent whatever it is set to.
    const N9 = NaN;
    const values = [1, 2, 3, 4, N9, 5, 6, 7, 8];
    const r = applyFilter(values, { b: [0.5], a: [1, -0.5], mode: 'zeroPhase', restartGap: 99 });
    assert.equal(r.segments, 2, 'two runs, filtered independently');
    assert.ok(Number.isNaN(r.values[4]));
    assert.ok(r.values.filter(Number.isFinite).length === 8);
}

console.log('detrend + digital filter kernel tests passed');
