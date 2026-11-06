// Derived datasets of a file in memory-saving (lazy) mode, and the
// cross-correlation of one.
//
// A resample and a collapse of repeated timestamps give another axis, so they
// are files of their own (derived-dataset-methods.js). On a lazy file they are
// lazy files of their own: the kernel runs over the source a chunk at a time
// (src/data/chunk-executor.js, runDatasetJob) and writes its rows to a table
// (DuckDbSource.createDatasetTable), which is then adopted as a lazy dataset
// (adoptDatasetTable) — read by every lazy query, zoomed, exported and given
// data tools like a file. The grid is never held in memory; the sinks' budget
// holds the table. Editing, a reload of the source and a session restore run
// the job again, as they recompute an in-memory dataset.
//
// The cross-correlation is a transform of two whole series (an FFT of both):
// it is not a chunked tool and does not pretend to be one. On a lazy file the
// two columns are read into memory up to a budget (LAZY_XCORR_MAX_ROWS) and
// the in-memory kernel runs; a file with more rows is refused with the reason.
//
// What every tool reads first is the axis measured over the whole file —
// `_lazyRealAxisSteps`, the pass of _lazyAxisSteps over the file's time column
// whatever the kind the panel shows it in — for the span, the nominal step,
// the row count and the repeated stamps.

import i18n from '../../i18n/index.js';
import { runDatasetJob } from '../../data/chunk-executor.js';
import { streamColumns } from '../../data/column-stream.js';
import { createResampler, normalizeResampleParams, resampleGridLayout } from '../../compute/kernels/regrid.js';
import { createCollapser, normalizeCollapseAggregate } from '../../compute/kernels/collapse-repeats.js';
import { DataToolError } from '../../compute/kernels/shared.js';
import { treeForDerivedData } from '../../parsers/csv-tree-grouping.js';

// How many rows a cross-correlation reads into memory: two columns of 8 M
// doubles are 128 MB, the order of what the FFT already holds.
export const LAZY_XCORR_MAX_ROWS = 8_000_000;
// The CSV a dataset writes to disk is built in memory; past this many cells
// it is not a file anyone wants written from a browser tab.
const LAZY_DATASET_CSV_MAX_CELLS = 60_000_000;

export function installLazyDatasetMethods(TargetClass) {
    const proto = TargetClass.prototype;

// ─── The axis, measured over the whole file ─────────────────────────────────

// How many rows the lazy queries serve: the count the loader has (Parquet), or
// one COUNT over the file, kept with the axis statistics.
proto._lazyRowCount = async function(data, { signal } = {}) {
    const meta = data?._duckdb;
    if (!meta) return Number(data?.metadata?.numTimesteps) || 0;
    const known = Number(meta.totalRows);
    if (Number.isFinite(known) && known > 0 && !meta.appendRows) return known;
    const source = meta.source;
    if (source.timeValueSql(data)) return (await this._lazyRealAxisSteps(data, { signal })).rows;
    const key = this._lazyRealAxisKey(data, 'rows');
    if (!this._lazyAxisStepCache) this._lazyAxisStepCache = new Map();
    const cached = this._lazyAxisStepCache.get(key);
    if (cached) return cached.rows;
    const { n } = await source.aggregateOver(source.passSql(data, [], 'TRUE'), 'COUNT(*)::BIGINT AS n', { signal });
    this._lazyAxisStepCache.set(key, { rows: n });
    return n;
};

proto._lazyRealAxisKey = function(data, what) {
    const meta = data._duckdb;
    return JSON.stringify([meta.tableName, Number(meta.appendRows) || 0, what, meta.source.timeValueSql(data)]);
};

// detectSamplingGaps over the file's time column, whatever kind the panel reads
// the axis in: `{ timed, generated, rows, medianDt, hasNominalStep, reason,
// count, totalMissing, usableAxis, repeats, nonFinite }`. A generated axis
// (row numbers) is `timed: false` with the rows counted. Measured once per
// file: a reload is a new table, rows appended live a new count.
proto._lazyRealAxisSteps = async function(data, { signal } = {}) {
    const meta = data._duckdb;
    const source = meta.source;
    const timeSql = source.timeValueSql(data);
    if (!this._lazyAxisStepCache) this._lazyAxisStepCache = new Map();
    const key = this._lazyRealAxisKey(data, 'axis');
    const cached = this._lazyAxisStepCache.get(key);
    if (cached) return cached;
    let steps;
    if (!timeSql) {
        const rows = await this._lazyRowCount(data, { signal });
        steps = { timed: false, generated: true, rows, medianDt: NaN, hasNominalStep: false, reason: 'noTimeAxis', count: 0, totalMissing: 0, usableAxis: true, repeats: 0, nonFinite: 0 };
    } else {
        steps = { timed: true, generated: false, ...await this._lazyStepStats(data, timeSql, [], { signal }) };
    }
    this._lazyAxisStepCache.set(key, steps);
    while (this._lazyAxisStepCache.size > 16) this._lazyAxisStepCache.delete(this._lazyAxisStepCache.keys().next().value);
    return steps;
};

// The same, for a panel that cannot wait: the measurement when there is one;
// otherwise null, with the measurement started in the background and the
// panel synced again when it is in.
proto._lazyRealAxisStepsNow = function(data) {
    const key = this._lazyRealAxisKey(data, 'axis');
    const cached = this._lazyAxisStepCache?.get(key);
    if (cached) return cached;
    if (!this._lazyAxisStepRuns) this._lazyAxisStepRuns = new Map();
    if (!this._lazyAxisStepRuns.has(key)) {
        const run = this._lazyRealAxisSteps(data)
            .then(() => this._syncDataTools?.())
            .catch(err => console.warn('[duckdb] could not measure the time axis:', err?.message || err))
            .finally(() => this._lazyAxisStepRuns.delete(key));
        this._lazyAxisStepRuns.set(key, run);
    }
    return null;
};

// What the resampler and the collapse read of a lazy file's axis, for the
// panel's summary: null while it is being measured.
// `{ rows, span, first, last, sourceStep, gaps, repeats, steps }`.
proto._lazyDatasetAxisNow = function(data) {
    const steps = this._lazyRealAxisStepsNow(data);
    return steps ? this._lazyDatasetAxisFrom(data, steps) : null;
};

proto._lazyDatasetAxisFrom = function(data, steps) {
    const rows = Number(steps.rows) || 0;
    // The ends of the axis: MIN and MAX over the file (the loader's), the
    // first and last row of a monotonic axis; row numbers for a generated one.
    const first = steps.generated ? 0 : Number(data.metadata?.timeStart);
    const last = steps.generated ? Math.max(0, rows - 1) : Number(data.metadata?.timeEnd);
    return {
        rows,
        first,
        last,
        span: last - first,
        sourceStep: steps.generated ? 1 : steps.medianDt,
        gaps: steps.hasNominalStep && steps.count > 0 ? { count: steps.count, missing: steps.totalMissing } : null,
        repeats: steps.repeats || 0,
        steps,
    };
};

// ─── The job ────────────────────────────────────────────────────────────────

/**
 * Run a kernel over the whole source into a new dataset table, behind an
 * overlay with progress and Cancel. Returns `{ dataset, rows, written }`, or
 * null when it was cancelled (the table is dropped then). Anything else that
 * stops it is thrown, with a message for the panel.
 */
proto._runLazyDatasetJob = async function(data, { name, sourceNames, timeColumn, columns, estimatedRows, kernel }, { signal = null, overlayDelayMs = 0 } = {}) {
    const source = data._duckdb.source;
    const budgetBytes = this._lazySinkBudgetBytes();
    if (budgetBytes !== null) source.sinkBudgetBytes = budgetBytes;
    // Refused before reading anything when the size of the result is known
    // (a resample's grid); otherwise the writer stops at the budget.
    if (Number.isFinite(estimatedRows) && estimatedRows > 0) {
        const budget = source.sinkBudget();
        if (budget.used + source.sinkBytesFor(estimatedRows, columns.length) > budget.limit) {
            throw new Error(this._lazySinkErrorMessage(name, { code: 'SINK_BUDGET', ...budget }));
        }
    }
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
    const token = {
        get cancelled() { return controller.signal.aborted; },
        set cancelled(value) { if (value) controller.abort(); },
    };
    let overlay = null;
    const openOverlay = () => {
        overlay = this._showBusyOverlay?.({ title: i18n.t('dataToolSinkRunning').replace('{name}', name), token }) || null;
    };
    const overlayTimer = overlayDelayMs > 0 ? setTimeout(openOverlay, overlayDelayMs) : null;
    if (!overlayTimer) openOverlay();
    const progress = ({ rows: done, totalRows: total }) => {
        overlay?.progress(total
            ? i18n.t('csvExportProgress')
                .replace('{done}', i18n.formatNumber(Math.min(done, total)))
                .replace('{total}', i18n.formatNumber(total))
            : i18n.t('csvExportProgressRows').replace('{done}', i18n.formatNumber(done)));
    };
    try {
        const dataset = await source.createDatasetTable(data, { timeColumn, columns });
        const writer = source.openDatasetWriter(data, dataset);
        const { rows, written } = await runDatasetJob({ data, sourceNames, kernel, writer, signal: controller.signal, onProgress: progress });
        return { dataset, rows, written };
    } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') return null;
        throw new Error(this._lazySinkErrorMessage(name, err));
    } finally {
        if (overlayTimer) clearTimeout(overlayTimer);
        overlay?.close();
    }
};

// What a cancelled job throws to the commit paths, which drop it silently.
function cancelledError() {
    const err = new Error('Job cancelled');
    err.cancelled = true;
    return err;
}

// ─── The resample ───────────────────────────────────────────────────────────

/**
 * A resampled dataset of a lazy file, from its recipe. What
 * _computeResampleDataset returns for a file in memory, with the dataset a
 * lazy file of its own.
 */
proto._computeLazyResampleDataset = async function(sourceFileId, sourceData, recipe, name = recipe.name || '') {
    const source = sourceData._duckdb.source;
    const time = this._resampleTimeContext(sourceData);
    const names = this._resampleTargetNames(sourceData, recipe.sourceName || '');
    if (!names.length) {
        const err = new Error('No variables to resample');
        err.code = 'outlierNoVariables';
        throw err;
    }
    const params = normalizeResampleParams(recipe.params || {});
    const gridParams = this._resampleGridParams(params, time.kind);
    const steps = await this._lazyRealAxisSteps(sourceData);
    // What resampleSourceAxis refuses over an array.
    if (steps.timed && steps.nonFinite > 0) throw new DataToolError('dataToolResampleTimeInvalid');
    if (steps.timed && steps.reason === 'nonMonotonic') throw new DataToolError('dataToolResampleTimeNotAscending');
    const axis = this._lazyDatasetAxisFrom(sourceData, steps);
    if (axis.rows < 2) throw new DataToolError('dataToolResampleTooShort');
    const layout = resampleGridLayout(axis.first, axis.last, gridParams, axis.sourceStep, { maxPoints: Infinity });
    const resampler = createResampler(layout, { ...gridParams, sourceStep: axis.sourceStep }, { columns: names.length });
    const timeName = time.name || 'time';
    const run = await this._runLazyDatasetJob(sourceData, {
        name: name || 'resample',
        sourceNames: names,
        timeColumn: timeName,
        columns: names,
        estimatedRows: layout.count,
        kernel: {
            push: chunk => resampler.push(chunk.x, names.map(n => chunk.yByVar.get(n))),
            flush: () => resampler.flush(),
        },
    });
    if (!run) throw cancelledError();
    const report = resampler.report();
    const adopted = await source.adoptDatasetTable(sourceData, run.dataset, {
        timeName,
        timeKind: time.kind === 'datetime' ? 'datetime' : 'numeric',
        overviewPoints: sourceData._duckdb.overviewPoints || 10000,
    });
    const scale = this._resampleAxisScale(time.kind);
    const data = this._buildLazyDatasetData(sourceData, time, adopted, names, 'resample', {
        resample: {
            method: params.method,
            gridMode: params.gridMode,
            gapPolicy: params.gapPolicy,
            step: layout.step / scale,
            sourceKind: time.kind,
        },
    });
    return {
        data,
        resampled: {
            grid: null,
            columns: null,
            step: layout.step,
            sourceStep: axis.sourceStep,
            emptyCounts: report.emptyCounts,
            bridgedCounts: report.bridgedCounts,
            gapLeftCounts: report.gapLeftCounts,
        },
        names,
    };
};

// ─── The collapse ───────────────────────────────────────────────────────────

/** A lazy file with one row per instant, from its recipe (see _computeCollapseDataset). */
proto._computeLazyCollapseDataset = async function(sourceFileId, sourceData, recipe, name = recipe.name || '') {
    const source = sourceData._duckdb.source;
    const time = this._resampleTimeContext(sourceData);
    const names = this._resampleTargetNames(sourceData, recipe?.sourceName || '');
    if (!names.length) {
        const err = new Error('No variables to collapse');
        err.code = 'outlierNoVariables';
        throw err;
    }
    if (time.kind === 'index' || !source.timeValueSql(sourceData)) throw new DataToolError('dataToolCollapseNoTimeAxis');
    const steps = await this._lazyRealAxisSteps(sourceData);
    const aggregate = normalizeCollapseAggregate(recipe?.params?.aggregate);
    const collapser = createCollapser({ aggregate }, { columns: names.length });
    const timeName = time.name || 'time';
    const run = await this._runLazyDatasetJob(sourceData, {
        name: name || 'collapse',
        sourceNames: names,
        timeColumn: timeName,
        columns: names,
        estimatedRows: Math.max(0, (Number(steps.rows) || 0) - (Number(steps.repeats) || 0)),
        kernel: {
            push: chunk => collapser.push(chunk.x, names.map(n => chunk.yByVar.get(n))),
            flush: () => collapser.flush(),
        },
    });
    if (!run) throw cancelledError();
    const report = collapser.report();
    const adopted = await source.adoptDatasetTable(sourceData, run.dataset, {
        timeName,
        timeKind: time.kind === 'datetime' ? 'datetime' : 'numeric',
        overviewPoints: sourceData._duckdb.overviewPoints || 10000,
    });
    const groups = report.groups;
    const data = this._buildLazyDatasetData(sourceData, time, adopted, names, 'collapse', {
        // One row per instant is the point, so the copy has nothing left to
        // repeat — and the notice must not fire again on the result.
        datetimeRepeats: { samples: groups, repeated: 0, longestRun: groups ? 1 : 0 },
        collapse: { aggregate, collapsed: report.collapsed, sourceRows: report.rows },
    });
    return { data, result: { groups, collapsed: report.collapsed, aggregate }, names };
};

// ─── The dataset as a file ──────────────────────────────────────────────────

// The adopted table dressed as _buildResampledData / _buildCollapsedData dress
// a dataset in memory: the source's labels, interpolation and units on each
// variable, its parameters copied through, the metadata of the tool, and the
// source's folders in the tree. The variables keep what makes them lazy
// (`_duckdbCol`), and the dataset keeps its `_duckdb`.
proto._buildLazyDatasetData = function(sourceData, time, adopted, names, tool, extraMetadata = {}) {
    const kind = time.kind;
    const timeName = time.name || 'time';
    const variables = {};
    const abscissa = adopted.variables[adopted.metadata.timeName] || Object.values(adopted.variables).find(v => v.kind === 'abscissa');
    abscissa.name = timeName;
    abscissa.description = time.variable?.description || abscissa.description || '';
    abscissa.source = tool;
    if (kind === 'datetime') {
        abscissa.timeKind = 'datetime';
        abscissa.timeDisplayMode = 'calendar';
        abscissa.description = abscissa.description || '[datetime]';
    } else if (kind === 'index' && tool === 'resample') {
        // A resampled index axis is no longer a row count: the values are
        // fractional row positions, published as the plain numbers they hold.
        abscissa.description = abscissa.description || '[sample]';
    }
    variables[timeName] = abscissa;
    for (const name of names) {
        const variable = adopted.variables[name];
        const source = sourceData.variables[name];
        if (!variable) continue;
        variables[name] = {
            ...variable,
            name,
            displayName: source?.displayName || name,
            description: source?.description || '',
            kind: 'variable',
            dataType: this.parser._detectDataType(variable.data, 'variable'),
            isConstant: this.parser._isConstantValues(variable.data),
            interpolation: source?.interpolation || 'linear',
            negate: false,
            source: tool,
        };
    }
    // Parameters are constants: they have no sampling to change.
    for (const [name, variable] of Object.entries(sourceData.variables || {})) {
        if (variable?.kind !== 'parameter' || variables[name]) continue;
        variables[name] = { ...variable, source: tool };
    }
    const first = Number(adopted.metadata.timeStart);
    const metadata = {
        ...adopted.metadata,
        numVariables: Object.keys(variables).length,
        numParams: Object.values(variables).filter(v => v.kind === 'parameter').length,
        numTimevarying: names.length,
        timeName,
        timeKind: kind === 'datetime' ? 'datetime' : 'numeric',
        timeDisplayMode: kind === 'datetime' ? 'calendar' : 'numeric',
        timeOriginMs: kind === 'datetime' && Number.isFinite(first) ? first : 0,
        ...extraMetadata,
    };
    const data = {
        filename: '',
        metadata,
        variables,
        tree: treeForDerivedData(sourceData, metadata, variables, vars => this.parser._buildTree(vars)),
        _duckdb: adopted._duckdb,
    };
    return data;
};

// The CSV a lazy dataset writes to disk: every row, read from its table.
proto._lazyDatasetCsvBytes = async function(data) {
    const timeName = data?.metadata?.timeName;
    const abscissa = data?.variables?.[timeName];
    const names = Object.entries(data?.variables || {})
        .filter(([name, variable]) => name !== timeName && variable?.kind !== 'parameter' && data._duckdb?.source?.hasSqlValue(variable))
        .map(([name]) => name);
    const rows = Number(data?._duckdb?.totalRows) || 0;
    if (!abscissa || !rows) throw new Error('Dataset is empty');
    if (rows * (names.length + 1) > LAZY_DATASET_CSV_MAX_CELLS) throw new Error('Dataset is too large to serialize');
    const isDatetime = data.metadata?.timeKind === 'datetime';
    const header = (name, variable) => {
        const unit = (String(variable?.description || '').match(/\[([^\]]+)\]/) || [])[1] || '';
        return unit ? `${name} [${unit}]` : name;
    };
    const cell = value => (Number.isFinite(value) ? String(value) : '');
    const quote = text => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    const parts = [[header(timeName, abscissa), ...names.map(name => header(name, data.variables[name]))].map(quote).join(',')];
    for await (const chunk of streamColumns(data, names)) {
        const columns = names.map(name => chunk.yByVar.get(name));
        for (let r = 0; r < chunk.x.length; r++) {
            const t = chunk.x[r];
            const cells = [isDatetime ? (Number.isFinite(t) ? new Date(t).toISOString() : '') : cell(t)];
            for (const column of columns) cells.push(cell(column[r]));
            parts.push(cells.join(','));
        }
    }
    return new TextEncoder().encode(`${parts.join('\n')}\n`);
};

// ─── The cross-correlation ──────────────────────────────────────────────────

// _xcorrAxis for a lazy file, from the axis measured over the whole file: the
// panel's version returns a "measuring" refusal until that is in.
proto._lazyXcorrAxis = function(data) {
    const steps = this._lazyRealAxisStepsNow(data);
    if (!steps) return { ok: false, code: 'dataToolLazyMeasuringAxis', kind: 'numeric', unit: '', dt: NaN, length: 0, measuring: true };
    return this._lazyXcorrAxisFrom(data, steps);
};

proto._lazyXcorrAxisAsync = async function(data) {
    return this._lazyXcorrAxisFrom(data, await this._lazyRealAxisSteps(data));
};

proto._lazyXcorrAxisFrom = function(data, steps) {
    const time = this._resampleTimeContext(data);
    const length = Number(steps.rows) || 0;
    if (time.kind === 'index' || !steps.timed) {
        return { ok: true, code: '', kind: 'index', unit: i18n.t('dataToolResampleUnitSamples'), dt: 1, length };
    }
    if (!steps.hasNominalStep || !(steps.medianDt > 0)) {
        return {
            ok: false,
            code: steps.reason === 'nonMonotonic' ? 'dataToolXcorrBackwards' : 'dataToolXcorrIrregular',
            kind: time.kind, unit: '', dt: NaN, length,
        };
    }
    const unit = this._resampleUnitLabel(time.kind, time.variable);
    return { ok: true, code: '', kind: time.kind, unit, dt: steps.medianDt / this._resampleAxisScale(time.kind), length };
};

/**
 * The two columns of a lazy file, whole, for the cross-correlation — up to the
 * budget, past which the file is refused. Read behind an overlay with Cancel.
 * @returns {Promise<{ x: Float64Array, y: Float64Array }>}
 */
proto._computeLazyXcorrInputs = async function(data, xName, yName, rows) {
    if (!(Number(rows) > 0) || Number(rows) > LAZY_XCORR_MAX_ROWS) throw new DataToolError('dataToolXcorrLazyTooLarge');
    const names = xName === yName ? [xName] : [xName, yName];
    const x = new Float64Array(rows);
    const y = xName === yName ? x : new Float64Array(rows);
    const controller = new AbortController();
    const token = {
        get cancelled() { return controller.signal.aborted; },
        set cancelled(value) { if (value) controller.abort(); },
    };
    const overlay = this._showBusyOverlay?.({ title: i18n.t('dataToolLazyReading'), token }) || null;
    let at = 0;
    try {
        for await (const chunk of streamColumns(data, names, { signal: controller.signal })) {
            const n = chunk.x.length;
            if (at + n > rows) throw new DataToolError('dataToolXcorrLazyTooLarge');
            x.set(chunk.yByVar.get(xName), at);
            if (y !== x) y.set(chunk.yByVar.get(yName), at);
            at += n;
            overlay?.progress(i18n.t('csvExportProgress')
                .replace('{done}', i18n.formatNumber(Math.min(at, rows)))
                .replace('{total}', i18n.formatNumber(rows)));
            if (controller.signal.aborted) throw cancelledError();
        }
    } catch (err) {
        if (controller.signal.aborted || err?.name === 'AbortError') throw cancelledError();
        throw err;
    } finally {
        overlay?.close();
    }
    return { x: x.subarray(0, at), y: y === x ? x.subarray(0, at) : y.subarray(0, at) };
};

}
