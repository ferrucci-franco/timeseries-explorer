// The exponential family of curve fits (utils/exp-fit.js): exact recovery on
// clean data, sane recovery on noisy data, shift handling, degenerate inputs,
// and the dispatch through utils/regression.js that both Curve Fit analyses use.
import assert from 'node:assert/strict';
import { expFamilyFit, expFamilyMinN, EXP_FAMILY_MODELS } from '../src/utils/exp-fit.js';
import { fitPair, predict, buildFitCurve } from '../src/utils/regression.js';

const close = (actual, expected, rel, label) => {
    const tol = rel * Math.max(1, Math.abs(expected));
    assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected}, got ${actual}`);
};
const range = (n, lo, hi) => Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));

// Deterministic noise (no Math.random: the test must not flake).
let seed = 12345;
const noise = (amp) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return ((seed / 2147483648) - 0.5) * 2 * amp;
};

assert.deepEqual([...EXP_FAMILY_MODELS].sort(), ['exponential', 'exponential-offset', 'first-order', 'first-order-offset']);
assert.equal(expFamilyMinN('exponential'), 3);
assert.equal(expFamilyMinN('first-order-offset'), 4);

// ── Clean data: every coefficient comes back ──
{
    const x = range(400, 0, 10);
    const f = expFamilyFit('exponential', x, x.map(v => 2.5 * Math.exp(-0.4 * v)));
    assert.equal(f.status, 'ok');
    close(f.a, 2.5, 1e-6, 'exp a');
    close(f.b, -0.4, 1e-6, 'exp b');
    close(f.timeConstant, 2.5, 1e-6, 'exp time constant');
    assert.ok(f.r2 > 1 - 1e-10, 'exp R² ≈ 1');
}
{
    const x = range(400, 0, 10);
    const f = expFamilyFit('exponential', x, x.map(v => -3 * Math.exp(0.15 * v)));
    close(f.a, -3, 1e-6, 'growing negative exp a');
    close(f.b, 0.15, 1e-6, 'growing negative exp b');
    assert.ok(Number.isNaN(f.timeConstant), 'a growing curve has no time constant');
}
{
    const x = range(300, 0, 5);
    const f = expFamilyFit('exponential-offset', x, x.map(v => 4 * Math.exp(-1.2 * v) + 7));
    close(f.a, 4, 1e-6, 'exp+offset a');
    close(f.b, -1.2, 1e-6, 'exp+offset b');
    close(f.c, 7, 1e-6, 'exp+offset c');
}
{
    // K·(1 − e^(α t)), the form asked for: a first-order step response.
    const t = range(500, 0, 60);
    const f = expFamilyFit('first-order', t, t.map(v => 2.05 * (1 - Math.exp(-v / 12))));
    close(f.K, 2.05, 1e-6, 'first-order K');
    close(f.alpha, -1 / 12, 1e-6, 'first-order α');
    close(f.timeConstant, 12, 1e-6, 'first-order τ');
    assert.equal(f.y0, 0);
}
{
    const t = range(500, 0, 3600);
    const f = expFamilyFit('first-order-offset', t, t.map(v => 0.3 + 1.8 * (1 - Math.exp(-v / 900))));
    close(f.K, 1.8, 1e-6, 'first-order+offset K');
    close(f.y0, 0.3, 1e-6, 'first-order+offset y₀');
    close(f.timeConstant, 900, 1e-6, 'first-order+offset τ');
}

// ── Noisy data: close, not exact ──
{
    const t = range(2000, 0, 100);
    const y = t.map(v => 5 * (1 - Math.exp(-v / 20)) + noise(0.05));
    const f = expFamilyFit('first-order', t, y);
    close(f.K, 5, 0.01, 'noisy K');
    close(f.timeConstant, 20, 0.02, 'noisy τ');
    assert.ok(f.r2 > 0.999, 'noisy R² high');
    assert.ok(f.rmse < 0.05, 'RMSE about the noise level');
}

// ── Scale: the same transient in milliseconds since 2026 (a calendar axis) ──
{
    const t0 = Date.UTC(2026, 10, 10, 17, 8);
    const t = range(300, t0, t0 + 3600e3);
    const y = t.map(v => 4 * Math.exp(-(v - t0) / 600e3) + 1);
    const f = expFamilyFit('exponential-offset', t, y);
    assert.equal(f.status, 'ok');
    close(f.b, -1 / 600e3, 1e-6, 'rate on a ms axis');
    close(f.c, 1, 1e-6, 'offset on a ms axis');
    // a is huge there (e^(t0/600e3)) and may overflow; the curve must not.
    close(predict(f, t[150]), y[150], 1e-7, 'prediction stays exact far from x = 0');
    const curve = buildFitCurve(f, 50);
    assert.equal(curve.x.length, 50);
    assert.ok(curve.y.every(Number.isFinite), 'the drawn curve is finite');
}

// ── Excluded rows and degenerate inputs ──
{
    const x = [0, 1, 2, NaN, 4, 5, 6];
    const y = x.map(v => 2 * Math.exp(-0.5 * v));
    y[2] = Infinity;
    const f = expFamilyFit('exponential', x, y);
    assert.equal(f.n, 5);
    assert.equal(f.nExcluded, 2);
    close(f.b, -0.5, 1e-6, 'exp with excluded rows');
}
assert.equal(expFamilyFit('exponential', [1, 2], [1, 2]).warning, 'insufficient-n');
assert.equal(expFamilyFit('first-order-offset', [1, 1, 1, 1, 1], [1, 2, 3, 4, 5]).warning, 'x-constant');
{
    const f = expFamilyFit('exponential-offset', [0, 1, 2, 3, 4], [3, 3, 3, 3, 3]);
    assert.ok(f.status !== 'ok' || f.warning === 'y-constant', 'a constant Y is never presented as a good fit');
}

// ── Dispatch through regression.js ──
{
    const x = range(100, 0, 4);
    const y = x.map(v => 1 - Math.exp(-2 * v));
    const f = fitPair('first-order', x, y);
    assert.equal(f.model, 'first-order');
    close(predict(f, 1), 1 - Math.exp(-2), 1e-6, 'predict through regression.js');
    const curve = buildFitCurve(f, 20);
    close(curve.x[0], 0, 0, 'curve starts at min x');
    close(curve.x[19], 4, 1e-12, 'curve ends at max x');
}

console.log('exp-fit tests passed');
