// The workers the analyses of a time-series or 2D panel compute on when their
// file is in memory (docs/architecture.md, "Analysis jobs").
//
// The same worker script as the Data Tools (src/workers/compute-worker.js), in
// a pool of its own: an analysis of a large file runs for seconds, and it must
// stop when the user presses Cancel or changes a setting — which, for work
// that is synchronous inside a worker, means terminating that worker
// (ExclusiveWorkerPool). The Data Tools' pool keeps its workers and drops
// stale results instead, which suits kernels that take milliseconds.
//
// Null where workers cannot be started (a Node test harness, a page opened
// from file:// without the portable build's bundled workers): the caller then
// runs the same kernel on the main thread.

import { ExclusiveWorkerPool, canUseWorkers, spawnWorker } from './worker-pool.js';

let analysisPool = null;

export function getAnalysisPool() {
    if (!canUseWorkers('compute')) return null;
    if (!analysisPool) {
        analysisPool = new ExclusiveWorkerPool(
            // The `new URL(..., import.meta.url)` form is what lets Vite find
            // and emit the worker chunk; it must stay literal and inline.
            () => spawnWorker('compute', () => new Worker(new URL('../workers/compute-worker.js', import.meta.url), { type: 'module' })),
            { name: 'compute', size: 2 },
        );
    }
    return analysisPool.available ? analysisPool : null;
}

// Rows of an in-memory range at or under this are computed where they are: a
// kernel over so few rows is done before a worker could be handed them.
export const ANALYSIS_INLINE_ROWS = 20000;
