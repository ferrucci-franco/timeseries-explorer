// Least-squares fits of the exponential family, for both Curve Fit analyses
// (the 2D pair fit and the time-series fit).
//
//   exponential          y = a·e^(b·x)
//   exponential-offset   y = a·e^(b·x) + c
//   first-order          y = K·(1 − e^(α·x))
//   first-order-offset   y = y₀ + K·(1 − e^(α·x))
//
// The last one is the step response of a first-order system once x is the
// time since the step; the time-series analysis passes x already shifted to
// its own origin (t′ = t − t₀), so the coefficients read directly.
//
// Unlike the power fit (a line in log-log), these minimise the squared error
// in Y itself: a transient that settles near zero would otherwise be ruled by
// its noisiest, smallest samples.
//
// Every model is linear in all its coefficients but one, the rate. For a fixed
// rate the others have a closed-form least-squares solution, so the problem
// reduces to minimising the residual sum of squares over that single number
// ("variable projection"). The rate is first located on a wide logarithmic
// grid — nothing has to be guessed by the user — and then refined by golden
// section search inside the bracket around the best grid point. Each step is
// one pass over the rows and keeps no per-row state, so a million rows cost
// some tens of passes.
//
// The fit is written as those passes (expFamilyFitSteps, a generator that
// yields one pass at a time; see src/utils/fit-passes.js). In memory every
// pass runs over the arrays; over a lazy file each one streams the rows from
// DuckDB, a chunk at a time, so a fit of any number of rows holds a few
// thousand of them at once — and gives the same numbers, bit for bit, because
// every sum is taken over the same rows in the same order.
//
// The rate is searched in a scaled coordinate u = (x − x₀)/s, where s is the
// span of x, so the same grid fits a transient measured in milliseconds or in
// days. The exponential models are invariant to a shift of x and use x₀ =
// min x; the first-order models are NOT (their 1 − e^(α·x) starts at x = 0),
// so they keep x₀ = 0 and only scale.

import { runPassesOnArrays } from './fit-passes.js';

export const EXP_FAMILY_MODELS = new Set(['exponential', 'exponential-offset', 'first-order', 'first-order-offset']);

const PARAM_COUNT = {
    exponential: 2,
    'exponential-offset': 3,
    'first-order': 2,
    'first-order-offset': 3,
};

// Fewest rows each model needs: one more than its coefficients, so the fit is
// not just an interpolation through every point.
export function expFamilyMinN(model) {
    return (PARAM_COUNT[model] || 2) + 1;
}

// Rates (per unit of u, i.e. per span) tried before refining. ±0.02 is a curve
// that barely bends across the range; ±200 one that is over within its first
// half percent.
const RATE_GRID = (() => {
    const mags = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 11, 15, 20, 30, 45, 70, 100, 150, 200];
    return [...mags.map(m => -m).reverse(), ...mags];
})();
const GOLDEN_C = (3 - Math.sqrt(5)) / 2;
// Above this many rows the rate is first located on an evenly strided subset,
// then polished on every row: the grid alone is ~50 passes.
const COARSE_ROWS = 20000;

const toFinite = (v) => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
};

// The basis the linear coefficient multiplies, for a rate B at u. expm1 keeps
// it accurate when B·u is small, where e^(Bu) − 1 would lose every digit.
//   exponential*: g = e^(Bu) − 1   (the "− 1" is absorbed by the constant, or
//                                   added back below when there is none)
//   first-order*: g = 1 − e^(Bu)
function basis(model, B, u) {
    const e = Math.expm1(B * u);
    return model.startsWith('first-order') ? -e : e;
}

const withOffset = (model) => model.endsWith('-offset');

// Closed-form linear coefficients and SSE for one rate, from one pass.
// Without an offset the exponential uses g + 1 = e^(Bu) as its basis.
function solveForRate(model, B, us, ys, n, sumY, sumYY) {
    if (!(Math.abs(B) > 1e-12)) return null;
    const sums = createRateSums(model, [B]);
    sums.add(us, ys, n);
    return sums.solve(0, n, sumY, sumYY);
}

// The three sums a rate's closed form needs (Σg, Σg², Σg·y), for one or
// several rates at once, accumulated row by row in the order the rows come:
// over in-memory arrays or chunk after chunk of a stream, the same numbers.
function createRateSums(model, rates) {
    const plainExp = model === 'exponential';
    const k = rates.length;
    const Sg = new Float64Array(k);
    const Sgg = new Float64Array(k);
    const Sgy = new Float64Array(k);
    return {
        add(us, ys, n) {
            for (let r = 0; r < k; r++) {
                const B = rates[r];
                let sg = Sg[r], sgg = Sgg[r], sgy = Sgy[r];
                for (let i = 0; i < n; i++) {
                    let g = basis(model, B, us[i]);
                    if (plainExp) g += 1;
                    sg += g;
                    sgg += g * g;
                    sgy += g * ys[i];
                }
                Sg[r] = sg; Sgg[r] = sgg; Sgy[r] = sgy;
            }
        },
        read(r) {
            return [Sg[r], Sgg[r], Sgy[r]];
        },
        write(r, sg, sgg, sgy) {
            Sg[r] = sg;
            Sgg[r] = sgg;
            Sgy[r] = sgy;
        },
        solve(r, n, sumY, sumYY) {
            if (!(Math.abs(rates[r]) > 1e-12)) return null;
            return solveFromSums(model, Sg[r], Sgg[r], Sgy[r], n, sumY, sumYY);
        },
    };
}

function solveFromSums(model, Sg, Sgg, Sgy, n, sumY, sumYY) {
    const offset = withOffset(model);
    if (!Number.isFinite(Sgg) || !Number.isFinite(Sgy)) return null;
    if (!offset) {
        if (!(Sgg > 0)) return null;
        const A = Sgy / Sgg;
        return { A, C: 0, sse: sumYY - A * Sgy };
    }
    const Cgg = Sgg - (Sg * Sg) / n;
    if (!(Cgg > Sgg * 1e-13) || !(Cgg > 0)) return null;
    const Cgy = Sgy - (Sg * sumY) / n;
    const A = Cgy / Cgg;
    const C = (sumY - A * Sg) / n;
    const sst = sumYY - (sumY * sumY) / n;
    return { A, C, sse: sst - A * Cgy };
}

// Brent's minimiser (golden section with parabolic steps): on the smooth SSE
// curve of one rate it converges in a dozen or so evaluations, each one pass.
// Written as a generator that yields each point it wants evaluated and is
// sent back the value, so the evaluation can be a pass over a stream; brent()
// drives it with a plain function.
function* brentSteps(ax, bx, tol = 1e-10, maxIter = 100) {
    let a = Math.min(ax, bx);
    let b = Math.max(ax, bx);
    let x = a + GOLDEN_C * (b - a);
    let w = x;
    let v = x;
    let fx = yield x;
    let fw = fx;
    let fv = fx;
    let d = 0;
    let e = 0;
    for (let iter = 0; iter < maxIter; iter++) {
        const xm = 0.5 * (a + b);
        const tol1 = tol * Math.abs(x) + 1e-14;
        const tol2 = 2 * tol1;
        if (Math.abs(x - xm) <= tol2 - 0.5 * (b - a)) break;
        let useGolden = true;
        if (Math.abs(e) > tol1) {
            const r = (x - w) * (fx - fv);
            let q = (x - v) * (fx - fw);
            let p = (x - v) * q - (x - w) * r;
            q = 2 * (q - r);
            if (q > 0) p = -p;
            q = Math.abs(q);
            const etemp = e;
            e = d;
            if (Number.isFinite(p) && Number.isFinite(q) && Math.abs(p) < Math.abs(0.5 * q * etemp)
                && p > q * (a - x) && p < q * (b - x)) {
                d = p / q;
                const u = x + d;
                if (u - a < tol2 || b - u < tol2) d = xm >= x ? tol1 : -tol1;
                useGolden = false;
            }
        }
        if (useGolden) {
            e = x >= xm ? a - x : b - x;
            d = GOLDEN_C * e;
        }
        const u = Math.abs(d) >= tol1 ? x + d : x + (d >= 0 ? tol1 : -tol1);
        const fu = yield u;
        if (fu <= fx) {
            if (u >= x) a = x; else b = x;
            v = w; fv = fw;
            w = x; fw = fx;
            x = u; fx = fu;
        } else {
            if (u < x) a = u; else b = u;
            if (fu <= fw || w === x) {
                v = w; fv = fw;
                w = u; fw = fu;
            } else if (fu <= fv || v === x || v === w) {
                v = u; fv = fu;
            }
        }
    }
    return x;
}

function brent(f, ax, bx, tol, maxIter) {
    const steps = brentSteps(ax, bx, tol, maxIter);
    let step = steps.next();
    while (!step.done) step = steps.next(f(step.value));
    return step.value;
}

function emptyResult(model, extra = {}) {
    return {
        model,
        n: 0,
        nExcluded: 0,
        minX: NaN,
        maxX: NaN,
        a: NaN, b: NaN, c: NaN,
        K: NaN, alpha: NaN, y0: NaN,
        timeConstant: NaN,
        r2: NaN, rmse: NaN, sse: NaN, sst: NaN,
        status: 'undefined',
        warning: null,
        ...extra,
    };
}

/**
 * Fit one of the exponential-family models to aligned x/y arrays. Rows where
 * x or y is not finite are skipped and counted in nExcluded, exactly as the
 * linear kernels do. The result carries the display coefficients (a, b, c for
 * the exponentials; K, α, y₀ for the first-order models), the time constant
 * −1/rate when the curve decays toward its asymptote, R², RMSE, and the
 * internal scaled solution used by predictExpFamily.
 */
export function expFamilyFit(model, x, y) {
    if (!EXP_FAMILY_MODELS.has(model)) return null;
    return runPassesOnArrays(expFamilyFitSteps(model, { keepRows: true }), x, y);
}

/**
 * The same fit, as the passes it makes over the rows: a generator that yields
 * one pass at a time — an object whose chunk(x, y) takes the rows, in order,
 * in as many chunks as the caller likes — and returns the result once the
 * passes are done. expFamilyFit feeds each pass the whole arrays; a lazy file
 * feeds it a stream (src/utils/fit-passes.js).
 *
 *   1. statistics: count, span of x, mean and spread of y, Σy, Σy²;
 *   2. the rows the rate is first located on: every row when there are no
 *      more than COARSE_ROWS, else every stride-th finite row, kept in memory;
 *   3. when they were a subset, one pass per evaluation of the polish on every
 *      row, and one that compares its answer with the subset's;
 *   4. the residuals, for the exact SSE.
 *
 * `keepRows` lets pass 2 keep every row, scaled (three doubles a row), so
 * passes 3 and 4 run over those copies instead of asking for the rows again —
 * the old in-memory kernel's shape, and the same numbers. `true` for rows
 * already in memory; a number for a stream, which keeps them when there are
 * no more than that many (known after pass 1) and reads them again otherwise.
 */
export function* expFamilyFitSteps(model, { keepRows = false } = {}) {
    if (!EXP_FAMILY_MODELS.has(model)) return null;
    const offset = withOffset(model);
    const firstOrder = model.startsWith('first-order');

    // ── Pass 1: statistics ──
    let len = 0;
    let n = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let meanY = 0;
    let m2y = 0;
    let sumY = 0;
    let sumYY = 0;
    yield {
        chunk(x, y) {
            const count = Math.min(x?.length || 0, y?.length || 0);
            len += count;
            let cn = n, cMin = minX, cMax = maxX, cMean = meanY, cM2 = m2y, cSum = sumY, cSum2 = sumYY;
            for (let i = 0; i < count; i++) {
                const xi = toFinite(x[i]);
                const yi = toFinite(y[i]);
                if (xi === null || yi === null) continue;
                cn++;
                const dy = yi - cMean;
                cMean += dy / cn;
                cM2 += dy * (yi - cMean);
                if (xi < cMin) cMin = xi;
                if (xi > cMax) cMax = xi;
                cSum += yi;
                cSum2 += yi * yi;
            }
            n = cn; minX = cMin; maxX = cMax; meanY = cMean; m2y = cM2; sumY = cSum; sumYY = cSum2;
        },
    };
    const nExcluded = len - n;
    const base = { n, nExcluded, minX: n ? minX : NaN, maxX: n ? maxX : NaN, sst: n ? m2y : NaN };
    if (n < expFamilyMinN(model)) return emptyResult(model, { ...base, warning: 'insufficient-n' });
    if (!(maxX > minX)) return emptyResult(model, { ...base, warning: 'x-constant' });

    const x0 = firstOrder ? 0 : minX;
    const scale = firstOrder ? Math.max(Math.abs(minX), Math.abs(maxX)) : (maxX - minX);
    if (!(scale > 0) || !Number.isFinite(scale)) return emptyResult(model, { ...base, warning: 'x-constant' });

    // With an offset, Y is centred on its mean so Σy² carries no huge
    // constant to cancel (the SSE is shift-invariant only with an offset;
    // without one, Y is used as is).
    if (offset) {
        sumY = 0;
        sumYY = m2y;
    }
    // Every later pass sees each finite row as (u, y′): u the scaled abscissa,
    // y′ the centred value. The loops are written out in each pass rather than
    // through a callback per row, which costs as much as the arithmetic.
    const shiftY = offset ? meanY : 0;

    // ── Pass 2: the rows the rate is located on ──
    // On every row when there are few, on a strided subset when there are
    // many (the rate is a property of the curve's shape, which a few thousand
    // evenly spread rows already pin down).
    const whole = n <= COARSE_ROWS;
    const stride = whole ? 1 : Math.ceil(n / COARSE_ROWS);
    const m = Math.ceil(n / stride);
    const su = new Float64Array(m);
    const sy = new Float64Array(m);
    let sY = 0;
    let sYY = 0;
    let seen = 0;
    let k = 0;
    const keep = !whole && (keepRows === true || (typeof keepRows === 'number' && n <= keepRows));
    const fx = keep ? new Float64Array(n) : null;
    const fu = keep ? new Float64Array(n) : null;
    const fy = keep ? new Float64Array(n) : null;
    let f = 0;
    yield {
        chunk(x, y) {
            const count = Math.min(x?.length || 0, y?.length || 0);
            for (let i = 0; i < count; i++) {
                const xi = toFinite(x[i]);
                const yi = toFinite(y[i]);
                if (xi === null || yi === null) continue;
                if (keep) {
                    fx[f] = xi;
                    fu[f] = (xi - x0) / scale;
                    fy[f] = offset ? yi - shiftY : yi;
                    f++;
                }
                if (seen++ % stride !== 0) continue;
                const u = (xi - x0) / scale;
                const yc = offset ? yi - shiftY : yi;
                su[k] = u;
                sy[k] = yc;
                k++;
                sY += yc;
                sYY += yc * yc;
            }
        },
    };

    const sseOver = (uArr, yArr, count, sumA, sumB) => (B) => {
        const s = solveForRate(model, B, uArr, yArr, count, sumA, sumB);
        return s && Number.isFinite(s.sse) ? s.sse : Infinity;
    };
    // Every row in memory: the full SSE needs no pass of its own.
    const sseAt = whole ? sseOver(su, sy, n, sumY, sumYY) : null;
    const coarse = whole ? sseAt : sseOver(su, sy, m, sY, sYY);
    let bestIndex = -1;
    let bestSse = Infinity;
    RATE_GRID.forEach((B, i) => {
        const sse = coarse(B);
        if (sse < bestSse) { bestSse = sse; bestIndex = i; }
    });
    if (bestIndex < 0) return emptyResult(model, { ...base, warning: 'singular' });

    // Refine inside the two neighbours. Across the B = 0 gap, the bracket stops
    // short of zero: there the model degenerates.
    let lo = RATE_GRID[Math.max(0, bestIndex - 1)];
    let hi = RATE_GRID[Math.min(RATE_GRID.length - 1, bestIndex + 1)];
    const Bgrid = RATE_GRID[bestIndex];
    if (lo < 0 && Bgrid > 0) lo = Bgrid / 4;
    if (hi > 0 && Bgrid < 0) hi = Bgrid / 4;
    let B = brent(coarse, lo, hi);
    let sol;
    if (keep) {
        // Every row in memory: the polish and the comparison as the passes
        // below would make them, over the kept rows.
        const sseFull = sseOver(fu, fy, n, sumY, sumYY);
        const near = brent(sseFull, B * 0.9, B * 1.1, 1e-8, 40);
        const atNear = solveForRate(model, near, fu, fy, n, sumY, sumYY);
        const atB = solveForRate(model, B, fu, fy, n, sumY, sumYY);
        const sseNear = atNear && Number.isFinite(atNear.sse) ? atNear.sse : Infinity;
        const sseB = atB && Number.isFinite(atB.sse) ? atB.sse : Infinity;
        if (sseNear <= sseB) {
            B = near;
            sol = atNear;
        } else {
            sol = atB;
        }
    } else if (!whole) {
        // ── Pass 3: polish on every row, close around the subset's answer ──
        // One pass per point Brent asks for.
        // One pass for one or two rates (the polish asks for one at a time;
        // the final comparison for two). Each rate's sums run over the rows
        // in order, as solveForRate's do.
        const ratePass = (rates) => {
            const sums = createRateSums(model, rates);
            const two = rates.length === 2;
            const B0 = rates[0];
            const B1 = two ? rates[1] : 0;
            const plainExp = model === 'exponential';
            return {
                sums,
                pass: {
                    chunk(x, y) {
                        const count = Math.min(x?.length || 0, y?.length || 0);
                        let g0s = 0, g0q = 0, g0y = 0, g1s = 0, g1q = 0, g1y = 0;
                        [g0s, g0q, g0y] = sums.read(0);
                        if (two) [g1s, g1q, g1y] = sums.read(1);
                        for (let i = 0; i < count; i++) {
                            const xi = toFinite(x[i]);
                            const yi = toFinite(y[i]);
                            if (xi === null || yi === null) continue;
                            const u = (xi - x0) / scale;
                            const yc = offset ? yi - shiftY : yi;
                            let g = basis(model, B0, u);
                            if (plainExp) g += 1;
                            g0s += g;
                            g0q += g * g;
                            g0y += g * yc;
                            if (two) {
                                let h = basis(model, B1, u);
                                if (plainExp) h += 1;
                                g1s += h;
                                g1q += h * h;
                                g1y += h * yc;
                            }
                        }
                        sums.write(0, g0s, g0q, g0y);
                        if (two) sums.write(1, g1s, g1q, g1y);
                    },
                },
            };
        };
        const polish = brentSteps(B * 0.9, B * 1.1, 1e-8, 40);
        let step = polish.next();
        while (!step.done) {
            const rate = step.value;
            let sse = Infinity;
            if (Math.abs(rate) > 1e-12) {
                const { sums, pass } = ratePass([rate]);
                yield pass;
                const s = sums.solve(0, n, sumY, sumYY);
                sse = s && Number.isFinite(s.sse) ? s.sse : Infinity;
            }
            step = polish.next(sse);
        }
        const near = step.value;
        // One more pass for the polished and the subset's rate side by side,
        // whose sums also give the chosen rate's coefficients.
        const { sums, pass } = ratePass([near, B]);
        yield pass;
        const atNear = sums.solve(0, n, sumY, sumYY);
        const atB = sums.solve(1, n, sumY, sumYY);
        const sseNear = atNear && Number.isFinite(atNear.sse) ? atNear.sse : Infinity;
        const sseB = atB && Number.isFinite(atB.sse) ? atB.sse : Infinity;
        if (sseNear <= sseB) {
            B = near;
            sol = atNear;
        } else {
            sol = atB;
        }
    } else {
        if (!(sseAt(B) <= sseAt(Bgrid))) B = Bgrid;
        sol = solveForRate(model, B, su, sy, n, sumY, sumYY);
    }
    if (!sol) return emptyResult(model, { ...base, warning: 'singular' });

    // Coefficients of the scaled model y = A·g(u) + C (+ meanY when centred).
    const A = sol.A;
    const C = sol.C + (offset ? meanY : 0);
    const rate = B / scale;
    const internal = { x0, scale, A, B, C };

    // ── Pass 4: SSE from the residuals themselves ──
    // The sufficient-statistic form above is good for ranking rates, the
    // direct one is exact.
    let sse = 0;
    if (keep) {
        for (let i = 0; i < n; i++) {
            const yi = fy[i] + (offset ? meanY : 0);
            const r = yi - predictInternal(model, internal, fx[i]);
            sse += r * r;
        }
    } else {
        yield {
            chunk(x, y) {
                const count = Math.min(x?.length || 0, y?.length || 0);
                let total = sse;
                for (let i = 0; i < count; i++) {
                    const xi = toFinite(x[i]);
                    const yi0 = toFinite(y[i]);
                    if (xi === null || yi0 === null) continue;
                    const yc = offset ? yi0 - shiftY : yi0;
                    const yi = yc + (offset ? meanY : 0);
                    const r = yi - predictInternal(model, internal, xi);
                    total += r * r;
                }
                sse = total;
            },
        };
    }
    const sst = m2y;

    const out = {
        model,
        ...base,
        internal,
        a: NaN, b: NaN, c: NaN,
        K: NaN, alpha: NaN, y0: NaN,
        timeConstant: NaN,
        sse,
        sst,
        r2: sst > 0 ? 1 - sse / sst : NaN,
        rmse: Math.sqrt(sse / n),
        status: 'ok',
        warning: sst > 0 ? null : 'y-constant',
    };
    if (firstOrder) {
        // y = A(1 − e^(B u)) + C, u = x/scale  ⇒  K = A, α = B/scale, y₀ = C.
        out.K = A;
        out.alpha = rate;
        out.y0 = offset ? C : 0;
    } else {
        // y = A(e^(B u) − 1) + C (offset) or A·e^(B u) (plain), u = (x − x₀)/scale.
        // ⇒ y = A·e^(−b·x₀)·e^(b·x) + (C − A).
        out.b = rate;
        out.a = A * Math.exp(-rate * x0);
        out.c = offset ? C - A : 0;
        if (!Number.isFinite(out.a)) out.warning = 'coefficient-overflow';
    }
    // A decaying exponential (rate < 0) has a time constant: the x it takes to
    // cover 63 % of the way to its asymptote.
    if (rate < 0) out.timeConstant = -1 / rate;
    return out;
}

function predictInternal(model, internal, x) {
    const { x0, scale, A, B, C } = internal;
    const u = (x - x0) / scale;
    if (model === 'exponential') return A * Math.exp(B * u);
    return A * basis(model, B, u) + C;
}

// ŷ at x, from the scaled solution (never from the display coefficients, which
// can over- or underflow far from the data).
export function predictExpFamily(fit, x) {
    if (!fit?.internal) return NaN;
    return predictInternal(fit.model, fit.internal, x);
}
