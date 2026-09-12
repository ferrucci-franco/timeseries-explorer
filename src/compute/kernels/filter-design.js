// Classic filter design: a specification in, coefficients out.
//
//     family (Butterworth, Chebyshev I, Chebyshev II, Bessel)
//   + response (low-pass, high-pass, band-pass, band-stop)
//   + order, cut-off frequency(ies), ripple / attenuation
//   + the data's sample rate
//   → second-order sections the IIR kernel can run, and b/a for display.
//
// The route is the textbook one, and the one MATLAB's butter/cheby1/cheby2/
// besself and scipy's iirfilter take: an ANALOG low-pass prototype normalised to
// 1 rad/s, the analog frequency transformation to the wanted response, then the
// bilinear transform with the cut-off pre-warped so the digital filter lands on
// the frequency the user typed. So the families the panel names are "analog"
// in the sense the textbooks use — the shape of the response is that of the
// analog design — while what runs is, necessarily, a digital filter: the data
// is sampled and nothing else can be applied to it.
//
// ── Why the output is second-order sections ──────────────────────────────
//
// A designed filter of order 8 with a cut-off at fs/100 has all eight poles
// crowded near z = 1. Expanded into a single polynomial the coefficients need
// more precision than a double carries: the rounding alone moves a pole across
// the unit circle, and the stability gate in iir.js (rightly) refuses a filter
// the user asked for in good faith. Factored into second-order sections every
// pole is represented by two numbers that ARE its own quadratic, the rounding
// is per section, and the same design runs cleanly at any order the panel
// allows. The single b/a is still produced, for the coefficient boxes and for
// pasting into another tool, but it is never what runs.
//
// Everything here works on complex numbers as [re, im] pairs and is pure:
// no DOM, no i18n, no app state, so it can run in the compute worker.

import { DataToolError } from './shared.js';

export const FILTER_DESIGN_FAMILIES = new Set(['butterworth', 'chebyshev1', 'chebyshev2', 'bessel']);
export const FILTER_DESIGN_RESPONSES = new Set(['lowpass', 'highpass', 'bandpass', 'bandstop']);
export const FILTER_DESIGN_MIN_ORDER = 1;
// Prototype order. A band-pass or band-stop of prototype order N is a digital
// filter of order 2N; 12 keeps the largest at 24, still a handful of sections.
export const FILTER_DESIGN_MAX_ORDER = 12;
export const FILTER_DESIGN_DEFAULT_ORDER = 4;
export const FILTER_DESIGN_DEFAULT_RIPPLE_DB = 1;
export const FILTER_DESIGN_DEFAULT_ATTENUATION_DB = 40;
// Ripple deeper than this describes a filter nobody wants and a prototype whose
// poles sit numerically on the imaginary axis; attenuation above it is beyond
// what a double-precision cascade can honour anyway.
export const FILTER_DESIGN_MAX_RIPPLE_DB = 30;
export const FILTER_DESIGN_MAX_ATTENUATION_DB = 150;

// ── Complex helpers ───────────────────────────────────────────────────────

const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cscale = (a, s) => [a[0] * s, a[1] * s];
const cabs = (a) => Math.hypot(a[0], a[1]);
const cdiv = (a, b) => {
    const d = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const csqrt = (a) => {
    const r = cabs(a);
    const re = Math.sqrt(Math.max(0, (r + a[0]) / 2));
    const im = Math.sqrt(Math.max(0, (r - a[0]) / 2));
    return [re, a[1] < 0 ? -im : im];
};
const cprod = (list) => list.reduce((acc, value) => cmul(acc, value), [1, 0]);
const cneg = (a) => [-a[0], -a[1]];

// ── Analog low-pass prototypes (cut-off 1 rad/s) ──────────────────────────
//
// Each returns { zeros, poles, gain } with poles in the left half-plane. The
// formulas are those of scipy's buttap / cheb1ap / cheb2ap / besselap, which
// are in turn the ones in every filter-design text.

function butterworthPrototype(order) {
    const poles = [];
    for (let k = 0; k < order; k++) {
        const angle = Math.PI * (2 * k + order + 1) / (2 * order);
        poles.push([Math.cos(angle), Math.sin(angle)]);
    }
    return { zeros: [], poles, gain: 1 };
}

function chebyshev1Prototype(order, rippleDb) {
    const eps = Math.sqrt(10 ** (0.1 * rippleDb) - 1);
    const mu = Math.asinh(1 / eps) / order;
    const poles = [];
    for (let m = -order + 1; m < order; m += 2) {
        const theta = Math.PI * m / (2 * order);
        // −sinh(μ + jθ)
        poles.push([-Math.sinh(mu) * Math.cos(theta), -Math.cosh(mu) * Math.sin(theta)]);
    }
    let gain = cprod(poles.map(cneg))[0];
    // An even-order Chebyshev I has its ripple trough at DC, so the DC gain is
    // 1/√(1+ε²) rather than 1 — the convention MATLAB and scipy both follow.
    if (order % 2 === 0) gain /= Math.sqrt(1 + eps * eps);
    return { zeros: [], poles, gain };
}

function chebyshev2Prototype(order, attenuationDb) {
    const de = 1 / Math.sqrt(10 ** (0.1 * attenuationDb) - 1);
    const mu = Math.asinh(1 / de) / order;
    const zeros = [];
    const poles = [];
    for (let m = -order + 1; m < order; m += 2) {
        const theta = Math.PI * m / (2 * order);
        // Zeros on the imaginary axis at ±j/sin(θ); an odd order has θ = 0 in
        // the middle of the list, whose zero is at infinity and is simply absent.
        if (m !== 0) zeros.push([0, 1 / Math.sin(theta)]);
        // Poles: the reciprocals of the Chebyshev I poles at this order.
        const angle = Math.PI * m / (2 * order);
        const p = [-Math.sinh(mu) * Math.cos(angle), -Math.cosh(mu) * Math.sin(angle)];
        poles.push(cdiv([1, 0], p));
    }
    const gain = cdiv(cprod(poles.map(cneg)), cprod(zeros.map(cneg)))[0];
    return { zeros, poles, gain };
}

// Reverse Bessel polynomial θ_N(s) = Σ a_k s^k, a_k = (2N−k)! / (2^(N−k) k! (N−k)!).
function reverseBesselCoefficients(order) {
    const factorial = (n) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
    const out = new Array(order + 1);
    for (let k = 0; k <= order; k++) {
        out[k] = factorial(2 * order - k) / (2 ** (order - k) * factorial(k) * factorial(order - k));
    }
    return out;   // ascending powers
}

// Roots of a real polynomial (ascending coefficients) by Durand–Kerner with a
// Newton polish. Degree ≤ 12 here, and the Bessel polynomial's roots are simple
// and well separated, so the iteration converges in a few dozen steps.
function polynomialRoots(ascending) {
    const degree = ascending.length - 1;
    const lead = ascending[degree];
    const monic = ascending.map(c => c / lead);   // ascending, monic
    const evaluate = (z) => {
        let value = [0, 0];
        let derivative = [0, 0];
        for (let k = degree; k >= 0; k--) {
            derivative = cadd(cmul(derivative, z), value);
            value = cadd(cmul(value, z), [monic[k], 0]);
        }
        return { value, derivative };
    };
    const radius = Math.max(1e-3, Math.abs(monic[0]) ** (1 / degree));
    let roots = [];
    for (let i = 0; i < degree; i++) {
        const angle = (2 * Math.PI * i) / degree + 0.4;
        roots.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
    for (let iteration = 0; iteration < 1000; iteration++) {
        let maxStep = 0;
        for (let i = 0; i < degree; i++) {
            let denominator = [1, 0];
            for (let j = 0; j < degree; j++) {
                if (j !== i) denominator = cmul(denominator, csub(roots[i], roots[j]));
            }
            if (!(cabs(denominator) > 1e-300)) continue;
            const step = cdiv(evaluate(roots[i]).value, denominator);
            roots[i] = csub(roots[i], step);
            maxStep = Math.max(maxStep, cabs(step));
        }
        if (maxStep < 1e-14 * Math.max(1, radius)) break;
    }
    // Newton polish, a few steps each: takes the linear-convergence tail of
    // Durand–Kerner down to the last bit.
    roots = roots.map(root => {
        let z = root;
        for (let n = 0; n < 8; n++) {
            const { value, derivative } = evaluate(z);
            if (!(cabs(derivative) > 1e-300)) break;
            const step = cdiv(value, derivative);
            z = csub(z, step);
            if (cabs(step) < 1e-16 * Math.max(1, cabs(z))) break;
        }
        return z;
    });
    // Conjugate symmetry is a property of the polynomial; make it exact in the
    // result so pairs are later recognised by equality, not by tolerance alone.
    return roots.map(z => (Math.abs(z[1]) < 1e-12 * Math.max(1, cabs(z)) ? [z[0], 0] : z));
}

// Bessel, normalised so the magnitude is −3 dB at 1 rad/s ("mag" in scipy's
// terms). The natural normalisation of the polynomial is unit group delay,
// which puts the −3 dB point somewhere else for every order; a user who types
// a cut-off frequency means the −3 dB point, as for the other families.
function besselPrototype(order) {
    const raw = polynomialRoots(reverseBesselCoefficients(order));
    // |H(jω)| = Π|p_k| / Π|jω − p_k| is monotone for a Bessel filter, so the
    // −3 dB frequency is found by bisection.
    const magnitude = (w) => {
        let num = 1;
        let den = 1;
        for (const p of raw) { num *= cabs(p); den *= cabs(csub([0, w], p)); }
        return num / den;
    };
    let lo = 0;
    let hi = 1;
    while (magnitude(hi) > Math.SQRT1_2) hi *= 2;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (magnitude(mid) > Math.SQRT1_2) lo = mid; else hi = mid;
    }
    const w3 = (lo + hi) / 2;
    const poles = raw.map(p => cscale(p, 1 / w3));
    return { zeros: [], poles, gain: cprod(poles.map(cneg))[0] };
}

export function analogPrototype(family, order, { rippleDb, attenuationDb } = {}) {
    if (family === 'chebyshev1') return chebyshev1Prototype(order, rippleDb);
    if (family === 'chebyshev2') return chebyshev2Prototype(order, attenuationDb);
    if (family === 'bessel') return besselPrototype(order);
    return butterworthPrototype(order);
}

// ── Analog frequency transformations (zpk form) ──────────────────────────

function lp2lp({ zeros, poles, gain }, wo) {
    const degree = poles.length - zeros.length;
    return {
        zeros: zeros.map(z => cscale(z, wo)),
        poles: poles.map(p => cscale(p, wo)),
        gain: gain * wo ** degree,
    };
}

function lp2hp({ zeros, poles, gain }, wo) {
    const degree = poles.length - zeros.length;
    const w = [wo, 0];
    const newZeros = zeros.map(z => cdiv(w, z));
    const newPoles = poles.map(p => cdiv(w, p));
    for (let i = 0; i < degree; i++) newZeros.push([0, 0]);
    const k = gain * cdiv(cprod(zeros.map(cneg)), cprod(poles.map(cneg)))[0];
    return { zeros: newZeros, poles: newPoles, gain: k };
}

// Each prototype root r becomes the pair r·bw/2 ± sqrt((r·bw/2)² − wo²).
function splitBand(root, bw, wo) {
    const scaled = cscale(root, bw / 2);
    const disc = csqrt(csub(cmul(scaled, scaled), [wo * wo, 0]));
    return [cadd(scaled, disc), csub(scaled, disc)];
}

function lp2bp({ zeros, poles, gain }, wo, bw) {
    const degree = poles.length - zeros.length;
    const newZeros = zeros.flatMap(z => splitBand(z, bw, wo));
    const newPoles = poles.flatMap(p => splitBand(p, bw, wo));
    for (let i = 0; i < degree; i++) newZeros.push([0, 0]);
    return { zeros: newZeros, poles: newPoles, gain: gain * bw ** degree };
}

function lp2bs({ zeros, poles, gain }, wo, bw) {
    const degree = poles.length - zeros.length;
    const half = [bw / 2, 0];
    const invert = list => list.map(r => cdiv(half, r));
    const newZeros = invert(zeros).flatMap(z => splitBand([z[0], z[1]], 2, wo));
    const newPoles = invert(poles).flatMap(p => splitBand([p[0], p[1]], 2, wo));
    for (let i = 0; i < degree; i++) newZeros.push([0, wo], [0, -wo]);
    const k = gain * cdiv(cprod(zeros.map(cneg)), cprod(poles.map(cneg)))[0];
    return { zeros: newZeros, poles: newPoles, gain: k };
}

// ── Bilinear transform ────────────────────────────────────────────────────
//
// s = 2·fs·(z − 1)/(z + 1). Every analog root r maps to (2fs + r)/(2fs − r),
// and the `degree` zeros the analog filter had at infinity land at z = −1.
function bilinear({ zeros, poles, gain }, fs) {
    const fs2 = [2 * fs, 0];
    const degree = poles.length - zeros.length;
    const map = r => cdiv(cadd(fs2, r), csub(fs2, r));
    const newZeros = zeros.map(map);
    const newPoles = poles.map(map);
    for (let i = 0; i < degree; i++) newZeros.push([-1, 0]);
    const k = gain * cdiv(cprod(zeros.map(z => csub(fs2, z))), cprod(poles.map(p => csub(fs2, p))))[0];
    return { zeros: newZeros, poles: newPoles, gain: k };
}

// ── zpk → polynomial and zpk → second-order sections ──────────────────────

// Coefficients of Π(z − r_k), ascending in z⁻¹ (i.e. [1, −Σr, …]), real part
// only: the roots come in conjugate pairs so the imaginary parts cancel.
function polynomialFromRoots(roots) {
    let poly = [[1, 0]];
    for (const r of roots) {
        const next = new Array(poly.length + 1).fill(null).map(() => [0, 0]);
        for (let i = 0; i < poly.length; i++) {
            next[i] = cadd(next[i], poly[i]);
            next[i + 1] = csub(next[i + 1], cmul(poly[i], r));
        }
        poly = next;
    }
    return poly.map(c => c[0]);
}

export function zpkToTransferFunction({ zeros, poles, gain }) {
    const b = polynomialFromRoots(zeros).map(c => c * gain);
    const a = polynomialFromRoots(poles);
    // Same length, as the IIR kernel wants them.
    while (b.length < a.length) b.push(0);
    while (a.length < b.length) a.push(0);
    return { b, a };
}

// Roots → groups: conjugate pairs first, then real roots paired with their
// nearest real neighbour, and at most one real root left on its own.
function groupRoots(roots) {
    const pool = roots.map(r => ({ r, used: false }));
    const groups = [];
    const isReal = r => Math.abs(r[1]) <= 1e-10 * Math.max(1, cabs(r));
    for (const entry of pool) {
        if (entry.used || isReal(entry.r)) continue;
        entry.used = true;
        // Its conjugate: the closest unused root to conj(r).
        const target = [entry.r[0], -entry.r[1]];
        let best = null;
        let bestDistance = Infinity;
        for (const other of pool) {
            if (other.used || isReal(other.r)) continue;
            const distance = cabs(csub(other.r, target));
            if (distance < bestDistance) { bestDistance = distance; best = other; }
        }
        if (best) {
            best.used = true;
            groups.push([entry.r, [entry.r[0], -entry.r[1]]]);   // exact conjugate
        } else {
            groups.push([entry.r]);
        }
    }
    const reals = pool.filter(entry => !entry.used).map(entry => [entry.r[0], 0]).sort((p, q) => p[0] - q[0]);
    // Pair adjacent real roots after sorting: the nearest neighbours, which
    // keeps each section's quadratic well conditioned.
    let i = 0;
    while (i + 1 < reals.length) { groups.push([reals[i], reals[i + 1]]); i += 2; }
    if (i < reals.length) groups.push([reals[i]]);
    return groups;
}

const groupCentre = group => {
    const sum = group.reduce((acc, r) => cadd(acc, r), [0, 0]);
    return cscale(sum, 1 / group.length);
};

/**
 * Pair poles with zeros into second-order sections. Each section is
 * [b0, b1, b2, 1, a1, a2]. The pole pairs closest to the unit circle get the
 * nearest zero pairs (which cancels the most gain within one section), and are
 * placed LAST in the cascade, as scipy's zpk2sos does.
 */
export function zpkToSos({ zeros, poles, gain }) {
    if (!poles.length) return [[gain, 0, 0, 1, 0, 0]];
    const poleGroups = groupRoots(poles);
    const zeroGroups = groupRoots(zeros);
    // Closest to the unit circle first.
    poleGroups.sort((p, q) => {
        const dp = Math.min(...p.map(r => Math.abs(1 - cabs(r))));
        const dq = Math.min(...q.map(r => Math.abs(1 - cabs(r))));
        return dp - dq;
    });
    const remaining = zeroGroups.map(group => ({ group, used: false }));
    const sections = [];
    for (const pg of poleGroups) {
        const centre = groupCentre(pg);
        let best = null;
        let bestDistance = Infinity;
        for (const candidate of remaining) {
            if (candidate.used) continue;
            // A lone real pole takes a lone real zero when one exists, so the
            // section stays first order.
            if (pg.length === 1 && candidate.group.length !== 1) continue;
            if (pg.length === 2 && candidate.group.length === 1 && remaining.some(c => !c.used && c.group.length === 2)) continue;
            const distance = cabs(csub(groupCentre(candidate.group), centre));
            if (distance < bestDistance) { bestDistance = distance; best = candidate; }
        }
        if (best) best.used = true;
        const zg = best ? best.group : [];
        const bPoly = polynomialFromRoots(zg);
        const aPoly = polynomialFromRoots(pg);
        const b = [bPoly[0] || 0, bPoly[1] || 0, bPoly[2] || 0];
        const a = [1, aPoly[1] || 0, aPoly[2] || 0];
        sections.push([b[0], b[1], b[2], a[0], a[1], a[2]]);
    }
    // Any zero groups left over (more zeros than poles never happens for these
    // designs, but the function should not silently drop them) become FIR sections.
    for (const candidate of remaining) {
        if (candidate.used) continue;
        const bPoly = polynomialFromRoots(candidate.group);
        sections.push([bPoly[0] || 0, bPoly[1] || 0, bPoly[2] || 0, 1, 0, 0]);
    }
    // Worst (closest to the unit circle) last; the overall gain goes on the
    // first section.
    sections.reverse();
    for (let i = 0; i < 3; i++) sections[0][i] *= gain;
    return sections;
}

// ── Response evaluation ───────────────────────────────────────────────────

/** Complex frequency response of a section cascade at normalised ω (rad/sample). */
export function sosResponse(sos, omega) {
    const z1 = [Math.cos(-omega), Math.sin(-omega)];   // z⁻¹
    const z2 = cmul(z1, z1);
    let h = [1, 0];
    for (const [b0, b1, b2, a0, a1, a2] of sos) {
        const num = cadd([b0, 0], cadd(cscale(z1, b1), cscale(z2, b2)));
        const den = cadd([a0, 0], cadd(cscale(z1, a1), cscale(z2, a2)));
        h = cmul(h, cdiv(num, den));
    }
    return h;
}

export function sosMagnitudeDb(sos, omega) {
    const magnitude = cabs(sosResponse(sos, omega));
    return magnitude > 0 ? 20 * Math.log10(magnitude) : -Infinity;
}

// ── The specification ─────────────────────────────────────────────────────

export function normalizeFilterDesignOrder(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return FILTER_DESIGN_DEFAULT_ORDER;
    return Math.max(FILTER_DESIGN_MIN_ORDER, Math.min(FILTER_DESIGN_MAX_ORDER, n));
}

function clampDb(value, fallback, max) {
    const n = Number(value);
    if (!Number.isFinite(n) || !(n > 0)) return fallback;
    return Math.min(max, n);
}

/**
 * A design as the kernel wants it: known family and response, order in range,
 * the cut-offs as a list of one or two finite numbers (unvalidated against the
 * sample rate — that is `designFilter`'s job, because only it knows fs).
 */
export function normalizeFilterDesign(params = {}) {
    const family = FILTER_DESIGN_FAMILIES.has(params.family) ? params.family : 'butterworth';
    const response = FILTER_DESIGN_RESPONSES.has(params.response) ? params.response : 'lowpass';
    const order = normalizeFilterDesignOrder(params.order);
    const raw = Array.isArray(params.cutoff) ? params.cutoff : [params.cutoff];
    const cutoff = raw.map(Number).slice(0, 2);
    const wantsTwo = response === 'bandpass' || response === 'bandstop';
    while (cutoff.length < (wantsTwo ? 2 : 1)) cutoff.push(NaN);
    if (!wantsTwo) cutoff.length = 1;
    const sampleRate = Number(params.sampleRate);
    return {
        family,
        response,
        order,
        cutoff,
        rippleDb: clampDb(params.rippleDb, FILTER_DESIGN_DEFAULT_RIPPLE_DB, FILTER_DESIGN_MAX_RIPPLE_DB),
        attenuationDb: clampDb(params.attenuationDb, FILTER_DESIGN_DEFAULT_ATTENUATION_DB, FILTER_DESIGN_MAX_ATTENUATION_DB),
        sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : NaN,
    };
}

/**
 * Design the filter.
 *
 * @param {object} params see normalizeFilterDesign; `sampleRate` in the same
 *   unit the cut-offs are in (Hz when the cut-offs are Hz, 1 for cycles/sample).
 * @returns {{ sos: number[][], b: number[], a: number[], order: number,
 *   design: object, zeros, poles, gain }}
 * @throws {DataToolError} with a stable code the panel maps to a sentence:
 *   dataToolFilterDesignNoRate      no usable sample rate
 *   dataToolFilterDesignCutoffMissing  a cut-off is empty or not a number
 *   dataToolFilterDesignCutoffPositive a cut-off is ≤ 0
 *   dataToolFilterDesignCutoffNyquist  a cut-off is at or above fs/2
 *   dataToolFilterDesignBandOrder      band edges in the wrong order
 */
export function designFilter(params = {}) {
    const design = normalizeFilterDesign(params);
    const { family, response, order, cutoff, rippleDb, attenuationDb, sampleRate } = design;
    if (!(sampleRate > 0)) throw new DataToolError('dataToolFilterDesignNoRate');
    const nyquist = sampleRate / 2;
    for (const f of cutoff) {
        if (!Number.isFinite(f)) throw new DataToolError('dataToolFilterDesignCutoffMissing');
        if (!(f > 0)) throw new DataToolError('dataToolFilterDesignCutoffPositive');
        if (!(f < nyquist)) throw new DataToolError('dataToolFilterDesignCutoffNyquist');
    }
    if (cutoff.length === 2 && !(cutoff[0] < cutoff[1])) throw new DataToolError('dataToolFilterDesignBandOrder');

    // Work at fs = 2, as scipy does: normalised frequencies in (0, 1) with 1 at
    // Nyquist, pre-warped so the bilinear map lands the cut-off exactly.
    const fs = 2;
    const warped = cutoff.map(f => 2 * fs * Math.tan(Math.PI * (f / nyquist) / fs));

    const prototype = analogPrototype(family, order, { rippleDb, attenuationDb });
    let analog;
    if (response === 'lowpass') analog = lp2lp(prototype, warped[0]);
    else if (response === 'highpass') analog = lp2hp(prototype, warped[0]);
    else {
        const bw = warped[1] - warped[0];
        const wo = Math.sqrt(warped[0] * warped[1]);
        analog = response === 'bandpass' ? lp2bp(prototype, wo, bw) : lp2bs(prototype, wo, bw);
    }
    const digital = bilinear(analog, fs);
    const sos = zpkToSos(digital);
    const { b, a } = zpkToTransferFunction(digital);
    return {
        sos,
        b,
        a,
        order: digital.poles.length,
        design,
        zeros: digital.zeros,
        poles: digital.poles,
        gain: digital.gain,
    };
}

/** Magnitude in dB at a frequency given in the cut-offs' unit. */
export function designedMagnitudeDb(sos, frequency, sampleRate) {
    return sosMagnitudeDb(sos, 2 * Math.PI * frequency / sampleRate);
}
