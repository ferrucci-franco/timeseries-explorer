// The histogram of a file in memory-saving (lazy) mode: every row of the file,
// not the overview in memory.
//
// The in-memory histogram reads a trace's transformed values
// (_getTransformedVariableData: crop, time shift, gain, offset, sign), cuts
// them to the selected range by the transformed time
// (_histogramSamplesForTrace), and runs the kernel of src/utils/histogram.js:
// finite stats with quartiles (exact up to HISTOGRAM_EXACT_QUANTILE_MAX_N
// finite values, a deterministic stride sample above), shared edges, and the
// counts. Here the same happens over the file read in order, a chunk at a time:
// each chunk is transformed by the function the lazy FFT and phase plots use
// for rows read from the file (_transformFetchedPhaseTrajectory), cut to the
// range by the same comparison, and handed to the same arithmetic — the
// counts are sums of integers, the quartiles come from the same sample sorted
// the same way, so the bars are the in-memory bars.
//
// Passes over the file, per pass one stream per file with every variable its
// traces read:
//   1. stats: rows in range, finite, min, max; the finite values themselves
//      while there are no more than the quartile limit (then nothing else is
//      read: the quartiles and the counts come from them);
//   2. only for an automatic bin count past that limit: the stride sample the
//      in-memory kernel takes, for the quartiles;
//   3. only past that limit: the counts, against the shared edges.
//
// No Plotly here: the module runs in Node against DuckDB-WASM in the tests.

import { streamColumns } from '../../data/column-stream.js';
import {
    countHistogramBins,
    histogramFiniteStats,
    HISTOGRAM_EXACT_QUANTILE_MAX_N,
} from '../../utils/histogram.js';

function abortError() {
    const err = new Error('Histogram cancelled');
    err.name = 'AbortError';
    return err;
}

function growFloat64(buffer, size, extra) {
    if (size + extra <= buffer.length) return buffer;
    let capacity = Math.max(1024, buffer.length);
    while (capacity < size + extra) capacity *= 2;
    const out = new Float64Array(capacity);
    out.set(buffer.subarray(0, size), 0);
    return out;
}

export function installPlotHistogramLazyMethods(TargetClass) {
    const proto = TargetClass.prototype;

/** Whether a trace's file is read lazily. */
proto._isLazyHistogramTrace = function(trace) {
    return !!this.files.get(trace?.fileId)?.data?._duckdb;
};

/** Whether a lazy trace can be histogrammed exactly: its values have SQL of their own. */
proto._lazyHistogramTraceHasSource = function(trace) {
    const data = this.files.get(trace?.fileId)?.data;
    const variable = data?.variables?.[trace?.varName];
    return !!variable && !!data?._duckdb?.source?.hasSqlValue?.(variable);
};

/**
 * One pass over the lazy traces: `visit(trace, values)` for each chunk, with
 * the trace's transformed values in the range. One stream per file.
 *
 * A file whose displayed axis is a row number (a generated index) is read
 * whole, so each row's position is its index in the file; any other is read
 * over the source range the selection maps to, widened a hair so the exact
 * cut is made on the transformed time, as in memory.
 */
proto._lazyHistogramPass = async function(traces, range, visit, { signal = null, onRows = null } = {}) {
    const byFile = new Map();
    for (const trace of traces) {
        if (!byFile.has(trace.fileId)) byFile.set(trace.fileId, []);
        byFile.get(trace.fileId).push(trace);
    }
    let lo = -Infinity;
    let hi = Infinity;
    if (range) {
        [lo, hi] = [Number(range[0]), Number(range[1])];
        if (lo > hi) [lo, hi] = [hi, lo];
    }
    let rowsRead = 0;
    for (const [fileId, fileTraces] of byFile) {
        const data = this.files.get(fileId)?.data;
        if (!data?._duckdb) continue;
        const timeVar = this._getTimeVar(fileId);
        const byRow = this._isGeneratedIndexTime(fileId, timeVar) || this._isGeneratedFromDetectedTime(fileId, timeVar);
        const names = [...new Set(fileTraces.map(trace => trace.varName))];
        const options = { signal };
        if (range && !byRow) {
            const source = this._sourceRangeForDisplayRange(fileId, [lo, hi], timeVar);
            if (source && source.every(Number.isFinite)) {
                let [a, b] = source;
                if (a > b) [a, b] = [b, a];
                const pad = (b - a) * 1e-9 + Math.max(Math.abs(a), Math.abs(b), 1) * 1e-12;
                options.t0 = a - pad;
                options.t1 = b + pad;
            }
        }
        for await (const chunk of streamColumns(data, names, options)) {
            if (signal?.aborted) throw abortError();
            const n = chunk.x.length;
            let rowIndex = null;
            if (byRow) {
                rowIndex = new Float64Array(n);
                for (let i = 0; i < n; i++) rowIndex[i] = chunk.rowStart + i;
            }
            const transformed = this._transformFetchedPhaseTrajectory(fileId, chunk.x, rowIndex, chunk.yByVar, names);
            let keep = null;
            if (range) {
                // The comparison _histogramSamplesForTrace's bounds make on a
                // sorted axis: lo ≤ t ≤ hi.
                const time = transformed.time;
                keep = [];
                for (let i = 0; i < time.length; i++) {
                    const t = time[i];
                    if (t >= lo && t <= hi) keep.push(i);
                }
            }
            for (const trace of fileTraces) {
                let values = transformed.valuesByVar.get(trace.varName);
                if (keep) {
                    const picked = new Float64Array(keep.length);
                    for (let k = 0; k < keep.length; k++) picked[k] = values[keep[k]];
                    values = picked;
                }
                visit(trace, values);
            }
            rowsRead += n;
            onRows?.(rowsRead);
        }
    }
};

/**
 * histogramFiniteStats for each lazy trace, over every row in the range:
 * `Map(trace → { stat, finite })`, `finite` the trace's finite values in order
 * when there are no more than the quartile limit (null past it).
 *
 * `needQuartiles` false skips the stride pass past the limit: the quartiles
 * only choose an automatic bin count.
 */
proto._lazyHistogramStats = async function(traces, range, { needQuartiles = true, signal = null, onRows = null } = {}) {
    const cap = HISTOGRAM_EXACT_QUANTILE_MAX_N;
    const acc = new Map(traces.map(trace => [trace, {
        nScope: 0, nFinite: 0, min: Infinity, max: -Infinity,
        buffer: new Float64Array(1024), size: 0, kept: true,
    }]));
    await this._lazyHistogramPass(traces, range, (trace, values) => {
        const a = acc.get(trace);
        a.nScope += values.length;
        if (a.kept) a.buffer = growFloat64(a.buffer, a.size, values.length);
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (!Number.isFinite(v)) continue;
            a.nFinite++;
            if (v < a.min) a.min = v;
            if (v > a.max) a.max = v;
            if (!a.kept) continue;
            if (a.size === cap) {
                // Past the limit the in-memory kernel samples by stride: the
                // values are no use whole, and not kept.
                a.kept = false;
                a.buffer = null;
                continue;
            }
            a.buffer[a.size++] = v;
        }
    }, { signal, onRows });

    // The stride sample, for an automatic bin count past the limit.
    const sampled = traces.filter(trace => {
        const a = acc.get(trace);
        return needQuartiles && !a.kept && a.nFinite >= 2;
    });
    const samples = new Map();
    if (sampled.length) {
        for (const trace of sampled) {
            const a = acc.get(trace);
            samples.set(trace, { stride: Math.ceil(a.nFinite / cap), seen: 0, values: [] });
        }
        await this._lazyHistogramPass(sampled, range, (trace, values) => {
            const s = samples.get(trace);
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                if (!Number.isFinite(v)) continue;
                if (s.seen % s.stride === 0) s.values.push(v);
                s.seen++;
            }
        }, { signal, onRows });
    }

    const out = new Map();
    for (const trace of traces) {
        const a = acc.get(trace);
        const nInvalid = a.nScope - a.nFinite;
        if (a.nFinite === 0) {
            out.set(trace, {
                stat: { nScope: a.nScope, nFinite: 0, nInvalid, min: NaN, max: NaN, q1: NaN, q3: NaN, quartilesApprox: false },
                finite: null,
            });
            continue;
        }
        const finite = a.kept ? a.buffer.subarray(0, a.size) : null;
        let q1 = NaN;
        let q3 = NaN;
        if (a.nFinite >= 2) {
            // The quartiles of the same sample the in-memory kernel sorts:
            // every finite value, or every stride-th.
            const sample = finite || samples.get(trace)?.values || null;
            if (sample) {
                const quartiles = histogramFiniteStats(sample);
                q1 = quartiles.q1;
                q3 = quartiles.q3;
            }
        }
        out.set(trace, {
            stat: {
                nScope: a.nScope, nFinite: a.nFinite, nInvalid, min: a.min, max: a.max, q1, q3,
                quartilesApprox: !a.kept && a.nFinite >= 2,
            },
            finite,
        });
    }
    return out;
};

/**
 * countHistogramBins for each lazy trace against the shared edges: from the
 * finite values kept by the stats pass when there are, one more pass over the
 * file for the others. `Map(trace → { counts, underflow, overflow, nBinned })`.
 */
proto._lazyHistogramCounts = async function(entries, range, spec, { signal = null, onRows = null } = {}) {
    const out = new Map();
    const streamed = [];
    for (const { trace, finite } of entries) {
        if (finite) out.set(trace, countHistogramBins(finite, spec));
        else streamed.push(trace);
    }
    if (!streamed.length) return out;
    for (const trace of streamed) out.set(trace, { counts: new Float64Array(spec.k), underflow: 0, overflow: 0, nBinned: 0 });
    await this._lazyHistogramPass(streamed, range, (trace, values) => {
        const part = countHistogramBins(values, spec);
        const total = out.get(trace);
        for (let i = 0; i < spec.k; i++) total.counts[i] += part.counts[i];
        total.underflow += part.underflow;
        total.overflow += part.overflow;
        total.nBinned += part.nBinned;
    }, { signal, onRows });
    return out;
};

/** The time extent of a lazy trace's file, transformed as its rows are (_lazyTimeExtent). */
proto._lazyHistogramTimeExtent = function(fileId) {
    return this._lazyTimeExtent(fileId);
};

}
