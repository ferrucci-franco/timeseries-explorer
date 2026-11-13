// The kernel of the Trend analysis: what one stretch of a signal is worth
// summarising by — its mean, how flat it is, and the trend fitted through it.
//
// Pure and dependency-free (the shared pairwise-moments accumulator and the OLS
// solvers of regression.js): callers pass already-transformed numeric arrays,
// so the eager path and the lazy one agree on what a row is.
//
// Three numbers come from one pass over the rows (the pairwise moments of
// (t′, y)):
//   · the MEAN of y, and the spread around it (sample stddev, and the RMS
//     deviation from the mean — the "RMSE of the flat model", so the mean can be
//     read against the fits' RMSE);
//   · the LINEAR trend, through linearFromMoments: slope, intercept, r, R², RMSE;
// and the QUADRATIC trend needs one more pass (the sufficient statistics in the
// centred coordinate), which is exactly what quadraticFitSteps does — so this
// kernel DRIVES that generator with the same rows instead of solving the system
// again. The quadratic of a stretch is therefore the Curve Fit quadratic of the
// same stretch, bit for bit, and there is one solver in the app, not two.
//
// The exponential trend is not here: it is an iterative fit over the same rows
// (src/utils/exp-fit.js, through fitPair / _streamLazyFit), asked for per
// segment because it costs passes.
//
// OUTLIERS. A segment may carry a value band [lower, upper]: a row whose y is
// finite but outside the band is an outlier — dropped from every number above
// and counted. The test is the one the Data tools' bounds detector uses
// (detectBoundsOutliers: `y < lower || y > upper`, an empty bound open), so
// "remove outliers by bounds" means the same thing in the whole app. Masking
// (the row's x and y become NaN, which pairwise deletion then drops) is also
// what the lazy SQL does with a CASE WHEN, so both paths exclude the same rows.
//
// Written as passes (src/utils/fit-passes.js) so the very same code summarises
// arrays in memory and a lazy file read a chunk at a time.

import { createPairwiseMoments } from './correlation.js';
import { linearFromMoments, quadraticFitSteps } from './regression.js';
import { boundValue } from '../compute/kernels/outliers.js';

// Rows below this cannot define a mean.
export const TREND_MIN_N = 1;

// `toFinite` of correlation.js, which decides what a row is: null and undefined
// are missing (Number(null) is 0, which must not pass as a value), and so is
// anything that is not a finite number.
const fin = (v) => {
    if (v == null) return NaN;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : NaN;
};

/**
 * The value band of a segment as the kernel reads it: `{ active, lower, upper }`
 * with an empty, absent or non-finite bound open (−∞ / +∞). `band` is
 * `{ lower, upper }` or null; a band with both bounds open is not active.
 */
export function trendBand(band) {
    if (!band) return { active: false, lower: -Infinity, upper: Infinity };
    const lower = boundValue(band.lower);
    const upper = boundValue(band.upper);
    const hasLower = Number.isFinite(lower);
    const hasUpper = Number.isFinite(upper);
    return {
        active: hasLower || hasUpper,
        lower: hasLower ? lower : -Infinity,
        upper: hasUpper ? upper : Infinity,
    };
}

// Whether a finite y is inside the band. Written as the negation of the bounds
// detector's test so the two cannot drift apart.
export function trendInBand(y, { lower, upper }) {
    return !(y < lower || y > upper);
}

/**
 * The mean, the spread, the linear fit and (when asked) the quadratic fit of a
 * stretch, as the passes they make over its rows.
 *
 * Yields one pass, and a second one only when the quadratic needs it. Returns
 * the shape assembleTrend returns — the same shape the lazy SQL path builds
 * from its aggregates.
 */
export function* trendSteps({ band = null, quadratic = true } = {}) {
    const bounds = trendBand(band);
    const moments = createPairwiseMoments();
    const quad = quadratic ? quadraticFitSteps() : null;
    // The quadratic kernel's own first pass: the same rows, so it finds the
    // same centre and scale.
    let quadStep = quad ? quad.next() : null;
    let nOutliers = 0;
    let minY = Infinity;
    let maxY = -Infinity;

    // The rows a pass accumulates: as they are when no band is set (nothing to
    // drop, nothing to allocate), masked copies when one is — an outlier's x
    // and y become NaN, which pairwise deletion drops. Both passes mask the
    // same way, so they see the same rows.
    const masked = (x, y, count) => {
        if (!bounds.active) return [x, y];
        const mx = new Float64Array(count);
        const my = new Float64Array(count);
        for (let i = 0; i < count; i++) {
            const xi = fin(x[i]);
            const yi = fin(y[i]);
            const kept = Number.isFinite(xi) && Number.isFinite(yi) && trendInBand(yi, bounds);
            mx[i] = kept ? xi : NaN;
            my[i] = kept ? yi : NaN;
        }
        return [mx, my];
    };

    yield {
        chunk(x, y) {
            const count = Math.min(x?.length || 0, y?.length || 0);
            if (!count) return;
            // What only this pass can count: the rows the band dropped, and the
            // extremes of the rows kept.
            let outliers = nOutliers;
            let lo = minY;
            let hi = maxY;
            for (let i = 0; i < count; i++) {
                const xi = fin(x[i]);
                const yi = fin(y[i]);
                if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
                if (bounds.active && !trendInBand(yi, bounds)) {
                    outliers++;
                    continue;
                }
                if (yi < lo) lo = yi;
                if (yi > hi) hi = yi;
            }
            nOutliers = outliers;
            minY = lo;
            maxY = hi;
            const [mx, my] = masked(x, y, count);
            moments.chunk(mx, my);
            if (quadStep && !quadStep.done) quadStep.value.chunk(mx, my);
        },
    };

    const m = moments.result();
    // The quadratic kernel resumes on its own moments: either it wants its
    // second pass, or it has already given up (fewer than three rows, or a
    // constant t′) and returns its degenerate result.
    let quadFit = null;
    if (quad) {
        quadStep = quad.next();
        if (quadStep.done) {
            quadFit = quadStep.value;
        } else {
            const pass = quadStep.value;
            yield {
                chunk(x, y) {
                    const count = Math.min(x?.length || 0, y?.length || 0);
                    if (!count) return;
                    const [mx, my] = masked(x, y, count);
                    pass.chunk(mx, my);
                },
            };
            quadFit = quad.next().value;
        }
    }

    return assembleTrend({
        nScope: m.nRowsSeen,
        nOutliers,
        moments: m,
        minY: m.n ? minY : NaN,
        maxY: m.n ? maxY : NaN,
        quadratic: quadFit,
    });
}

/**
 * What a segment's summary is, from the aggregates of its rows — however they
 * were accumulated: by the passes above over arrays or a stream, or by the
 * aggregate queries of a lazy file (src/data/trend-sql.js). The two paths share
 * this function and the solvers it calls, so they can only differ by the
 * rounding of their sums.
 *
 *   nScope     rows in the segment's range
 *   n          rows used: x and y finite, and inside the band
 *   nOutliers  rows dropped by the band (finite, outside it)
 *   nMissing   rows dropped for want of a value (empty cells, NaN, ±∞)
 *   mean, std  the mean of y and the sample stddev around it
 *   meanRmse   RMS deviation from the mean: the RMSE of "y is constant"
 *   minY, maxY the extremes of the rows used
 *   minX, maxX the span of t′ actually covered
 *   linear     the OLS line, as every other fit in the app reports it
 *   quadratic  the OLS parabola, or null when it was not asked for
 */
export function assembleTrend({ nScope = 0, nOutliers = 0, moments, minY = NaN, maxY = NaN, quadratic = null }) {
    const m = moments || {};
    const n = Number.isFinite(m.n) ? m.n : 0;
    const scope = Number.isFinite(nScope) ? nScope : 0;
    const outliers = Number.isFinite(nOutliers) ? nOutliers : 0;
    const m2y = Number(m.m2y);
    return {
        nScope: scope,
        n,
        nOutliers: outliers,
        nMissing: Math.max(0, scope - n - outliers),
        mean: n >= TREND_MIN_N ? m.meanY : NaN,
        std: n >= 2 ? Math.sqrt(m2y / (n - 1)) : NaN,
        meanRmse: n >= TREND_MIN_N ? Math.sqrt((m2y > 0 ? m2y : 0) / n) : NaN,
        minY,
        maxY,
        minX: m.minX,
        maxX: m.maxX,
        linear: linearFromMoments(m),
        quadratic: quadratic || null,
    };
}

/**
 * The values of a stretch with its outliers taken out: a copy in which a row
 * outside the band is NaN, so any fit kernel's pairwise deletion drops exactly
 * the rows the passes above drop. The array itself when there is no band.
 *
 * This is how the exponential trend — an iterative fit that does not go
 * through trendSteps — sees the same rows as the mean and the line.
 */
export function maskTrendValues(values, band) {
    const bounds = trendBand(band);
    const count = values?.length || 0;
    if (!bounds.active || !count) return values;
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const yi = fin(values[i]);
        out[i] = Number.isFinite(yi) && trendInBand(yi, bounds) ? yi : NaN;
    }
    return out;
}

/**
 * The change the linear trend accounts for over the stretch it was fitted on:
 * slope × (last t′ − first t′). The number the mean cannot give — "it rose by
 * 4.2 °C across this stretch" — and the one a slope in units per second is hard
 * to read as.
 */
export function trendDelta(trend) {
    const fit = trend?.linear;
    if (!fit || fit.status !== 'ok') return NaN;
    const span = Number(fit.maxX) - Number(fit.minX);
    return Number.isFinite(span) ? fit.b1 * span : NaN;
}

/**
 * A seed for a segment's value band from the rows already summarised:
 * mean ± k·stddev, the usual first guess at "what is an outlier here". Null
 * when the segment has no spread to speak of (fewer than two rows, or a
 * constant signal), which is when a band would exclude everything or nothing.
 */
export function seedTrendBand(trend, k = 3) {
    const mean = Number(trend?.mean);
    const std = Number(trend?.std);
    const factor = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : 3;
    if (!Number.isFinite(mean) || !(std > 0)) return null;
    return { lower: mean - factor * std, upper: mean + factor * std };
}
