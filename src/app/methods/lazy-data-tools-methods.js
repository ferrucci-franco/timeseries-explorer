// Data Tools on a file in memory-saving (lazy) mode, beyond hard bounds.
//
// The derivative, the IQR outlier filter and the polynomial / first-sample
// detrend become SQL over the file (src/data/lazy-tool-sql.js): their output is
// a variable with `_duckdbExpr` — like a translated formula — so every lazy
// consumer reads it over the whole file at full resolution. What the SQL cannot
// know by itself (quartiles, a fitted polynomial, the first finite sample) is
// computed once, with aggregate passes over the file, and kept on the
// definition as `lazyStats`, tagged with the source it was computed from.
//
// Hard bounds keep their original path (`_duckdbDataTool`, data-tools-methods.js).

import i18n from '../../i18n/index.js';
import {
    derivativeWindows,
    detrendAnchorSql,
    detrendPolynomialSql,
    iqrOutlierSql,
    mergeWindows,
    quoteIdent,
    rowIndexWindow,
} from '../../data/lazy-tool-sql.js';
import {
    DETREND_METHODS,
    detrendRequestedOrder,
    detrendScale,
    solveDetrendFit,
} from '../../compute/kernels/detrend.js';
import { iqrFences, interpolatedQuantile } from '../../compute/kernels/outliers.js';

// Detrend methods the lazy path computes. The moving-average baseline is a
// centred window of arbitrary width: it waits for the chunked executor.
export const LAZY_DETREND_METHODS = new Set(['mean', 'linear', 'polynomial', 'firstSample']);

export function installLazyDataToolsMethods(TargetClass) {
    const proto = TargetClass.prototype;

// Whether the lazy SQL path computes this configuration (hard bounds aside).
proto._isLazySqlToolConfig = function(config) {
    if (!config) return false;
    if (config.tool === 'derivative') return true;
    if (config.tool === 'removeOutliers') return config.method === 'iqr';
    if (config.tool === 'detrend') {
        const method = config.params?.method ?? config.method;
        return DETREND_METHODS.has(method) && LAZY_DETREND_METHODS.has(method);
    }
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

// The output variable, from the definition and its statistics. Null while the
// source has no SQL of its own (a formula not restored yet).
proto._lazySqlToolVariable = function(data, name, definition) {
    const source = data?._duckdb?.source;
    const sourceName = definition.sourceName;
    const sourceVariable = data?.variables?.[sourceName];
    if (!source || !sourceVariable || !source.hasSqlValue(sourceVariable)) return null;
    const stats = definition.lazyStats || null;
    const valueSql = source._valueExpressionSql(sourceVariable, sourceName, { castDouble: true });
    const sourceWindows = sourceVariable._duckdbWindows || [];

    let expr = null;
    let windows = sourceWindows;
    if (definition.tool === 'derivative') {
        const axis = this._lazyToolTimeAxis(data);
        const built = derivativeWindows(valueSql, axis.timeSql, {
            kind: axis.kind,
            method: definition.params?.method || 'centered',
            deps: sourceWindows,
        });
        expr = quoteIdent(built.column.column);
        windows = built.windows;
    } else if (stats) {
        if (definition.tool === 'removeOutliers') {
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
            ...(definition.tool === 'detrend'
                ? { order: stats?.order ?? null, slope: stats?.slope ?? null, fitPoints: stats?.fitPoints ?? null }
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
    const warning = tool === 'detrend' ? () => this._detrendNote(stats, config.params) : null;
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

}
