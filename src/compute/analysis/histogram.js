// The histogram's two kernels as functions of plain data: what the Histogram
// analysis computes over the values of a trace, on the main thread or in the
// compute worker (src/workers/compute-worker.js, `analysis:histogramStats`
// and `analysis:histogramCounts`). The same functions, so the same bits.
//
// The stats come first, for every trace; the shared edges are resolved from
// them on the main thread; then each trace is counted against those edges.

import { countHistogramBins, histogramFiniteStats } from '../../utils/histogram.js';

/** The finite stats of `values` (rows in scope, finite, min, max, quartiles). */
export function histogramStatsOf({ values, computeQuartiles = true }) {
    return histogramFiniteStats(values, { computeQuartiles });
}

/** The counts of `values` against the shared edges `spec`. */
export function histogramCountsOf({ values, spec }) {
    return countHistogramBins(values, spec);
}
