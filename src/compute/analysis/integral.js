// The definite integral of one in-memory signal — its total over the range,
// and one integral per calendar period when the panel groups — as one
// function of plain data, for the compute worker
// (src/workers/compute-worker.js, `analysis:integral`).
//
// The kernel is computeDefiniteIntegral, the one the main thread runs
// (PlotManager._recomputeIntegral with _integralSeriesForTrace and
// _integralEagerGroups). What this module adds is their row selection, done on
// the arrays it is given: the rows of a range with one neighbour on each side,
// so the kernel clips the edge segments to the exact bounds. The caller hands
// over the rows of the whole range with those neighbours, which hold every
// period window's rows too; selecting inside them by bisection gives the rows
// the main thread selects in the full arrays, so the numbers are the same bits.

import { collectMissingDays, computeDefiniteIntegral } from '../kernels/definite-integral.js';

function lowerBound(sorted, target) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function upperBound(sorted, target) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// _integralSeriesForTrace on the arrays given: the rows of `range` and one
// neighbour on each side; everything when there is no range. Views, no copy.
function rowsOf(times, values, range) {
    const length = Math.min(times?.length || 0, values?.length || 0);
    if (!length || !range) return { times, values };
    let [lower, upper] = range;
    if (lower > upper) [lower, upper] = [upper, lower];
    const start = Math.max(0, Math.min(length, lowerBound(times, lower)) - 1);
    const end = Math.max(start, Math.min(length, upperBound(times, upper) + 1));
    return { times: times.subarray(start, end), values: values.subarray(start, end) };
}

const timeContext = (kind, times) => (kind === 'index' ? { values: null, kind: 'index' } : { values: times, kind });

/**
 * @param {object} args
 * @param {Float64Array} args.times   display times (epoch ms on a calendar axis)
 * @param {Float64Array} args.values
 * @param {'datetime'|'numeric'|'index'} args.kind
 * @param {[number, number]|null} args.range   the panel's range, null for all
 * @param {object} args.options   the kernel's options for the whole range
 * @param {Array|null} args.windows   calendar period windows, or null
 * @returns {{ result: object, groups: Array|null }}
 */
export function integralRows({ times, values, kind, range = null, options = {}, windows = null }) {
    const whole = rowsOf(times, values, range);
    const result = computeDefiniteIntegral(whole.values, timeContext(kind, whole.times), options);
    if (!windows) return { result, groups: null };
    // The step the WHOLE series has, handed to every window: the result reports
    // it in seconds on a calendar axis, the kernel wants raw abscissa units.
    const nominalStep = result?.hasNominalStep && Number.isFinite(result.medianDt)
        ? result.medianDt * (result.timeKind === 'datetime' ? 1000 : 1)
        : null;
    const groups = windows.map((periodWindow) => {
        const selected = rowsOf(times, values, [periodWindow.startMs, periodWindow.endMs]);
        return {
            startMs: periodWindow.periodStartMs,
            endMs: periodWindow.periodEndMs,
            result: computeDefiniteIntegral(selected.values, timeContext(kind, selected.times), {
                ...options,
                rangeStart: periodWindow.startMs,
                rangeEnd: periodWindow.endMs,
                nominalStep,
            }),
        };
    });
    return { result, groups };
}

/** The days of the range with a hole in them (for "discard the day for all"). */
export function integralMissingDays({ times, values, kind, range = null, options = {} }) {
    const whole = rowsOf(times, values, range);
    return { days: [...collectMissingDays(whole.values, timeContext(kind, whole.times), options).days] };
}
