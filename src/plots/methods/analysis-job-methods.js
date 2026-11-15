// How the panel's analyses use analysis jobs (src/core/analysis-jobs.js): the
// signal of a run, and a job given the rows of a range held in memory.
//
// Kept apart from the analyses' own modules so a Node test can install it on a
// bare harness: with no Worker there, the jobs run on the caller's thread.

import {
    openAnalysisJob, feedAnalysisJob, columnsFitWorker, analysisWorkersAvailable, ANALYSIS_JOB_SLOT,
} from '../../core/analysis-jobs.js';

export function installPlotAnalysisJobMethods(TargetClass) {
    const proto = TargetClass.prototype;

    /**
     * The signal one run of the panel's analysis hands its job: the shared run
     * signal (_analysisRunSignal in analysis-busy-methods.js) in the jobs'
     * slot. It is tied to the panel's analysis signal, so Cancel stops the job
     * too, and asking for it aborts the run before it — a newer request stops
     * the one it supersedes, the worker in the middle of its kernel, instead
     * of leaving it to finish for nobody (docs/analysis-responsiveness.md).
     *
     * A lazy file's queries of the same run carry a run signal of their own
     * slot (#384): the two halves of a run that mixes files in memory and lazy
     * ones do not stop each other.
     */
    proto._analysisJobSignal = function(plot) {
        return this._analysisRunSignal(plot, ANALYSIS_JOB_SLOT);
    };

    // Stop the job in flight, if any. Called when a newer run is scheduled
    // (before its debounce: the old work is of no use from that moment), when
    // it starts, and by _dropAnalysisRuns.
    proto._abortAnalysisJob = function(plot) {
        this._abortAnalysisRun(plot, ANALYSIS_JOB_SLOT);
    };

    // A run that has ended lets go of the panel's signal.
    proto._settleAnalysisJob = function(plot, signal) {
        this._settleAnalysisRun(plot, ANALYSIS_JOB_SLOT, signal);
    };

    /**
     * Whether a kernel over these columns runs off the main thread: there are
     * workers, and every column can be handed to one. An analysis whose
     * results are returned synchronously (the fits) asks this to know whether
     * to compute on the spot, as before, or to hand the fit to a job and paint
     * it when it comes.
     */
    proto._analysisRunsOffThread = function(columns) {
        return analysisWorkersAvailable() && columnsFitWorker(columns);
    };

    /**
     * A job for kernels over `columns` (arrays in memory, by name): in a
     * worker when every one of them can be handed to it, on this thread
     * otherwise. Nothing is given to it yet (_feedAnalysisJob); the caller
     * closes it.
     */
    proto._openAnalysisJob = function(columns, { signal = null } = {}) {
        const job = openAnalysisJob({ signal, local: !columnsFitWorker(columns) });
        // The time the kernels of every job have run, for _measureAnalysisKernel:
        // the automatic preview is projected from the kernel alone, not from
        // the wait for a worker to start and for its messages.
        job.onKernel = (ms) => {
            this._analysisKernelClock = {
                ms: (this._analysisKernelClock?.ms || 0) + ms,
                runs: (this._analysisKernelClock?.runs || 0) + 1,
            };
        };
        return job;
    };

    // The rows `[start, end)` of `columns`, handed to the job under their names.
    proto._feedAnalysisJob = function(job, columns, { start = 0, end = null, signal = null } = {}) {
        return feedAnalysisJob(job, columns, { start, end, signal });
    };

    /**
     * The rows of a trace held in memory that fall in a display time range,
     * as the analyses cut them (binary bounds on the transformed time), but
     * not yet copied: `{ times, values, start, end, whole }`. `whole` when
     * there is no range (or nothing to cut): the two arrays as they are.
     * `pad` keeps that many neighbours on each side (the integral clips its
     * edge segments against them).
     */
    proto._analysisTraceScope = function(trace, range = null, pad = 0) {
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName) || [];
        const values = this._getTransformedVariableData(trace.fileId, trace.varName) || [];
        const length = Math.min(times.length || 0, values.length || 0);
        if (!length || !range) return { times, values, start: 0, end: length, whole: true };
        let [lower, upper] = range;
        if (lower > upper) [lower, upper] = [upper, lower];
        const start = Math.max(0, Math.min(length, this._lowerBound(times, lower)) - pad);
        const end = Math.max(start, Math.min(length, this._upperBound(times, upper) + pad));
        return { times, values, start, end, whole: false };
    };

    /**
     * A job holding a trace's rows (_analysisTraceScope) as its `times` and
     * `values` columns — the two arrays the analysis used to slice and hand
     * its kernel. The caller closes it.
     */
    proto._analysisJobOverTrace = async function(scope, { signal = null } = {}) {
        const { times, values } = scope;
        const job = this._openAnalysisJob({ times, values }, { signal });
        try {
            if (scope.whole) {
                // Each as long as it is: a kernel that is told of a time and a
                // value array of different lengths must still be told.
                await this._feedAnalysisJob(job, { times }, { signal });
                await this._feedAnalysisJob(job, { values }, { signal });
            } else {
                await this._feedAnalysisJob(job, { times, values }, { start: scope.start, end: scope.end, signal });
            }
        } catch (error) {
            job.close();
            throw error;
        }
        return job;
    };

    /**
     * A job holding the rows `[start, end)` of `columns`, ready for its
     * kernels. The caller closes it.
     */
    proto._analysisJobOver = async function(columns, { start = 0, end = null, signal = null } = {}) {
        const job = this._openAnalysisJob(columns, { signal });
        try {
            await this._feedAnalysisJob(job, columns, { start, end, signal });
        } catch (error) {
            job.close();
            throw error;
        }
        return job;
    };
}
