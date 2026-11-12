// Curve fits of a file in memory-saving (lazy) mode, over every row in the
// range: the 2D pair fit's models with no SQL form (the exponential family)
// and every model of the time-series fit.
//
// Rows few enough to hold (FIT_MAX_LAZY_ROWS) are fetched in one query and
// fitted in memory, as before. Past that the fit is not refused any more: its
// kernel is a sequence of passes over the rows (src/utils/fit-passes.js), and
// each pass here is a stream of the file, a chunk at a time — the rows
// _fetchLazyFitRows would return, transformed and cut the same way. The
// kernel accumulates over the chunks exactly as over arrays, so the fit, its
// metrics and its residuals are the in-memory ones, bit for bit
// (scripts/test-lazy-curve-fit.mjs). The cost is time: one read of the range
// per pass, a handful for the linear models, about twenty for an exponential.
//
// Kept apart from the analyses' own modules (which draw with Plotly) so a test
// can run these methods in Node on a real DuckDB-WASM engine.

import { fitPair, fitSteps, buildFitCurve, predict } from '../../utils/regression.js';
import { runPassesOnChunks } from '../../utils/fit-passes.js';
import { createMinMaxDecimator, decimateMinMax, shiftedTime } from '../curve-fit-state.js';

// The most rows of a lazy file a fit computed outside SQL (the exponential
// family, and the time-series fit) fetches in one piece and fits in memory:
// about two seconds of fitting. Past it the fit streams its passes over the
// rows instead (_streamLazyFit), with the same result.
export const FIT_MAX_LAZY_ROWS = 2000000;
// Past FIT_MAX_LAZY_ROWS, an exponential-family fit of no more rows than this
// keeps them after its second pass (three doubles a row: ~140 MB at the
// limit) and polishes in memory; beyond it, every evaluation of the polish is
// one more read of the range. Same numbers either way, very different times:
// three reads of the file instead of twenty-odd.
export const FIT_KEEP_LAZY_ROWS = 6000000;
// Residual points drawn under the time-series fit's time pane.
export const RESIDUAL_BUCKETS = 2000;

export function installPlotFitLazyMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // Every row of a lazy (DuckDB) file inside a display time range, with the
    // panel's transforms applied — the rows a fit that no SQL aggregate can
    // hold works from. Returns { ok: false, reason: 'tooManyRows' } past
    // FIT_MAX_LAZY_ROWS (never a sample): the caller then streams the fit.
    proto._fetchLazyFitRows = async function(fileId, varNames, displayRange, maxRows = FIT_MAX_LAZY_ROWS) {
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getRawColumnsRange) return { ok: false, reason: 'noSql' };
        const timeVar = this._getTimeVar(fileId);
        const sourceRange = this._sourceRangeForDisplayRange(fileId, displayRange, timeVar);
        if (!sourceRange || !sourceRange.every(Number.isFinite)) return { ok: false, reason: 'undefined' };
        const raw = await source.getRawColumnsRange(data, varNames, sourceRange[0], sourceRange[1], maxRows);
        if (raw.truncated) return { ok: false, reason: 'tooManyRows' };
        const transformed = this._transformFetchedPhaseTrajectory(fileId, raw.x, raw.rowIndex, raw.yByVar, varNames);
        const [lo, hi] = displayRange;
        const keep = [];
        for (let i = 0; i < transformed.time.length; i++) {
            const t = transformed.time[i];
            if (t >= lo && t <= hi) keep.push(i);
        }
        if (keep.length === transformed.time.length) return { ok: true, ...transformed };
        const pick = (arr) => Float64Array.from(keep, i => arr[i]);
        return {
            ok: true,
            time: pick(transformed.time),
            valuesByVar: new Map([...transformed.valuesByVar].map(([name, arr]) => [name, pick(arr)])),
        };
    };

    // The rows _fetchLazyFitRows returns, a chunk at a time and without a cap:
    // the same query (DuckDbSource.streamColumns and getRawColumnsRange share
    // _rawRowsSql), the same transforms and the same cut on the display time.
    // `visit(time, valuesByVar)` is called for each chunk, in file order. For
    // a fit past FIT_MAX_LAZY_ROWS: one call per pass of the fit's kernel
    // (src/utils/fit-passes.js), so no more than a chunk is held at once.
    proto._lazyFitPass = async function(fileId, varNames, displayRange, visit, { signal = null, onRows = null, chunkRows } = {}) {
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.streamColumns) throw Object.assign(new Error('noSql'), { reason: 'noSql' });
        const timeVar = this._getTimeVar(fileId);
        const sourceRange = this._sourceRangeForDisplayRange(fileId, displayRange, timeVar);
        if (!sourceRange || !sourceRange.every(Number.isFinite)) {
            throw Object.assign(new Error('undefined'), { reason: 'undefined' });
        }
        // getRawColumnsRange's row index: the row number for generated time
        // (the stream's t is that number), nothing for a real time column.
        const generated = !!data._duckdb.generatedTime;
        const [lo, hi] = displayRange;
        let rows = 0;
        for await (const chunk of source.streamColumns(data, varNames, { t0: sourceRange[0], t1: sourceRange[1], signal, chunkRows })) {
            const transformed = this._transformFetchedPhaseTrajectory(
                fileId, chunk.x, generated ? chunk.x : null, chunk.yByVar, varNames,
            );
            const keep = [];
            for (let i = 0; i < transformed.time.length; i++) {
                const t = transformed.time[i];
                if (t >= lo && t <= hi) keep.push(i);
            }
            rows += chunk.x.length;
            if (keep.length === transformed.time.length) {
                visit(transformed.time, transformed.valuesByVar);
            } else if (keep.length) {
                const pick = (arr) => Float64Array.from(keep, i => arr[i]);
                visit(pick(transformed.time), new Map([...transformed.valuesByVar].map(([name, arr]) => [name, pick(arr)])));
            }
            onRows?.(rows);
        }
    };

    // A fit of the lazy rows in a range, over every one of them: its kernel's
    // passes (fitSteps), each one a stream of the rows. `toXY(time, byVar)`
    // gives the x/y a chunk is fitted on. Resolves to { fit, nScope } — nScope
    // the rows in the range, as _fetchLazyFitRows' length.
    proto._streamLazyFit = async function(fileId, varNames, displayRange, model, toXY, { signal = null, onProgress = null, chunkRows, keepRows = FIT_KEEP_LAZY_ROWS } = {}) {
        let nScope = 0;
        const fit = await runPassesOnChunks(fitSteps(model, { keepRows }), async (pass, index) => {
            let count = 0;
            await this._lazyFitPass(fileId, varNames, displayRange, (time, byVar) => {
                const [x, y] = toXY(time, byVar);
                pass.chunk(x, y);
                count += time.length;
            }, { signal, chunkRows, onRows: rows => onProgress?.(index + 1, rows) });
            if (index === 0) nScope = count;
        });
        return { fit, nScope };
    };

    // Stops every lazy fit still reading the file for this panel: called when
    // the analysis is closed, so a long streamed fit does not run on unseen.
    // Forgotten too, so reopening the analysis asks for it afresh.
    proto._stopLazyFits = function(plot) {
        if (!plot) return;
        for (const job of plot._curveFitLazyJobs?.values() || []) job.controller?.abort();
        plot._curveFitLazyJobs?.clear();
        plot._phase2dLazyJob?.controller?.abort();
        plot._phase2dLazyJob = null;
    };

    proto._curveFitFromRows = function(plot, entry, trace, range, info, times, values) {
        const t0 = range[0];
        const tPrime = shiftedTime(times, t0, info.scale);
        const fit = fitPair(entry.model, tPrime, values);
        let residual = { x: [], y: [] };
        if (fit?.status === 'ok') {
            const r = new Float64Array(tPrime.length);
            for (let i = 0; i < tPrime.length; i++) {
                const y = Number(values[i]);
                r[i] = Number.isFinite(y) && Number.isFinite(tPrime[i]) ? y - predict(fit, tPrime[i]) : NaN;
            }
            residual = decimateMinMax(times, r, RESIDUAL_BUCKETS);
        }
        return this._curveFitResult(trace, range, info, fit, residual, times.length);
    };

    // What the panes and the drawer draw from, once the fit and its residuals
    // (decimated, in display time) are known — however the rows were read.
    proto._curveFitResult = function(trace, range, info, fit, residual, nScope) {
        const t0 = range[0];
        const timeVar = this._getTimeVar(trace.fileId);
        const toPlot = (arr) => this._plotlyTimeArray(trace.fileId, arr, timeVar);
        let curve = { x: [], y: [], tPrime: [] };
        let drawnResidual = { x: [], y: [] };
        if (fit?.status === 'ok') {
            const sampled = buildFitCurve(fit);
            const t = sampled.x.map(v => t0 + v * info.scale);
            curve = { x: toPlot(t), y: sampled.y, t, tPrime: sampled.x };
            drawnResidual = { x: toPlot(residual.x), y: residual.y };
        }
        return { fit, t0, scale: info.scale, unit: info.unit, calendar: info.calendar, curve, residual: drawnResidual, nScope };
    };

    // A lazy fit past FIT_MAX_LAZY_ROWS: the kernel's passes streamed over
    // every row in the range, then one more pass for the residuals, decimated
    // as they go. Never more than a chunk of rows held; the same numbers as
    // _curveFitFromRows would give on the same rows.
    proto._curveFitStreamed = async function(plot, r, { signal = null, onProgress = null, chunkRows, keepRows } = {}) {
        const { trace, range, info, entry } = r;
        const t0 = range[0];
        const toXY = (time, byVar) => [shiftedTime(time, t0, info.scale), byVar.get(trace.varName) || []];
        const { fit, nScope } = await this._streamLazyFit(trace.fileId, [trace.varName], range, entry.model, toXY, { signal, onProgress, chunkRows, keepRows });
        let residual = { x: [], y: [] };
        if (fit?.status === 'ok') {
            const decimator = createMinMaxDecimator(nScope, RESIDUAL_BUCKETS);
            await this._lazyFitPass(trace.fileId, [trace.varName], range, (time, byVar) => {
                const tPrime = shiftedTime(time, t0, info.scale);
                const values = byVar.get(trace.varName) || [];
                for (let i = 0; i < tPrime.length; i++) {
                    const y = Number(values[i]);
                    decimator.push(time[i], Number.isFinite(y) && Number.isFinite(tPrime[i]) ? y - predict(fit, tPrime[i]) : NaN);
                }
            }, { signal, chunkRows, onRows: rows => onProgress?.('residuals', rows) });
            residual = decimator.result();
        }
        return this._curveFitResult(trace, range, info, fit, residual, nScope);
    };
}
