// The Pearson correlation of one pair of signals, as one function of plain
// data: what the pair Correlation computes for an in-memory file, on the main
// thread or in the compute worker (src/workers/compute-worker.js,
// `analysis:correlation`). One function, so the two give the same bits.

import { pearsonCorrelation } from '../../utils/correlation.js';

export function pairCorrelationRows({ x, y }) {
    return pearsonCorrelation(x, y);
}
