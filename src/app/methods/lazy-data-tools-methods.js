// Data Tools on a file in memory-saving (lazy) mode, beyond hard bounds.
//
// The derivative, the cumulative integral, the IQR outlier filter and the
// polynomial / first-sample detrend become SQL over the file
// (src/data/lazy-tool-sql.js): their output is
// a variable with `_duckdbExpr` — like a translated formula — so every lazy
// consumer reads it over the whole file at full resolution. What the SQL cannot
// know by itself (quartiles, a fitted polynomial, the first finite sample, the
// time axis's nominal step) is
// computed once, with aggregate passes over the file, and kept on the
// definition as `lazyStats`, tagged with the source it was computed from.
//
// Hard bounds keep their original path (`_duckdbDataTool`, data-tools-methods.js).
//
// The moving average (and the moving-average detrend) has no SQL form: its
// kernel runs over the file a chunk at a time (src/data/chunk-executor.js) and
// writes its output to a sink, a table as long as the file, that the variable
// reads (`definition.lazySink`). The run is a job behind an overlay with
// progress and Cancel; a session keeps the definition and runs it again.

import i18n from '../../i18n/index.js';
import { runChunkedJob } from '../../data/chunk-executor.js';
import { createMovingAverage } from '../../compute/kernels/moving-average.js';
import { createForwardFilter, createZeroPhaseFilter } from '../../compute/kernels/iir.js';
import {
    derivativeWindows,
    detrendAnchorSql,
    detrendPolynomialSql,
    doubleLiteral,
    integralWindows,
    iqrOutlierSql,
    mergeWindows,
    quoteIdent,
    rowIndexWindow,
    windowColumn,
} from '../../data/lazy-tool-sql.js';
import {
    GAP_STEP_MIN_AGREEMENT,
    GAP_STEP_MIN_SAMPLES,
    GAP_STEP_TOLERANCE,
    GAP_THRESHOLD_FACTOR,
} from '../../utils/sampling-gaps.js';
import {
    createMovingAverageDetrend,
    DETREND_METHODS,
    detrendRequestedOrder,
    detrendScale,
    solveDetrendFit,
} from '../../compute/kernels/detrend.js';
import { iqrFences, interpolatedQuantile } from '../../compute/kernels/outliers.js';

// Detrend methods the lazy path computes as SQL. The moving-average baseline,
// a centred window of arbitrary width, runs in the chunked executor.
const LAZY_SQL_DETREND_METHODS = new Set(['mean', 'linear', 'polynomial', 'firstSample']);
// Every detrend method a lazy file offers.
export const LAZY_DETREND_METHODS = new Set([...LAZY_SQL_DETREND_METHODS, 'movingAverage']);
// A stretch of a zero-phase filter up to this many samples is filtered in
// memory; a longer one in two passes over the file (createZeroPhaseFilter).
export const LAZY_FILTER_MEMORY_ROWS = 1 << 20;

export function installLazyDataToolsMethods(TargetClass) {
    const proto = TargetClass.prototype;

// Whether the lazy SQL path computes this configuration (hard bounds aside).
proto._isLazySqlToolConfig = function(config) {
    if (!config) return false;
    if (config.tool === 'derivative') return true;
    // Bridging a hole ('interpolate') needs the next finite sample: a look
    // ahead a streaming window cannot make.
    if (config.tool === 'integrate') return (config.params?.gapPolicy || 'zero') !== 'interpolate';
    if (config.tool === 'removeOutliers') return config.method === 'iqr';
    if (config.tool === 'detrend') {
        const method = config.params?.method ?? config.method;
        return DETREND_METHODS.has(method) && LAZY_SQL_DETREND_METHODS.has(method);
    }
    return false;
};

// Whether the chunked executor computes this configuration into a sink.
proto._isLazySinkToolConfig = function(config) {
    if (!config) return false;
    if (config.tool === 'movingAverage' || config.tool === 'filter') return true;
    if (config.tool === 'detrend') return (config.params?.method ?? config.method) === 'movingAverage';
    return false;
};

// The time axis as the kernels read it (_getDataToolTimeContext): its kind, and
// its values as SQL — null when the kernel counts samples instead.
proto._lazyToolTimeAxis = function(data) {
    const context = this._getDataToolTimeContext(data, NaN);
    const timeSql = data?._duckdb?.source?.timeValueSql?.(data) || null;
    const kind = !timeSql ? 'index' : context.kind;
    return { kind, timeSql: kind === 'index' ? null : timeSql };
};

// What a tool's statistics depend on, as text: the source's SQL (which names
// every window it is built on), the time axis, and the rows — a reload is a new
// table, a live update appends rows.
proto._lazyToolSourceSignature = function(data, sourceName) {
    const meta = data?._duckdb;
    const source = meta?.source;
    const variable = data?.variables?.[sourceName];
    if (!source || !variable || !source.hasSqlValue(variable)) return null;
    const axis = this._lazyToolTimeAxis(data);
    return JSON.stringify([
        source._valueExpressionSql(variable, sourceName, { castDouble: true }),
        axis.kind,
        axis.timeSql,
        meta.tableName,
        Number(meta.appendRows) || 0,
    ]);
};

// The passes a tool needs before its SQL can be written.
proto._computeLazyToolStats = async function(data, definition) {
    const source = data._duckdb.source;
    const { sourceName, tool, params = {} } = definition;
    const signature = this._lazyToolSourceSignature(data, sourceName);
    if (tool === 'derivative') return { signature };
    if (tool === 'integrate') return { signature, ...await this._lazyIntegralStats(data, definition) };

    if (tool === 'removeOutliers') {
        // The ranks the kernel's interpolated quartiles read, then those values.
        const ranksFor = (count) => {
            const ranks = [];
            if (count >= 4) for (const p of [0.25, 0.75]) interpolatedQuantile(count, p, r => { ranks.push(r); return 0; });
            return ranks;
        };
        const { n, values } = await source.exactOrderStatistics(data, sourceName, ranksFor);
        if (n < 4) throw new Error(i18n.t('outlierNotEnoughData'));
        const q1 = interpolatedQuantile(n, 0.25, r => values.get(r));
        const q3 = interpolatedQuantile(n, 0.75, r => values.get(r));
        const { low, high } = iqrFences(q1, q3, params);
        const count = await source.countOutsideRange(data, sourceName, low, high);
        return { signature, low, high, count };
    }

    // Detrend.
    const method = params.method;
    if (method === 'firstSample') {
        return { signature, anchor: await source.firstFiniteValue(data, sourceName) };
    }
    const axis = this._lazyToolTimeAxis(data);
    const rowIndex = axis.timeSql ? null : rowIndexWindow();
    const sums = await source.detrendSums(data, sourceName, {
        xSql: rowIndex ? quoteIdent(rowIndex.column) : axis.timeSql,
        xWindows: rowIndex ? [rowIndex] : [],
        scale: detrendScale,
        orderFor: fitPoints => detrendRequestedOrder(params, fitPoints),
    });
    const usedTimeAxis = !!axis.timeSql;
    if (!sums.fitPoints) return { signature, passThrough: true, fitPoints: 0, order: sums.order, usedTimeAxis };
    const { mid, half } = detrendScale(sums.min, sums.max);
    const { order, coefficients } = solveDetrendFit(sums.powerSums, sums.rhs, sums.order);
    if (!coefficients) return { signature, passThrough: true, fitPoints: sums.fitPoints, order, usedTimeAxis };
    let slope = null;
    if (order >= 1) {
        const perX = coefficients[1] / half;
        slope = axis.kind === 'datetime' ? perX * 1000 : perX;
    }
    return { signature, mid, half, coefficients, order, fitPoints: sums.fitPoints, slope, usedTimeAxis };
};

// detectSamplingGaps (src/utils/sampling-gaps.js) over the whole time axis:
// the nominal step is the median positive step, it holds when at least 80 % of
// the steps agree with it to 10 %, and a step above 1.5 of it is a gap. The
// median is an exact order statistic, so the step and the threshold are the
// kernel's. Returns what detectSamplingGaps returns that a tool reads —
// `{ medianDt, hasNominalStep, reason, count, totalMissing }` — with the same
// reasons when there is no nominal step.
proto._lazyStepStats = async function(data, timeSql, timeWindows = [], { signal } = {}) {
    const source = data._duckdb.source;
    const time = windowColumn(timeSql, timeWindows);
    const t = quoteIdent(time.column);
    const step = windowColumn(`CASE WHEN LAG(TRUE, 1, FALSE) OVER () THEN ${t} - LAG(${t}) OVER () END`, [...timeWindows, time]);
    const d = quoteIdent(step.column);
    const pass = source.passSql(data, [{ _duckdbWindows: mergeWindows(timeWindows, [time, step]) }], `CASE WHEN ${d} > 0 THEN ${d} END`);
    const none = (reason, medianDt = NaN) => ({ medianDt, hasNominalStep: false, reason, count: 0, totalMissing: 0 });
    const counts = await source.aggregateOver(pass, [
        'COUNT(*)::BIGINT AS n',
        `COUNT(*) FILTER (WHERE ${d} < 0 AND isfinite(${d}))::BIGINT AS neg`,
        `COUNT(*) FILTER (WHERE ${d} > 0 AND isfinite(${d}))::BIGINT AS pos`,
    ].join(', '), { signal });
    if (counts.n < 3) return none('tooFewSamples');
    if (counts.neg > 0) return none('nonMonotonic');
    if (counts.pos < 2) return none('tooFewSamples');
    const mid = counts.pos >> 1;
    const ranks = counts.pos % 2 ? [mid] : [mid - 1, mid];
    const { values } = await source.exactOrderStatisticsOver(pass, ranks, { signal });
    const median = counts.pos % 2 ? values.get(mid) : (values.get(mid - 1) + values.get(mid)) / 2;
    if (!Number.isFinite(median) || median <= 0) return none('irregularStep', median);
    const band = median * GAP_STEP_TOLERANCE;
    const threshold = median * GAP_THRESHOLD_FACTOR;
    const { agree, gaps, missing } = await source.aggregateOver(pass, [
        `COUNT(*) FILTER (WHERE ${d} > 0 AND isfinite(${d}) AND abs(${d} - ${doubleLiteral(median)}) <= ${doubleLiteral(band)})::BIGINT AS agree`,
        // A gap counts its missing samples as the kernel does: the steps it
        // spans, less one, at least one.
        `COUNT(*) FILTER (WHERE ${d} > ${doubleLiteral(threshold)})::BIGINT AS gaps`,
        `COALESCE(SUM(GREATEST(1, round(${d} / ${doubleLiteral(median)}) - 1)) FILTER (WHERE ${d} > ${doubleLiteral(threshold)}), 0) AS missing`,
    ].join(', '), { signal });
    if (counts.pos >= GAP_STEP_MIN_SAMPLES && agree / counts.pos < GAP_STEP_MIN_AGREEMENT) return none('irregularStep', median);
    return { medianDt: median, hasNominalStep: true, reason: null, count: gaps, totalMissing: missing };
};

// The integral's gap threshold: 1.5 × the nominal step, when there is one.
proto._lazySamplingGapThreshold = async function(data, timeSql, timeWindows = []) {
    const steps = await this._lazyStepStats(data, timeSql, timeWindows);
    return steps.hasNominalStep
        ? { gapThreshold: steps.medianDt * GAP_THRESHOLD_FACTOR, hasNominalStep: true }
        : { gapThreshold: null, hasNominalStep: false };
};

// The step of a lazy file's time axis, measured over the whole file — the
// overview in memory is a sample of the rows, and its spacing says nothing
// about the file's. `{ timed, medianDt, hasNominalStep, reason, count,
// totalMissing }`; `timed` is false for an index axis (a generated one, or
// one the user reads in samples), which has no step to measure. Measured once
// per file and axis: a reload is a new table, rows appended live a new count.
proto._lazyAxisSteps = async function(data, { signal } = {}) {
    const axis = this._lazyToolTimeAxis(data);
    if (!axis.timeSql) return { timed: false, medianDt: NaN, hasNominalStep: false, reason: 'noTimeAxis', count: 0, totalMissing: 0 };
    const key = this._lazyAxisStepsKey(data, axis);
    if (!this._lazyAxisStepCache) this._lazyAxisStepCache = new Map();
    const cached = this._lazyAxisStepCache.get(key);
    if (cached) return cached;
    const steps = { timed: true, ...await this._lazyStepStats(data, axis.timeSql, [], { signal }) };
    this._lazyAxisStepCache.set(key, steps);
    while (this._lazyAxisStepCache.size > 8) this._lazyAxisStepCache.delete(this._lazyAxisStepCache.keys().next().value);
    return steps;
};

proto._lazyAxisStepsKey = function(data, axis) {
    const meta = data._duckdb;
    return JSON.stringify([meta.tableName, Number(meta.appendRows) || 0, axis.kind, axis.timeSql]);
};

// The same, for a panel that cannot wait: the measurement when there is one;
// otherwise null, with the measurement started in the background and the
// panel synced again when it is in.
proto._lazyAxisStepsNow = function(data) {
    const axis = this._lazyToolTimeAxis(data);
    if (!axis.timeSql) return { timed: false, medianDt: NaN, hasNominalStep: false, reason: 'noTimeAxis', count: 0, totalMissing: 0 };
    const key = this._lazyAxisStepsKey(data, axis);
    const cached = this._lazyAxisStepCache?.get(key);
    if (cached) return cached;
    if (!this._lazyAxisStepRuns) this._lazyAxisStepRuns = new Map();
    if (!this._lazyAxisStepRuns.has(key)) {
        const run = this._lazyAxisSteps(data)
            .then(() => this._syncDataTools?.())
            .catch(err => console.warn('[duckdb] could not measure the time axis:', err?.message || err))
            .finally(() => this._lazyAxisStepRuns.delete(key));
        this._lazyAxisStepRuns.set(key, run);
    }
    return null;
};

// The integral's gap threshold, and what the panel reports about the holes
// (_integralWarning): the counts computeIntegral returns.
proto._lazyIntegralStats = async function(data, definition) {
    const source = data._duckdb.source;
    const { sourceName, params = {} } = definition;
    const sourceVariable = data.variables[sourceName];
    const valueSql = source._valueExpressionSql(sourceVariable, sourceName, { castDouble: true });
    const sourceWindows = sourceVariable._duckdbWindows || [];
    if (params.method === 'sum') {
        // The running sum never reads time: its holes are non-finite samples,
        // counted as samples.
        const pass = source.passSql(data, [sourceVariable], valueSql);
        const { holes } = await source.aggregateOver(pass,
            `COUNT(*) FILTER (WHERE NOT COALESCE(isfinite(${valueSql}), FALSE))::BIGINT AS holes`);
        return {
            gapThreshold: null, hasNominalStep: false, negativeDtCount: 0, gapCount: 0,
            nanSegmentCount: holes, uncoveredTime: holes, timeKind: 'index',
        };
    }
    const axis = this._lazyToolTimeAxis(data);
    const gaps = axis.timeSql && axis.kind !== 'index' && params.detectGaps !== false
        ? await this._lazySamplingGapThreshold(data, axis.timeSql)
        : { gapThreshold: null, hasNominalStep: false };
    const built = integralWindows(valueSql, axis.timeSql, {
        kind: axis.kind, method: params.method, policy: params.gapPolicy, initial: params.initial,
        gapThreshold: gaps.gapThreshold, deps: sourceWindows,
    });
    const { dt, missing, unusable } = built.steps;
    const q = (window) => quoteIdent(window.column);
    const pass = source.passSql(data, [{ _duckdbWindows: mergeWindows(built.windows, [dt, missing, unusable]) }], q(dt));
    const counts = await source.aggregateOver(pass, [
        `COUNT(*) FILTER (WHERE ${q(dt)} < 0)::BIGINT AS neg`,
        `COUNT(*) FILTER (WHERE ${q(missing)})::BIGINT AS gaps`,
        `COUNT(*) FILTER (WHERE ${q(unusable)})::BIGINT AS holes`,
        `COALESCE(SUM(${q(dt)}) FILTER (WHERE ${q(missing)} OR ${q(unusable)}), 0) AS uncovered`,
    ].join(', '));
    return {
        ...gaps,
        negativeDtCount: counts.neg,
        gapCount: counts.gaps,
        nanSegmentCount: counts.holes,
        uncoveredTime: counts.uncovered,
        timeKind: axis.kind,
    };
};

// The output variable, from the definition and its statistics — or, for a tool
// the chunked executor runs, its sink. Null while the source has no SQL of its
// own (a formula not restored yet). Without statistics or a sink yet the
// variable exists with no SQL, and its overview is empty.
proto._lazySqlToolVariable = function(data, name, definition) {
    const source = data?._duckdb?.source;
    const sourceName = definition.sourceName;
    const sourceVariable = data?.variables?.[sourceName];
    if (!source || !sourceVariable || !source.hasSqlValue(sourceVariable)) return null;
    const sink = this._isLazySinkToolConfig(definition) ? definition.lazySink || null : null;
    const stats = definition.lazyStats || sink;
    const valueSql = source._valueExpressionSql(sourceVariable, sourceName, { castDouble: true });
    const sourceWindows = sourceVariable._duckdbWindows || [];

    let expr = null;
    let windows = sourceWindows;
    if (this._isLazySinkToolConfig(definition)) {
        // The output is in the sink: nothing of the source's SQL is needed to
        // read it.
        windows = [];
        if (sink?.column) {
            expr = quoteIdent(sink.column.column);
            windows = [sink.column];
        }
    } else if (definition.tool === 'derivative') {
        const axis = this._lazyToolTimeAxis(data);
        const built = derivativeWindows(valueSql, axis.timeSql, {
            kind: axis.kind,
            method: definition.params?.method || 'centered',
            deps: sourceWindows,
        });
        expr = quoteIdent(built.column.column);
        windows = built.windows;
    } else if (stats) {
        if (definition.tool === 'integrate') {
            const axis = this._lazyToolTimeAxis(data);
            const params = definition.params || {};
            const built = integralWindows(valueSql, axis.timeSql, {
                kind: axis.kind, method: params.method, policy: params.gapPolicy, initial: params.initial,
                gapThreshold: stats.gapThreshold, deps: sourceWindows,
            });
            expr = quoteIdent(built.column.column);
            windows = built.windows;
        } else if (definition.tool === 'removeOutliers') {
            expr = iqrOutlierSql(valueSql, stats.low, stats.high);
        } else if (definition.params?.method === 'firstSample') {
            expr = detrendAnchorSql(valueSql, stats.anchor);
        } else if (stats.passThrough) {
            expr = valueSql;
        } else {
            const axis = this._lazyToolTimeAxis(data);
            let xSql = axis.timeSql;
            if (!xSql) {
                const rowIndex = rowIndexWindow();
                xSql = quoteIdent(rowIndex.column);
                windows = mergeWindows(sourceWindows, [rowIndex]);
            }
            expr = detrendPolynomialSql(valueSql, xSql, stats);
        }
    }

    const timeName = data.metadata?.timeName;
    const overviewLength = data.variables?.[timeName]?.data?.length ?? sourceVariable.data?.length ?? 0;
    const variable = {
        ...sourceVariable,
        name,
        displayName: name,
        // The overview is refilled by refreshOverview once the SQL is in place.
        data: new Float64Array(overviewLength).fill(NaN),
        description: this._dataToolDescription({ ...definition, targetName: name, targetMode: 'create' }),
        kind: 'variable',
        isConstant: false,
        interpolation: sourceVariable.interpolation || 'linear',
        derived: true,
        dataToolModified: false,
        dataTool: {
            tool: definition.tool,
            sourceName,
            targetMode: 'create',
            method: definition.method || definition.params?.method || null,
            params: this._cloneDataToolParams(definition.params),
            ...(definition.tool === 'removeOutliers'
                ? { replacement: 'nan', outlierCount: stats?.count ?? null }
                : {}),
            ...(definition.tool === 'movingAverage' ? { window: definition.params?.window } : {}),
            ...(definition.tool === 'filter' ? this._lazyFilterDataTool(definition.params || {}, sink?.report) : {}),
            ...(definition.tool === 'detrend'
                ? { order: stats?.order ?? null, slope: stats?.slope ?? null, fitPoints: stats?.fitPoints ?? null }
                : {}),
            ...(definition.tool === 'integrate'
                ? {
                    method: definition.params?.method,
                    gapPolicy: definition.params?.gapPolicy,
                    initial: definition.params?.initial,
                    negativeDtCount: stats?.negativeDtCount ?? null,
                    gapCount: stats?.gapCount ?? null,
                    nanSegmentCount: stats?.nanSegmentCount ?? null,
                    uncoveredTime: stats?.uncoveredTime ?? null,
                    hasNominalStep: stats?.hasNominalStep ?? false,
                }
                : {}),
        },
    };
    delete variable._duckdbCol;
    delete variable._duckdbDataTool;
    delete variable._duckdbExpr;
    delete variable._duckdbWindows;
    delete variable.formula;
    if (expr) {
        variable._duckdbExpr = expr;
        if (windows.length) variable._duckdbWindows = windows;
    }
    return variable;
};

proto._applyLazySqlToolCreateMode = async function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const existing = data.variables[outputName];
    const existingDefinition = definitions?.get(outputName);
    if (existing && !existingDefinition) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
    if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));
    if (!data._duckdb?.source?.hasSqlValue(sourceVariable)) throw new Error(i18n.t('dataToolLazyDisabled'));

    const definition = {
        name: outputName,
        tool,
        targetMode: 'create',
        sourceName,
        method: config.method || null,
        params: this._cloneDataToolParams(config.params),
        replacement: tool === 'removeOutliers' ? 'nan' : '',
    };
    definition.lazyStats = await this._computeLazyToolStats(data, definition);
    const variable = this._lazySqlToolVariable(data, outputName, definition);
    if (!variable?._duckdbExpr) throw new Error(i18n.t('dataToolLazyDisabled'));
    data.variables[outputName] = variable;
    this._storeDataToolDefinition(fileId, outputName, { ...definition, variable });
    // What is built on this output embeds its SQL: rebuild it.
    const dependents = existingDefinition ? this._reapplyDataToolDependents(fileId, data, outputName) : [];
    await this._refreshLazyDataToolOverview(data);

    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree();
    this._syncDataTools();
    const stats = definition.lazyStats;
    const warning = tool === 'detrend'
        ? () => this._detrendNote(stats, config.params)
        : (tool === 'integrate' ? () => this._integralWarning(stats, config.params) : null);
    const result = {
        variable,
        count: tool === 'removeOutliers' ? (stats.count ?? 0) : 0,
        tool,
        name: outputName,
        warning: warning && warning() ? warning : '',
    };
    if (!options.silent) {
        this._setDataToolApplyMessage(result, existingDefinition ? 'updated' : 'created', outputName, dependents.length);
    }
    return result;
};

// Rebuild the output from its definition, synchronously (session restore, a
// source edited upstream). Statistics computed from a different source are
// stale: the variable keeps its old SQL meanwhile, and a pass in the background
// replaces it. Returns false while the source has no SQL yet.
proto._reapplyLazySqlTool = function(fileId, data, name, definition) {
    if (this._isLazySinkToolConfig(definition)) return this._reapplyLazySinkTool(fileId, data, name, definition);
    const sourceVariable = data.variables?.[definition.sourceName];
    if (!sourceVariable || !data._duckdb?.source?.hasSqlValue(sourceVariable)) return false;
    const signature = this._lazyToolSourceSignature(data, definition.sourceName);
    if (definition.tool === 'derivative') definition.lazyStats = { signature };
    const variable = this._lazySqlToolVariable(data, name, definition);
    if (!variable) return false;
    data.variables[name] = variable;
    definition.variable = variable;
    if (definition.lazyStats?.signature !== signature) this._scheduleLazyToolStats(fileId, name);
    return true;
};

proto._scheduleLazyToolStats = function(fileId, name) {
    if (!this._lazyToolStatsRuns) this._lazyToolStatsRuns = new Map();
    const key = `${fileId}\u001e${name}`;
    const run = (this._lazyToolStatsRuns.get(key) || 0) + 1;
    this._lazyToolStatsRuns.set(key, run);
    const promise = Promise.resolve().then(() => this._refreshLazyToolStats(fileId, name, () => this._lazyToolStatsRuns.get(key) === run));
    if (!this._lazyToolStatsPending) this._lazyToolStatsPending = new Set();
    this._lazyToolStatsPending.add(promise);
    promise.finally(() => this._lazyToolStatsPending.delete(promise));
    return promise;
};

proto._refreshLazyToolStats = async function(fileId, name, isCurrent = () => true) {
    const data = this.plotManager.files.get(fileId)?.data;
    const definition = this.dataToolVariablesByFile?.get(fileId)?.get(name);
    if (!data?._duckdb || !definition) return false;
    try {
        const signature = this._lazyToolSourceSignature(data, definition.sourceName);
        if (!signature || definition.lazyStats?.signature === signature) return false;
        const stats = await this._computeLazyToolStats(data, definition);
        if (!isCurrent() || stats.signature !== this._lazyToolSourceSignature(data, definition.sourceName)) return false;
        definition.lazyStats = stats;
        const variable = this._lazySqlToolVariable(data, name, definition);
        if (!variable) return false;
        data.variables[name] = variable;
        definition.variable = variable;
        this._reapplyDataToolDependents(fileId, data, name);
        await this._refreshLazyDataToolOverview(data);
        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree?.();
        return true;
    } catch (err) {
        console.warn(`[duckdb] could not compute lazy data tool ${name}:`, err?.message || err);
        return false;
    }
};


// ─── Tools the chunked executor runs ────────────────────────────────────────

proto._applyLazySinkToolCreateMode = async function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    const source = data._duckdb?.source;
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const existing = data.variables[outputName];
    const existingDefinition = definitions?.get(outputName);
    if (existing && !existingDefinition) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
    if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));
    if (!source?.hasSqlValue(sourceVariable)) throw new Error(i18n.t('dataToolLazyDisabled'));

    const definition = {
        name: outputName,
        tool,
        targetMode: 'create',
        sourceName,
        method: config.method || null,
        params: this._cloneDataToolParams(config.params),
        replacement: '',
    };
    const signature = this._lazySinkSignature(data, definition);
    const run = await this._runLazySinkJob(data, definition, options);
    if (!run) {
        if (!options.silent) this._setOutlierMessage(() => i18n.t('dataToolSinkCancelled').replace('{name}', outputName), '');
        return null;
    }
    definition.lazySink = this._lazySinkRecord(run, signature);
    const variable = this._lazySqlToolVariable(data, outputName, definition);
    if (!variable?._duckdbExpr) {
        await source.dropSink(data, run.sink.table);
        throw new Error(i18n.t('dataToolLazyDisabled'));
    }
    data.variables[outputName] = variable;
    // Replacing an earlier run drops its sink (_storeDataToolDefinition).
    this._storeDataToolDefinition(fileId, outputName, { ...definition, variable });
    // What is built on this output reads its sink: rebuild it.
    const dependents = existingDefinition ? this._reapplyDataToolDependents(fileId, data, outputName) : [];
    await this._refreshLazyDataToolOverview(data);

    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree();
    this._syncDataTools();
    const report = definition.lazySink.report;
    const note = tool === 'filter' && report ? () => this._filterNote(report) : null;
    const result = {
        variable,
        count: report?.filteredCount ?? 0,
        tool,
        name: outputName,
        warning: note && note() ? note : '',
    };
    if (!options.silent) {
        this._setDataToolApplyMessage(result, existingDefinition ? 'updated' : 'created', outputName, dependents.length);
    }
    return result;
};

// What a filter's output carries on `dataTool`, as _buildFilterResult writes
// it for a file in memory.
proto._lazyFilterDataTool = function(params, report) {
    return {
        mode: params.mode,
        source: params.source || 'manual',
        b: [...(params.b || [])],
        a: [...(params.a || [])],
        sos: params.sos ? params.sos.map(section => [...section]) : undefined,
        design: params.design ? this._cloneDataToolParams(params.design) : undefined,
        advance: params.advance,
        advanceA: params.advanceA,
        advanceB: params.advanceB,
        init: params.init,
        initState: [...(params.initState || [])],
        restartGap: params.restartGap,
        segments: report?.segments ?? null,
        restarts: report?.restarts ?? null,
        carriedBreaks: report?.carriedBreaks ?? null,
        filteredCount: report?.filteredCount ?? null,
        skippedCount: report?.skippedCount ?? null,
        irregular: report?.irregular ?? null,
    };
};

// What a sink was computed from: the source (its SQL, the time axis, the rows
// — see _lazyToolSourceSignature) and the tool's settings. A sink computed
// from anything else is stale.
proto._lazySinkSignature = function(data, definition) {
    const source = this._lazyToolSourceSignature(data, definition.sourceName);
    if (!source) return null;
    return JSON.stringify([source, definition.tool, definition.params || {}]);
};

proto._lazySinkRecord = function(run, signature) {
    return {
        table: run.sink.table,
        column: run.sink.columns[0],
        signature,
        rows: run.rows,
        // The moving-average detrend's fit points (see computeDetrend).
        fitPoints: run.fitPoints,
        // A filter's counts (see applyFilter): what the panel says about holes.
        report: run.report || null,
    };
};

// The kernel a job runs: the incremental form of the tool's own kernel, fed
// the source column of each chunk. A filter also reads the time of each
// sample (forward, when the axis has one: a stretch of time with no rows is a
// hole) or runs a second pass (zero phase); `axis` is the step of the whole
// time axis (_lazyAxisSteps).
proto._lazySinkKernel = function(definition, { axis = null } = {}) {
    const params = definition.params || {};
    const sourceName = definition.sourceName;
    const column = chunk => chunk.yByVar.get(sourceName);
    if (definition.tool === 'filter') {
        if (params.mode === 'zeroPhase') {
            const kernel = createZeroPhaseFilter(params, { axis, memoryRows: LAZY_FILTER_MEMORY_ROWS });
            return {
                push: chunk => kernel.push(column(chunk)),
                flush: () => kernel.flush(),
                backward: s => kernel.backward(s),
                longStretches: kernel.longStretches,
                report: () => kernel.report(),
                withTime: false,
            };
        }
        const kernel = createForwardFilter(params, { axis });
        const timed = !!axis?.timed;
        return {
            push: chunk => kernel.push(column(chunk), timed ? chunk.x : null),
            flush: () => kernel.flush(),
            report: () => kernel.report(),
            withTime: timed,
        };
    }
    const kernel = definition.tool === 'detrend' ? createMovingAverageDetrend(params) : createMovingAverage(params);
    return {
        push: chunk => kernel.push(column(chunk)),
        flush: () => kernel.flush(),
        get used() { return kernel.used; },
    };
};

// What the sinks may hold together, in bytes: the Advanced setting "Results in
// memory", where 0 is no limit. Null leaves the engine's own default.
proto._lazySinkBudgetBytes = function() {
    const mb = Number(this.advancedSettings?.lazyResultsMb);
    if (!Number.isFinite(mb) || mb < 0) return null;
    return mb > 0 ? mb * 1024 * 1024 : Infinity;
};

/**
 * Run a tool over the whole file into a new sink, behind an overlay with
 * progress and Cancel. Returns `{ sink, rows, fitPoints }`, or null when it
 * was cancelled (the sink is dropped then). Anything else that stops it is
 * thrown, with a message for the panel.
 *
 * `overlayDelayMs` holds the overlay back: a run nobody asked for just now (a
 * session restored, rows appended live, a source edited upstream) shows it
 * only if it lasts, so a file that updates live does not flash a dialog at
 * every append.
 */
proto._runLazySinkJob = async function(data, definition, { signal = null, overlayDelayMs = 0 } = {}) {
    const source = data._duckdb.source;
    const budgetBytes = this._lazySinkBudgetBytes();
    if (budgetBytes !== null) source.sinkBudgetBytes = budgetBytes;
    // Refused before reading anything when the size is known (Parquet, a
    // counted file); otherwise the writer stops at the budget.
    const totalRows = Number(data._duckdb.totalRows);
    if (Number.isFinite(totalRows) && totalRows > 0) {
        const budget = source.sinkBudget();
        if (budget.used + source.sinkBytesFor(totalRows, 1) > budget.limit) {
            throw new Error(this._lazySinkErrorMessage(definition.name, { code: 'SINK_BUDGET', ...budget }));
        }
    }
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
    // The overlay's Cancel sets `cancelled`: that aborts the job there and
    // then, rather than at the next chunk.
    const token = {
        get cancelled() { return controller.signal.aborted; },
        set cancelled(value) { if (value) controller.abort(); },
    };
    let overlay = null;
    const openOverlay = () => {
        overlay = this._showBusyOverlay?.({
            title: i18n.t('dataToolSinkRunning').replace('{name}', definition.name),
            token,
        }) || null;
    };
    const overlayTimer = overlayDelayMs > 0 ? setTimeout(openOverlay, overlayDelayMs) : null;
    if (!overlayTimer) openOverlay();
    const progress = ({ rows: done, totalRows: total, pass }) => {
        if (pass === 2) {
            overlay?.progress(i18n.t('dataToolSinkBackwardProgress')
                .replace('{done}', i18n.formatNumber(done))
                .replace('{total}', i18n.formatNumber(total)));
            return;
        }
        overlay?.progress(total
            ? i18n.t('csvExportProgress')
                .replace('{done}', i18n.formatNumber(Math.min(done, total)))
                .replace('{total}', i18n.formatNumber(total))
            : i18n.t('csvExportProgressRows').replace('{done}', i18n.formatNumber(done)));
    };
    try {
        // A filter needs the step of the whole time axis first: a pass of its
        // own, once per file.
        let axis = null;
        if (definition.tool === 'filter') {
            overlay?.progress(i18n.t('dataToolSinkMeasuringAxis'));
            axis = await this._lazyAxisSteps(data, { signal: controller.signal });
        }
        const kernel = this._lazySinkKernel(definition, { axis });
        const sink = await source.createSink(data);
        const { rows } = await runChunkedJob({
            data,
            sourceNames: [definition.sourceName],
            kernel,
            sink,
            withTime: !!kernel.withTime,
            signal: controller.signal,
            onProgress: progress,
        });
        return { sink, rows, fitPoints: kernel.used, report: kernel.report?.() || null };
    } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') return null;
        throw new Error(this._lazySinkErrorMessage(definition.name, err));
    } finally {
        if (overlayTimer) clearTimeout(overlayTimer);
        overlay?.close();
    }
};

proto._lazySinkErrorMessage = function(name, err) {
    if (err?.code === 'SINK_BUDGET') {
        const size = (bytes) => this._formatFileSize?.(bytes) || `${Math.round(bytes / 1048576)} MB`;
        return i18n.t('dataToolSinkBudget')
            .replace('{name}', name)
            .replace('{limit}', size(err.limit))
            .replace('{used}', size(err.used));
    }
    // A kernel's own refusal (an unstable filter) is a code with a sentence.
    const translated = err?.code ? i18n.t(err.code) : '';
    const detail = translated && translated !== err.code ? translated : (err?.message || String(err));
    return i18n.t('dataToolSinkFailed').replace('{name}', name).replace('{error}', detail);
};

// Rebuild the output from its definition, synchronously (session restore, a
// source edited upstream, a reload, rows appended live). A sink computed from
// this very source is read as it is. Otherwise the variable exists at once —
// reading the old sink while that is still there, empty if not — and the job
// runs again in the background.
proto._reapplyLazySinkTool = function(fileId, data, name, definition) {
    const source = data._duckdb?.source;
    const sourceVariable = data.variables?.[definition.sourceName];
    if (!sourceVariable || !source?.hasSqlValue(sourceVariable)) return false;
    if (definition.lazySink && !source.hasSink(definition.lazySink.table)) definition.lazySink = null;
    const current = !!definition.lazySink && definition.lazySink.signature === this._lazySinkSignature(data, definition);
    const variable = this._lazySqlToolVariable(data, name, definition);
    if (!variable) return false;
    data.variables[name] = variable;
    definition.variable = variable;
    if (!current) this._scheduleLazySinkJob(fileId, name);
    return true;
};

// Jobs run one at a time: each has its overlay, and they read the same files.
// A later request for the same output supersedes one still waiting.
proto._scheduleLazySinkJob = function(fileId, name) {
    if (!this._lazySinkRuns) this._lazySinkRuns = new Map();
    const key = `${fileId}\u001e${name}`;
    const run = (this._lazySinkRuns.get(key) || 0) + 1;
    this._lazySinkRuns.set(key, run);
    const isCurrent = () => this._lazySinkRuns.get(key) === run;
    const previous = this._lazySinkQueue || Promise.resolve();
    const promise = previous.catch(() => null)
        .then(() => (isCurrent() ? this._refreshLazySinkTool(fileId, name, isCurrent) : false));
    this._lazySinkQueue = promise;
    // Awaited with the statistics passes (tests, and whoever needs every lazy
    // tool settled).
    if (!this._lazyToolStatsPending) this._lazyToolStatsPending = new Set();
    this._lazyToolStatsPending.add(promise);
    promise.finally(() => this._lazyToolStatsPending.delete(promise));
    return promise;
};

proto._refreshLazySinkTool = async function(fileId, name, isCurrent = () => true) {
    const data = this.plotManager.files.get(fileId)?.data;
    const definition = this.dataToolVariablesByFile?.get(fileId)?.get(name);
    if (!data?._duckdb || !definition || !this._isLazySinkToolConfig(definition)) return false;
    const source = data._duckdb.source;
    const signature = this._lazySinkSignature(data, definition);
    if (!signature) return false;
    if (definition.lazySink?.signature === signature && source.hasSink(definition.lazySink.table)) return false;
    let run = null;
    try {
        run = await this._runLazySinkJob(data, definition, { overlayDelayMs: 1000 });
    } catch (err) {
        console.warn(`[duckdb] could not compute lazy data tool ${name}:`, err?.message || err);
        this._setOutlierMessage(err?.message || String(err), 'error');
        return false;
    }
    if (!run) {
        this._setOutlierMessage(() => i18n.t('dataToolSinkNotComputed').replace('{name}', name), 'error');
        return false;
    }
    // Edited, deleted, renamed or reloaded meanwhile: this run answers nothing.
    const stillCurrent = isCurrent()
        && this.dataToolVariablesByFile?.get(fileId)?.get(name) === definition
        && this.plotManager.files.get(fileId)?.data === data
        && this._lazySinkSignature(data, definition) === signature;
    if (!stillCurrent) {
        await source.dropSink(data, run.sink.table);
        return false;
    }
    const replaced = definition.lazySink?.table;
    definition.lazySink = this._lazySinkRecord(run, signature);
    const variable = this._lazySqlToolVariable(data, name, definition);
    if (!variable) {
        definition.lazySink = null;
        await source.dropSink(data, run.sink.table);
        return false;
    }
    data.variables[name] = variable;
    definition.variable = variable;
    this._reapplyDataToolDependents(fileId, data, name);
    await this._refreshLazyDataToolOverview(data);
    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree?.();
    if (replaced && replaced !== run.sink.table) await source.dropSink(data, replaced);
    return true;
};

// A deleted output's sink: nothing reads it any more.
proto._dropLazySink = function(fileId, table) {
    const data = this.plotManager?.files?.get(fileId)?.data;
    const source = data?._duckdb?.source;
    if (!source || !table) return;
    source.dropSink(data, table).catch(err => console.warn('[duckdb] could not drop a sink:', err?.message || err));
};

}
