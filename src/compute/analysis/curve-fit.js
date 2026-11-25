// The time-series curve fit of the rows of one range, as one function of plain
// data: what the Curve fit analysis computes for an in-memory file, on the
// main thread or in the compute worker (src/workers/compute-worker.js,
// `analysis:curveFit`). One function, so the two give the same bits.
//
// `times` are display times inside the range, `values` the signal there. The
// fit runs on t′ = (t − t0) / scale; the residuals come back decimated to
// `buckets` min/max buckets in display time, which is what the pane draws.

import { fitPair, predict } from '../../utils/regression.js';
import { decimateMinMax, shiftedTime } from '../../plots/curve-fit-state.js';

export function curveFitRows({ model, times, values, t0, scale, buckets }) {
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
