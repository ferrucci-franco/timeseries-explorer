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
import { GAP_THRESHOLD_FACTOR } from '../../utils/sampling-gaps.js';
import { createStepMedian, STEP_COLLECT_LIMIT } from '../../utils/step-median.js';

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

// ─── Calendar grouping ────────────────────────────────────────────────────
//
// The definite integral answers "how much in total". Splitting the domain into
// calendar periods answers "how much per year / month / week / day", which is
// the question a rainfall record asks: the yearly accumulation is the integral
// of the same signal over each calendar year separately.
//
// The split is exact rather than approximate because the kernel already honours
// its range boundaries to the millisecond, interpolating the value at an edge
// that falls between two samples. Integrating consecutive windows that share an
// edge therefore sums back to the integral over the whole span — so "Group by"
// never changes the total, it only shows where the total came from.

export const INTEGRAL_GROUPINGS = new Set(['none', 'day', 'week', 'month', 'year']);

// A hard stop on how many bars the panel will draw (and kernel passes it will
// run). Daily grouping over a decade is 3650 columns of two pixels each: the
// honest answer is to say the grouping is too fine, not to draw it.
export const INTEGRAL_MAX_GROUPS = 2000;

/** Start of the UTC calendar period `ms` falls in. */
export function utcPeriodStart(ms, period) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return NaN;
    if (period === 'day') return Math.floor(value / MS_PER_DAY) * MS_PER_DAY;
    if (period === 'week') {
        // Monday-based, as the temporal profile's weeks are.
        const dayStart = Math.floor(value / MS_PER_DAY) * MS_PER_DAY;
        const weekday = new Date(dayStart).getUTCDay();
        return dayStart - ((weekday === 0 ? 6 : weekday - 1) * MS_PER_DAY);
    }
    const date = new Date(value);
    if (period === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return Date.UTC(date.getUTCFullYear(), 0, 1);
}

/** Start of the UTC calendar period after the one beginning at `startMs`. */
export function utcPeriodEnd(startMs, period) {
    const value = Number(startMs);
    if (!Number.isFinite(value)) return NaN;
    if (period === 'day') return value + MS_PER_DAY;
    if (period === 'week') return value + 7 * MS_PER_DAY;
    const date = new Date(value);
    if (period === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
}

/**
 * The calendar windows covering [startMs, endMs].
 *
 * `clip` decides what happens at the two ends. A window is clipped to the
 * requested span when the user chose that span (a selection band means what it
 * says); left whole when the span is merely the data's own extent, so the last
 * window still has room for the trailing period `extendLastSample` grants the
 * final sample — which is what keeps the sum of the groups equal to the
 * ungrouped total.
 *
 * @returns {{ ok: true, windows: Array<{startMs,endMs,periodStartMs,periodEndMs}> }
 *           | { ok: false, reason: string, count?: number, maxGroups?: number }}
 */
export function calendarPeriodWindows(startMs, endMs, period, options = {}) {
    if (!INTEGRAL_GROUPINGS.has(period) || period === 'none') return { ok: false, reason: 'noGrouping' };
    const from = Number(startMs);
    const to = Number(endMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { ok: false, reason: 'noRange' };
    const clip = options.clip === true;
    const maxGroups = Number.isFinite(Number(options.maxGroups)) ? Number(options.maxGroups) : INTEGRAL_MAX_GROUPS;
    const windows = [];
    let periodStartMs = utcPeriodStart(from, period);
    // A corrupt timestamp must not spin here; the cap is checked each turn.
    while (periodStartMs <= to) {
        const periodEndMs = utcPeriodEnd(periodStartMs, period);
        if (!Number.isFinite(periodEndMs) || periodEndMs <= periodStartMs) break;
        windows.push({
            periodStartMs,
            periodEndMs,
            startMs: clip ? Math.max(periodStartMs, from) : periodStartMs,
            endMs: clip ? Math.min(periodEndMs, to) : periodEndMs,
        });
        if (windows.length > maxGroups) {
            return { ok: false, reason: 'tooManyGroups', count: windows.length, maxGroups };
        }
        periodStartMs = periodEndMs;
    }
    if (!windows.length) return { ok: false, reason: 'noRange' };
    return { ok: true, windows };
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

// ─── The kernel, as passes over the rows ──────────────────────────────────
//
// The definite integral is written as a sequence of PASSES over the rows, in
// file order, so that the same code integrates arrays in memory and a file in
// memory-saving (lazy) mode that is read as a stream and never held whole
// (src/plots/methods/integral-lazy-methods.js). A pass is an object with
// `chunk(t, v)`: the rows' abscissae and values, aligned, in as many pieces as
// the caller likes. Every running quantity carries on from one chunk to the
// next — the previous row, the open hole, the sums — so feeding a pass the
// whole arrays at once or a stream of pieces gives the same doubles, in the
// same order of summation. computeDefiniteIntegral feeds them the arrays.
//
// The passes, by `stage` (the order a driver runs them in):
//
//   scan   the row count, the first and last abscissa (the data extent), the
//          time axis' order and its positive steps (for the gap scan), and the
//          long runs of non-finite values (for 'interpolate');
//   steps  only when the median step is not settled by the scan: further
//          passes over the steps (src/utils/step-median.js). Never on an array
//          in memory, where every step is kept, as detectSamplingGaps does;
//   days   only on a calendar axis with a whole-day policy or the
//          incomplete-ends trim: the UTC days holding a hole, and the first
//          and last sample in the range;
//   area   the quadrature itself, with the counts.
//
// Two inputs may be given as functions, read when they are needed rather than
// when the kernel starts, for a caller that learns them from other passes:
//   nominalStep   read after the scan (a calendar group's window inherits the
//                 whole range's step, known once that range's scan is done);
//   excludedDays  read before the area pass ('discard-day-all' needs every
//                 signal's hole days, known once their days passes are done).

export const INTEGRAL_PASS_STAGES = Object.freeze(['scan', 'steps', 'days', 'area']);

// A run of non-finite values longer than this is noted by the scan, so the
// area pass can bridge it ('interpolate') as it goes; a shorter one is held
// until its end is read. So no pass ever holds more than this many rows.
const BRIDGE_HOLD_ROWS = 4096;

// `null` means "no bound given, use the data extent" — and it has to be tested
// for explicitly, because Number(null) is 0, a perfectly finite number that
// would silently collapse the whole range to [0, 0].
function boundOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// `explicitEnd` matters for `extendLastSample`: read as periods, the DOMAIN runs
// one step past the last sample, so the implied end has to move with it. A range
// the user actually typed or dragged is never widened — it means what it says.
function resolveRange(firstT, lastT, params) {
    const startBound = boundOrNull(params.rangeStart);
    const endBound = boundOrNull(params.rangeEnd);
    const start = startBound === null ? firstT : startBound;
    const end = endBound === null ? lastT : endBound;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const range = start <= end ? [start, end] : [end, start];
    range.explicitEnd = endBound !== null;
    return range;
}

function positiveStepOrNull(value) {
    const step = Number(value);
    return Number.isFinite(step) && step > 0 ? step : null;
}

/**
 * The definite integral (or, with `options.daysOnly`, collectMissingDays) as a
 * generator of passes. Yields `{ stage, chunk(t, v), end() }`; returns the
 * result. `timeKind` is the axis kind ('datetime' | 'numeric' | 'index');
 * `hasTimes` false means there are no abscissae (the row number is the axis).
 *
 * options:
 *   collectLimit  steps kept as they are by the gap scan (Infinity in memory)
 *   stepCapacity  the steps expected, when known (one allocation)
 *   probe         an object that receives `verdict` ({ hasNominalStep,
 *                 medianDt }) once the gap scan is settled, and `ready` once
 *                 nothing more will be written to it
 *   daysOnly      stop after the days pass, returning collectMissingDays' shape
 */
export function* definiteIntegralPasses(params = {}, timeKind = 'numeric', hasTimes = true, options = {}) {
    const probe = options.probe || null;
    try {
        return yield* integralPasses(params, timeKind, hasTimes, options, probe);
    } finally {
        if (probe) probe.ready = true;
    }
}

function* integralPasses(params, timeKind, hasTimes, options, probe) {
    const kind = timeKind === 'datetime' ? 'datetime' : (timeKind === 'index' ? 'index' : 'numeric');
    const useTimes = !!hasTimes && kind !== 'index';
    const isDatetime = kind === 'datetime';
    const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    const rectangular = method === 'rectangular';
    const policy = INTEGRAL_MISSING_POLICIES.has(params.missingPolicy) ? params.missingPolicy : 'zero';
    const interpolate = policy === 'interpolate';
    const toSeconds = isDatetime ? 1 / 1000 : 1;
    const daysOnly = options.daysOnly === true;
    const detect = params.detectGaps !== false && useTimes;
    const deferredStep = typeof params.nominalStep === 'function';
    const givenStep = deferredStep ? null : positiveStepOrNull(params.nominalStep);
    const collectLimit = options.collectLimit ?? STEP_COLLECT_LIMIT;

    const blankDays = { days: [], medianDt: null, hasNominalStep: false };
    if (daysOnly && !isDatetime) return blankDays;

    // ── scan ──
    let stats = detect && !deferredStep && givenStep === null
        ? createStepMedian({ collectLimit, capacity: options.stepCapacity })
        : null;
    const S0 = {
        useTimes,
        n: 0,
        firstT: NaN,
        lastT: NaN,
        prevT: NaN,
        negativeAny: false,     // detectGapIndices' order test: any d < 0
        negativeFinite: false,  // detectSamplingGaps': a finite d < 0
        stats,
        // Long non-finite runs, by first row: { end, y1, t1 } (end = n: never ends).
        longRuns: interpolate && !daysOnly ? new Map() : null,
        runStart: -1,
    };
    const scan = {
        stage: 'scan',
        more: false,
        ended: false,
        chunk(t, v) { scanRows(S0, t, v); },
        end() {
            if (this.ended) return;
            this.ended = true;
            if (S0.longRuns && S0.runStart >= 0 && S0.n - S0.runStart > BRIDGE_HOLD_ROWS) {
                S0.longRuns.set(S0.runStart, { end: S0.n, y1: NaN, t1: NaN });
            }
            this.more = S0.stats ? S0.stats.endPass() : false;
        },
    };
    yield scan;
    scan.end();
    const { n, firstT, lastT, negativeAny, negativeFinite, longRuns } = S0;

    const empty = {
        ok: false,
        reason: 'noData',
        value: null,
        method,
        missingPolicy: policy,
        timeKind: kind,
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
    if (n < 2) return daysOnly ? blankDays : empty;
    const range = resolveRange(firstT, lastT, params);
    if (!range) return daysOnly ? blankDays : empty;
    const [rangeStart] = range;
    const declaredEnd = range[1];
    let rangeEnd = declaredEnd;

    // ── the gap verdict: detectGapIndices for a given step, detectSamplingGaps
    //    otherwise ──
    let hasNominalStep = false;
    let medianDt = null;
    let gapsActive = false;
    let threshold = NaN;
    if (detect) {
        const step = deferredStep ? positiveStepOrNull(params.nominalStep()) : givenStep;
        if (step !== null) {
            hasNominalStep = !negativeAny;
            medianDt = step;
            threshold = step * GAP_THRESHOLD_FACTOR;
            gapsActive = hasNominalStep && Number.isFinite(threshold);
        } else if (n >= 3 && !negativeFinite) {
            let more = scan.more;
            if (!stats) {
                // The step was to be inherited and is not there: measure it.
                stats = createStepMedian({ collectLimit, capacity: options.stepCapacity });
                const pass = stepsPass(stats, useTimes);
                yield pass;
                pass.end();
                more = pass.more;
            }
            if (stats.count >= 2) {
                while (more) {
                    const pass = stepsPass(stats, useTimes);
                    yield pass;
                    pass.end();
                    more = pass.more;
                }
                const verdict = stats.verdict();
                const median = verdict.medianDt;
                medianDt = Number.isFinite(median) ? median : null;
                hasNominalStep = Number.isFinite(median) && median > 0 && verdict.agreementOk;
                threshold = hasNominalStep ? median * GAP_THRESHOLD_FACTOR : NaN;
                gapsActive = hasNominalStep;
            }
        }
    }
    stats = null;
    if (probe) probe.verdict = { hasNominalStep, medianDt };

    const extendLastSample = params.extendLastSample === true;
    // Read as periods with no explicit end, the domain reaches one step past the
    // last sample — that is what makes a day of quarter-hours 24 h long.
    if (!daysOnly && extendLastSample && !range.explicitEnd && hasNominalStep && medianDt > 0) {
        rangeEnd += medianDt;
    }
    // ── days ──
    // Days removed from the domain of integration. Only a calendar axis has
    // days; on any other axis both policies fall back to 'zero', which the
    // panel also reflects by disabling the controls.
    const dayPolicy = policy === 'discard-day-own' || policy === 'discard-day-all';
    const wantHoles = daysOnly || (isDatetime && dayPolicy);
    const wantEnds = !daysOnly && isDatetime && !!params.discardIncompleteEnds;
    const D = {
        useTimes,
        rectangular,
        rangeStart,
        rangeEnd,
        // The range as given: a hole past the data is not in it, whatever the
        // periods reading adds.
        declaredEnd,
        gapsActive,
        threshold,
        wantHoles,
        wantEnds,
        holeDays: new Set(),
        endFirstT: null,
        endLastT: null,
        g: 0,
        lastT: NaN,
        lastV: NaN,
    };
    const holeDays = D.holeDays;
    if (wantHoles || wantEnds) {
        const days = {
            stage: 'days',
            chunk(t, v) { daysRows(D, t, v); },
            end() {},
            // What this signal holds holes on: the panel unions these across
            // signals for 'discard-day-all'.
            holeDays: () => [...holeDays].sort((a, b) => a - b),
        };
        yield days;
    }
    if (daysOnly) return { days: [...holeDays].sort((a, b) => a - b), medianDt, hasNominalStep };

    const excluded = new Set();
    if (isDatetime) {
        const extra = typeof params.excludedDays === 'function' ? params.excludedDays() : params.excludedDays;
        if (extra) {
            for (const day of extra) {
                if (Number.isFinite(day)) excluded.add(day);
            }
        }
        if (dayPolicy) for (const day of holeDays) excluded.add(day);
        const { endFirstT, endLastT } = D;
        if (wantEnds && endFirstT !== null) {
            // The first and last UTC day of the range, when the data does not
            // cover them end to end. The slack allowed at the end is exactly
            // one nominal step, but ONLY when the last sample is taken to own
            // that step (`extendLastSample`). The two settings have to agree or
            // the panel contradicts itself: hourly samples at 00:00…23:00
            // either cover the day — in which case the integral must run to
            // midnight too — or they do not, in which case the day is not
            // complete and goes. Reporting "32 days integrated" over 31 days
            // and 23 hours is the one thing neither reading permits.
            const step = Number.isFinite(medianDt) && medianDt > 0 ? medianDt : 0;
            const tolerance = extendLastSample ? step : 0;
            const firstDay = utcDayIndex(endFirstT);
            const ends = [];
            if (endFirstT > utcDayStart(firstDay)) ends.push(firstDay);
            const lastDay = utcDayIndex(endLastT);
            if (endLastT < utcDayStart(lastDay + 1) - tolerance && !ends.includes(lastDay)) ends.push(lastDay);
            for (const day of ends) excluded.add(day);
        }
    }

    // ── area ──
    const A = {
        useTimes,
        interpolate,
        rectangular,
        rangeStart,
        rangeEnd,
        gapsActive,
        threshold,
        excluded,
        n,
        longRuns,
        g: 0,
        // The row integrated last: its abscissa, source value and integrated
        // value ('interpolate' integrates the bridged copy).
        started: false,
        lastT: NaN,
        lastV: NaN,
        lastW: NaN,
        area: 0,
        covered: 0,
        uncovered: 0,
        discarded: 0,
        gapCount: 0,
        nanSegmentCount: 0,
        negativeDtCount: 0,
        sampleCount: 0,
        // The last row with a finite abscissa and a finite value: the one that
        // owns the trailing period.
        tailT: NaN,
        tailV: NaN,
        // 'interpolate': the open run of non-finite values, and its rows held
        // until its far end is read.
        run: null,
        held: 0,
        heldT: null,
        heldV: null,
        heldW: null,
    };
    const areaPass = {
        stage: 'area',
        ended: false,
        chunk(t, v) { areaRows(A, t, v, null); },
        end() {
            if (this.ended) return;
            this.ended = true;
            // A run still open at the last row has no far end: left as it is.
            if (A.run && !A.run.long) releaseHeld(A, NaN, NaN, false);
            A.run = null;
            A.heldT = A.heldV = A.heldW = null;
        },
    };
    yield areaPass;
    areaPass.end();
    let { area, covered, discarded } = A;
    const { uncovered, gapCount, nanSegmentCount, negativeDtCount, sampleCount, tailT, tailV } = A;

    // The step the last sample owns, when the data is read as periods. Held
    // constant (there is nothing to interpolate towards), clipped to the range
    // and split at midnight like every other interval, so a day that only
    // leaves it out is no longer reported as fully integrated.
    //
    // A trapezoid needs a sample on both sides, so a series ending at 23:45
    // leaves the last 15 minutes of the day uncovered — the total is short by
    // one step and the reported duration says so. That is right for a sampled
    // signal and wrong for a PyPSA-style snapshot, where each timestamp
    // REPRESENTS the step that follows it. Only a series with a nominal step
    // can be extended: without one there is no defensible length to give the
    // last period.
    if (extendLastSample && hasNominalStep && medianDt > 0 && Number.isFinite(tailT) && tailT < rangeEnd) {
        const from = tailT;
        const to = Math.min(tailT + medianDt, rangeEnd);
        if (to > from) {
            const pieces = excluded.size ? splitAtDayBoundaries(from, to) : [[from, to]];
            for (const [pieceStart, pieceEnd] of pieces) {
                const span = pieceEnd - pieceStart;
                if (!(span > 0)) continue;
                if (excluded.size && excluded.has(utcDayIndex(pieceStart))) { discarded += span; continue; }
                area += tailV * span;
                covered += span;
            }
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
        extendLastSample,
        timeKind: kind,
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

// The days pass over one chunk: the UTC days a hole touches inside the range,
// and the first and last sample in it.
function daysRows(D, t, v) {
    const { useTimes, rectangular, rangeStart, rangeEnd, declaredEnd, gapsActive, threshold, wantHoles, wantEnds, holeDays } = D;
    let g = D.g;
    let pt = D.lastT;
    let pv = D.lastV;
    let endFirstT = D.endFirstT;
    let endLastT = D.endLastT;
    const len = v.length;
    for (let k = 0; k < len; k++, g++) {
        const tb = useTimes ? t[k] : g;
        const vb = v[k];
        if (wantEnds && Number.isFinite(tb) && tb >= rangeStart && tb <= rangeEnd) {
            if (endFirstT === null) endFirstT = tb;
            endLastT = tb;
        }
        if (wantHoles && g > 0) {
            const ta = pt;
            if (Number.isFinite(ta) && Number.isFinite(tb) && tb > ta) {
                const from = Math.max(ta, rangeStart);
                const to = Math.min(tb, declaredEnd);
                if (to > from) {
                    const usable = rectangular
                        ? Number.isFinite(pv)
                        : (Number.isFinite(pv) && Number.isFinite(vb));
                    // Rows are missing across a step above the threshold: the
                    // detector's own subtraction.
                    if (!usable || (gapsActive && (tb - ta) > threshold)) {
                        for (let day = utcDayIndex(from); day <= lastDayIndex(to); day++) holeDays.add(day);
                    }
                }
            }
        }
        pt = tb;
        pv = vb;
    }
    D.g = g;
    D.lastT = pt;
    D.lastV = pv;
    D.endFirstT = endFirstT;
    D.endLastT = endLastT;
}

// The value bridgeNonFinite (integral.js) gives row k of a run of non-finite
// values between (t0, y0) and (t1, y1): the straight line, by abscissa.
function bridgedValue(tk, t0, y0, t1, y1) {
    const span = t1 - t0;
    const frac = span && Number.isFinite(tk) ? (tk - t0) / span : 0;
    return y0 + frac * (y1 - y0);
}

// The held rows of a short run, now that its far end (t1, y1) is read — or the
// rows ran out (`ends` false), and the run stays as it is.
function releaseHeld(A, t1, y1, ends) {
    const run = A.run;
    // Bridged only with a finite row on both sides, as bridgeNonFinite does.
    const ok = ends && run.hasPrev && Number.isFinite(run.y0) && Number.isFinite(y1)
        && Number.isFinite(run.t0) && Number.isFinite(t1);
    const held = A.held;
    A.held = 0;
    for (let j = 0; j < held; j++) {
        A.heldW[j] = ok ? bridgedValue(A.heldT[j], run.t0, run.y0, t1, y1) : A.heldV[j];
    }
    areaRows(A, A.heldT.subarray(0, held), A.heldV.subarray(0, held), A.heldW);
}

// The area pass over one chunk: every interval between consecutive rows,
// clipped to the range, split at midnight when days are excluded, integrated
// unless it is a hole. A function of its own over a state object, with the
// running sums in locals: the loop runs once per row of the file.
//
// `w`, when given, are the rows' integrated values, already bridged: the held
// rows of a run, replayed once its far end is known (their samples were
// counted when they were first read).
function areaRows(A, t, v, w) {
    const useTimes = A.useTimes;
    const interpolate = A.interpolate && w === null;
    const replay = w !== null;
    const rectangular = A.rectangular;
    const rangeStart = A.rangeStart;
    const rangeEnd = A.rangeEnd;
    const gapsActive = A.gapsActive;
    const threshold = A.threshold;
    const excluded = A.excluded;
    const split = excluded.size > 0;
    // Under 'interpolate' a missing row is not a hole to skip: running the
    // quadrature straight across it IS the linear bridge the policy promises,
    // which is what makes an absent row agree with an empty cell.
    const skipMissingRows = !A.interpolate;
    let g = A.g;
    let started = A.started;
    let lastT = A.lastT;
    let lastV = A.lastV;
    let lastW = A.lastW;
    let area = A.area;
    let covered = A.covered;
    let uncovered = A.uncovered;
    let discarded = A.discarded;
    let gapCount = A.gapCount;
    let nanSegmentCount = A.nanSegmentCount;
    let negativeDtCount = A.negativeDtCount;
    let sampleCount = A.sampleCount;
    let tailT = A.tailT;
    let tailV = A.tailV;
    const len = v.length;
    for (let k = 0; k < len; k++) {
        const tb = replay ? t[k] : (useTimes ? t[k] : g);
        const vb = v[k];
        let wb = replay ? w[k] : vb;
        if (!replay) {
            g++;
            if (Number.isFinite(tb)) {
                if (tb >= rangeStart && tb <= rangeEnd) sampleCount++;
                if (Number.isFinite(vb)) { tailT = tb; tailV = vb; }
            }
        }
        if (interpolate) {
            if (Number.isFinite(vb)) {
                const run = A.run;
                if (run !== null) {
                    A.run = null;
                    if (!run.long && A.held) {
                        A.run = run;
                        A.g = g; A.started = started; A.lastT = lastT; A.lastV = lastV; A.lastW = lastW;
                        A.area = area; A.covered = covered; A.uncovered = uncovered; A.discarded = discarded;
                        A.gapCount = gapCount; A.nanSegmentCount = nanSegmentCount; A.negativeDtCount = negativeDtCount;
                        releaseHeld(A, tb, vb, true);
                        A.run = null;
                        started = A.started; lastT = A.lastT; lastV = A.lastV; lastW = A.lastW;
                        area = A.area; covered = A.covered; uncovered = A.uncovered; discarded = A.discarded;
                        gapCount = A.gapCount; nanSegmentCount = A.nanSegmentCount; negativeDtCount = A.negativeDtCount;
                    }
                }
            } else {
                // `g` has moved past this row: its index is g - 1.
                let run = A.run;
                if (run === null) {
                    run = { t0: lastT, y0: lastV, hasPrev: g - 1 > 0, long: A.longRuns.get(g - 1) || null };
                    A.run = run;
                }
                if (run.long !== null) {
                    const { end, y1, t1 } = run.long;
                    const ok = run.hasPrev && end < A.n && Number.isFinite(run.y0) && Number.isFinite(y1)
                        && Number.isFinite(run.t0) && Number.isFinite(t1);
                    if (ok) wb = bridgedValue(tb, run.t0, run.y0, t1, y1);
                } else {
                    if (A.heldT === null) {
                        // Allocated with the first held row: a kernel per calendar
                        // period must not each carry the buffers.
                        A.heldT = new Float64Array(BRIDGE_HOLD_ROWS);
                        A.heldV = new Float64Array(BRIDGE_HOLD_ROWS);
                        A.heldW = new Float64Array(BRIDGE_HOLD_ROWS);
                    }
                    A.heldT[A.held] = tb;
                    A.heldV[A.held] = vb;
                    A.held++;
                    continue;
                }
            }
        }
        if (started) {
            const ta = lastT;
            if (Number.isFinite(ta) && Number.isFinite(tb)) {
                if (tb < ta) {
                    negativeDtCount++;
                } else if (tb !== ta) {
                    const from = Math.max(ta, rangeStart);
                    const to = Math.min(tb, rangeEnd);
                    if (to > from) {
                        // A segment is a hole when the source has no usable
                        // value for it, or when the detector says rows are
                        // missing across it (its step is above the threshold:
                        // the detector's own subtraction). Read from the
                        // SOURCE, never from the bridged copy: whether the file
                        // has data is a property of the file, not of the policy
                        // chosen about it.
                        const ya = lastV;
                        const sourceUsable = rectangular
                            ? Number.isFinite(ya)
                            : (Number.isFinite(ya) && Number.isFinite(vb));
                        const missingRow = gapsActive && (tb - ta) > threshold;
                        if (missingRow) gapCount++;
                        if (!sourceUsable) nanSegmentCount++;
                        // Counted against the SOURCE, before any policy touches
                        // it: so 'interpolate' still reports the hole it
                        // bridged, and the panel can say the total rests on an
                        // assumption.
                        if (!sourceUsable || missingRow) uncovered += to - from;
                        const wa = lastW;
                        const workUsable = rectangular
                            ? Number.isFinite(wa)
                            : (Number.isFinite(wa) && Number.isFinite(wb));
                        const skip = !workUsable || (missingRow && skipMissingRows);
                        if (!split) {
                            const span = to - from;
                            if (span > 0 && !skip) {
                                if (rectangular) {
                                    area += wa * span;
                                } else {
                                    const width = tb - ta;
                                    const yA = wa + (wb - wa) * ((from - ta) / width);
                                    const yB = wa + (wb - wa) * ((to - ta) / width);
                                    area += 0.5 * (yA + yB) * span;
                                }
                                covered += span;
                            }
                        } else {
                            for (const [pieceStart, pieceEnd] of splitAtDayBoundaries(from, to)) {
                                const span = pieceEnd - pieceStart;
                                if (!(span > 0)) continue;
                                if (excluded.has(utcDayIndex(pieceStart))) { discarded += span; continue; }
                                if (skip) continue;
                                if (rectangular) {
                                    area += wa * span;
                                } else {
                                    const width = tb - ta;
                                    const yA = wa + (wb - wa) * ((pieceStart - ta) / width);
                                    const yB = wa + (wb - wa) * ((pieceEnd - ta) / width);
                                    area += 0.5 * (yA + yB) * span;
                                }
                                covered += span;
                            }
                        }
                    }
                }
            }
        }
        started = true;
        lastT = tb;
        lastV = vb;
        lastW = wb;
    }
    A.g = g;
    A.started = started;
    A.lastT = lastT;
    A.lastV = lastV;
    A.lastW = lastW;
    A.area = area;
    A.covered = covered;
    A.uncovered = uncovered;
    A.discarded = discarded;
    A.gapCount = gapCount;
    A.nanSegmentCount = nanSegmentCount;
    A.negativeDtCount = negativeDtCount;
    A.sampleCount = sampleCount;
    A.tailT = tailT;
    A.tailV = tailV;
}

// The scan pass over one chunk. A function of its own over a state object,
// with the running values in locals: the loop runs once per row of the file.
function scanRows(S, t, v) {
    const useTimes = S.useTimes;
    const stats = S.stats;
    const longRuns = S.longRuns;
    let g = S.n;
    let prevT = S.prevT;
    let negativeAny = S.negativeAny;
    let negativeFinite = S.negativeFinite;
    let runStart = S.runStart;
    const len = v.length;
    if (stats !== null && useTimes) stats.addSteps(t, len, prevT);
    for (let k = 0; k < len; k++, g++) {
        const tg = useTimes ? t[k] : g;
        if (g === 0) S.firstT = tg;
        if (useTimes && g > 0) {
            const d = tg - prevT;
            if (d < 0) {
                negativeAny = true;
                if (Number.isFinite(d)) negativeFinite = true;
            }
        }
        prevT = tg;
        if (longRuns !== null) {
            const value = v[k];
            if (Number.isFinite(value)) {
                if (runStart >= 0 && g - runStart > BRIDGE_HOLD_ROWS) longRuns.set(runStart, { end: g, y1: value, t1: tg });
                runStart = -1;
            } else if (runStart < 0) {
                runStart = g;
            }
        }
    }
    if (len) S.lastT = useTimes ? t[len - 1] : g - 1;
    S.n = g;
    S.prevT = prevT;
    S.negativeAny = negativeAny;
    S.negativeFinite = negativeFinite;
    S.runStart = runStart;
}

// A pass over the positive steps only, for the median's further passes.
function stepsPass(stats, useTimes) {
    let prev = NaN;
    return {
        stage: 'steps',
        more: false,
        ended: false,
        chunk(t, v) {
            const len = v.length;
            if (!useTimes || !len) return;
            stats.addSteps(t, len, prev);
            prev = t[len - 1];
        },
        end() {
            if (this.ended) return;
            this.ended = true;
            this.more = stats.endPass();
        },
    };
}

// Every pass over the same arrays: the in-memory driver.
export function runIntegralPassesOnArrays(passes, t, v) {
    let step = passes.next();
    while (!step.done) {
        step.value.chunk(t, v);
        step.value.end();
        step = passes.next();
    }
    return step.value;
}

// The kernel's inputs from the in-memory call: values as doubles, and the
// abscissae aligned with them (an absent one reads NaN, as an out-of-range
// index did).
function arrayInputs(sourceValues, time) {
    const values = asFloat64(sourceValues);
    const ctx = normalizeTimeContext(time);
    const useTimes = !!(ctx.values && ctx.kind !== 'index');
    let times = null;
    if (useTimes) {
        times = ctx.values;
        if (times.length !== values.length) {
            const aligned = new Float64Array(values.length).fill(NaN);
            aligned.set(times.subarray(0, Math.min(times.length, values.length)));
            times = aligned;
        }
    }
    return { values, ctx, times, hasTimes: !!ctx.values };
}

/**
 * UTC days (as day indexes) that hold a hole inside the range. The panel unions
 * these across signals to implement `discard-day-all`, which is the only way
 * every bar can claim the same integrated duration.
 *
 * @returns {{ days: number[], medianDt: number|null, hasNominalStep: boolean }}
 */
export function collectMissingDays(sourceValues, time, params = {}) {
    const { values, ctx, times, hasTimes } = arrayInputs(sourceValues, time);
    const passes = definiteIntegralPasses(params, ctx.kind, hasTimes, {
        daysOnly: true,
        collectLimit: Infinity,
        stepCapacity: values.length,
    });
    return runIntegralPassesOnArrays(passes, times, values);
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
 *   extendLastSample       read the samples as periods: the last one owns one
 *                          nominal step, so a whole day of quarter-hours
 *                          integrates to 24 h instead of 23 h 45 min
 *   excludedDays           extra UTC day indexes to remove (the panel's union,
 *                          for 'discard-day-all')
 *   detectGaps             false disables missing-row detection entirely
 *   nominalStep            the series' sampling step in raw abscissa units,
 *                          supplied when `values` is a WINDOW of a longer
 *                          series (calendar grouping): too short a window
 *                          cannot establish a step of its own
 *
 * The returned `value` carries the signal's unit times SECONDS on a calendar
 * axis and times the abscissa unit otherwise; `timeKind` says which, because
 * calling row numbers "seconds" would invent hours out of indexes. Every other
 * duration in the result is in those same units.
 *
 * The arrays are fed to the passes of definiteIntegralPasses whole; a lazy
 * file streams the same passes a chunk at a time and gets the same doubles.
 */
export function computeDefiniteIntegral(sourceValues, time, params = {}) {
    const { values, ctx, times, hasTimes } = arrayInputs(sourceValues, time);
    const passes = definiteIntegralPasses(params, ctx.kind, hasTimes, {
        collectLimit: Infinity,
        stepCapacity: values.length,
    });
    return runIntegralPassesOnArrays(passes, times, values);
}
