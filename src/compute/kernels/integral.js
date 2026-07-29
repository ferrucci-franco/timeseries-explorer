import {
    asFloat64,
    INTEGRAL_GAP_POLICIES,
    INTEGRAL_METHODS,
    normalizeTimeContext,
    timeDelta,
} from './shared.js';
import { detectSamplingGaps } from '../../utils/sampling-gaps.js';

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
//   method     'trapezoidal' | 'rectangular'
//   gapPolicy  see INTEGRAL_GAP_POLICIES; defaults to 'zero'
//   detectGaps set false to skip missing-row detection entirely. Then a gap is
//              just a long dt and the quadrature runs straight across it, which
//              — together with gapPolicy 'zero' — is exactly the pre-policy
//              behaviour that bench/legacy-data-tools.mjs pins bit-for-bit.
//
// Missing rows are only detected where the time axis HAS a nominal step:
// detectSamplingGaps returns no gaps for a genuinely irregular series, because
// there a long dt is real sampling, not a hole. That is the same rule the
// Missing/NaN overlay follows, so the two features never disagree about what
// counts as missing.
export function computeIntegral(sourceValues, time, params = {}) {
    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = new Float64Array(n);
    const empty = {
        values: out,
        negativeDtCount: 0,
        gapCount: 0,
        nanSegmentCount: 0,
        uncoveredTime: 0,
        hasNominalStep: false,
    };
    if (!n) return empty;

    const ctx = normalizeTimeContext(time);
    const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    const policy = INTEGRAL_GAP_POLICIES.has(params.gapPolicy) ? params.gapPolicy : 'zero';
    const rectangular = method === 'rectangular';

    // An index axis carries no timestamps, so every step is 1 by construction
    // and a missing row is undetectable — not absent, undetectable. Skipping the
    // scan there states that honestly instead of reporting zero gaps found.
    let hasNominalStep = false;
    let gapEndIndexes = null;
    if (params.detectGaps !== false && ctx.values && ctx.kind !== 'index') {
        const info = detectSamplingGaps(ctx.values);
        hasNominalStep = info.hasNominalStep;
        if (info.gaps.length) gapEndIndexes = new Set(info.gaps.map(g => g.index + 1));
    }

    const work = policy === 'interpolate' ? bridgeNonFinite(values, ctx) : values;

    // The constant of integration. Zero keeps the historical result, so leaving
    // it alone changes nothing; a level, an energy or a position needs the value
    // the accumulation starts from.
    const initial = Number.isFinite(Number(params.initial)) ? Number(params.initial) : 0;
    let acc = initial;
    out[0] = initial;
    let negativeDtCount = 0;
    let gapCount = 0;
    let nanSegmentCount = 0;
    let uncoveredTime = 0;

    for (let i = 1; i < n; i++) {
        const dt = timeDelta(ctx, i - 1, i);
        if (Number.isFinite(dt)) {
            if (dt < 0) negativeDtCount++;
            // Holes are counted against the SOURCE, before any policy touches
            // them: how much of the span the file has no data for is a property
            // of the file, not of what was decided about it. Reading `work`
            // here instead would report zero under 'interpolate', where the
            // bridge has already filled the hole in.
            const s0 = values[i - 1];
            const s1 = values[i];
            // Kept per-method: the rectangular rule only ever read y0, and that
            // asymmetry is part of the behaviour the differential test pins.
            const sourceUsable = rectangular
                ? Number.isFinite(s0)
                : (Number.isFinite(s0) && Number.isFinite(s1));
            const missingRow = gapEndIndexes !== null && gapEndIndexes.has(i);
            if (missingRow) gapCount++;
            if (!sourceUsable) nanSegmentCount++;
            if (missingRow || !sourceUsable) uncoveredTime += dt;

            const y0 = work[i - 1];
            const y1 = work[i];
            const usable = rectangular
                ? Number.isFinite(y0)
                : (Number.isFinite(y0) && Number.isFinite(y1));
            // Under 'interpolate' a missing row is not a hole to skip: letting
            // the quadrature run straight across it IS the linear bridge the
            // policy promises, and it is what makes an absent row agree with an
            // empty cell (which bridgeNonFinite already filled above).
            if (!usable || (missingRow && policy !== 'interpolate')) {
                // 'zero' adds nothing. 'interpolate' only lands here when the
                // run could not be bridged (a leading or trailing NaN, with no
                // finite sample on one side to interpolate towards), and adding
                // nothing is the only option left. Once acc is NaN every later
                // `acc +=` keeps it NaN, which is the propagation.
                if (policy === 'propagate') acc = NaN;
            } else if (rectangular) {
                acc += y0 * dt;
            } else {
                acc += 0.5 * (y0 + y1) * dt;
            }
        }
        out[i] = acc;
    }
    // `timeKind` travels with `uncoveredTime` because it is what gives that
    // number a unit: seconds on a datetime axis, x-units on a numeric one, and
    // a plain sample count on an index axis. Formatting it as a duration
    // without checking would invent hours out of row numbers.
    return {
        values: out,
        negativeDtCount,
        gapCount,
        nanSegmentCount,
        uncoveredTime,
        hasNominalStep,
        timeKind: ctx.kind,
    };
}
