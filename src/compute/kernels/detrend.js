// Remove a trend from a series, leaving the sampling untouched.
//
// Every method here is a SUBTRACTION: the output is the input minus something
// the tool fitted to it. That is what makes the result interpretable — the
// residual is in the same units as the signal, and adding the trend back
// reconstructs the original exactly. Nothing is rescaled, nothing is filtered.
//
// The polynomial fits (mean, linear and a chosen order are one code path) run
// on a CENTRED AND SCALED abscissa, u = (x − mid) / half ∈ [−1, 1], never on the
// raw one. A datetime axis carries epoch milliseconds — around 1.8e12 — and
// u³ of that overflows the useful precision of a double long before the fit
// gets anywhere. Centring costs one pass and makes the normal equations
// well-conditioned for any axis a file can carry.
//
// Non-finite samples take no part in the fit and stay non-finite in the output.
// A hole is not a data point, and a trend fitted through one would bend toward
// whatever the hole was filled with.

import { asFloat64, DataToolError, normalizeTimeContext } from './shared.js';
import { computeMovingAverage } from './moving-average.js';

export const DETREND_METHODS = new Set(['mean', 'linear', 'polynomial', 'movingAverage', 'firstSample']);

// Above this the normal equations stop being worth solving in double precision
// even on a scaled abscissa, and a "trend" with nine degrees of freedom is
// fitting the signal, not the drift under it.
export const DETREND_MAX_ORDER = 8;

export function normalizeDetrendOrder(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 2;
    return Math.max(2, Math.min(DETREND_MAX_ORDER, n));
}

export function normalizeDetrendWindow(value, maxLength = Infinity) {
    let n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = 101;
    const max = Number.isFinite(maxLength) ? Math.max(3, Math.round(maxLength)) : Number.MAX_SAFE_INTEGER;
    return Math.max(3, Math.min(max, n));
}

export function normalizeDetrendParams(params = {}) {
    const method = DETREND_METHODS.has(params.method) ? params.method : 'linear';
    return {
        method,
        order: normalizeDetrendOrder(params.order),
        window: normalizeDetrendWindow(params.window),
    };
}

// The polynomial order each method actually fits. Keeping mean and linear as
// orders 0 and 1 of the same solver means there is one place where a fit can be
// wrong, not three.
function polynomialOrder(settings) {
    if (settings.method === 'mean') return 0;
    if (settings.method === 'linear') return 1;
    return settings.order;
}

/** Gaussian elimination with partial pivoting. Returns null on a singular system. */
function solve(matrix, rhs) {
    const n = rhs.length;
    const m = matrix.map((row, i) => [...row, rhs[i]]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
        }
        if (!(Math.abs(m[pivot][col]) > 1e-300)) return null;
        if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];
        for (let row = col + 1; row < n; row++) {
            const factor = m[row][col] / m[col][col];
            if (factor === 0) continue;
            for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
        }
    }
    const out = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row--) {
        let sum = m[row][n];
        for (let col = row + 1; col < n; col++) sum -= m[row][col] * out[col];
        out[row] = sum / m[row][row];
    }
    return out.every(Number.isFinite) ? out : null;
}

/**
 * @returns {{
 *   values: Float64Array,
 *   coefficients: number[]|null, order: number|null,
 *   fitPoints: number, slope: number|null, usedTimeAxis: boolean,
 * }} `coefficients` are in the SCALED variable u, not in x — they are reported
 *   for the record, not for re-evaluation elsewhere. `slope` is the only one
 *   converted back to the file's own units (per second on a calendar axis),
 *   because a drift rate is a number people actually read.
 */
export function computeDetrend(sourceValues, time, params = {}) {
    const settings = normalizeDetrendParams(params);
    if (!DETREND_METHODS.has(settings.method)) throw new DataToolError('dataToolDetrendMethodUnknown');

    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = new Float64Array(n).fill(NaN);
    const report = {
        values: out, coefficients: null, order: null,
        fitPoints: 0, slope: null, usedTimeAxis: false,
    };
    if (!n) return report;

    if (settings.method === 'firstSample') {
        let anchor = NaN;
        for (let i = 0; i < n; i++) {
            if (Number.isFinite(values[i])) { anchor = values[i]; break; }
        }
        if (!Number.isFinite(anchor)) return report;
        for (let i = 0; i < n; i++) out[i] = values[i] - anchor;
        report.coefficients = [anchor];
        report.order = 0;
        report.fitPoints = 1;
        return report;
    }

    if (settings.method === 'movingAverage') {
        // Subtracting a centred moving average is a high-pass: what survives is
        // whatever moves faster than the window. Unlike a polynomial it follows a
        // wandering baseline, and unlike a filter it needs no coefficients.
        const window = normalizeDetrendWindow(settings.window, n);
        const baseline = computeMovingAverage(values, { window });
        let used = 0;
        for (let i = 0; i < n; i++) {
            if (!Number.isFinite(values[i]) || !Number.isFinite(baseline[i])) continue;
            out[i] = values[i] - baseline[i];
            used++;
        }
        report.fitPoints = used;
        return report;
    }

    const context = normalizeTimeContext(time);
    const x = context.kind !== 'index' && context.values && context.values.length === n
        ? context.values
        : null;
    report.usedTimeAxis = !!x;
    const xAt = x ? (i => x[i]) : (i => i);

    let min = Infinity;
    let max = -Infinity;
    let fitPoints = 0;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(values[i])) continue;
        const xi = xAt(i);
        if (!Number.isFinite(xi)) continue;
        if (xi < min) min = xi;
        if (xi > max) max = xi;
        fitPoints++;
    }
    report.fitPoints = fitPoints;

    const requested = Math.min(polynomialOrder(settings), Math.max(0, fitPoints - 1));
    // A fit needs one more point than its order. With none at all there is
    // nothing to remove and the input passes through unchanged rather than
    // becoming NaN.
    if (fitPoints === 0) {
        report.order = requested;
        out.set(values);
        return report;
    }

    const mid = (min + max) / 2;
    const half = (max - min) / 2 || 1;
    const scale = (xi) => (xi - mid) / half;

    // Normal equations over the scaled abscissa. Sums of powers up to 2·order,
    // accumulated once and read off the band.
    const powerSums = new Array(2 * requested + 1).fill(0);
    const rhs = new Array(requested + 1).fill(0);
    for (let i = 0; i < n; i++) {
        const y = values[i];
        if (!Number.isFinite(y)) continue;
        const xi = xAt(i);
        if (!Number.isFinite(xi)) continue;
        const u = scale(xi);
        let power = 1;
        for (let p = 0; p <= 2 * requested; p++) {
            powerSums[p] += power;
            if (p <= requested) rhs[p] += power * y;
            power *= u;
        }
    }

    // Step the order down until the system solves. A singular one means the
    // abscissa carries no information at THAT order — every sample at the same
    // instant makes a line undetermined — but the orders below it may still be
    // perfectly determined, and the mean always is. Refusing outright would
    // hand back the signal untouched when there was something real to remove.
    let order = requested;
    let coefficients = null;
    while (order >= 0) {
        const matrix = [];
        for (let r = 0; r <= order; r++) {
            const row = new Array(order + 1);
            for (let c = 0; c <= order; c++) row[c] = powerSums[r + c];
            matrix.push(row);
        }
        coefficients = solve(matrix, rhs.slice(0, order + 1));
        if (coefficients) break;
        order--;
    }
    report.order = order;
    if (!coefficients) {
        out.set(values);
        return report;
    }
    report.coefficients = coefficients;

    for (let i = 0; i < n; i++) {
        const y = values[i];
        if (!Number.isFinite(y)) continue;
        const xi = xAt(i);
        if (!Number.isFinite(xi)) continue;
        const u = scale(xi);
        let trend = 0;
        let power = 1;
        for (let p = 0; p <= order; p++) { trend += coefficients[p] * power; power *= u; }
        out[i] = y - trend;
    }

    if (order >= 1) {
        // dTrend/dx at the centre, converted out of the scaled variable and, on a
        // calendar axis, out of milliseconds. This is the drift rate the panel
        // quotes, so it has to be in the units the user thinks in.
        const perX = coefficients[1] / half;
        report.slope = context.kind === 'datetime' ? perX * 1000 : perX;
    }
    return report;
}
