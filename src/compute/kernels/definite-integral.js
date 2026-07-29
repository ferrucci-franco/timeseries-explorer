// Definite integral of a signal over a time range — one scalar per series.
//
// Distinct from `computeIntegral` (integral.js), which returns the CUMULATIVE
// curve for Data Tools. This one answers "how much in total", which is the
// question the Integral analysis mode asks: a power in MW over a range gives an
// energy, and the bar chart compares those energies across signals.
//
// Pure: no DOM, no i18n, no `this`. Reasons come back as stable codes; the UI
// layer maps them to translated text.
//
// Three things separate it from "take the last value of the cumulative curve":
//
//   1. The range boundaries are HONOURED EXACTLY. An interval straddling
//      t_start or t_end is clipped and its endpoint value interpolated, so the
//      total varies continuously as the selection band is dragged instead of
//      jumping every time the edge crosses a sample. Same treatment the lazy
//      heatmap already gives its cell boundaries (duckdb-source.js).
//   2. Whole UTC days can be removed from the domain of integration (the
//      discard-day policies), which needs interval-level clipping at midnight.
//   3. It reports how much of the range it actually covered. With any policy
//      other than `interpolate` a hole contributes nothing, so the number is a
//      lower bound — and a bar chart that hides that fact is worse than no bar
//      chart. `coveredTime` / `uncoveredTime` are what the panel warns from.
//
// The hole vocabulary (a run of non-finite values, or a stretch of time with no
// rows at all) and the nominal-step gate that decides whether missing rows can
// be claimed at all are shared with the cumulative kernel through
// detectSamplingGaps, so the two features never disagree about what is missing.

import { asFloat64, INTEGRAL_METHODS, normalizeTimeContext } from './shared.js';
import { detectSamplingGaps } from '../../utils/sampling-gaps.js';
import { bridgeNonFinite } from './integral.js';

export const MS_PER_DAY = 86400000;

// What the definite integral does with a hole. The first two are the
// sample-level policies of the cumulative kernel under the names this analysis
// uses; the last two are day-level and only mean anything on a calendar axis.
//
//   zero              the hole contributed nothing — the result is a lower bound
//   interpolate       the signal varied linearly across the hole
//   discard-day-own   any day holding a hole leaves the domain, for this signal
//   discard-day-all   ... and for every signal in the panel, so the totals stay
//                     comparable (same integrated duration for all of them)
//
// `propagate` (NaN from the hole on) is deliberately absent: for a single total
// it degenerates to "no bar", which the empty-result path already expresses.
export const INTEGRAL_MISSING_POLICIES = new Set([
    'zero',
    'interpolate',
    'discard-day-own',
    'discard-day-all',
]);

export function utcDayIndex(ms) {
    return Math.floor(ms / MS_PER_DAY);
}

// Last day an interval [a, b) touches. An interval ending exactly at midnight
// stops at the previous day; without this every hole would soil the day after
// it as well.
function lastDayIndex(endMs) {
    const day = utcDayIndex(endMs);
    return endMs % MS_PER_DAY === 0 ? day - 1 : day;
}

export function utcDayStart(dayIndex) {
    return dayIndex * MS_PER_DAY;
}

// Cut [a, b] at every UTC midnight it crosses. Only called when day exclusion
// is actually in play — splitting otherwise would change the float summation
// order for no reason.
function splitAtDayBoundaries(a, b) {
    const pieces = [];
    let cursor = a;
    // A range of a few centuries is already absurd for a plot; the cap only
    // exists so a corrupt timestamp cannot spin here.
    for (let guard = 0; cursor < b && guard < 200000; guard++) {
        const nextMidnight = (Math.floor(cursor / MS_PER_DAY) + 1) * MS_PER_DAY;
        const end = Math.min(nextMidnight, b);
        pieces.push([cursor, end]);
        cursor = end;
    }
    if (cursor < b) pieces.push([cursor, b]);
    return pieces;
}

// Shared reading of the inputs. `times` is null for an index axis, where the
// abscissa is the row number and nothing calendar-shaped can be asserted.
function readContext(sourceValues, time, params) {
    const values = asFloat64(sourceValues);
    const ctx = normalizeTimeContext(time);
    const useTimes = !!(ctx.values && ctx.kind !== 'index');
    const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    return {
        values,
        ctx,
        useTimes,
        at: useTimes ? (i => ctx.values[i]) : (i => i),
        isDatetime: ctx.kind === 'datetime',
        rectangular: method === 'rectangular',
        method,
    };
}

// `null` means "no bound given, use the data extent" — and it has to be tested
// for explicitly, because Number(null) is 0, a perfectly finite number that
// would silently collapse the whole range to [0, 0].
function boundOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function resolveRange(at, n, params) {
    let start = boundOrNull(params.rangeStart);
    let end = boundOrNull(params.rangeEnd);
    if (start === null) start = at(0);
    if (end === null) end = at(n - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return start <= end ? [start, end] : [end, start];
}

function scanGaps(ctx, useTimes, params) {
    if (params.detectGaps === false || !useTimes) {
        return { hasNominalStep: false, medianDt: null, gapEnds: null };
    }
    const info = detectSamplingGaps(ctx.values);
    return {
        hasNominalStep: info.hasNominalStep,
        medianDt: Number.isFinite(info.medianDt) ? info.medianDt : null,
        gapEnds: info.gaps.length ? new Set(info.gaps.map(gap => gap.index + 1)) : null,
    };
}

// A segment is a hole when the source has no usable value for it, or when the
// detector says rows are missing across it. Read from the SOURCE, never from
// the bridged copy: whether the file has data is a property of the file, not of
// the policy chosen about it.
function segmentIsHole(values, i, rectangular, gapEnds) {
    const y0 = values[i - 1];
    const y1 = values[i];
    const usable = rectangular
        ? Number.isFinite(y0)
        : (Number.isFinite(y0) && Number.isFinite(y1));
    const missingRow = gapEnds !== null && gapEnds.has(i);
    return { usable, missingRow, hole: !usable || missingRow };
}

/**
 * Fold per-UTC-day partial sums into the same result a whole-array run would
 * have produced. This is what lets a lazy (DuckDB-backed) file share the eager
 * semantics instead of re-deriving them in SQL: the query answers "area,
 * covered time and holes, per day", and every policy that operates on WHOLE
 * DAYS — discard-day-own, discard-day-all, discard-incomplete-ends — is then
 * decided here, against the same rules the eager kernel applies.
 *
 * `days` entries: { day, areaMs, coveredMs, uncoveredMs, hasHole, sampleCount,
 * firstT, lastT }. Areas and durations arrive in raw ms; the seconds conversion
 * happens here so callers cannot forget it.
 *
 * @returns {object} the shape computeDefiniteIntegral returns
 */
export function reduceDailyIntegral(days = [], params = {}) {
    const toSeconds = 1 / 1000;
    const rangeStart = Number(params.rangeStart);
    const rangeEnd = Number(params.rangeEnd);
    const medianDt = Number.isFinite(params.medianDt) ? params.medianDt : null;
    const excluded = new Set();
    if (params.excludedDays) {
        for (const day of params.excludedDays) if (Number.isFinite(day)) excluded.add(day);
    }
    const policy = INTEGRAL_MISSING_POLICIES.has(params.missingPolicy) ? params.missingPolicy : 'zero';
    const sorted = days.slice().sort((a, b) => a.day - b.day);

    if (policy === 'discard-day-own' || policy === 'discard-day-all') {
        for (const entry of sorted) if (entry.hasHole) excluded.add(entry.day);
    }
    if (params.discardIncompleteEnds) {
        const withSamples = sorted.filter(entry => (entry.sampleCount || 0) > 0);
        const first = withSamples[0];
        const last = withSamples[withSamples.length - 1];
        const tolerance = Number.isFinite(medianDt) && medianDt > 0 ? medianDt : 0;
        if (first && first.firstT > utcDayStart(first.day) + tolerance) excluded.add(first.day);
        if (last && last.lastT < utcDayStart(last.day + 1) - tolerance) excluded.add(last.day);
    }

    let area = 0;
    let covered = 0;
    let uncovered = 0;
    let discarded = 0;
    let sampleCount = 0;
    for (const entry of sorted) {
        sampleCount += Number(entry.sampleCount) || 0;
        uncovered += Number(entry.uncoveredMs) || 0;
        if (excluded.has(entry.day)) {
            discarded += Number(entry.coveredMs) || 0;
            continue;
        }
        area += Number(entry.areaMs) || 0;
        covered += Number(entry.coveredMs) || 0;
    }

    let dayCount = 0;
    let discardedDays = [];
    if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart) {
        const firstDay = utcDayIndex(rangeStart);
        const lastDay = lastDayIndex(rangeEnd);
        dayCount = Math.max(0, lastDay - firstDay + 1);
        discardedDays = [...excluded].filter(day => day >= firstDay && day <= lastDay).sort((a, b) => a - b);
    }

    const negativeDtCount = Number(params.negativeDtCount) || 0;
    const reason = negativeDtCount > 0
        ? 'unsorted'
        : covered > 0
            ? null
            : (discardedDays.length ? 'allDiscarded' : 'noData');

    return {
        ok: reason === null,
        reason,
        value: reason === null ? area * toSeconds : null,
        method: INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal',
        missingPolicy: policy,
        timeKind: 'datetime',
        rangeStart: Number.isFinite(rangeStart) ? rangeStart : null,
        rangeEnd: Number.isFinite(rangeEnd) ? rangeEnd : null,
        spanTime: Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) ? (rangeEnd - rangeStart) * toSeconds : 0,
        coveredTime: covered * toSeconds,
        uncoveredTime: uncovered * toSeconds,
        discardedTime: discarded * toSeconds,
        sampleCount,
        gapCount: Number(params.gapCount) || 0,
        nanSegmentCount: Number(params.nanSegmentCount) || 0,
        negativeDtCount,
        hasNominalStep: !!params.hasNominalStep,
        medianDt: medianDt == null ? null : medianDt * toSeconds,
        dayCount,
        discardedDayCount: discardedDays.length,
        discardedDays,
        // Marks the number as coming from the file itself rather than from a
        // downsampled overview, which is the whole point of the lazy path.
        exact: true,
    };
}

/**
 * UTC days (as day indexes) that hold a hole inside the range. The panel unions
 * these across signals to implement `discard-day-all`, which is the only way
 * every bar can claim the same integrated duration.
 *
 * @returns {{ days: number[], medianDt: number|null, hasNominalStep: boolean }}
 */
export function collectMissingDays(sourceValues, time, params = {}) {
    const { values, ctx, useTimes, at, isDatetime, rectangular } = readContext(sourceValues, time, params);
    const n = values.length;
    const blank = { days: [], medianDt: null, hasNominalStep: false };
    if (n < 2 || !isDatetime) return blank;
    const range = resolveRange(at, n, params);
    if (!range) return blank;
    const [rangeStart, rangeEnd] = range;
    const { hasNominalStep, medianDt, gapEnds } = scanGaps(ctx, useTimes, params);

    const days = new Set();
    for (let i = 1; i < n; i++) {
        const ta = at(i - 1);
        const tb = at(i);
        if (!Number.isFinite(ta) || !Number.isFinite(tb) || !(tb > ta)) continue;
        const from = Math.max(ta, rangeStart);
        const to = Math.min(tb, rangeEnd);
        if (!(to > from)) continue;
        if (!segmentIsHole(values, i, rectangular, gapEnds).hole) continue;
        for (let day = utcDayIndex(from); day <= lastDayIndex(to); day++) days.add(day);
    }
    return { days: [...days].sort((a, b) => a - b), medianDt, hasNominalStep };
}

// The first and last UTC day of the range, when the data does not cover them
// end to end. "Covered" allows one nominal step of slack: hourly samples at
// 00:00…23:00 cover the day, even though the last trapezoid stops at 23:00.
function incompleteEndDays(values, at, n, rangeStart, rangeEnd, medianDt) {
    let firstT = null;
    let lastT = null;
    for (let i = 0; i < n; i++) {
        const t = at(i);
        if (!Number.isFinite(t) || t < rangeStart || t > rangeEnd) continue;
        if (firstT === null) firstT = t;
        lastT = t;
    }
    if (firstT === null) return [];
    const tolerance = Number.isFinite(medianDt) && medianDt > 0 ? medianDt : 0;
    const out = [];
    const firstDay = utcDayIndex(firstT);
    if (firstT > utcDayStart(firstDay) + tolerance) out.push(firstDay);
    const lastDay = utcDayIndex(lastT);
    if (lastT < utcDayStart(lastDay + 1) - tolerance && !out.includes(lastDay)) out.push(lastDay);
    return out;
}

/**
 * Definite integral over [rangeStart, rangeEnd].
 *
 * params:
 *   method                 'trapezoidal' | 'rectangular' (left) — as Data Tools
 *   missingPolicy          see INTEGRAL_MISSING_POLICIES; defaults to 'zero'
 *   rangeStart, rangeEnd   raw abscissa units (epoch ms on a calendar axis);
 *                          null/absent means the data extent
 *   discardIncompleteEnds  drop the first/last UTC day when not fully covered
 *   excludedDays           extra UTC day indexes to remove (the panel's union,
 *                          for 'discard-day-all')
 *   detectGaps             false disables missing-row detection entirely
 *
 * The returned `value` carries the signal's unit times SECONDS on a calendar
 * axis and times the abscissa unit otherwise; `timeKind` says which, because
 * calling row numbers "seconds" would invent hours out of indexes. Every other
 * duration in the result is in those same units.
 */
export function computeDefiniteIntegral(sourceValues, time, params = {}) {
    const { values, ctx, useTimes, at, isDatetime, rectangular, method } =
        readContext(sourceValues, time, params);
    const n = values.length;
    const policy = INTEGRAL_MISSING_POLICIES.has(params.missingPolicy) ? params.missingPolicy : 'zero';
    const toSeconds = isDatetime ? 1 / 1000 : 1;

    const empty = {
        ok: false,
        reason: 'noData',
        value: null,
        method,
        missingPolicy: policy,
        timeKind: ctx.kind,
        rangeStart: null,
        rangeEnd: null,
        spanTime: 0,
        coveredTime: 0,
        uncoveredTime: 0,
        discardedTime: 0,
        sampleCount: 0,
        gapCount: 0,
        nanSegmentCount: 0,
        negativeDtCount: 0,
        hasNominalStep: false,
        medianDt: null,
        dayCount: 0,
        discardedDayCount: 0,
        discardedDays: [],
    };
    if (n < 2) return empty;

    const range = resolveRange(at, n, params);
    if (!range) return empty;
    const [rangeStart, rangeEnd] = range;

    const { hasNominalStep, medianDt, gapEnds } = scanGaps(ctx, useTimes, params);
    const work = policy === 'interpolate' ? bridgeNonFinite(values, ctx) : values;

    // Days removed from the domain of integration. Only a calendar axis has
    // days; on any other axis both policies fall back to 'zero', which the
    // panel also reflects by disabling the controls.
    const excluded = new Set();
    if (isDatetime) {
        if (params.excludedDays) {
            for (const day of params.excludedDays) {
                if (Number.isFinite(day)) excluded.add(day);
            }
        }
        if (policy === 'discard-day-own' || policy === 'discard-day-all') {
            for (const day of collectMissingDays(sourceValues, time, params).days) excluded.add(day);
        }
        if (params.discardIncompleteEnds) {
            for (const day of incompleteEndDays(values, at, n, rangeStart, rangeEnd, medianDt)) {
                excluded.add(day);
            }
        }
    }

    let area = 0;
    let covered = 0;
    let uncovered = 0;
    let discarded = 0;
    let gapCount = 0;
    let nanSegmentCount = 0;
    let negativeDtCount = 0;
    let sampleCount = 0;

    for (let i = 0; i < n; i++) {
        const t = at(i);
        if (Number.isFinite(t) && t >= rangeStart && t <= rangeEnd) sampleCount++;
    }

    for (let i = 1; i < n; i++) {
        const ta = at(i - 1);
        const tb = at(i);
        if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue;
        if (tb < ta) { negativeDtCount++; continue; }
        if (tb === ta) continue;
        const from = Math.max(ta, rangeStart);
        const to = Math.min(tb, rangeEnd);
        if (!(to > from)) continue;

        const { usable: sourceUsable, missingRow, hole: sourceHole } =
            segmentIsHole(values, i, rectangular, gapEnds);
        if (missingRow) gapCount++;
        if (!sourceUsable) nanSegmentCount++;
        // Counted against the SOURCE, before any policy touches it: how much of
        // the range the file has no data for is a property of the file, not of
        // what was decided about it. So 'interpolate' still reports the hole it
        // bridged, and the panel can say the total rests on an assumption.
        if (sourceHole) uncovered += to - from;

        const y0 = work[i - 1];
        const y1 = work[i];
        const workUsable = rectangular
            ? Number.isFinite(y0)
            : (Number.isFinite(y0) && Number.isFinite(y1));
        // Under 'interpolate' a missing row is not a hole to skip: running the
        // quadrature straight across it IS the linear bridge the policy
        // promises, which is what makes an absent row agree with an empty cell.
        const skip = !workUsable || (missingRow && policy !== 'interpolate');

        const pieces = excluded.size ? splitAtDayBoundaries(from, to) : [[from, to]];
        for (const [pieceStart, pieceEnd] of pieces) {
            const span = pieceEnd - pieceStart;
            if (!(span > 0)) continue;
            if (excluded.size && excluded.has(utcDayIndex(pieceStart))) { discarded += span; continue; }
            if (skip) continue;
            if (rectangular) {
                area += y0 * span;
            } else {
                const width = tb - ta;
                const ya = y0 + (y1 - y0) * ((pieceStart - ta) / width);
                const yb = y0 + (y1 - y0) * ((pieceEnd - ta) / width);
                area += 0.5 * (ya + yb) * span;
            }
            covered += span;
        }
    }

    let dayCount = 0;
    let discardedDays = [];
    if (isDatetime && rangeEnd > rangeStart) {
        const firstDay = utcDayIndex(rangeStart);
        const lastDay = lastDayIndex(rangeEnd);
        dayCount = Math.max(0, lastDay - firstDay + 1);
        discardedDays = [...excluded].filter(day => day >= firstDay && day <= lastDay).sort((a, b) => a - b);
    }

    // Disorder is fatal rather than merely noted: every distance would be
    // measured along a sequence that is not the real one, so the area is not a
    // smaller truth, it is a different question's answer.
    const reason = negativeDtCount > 0
        ? 'unsorted'
        : covered > 0
            ? null
            : (discardedDays.length ? 'allDiscarded' : 'noData');

    return {
        ok: reason === null,
        reason,
        value: reason === null ? area * toSeconds : null,
        method,
        missingPolicy: policy,
        timeKind: ctx.kind,
        rangeStart,
        rangeEnd,
        spanTime: (rangeEnd - rangeStart) * toSeconds,
        coveredTime: covered * toSeconds,
        uncoveredTime: uncovered * toSeconds,
        discardedTime: discarded * toSeconds,
        sampleCount,
        gapCount,
        nanSegmentCount,
        negativeDtCount,
        hasNominalStep,
        medianDt: medianDt == null ? null : medianDt * toSeconds,
        dayCount,
        discardedDayCount: discardedDays.length,
        discardedDays,
    };
}
