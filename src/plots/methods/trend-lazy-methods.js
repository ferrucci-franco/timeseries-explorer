// Everything the Trend analysis computes, and the state it computes from —
// but nothing it draws. Kept apart from trend-methods.js (which imports Plotly
// and touches the DOM) so a test can run these methods in Node against a real
// DuckDB-WASM engine, the way fit-lazy-methods.js is
// (scripts/test-lazy-trend.mjs).
//
// A segment's mean, spread, linear trend and quadratic trend come from two
// passes of sums over every row in its range. Three paths, one kernel:
//
//   · a file in memory — the kernel over the arrays (src/utils/trend-fit.js);
//   · a lazy file with a time column of its own — the same sums as ONE
//     aggregate query per pass, for every segment of that file at once
//     (DuckDbSource.getTrendStats), fed to the same assembly and the same
//     solvers. That is what makes dragging a range over a multi-gigabyte file
//     answer in a query instead of a full read into JavaScript; the numbers
//     agree with memory to rounding (docs/any-size-files.md);
//   · a lazy file whose engine has no regression aggregates — the kernel
//     itself streamed over the rows, a chunk at a time, which is exact bit for
//     bit at the cost of reading them.
//
// A lazy file whose time axis is GENERATED from the row number is refused, and
// says so: in memory-saving mode that axis numbers the rows of the overview,
// not of the file, so the stretch the panel shows and the rows the file holds
// at those positions are not the same rows (docs/any-size-files.md).
//
// The exponential trend is per segment and asked for explicitly: it is an
// iterative fit (src/utils/exp-fit.js), so on a lazy file it is a score of
// reads of the range. It runs through the same passes as the Curve Fit
// analysis' exponential (_streamLazyFit), on the rows the value band keeps.
//
// A signal that exists only in a lazy file's overview has no rows to read:
// the segment is refused and says so, rather than reporting the overview's
// numbers as if they were the file's.

import { fitPair, buildFitCurve, predict } from '../../utils/regression.js';
import { runPassesOnArrays, runPassesOnChunks } from '../../utils/fit-passes.js';
import { maskTrendValues, trendDelta, trendSteps } from '../../utils/trend-fit.js';
import { CURVE_FIT_TIME_UNITS, rangeIndices, shiftedTime } from '../curve-fit-state.js';
import {
    defaultTrendSegment,
    defaultTrendState,
    normalizeTrendState,
    trendColor,
    trendSegmentBand,
} from '../trend-state.js';

// Points on a drawn trend curve. The mean and the line need two; a parabola or
// an exponential is sampled like every other fit curve in the app.
export const TREND_CURVE_POINTS = 200;

export function installPlotTrendLazyMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── State ──────────────────────────────────────────────────────
    proto._defaultTrendState = function() {
        return defaultTrendState();
    };

    proto._normalizeTrendState = function(raw = {}) {
        return normalizeTrendState(raw || {});
    };

    proto._ensureTrendState = function(plot) {
        if (!plot) return defaultTrendState();
        const current = plot.trend;
        const normalized = normalizeTrendState(current || {});
        if (current && typeof current === 'object' && !Array.isArray(current)) {
            // Handlers and results hold this object and its segments; keep the
            // identity of both, normalising each segment in place.
            const previous = Array.isArray(current.segments) ? current.segments : [];
            normalized.segments = normalized.segments.map((segment, index) => {
                const old = previous[index];
                if (old && typeof old === 'object' && old.id === segment.id) return Object.assign(old, segment);
                return segment;
            });
            Object.assign(current, normalized);
            return current;
        }
        plot.trend = normalized;
        return normalized;
    };

    proto._trendActiveSegment = function(plot) {
        const state = this._ensureTrendState(plot);
        return state.segments[state.activeSegment] || state.segments[0] || null;
    };

    // The panel trace a segment reads. A segment whose signal left the panel
    // falls back to the first visible one, so it never silently summarises
    // nothing.
    proto._trendTraceFor = function(plot, segment) {
        const traces = plot?.traces || [];
        const own = traces.find(t => t.varName === segment?.varName && t.fileId === segment?.fileId);
        if (own) return own;
        const fallback = traces.find(t => this._isVisible(t)) || traces[0] || null;
        if (fallback && segment) {
            segment.varName = fallback.varName;
            segment.fileId = fallback.fileId;
        }
        return fallback;
    };

    // ── Time axis ─────────────────────────────────────────────────
    // What t′ is measured in: on a calendar axis the chosen unit of the
    // millisecond times, elsewhere the axis's own unit. The Curve Fit
    // analysis' rule and its units table, so a slope reads the same in both.
    proto._trendTimeInfo = function(plot, trace) {
        const state = this._ensureTrendState(plot);
        const calendar = !!trace && this._canonicalFftKind(trace.fileId) === 'datetime';
        if (calendar) {
            return { calendar, scale: CURVE_FIT_TIME_UNITS[state.timeUnit] || 1000, unit: state.timeUnit };
        }
        const unit = trace ? String(this._timeUnitLabel(trace.fileId) || '').trim() : '';
        const shown = unit === 'duration' || unit === 'datetime' ? 's' : (unit === 'index' ? '' : unit);
        return { calendar, scale: 1, unit: shown };
    };

    // ── Domain and ranges ─────────────────────────────────────────
    /**
     * The time a LAZY file really spans, in the panel's display time: the
     * scan's own MIN and MAX (metadata.timeStart/timeEnd), narrowed by a crop.
     *
     * Not the extent of the overview: in memory-saving mode the overview is a
     * reservoir sample, and its first and last rows are not the file's. Taking
     * the domain from it would make "Full" stop short of both ends — the
     * overview deciding what "the whole signal" is, which is exactly what this
     * analysis must not do. Null when the file has no such range (a generated
     * axis, or a scan that failed), and then the overview's extent is used.
     */
    proto._trendLazyDisplayDomain = function(trace) {
        const data = this.files.get(trace?.fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.timeValueSql?.(data)) return null;
        let lo = Number(data.metadata?.timeStart);
        let hi = Number(data.metadata?.timeEnd);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        const crop = this._phaseSourceTimeRange?.(trace.fileId);
        if (crop) {
            lo = Math.max(lo, crop[0]);
            hi = Math.min(hi, crop[1]);
        }
        if (!(hi >= lo)) return null;
        const timeVar = this._getTimeVar(trace.fileId);
        const min = this._displayTimeForFetchedSourceTime(trace.fileId, lo, 0, timeVar);
        const max = this._displayTimeForFetchedSourceTime(trace.fileId, hi, null, timeVar);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        return min <= max ? { min, max } : { min: max, max: min };
    };

    proto._trendDomain = function(plot) {
        const arrays = [];
        let min = Infinity;
        let max = -Infinity;
        for (const trace of plot?.traces || []) {
            const lazy = this._trendLazyDisplayDomain(trace);
            if (lazy) {
                if (lazy.min < min) min = lazy.min;
                if (lazy.max > max) max = lazy.max;
                continue;
            }
            const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
            if (values?.length) arrays.push(values);
        }
        const extent = this._finiteSortedExtent(arrays);
        if (extent) {
            if (extent.min < min) min = extent.min;
            if (extent.max > max) max = extent.max;
        }
        return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    };

    proto._trendTraceDomain = function(trace) {
        if (!trace) return null;
        const lazy = this._trendLazyDisplayDomain(trace);
        if (lazy) return lazy;
        const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const extent = values?.length ? this._finiteSortedExtent([values]) : null;
        return extent ? { min: extent.min, max: extent.max } : null;
    };

    // [lo, hi] of one segment, in the axis's own time.
    proto._trendRange = function(plot, segment) {
        const trace = this._trendTraceFor(plot, segment);
        const domain = this._trendTraceDomain(trace) || this._trendDomain(plot);
        if (!domain) return [0, 1];
        if (segment?.rangeFull) return [domain.min, domain.max];
        let lo = Number(segment?.x1);
        let hi = Number(segment?.x2);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain.min; hi = domain.max; }
        if (lo > hi) [lo, hi] = [hi, lo];
        const panel = this._trendDomain(plot) || domain;
        lo = Math.max(panel.min, Math.min(panel.max, lo));
        hi = Math.max(panel.min, Math.min(panel.max, hi));
        return [lo, hi];
    };

    // ── What a segment is computed from ───────────────────────────
    // Whether a lazy file can serve this signal's rows at all: a signal that
    // lives only in the overview cannot (and must not be summarised from it).
    proto._trendHasLazyRows = function(trace) {
        const data = this.files.get(trace?.fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source) return true;
        const variable = data.variables?.[trace.varName];
        return !!variable && !!source.hasSqlValue?.(variable);
    };

    // Whether the aggregate queries can summarise this file: they filter and
    // shift the file's own time column.
    proto._trendCanAggregate = function(trace) {
        const data = this.files.get(trace?.fileId)?.data;
        const source = data?._duckdb?.source;
        return !!source?.getTrendStats && !!source.timeValueSql?.(data);
    };

    /**
     * Whether a lazy file's time axis is generated from the row number, which
     * this analysis cannot read a stretch of.
     *
     * In memory-saving mode the overview is a reservoir sample renumbered from
     * zero, so the panel's axis counts the overview's rows while the file's
     * rows are numbered 0…N−1. A segment placed on that axis would name one
     * set of rows on screen and another in the file: there is no honest answer
     * to give, so the segment says why instead.
     */
    proto._trendAxisIsGeneratedRowNumber = function(trace) {
        const data = this.files.get(trace?.fileId)?.data;
        if (!data?._duckdb) return false;
        return !!data._duckdb.generatedTime;
    };

    /**
     * The affine map from the file's stored time to this segment's t′, as the
     * aggregate queries need it: t′ = (T − origin) / divisor. The panel's times
     * are the stored ones after the file's transform (time shift, a generated
     * axis' step), so the display range is mapped back the way a saved fit
     * formula maps it (curveFitFormula).
     */
    proto._trendSourcePlan = function(trace, range, info) {
        const timeVar = this._getTimeVar(trace.fileId);
        const source = this._sourceRangeForDisplayRange(trace.fileId, range, timeVar);
        if (!source || !source.every(Number.isFinite)) return null;
        const span = range[1] - range[0];
        const sourceSpan = source[1] - source[0];
        const k = span > 0 && sourceSpan > 0 ? span / sourceSpan : 1;
        return { sourceRange: source, origin: source[0], divisor: info.scale / k };
    };

    // ── In memory ─────────────────────────────────────────────────
    // The rows of a stretch: every sample whose time falls inside [lo, hi],
    // with the panel's transforms applied.
    proto._trendEagerRows = function(trace, range) {
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName) || [];
        const values = this._getTransformedVariableData(trace.fileId, trace.varName) || [];
        const n = Math.min(times.length || 0, values.length || 0);
        const [start, end] = rangeIndices(n === times.length ? times : times.slice(0, n), range[0], range[1]);
        return { times: times.slice(start, end), values: values.slice(start, end) };
    };

    proto._trendFromRows = function(segment, trace, range, info, band, times, values) {
        const tPrime = shiftedTime(times, range[0], info.scale);
        const trend = runPassesOnArrays(trendSteps({ band }), tPrime, values);
        const exp = this._trendExpFromRows(segment, band, tPrime, values);
        return this._trendResult(trace, range, info, band, trend, exp);
    };

    // The exponential of a segment that asked for one, over the rows the band
    // keeps. Null when none was asked for.
    proto._trendExpFromRows = function(segment, band, tPrime, values) {
        const model = segment?.expModel;
        if (!model || model === 'none') return null;
        return fitPair(model, tPrime, maskTrendValues(values, band));
    };

    /**
     * What the table and the panes read, once a segment's numbers are known —
     * however they were computed. The curves are in the panel's own x units,
     * ready to draw, and each is null when its model has nothing to show.
     */
    proto._trendResult = function(trace, range, info, band, trend, exp) {
        const t0 = range[0];
        const timeVar = this._getTimeVar(trace.fileId);
        const toPlot = (arr) => this._plotlyTimeArray(trace.fileId, arr, timeVar);
        // A curve sampled in t′ → the file's display time → the panel's x.
        const curveOf = (tPrime, y) => {
            if (!tPrime?.length) return null;
            const t = Array.from(tPrime, v => t0 + v * info.scale);
            return { x: toPlot(t), y, tPrime, t };
        };
        const span = trend && Number.isFinite(trend.minX) && Number.isFinite(trend.maxX)
            ? [trend.minX, trend.maxX]
            : null;
        const curves = {
            mean: span && Number.isFinite(trend.mean) ? curveOf(span, [trend.mean, trend.mean]) : null,
            linear: null,
            quadratic: null,
            exp: null,
        };
        for (const [name, fit] of [['linear', trend?.linear], ['quadratic', trend?.quadratic], ['exp', exp]]) {
            if (fit?.status !== 'ok') continue;
            const sampled = name === 'linear'
                ? { x: [fit.minX, fit.maxX], y: [predict(fit, fit.minX), predict(fit, fit.maxX)] }
                : buildFitCurve(fit, TREND_CURVE_POINTS);
            curves[name] = curveOf(sampled.x, sampled.y);
        }
        return {
            trend,
            exp: exp || null,
            delta: trendDelta(trend),
            t0,
            scale: info.scale,
            unit: info.unit,
            calendar: info.calendar,
            range: [range[0], range[1]],
            band: band || null,
            curves,
        };
    };

    // ── One result per segment ────────────────────────────────────
    // Eager segments are computed here (and cached by their inputs); the
    // segments of a lazy file are left pending for _refreshTrendLazy.
    proto._computeTrends = function(plot) {
        const state = this._ensureTrendState(plot);
        if (!plot._trendCache) plot._trendCache = new Map();
        const results = [];
        state.segments.forEach((segment, index) => {
            const trace = this._trendTraceFor(plot, segment);
            const color = trendColor(index);
            const base = { segment, index, trace, color, result: null, lazy: false, lazyStatus: null };
            if (!trace || !this._isVisible(trace)) {
                results.push(base);
                return;
            }
            const range = this._trendRange(plot, segment);
            const info = this._trendTimeInfo(plot, trace);
            const band = trendSegmentBand(segment);
            const key = this._trendKey(plot, segment, trace, range, info, band);
            const cached = plot._trendCache.get(segment.id);
            const lazy = !!this.files.get(trace.fileId)?.data?._duckdb;
            if (cached?.key === key && cached.result) {
                results.push({ ...base, result: cached.result, lazy });
                return;
            }
            if (lazy) {
                // Until the new numbers arrive (or after they were cancelled)
                // the previous ones stay on screen — staleResult, never
                // `result`: the table's live row, the CSV and the status line
                // read `result`, which is the answer to what is asked now.
                const sameKey = cached?.key === key;
                const lazyStatus = sameKey ? cached.status : 'pending';
                const staleResult = sameKey ? (cached.previous || null) : (cached?.result || cached?.previous || null);
                results.push({ ...base, lazy: true, lazyStatus, key, range, info, band, staleResult });
                return;
            }
            const rows = this._trendEagerRows(trace, range);
            const result = this._trendFromRows(segment, trace, range, info, band, rows.times, rows.values);
            plot._trendCache.set(segment.id, { key, result, status: 'ok' });
            results.push({ ...base, result });
        });
        plot._trendResults = results;
        return results;
    };

    // The identity of one segment's numbers: everything they are computed from.
    proto._trendKey = function(plot, segment, trace, range, info, band) {
        const token = this._fftDataToken?.(trace.fileId) ?? '';
        return [
            trace.fileId, trace.varName, range[0], range[1], info.scale,
            band ? `${band.lower}:${band.upper}` : '-',
            segment.expModel || 'none',
            token,
        ].join('\u0000');
    };

    // ── A lazy file ───────────────────────────────────────────────
    /**
     * The segments of lazy files, computed and painted as they arrive. One job
     * per segment under the key it was asked for, so a refresh that asks for
     * the same thing lets the work finish (a scan of a large file takes as long
     * as it takes, and a panel refreshes for many reasons), while a segment
     * that now wants something else is dropped.
     *
     * The segments of one file that can be aggregated share a job: their sums
     * are two queries for all of them, whatever their ranges.
     */
    proto._refreshTrendLazy = async function(panelId, plot, results) {
        // A segment cancelled from the pill waits for its inputs to change.
        const pending = (results || []).filter(r => r.lazy && !r.result && r.key && r.lazyStatus !== 'cancelled');
        if (!plot._trendLazyJobs) plot._trendLazyJobs = new Map();
        const jobs = plot._trendLazyJobs;
        const wanted = new Map(pending.map(r => [r.segment.id, r.key]));
        for (const [id, job] of jobs) {
            if (wanted.get(id) === job.key) continue;
            job.controller?.abort();
            jobs.delete(id);
        }
        const fresh = pending.filter(r => !jobs.has(r.segment.id));
        if (!fresh.length) return;

        // A lazy file whose axis is the row number must be counted before its
        // domain can be told — a CSV opened as a view is not counted when it
        // loads, and without the count the overview's samples (and the file's
        // last row) sit at the wrong positions, which would make "Full" the
        // first few hundred rows. Counted once, then this pass runs again.
        const uncounted = [...new Set(fresh.map(r => r.trace?.fileId))]
            .filter(fileId => this._needsLazyRowCount?.(fileId));
        if (uncounted.length) {
            await Promise.all(uncounted.map(fileId => this._ensureLazyRowCount(fileId)));
            this._afterTrendLazyJob?.(panelId, plot, { again: true });
            return;
        }

        // What cannot be read from the file is refused, not answered from the
        // overview: a signal that only exists there, and a file whose time axis
        // numbers the overview's rows rather than the file's.
        const refused = [];
        const readable = [];
        for (const r of fresh) {
            if (!this._trendHasLazyRows(r.trace)) refused.push([r, 'unsupported']);
            else if (this._trendAxisIsGeneratedRowNumber(r.trace)) refused.push([r, 'generatedAxis']);
            else readable.push(r);
        }
        for (const [r, status] of refused) {
            plot._trendCache.set(r.segment.id, { key: r.key, result: null, status });
        }
        if (refused.length) this._afterTrendLazyJob?.(panelId, plot);
        if (!readable.length) return;

        const batches = [];
        const byFile = new Map();
        for (const r of readable) {
            if (!this._trendCanAggregate(r.trace)) {
                batches.push({ kind: 'stream', items: [r] });
                continue;
            }
            const key = r.trace.fileId;
            if (!byFile.has(key)) {
                const batch = { kind: 'sql', fileId: key, items: [] };
                byFile.set(key, batch);
                batches.push(batch);
            }
            byFile.get(key).items.push(r);
        }

        for (const batch of batches) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            for (const r of batch.items) jobs.set(r.segment.id, { key: r.key, controller });
        }
        await Promise.all(batches.map(batch => this._runTrendLazyBatch(panelId, plot, batch)));
    };

    // One batch: the aggregate queries of a file's segments, or one streamed
    // segment. Settles every segment of the batch (a result, or a status) and
    // repaints.
    proto._runTrendLazyBatch = async function(panelId, plot, batch) {
        const jobs = plot._trendLazyJobs;
        const first = batch.items[0];
        const job = jobs?.get(first.segment.id);
        const signal = job?.controller?.signal || null;
        const current = (r) => jobs?.get(r.segment.id)?.key === r.key;
        const settle = (r, entry) => {
            if (!current(r)) return;
            jobs.delete(r.segment.id);
            plot._trendCache.set(r.segment.id, entry);
        };
        try {
            if (batch.kind === 'sql') await this._runTrendSqlBatch(plot, batch, signal, settle);
            else await this._runTrendStreamBatch(plot, batch, signal, settle);
        } catch (err) {
            if (err?.name === 'AbortError') {
                // An abort this batch did not ask for (a shared cached query
                // cancelled by another panel) means: ask again.
                if (this._isForeignAbort?.(err, signal)) {
                    for (const r of batch.items) if (current(r)) jobs.delete(r.segment.id);
                    this._afterTrendLazyJob?.(panelId, plot, { again: true });
                }
                return;
            }
            console.warn('[trend] lazy query failed:', err);
            for (const r of batch.items) settle(r, { key: r.key, result: null, status: 'error', previous: r.staleResult || null });
        }
        this._afterTrendLazyJob?.(panelId, plot);
    };

    // The aggregate path: two queries for every segment of the file, then the
    // exponential of each segment that asked for one.
    proto._runTrendSqlBatch = async function(plot, batch, signal, settle) {
        const items = batch.items;
        const data = this.files.get(batch.fileId)?.data;
        const source = data?._duckdb?.source;
        const transform = this._fileTransform(batch.fileId);
        const plans = items.map(r => this._trendSourcePlan(r.trace, r.range, r.info));
        const segments = items.map((r, i) => (plans[i] ? {
            varName: r.trace.varName,
            sign: this.isVariableSignInverted?.(r.trace.fileId, r.trace.varName) ? -1 : 1,
            sourceRange: plans[i].sourceRange,
            origin: plans[i].origin,
            divisor: plans[i].divisor,
            band: r.band,
            quadratic: true,
        } : null));
        const asked = segments.filter(Boolean);
        if (!asked.length) {
            for (const r of items) settle(r, { key: r.key, result: null, status: 'error', previous: r.staleResult || null });
            return;
        }
        this._setTrendProgress?.(plot, 'sums', items.length);
        const stats = await source.getTrendStats(data, asked, {
            gain: Number(transform.gain),
            yOffset: Number(transform.yOffset),
            signal,
        });
        let k = 0;
        const byItem = items.map((r, i) => (segments[i] ? stats[k++] : { status: 'noSql' }));
        for (let i = 0; i < items.length; i++) {
            const r = items[i];
            const stat = byItem[i];
            // An engine without the regression aggregates: the kernel over the
            // rows instead, which is exact and only slower.
            if (stat?.status === 'noRegr') {
                await this._runTrendStreamBatch(plot, { kind: 'stream', items: [r] }, signal, settle);
                continue;
            }
            if (stat?.status !== 'ok') {
                settle(r, { key: r.key, result: null, status: 'error', previous: r.staleResult || null });
                continue;
            }
            let exp = null;
            if (r.segment.expModel && r.segment.expModel !== 'none') {
                exp = await this._trendLazyExpFit(plot, r, { signal });
            }
            settle(r, { key: r.key, result: this._trendResult(r.trace, r.range, r.info, r.band, stat.trend, exp), status: 'ok' });
        }
    };

    // The streamed path (a generated time axis): the kernel itself over the
    // file's rows, a chunk at a time — exact, at the cost of reading them.
    proto._runTrendStreamBatch = async function(plot, batch, signal, settle) {
        const r = batch.items[0];
        const trend = await this._streamLazyTrend(plot, r, { signal });
        let exp = null;
        if (r.segment.expModel && r.segment.expModel !== 'none') {
            exp = await this._trendLazyExpFit(plot, r, { signal });
        }
        settle(r, { key: r.key, result: this._trendResult(r.trace, r.range, r.info, r.band, trend, exp), status: 'ok' });
    };

    /**
     * The trend kernel over the rows of a lazy file, streamed: each pass is one
     * read of the range (the rows _fetchLazyFitRows would return, transformed
     * and cut the same way), and the kernel accumulates over the chunks exactly
     * as over arrays — so the result is the in-memory one, bit for bit.
     */
    proto._streamLazyTrend = async function(plot, r, { signal = null, chunkRows } = {}) {
        const { trace, range, info, band } = r;
        const t0 = range[0];
        return runPassesOnChunks(trendSteps({ band }), async (pass, index) => {
            await this._lazyFitPass(trace.fileId, [trace.varName], range, (time, byVar) => {
                pass.chunk(shiftedTime(time, t0, info.scale), byVar.get(trace.varName) || []);
            }, {
                signal,
                chunkRows,
                onRows: rows => this._setTrendProgress?.(plot, 'stream', rows, index + 1),
            });
        });
    };

    // The exponential of a segment of a lazy file: the rows in one piece when
    // they are few enough, streamed pass by pass when they are not — the Curve
    // Fit analysis' own paths, over the rows the band keeps.
    proto._trendLazyExpFit = async function(plot, r, { signal = null } = {}) {
        const { trace, range, info, band, segment } = r;
        const t0 = range[0];
        const rows = await this._fetchLazyFitRows(trace.fileId, [trace.varName], range, undefined, signal);
        if (rows.ok) {
            const tPrime = shiftedTime(rows.time, t0, info.scale);
            return fitPair(segment.expModel, tPrime, maskTrendValues(rows.valuesByVar.get(trace.varName) || [], band));
        }
        if (rows.reason !== 'tooManyRows') return null;
        const toXY = (time, byVar) => [
            shiftedTime(time, t0, info.scale),
            maskTrendValues(byVar.get(trace.varName) || [], band),
        ];
        const { fit } = await this._streamLazyFit(trace.fileId, [trace.varName], range, segment.expModel, toXY, {
            signal,
            onProgress: (pass, read) => this._setTrendProgress?.(plot, 'exp', read, pass),
        });
        return fit;
    };

    // Cancel from the pill: every segment still pending is kept as cancelled
    // under the key it was asked for (so a refresh does not start it again),
    // with the numbers shown before it, which stay on screen.
    proto._markTrendsCancelled = function(plot) {
        if (!plot?._trendCache) return;
        for (const r of plot._trendResults || []) {
            if (!r.lazy || r.result || !r.key || r.lazyStatus !== 'pending') continue;
            plot._trendCache.set(r.segment.id, { key: r.key, result: null, status: 'cancelled', previous: r.staleResult || null });
            r.lazyStatus = 'cancelled';
        }
    };

    // After Cancel put the previous settings back: each cancelled segment's
    // previous result is the result of those settings again, under their key,
    // so it is shown as current and no refresh asks for it a second time.
    proto._rekeyTrendsAfterRestore = function(plot) {
        const state = this._ensureTrendState(plot);
        for (const segment of state.segments || []) {
            const cached = plot._trendCache?.get(segment.id);
            if (cached?.status !== 'cancelled' || !cached.previous) continue;
            const trace = this._trendTraceFor(plot, segment);
            if (!trace) continue;
            const range = this._trendRange(plot, segment);
            const info = this._trendTimeInfo(plot, trace);
            const band = trendSegmentBand(segment);
            plot._trendCache.set(segment.id, {
                key: this._trendKey(plot, segment, trace, range, info, band),
                result: cached.previous,
                status: 'ok',
            });
        }
    };

    // Stops every lazy segment still reading a file for this panel: called when
    // the analysis is closed, so a long scan does not run on unseen. Forgotten
    // too, so reopening the analysis asks for it afresh.
    proto._stopLazyTrends = function(plot) {
        if (!plot) return;
        for (const job of plot._trendLazyJobs?.values() || []) job.controller?.abort();
        plot._trendLazyJobs?.clear();
    };

    // A fresh segment, seeded from the active one's signal.
    proto._newTrendSegment = function(plot) {
        const current = this._trendActiveSegment(plot);
        return defaultTrendSegment({
            fileId: current?.fileId ?? null,
            varName: current?.varName ?? null,
        });
    };
}
