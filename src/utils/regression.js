// OLS fitting kernel for the 2D-mode fitting feature (TODO 10).
//
// Pure and dependency-free (only the shared pairwise-moments kernel from
// correlation.js): callers pass already-transformed numeric arrays (gain/yOffset
// are applied upstream by the data layer, so eager and lazy paths share the same
// inputs). The kernel never interpolates, resamples, sorts, or fills gaps — it
// applies pairwise-finite deletion over aligned rows and solves a numerically
// stable OLS system. It fits Y on X (vertical residuals); swapping X/Y changes
// the model. It never extrapolates: fit curves span only [minX, maxX] of the
// rows actually fitted.

import { pairwiseMoments } from './correlation.js';

export const FIT_CURVE_POINTS = 200;

// Rows below these counts cannot define the corresponding model.
export const LINEAR_MIN_N = 2;
export const QUADRATIC_MIN_N = 3;

// Derived goodness-of-fit metrics from the residual sum of squares (SSE) and the
// total sum of squares (SST = Σ(y − meanY)²). SST = 0 ⇒ Y is constant, so R² is
// undefined (never invented as 1) and RMSE still reports the residual scale.
export function regressionMetrics(sse, sst, n) {
    const cleanSse = sse > 0 ? sse : 0; // absorb tiny negative roundoff
    return {
        sse: cleanSse,
        sst,
        r2: sst > 0 ? 1 - cleanSse / sst : NaN,
        rmse: n > 0 ? Math.sqrt(cleanSse / n) : NaN,
    };
}

// y = b0 + b1·x by ordinary least squares, reusing the stable pairwise moments
// (no naive Σx·Σy formula). Returns coefficients, Pearson r/R², RMSE, the fitted
// row count, the excluded-row count, and the observed X span. status is 'ok'
// when the slope is defined (≥2 rows and X has variance) and 'undefined'
// otherwise; a warning code is attached for the degenerate cases.
export function linearFit(x, y) {
    return linearFromMoments(pairwiseMoments(x, y));
}

// Same linear OLS result, built from already-accumulated pairwise moments.
// Shared by the eager kernel and the lazy DuckDB path (which maps DuckDB's
// regr_sxx/regr_syy/regr_sxy/avg to m2x/m2y/cMoment/means), so both produce
// identical coefficients and metrics.
export function linearFromMoments(m) {
    const { n, nExcluded, meanX, meanY, m2x, m2y, cMoment, minX, maxX } = m;

    const base = {
        model: 'linear',
        n,
        nExcluded,
        minX,
        maxX,
        b0: NaN,
        b1: NaN,
        r: NaN,
        r2: NaN,
        rmse: NaN,
        sse: NaN,
        sst: m2y,
    };

    if (n < LINEAR_MIN_N) {
        return { ...base, status: 'undefined', warning: 'insufficient-n' };
    }
    if (!(m2x > 0)) {
        // X constant → slope undefined; a vertical relation is not an OLS Y|X fit.
        return { ...base, status: 'undefined', warning: 'x-constant' };
    }

    const b1 = cMoment / m2x;
    const b0 = meanY - b1 * meanX;
    // SSE = SST − explained; algebraically Σ(y−ŷ)² = m2y − cMoment²/m2x.
    const sseRaw = m2y - (cMoment * cMoment) / m2x;
    const { sse, sst, r2, rmse } = regressionMetrics(sseRaw, m2y, n);

    let r = NaN;
    let warning = null;
    if (m2y > 0) {
        r = cMoment / Math.sqrt(m2x * m2y);
        if (r > 1) r = 1; else if (r < -1) r = -1;
    } else {
        // Y constant: horizontal line is a valid fit but r/R² are N/A.
        warning = 'y-constant';
    }

    return {
        ...base,
        b0,
        b1,
        r,
        r2: m2y > 0 ? r2 : NaN,
        rmse,
        sse,
        sst,
        status: 'ok',
        warning,
    };
}

// Solve a symmetric 3×3 system A·z = rhs with partial pivoting. Returns
// { solution, singular } where singular is true when a pivot collapses to ~0
// relative to the matrix scale (rank-deficient / ill-conditioned design).
function solve3x3(A, rhs) {
    // Work on an augmented copy so the caller's arrays are untouched.
    const M = [
        [A[0][0], A[0][1], A[0][2], rhs[0]],
        [A[1][0], A[1][1], A[1][2], rhs[1]],
        [A[2][0], A[2][1], A[2][2], rhs[2]],
    ];
    let scale = 0;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) scale = Math.max(scale, Math.abs(A[i][j]));
    }
    const eps = scale > 0 ? scale * 1e-12 : 1e-12;

    for (let col = 0; col < 3; col++) {
        // Partial pivot: swap in the row with the largest magnitude in this col.
        let piv = col;
        for (let r = col + 1; r < 3; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) <= eps) return { solution: null, singular: true };
        if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }

        for (let r = 0; r < 3; r++) {
            if (r === col) continue;
            const f = M[r][col] / M[col][col];
            for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
        }
    }
    return {
        solution: [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]],
        singular: false,
    };
}

// y = a·x² + b·x + c by OLS, solved in the centered/scaled coordinate
// u = (x − centerX)/scaleX (centerX = meanX, scaleX = sample stddev) so the
// normal equations stay well conditioned even when X is huge or spans a narrow
// range. The 3×3 system in u is solved with partial pivoting; on a singular /
// rank-deficient design the pair is not fitted. Coefficients A/B/C in u are
// converted to display a/b/c only at the end. SSE comes from the sufficient
// statistics, not per-row residuals, so it matches the lazy DuckDB path.
export function quadraticFitCentered(x, y) {
    const moments = pairwiseMoments(x, y);
    const { n, nExcluded, meanX, m2x, m2y, minX, maxX } = moments;

    const base = {
        model: 'quadratic',
        n,
        nExcluded,
        minX,
        maxX,
        a: NaN,
        b: NaN,
        c: NaN,
        A: NaN,
        B: NaN,
        C: NaN,
        centerX: NaN,
        scaleX: NaN,
        r2: NaN,
        rmse: NaN,
        sse: NaN,
        sst: m2y,
    };

    if (n < QUADRATIC_MIN_N) {
        return { ...base, status: 'undefined', warning: 'insufficient-n' };
    }
    if (!(m2x > 0)) {
        return { ...base, status: 'undefined', warning: 'x-constant' };
    }

    const centerX = meanX;
    // Sample stddev as a finite, positive scale. Guaranteed > 0 here (m2x > 0).
    const scaleX = Math.sqrt(m2x / (n - 1));
    if (!(scaleX > 0) || !Number.isFinite(scaleX)) {
        return { ...base, status: 'undefined', warning: 'x-constant' };
    }

    // Second pass: sufficient statistics in u. S_k = Σ u^k, T_k = Σ u^k·y.
    const len = Math.min(x?.length || 0, y?.length || 0);
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
    let T0 = 0, T1 = 0, T2 = 0, YY = 0;
    for (let i = 0; i < len; i++) {
        const xi = Number(x[i]);
        const yi = Number(y[i]);
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
        const u = (xi - centerX) / scaleX;
        const u2 = u * u;
        S0 += 1; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2;
        T0 += yi; T1 += u * yi; T2 += u2 * yi;
        YY += yi * yi;
    }

    return quadraticFromMoments({
        n, nExcluded, centerX, scaleX,
        S0, S1, S2, S3, S4, T0, T1, T2, YY, minX, maxX,
    });
}

// Solve the centered quadratic from its sufficient statistics (S_k = Σu^k,
// T_k = Σu^k·y, YY = Σy², u = (x−centerX)/scaleX). Shared by the eager kernel
// and the lazy DuckDB path so both produce identical a/b/c and metrics. Expects
// n ≥ 3 rows already aggregated; returns the same result shape as
// quadraticFitCentered.
export function quadraticFromMoments(stats) {
    const { n, nExcluded, centerX, scaleX, S0, S1, S2, S3, S4, T0, T1, T2, YY, minX, maxX } = stats;
    const sstRaw = S0 > 0 ? YY - (T0 * T0) / S0 : NaN;
    const base = {
        model: 'quadratic', n, nExcluded, minX, maxX,
        a: NaN, b: NaN, c: NaN, A: NaN, B: NaN, C: NaN,
        centerX, scaleX, r2: NaN, rmse: NaN, sse: NaN, sst: sstRaw,
    };
    if (!(n >= QUADRATIC_MIN_N)) return { ...base, status: 'undefined', warning: 'insufficient-n' };
    if (!(scaleX > 0) || !Number.isFinite(scaleX)) return { ...base, status: 'undefined', warning: 'x-constant' };

    // [S0 S1 S2][C]   [T0]
    // [S1 S2 S3][B] = [T1]
    // [S2 S3 S4][A]   [T2]
    const { solution, singular } = solve3x3(
        [[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]],
        [T0, T1, T2],
    );
    if (singular || !solution) return { ...base, status: 'undefined', warning: 'singular' };
    const [C, B, A] = solution;

    // SSE = Σy² − (C·T0 + B·T1 + A·T2) from the sufficient statistics.
    const sseRaw = YY - (C * T0 + B * T1 + A * T2);
    const { sse, sst, r2, rmse } = regressionMetrics(sseRaw, sstRaw, n);

    // Convert centered coefficients back to y = a·x² + b·x + c.
    const s2 = scaleX * scaleX;
    const a = A / s2;
    const b = B / scaleX - (2 * A * centerX) / s2;
    const c = C - (B * centerX) / scaleX + (A * centerX * centerX) / s2;

    return {
        ...base, a, b, c, A, B, C, centerX, scaleX,
        r2, rmse, sse, sst, status: 'ok', warning: sst > 0 ? null : 'y-constant',
    };
}

// Predict ŷ at a single x for a fit result. Quadratic is evaluated in the
// centered coordinate (matching how it was solved) for numerical stability.
export function predict(fit, x) {
    if (!fit) return NaN;
    if (fit.model === 'linear') return fit.b0 + fit.b1 * x;
    if (fit.model === 'quadratic') {
        const u = (x - fit.centerX) / fit.scaleX;
        return fit.A * u * u + fit.B * u + fit.C;
    }
    return NaN;
}

// Sampled fit curve over the observed X range only (no extrapolation). Returns
// { x, y } arrays of `count` points from minX to maxX inclusive. A degenerate
// or unfitted result yields empty arrays.
export function buildFitCurve(fit, count = FIT_CURVE_POINTS) {
    if (!fit || fit.status !== 'ok' || !Number.isFinite(fit.minX) || !Number.isFinite(fit.maxX)) {
        return { x: [], y: [] };
    }
    const n = Math.max(2, Math.floor(count));
    const { minX, maxX } = fit;
    if (minX === maxX) {
        return { x: [minX], y: [predict(fit, minX)] };
    }
    const xs = new Array(n);
    const ys = new Array(n);
    const step = (maxX - minX) / (n - 1);
    for (let i = 0; i < n; i++) {
        const xi = i === n - 1 ? maxX : minX + step * i;
        xs[i] = xi;
        ys[i] = predict(fit, xi);
    }
    return { x: xs, y: ys };
}

// Dispatch helper: run the requested model over aligned arrays.
export function fitPair(model, x, y) {
    if (model === 'linear') return linearFit(x, y);
    if (model === 'quadratic') return quadraticFitCentered(x, y);
    return null;
}
