// The kernels of the analyses, as an analysis job runs them.
//
// An analysis job (src/core/analysis-jobs.js) is how an analysis computes
// without holding the main thread: the rows of its range are handed to a job,
// a chunk at a time, and the job runs a kernel over them. The job lives in a
// compute worker when there is one, and on the main thread when there is not
// (a page opened from file:// without bundled workers, a Node test) — and in
// both places it is THIS module that runs: the same registry, calling the same
// kernel functions on the same numbers, so a result does not depend on where
// it was computed. scripts/test-analysis-kernels.mjs holds them to that.
//
// A kernel is `(job, params) => result`:
//   job.col(name)   a column the job was given, whole (its chunks joined);
//   job.chunk       the columns handed with this one call, when the kernel
//                   takes its rows as they come (the passes of a fit);
//   job.state       what a kernel keeps from one call to the next.
// `params` and the result are plain data: they cross to and from the worker.
//
// Everything imported here is pure compute — no DOM, no i18n, no Plotly.

import { histogramFiniteStats, countHistogramBins } from '../utils/histogram.js';
import { buildCalendarHeatmap } from '../utils/calendar-heatmap.js';
import { buildTemporalProfile } from '../utils/temporal-profile.js';
import { collectMissingDays, computeDefiniteIntegral } from './kernels/definite-integral.js';
import { pearsonCorrelation } from '../utils/correlation.js';
import { fitPair, predict } from '../utils/regression.js';
import { runPassesOnArrays } from '../utils/fit-passes.js';
import { maskTrendValues, trendSteps } from '../utils/trend-fit.js';
import { decimateMinMax, shiftedTime } from '../plots/curve-fit-state.js';

/**
 * The time-series Curve Fit of a stretch of rows: the fit of `model` in
 * t′ = (t − t₀) / scale, and its residuals y − ŷ decimated to `buckets`
 * min/max pairs in display time. `{ fit, residual, nScope }` — what
 * PlotManager._curveFitResult draws from.
 */
export function curveFitOverRows(times, values, { model, t0, scale, buckets }) {
    const tPrime = shiftedTime(times, t0, scale);
    const fit = fitPair(model, tPrime, values);
    let residual = { x: [], y: [] };
    if (fit?.status === 'ok') {
        const r = new Float64Array(tPrime.length);
        for (let i = 0; i < tPrime.length; i++) {
            const y = Number(values[i]);
            r[i] = Number.isFinite(y) && Number.isFinite(tPrime[i]) ? y - predict(fit, tPrime[i]) : NaN;
        }
        residual = decimateMinMax(times, r, buckets);
    }
    return { fit, residual, nScope: times.length };
}

/**
 * The Trend analysis of a segment's rows: its mean, spread, linear and
 * quadratic trends over the rows the value band keeps and, when the segment
 * asked for one, its exponential. `{ trend, exp }` — what
 * PlotManager._trendResult draws from.
 */
export function trendOverRows(times, values, { band, t0, scale, expModel }) {
    const tPrime = shiftedTime(times, t0, scale);
    const trend = runPassesOnArrays(trendSteps({ band }), tPrime, values);
    const exp = expModel && expModel !== 'none' ? fitPair(expModel, tPrime, maskTrendValues(values, band)) : null;
    return { trend, exp };
}

// The rows `[from, to)` of a column, as the analyses cut them: a copy (the
// kernels were always handed slices of the signal, never the signal itself),
// or the column as it is when the rows are all of it.
const rowsOf = (column, rows) => {
    if (!rows || !column) return column;
    const [from, to] = rows;
    return from === 0 && to === column.length ? column : column.slice(from, to);
};

// The integral's time context: the values of the time column, or none on an
// index axis.
const integralTime = (timeKind, times) => (timeKind === 'index' ? { values: null, kind: 'index' } : { values: times, kind: timeKind });

export const ANALYSIS_KERNELS = {
    // Calendar heatmap and temporal profile: one kernel call over a signal's
    // times and values in the range.
    'heatmap:build': (job, params) => buildCalendarHeatmap({
        times: job.col(params.times || 'times'),
        values: job.col(params.values || 'values'),
        ...params.options,
    }),
    'profile:build': (job, params) => buildTemporalProfile({
        times: job.col(params.times || 'times'),
        values: job.col(params.values || 'values'),
        ...params.options,
    }),

    // Integral: the days with a hole (for the policy that drops a day from
    // every signal), then the definite integral over the range and, when the
    // panel groups by calendar period, one per window — each window read with
    // one neighbouring sample on either side, so the kernel interpolates the
    // value at the period edge, and handed the step of the whole series.
    'integral:missingDays': (job, params) => {
        const times = rowsOf(job.col(params.times), params.rows);
        const values = rowsOf(job.col(params.values), params.rows);
        return { days: collectMissingDays(values, integralTime(params.timeKind, times), params.options).days };
    },
    'integral:compute': (job, params) => {
        const allTimes = job.col(params.times);
        const allValues = job.col(params.values);
        const result = computeDefiniteIntegral(
            rowsOf(allValues, params.rows),
            integralTime(params.timeKind, rowsOf(allTimes, params.rows)),
            params.options,
        );
        if (!params.windows) return { result, groups: null };
        // The step the WHOLE series has, handed to every window: the result
        // reports it in seconds on a calendar axis, the kernel wants raw
        // abscissa units.
        const nominalStep = result?.hasNominalStep && Number.isFinite(result.medianDt)
            ? result.medianDt * (result.timeKind === 'datetime' ? 1000 : 1)
            : null;
        const groups = params.windows.map(periodWindow => ({
            startMs: periodWindow.periodStartMs,
            endMs: periodWindow.periodEndMs,
            result: computeDefiniteIntegral(
                rowsOf(allValues, periodWindow.rows),
                integralTime(params.timeKind, rowsOf(allTimes, periodWindow.rows)),
                {
                    ...params.groupOptions,
                    rangeStart: periodWindow.startMs,
                    rangeEnd: periodWindow.endMs,
                    nominalStep,
                },
            ),
        }));
        return { result, groups };
    },

    // Correlation of a pair: Pearson's r over the two signals' rows.
    'correlation:pearson': job => pearsonCorrelation(job.col('x'), job.col('y')),

    // The fits, over rows held whole: the time-series Curve Fit and the Trend
    // analysis of a stretch of a signal, and the 2D plot's fit of a pair.
    'fit:curve': (job, params) => curveFitOverRows(job.col('times'), job.col('values'), params),
    'fit:trend': (job, params) => trendOverRows(job.col('times'), job.col('values'), params),
    'fit:pair': (job, params) => fitPair(params.model, job.col('x'), job.col('y')),

    // Histogram: the statistics of a signal's values in the range, then its
    // counts against the edges the panel resolved from every trace's
    // statistics. Two calls on the same column (one column per trace).
    'histogram:stats': (job, params) => histogramFiniteStats(job.col(params.column || 'values'), params.options || {}),
    'histogram:count': (job, params) => countHistogramBins(job.col(params.column || 'values'), params.spec),
};

/**
 * The columns and state of one job, and the kernels run on them. Used as it
 * is by a job on the main thread, and behind the worker's message handler.
 *
 * `put(columns, total)` adds rows to columns by name. With `total` (the row
 * count, when the sender knows it) a column is allocated once and filled as
 * its chunks arrive; without it the chunks are kept and joined when a kernel
 * first asks for the column. A column given whole, in one piece, is handed to
 * the kernel as it is — which is how a job on the main thread passes the very
 * array the analysis holds.
 */
export function createAnalysisJobState() {
    const columns = new Map();
    const state = {};
    const put = (chunk, total = null) => {
        for (const [name, values] of Object.entries(chunk || {})) {
            let column = columns.get(name);
            if (!column) {
                column = { parts: [], rows: 0, whole: null, filled: null };
                if (Number.isInteger(total) && total >= 0 && values.length < total) column.filled = new Float64Array(total);
                columns.set(name, column);
            }
            if (column.filled) column.filled.set(values, column.rows);
            else column.parts.push(values);
            column.rows += values.length;
            column.whole = null;
        }
    };
    const col = (name) => {
        const column = columns.get(name);
        if (!column) return null;
        if (column.whole) return column.whole;
        if (column.filled) {
            column.whole = column.rows === column.filled.length ? column.filled : column.filled.subarray(0, column.rows);
        } else if (column.parts.length === 1) {
            [column.whole] = column.parts;
        } else {
            const joined = new Float64Array(column.rows);
            let at = 0;
            for (const part of column.parts) {
                joined.set(part, at);
                at += part.length;
            }
            column.parts = [joined];
            column.whole = joined;
        }
        return column.whole;
    };
    const run = (kernel, params = {}, chunk = null) => {
        const fn = ANALYSIS_KERNELS[kernel];
        if (!fn) throw new Error(`Unknown analysis kernel "${kernel}"`);
        return fn({ col, state, chunk }, params || {});
    };
    return { put, col, run, state };
}
