// Panel statistics (Σ) of a file in memory-saving (lazy) mode: every row of the
// file, not the overview in memory.
//
// In memory, Σ runs seriesStats over a variable's transformed values
// (_getTransformedVariableData: crop, time shift, gain, offset, sign). On a
// lazy file those arrays are a decimated overview, and the same call would
// print figures that look right and are not. Here the file is read in order,
// a chunk at a time, by the pass the lazy histogram reads it with
// (_lazyHistogramPass: the same transform, applied to rows read from the
// file), and each chunk is fed to the same arithmetic
// (createSeriesStatsAccumulator) — so min, max, mean, RMS and the count of
// missing samples are the in-memory ones, bit for bit.
//
// A variable that exists only in the overview (one computed from it, with no
// SQL of its own) has no file to read: it is reported as such, never filled in
// from the overview.
//
// No Plotly here: the module runs in Node against DuckDB-WASM in the tests.

import { createSeriesStatsAccumulator } from '../../utils/series-stats.js';

export function installPlotStatsLazyMethods(TargetClass) {
    const proto = TargetClass.prototype;

    /** Whether a variable's file is read lazily. */
    proto._isLazyStatsEntry = function(entry) {
        return !!this.files.get(entry?.fileId)?.data?._duckdb;
    };

    /** Whether a lazy variable can be read whole: the time axis, or a column with SQL of its own. */
    proto._lazyStatsEntryHasSource = function(entry) {
        const data = this.files.get(entry?.fileId)?.data;
        const variable = data?.variables?.[entry?.varName];
        if (!variable) return false;
        if (variable.kind === 'abscissa' || entry.varName === this._getTimeVar(entry.fileId)) return true;
        return !!data?._duckdb?.source?.hasSqlValue?.(variable);
    };

    /**
     * seriesStats for each lazy entry ({ fileId, varName }), over every row of
     * its file: `Map(entry → stats | null)`. Entries without a source are left
     * out (the caller says so). One stream per file, every variable at once.
     */
    proto._lazyPanelStats = async function(entries, { signal = null, onRows = null } = {}) {
        const readable = entries.filter(entry => this._lazyStatsEntryHasSource(entry));
        const accumulators = new Map(readable.map(entry => [entry, createSeriesStatsAccumulator()]));
        await this._lazyHistogramPass(readable, null, (entry, values) => {
            accumulators.get(entry).add(values);
        }, { signal, onRows });
        // Cancelled after the last chunk is still cancelled: no figures from a
        // read the user stopped.
        if (signal?.aborted) {
            const err = new Error('Statistics cancelled');
            err.name = 'AbortError';
            throw err;
        }
        return new Map([...accumulators].map(([entry, stats]) => [entry, stats.result()]));
    };
}
