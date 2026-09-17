// A digital filter from its own coefficients: y is the solution of
//
//     a₀·y[n] = b₀·x[n] + b₁·x[n−1] + … − a₁·y[n−1] − a₂·y[n−2] − …
//
// which is a plain FIR when `a` is just [a₀] and an IIR otherwise. The
// coefficients are typed by the user, or arrive as second-order sections from
// filter-design.js; nothing here designs a filter, and nothing here guesses
// what was meant.
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

import { asFloat64, copyFloat64, DataToolError, normalizeTimeContext } from './shared.js';
import { detectSamplingGaps } from '../../utils/sampling-gaps.js';

export const FILTER_MODES = new Set(['forward', 'zeroPhase']);

// Where the recursion starts from at the beginning of a run. All four describe
// the SAME thing — the filter's memory at the moment the data begins — in the
// terms most likely to be the ones the user is thinking in.
//
//   steady — as if the input had been constant at the run's first sample
//            forever. No transient that the data did not ask for.
//   zero   — at rest, which is what a real DSP does when it powers up.
//   level  — steady, but at a value the caller names: "the signal had been
//            sitting at 300 before the recording started". One number.
//   past   — the samples themselves: x[−1] … x[−N] and y[−1] … y[−N]. Fully
//            general (every state above is expressible this way) and the
//            convention MATLAB's filtic uses.
export const FILTER_INIT_MODES = new Set(['steady', 'zero', 'level', 'past']);

/** How many numbers a given init mode expects for a filter of this order. */
export function filterInitStateLength(mode, order) {
    if (mode === 'level') return 1;
    if (mode === 'past') return 2 * order;
    return 0;
}

export function normalizeFilterRestartGap(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(1e9, n);
}

// ── How long a filter may be ──────────────────────────────────────────────
//
// Two very different things are typed into the boxes. A DENSE filter — every
// coefficient meaningful, designed in MATLAB or here — is short: nobody types
// more than a few dozen numbers, and the O(N) per-sample recursion and the
// O(N²) stability test are free at that size. A SPARSE one is long and almost
// all zeros: the simple echo
//
//     y[n] = x[n] + 0.5·x[n − 2400]        b = 1 zeros(2399) 0.5,  a = 1
//
// is the first difference equation a signals course writes, and at 8 kHz its
// order is 2400 with two non-zero taps. Order and cost are unrelated there, so
// the limits are three, each bounding the thing that actually costs:
//
//   FILTER_DENSE_ORDER      up to this the plain direct-form loop runs (and
//                           the pole finder, and the past-samples init — all
//                           of them O(N²) or worse); above it the section is
//                           run as a sparse delay line that visits only the
//                           non-zero taps.
//   FILTER_MAX_ORDER        the longest delay a tap may reach: a state vector
//                           this long is 8 MB, and 2²⁰ samples is 24 s at
//                           44.1 kHz — an echo longer than that is not an echo.
//   FILTER_MAX_DENOMINATOR  the Schur–Cohn test is O(N²) in the DENOMINATOR
//                           order however sparse it is (the step-down fills
//                           in), so feedback delays stop well before 2²⁰.
//   FILTER_MAX_TAPS         non-zero coefficients, which is what every output
//                           sample pays for.
export const FILTER_DENSE_ORDER = 64;
export const FILTER_MAX_ORDER = 1 << 20;
export const FILTER_MAX_DENOMINATOR_ORDER = 16384;
export const FILTER_MAX_TAPS = 8192;

// `zeros(k)` as MATLAB writes it — `zeros(1,k)` and `zeros(k,1)` are the same
// row, and the NumPy spelling is taken too — so `[1 zeros(1,2399) 0.5]` pastes
// straight from a script. A count is a plain positive integer; anything else in
// the parentheses is left for the number parser to reject by name.
const ZEROS_GROUP = /(?:np\.|numpy\.)?zeros\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/gi;

/**
 * Coefficients as typed: commas, spaces, newlines, and MATLAB/NumPy brackets all
 * accepted, because that is what lands in the box when someone pastes from the
 * tool they designed the filter in. Runs of zeros may be written `zeros(k)`.
 *
 * @returns {{ values: number[]|null, badToken: string, tooLong?: boolean }}
 *   `values` is null when a token is not a number (`badToken` names it) or when
 *   a `zeros(k)` alone exceeds the longest filter accepted (`tooLong`).
 */
export function parseCoefficients(text) {
    // Each zeros(…) group is lifted out before the brackets are thrown away, so
    // its own parentheses and comma survive the cleaning the rest of the list
    // gets. The placeholder is not a number, and a stray '#' typed by hand is
    // caught below by not naming a group.
    const groups = [];
    const cleaned = String(text ?? '')
        .replace(ZEROS_GROUP, (match, rows, cols) => {
            groups.push({ text: match, count: Number(rows) * (cols === undefined ? 1 : Number(cols)) });
            return ` #${groups.length - 1} `;
        })
        .replace(/[[\]()]/g, ' ')
        .replace(/[;,]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const out = [];
    for (const token of tokens) {
        if (token[0] === '#') {
            const group = groups[Number(token.slice(1))];
            if (!group) return { values: null, badToken: token };
            if (!Number.isFinite(group.count) || group.count > FILTER_MAX_ORDER) return { values: null, badToken: group.text, tooLong: true };
            for (let i = 0; i < group.count; i++) out.push(0);
            continue;
        }
        const value = Number(token);
        if (!Number.isFinite(value)) return { values: null, badToken: token };
        out.push(value);
    }
    return { values: out, badToken: '' };
}

/**
 * The inverse of the `zeros(k)` spelling: a list with its runs of zeros folded
 * back, for descriptions and boxes where 2400 numbers would say less than
 * `1, zeros(2399), 0.5`. Short runs stay written out — `1, 0, 0, 0.5` is
 * easier to read than `1, zeros(2), 0.5`.
 */
export function formatSparseCoefficients(values, formatOne = value => String(value), minRun = 4) {
    const list = Array.from(values || [], Number);
    const parts = [];
    let i = 0;
    while (i < list.length) {
        if (list[i] === 0) {
            let end = i;
            while (end < list.length && list[end] === 0) end++;
            const run = end - i;
            if (run >= minRun) {
                parts.push(`zeros(${run})`);
                i = end;
                continue;
            }
        }
        parts.push(formatOne(list[i]));
        i++;
    }
    return parts.join(', ');
}

/** Indices ≥ 1 where either list has a non-zero coefficient — the taps. */
function nonZeroTaps(b, a) {
    const taps = [];
    const length = Math.max(b.length, a.length);
    for (let i = 1; i < length; i++) {
        if ((i < b.length && b[i] !== 0) || (i < a.length && a[i] !== 0)) taps.push(i);
    }
    return taps;
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
    if (a.length - 1 > FILTER_MAX_DENOMINATOR_ORDER) throw new DataToolError('dataToolFilterDenominatorTooLong');
    if (nonZeroTaps(b, a).length + 1 > FILTER_MAX_TAPS) throw new DataToolError('dataToolFilterTooManyTaps');

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
 * A trailing zero is a reflection coefficient of exactly 0, and the step-down
 * through it is the identity — so it is skipped rather than computed. That is
 * what makes an FIR (a = 1, padded with zeros to the numerator's length) a
 * decision in O(1), and a pure comb `1 zeros(N−1) −α` one in O(N): its first
 * step-down leaves 1 followed by nothing but zeros.
 *
 * @returns {{ stable: boolean, maxReflection: number }}
 */
export function schurCohnStable(a) {
    let poly = Float64Array.from(a);
    let maxReflection = 0;
    let m = poly.length - 1;
    while (m >= 1) {
        if (poly[m] === 0) { m--; continue; }
        const k = poly[m];
        const magnitude = Math.abs(k);
        if (magnitude > maxReflection) maxReflection = magnitude;
        if (!(magnitude < 1)) return { stable: false, maxReflection: magnitude };
        const denominator = 1 - k * k;
        const next = new Float64Array(m);
        next[0] = 1;
        for (let i = 1; i < m; i++) next[i] = (poly[i] - k * poly[m - i]) / denominator;
        poly = next;
        m--;
    }
    return { stable: true, maxReflection };
}

/**
 * Poles of A(z), by Durand–Kerner. Best-effort and DIAGNOSTIC ONLY — the verdict
 * is Schur–Cohn's above. Returned so the panel can say "a pole at |z| = 1.03"
 * instead of quoting a reflection coefficient nobody asked about.
 *
 * Root-finding a polynomial of degree 2400 is neither quick nor reliable, so
 * beyond the dense order the poles are simply not located — except for the
 * pure comb `1 zeros(N−1) a_N`, whose N poles all sit on the circle
 * |z| = |a_N|^(1/N): that one is the recursive echo, and its radius is what
 * tells the user the feedback gain must stay below 1.
 *
 * @returns {{ poles: Array<{re:number,im:number,r:number}>, maxRadius: number, converged: boolean }}
 */
export function denominatorPoles(a) {
    // 1 + a₁z⁻¹ + … + a_Nz⁻ᴺ = 0  ⟺  zᴺ + a₁z^{N−1} + … + a_N = 0.
    const coefficients = Array.from(a);
    while (coefficients.length > 1 && coefficients[coefficients.length - 1] === 0) coefficients.pop();
    const degree = coefficients.length - 1;
    if (degree < 1) return { poles: [], maxRadius: 0, converged: true };
    if (degree > FILTER_DENSE_ORDER) {
        const comb = coefficients.slice(1, degree).every(value => value === 0);
        if (!comb) return { poles: [], maxRadius: NaN, converged: false };
        const r = Math.pow(Math.abs(coefficients[degree]), 1 / degree);
        return { poles: [], maxRadius: r, converged: true };
    }

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

// ── Second-order sections ─────────────────────────────────────────────────
//
// A DESIGNED filter (filter-design.js) arrives as a cascade of second-order
// sections rather than one polynomial: at order 8 with a cut-off far below
// Nyquist the single polynomial's rounding alone can push a pole across the
// unit circle, while each section holds its own pole pair exactly. The cascade
// is run section by section, each with its own state, and everything else —
// the stability gate, the initial conditions, the gap policy — is the same
// machinery applied per section.

export const SOS_MAX_SECTIONS = 32;

/**
 * Sections as the recursion wants them: [{ b: Float64Array(3), a: Float64Array(3) }]
 * with a₀ = 1 in every section.
 * @throws {DataToolError} when the list cannot describe a filter at all.
 */
export function normalizeSos(rawSos) {
    if (!Array.isArray(rawSos) || !rawSos.length) throw new DataToolError('dataToolFilterEmpty');
    if (rawSos.length > SOS_MAX_SECTIONS) throw new DataToolError('dataToolFilterTooLong');
    return rawSos.map(row => {
        const values = Array.from(row || [], Number);
        if (values.length !== 6 || !values.every(Number.isFinite)) throw new DataToolError('dataToolFilterNotNumeric');
        const scale = values[3];
        if (!(Math.abs(scale) > 0)) throw new DataToolError('dataToolFilterLeadingZero');
        return {
            b: Float64Array.from([values[0] / scale, values[1] / scale, values[2] / scale]),
            a: Float64Array.from([1, values[4] / scale, values[5] / scale]),
        };
    });
}

/** Expand a cascade into one b/a pair — for display, never for running. */
export function sosToTransferFunction(rawSos) {
    const sections = normalizeSos(rawSos);
    const multiply = (p, q) => {
        const out = new Array(p.length + q.length - 1).fill(0);
        for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) out[i + j] += p[i] * q[j];
        return out;
    };
    let b = [1];
    let a = [1];
    for (const section of sections) {
        b = multiply(b, Array.from(section.b));
        a = multiply(a, Array.from(section.a));
    }
    // A first-order section carries a zero third coefficient; the product then
    // ends in a zero that says nothing about the filter and would inflate the
    // reported order.
    while (b.length > 1 && b[b.length - 1] === 0 && a[a.length - 1] === 0) { b.pop(); a.pop(); }
    return { b, a };
}

/** Poles of one section, exactly, from the quadratic formula. */
function sectionPoles(a) {
    const a1 = a[1];
    const a2 = a[2];
    if (a2 === 0) {
        if (a1 === 0) return [];
        return [{ re: -a1, im: 0, r: Math.abs(a1) }];
    }
    const disc = a1 * a1 - 4 * a2;
    if (disc >= 0) {
        const root = Math.sqrt(disc);
        return [(-a1 + root) / 2, (-a1 - root) / 2].map(re => ({ re, im: 0, r: Math.abs(re) }));
    }
    const re = -a1 / 2;
    const im = Math.sqrt(-disc) / 2;
    const r = Math.hypot(re, im);
    return [{ re, im, r }, { re, im: -im, r }];
}

/**
 * The verdict on a cascade — the same shape inspectFilter returns, so the panel
 * reads either without caring which it was given.
 */
export function inspectSos(rawSos) {
    const sections = normalizeSos(rawSos);
    let stable = true;
    let maxReflection = 0;
    let maxRadius = 0;
    let dcGain = 1;
    let order = 0;
    const poles = [];
    for (const { b, a } of sections) {
        const verdict = schurCohnStable(a);
        if (!verdict.stable) stable = false;
        maxReflection = Math.max(maxReflection, verdict.maxReflection);
        for (const pole of sectionPoles(a)) {
            poles.push(pole);
            if (pole.r > maxRadius) maxRadius = pole.r;
        }
        const numerator = b[0] + b[1] + b[2];
        const denominator = a[0] + a[1] + a[2];
        dcGain *= Math.abs(denominator) > 1e-300 ? numerator / denominator : Infinity;
        order += sectionOrder(b, a);
    }
    poles.sort((p, q) => q.r - p.r);
    const { b, a } = sosToTransferFunction(rawSos);
    return {
        b: Float64Array.from(b),
        a: Float64Array.from(a),
        sections,
        order,
        denominatorOrder: order,
        numeratorOrder: order,
        stable,
        maxReflection,
        maxPoleRadius: maxRadius,
        poles,
        dcGain,
        code: stable ? '' : 'dataToolFilterUnstable',
    };
}

function sectionOrder(b, a) {
    for (let k = b.length - 1; k >= 1; k--) if (b[k] !== 0 || a[k] !== 0) return k;
    return 0;
}

/**
 * The cascade a run uses, from whichever form the params carry. A `sos` list
 * takes precedence over b/a: a designed filter stores both, and the polynomial
 * is the one that must never run.
 * @returns {Array<{ b: Float64Array, a: Float64Array }>}
 */
function resolveSections(params) {
    if (Array.isArray(params.sos) && params.sos.length) {
        const inspection = inspectSos(params.sos);
        if (!inspection.stable) throw new DataToolError('dataToolFilterUnstable');
        return inspection.sections;
    }
    const inspection = inspectFilter(params.b, params.a);
    // Belt and braces: the panel refuses an unstable filter before ever getting
    // here, and so does this, because the kernel is also reachable from a
    // restored session whose coefficients were saved before this check existed.
    if (!inspection.stable) throw new DataToolError('dataToolFilterUnstable');
    return [makeSection(inspection.b, inspection.a)];
}

/**
 * A section as the recursion wants it. Above the dense order it also carries
 * its non-zero taps, which is what the sparse loop visits instead of the whole
 * state; a designed section (order 2) and a typed short one never do.
 */
function makeSection(b, a) {
    const order = Math.max(b.length, a.length) - 1;
    if (order <= FILTER_DENSE_ORDER) return { b, a };
    const indexes = nonZeroTaps(b, a);
    const taps = {
        index: Int32Array.from(indexes),
        b: Float64Array.from(indexes, i => (i < b.length ? b[i] : 0)),
        a: Float64Array.from(indexes, i => (i < a.length ? a[i] : 0)),
    };
    return { b, a, taps };
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
 * scipy solves (I − Aᵀ)·zi = b[1:] − a[1:]·b₀ with A the companion matrix of a.
 * The same numbers fall straight out of the transposed direct-form II update
 * once x ≡ 1 and y ≡ H(1) = Σb / Σa are put into it:
 *
 *     z_k = Σ_{i=k+1}^{N} ( b_i − a_i·H(1) )
 *
 * one suffix sum, O(N), which is what lets a 2400-tap echo start in its steady
 * state without a 2400×2400 matrix. The system is singular exactly when
 * Σa = 0 — a pole at z = 1, where no steady state exists — and the filter then
 * starts from rest, as it always did.
 */
export function filterInitialState(b, a) {
    const n = a.length;
    if (n < 2) return new Float64Array(0);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) { numerator += b[i]; denominator += a[i]; }
    const zi = new Float64Array(n - 1);
    if (!(Math.abs(denominator) > 1e-300)) return zi;
    const gain = numerator / denominator;
    if (!Number.isFinite(gain)) return zi;
    let sum = 0;
    for (let k = n - 2; k >= 0; k--) {
        sum += b[k + 1] - a[k + 1] * gain;
        zi[k] = Number.isFinite(sum) ? sum : 0;
    }
    return zi;
}

/**
 * The state a run carries: the transposed direct-form II vector z, plus where
 * z₀ currently sits. A dense section keeps z in place and shifts it every
 * sample, so `pos` stays 0; a sparse section keeps z in a ring and advances
 * `pos` instead — the shift then costs nothing and only the taps are touched.
 */
function makeRunningState(zi, scale = 1) {
    if (scale === 0) return { z: new Float64Array(zi.length), pos: 0 };
    return { z: Float64Array.from(zi, value => value * scale), pos: 0 };
}

/**
 * Direct form II transposed through a cascade, over a plain array. Each entry of
 * `states` is one section's running state and is modified in place. A single
 * section of arbitrary order (the typed b/a) and a chain of second-order
 * sections (a designed filter) are the same loop: the output of one section is
 * the input of the next.
 */
function runCascade(sections, states, input, reverse = false) {
    const n = input.length;
    const out = new Float64Array(n);
    for (let step = 0; step < n; step++) {
        const index = reverse ? n - 1 - step : step;
        out[index] = stepCascade(sections, states, input[index]);
    }
    return out;
}

/** One sample through every section. */
function stepCascade(sections, states, sample) {
    let x = sample;
    for (let s = 0; s < sections.length; s++) {
        const section = sections[s];
        x = section.taps ? stepSparse(section, states[s], x) : stepDense(section, states[s], x);
    }
    return x;
}

function stepDense({ b, a }, running, x) {
    const state = running.z;
    const order = state.length;
    const y = b[0] * x + (order ? state[0] : 0);
    for (let i = 0; i < order - 1; i++) state[i] = b[i + 1] * x + state[i + 1] - a[i + 1] * y;
    if (order) state[order - 1] = b[order] * x - a[order] * y;
    return y;
}

// The same update as stepDense, with z stored in a ring: z_k lives at
// (pos + k) mod N. Reading z₀ and advancing pos IS the shift, and the slot that
// held z₀ becomes the new z_{N−1}, which starts empty; then each tap i adds
// b_i·x − a_i·y into z_{i−1}. Only the taps are visited, so a 2400-sample echo
// with two of them costs two multiplications per sample rather than 2400.
function stepSparse({ b, taps }, running, x) {
    const state = running.z;
    const order = state.length;
    const y = b[0] * x + state[running.pos];
    state[running.pos] = 0;
    const pos = running.pos + 1 === order ? 0 : running.pos + 1;
    running.pos = pos;
    const { index, b: tb, a: ta } = taps;
    for (let t = 0; t < index.length; t++) {
        let slot = pos + index[t] - 1;
        if (slot >= order) slot -= order;
        state[slot] += tb[t] * x - ta[t] * y;
    }
    return y;
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

/**
 * Past samples → the recursion's internal state, i.e. MATLAB's `filtic`.
 *
 * Derived straight from the transposed direct-form II update by unrolling it
 * backwards: the state entering sample 0 is whatever the same recursion would
 * have left behind after processing x[−N..−1] and emitting y[−N..−1].
 *
 *     z_k = Σ_{i=k+1}^{N} ( b_i·x[k−i] − a_i·y[k−i] )
 *
 * Each z mixes past inputs AND past outputs, which is exactly why there are N
 * of them and not 2N — and why asking the user for z was asking the wrong
 * question. `xPast[j]` is x[−1−j] and `yPast[j]` is y[−1−j].
 */
export function stateFromPastSamples(b, a, xPast = [], yPast = []) {
    const order = Math.max(0, b.length - 1);
    const state = new Float64Array(order);
    const at = (list, index) => {
        const value = Number(list?.[index]);
        return Number.isFinite(value) ? value : 0;
    };
    // Only the taps contribute — a zero coefficient adds nothing whatever the
    // history was — so the sum runs over them, in ascending i for every k.
    const taps = nonZeroTaps(b, a);
    for (const i of taps) {
        const bi = i < b.length ? b[i] : 0;
        const ai = i < a.length ? a[i] : 0;
        for (let k = 0; k < i; k++) {
            const j = i - k - 1;   // x[k−i] is x[−(i−k)] is xPast[i−k−1]
            state[k] += bi * at(xPast, j) - ai * at(yPast, j);
        }
    }
    return state;
}

/**
 * Steady-state initial conditions for a whole cascade, i.e. scipy's
 * `sosfilt_zi`: each section's unit-step state, scaled by the DC gain of every
 * section before it, because that is the level a constant input has reached by
 * the time it arrives there.
 * @returns {Float64Array[]} one state per section, for a unit step
 */
export function cascadeInitialState(sections) {
    let level = 1;
    return sections.map(({ b, a }) => {
        const zi = filterInitialState(b, a);
        for (let i = 0; i < zi.length; i++) zi[i] *= level;
        let numerator = 0;
        let denominator = 0;
        for (let i = 0; i < b.length; i++) { numerator += b[i]; denominator += a[i]; }
        level *= Math.abs(denominator) > 1e-300 ? numerator / denominator : 0;
        return zi;
    });
}

/**
 * The states a run starts from, under the caller's chosen convention.
 * @param {Float64Array[]} zis steady-state solution for a unit step, per section
 * @param {number} first the run's first sample
 */
function startingStates(zis, first, init, sections) {
    if (init.mode === 'zero') return zis.map(zi => makeRunningState(zi, 0));
    if (init.mode === 'level') {
        // `zis` is the state for a unit step, so scaling it by the level gives
        // the state for a step of that height — the same arithmetic `steady`
        // does, with the height named rather than taken from the data.
        const level = Number(init.state?.[0]);
        const scale = Number.isFinite(level) ? level : first;
        return zis.map(zi => makeRunningState(zi, scale));
    }
    // Past samples describe the filter as a whole — x and y at its outer
    // terminals — which pins down the state of a SINGLE section exactly and of a
    // cascade not at all (the signals between sections are unknown). The panel
    // never offers this convention for a designed filter; a stored definition
    // that carries it anyway is read as steady state.
    if (init.mode === 'past' && sections.length === 1) {
        const { b, a } = sections[0];
        const order = zis[0].length;
        // Length is validated in the panel; a short list is padded with zeros
        // here rather than throwing, so a stored definition always reopens.
        return [makeRunningState(stateFromPastSamples(b, a, (init.state || []).slice(0, order), (init.state || []).slice(order)))];
    }
    return zis.map(zi => makeRunningState(zi, first));
}

export function normalizeFilterInit(params = {}) {
    const mode = FILTER_INIT_MODES.has(params.init) ? params.init : 'steady';
    const state = Array.isArray(params.initState)
        ? params.initState.map(Number).filter(Number.isFinite)
        : [];
    return { mode, state };
}

// Forward then backward: the two passes have opposite phase, so the phase
// distortion cancels exactly and a feature stays where it was. The price is a
// doubled magnitude response (the filter is applied twice) and a non-causal
// result, which is fine for a file that has already been recorded.
function filterSegmentZeroPhase(sections, zis, segment) {
    const n = segment.length;
    if (n < 2) return copyFloat64(segment);
    let totalOrder = 0;
    for (const zi of zis) totalOrder += zi.length;
    const padLength = Math.min(3 * Math.max(1, totalOrder), n - 1);
    const extended = padLength > 0 ? oddExtend(segment, padLength) : copyFloat64(segment);

    const forwardStates = zis.map(zi => makeRunningState(zi, extended[0]));
    const forward = runCascade(sections, forwardStates, extended, false);
    const backwardStates = zis.map(zi => makeRunningState(zi, forward[forward.length - 1]));
    const backward = runCascade(sections, backwardStates, forward, true);
    return backward.slice(padLength, padLength + n);
}

// ── What counts as a break in the signal ──────────────────────────────────
//
// A digital filter is defined per SAMPLE, not per second: the recursion has no
// idea how much time passed between two rows. So a hole matters twice over — the
// samples are missing AND the state carries a memory that is now out of date by
// however long the hole lasted.
//
// Two kinds of hole are therefore the same thing here and are measured the same
// way: rows that exist but hold NaN, and rows that do not exist at all because
// the logger stopped. `expectedBetween` converts both into one number — how many
// sample positions between two usable values carry no usable value.
//
// The nominal step comes from detectSamplingGaps (utils/sampling-gaps.js), the
// same detector the integral kernel already uses for the same question. It is
// deliberately one of several in this codebase — see docs and the project note —
// and this is the one that fits: eager, full-resolution, in-memory arrays.
function filterAxis(values, time) {
    const context = normalizeTimeContext(time);
    const x = context.kind !== 'index' && context.values && context.values.length === values.length
        ? context.values
        : null;
    if (!x) return { x: null, medianDt: NaN, hasNominalStep: false, reason: 'noTimeAxis' };
    const info = detectSamplingGaps(x);
    return {
        x,
        medianDt: info.medianDt,
        hasNominalStep: info.hasNominalStep,
        reason: info.reason,
        gapCount: info.count,
        totalMissing: info.totalMissing,
    };
}

function expectedBetween(axis, from, to) {
    const rows = to - from - 1;
    if (!axis.hasNominalStep || !axis.x) return rows;
    const dt = axis.x[to] - axis.x[from];
    if (!Number.isFinite(dt) || !(axis.medianDt > 0)) return rows;
    // Rounded to the nearest whole number of steps: ordinary jitter must not be
    // read as a fraction of a missing sample.
    return Math.max(rows, Math.max(0, Math.round(dt / axis.medianDt) - 1));
}

/**
 * Filter a series, through either the typed b/a or — when `params.sos` is
 * given — a cascade of second-order sections.
 *
 * Non-finite samples stay non-finite — a single NaN inside an IIR recursion
 * enters the state and every sample after it is NaN for the rest of the file.
 * What happens to the STATE across a hole is the caller's choice:
 *
 *   restartGap = 0  the state is rebuilt after any hole at all (the default).
 *                   Honest and simple: nothing is carried across a break.
 *   restartGap = N  a hole of at most N samples is stepped over with the state
 *                   left standing, so a single dropped sample does not cost a
 *                   whole settling transient. Anything longer restarts.
 *
 * Zero phase ignores restartGap: a backward pass cannot cross a hole, so each
 * contiguous run is padded and filtered on its own whatever the setting.
 *
 * @returns {{
 *   values: Float64Array, segments: number, restarts: number, carriedBreaks: number,
 *   filteredCount: number, skippedCount: number,
 *   irregular: boolean, irregularReason: string, medianDt: number,
 * }}
 */
export function applyFilter(sourceValues, params = {}) {
    const mode = FILTER_MODES.has(params.mode) ? params.mode : 'forward';
    const sections = resolveSections(params);
    const init = normalizeFilterInit(params);
    const tolerance = normalizeFilterRestartGap(params.restartGap);
    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = new Float64Array(n).fill(NaN);
    const zis = cascadeInitialState(sections);
    const axis = filterAxis(values, params.time);

    const report = {
        values: out,
        segments: 0, restarts: 0, carriedBreaks: 0,
        filteredCount: 0, skippedCount: 0,
        // A series with no nominal step has no meaningful sample rate, so the
        // filter's cut-off is not a frequency in the data's own units. The panel
        // warns; it does not refuse, because a slightly irregular axis is still
        // worth filtering and only the user knows whether it is.
        irregular: !axis.hasNominalStep,
        irregularReason: axis.hasNominalStep ? '' : (axis.reason || ''),
        medianDt: axis.medianDt,
    };
    if (!n) return report;

    if (mode === 'zeroPhase') {
        let i = 0;
        while (i < n) {
            if (!Number.isFinite(values[i])) { report.skippedCount++; i++; continue; }
            let end = i;
            while (end < n && Number.isFinite(values[end])) end++;
            out.set(filterSegmentZeroPhase(sections, zis, values.subarray(i, end)), i);
            report.segments++;
            report.restarts++;
            report.filteredCount += end - i;
            i = end;
        }
        return report;
    }

    let states = null;
    let lastValid = -1;
    for (let i = 0; i < n; i++) {
        const x = values[i];
        if (!Number.isFinite(x)) { report.skippedCount++; continue; }
        const hole = lastValid < 0 ? 0 : expectedBetween(axis, lastValid, i);
        if (states === null || hole > tolerance) {
            states = startingStates(zis, x, init, sections);
            report.restarts++;
            report.segments++;
        } else if (hole > 0) {
            report.carriedBreaks++;
        }
        out[i] = stepCascade(sections, states, x);
        report.filteredCount++;
        lastValid = i;
    }
    return report;
}
