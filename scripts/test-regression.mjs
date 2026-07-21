import assert from 'node:assert/strict';
import {
    linearFit,
    quadraticFitCentered,
    regressionMetrics,
    buildFitCurve,
    predict,
    fitPair,
    FIT_CURVE_POINTS,
} from '../src/utils/regression.js';

const close = (actual, expected, tolerance, label) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`,
    );
};

// ── Linear: known slope/intercept ──
{
    // y = 3x + 2 exactly
    const x = [0, 1, 2, 3, 4, 5];
    const y = x.map((v) => 3 * v + 2);
    const f = linearFit(x, y);
    assert.equal(f.status, 'ok', 'exact linear is ok');
    close(f.b1, 3, 1e-12, 'linear slope');
    close(f.b0, 2, 1e-12, 'linear intercept');
    close(f.r2, 1, 1e-12, 'linear R2=1');
    close(f.rmse, 0, 1e-9, 'linear RMSE=0');
    close(f.r, 1, 1e-12, 'linear r=+1');
    assert.equal(f.n, 6, 'linear n');
    assert.equal(f.nExcluded, 0, 'linear nExcluded');
    close(f.minX, 0, 0, 'linear minX');
    close(f.maxX, 5, 0, 'linear maxX');
}

// ── Linear: perfect negative correlation ──
{
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];   // y = -2x + 12
    const f = linearFit(x, y);
    close(f.b1, -2, 1e-12, 'neg slope');
    close(f.b0, 12, 1e-12, 'neg intercept');
    close(f.r, -1, 1e-12, 'r = -1');
    close(f.r2, 1, 1e-12, 'R2 = 1');
}

// ── Linear: horizontal Y (SST=0) → r/R2 N/A, never invented ──
{
    const f = linearFit([1, 2, 3, 4], [7, 7, 7, 7]);
    assert.equal(f.status, 'ok', 'horizontal is a valid fit');
    close(f.b1, 0, 1e-12, 'horizontal slope 0');
    close(f.b0, 7, 1e-12, 'horizontal intercept = mean');
    assert.ok(Number.isNaN(f.r2), 'R2 is NaN (not 1) when SST=0');
    assert.ok(Number.isNaN(f.r), 'r is NaN when SST=0');
    assert.equal(f.warning, 'y-constant', 'y-constant warning');
}

// ── Linear: large offset stability (X ~ 1e12 with small span) ──
{
    const base = 1e12;
    const x = [base, base + 1, base + 2, base + 3, base + 4];
    const y = x.map((v) => 5 * (v - base) + 100); // slope 5 in local coords
    const f = linearFit(x, y);
    close(f.b1, 5, 1e-6, 'large-X slope stable');
    close(f.r2, 1, 1e-9, 'large-X R2 stable');
}

// ── Linear: hand-computed metrics with residuals ──
{
    // x=[1..5], y=[2,1,4,3,6]. From correlation test: Σdxdy=10, Σdx²=10, Σdy²=14.8
    // slope=1, intercept=meanY-slope*meanX=3.2-3=0.2, SSE=14.8-100/10=4.8
    const f = linearFit([1, 2, 3, 4, 5], [2, 1, 4, 3, 6]);
    close(f.b1, 1, 1e-12, 'ref slope');
    close(f.b0, 0.2, 1e-12, 'ref intercept');
    close(f.sse, 4.8, 1e-12, 'ref SSE');
    close(f.r2, 1 - 4.8 / 14.8, 1e-12, 'ref R2');
    close(f.rmse, Math.sqrt(4.8 / 5), 1e-12, 'ref RMSE');
}

// ── Linear degenerate: n<2 and X constant ──
{
    assert.equal(linearFit([1], [2]).status, 'undefined', 'n=1 undefined');
    assert.equal(linearFit([1], [2]).warning, 'insufficient-n', 'n=1 warning');
    assert.equal(linearFit([], []).status, 'undefined', 'n=0 undefined');
    const xc = linearFit([5, 5, 5], [1, 2, 3]);
    assert.equal(xc.status, 'undefined', 'X constant undefined');
    assert.equal(xc.warning, 'x-constant', 'X constant warning');
}

// ── Quadratic: known a/b/c ──
{
    // y = 2x² - 3x + 1
    const x = [-3, -2, -1, 0, 1, 2, 3];
    const y = x.map((v) => 2 * v * v - 3 * v + 1);
    const f = quadraticFitCentered(x, y);
    assert.equal(f.status, 'ok', 'exact quadratic ok');
    close(f.a, 2, 1e-9, 'quad a');
    close(f.b, -3, 1e-9, 'quad b');
    close(f.c, 1, 1e-9, 'quad c');
    close(f.r2, 1, 1e-12, 'quad R2=1');
    close(f.rmse, 0, 1e-6, 'quad RMSE=0');
    assert.equal(f.n, 7, 'quad n');
    assert.ok(Number.isFinite(f.centerX) && f.scaleX > 0, 'center/scale set');
}

// ── Quadratic: centered stability with huge X and small span ──
{
    const base = 1e9;
    // y = 0.5 u² + ... in local coords; use local a=3,b=0,c=0 around base
    const x = [];
    const y = [];
    for (let k = 0; k <= 20; k++) {
        const xv = base + k * 0.1;
        const local = xv - base;
        x.push(xv);
        y.push(3 * local * local - 2 * local + 5);
    }
    const f = quadraticFitCentered(x, y);
    assert.equal(f.status, 'ok', 'huge-X quadratic ok');
    close(f.r2, 1, 1e-6, 'huge-X R2≈1');
    // Predict should reproduce the data closely
    const mid = x[10];
    close(predict(f, mid), y[10], Math.abs(y[10]) * 1e-6 + 1e-6, 'huge-X predict');
}

// ── Quadratic: with noise, R2 between 0 and 1 ──
{
    const x = [];
    const y = [];
    for (let k = 0; k < 50; k++) {
        x.push(k);
        // deterministic pseudo-noise
        const noise = ((k * 37) % 11) - 5;
        y.push(0.2 * k * k - 1.5 * k + 3 + noise);
    }
    const f = quadraticFitCentered(x, y);
    assert.equal(f.status, 'ok', 'noisy quadratic ok');
    assert.ok(f.r2 > 0.9 && f.r2 < 1, `noisy R2 in (0.9,1): ${f.r2}`);
    assert.ok(f.rmse > 0, 'noisy RMSE > 0');
}

// ── Quadratic degenerate: n<3, and rank-deficient (collinear on a line) ──
{
    assert.equal(quadraticFitCentered([1, 2], [1, 2]).status, 'undefined', 'n=2 quad undefined');
    assert.equal(quadraticFitCentered([1, 2], [1, 2]).warning, 'insufficient-n', 'n=2 quad warning');
    // Only two distinct X repeated → design rank-deficient for quadratic
    const f = quadraticFitCentered([1, 1, 2, 2], [1, 1, 2, 2]);
    assert.equal(f.status, 'undefined', 'two distinct X → singular');
    assert.equal(f.warning, 'singular', 'singular warning');
}

// ── Quadratic reduces to a line when data is linear (a≈0) ──
{
    const x = [-2, -1, 0, 1, 2, 3];
    const y = x.map((v) => 4 * v - 1);
    const f = quadraticFitCentered(x, y);
    assert.equal(f.status, 'ok', 'linear-into-quadratic ok');
    close(f.a, 0, 1e-9, 'quad a≈0 for linear data');
    close(f.b, 4, 1e-8, 'quad recovers slope');
    close(f.c, -1, 1e-8, 'quad recovers intercept');
}

// ── regressionMetrics: SST=0 → R2 NaN, tiny negative SSE clamped ──
{
    const m = regressionMetrics(-1e-15, 0, 4);
    assert.ok(Number.isNaN(m.r2), 'SST=0 → R2 NaN');
    assert.equal(m.sse, 0, 'tiny negative SSE clamped to 0');
    close(m.rmse, 0, 0, 'RMSE 0');
}

// ── buildFitCurve: no extrapolation, correct endpoints, default count ──
{
    const f = linearFit([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]); // y=2x
    const curve = buildFitCurve(f);
    assert.equal(curve.x.length, FIT_CURVE_POINTS, 'default curve length');
    close(curve.x[0], 1, 0, 'curve starts at minX');
    close(curve.x[curve.x.length - 1], 5, 0, 'curve ends at maxX (no extrapolation)');
    close(curve.y[0], 2, 1e-9, 'curve y at minX');
    close(curve.y[curve.y.length - 1], 10, 1e-9, 'curve y at maxX');
    // custom count
    assert.equal(buildFitCurve(f, 10).x.length, 10, 'custom curve length');
    // undefined fit → empty
    const empty = buildFitCurve(linearFit([1], [1]));
    assert.equal(empty.x.length, 0, 'undefined fit → empty curve');
}

// ── Pairwise-finite deletion: NaN/Inf/null rows excluded, X/Y not mixed ──
{
    const x = [1, 2, NaN, 4, 5, 6];
    const y = [2, 4, 8, Infinity, 10, 12]; // rows 2 and 3 invalid
    const f = linearFit(x, y);           // valid rows: (1,2)(2,4)(5,10)(6,12) → y=2x
    assert.equal(f.n, 4, 'excludes NaN and Inf rows');
    assert.equal(f.nExcluded, 2, 'counts 2 excluded');
    close(f.b1, 2, 1e-12, 'slope from valid rows only');
}

// ── fitPair dispatch ──
{
    assert.equal(fitPair('linear', [1, 2, 3], [1, 2, 3]).model, 'linear', 'dispatch linear');
    assert.equal(fitPair('quadratic', [1, 2, 3, 4], [1, 4, 9, 16]).model, 'quadratic', 'dispatch quadratic');
    assert.equal(fitPair('none', [1], [1]), null, 'dispatch none → null');
}

console.log('test-regression: all assertions passed');
