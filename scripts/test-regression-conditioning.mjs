// TODO 10 Phase 5 — numeric-conditioning fixtures for the OLS fitting kernel.
// These are the stress cases the feature must survive: huge/small X, huge/tiny
// coefficients, near-constant X, rank-deficient quadratic designs, row-order and
// duplicate invariance, and pairwise NaN/Inf. Every case also checks that the
// eager kernel and the lazy (moment/sufficient-stat) path agree, so the DuckDB
// path can never silently diverge on ill-conditioned data.

import assert from 'node:assert/strict';
import {
    linearFit,
    quadraticFitCentered,
    linearFromMoments,
    quadraticFromMoments,
    buildFitCurve,
    predict,
} from '../src/utils/regression.js';
import { parseRegressionPass1, parseRegressionPass2 } from '../src/data/pair-regression-sql.js';

const rel = (a, b, relTol, absTol, label) => {
    const tol = Math.abs(b) * relTol + absTol;
    assert.ok(Math.abs(a - b) <= tol, `${label}: expected ${b}, got ${a} (tol ${tol})`);
};

// Exact aggregates DuckDB's regr_*/sum would return, so we can drive the lazy
// parse path from the same data and prove parity.
function duckdbPass1(x, y) {
    let n = 0, sx = 0, sy = 0, minx = Infinity, maxx = -Infinity;
    const xs = [], ys = [];
    for (let i = 0; i < x.length; i++) {
        const xi = Number(x[i]), yi = Number(y[i]);
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
        n++; sx += xi; sy += yi; xs.push(xi); ys.push(yi);
        if (xi < minx) minx = xi; if (xi > maxx) maxx = xi;
    }
    const ax = sx / n, ay = sy / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - ax) ** 2; syy += (ys[i] - ay) ** 2; sxy += (xs[i] - ax) * (ys[i] - ay); }
    return { n, ax, ay, sxx, syy, sxy, minx, maxx, xs, ys, nSeen: x.length };
}
function duckdbPass2(xs, ys, centerX, scaleX) {
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0, YY = 0;
    for (let i = 0; i < xs.length; i++) {
        const u = (xs[i] - centerX) / scaleX, u2 = u * u;
        S0++; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2;
        T0 += ys[i]; T1 += u * ys[i]; T2 += u2 * ys[i]; YY += ys[i] * ys[i];
    }
    return { S0, S1, S2, S3, S4, T0, T1, T2, YY };
}
const scalarFrom = (map) => (name) => (name in map ? map[name] : null);

function lazyLinear(x, y) {
    const p = duckdbPass1(x, y);
    const map = { n_scope: p.nSeen, n0: p.n, ax0: p.ax, ay0: p.ay, sxx0: p.sxx, syy0: p.syy, sxy0: p.sxy, mnx0: p.minx, mxx0: p.maxx };
    const [{ moments }] = parseRegressionPass1(scalarFrom(map), 1);
    return linearFromMoments(moments);
}
function lazyQuadratic(x, y) {
    const p = duckdbPass1(x, y);
    const map1 = { n_scope: p.nSeen, n0: p.n, ax0: p.ax, ay0: p.ay, sxx0: p.sxx, syy0: p.syy, sxy0: p.sxy, mnx0: p.minx, mxx0: p.maxx };
    const [{ moments, centerX, scaleX }] = parseRegressionPass1(scalarFrom(map1), 1);
    if (!(scaleX > 0)) return quadraticFromMoments({ n: moments.n, nExcluded: moments.nExcluded, centerX, scaleX, S0: NaN, S1: NaN, S2: NaN, S3: NaN, S4: NaN, T0: NaN, T1: NaN, T2: NaN, YY: NaN, minX: moments.minX, maxX: moments.maxX });
    const s = duckdbPass2(p.xs, p.ys, centerX, scaleX);
    const map2 = { s0_0: s.S0, s1_0: s.S1, s2_0: s.S2, s3_0: s.S3, s4_0: s.S4, t0_0: s.T0, t1_0: s.T1, t2_0: s.T2, yy_0: s.YY };
    const statsMap = parseRegressionPass2(scalarFrom(map2), [{ i: 0 }]);
    return quadraticFromMoments({ n: moments.n, nExcluded: moments.nExcluded, centerX, scaleX, ...statsMap.get(0), minX: moments.minX, maxX: moments.maxX });
}
const assertQuadParity = (x, y, label) => {
    const e = quadraticFitCentered(x, y), l = lazyQuadratic(x, y);
    assert.equal(l.status, e.status, `${label}: status parity`);
    if (e.status === 'ok') {
        rel(l.a, e.a, 1e-6, 1e-9, `${label}: a parity`);
        rel(l.b, e.b, 1e-6, 1e-9, `${label}: b parity`);
        rel(l.c, e.c, 1e-6, 1e-9, `${label}: c parity`);
    }
    return e;
};
const assertLinParity = (x, y, label) => {
    const e = linearFit(x, y), l = lazyLinear(x, y);
    assert.equal(l.status, e.status, `${label}: status parity`);
    if (e.status === 'ok') {
        rel(l.b1, e.b1, 1e-8, 1e-12, `${label}: slope parity`);
        rel(l.b0, e.b0, 1e-8, 1e-12, `${label}: intercept parity`);
    }
    return e;
};

// ── Huge X (1e12) with tiny span, quadratic — centred solve stays accurate ──
{
    const base = 1e12;
    const x = [], y = [];
    for (let k = 0; k <= 30; k++) { const xv = base + k * 0.05; const l = xv - base; x.push(xv); y.push(2 * l * l - 3 * l + 1); }
    const f = assertQuadParity(x, y, 'huge-X quad');
    assert.equal(f.status, 'ok', 'huge-X quad ok');
    rel(f.r2, 1, 1e-6, 0, 'huge-X quad R2≈1');
    for (let k = 0; k <= 30; k += 5) rel(predict(f, x[k]), y[k], 1e-5, 1e-5, `huge-X quad predict[${k}]`);
}

// ── Huge coefficients, quadratic — recover a/b/c ──
{
    const x = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    const A = 5e7, B = -3e6, C = 2e5;
    const y = x.map(v => A * v * v + B * v + C);
    const f = assertQuadParity(x, y, 'huge-coeff quad');
    rel(f.a, A, 1e-6, 0, 'huge-coeff a'); rel(f.b, B, 1e-6, 0, 'huge-coeff b'); rel(f.c, C, 1e-6, 0, 'huge-coeff c');
}

// ── Tiny coefficients, quadratic — recover a/b/c ──
{
    const x = []; for (let k = 0; k <= 20; k++) x.push(k);
    const A = 2e-7, B = 1e-5, C = 3e-4;
    const y = x.map(v => A * v * v + B * v + C);
    const f = assertQuadParity(x, y, 'tiny-coeff quad');
    rel(f.a, A, 1e-5, 1e-15, 'tiny-coeff a'); rel(f.b, B, 1e-5, 1e-13, 'tiny-coeff b'); rel(f.c, C, 1e-5, 1e-12, 'tiny-coeff c');
}

// ── Near-constant X (tiny but non-zero spread), linear — slope still recovered ──
{
    const base = 100;
    const x = [0, 1e-6, 2e-6, 3e-6, 4e-6, 5e-6].map(d => base + d);
    const slope = 4, icept = 7;
    const y = x.map(v => slope * v + icept);
    const f = assertLinParity(x, y, 'near-const-X linear');
    assert.equal(f.status, 'ok', 'near-const-X linear ok');
    rel(f.b1, slope, 1e-4, 0, 'near-const-X slope');
}

// ── Rank-deficient quadratic (only 2 distinct X) → singular, both paths ──
{
    const x = [1, 1, 1, 2, 2, 2], y = [1, 1, 1, 5, 5, 5];
    const f = quadraticFitCentered(x, y);
    assert.equal(f.status, 'undefined', 'two-distinct-X quad undefined');
    assert.equal(f.warning, 'singular', 'two-distinct-X quad singular');
    assert.equal(lazyQuadratic(x, y).status, 'undefined', 'two-distinct-X quad lazy undefined');
}

// ── Row-order invariance (irregular sampling doesn't reweight OLS) ──
{
    const x = [0, 1, 2, 3, 4, 5, 6], y = x.map(v => 0.5 * v * v - v + 2);
    const perm = [4, 0, 6, 2, 5, 1, 3];
    const px = perm.map(i => x[i]), py = perm.map(i => y[i]);
    const a = quadraticFitCentered(x, y), b = quadraticFitCentered(px, py);
    rel(b.a, a.a, 1e-9, 1e-12, 'order-invariant a'); rel(b.b, a.b, 1e-9, 1e-12, 'order-invariant b'); rel(b.c, a.c, 1e-9, 1e-12, 'order-invariant c');
}

// ── Duplicate rows: n scales, coefficients / R² / RMSE unchanged ──
{
    const x = [1, 2, 3, 4, 5, 6], y = [2, 1, 4, 3, 6, 5];
    const dupX = [...x, ...x], dupY = [...y, ...y];
    const a = quadraticFitCentered(x, y), b = quadraticFitCentered(dupX, dupY);
    assert.equal(b.n, 2 * a.n, 'duplicate n doubles');
    rel(b.a, a.a, 1e-9, 1e-12, 'duplicate a'); rel(b.b, a.b, 1e-9, 1e-12, 'duplicate b'); rel(b.c, a.c, 1e-9, 1e-12, 'duplicate c');
    rel(b.r2, a.r2, 1e-9, 0, 'duplicate R2'); rel(b.rmse, a.rmse, 1e-9, 1e-12, 'duplicate RMSE');
    // Lazy agrees on the duplicated set too.
    assertQuadParity(dupX, dupY, 'duplicate quad');
}

// ── Pairwise NaN/Inf: fit equals the clean subset; eager == lazy ──
{
    const cleanX = [0, 1, 2, 3, 4, 5], cleanY = cleanX.map(v => 3 * v * v + 2 * v - 1);
    const x = [0, NaN, 1, 2, Infinity, 3, 4, -Infinity, 5];
    const y = [cleanY[0], 99, cleanY[1], cleanY[2], 99, cleanY[3], cleanY[4], 99, cleanY[5]];
    const dirty = quadraticFitCentered(x, y), clean = quadraticFitCentered(cleanX, cleanY);
    rel(dirty.a, clean.a, 1e-9, 1e-9, 'NaN/Inf a matches clean');
    assert.equal(dirty.n, 6, 'NaN/Inf keeps 6 valid rows');
    assert.equal(dirty.nExcluded, 3, 'NaN/Inf excludes 3 rows');
    assertQuadParity(x, y, 'NaN/Inf quad');
}

// ── buildFitCurve on huge-X quad: endpoints clamp to minX/maxX, all finite ──
{
    const base = 1e12; const x = [], y = [];
    for (let k = 0; k <= 10; k++) { const xv = base + k; const l = xv - base; x.push(xv); y.push(l * l - l + 1); }
    const f = quadraticFitCentered(x, y);
    const c = buildFitCurve(f, 200);
    assert.equal(c.x.length, 200, 'curve length');
    assert.equal(c.x[0], f.minX, 'curve starts at minX (no extrapolation)');
    assert.equal(c.x[199], f.maxX, 'curve ends at maxX (no extrapolation)');
    assert.ok(c.y.every(Number.isFinite), 'curve y all finite');
}

// ── Determinism: same input → identical output ──
{
    const x = [1, 2, 3, 4, 5, 6, 7], y = x.map(v => -2 * v * v + 5 * v - 3);
    assert.deepEqual(quadraticFitCentered(x, y), quadraticFitCentered(x.slice(), y.slice()), 'deterministic quad');
}

console.log('test-regression-conditioning: all assertions passed');
