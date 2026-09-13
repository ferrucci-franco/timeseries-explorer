// Cross-correlation of two series as a function of lag.
//
//     r_xy[k] = Σ_n x[n + k] · y[n],      k = −L … L
//
// which is MATLAB's `xcorr(x, y)` and scipy's `correlate(x, y)`: a peak at a
// POSITIVE lag k means x[n + k] lines up with y[n], i.e. x runs BEHIND y by k
// samples (x is the delayed one). With y = x the result is the autocorrelation,
// even in k and largest at k = 0. Same convention throughout, and the panel's
// help says it in as many words, because the sign is the one thing every user
// of a cross-correlation gets wrong once.
//
// ── Normalisation ─────────────────────────────────────────────────────────
//
// The four of `xcorr`, by the same names:
//
//   none      the raw sum above;
//   biased    ÷ N, the length of the series — a consistent estimate of the
//             correlation function whose bias shrinks the far lags;
//   unbiased  ÷ (N − |k|), the number of pairs that actually overlap at that
//             lag — unbiased, but noisy at the far lags where few pairs remain;
//   coeff     ÷ √(r_xx[0] · r_yy[0]), so the autocorrelation is 1 at lag 0 and
//             every value sits in [−1, 1]. With the means removed first this is
//             the Pearson coefficient of the two series at each lag — which is
//             why "remove the mean" defaults on.
//
// ── Missing values ────────────────────────────────────────────────────────
//
// A NaN anywhere would poison every lag. Instead each product is counted only
// when BOTH samples are finite: the sum runs over the pairs that exist, and
// `unbiased` divides by that count rather than by N − |k| (with no holes the
// two are the same number). `biased` keeps N — that is what makes it biased —
// and `coeff` normalises with the lag-0 sums over the finite samples.
//
// ── How it is computed ────────────────────────────────────────────────────
//
// Directly, O(N·L), when that is cheap; by FFT, O(M log M), when it is not.
// The FFT route handles holes with the same arithmetic: the series are zero-
// filled where missing, and the pair counts come out of the FFT of the two
// masks — the cross-correlation of two indicator functions IS the number of
// overlapping finite pairs at each lag. Both routes give the same numbers to
// rounding, and the tests hold them to it.
//
// Pure: no DOM, no i18n, no app state, so it runs in the compute worker.

import { DataToolError, asFloat64 } from './shared.js';
import { fftRadix2, nextPowerOfTwo } from '../../utils/fft.js';

export const XCORR_NORMALIZATIONS = new Set(['none', 'biased', 'unbiased', 'coeff']);
export const XCORR_DEFAULT_NORMALIZATION = 'coeff';
// Past this many multiply-adds the direct route is slower than two FFTs.
export const XCORR_DIRECT_LIMIT = 4_000_000;
// A lag axis longer than this is not something anyone looks at, and the
// dataset it makes would dwarf its source.
export const XCORR_MAX_LAGS = 5_000_000;

/**
 * Parameters as the kernel wants them. `maxLag` is in SAMPLES here; the panel
 * converts from the axis unit before calling.
 */
export function normalizeXcorrParams(params = {}, length = Infinity) {
    const normalization = XCORR_NORMALIZATIONS.has(params.normalization)
        ? params.normalization
        : XCORR_DEFAULT_NORMALIZATION;
    const longest = Number.isFinite(length) ? Math.max(0, Math.floor(length) - 1) : Infinity;
    let maxLag = Math.floor(Number(params.maxLag));
    if (!Number.isFinite(maxLag) || maxLag < 0) maxLag = longest;
    maxLag = Math.min(maxLag, longest, XCORR_MAX_LAGS);
    return {
        maxLag,
        normalization,
        removeMean: params.removeMean !== false,
    };
}

function finiteMean(values) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) { sum += v; count++; }
    }
    return count ? sum / count : 0;
}

// The series with NaN → 0 and its mask, mean removed where asked. Everything
// downstream works on these two arrays, on both routes.
function prepare(values, removeMean) {
    const source = asFloat64(values);
    const n = source.length;
    const clean = new Float64Array(n);
    const mask = new Float64Array(n);
    const mean = removeMean ? finiteMean(source) : 0;
    let finite = 0;
    for (let i = 0; i < n; i++) {
        const v = source[i];
        if (Number.isFinite(v)) {
            clean[i] = v - mean;
            mask[i] = 1;
            finite++;
        }
    }
    return { clean, mask, finite, mean };
}

function correlateDirect(x, y, xMask, yMask, maxLag) {
    const n = x.length;
    const lags = 2 * maxLag + 1;
    const sums = new Float64Array(lags);
    const counts = new Float64Array(lags);
    for (let k = -maxLag; k <= maxLag; k++) {
        // r[k] = Σ_n x[n + k] y[n]; n runs where both indices are inside.
        const start = Math.max(0, -k);
        const end = Math.min(n, n - k);
        let sum = 0;
        let count = 0;
        for (let m = start; m < end; m++) {
            const i = m + k;
            if (xMask[i] && yMask[m]) { sum += x[i] * y[m]; count++; }
        }
        sums[k + maxLag] = sum;
        counts[k + maxLag] = count;
    }
    return { sums, counts };
}

// Circular correlation by FFT on a buffer long enough that nothing wraps:
// c[k] = Σ_n a[n + k] b[n] for k in [−maxLag, maxLag] is read off
// IFFT(A · conj(B)) at index k (mod M).
function circularCorrelation(a, b, size) {
    const ar = new Float64Array(size);
    const br = new Float64Array(size);
    ar.set(a);
    br.set(b);
    const A = fftRadix2(ar);
    const B = fftRadix2(br);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
        // A · conj(B)
        re[i] = A.real[i] * B.real[i] + A.imag[i] * B.imag[i];
        im[i] = A.imag[i] * B.real[i] - A.real[i] * B.imag[i];
    }
    // Inverse transform through the forward one: ifft(z) = conj(fft(conj(z))) / M.
    for (let i = 0; i < size; i++) im[i] = -im[i];
    const out = fftRadix2(re, im);
    const result = new Float64Array(size);
    for (let i = 0; i < size; i++) result[i] = out.real[i] / size;
    return result;
}

function correlateFft(x, y, xMask, yMask, maxLag) {
    const n = x.length;
    const size = nextPowerOfTwo(n + maxLag + 1);
    const values = circularCorrelation(x, y, size);
    const overlap = circularCorrelation(xMask, yMask, size);
    const lags = 2 * maxLag + 1;
    const sums = new Float64Array(lags);
    const counts = new Float64Array(lags);
    for (let k = -maxLag; k <= maxLag; k++) {
        const index = k >= 0 ? k : size + k;
        sums[k + maxLag] = values[index];
        // The mask correlation is an integer in exact arithmetic; rounding it
        // keeps the pair count honest after two FFTs.
        counts[k + maxLag] = Math.round(overlap[index]);
    }
    return { sums, counts };
}

/**
 * Cross-correlate two series of equal length.
 *
 * @param {ArrayLike<number>} xValues
 * @param {ArrayLike<number>} yValues
 * @param {{ maxLag?: number, normalization?: string, removeMean?: boolean }} params
 * @returns {{
 *   lags: Float64Array, values: Float64Array, counts: Float64Array,
 *   peakLag: number, peakValue: number, zeroLagValue: number,
 *   length: number, maxLag: number, normalization: string, removeMean: boolean,
 *   finitePairs: number, route: 'direct'|'fft',
 * }}
 * @throws {DataToolError} dataToolXcorrLengthMismatch, dataToolXcorrTooShort, dataToolXcorrNoOverlap
 */
export function computeCrossCorrelation(xValues, yValues, params = {}) {
    const x = asFloat64(xValues);
    const y = asFloat64(yValues);
    if (x.length !== y.length) throw new DataToolError('dataToolXcorrLengthMismatch');
    const n = x.length;
    if (n < 2) throw new DataToolError('dataToolXcorrTooShort');
    const options = normalizeXcorrParams(params, n);
    const { maxLag, normalization, removeMean } = options;

    const px = prepare(x, removeMean);
    const py = prepare(y, removeMean);
    if (!px.finite || !py.finite) throw new DataToolError('dataToolXcorrNoOverlap');

    const direct = n * (2 * maxLag + 1) <= XCORR_DIRECT_LIMIT;
    const { sums, counts } = direct
        ? correlateDirect(px.clean, py.clean, px.mask, py.mask, maxLag)
        : correlateFft(px.clean, py.clean, px.mask, py.mask, maxLag);

    const lagCount = 2 * maxLag + 1;
    const lags = new Float64Array(lagCount);
    const values = new Float64Array(lagCount);
    for (let i = 0; i < lagCount; i++) lags[i] = i - maxLag;

    // Lag-0 energies for `coeff`, over the finite samples of each series.
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < n; i++) {
        if (px.mask[i]) xx += px.clean[i] * px.clean[i];
        if (py.mask[i]) yy += py.clean[i] * py.clean[i];
    }
    const coeffScale = Math.sqrt(xx * yy);

    let finitePairs = 0;
    for (let i = 0; i < lagCount; i++) {
        const count = counts[i];
        const sum = sums[i];
        if (!count) { values[i] = NaN; continue; }
        finitePairs += count;
        if (normalization === 'biased') values[i] = sum / n;
        else if (normalization === 'unbiased') values[i] = sum / count;
        else if (normalization === 'coeff') values[i] = coeffScale > 0 ? sum / coeffScale : NaN;
        else values[i] = sum;
    }
    if (!finitePairs) throw new DataToolError('dataToolXcorrNoOverlap');

    // The peak: the lag of largest |r|, which is the delay estimate a user reads
    // off the curve. Ties go to the lag nearest zero.
    let peakIndex = -1;
    let peakAbs = -1;
    for (let i = 0; i < lagCount; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        const magnitude = Math.abs(v);
        if (magnitude > peakAbs || (magnitude === peakAbs && Math.abs(lags[i]) < Math.abs(lags[peakIndex]))) {
            peakAbs = magnitude;
            peakIndex = i;
        }
    }

    return {
        lags,
        values,
        counts,
        peakLag: peakIndex >= 0 ? lags[peakIndex] : NaN,
        peakValue: peakIndex >= 0 ? values[peakIndex] : NaN,
        zeroLagValue: values[maxLag],
        length: n,
        maxLag,
        normalization,
        removeMean,
        finitePairs,
        route: direct ? 'direct' : 'fft',
    };
}

/**
 * The worker-facing entry: plain arrays in, transferable arrays out.
 * @param {{ x: ArrayLike<number>, y: ArrayLike<number>, params: object }} input
 */
export function runCrossCorrelation({ x, y, params } = {}) {
    return computeCrossCorrelation(x || [], y || [], params || {});
}
