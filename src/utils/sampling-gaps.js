// Sampling-gap and NaN-run detection over a time vector.
//
// Extracted from utils/fft.js: it started as a helper for the FFT time pane,
// but the FFT is now one of four consumers — the Missing/NaN overlay, the lazy
// DuckDB bucket reducer and the integral kernel all decide what counts as
// "missing" from here, and they must decide it the same way or the app
// contradicts itself. None of it computes a transform.
//
// Pure and unit-agnostic: `times` are raw values (ms for datetime series,
// x-units otherwise) and every returned dt/t0/t1 comes back in those same
// units, so callers can draw them or intersect them with a range directly.

// Default multiple of the median step above which an interval counts as a
// gap (missing samples). 1.5x flags a single dropped sample while staying
// clear of ordinary jitter.
export const GAP_THRESHOLD_FACTOR = 1.5;

// How far a step may sit from the median and still count as "the nominal step".
// Ordinary logger jitter is well inside 10%.
export const GAP_STEP_TOLERANCE = 0.1;
// Fraction of steps that must agree with the median before the series is
// considered to HAVE a nominal step at all. Below this, `medianDt` is just the
// middle of a spread of unrelated distances and no statement about missing
// samples can be justified — see the gate in detectSamplingGaps.
export const GAP_STEP_MIN_AGREEMENT = 0.8;
// Steps needed before the agreement statistic has any power. In a short series
// one legitimate gap is already a large fraction of the sample (with 4 steps it
// is 25%), so the gate would suppress the very gaps it exists to protect. Below
// this the median is used as before — the cost is that a genuinely irregular
// short series can still produce gap bands.
export const GAP_STEP_MIN_SAMPLES = 8;

// Locate gaps (runs of missing samples) in a time vector. Pure and unit-
// agnostic: `times` are the raw values (ms for datetime series, x-units
// otherwise), and every returned dt/t0/t1 is in those same units so callers
// can draw them or intersect them with a selection range directly. Used to
// highlight gaps in the FFT time pane; it does not itself relax the FFT
// uniformity gate.
//
// A gap only means something relative to a nominal step, so the detector first
// establishes that the series HAS one. Two conditions void it, and in both the
// honest answer is "no statement about missing samples" — `gaps` comes back
// empty with a `reason`, never populated with guesses a caller might draw:
//
//   nonMonotonic  — some step is negative, so the rows are not in chronological
//                   order. Every distance is then measured along a sequence
//                   that isn't the real one, and the forward jumps created by
//                   the disorder would be reported as gaps that don't exist.
//   irregularStep — fewer than `minStepAgreement` of the steps sit within
//                   `stepTolerance` of the median. Genuinely irregular sampling
//                   lands here: the median is the middle of a spread of
//                   unrelated distances, not a period, and comparing anything
//                   against it manufactures gaps. Only judged once there are
//                   GAP_STEP_MIN_SAMPLES steps to judge from.
//
// The gate must be robust to a MINORITY of large steps, because that is exactly
// what a real gap is — which is why it counts agreeing steps instead of reusing
// analyzeSampling's max-relative-error test. A uniform series with one dropped
// run has a huge max error but ~100% agreement, and must keep its gaps.
export function detectSamplingGaps(times, options = {}) {
    const factor = Number.isFinite(Number(options.thresholdFactor))
        ? Number(options.thresholdFactor)
        : GAP_THRESHOLD_FACTOR;
    const stepTolerance = Number.isFinite(Number(options.stepTolerance))
        ? Number(options.stepTolerance)
        : GAP_STEP_TOLERANCE;
    const minStepAgreement = Number.isFinite(Number(options.minStepAgreement))
        ? Number(options.minStepAgreement)
        : GAP_STEP_MIN_AGREEMENT;
    const values = times instanceof Float64Array ? times : Float64Array.from(times || [], Number);
    const n = values.length;
    const blank = (reason, extra = null) => ({
        medianDt: NaN,
        gaps: [],
        count: 0,
        totalMissing: 0,
        largest: null,
        hasNominalStep: false,
        stepAgreement: NaN,
        monotonic: true,
        reason,
        ...extra,
    });
    if (n < 3) return blank('tooFewSamples');

    // The positive steps, in a typed array: a plain array of millions of
    // doubles and a comparator sort were most of a second on a minute of
    // audio, and the median needs a selection, not an ordering.
    const steps = new Float64Array(n - 1);
    let count = 0;
    let monotonic = true;
    for (let i = 1; i < n; i++) {
        const d = values[i] - values[i - 1];
        if (!Number.isFinite(d)) continue;
        if (d < 0) monotonic = false;
        else if (d > 0) steps[count++] = d;
    }
    if (!monotonic) return blank('nonMonotonic', { monotonic: false });
    if (count < 2) return blank('tooFewSamples');
    const deltas = steps.subarray(0, count);
    const medianDt = medianInPlace(deltas);
    if (!Number.isFinite(medianDt) || medianDt <= 0) return blank('irregularStep', { medianDt });

    const band = medianDt * stepTolerance;
    let agreeing = 0;
    for (const d of deltas) {
        if (Math.abs(d - medianDt) <= band) agreeing++;
    }
    const stepAgreement = agreeing / deltas.length;
    if (deltas.length >= GAP_STEP_MIN_SAMPLES && stepAgreement < minStepAgreement) {
        return blank('irregularStep', { medianDt, stepAgreement });
    }

    const threshold = medianDt * factor;
    const gaps = [];
    let totalMissing = 0;
    let largest = null;
    for (let i = 1; i < n; i++) {
        const dt = values[i] - values[i - 1];
        if (!(dt > threshold)) continue;
        const missing = Math.max(1, Math.round(dt / medianDt) - 1);
        const gap = { index: i - 1, t0: values[i - 1], t1: values[i], dt, missing };
        gaps.push(gap);
        totalMissing += missing;
        if (!largest || dt > largest.dt) largest = gap;
    }
    return {
        medianDt,
        gaps,
        count: gaps.length,
        totalMissing,
        largest,
        hasNominalStep: true,
        stepAgreement,
        monotonic: true,
        reason: null,
    };
}

// The k-th smallest of `a` (0-based), reordering `a` as it goes: Hoare's
// partition around a median-of-three pivot, O(n) on average. Exported for the
// tests, which hold it to a sort.
export function selectKth(a, k) {
    let lo = 0;
    let hi = a.length - 1;
    while (hi > lo) {
        const mid = (lo + hi) >>> 1;
        if (a[mid] < a[lo]) { const t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
        if (a[hi] < a[lo]) { const t = a[hi]; a[hi] = a[lo]; a[lo] = t; }
        if (a[hi] < a[mid]) { const t = a[hi]; a[hi] = a[mid]; a[mid] = t; }
        const pivot = a[mid];
        let i = lo;
        let j = hi;
        while (i <= j) {
            while (a[i] < pivot) i++;
            while (a[j] > pivot) j--;
            if (i <= j) {
                const t = a[i]; a[i] = a[j]; a[j] = t;
                i++;
                j--;
            }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return a[k];
    }
    return a[lo];
}

// The median of `a`, reordering `a`. For an even count the upper middle is
// selected and the lower middle is then the largest of what sits below it.
export function medianInPlace(a) {
    const n = a.length;
    if (!n) return NaN;
    const mid = n >> 1;
    const upper = selectKth(a, mid);
    if (n % 2) return upper;
    let lower = -Infinity;
    for (let i = 0; i < mid; i++) if (a[i] > lower) lower = a[i];
    return (lower + upper) / 2;
}

// Runs of non-finite (NaN/Inf) values, returned as the time interval each
// hole spans — from the last good sample before the run to the first good
// sample after — so a band drawn over [t0, t1] covers the actual break in the
// line. `times`/`values` share an index; the interval is in `times` units.
export function detectNaNRuns(times, values) {
    const t = times instanceof Float64Array ? times : Float64Array.from(times || [], Number);
    const n = Math.min(t.length, values?.length || 0);
    const runs = [];
    let start = -1;
    for (let i = 0; i < n; i++) {
        const bad = !Number.isFinite(Number(values[i]));
        if (bad && start < 0) start = i;
        if (start >= 0 && (!bad || i === n - 1)) {
            const end = bad ? i : i - 1;
            const t0 = start > 0 ? t[start - 1] : t[start];
            const t1 = end < n - 1 ? t[end + 1] : t[end];
            if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
                runs.push({ t0, t1, count: end - start + 1 });
            }
            start = -1;
        }
    }
    return runs;
}

// ── The Gaps tool (docs/marks-menu-nan-gaps-design.md) ──
//
// The analysis kernels above keep the median + agreement gate: they must refuse
// to reason about missing rows on an irregular series. The Gaps overlay asks a
// different question — "where does this file have no rows, given this step?" —
// and lets the user set the step. Its automatic step is the MODE of the steps,
// not the median: the median is dragged towards the gaps as soon as they are a
// large minority, the mode is not. And there is no gate: a weak agreement is
// reported next to the step, never turned into "draw nothing".

/** Log-scale bins per e-fold of step length (≈ 2.5 % per bin). */
export const STEP_BINS_PER_EFOLD = 40;
/** Default threshold of the Gaps tool: a step above factor × Δt is a gap. */
export const GAP_DEFAULT_FACTOR = GAP_THRESHOLD_FACTOR;
// Bins either side of a bin that are within ±GAP_STEP_TOLERANCE of it.
const STEP_WINDOW_BINS = Math.ceil(Math.log1p(GAP_STEP_TOLERANCE) * STEP_BINS_PER_EFOLD);
// Window counts within this fraction of the best one tie; the smallest step
// wins a tie, because gaps are multiples of the step, never fractions of it.
const STEP_MODE_TIE = 0.05;

/** The histogram bin of one positive step. Shared with the DuckDB query. */
export function stepBinKey(step) {
    return Math.round(Math.log(step) * STEP_BINS_PER_EFOLD);
}

/**
 * Histogram of the positive steps of a time vector, in file order.
 * @returns {{ bins: Map<number, {count: number, sum: number}>, positive: number,
 *   negative: number }}
 */
export function stepHistogram(times) {
    const bins = new Map();
    let positive = 0;
    let negative = 0;
    const n = times?.length || 0;
    let prev = n ? Number(times[0]) : NaN;
    for (let i = 1; i < n; i++) {
        const t = Number(times[i]);
        const d = t - prev;
        prev = t;
        if (!Number.isFinite(d)) continue;
        if (d < 0) { negative++; continue; }
        if (d === 0) continue;
        positive++;
        const key = stepBinKey(d);
        const bin = bins.get(key);
        if (bin) { bin.count++; bin.sum += d; } else bins.set(key, { count: 1, sum: d });
    }
    return { bins, positive, negative };
}

/**
 * The nominal step from a step histogram: the most populated ±10 % window.
 * `bins` is a Map or an array of `{ key, count, sum }` (the DuckDB rows).
 * @returns {{ dt: number, agreement: number, positive: number }}
 *   `dt` NaN when there are no positive steps.
 */
export function nominalStepFromHistogram(bins, positive = null) {
    const list = [];
    const entries = bins instanceof Map
        ? [...bins].map(([key, bin]) => ({ key, count: bin.count, sum: bin.sum }))
        : (bins || []);
    for (const bin of entries) {
        const key = Number(bin.key);
        const count = Number(bin.count);
        const sum = Number(bin.sum);
        if (Number.isFinite(key) && count > 0 && Number.isFinite(sum)) list.push({ key, count, sum });
    }
    const total = Number.isFinite(Number(positive)) && Number(positive) > 0
        ? Number(positive)
        : list.reduce((s, b) => s + b.count, 0);
    if (!list.length || !(total > 0)) return { dt: NaN, agreement: NaN, positive: total || 0 };
    list.sort((a, b) => a.key - b.key);

    // Sliding window over the sorted keys: window[i] = steps within
    // ±STEP_WINDOW_BINS of bin i.
    const windows = new Array(list.length);
    let lo = 0;
    let hi = 0;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
        while (hi < list.length && list[hi].key <= list[i].key + STEP_WINDOW_BINS) count += list[hi++].count;
        while (list[lo].key < list[i].key - STEP_WINDOW_BINS) count -= list[lo++].count;
        windows[i] = { lo, hi, count };
    }
    let best = 0;
    for (let i = 1; i < list.length; i++) if (windows[i].count > windows[best].count) best = i;
    const floor = windows[best].count * (1 - STEP_MODE_TIE);
    for (let i = 0; i < best; i++) {
        if (windows[i].count >= floor) { best = i; break; }
    }
    const w = windows[best];
    let sum = 0;
    let n = 0;
    for (let i = w.lo; i < w.hi; i++) { sum += list[i].sum; n += list[i].count; }
    const dt = n ? sum / n : NaN;
    // Agreement against the step actually returned (its own ±10 % window).
    const center = stepBinKey(dt);
    let agreeing = 0;
    for (const bin of list) if (Math.abs(bin.key - center) <= STEP_WINDOW_BINS) agreeing += bin.count;
    return { dt, agreement: agreeing / total, positive: total };
}

/**
 * The automatic step of the Gaps tool for a time vector.
 * @returns {{ dt: number, agreement: number, positive: number, monotonic: boolean }}
 */
export function estimateNominalStep(times) {
    const { bins, positive, negative } = stepHistogram(times);
    const result = nominalStepFromHistogram(bins, positive);
    return { ...result, monotonic: negative === 0 };
}

/**
 * Gaps for a given step: every interval longer than factor × dt. Returns the
 * row index AFTER each gap (the gap spans times[i-1] → times[i]) in a typed
 * array, so a wrong manual step that makes every interval a gap costs one
 * Int32Array, not millions of objects.
 * @returns {{ ends: Int32Array, count: number, totalMissing: number,
 *   monotonic: boolean, dt: number, threshold: number }}
 */
export function detectGapIndices(times, dt, factor = GAP_DEFAULT_FACTOR) {
    const n = times?.length || 0;
    const step = Number(dt);
    const f = Number(factor) > 0 ? Number(factor) : GAP_DEFAULT_FACTOR;
    const threshold = step * f;
    const none = { ends: new Int32Array(0), count: 0, totalMissing: 0, monotonic: true, dt: step, threshold };
    if (n < 2 || !(step > 0) || !Number.isFinite(threshold)) return none;
    let ends = new Int32Array(64);
    let count = 0;
    let totalMissing = 0;
    let prev = Number(times[0]);
    for (let i = 1; i < n; i++) {
        const t = Number(times[i]);
        const d = t - prev;
        prev = t;
        if (d < 0) return { ...none, monotonic: false };
        if (!(d > threshold)) continue;
        if (count === ends.length) {
            const grown = new Int32Array(ends.length * 2);
            grown.set(ends);
            ends = grown;
        }
        ends[count++] = i;
        totalMissing += Math.max(1, Math.round(d / step) - 1);
    }
    return { ends: ends.subarray(0, count), count, totalMissing, monotonic: true, dt: step, threshold };
}

/**
 * Runs of non-finite values, as row indices (inclusive), in typed arrays.
 * The line breaks and the NaN/Inf strip read these; detectNaNRuns (above)
 * stays for the FFT pane, which wants time intervals.
 * @returns {{ starts: Int32Array, ends: Int32Array, count: number, nonFinite: number }}
 */
export function nanRunIndices(values) {
    const n = values?.length || 0;
    let starts = new Int32Array(16);
    let ends = new Int32Array(16);
    let count = 0;
    let nonFinite = 0;
    let start = -1;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        const bad = typeof v === 'number' ? !Number.isFinite(v) : !Number.isFinite(Number(v));
        if (bad) {
            nonFinite++;
            if (start < 0) start = i;
            continue;
        }
        if (start >= 0) {
            if (count === starts.length) {
                const s = new Int32Array(count * 2); s.set(starts); starts = s;
                const e = new Int32Array(count * 2); e.set(ends); ends = e;
            }
            starts[count] = start;
            ends[count] = i - 1;
            count++;
            start = -1;
        }
    }
    if (start >= 0) {
        if (count === starts.length) {
            const s = new Int32Array(count + 1); s.set(starts); starts = s;
            const e = new Int32Array(count + 1); e.set(ends); ends = e;
        }
        starts[count] = start;
        ends[count] = n - 1;
        count++;
    }
    return { starts: starts.subarray(0, count), ends: ends.subarray(0, count), count, nonFinite };
}
