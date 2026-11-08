import {
    asFloat64,
    CUMULATIVE_INTEGRAL_METHODS,
    INTEGRAL_GAP_POLICIES,
    normalizeTimeContext,
    timeDelta,
} from './shared.js';
import { detectSamplingGaps, GAP_THRESHOLD_FACTOR } from '../../utils/sampling-gaps.js';

// Linearly bridge runs of non-finite values so the integral can cross them.
// Interpolation is in TIME, not index, so an irregular axis is handled right.
// A run with no finite sample on one side (leading or trailing NaN) cannot be
// bridged and stays non-finite; the caller then treats it as a hole.
export function bridgeNonFinite(values, ctx) {
    const n = values.length;
    const out = new Float64Array(n);
    out.set(values);
    const at = (i) => (ctx.values && ctx.kind !== 'index' ? ctx.values[i] : i);
    let i = 0;
    while (i < n) {
        if (Number.isFinite(out[i])) { i++; continue; }
        const start = i;
        let end = start;
        while (end < n && !Number.isFinite(out[end])) end++;
        if (start > 0 && end < n) {
            const y0 = out[start - 1];
            const y1 = out[end];
            const t0 = at(start - 1);
            const t1 = at(end);
            if (Number.isFinite(y0) && Number.isFinite(y1) && Number.isFinite(t0) && Number.isFinite(t1)) {
                const span = t1 - t0;
                for (let k = start; k < end; k++) {
                    const tk = at(k);
                    const frac = span && Number.isFinite(tk) ? (tk - t0) / span : 0;
                    out[k] = y0 + frac * (y1 - y0);
                }
            }
        }
        i = end;
    }
    return out;
}

// Cumulative integral. Same accumulation order as the original
// `_computeIntegralValues` — the running sum is float-order-sensitive, so the
// loop must stay strictly sequential for results to match bit-for-bit.
//
// Two kinds of hole reach this function, and until the gap policy existed they
// were treated DIFFERENTLY for no defensible reason: an absent row was silently
// bridged by the trapezoid (linear interpolation nobody asked for), while an
// empty cell dropped its whole segment. The same physical hole produced -54%
// one way and -93% the other. Both now follow `params.gapPolicy`, so the two
// spellings of "no data here" give the same number.
//
// params:
//   method     'trapezoidal' | 'rectangular' | 'sum' (running sum, no ×Δt)
//   gapPolicy  see INTEGRAL_GAP_POLICIES; defaults to 'zero'
//   detectGaps set false to skip missing-row detection entirely. Then a gap is
//              just a long dt and the quadrature runs straight across it, which
//              — together with gapPolicy 'zero' — is exactly the pre-policy
//              behaviour that bench/legacy-data-tools.mjs pins bit-for-bit.
//
// Missing rows are only detected where the time axis HAS a nominal step:
// detectSamplingGaps returns no gaps for a genuinely irregular series, because
// there a long dt is real sampling, not a hole. That is the same rule the
// FFT pane's missing-data bands follow. (The time-series Gaps tool is
// different on purpose: the user sees and sets its step, and it marks
// dropouts whatever the agreement — docs/marks-menu-nan-gaps-design.md.)
//
// One call of the chunked form below over the whole series (windowed.js): a
// file too large to hold is fed to the same code a chunk at a time by the
// chunked executor and gets the same doubles. The nominal step is measured
// here over the whole axis; the lazy path measures it over the whole file.
export function computeIntegral(sourceValues, time, params = {}) {
    const values = asFloat64(sourceValues);
    const n = values.length;
    const ctx = normalizeTimeContext(time);
    const method = CUMULATIVE_INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    let hasNominalStep = false;
    let gapThreshold = null;
    // An index axis carries no timestamps, so every step is 1 by construction
    // and a missing row is undetectable — not absent, undetectable. Skipping the
    // scan there states that honestly instead of reporting zero gaps found.
    if (n && method !== 'sum' && params.detectGaps !== false && ctx.values && ctx.kind !== 'index') {
        const info = detectSamplingGaps(ctx.values);
        hasNominalStep = info.hasNominalStep;
        if (info.hasNominalStep) gapThreshold = info.medianDt * GAP_THRESHOLD_FACTOR;
    }
    const integral = createCumulativeIntegral(params, { kind: ctx.kind, gapThreshold, hasNominalStep });
    if (!n) return { values: new Float64Array(0), ...integral.report() };
    const { values: out } = integral.compute({
        values, times: ctx.values, start: 0, coreStart: 0, coreEnd: n,
        fileStart: true, eof: true, truncatedStart: false, truncatedEnd: false,
    });
    return { values: out, ...integral.report() };
}

/**
 * The cumulative integral as the compute of a lookahead kernel (windowed.js):
 * the accumulator is its state, carried from one call to the next, and the
 * only look ahead it makes is under the 'interpolate' policy, where a run of
 * non-finite samples is bridged linearly in time towards the finite sample
 * that ends it (bridgeNonFinite) — so it waits for that sample. A run the cap
 * cut is left unbridged, like one at the start or the end of the series: it
 * adds nothing.
 *
 *   createCumulativeIntegral(params, { kind, gapThreshold, hasNominalStep })
 *
 * `kind` is the time axis's ('numeric' | 'datetime' | 'index');
 * `gapThreshold` the step above which an interval is a missing row, in the
 * axis's own units (medianDt × GAP_THRESHOLD_FACTOR), or null when the axis
 * has no nominal step; `hasNominalStep` is what the report says about it. The
 * times of the view are read when `kind` is not 'index' and they are given;
 * otherwise every step is one row.
 */
export function createCumulativeIntegral(params = {}, { kind = 'numeric', gapThreshold = null, hasNominalStep = false } = {}) {
    const method = CUMULATIVE_INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    const policy = INTEGRAL_GAP_POLICIES.has(params.gapPolicy) ? params.gapPolicy : 'zero';
    // The constant of integration. Zero keeps the historical result, so leaving
    // it alone changes nothing; a level, an energy or a position needs the value
    // the accumulation starts from.
    const initial = Number.isFinite(Number(params.initial)) ? Number(params.initial) : 0;
    const sum = method === 'sum';
    const rectangular = method === 'rectangular';
    const bridge = policy === 'interpolate';
    const threshold = Number.isFinite(gapThreshold) ? gapThreshold : null;

    let acc = initial;
    let rows = 0;            // rows done
    // The previous row: its source value, its bridged value, its time.
    let prevSource = NaN;
    let prevWork = NaN;
    let prevTime = NaN;
    // The last finite sample, for the bridge: its value and its coordinate.
    let lastFinite = NaN;
    let lastFiniteAt = NaN;
    let negativeDtCount = 0;
    let gapCount = 0;
    let nanSegmentCount = 0;
    let uncoveredTime = 0;

    function compute(view) {
        const { values, times, start, coreStart, coreEnd, eof, truncatedEnd } = view;
        const n = values.length;
        const timed = kind !== 'index' && !!times;
        // The coordinate of a row: its time, or its position in the series.
        const at = timed ? (i => times[i]) : (i => start + i);
        const out = new Float64Array(coreEnd - coreStart);
        let settledEnd = coreEnd;
        // The bridged values of the hole being crossed, by index in the view.
        let bridgedFrom = -1;
        let bridged = null;

        for (let i = coreStart; i < coreEnd; i++) {
            const source = values[i];
            let work = source;
            if (bridge && !Number.isFinite(source)) {
                if (i >= bridgedFrom + (bridged?.length || 0)) {
                    // A new run: find the finite sample that ends it.
                    let end = i;
                    while (end < n && !Number.isFinite(values[end])) end++;
                    if (end >= n && !eof && !truncatedEnd) { settledEnd = i; break; }
                    bridgedFrom = i;
                    bridged = new Float64Array(end - i).fill(NaN);
                    // A run that begins where the view begins, after a row
                    // that was not finite either, is the rest of a run the cap
                    // cut: it stays unbridged, whole.
                    const continued = i === coreStart && rows > 0 && !Number.isFinite(prevSource);
                    if (end < n && !continued && Number.isFinite(lastFinite)) {
                        const y0 = lastFinite;
                        const y1 = values[end];
                        const t0 = lastFiniteAt;
                        const t1 = at(end);
                        if (Number.isFinite(t0) && Number.isFinite(t1)) {
                            const span = t1 - t0;
                            for (let k = i; k < end; k++) {
                                const tk = at(k);
                                const frac = span && Number.isFinite(tk) ? (tk - t0) / span : 0;
                                bridged[k - i] = y0 + frac * (y1 - y0);
                            }
                        }
                    }
                }
                work = bridged[i - bridgedFrom];
            }

            if (sum) {
                if (!Number.isFinite(source)) {
                    nanSegmentCount++;
                    uncoveredTime++;
                }
                if (Number.isFinite(work)) acc += work;
                else if (policy === 'propagate') acc = NaN;
                out[i - coreStart] = acc;
            } else if (rows === 0) {
                acc = initial;
                out[i - coreStart] = initial;
            } else {
                const t = timed ? times[i] : NaN;
                let dt;
                if (!timed) dt = 1;
                else if (!Number.isFinite(prevTime) || !Number.isFinite(t)) dt = NaN;
                else dt = kind === 'datetime' ? (t - prevTime) / 1000 : t - prevTime;
                if (Number.isFinite(dt)) {
                    if (dt < 0) negativeDtCount++;
                    // Holes are counted against the SOURCE, before any policy
                    // touches them: how much of the span the file has no data
                    // for is a property of the file, not of what was decided
                    // about it.
                    const sourceUsable = rectangular
                        ? Number.isFinite(prevSource)
                        : (Number.isFinite(prevSource) && Number.isFinite(source));
                    const missingRow = threshold !== null && timed && (t - prevTime) > threshold;
                    if (missingRow) gapCount++;
                    if (!sourceUsable) nanSegmentCount++;
                    if (missingRow || !sourceUsable) uncoveredTime += dt;

                    const usable = rectangular
                        ? Number.isFinite(prevWork)
                        : (Number.isFinite(prevWork) && Number.isFinite(work));
                    // Under 'interpolate' a missing row is not a hole to skip:
                    // letting the quadrature run straight across it IS the
                    // linear bridge the policy promises.
                    if (!usable || (missingRow && policy !== 'interpolate')) {
                        // 'zero' adds nothing. 'interpolate' only lands here
                        // when the run could not be bridged. Once acc is NaN
                        // every later `acc +=` keeps it NaN: the propagation.
                        if (policy === 'propagate') acc = NaN;
                    } else if (rectangular) {
                        acc += prevWork * dt;
                    } else {
                        acc += 0.5 * (prevWork + work) * dt;
                    }
                }
                out[i - coreStart] = acc;
            }

            if (Number.isFinite(source)) { lastFinite = source; lastFiniteAt = at(i); }
            prevSource = source;
            prevWork = work;
            prevTime = timed ? times[i] : NaN;
            rows++;
        }
        return { values: out.subarray(0, settledEnd - coreStart).slice(), settled: settledEnd - coreStart, keepFrom: settledEnd };
    }

    // `timeKind` travels with `uncoveredTime` because it is what gives that
    // number a unit: seconds on a datetime axis, x-units on a numeric one, and
    // a plain sample count on an index axis — which the running sum reports
    // whatever the axis, since it counts missing samples.
    const report = () => ({
        negativeDtCount,
        gapCount,
        nanSegmentCount,
        uncoveredTime,
        hasNominalStep: sum ? false : hasNominalStep,
        timeKind: sum ? 'index' : kind,
    });
    // The accumulator and the counts (see createMovingAverage on save/load).
    const save = () => ({
        acc, rows, prevSource, prevWork, prevTime, lastFinite, lastFiniteAt,
        negativeDtCount, gapCount, nanSegmentCount, uncoveredTime,
    });
    const load = (s) => {
        ({
            acc, rows, prevSource, prevWork, prevTime, lastFinite, lastFiniteAt,
            negativeDtCount, gapCount, nanSegmentCount, uncoveredTime,
        } = s);
    };
    return { compute, report, save, load };
}
