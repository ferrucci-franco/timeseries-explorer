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

    const deltas = [];
    let monotonic = true;
    for (let i = 1; i < n; i++) {
        const d = values[i] - values[i - 1];
        if (!Number.isFinite(d)) continue;
        if (d < 0) monotonic = false;
        else if (d > 0) deltas.push(d);
    }
    if (!monotonic) return blank('nonMonotonic', { monotonic: false });
    if (deltas.length < 2) return blank('tooFewSamples');
    deltas.sort((a, b) => a - b);
    const mid = deltas.length >> 1;
    const medianDt = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
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
