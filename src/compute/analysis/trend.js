// The numbers of one Trend segment over the rows of its stretch, as one
// function of plain data: what the Trend analysis computes for an in-memory
// file, on the main thread or in the compute worker
// (src/workers/compute-worker.js, `analysis:trend`). One function, so the two
// give the same bits.
//
// `times` are display times inside the stretch, `values` the signal there.
// Everything runs on t′ = (t − t0) / scale. `band` is the segment's value
// band, or null; `expModel` the exponential asked for, or 'none'.

import { fitPair } from '../../utils/regression.js';
import { runPassesOnArrays } from '../../utils/fit-passes.js';
import { maskTrendValues, trendSteps } from '../../utils/trend-fit.js';
import { shiftedTime } from '../../plots/curve-fit-state.js';

// The exponential of a segment that asked for one, over the rows the band
// keeps. Null when none was asked for.
export function trendExpRows(expModel, band, tPrime, values) {
    if (!expModel || expModel === 'none') return null;
    return fitPair(expModel, tPrime, maskTrendValues(values, band));
}

export function trendRows({ times, values, t0, scale, band = null, expModel = 'none' }) {
    const tPrime = shiftedTime(times, t0, scale);
    const trend = runPassesOnArrays(trendSteps({ band }), tPrime, values);
    const exp = trendExpRows(expModel, band, tPrime, values);
    return { trend, exp };
}
