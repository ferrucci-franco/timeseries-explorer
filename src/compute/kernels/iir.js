// A digital filter from its own coefficients: y is the solution of
//
//     a₀·y[n] = b₀·x[n] + b₁·x[n−1] + … − a₁·y[n−1] − a₂·y[n−2] − …
//
// which is a plain FIR when `a` is just [a₀] and an IIR otherwise. The user
// types b and a; nothing here designs a filter, and nothing here guesses what
// was meant.
//
// ── Why stability is a gate and not a warning ─────────────────────────────
//
// An IIR filter feeds its own output back. If any pole of A(z) sits on or
// outside the unit circle the recursion grows without bound, and on a
// million-sample trace the output reaches ±1e308 within a few thousand steps and
// is Infinity for the rest — after which every downstream tool, axis autoscale
// and export is poisoned by a result that was never a filtered signal. There is
// no partial credit here and no useful "unstable" output to inspect, so the
// tool refuses to run rather than producing one.
//
// The decision is made by the SCHUR–COHN test, not by root-finding: it is an
// exact decision procedure that reads the answer off the coefficients through
// the Levinson step-down recursion, in O(N²) and with no iteration to converge
// or fail to converge. Root-finding is done too, but only to say WHERE the
// offending pole is — a diagnosis, never the verdict.

import { asFloat64, copyFloat64, DataToolError } from './shared.js';

export const FILTER_MODES = new Set(['forward', 'zeroPhase']);

// A filter longer than this is not something anyone types into a text box, and
// the O(N²) stability test and the O(N) per-sample recursion both stop being
// free well before it.
export const FILTER_MAX_ORDER = 64;

/**
 * Coefficients as typed: commas, spaces, newlines, and MATLAB/NumPy brackets all
 * accepted, because that is what lands in the box when someone pastes from the
 * tool they designed the filter in.
 */
export function parseCoefficients(text) {
    const cleaned = String(text ?? '').replace(/[[\]()]/g, ' ').replace(/[;,]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const out = [];
    for (const token of tokens) {
        const value = Number(token);
        if (!Number.isFinite(value)) return { values: null, badToken: token };
        out.push(value);
    }
    return { values: out, badToken: '' };
}

/** Trailing zeros change nothing but inflate the reported order. */
function trimTrailingZeros(list) {
    const out = [...list];
    while (out.length > 1 && out[out.length - 1] === 0) out.pop();
    return out;
}

/**
 * b and a as the recursion wants them: same length, a normalized so a₀ = 1.
 * @throws {DataToolError} when the coefficients cannot describe a filter at all.
 */
export function normalizeFilterCoefficients(rawB, rawA) {
    const b = trimTrailingZeros((rawB && rawB.length ? rawB : [1]).map(Number));
    const a = trimTrailingZeros((rawA && rawA.length ? rawA : [1]).map(Number));
    if (!b.every(Number.isFinite) || !a.every(Number.isFinite)) throw new DataToolError('dataToolFilterNotNumeric');
    // a₀ divides every term. Zero there is not an unstable filter, it is not a
    // difference equation.
    if (!(Math.abs(a[0]) > 0)) throw new DataToolError('dataToolFilterLeadingZero');
    if (Math.max(a.length, b.length) - 1 > FILTER_MAX_ORDER) throw new DataToolError('dataToolFilterTooLong');

    const scale = a[0];
    const length = Math.max(a.length, b.length);
    const nb = new Float64Array(length);
    const na = new Float64Array(length);
    for (let i = 0; i < length; i++) {
        nb[i] = (i < b.length ? b[i] : 0) / scale;
        na[i] = (i < a.length ? a[i] : 0) / scale;
    }
    return { b: nb, a: na, order: length - 1, denominatorOrder: a.length - 1, numeratorOrder: b.length - 1 };
}

// ── Stability ─────────────────────────────────────────────────────────────

/**
 * Schur–Cohn (Levinson step-down). `a` must be normalized so a[0] = 1.
 *
 * At each stage the last coefficient IS the reflection coefficient of that
 * order, and the polynomial is stable exactly when every one of them has
 * magnitude below 1. |k| = 1 is not a borderline pass: it puts a pole on the
 * unit circle, where the recursion neither decays nor is bounded in general, and
 * the division by 1 − k² that continues the recursion is the same singularity
 * seen from the other side.
 *
 * @returns {{ stable: boolean, maxReflection: number }}
 */
export function schurCohnStable(a) {
    let poly = Array.from(a);
    let maxReflection = 0;
    for (let m = poly.length - 1; m >= 1; m--) {
        const k = poly[m];
        const magnitude = Math.abs(k);
        if (magnitude > maxReflection) maxReflection = magnitude;
        if (!(magnitude < 1)) return { stable: false, maxReflection: magnitude };
        const denominator = 1 - k * k;
        const next = new Array(m);
        next[0] = 1;
        for (let i = 1; i < m; i++) next[i] = (poly[i] - k * poly[m - i]) / denominator;
        poly = next;
    }
    return { stable: true, maxReflection };
}

/**
 * Poles of A(z), by Durand–Kerner. Best-effort and DIAGNOSTIC ONLY — the verdict
 * is Schur–Cohn's above. Returned so the panel can say "a pole at |z| = 1.03"
 * instead of quoting a reflection coefficient nobody asked about.
 * @returns {{ poles: Array<{re:number,im:number,r:number}>, maxRadius: number, converged: boolean }}
 */
export function denominatorPoles(a) {
    // 1 + a₁z⁻¹ + … + a_Nz⁻ᴺ = 0  ⟺  zᴺ + a₁z^{N−1} + … + a_N = 0.
    const coefficients = Array.from(a);
    while (coefficients.length > 1 && coefficients[coefficients.length - 1] === 0) coefficients.pop();
    const degree = coefficients.length - 1;
    if (degree < 1) return { poles: [], maxRadius: 0, converged: true };

    const evaluate = (re, im) => {
        let vr = 1;
        let vi = 0;
        for (let i = 1; i <= degree; i++) {
            const nr = vr * re - vi * im + coefficients[i];
            const ni = vr * im + vi * re;
            vr = nr;
            vi = ni;
        }
        return [vr, vi];
    };

    // The classic spiral start: distinct, off the real axis, so no two iterates
    // begin on top of each other.
    let re = new Array(degree);
    let im = new Array(degree);
    for (let i = 0; i < degree; i++) {
        const angle = (2 * Math.PI * i) / degree + 0.4;
        re[i] = 0.9 * Math.cos(angle);
        im[i] = 0.9 * Math.sin(angle);
    }

    let settled = false;
    for (let iteration = 0; iteration < 500 && !settled; iteration++) {
        let maxStep = 0;
        for (let i = 0; i < degree; i++) {
            const [pr, pi] = evaluate(re[i], im[i]);
            let dr = 1;
            let di = 0;
            for (let j = 0; j < degree; j++) {
                if (j === i) continue;
                const xr = re[i] - re[j];
                const xi = im[i] - im[j];
                const nr = dr * xr - di * xi;
                const ni = dr * xi + di * xr;
                dr = nr;
                di = ni;
            }
            const magnitude = dr * dr + di * di;
            if (!(magnitude > 1e-300)) continue;
            const qr = (pr * dr + pi * di) / magnitude;
            const qi = (pi * dr - pr * di) / magnitude;
            re[i] -= qr;
            im[i] -= qi;
            maxStep = Math.max(maxStep, Math.abs(qr) + Math.abs(qi));
        }
        if (maxStep < 1e-13) settled = true;
    }

    // Convergence is judged by the RESIDUAL, not by the step size. Durand–Kerner
    // converges only linearly onto a repeated root, so a double pole at z = 1 —
    // a double integrator, one of the most ordinary things anyone types here —
    // never gets its step below a step-based tolerance, and a step-based verdict
    // would throw away a perfectly good answer for exactly the case where the
    // user most needs to be told where the pole is.
    let scale = 0;
    for (const coefficient of coefficients) scale += Math.abs(coefficient);
    let maxResidual = 0;
    for (let i = 0; i < degree; i++) {
        if (!Number.isFinite(re[i]) || !Number.isFinite(im[i])) return { poles: [], maxRadius: NaN, converged: false };
        const [pr, pi] = evaluate(re[i], im[i]);
        maxResidual = Math.max(maxResidual, Math.hypot(pr, pi));
    }
    const converged = settled || maxResidual <= 1e-6 * Math.max(1, scale);
    if (!converged) return { poles: [], maxRadius: NaN, converged: false };

    const poles = [];
    let maxRadius = 0;
    for (let i = 0; i < degree; i++) {
        const r = Math.hypot(re[i], im[i]);
        poles.push({ re: re[i], im: im[i], r });
        if (r > maxRadius) maxRadius = r;
    }
    poles.sort((p, q) => q.r - p.r);
    return { poles, maxRadius, converged: true };
}

/**
 * The full verdict on a pair of coefficient lists.
 * @returns {{ b, a, order, stable, maxReflection, maxPoleRadius, poles, dcGain, code }}
 *   `code` is '' when the filter is usable, and an i18n key when it is not.
 */
export function inspectFilter(rawB, rawA) {
    const normalized = normalizeFilterCoefficients(rawB, rawA);
    const { b, a } = normalized;
    const { stable, maxReflection } = schurCohnStable(a);
    const { poles, maxRadius, converged } = denominatorPoles(a);

    // H(1): what the filter does to a constant. Quoted because "gain 0" explains
    // a result that came out flat at zero far better than the coefficients do.
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < b.length; i++) { numerator += b[i]; denominator += a[i]; }
    const dcGain = Math.abs(denominator) > 1e-300 ? numerator / denominator : Infinity;

    return {
        ...normalized,
        stable,
        maxReflection,
        maxPoleRadius: converged ? maxRadius : NaN,
        poles: converged ? poles : [],
        dcGain,
        code: stable ? '' : 'dataToolFilterUnstable',
    };
}

// ── Running the filter ────────────────────────────────────────────────────

/**
 * Steady-state initial conditions for a unit step, i.e. scipy's `lfilter_zi`.
 *
 * Without this the filter starts from rest and a signal sitting at 300 K opens
 * with a swing from zero that has nothing to do with the data — the single most
 * common "the filter broke my signal" report there is. Pre-loading the state as
 * if the input had been constant at its first sample forever makes the output
 * start where the signal does.
 *
 * Solves (I − Aᵀ)·zi = b[1:] − a[1:]·b₀, with A the companion matrix of a.
 */
export function filterInitialState(b, a) {
    const n = a.length;
    if (n < 2) return new Float64Array(0);
    const size = n - 1;
    // I − Aᵀ, where A is the companion matrix of a: column 0 holds −a[row+1] and
    // the first superdiagonal holds 1. The two never land on the same cell (that
    // would need row = −1), so each is written once.
    const matrix = [];
    for (let row = 0; row < size; row++) {
        const line = new Array(size).fill(0);
        for (let col = 0; col < size; col++) {
            let value = row === col ? 1 : 0;
            if (col === 0) value += a[row + 1];
            else if (col === row + 1) value -= 1;
            line[col] = value;
        }
        matrix.push(line);
    }
    const rhs = new Array(size);
    for (let i = 0; i < size; i++) rhs[i] = b[i + 1] - a[i + 1] * b[0];

    const solved = solveLinear(matrix, rhs);
    const zi = new Float64Array(size);
    if (!solved) return zi;   // rest state: a degenerate system is not worth failing over
    for (let i = 0; i < size; i++) zi[i] = Number.isFinite(solved[i]) ? solved[i] : 0;
    return zi;
}

function solveLinear(matrix, rhs) {
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
    return out;
}

/** Direct form II transposed, over a plain array. `state` is modified in place. */
function lfilter(b, a, input, state, reverse = false) {
    const n = input.length;
    const order = state.length;
    const out = new Float64Array(n);
    for (let step = 0; step < n; step++) {
        const index = reverse ? n - 1 - step : step;
        const x = input[index];
        const y = b[0] * x + (order ? state[0] : 0);
        for (let i = 0; i < order - 1; i++) state[i] = b[i + 1] * x + state[i + 1] - a[i + 1] * y;
        if (order) state[order - 1] = b[order] * x - a[order] * y;
        out[index] = y;
    }
    return out;
}

// Odd reflection about the endpoint: 2·y[0] − y[k]. Continuous in value and in
// slope at the join, so the padding does not itself look like an edge to the
// filter — which is the whole reason for padding rather than zero-filling.
function oddExtend(segment, padLength) {
    const n = segment.length;
    const out = new Float64Array(n + 2 * padLength);
    for (let i = 0; i < padLength; i++) {
        out[i] = 2 * segment[0] - segment[padLength - i];
        out[padLength + n + i] = 2 * segment[n - 1] - segment[n - 2 - i];
    }
    out.set(segment, padLength);
    return out;
}

function filterSegmentForward(b, a, segment) {
    const zi = filterInitialState(b, a);
    const state = Float64Array.from(zi, value => value * segment[0]);
    return lfilter(b, a, segment, state);
}

// Forward then backward: the two passes have opposite phase, so the phase
// distortion cancels exactly and a feature stays where it was. The price is a
// doubled magnitude response (the filter is applied twice) and a non-causal
// result, which is fine for a file that has already been recorded.
function filterSegmentZeroPhase(b, a, segment) {
    const n = segment.length;
    const zi = filterInitialState(b, a);
    if (n < 2) return copyFloat64(segment);
    const padLength = Math.min(3 * Math.max(1, zi.length), n - 1);
    const extended = padLength > 0 ? oddExtend(segment, padLength) : copyFloat64(segment);

    const forwardState = Float64Array.from(zi, value => value * extended[0]);
    const forward = lfilter(b, a, extended, forwardState);
    const backwardState = Float64Array.from(zi, value => value * forward[forward.length - 1]);
    const backward = lfilter(b, a, forward, backwardState, true);
    return backward.slice(padLength, padLength + n);
}

/**
 * Filter a series. Each run of consecutive finite samples is filtered on its
 * own and non-finite samples stay non-finite.
 *
 * That is not a convenience: a single NaN inside an IIR recursion enters the
 * state and every sample after it is NaN for the rest of the file. Restarting at
 * each hole confines the damage to the hole, which is also the same promise the
 * resampling tool makes — a hole stays a hole, and the tool that bridges one is
 * Fill missing data.
 *
 * @returns {{ values: Float64Array, segments: number, filteredCount: number, skippedCount: number }}
 */
export function applyFilter(sourceValues, params = {}) {
    const mode = FILTER_MODES.has(params.mode) ? params.mode : 'forward';
    const inspection = inspectFilter(params.b, params.a);
    // Belt and braces: the panel refuses an unstable filter before ever getting
    // here, and so does this, because the kernel is also reachable from a
    // restored session whose coefficients were saved before this check existed.
    if (!inspection.stable) throw new DataToolError('dataToolFilterUnstable');

    const { b, a } = inspection;
    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = new Float64Array(n).fill(NaN);
    let segments = 0;
    let filteredCount = 0;
    let skippedCount = 0;

    let i = 0;
    while (i < n) {
        if (!Number.isFinite(values[i])) { skippedCount++; i++; continue; }
        let end = i;
        while (end < n && Number.isFinite(values[end])) end++;
        const segment = values.subarray(i, end);
        const filtered = mode === 'zeroPhase'
            ? filterSegmentZeroPhase(b, a, segment)
            : filterSegmentForward(b, a, segment);
        out.set(filtered, i);
        segments++;
        filteredCount += end - i;
        i = end;
    }
    return { values: out, segments, filteredCount, skippedCount };
}
