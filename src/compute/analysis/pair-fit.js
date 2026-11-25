// The fit of one pair of signals, y against x, as one function of plain data:
// what the 2D Curve fit computes for an in-memory file, on the main thread or
// in the compute worker (src/workers/compute-worker.js, `analysis:pairFit`).
// One function, so the two give the same bits.

import { fitPair } from '../../utils/regression.js';

export function pairFitRows({ model, x, y }) {
    return { fit: fitPair(model, x, y), nScope: Math.min(x?.length || 0, y?.length || 0) };
}
