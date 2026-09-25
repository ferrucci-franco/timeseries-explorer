// The "Collapse repeated timestamps" data tool.
//
// One file in, one derived dataset out: the same signals with one row per
// instant instead of several. It is the third derived-dataset tool after the
// resampler and the cross-correlation, and rides on the same infrastructure —
// recipe, tree family, files-list nesting, Transformations row, edit in place,
// reload, sessions, cascade close (derived-dataset-methods.js). What lives here
// is the form, the plan the summary reads, and the shape of the dataset.
//
// Why it exists: the app keeps a file's time axis however often its stamps
// repeat (#154), which leaves the reader with the honest picture — several rows
// at one instant, drawn as a vertical segment. This is how they get one row per
// instant when that is what they meant, with the choice of WHICH one theirs to
// make: the mean of the burst, its extremes, or the row that arrived first or
// last. The arithmetic is the kernel's (src/compute/kernels/collapse-repeats.js).

import i18n from '../../i18n/index.js';
import {
    COLLAPSE_DEFAULT_AGGREGATE,
    normalizeCollapseAggregate,
    runCollapseRepeats,
    timestampRuns,
} from '../../compute/kernels/collapse-repeats.js';
import { RESAMPLE_ALL_VARIABLES } from './data-tools-methods.js';

export const COLLAPSE_FIELD_IDS = ['collapse-aggregate'];

export function installCollapseMethods(TargetClass) {
    const proto = TargetClass.prototype;

// Which variables the tool works on: what the Variable picker says, as the
// resampler reads it — "All variables (N)" or one of them. The picker used to
// be shown and then ignored here, so choosing one variable still wrote a copy
// of the whole file.
proto._collapseSelection = function() {
    return document.getElementById('outlier-variable')?.value || RESAMPLE_ALL_VARIABLES;
};

proto.initCollapseTool = function() {
    document.getElementById('collapse-aggregate')?.addEventListener('change', () => {
        this._setOutlierMessage('', '');
        this._syncDataTools();
    });
};

/**
 * What the tool would do to this file, and whether it can.
 * @returns {{ok: boolean, code: string, names: string[], samples: number, groups: number, collapsed: number}}
 */
proto._collapsePlan = function(data, selection = this._collapseSelection()) {
    const time = this._resampleTimeContext?.(data) || { values: null, kind: 'index' };
    const names = this._resampleTargetNames?.(data, selection) || [];
    const blank = { ok: false, code: '', names, samples: 0, groups: 0, collapsed: 0 };
    if (!data || !names.length) return { ...blank, code: 'outlierNoVariables' };
    // A row index counts rows: it cannot repeat, and collapsing it would mean
    // merging rows that were never said to be at one instant.
    if (time.kind === 'index' || !time.values?.length) return { ...blank, code: 'dataToolCollapseNoTimeAxis' };
    const runs = timestampRuns(time.values);
    if (!runs.collapsed) return { ...blank, code: 'dataToolCollapseNothing', samples: time.values.length };
    return {
        ok: true,
        code: '',
        names,
        samples: time.values.length,
        groups: runs.groups,
        collapsed: runs.collapsed,
    };
};

proto._getCollapseConfig = function() {
    const aggregate = normalizeCollapseAggregate(document.getElementById('collapse-aggregate')?.value);
    return { tool: 'collapse', method: aggregate, params: { aggregate } };
};

/** The line under the form: how many rows go, and how many are left. */
proto._syncCollapseControls = function() {
    const info = document.getElementById('collapse-info');
    if (!info) return;
    if (this._getSelectedDataTool?.() !== 'collapse') {
        info.textContent = '';
        return;
    }
    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    const plan = this._collapsePlan(data);
    if (!plan.ok) {
        info.textContent = plan.code ? i18n.t(plan.code) : '';
        return;
    }
    info.textContent = i18n.t('dataToolCollapseSummary')
        .replace('{rows}', i18n.formatNumber(plan.samples))
        .replace('{collapsed}', i18n.formatNumber(plan.collapsed))
        .replace('{left}', i18n.formatNumber(plan.groups));
};

proto._computeCollapseDataset = async function(sourceFileId, sourceData, recipe) {
    const time = this._resampleTimeContext(sourceData);
    const names = this._resampleTargetNames(sourceData, recipe?.sourceName || RESAMPLE_ALL_VARIABLES);
    if (!names.length) {
        const err = new Error('No variables to collapse');
        err.code = 'outlierNoVariables';
        throw err;
    }
    if (time.kind === 'index' || !time.values?.length) {
        const err = new Error('No time axis to collapse on');
        err.code = 'dataToolCollapseNoTimeAxis';
        throw err;
    }
    // Small and linear — one pass per column — so it runs inline rather than
    // paying for a worker round trip and a copy of every column.
    const result = runCollapseRepeats({
        time: time.values,
        columns: names.map(name => sourceData.variables[name]?.data || []),
        params: { aggregate: normalizeCollapseAggregate(recipe?.params?.aggregate) },
    });
    const data = this._buildCollapsedData(sourceData, time, names, result);
    return { data, result, names };
};

proto._buildCollapsedData = function(sourceData, time, names, result) {
    const timeName = time.name || 'time';
    const grid = result.time;
    const variables = {};

    const abscissa = {
        name: timeName,
        data: grid,
        description: time.variable?.description || '',
        kind: 'abscissa',
        dataType: this.parser._detectDataType(grid, 'abscissa'),
        isConstant: false,
        interpolation: 'linear',
        negate: false,
        source: 'collapse',
    };
    if (time.kind === 'datetime') {
        abscissa.timeKind = 'datetime';
        abscissa.timeDisplayMode = 'calendar';
        abscissa.timeOriginMs = grid.length ? grid[0] : null;
        abscissa.description = abscissa.description || '[datetime]';
    }
    variables[timeName] = abscissa;

    for (let i = 0; i < names.length; i++) {
        const source = sourceData.variables[names[i]];
        const values = result.columns[i];
        variables[names[i]] = {
            name: names[i],
            data: values,
            displayName: source?.displayName || names[i],
            description: source?.description || '',
            kind: 'variable',
            dataType: this.parser._detectDataType(values, 'variable'),
            isConstant: this.parser._isConstantValues(values),
            interpolation: source?.interpolation || 'linear',
            negate: false,
            source: 'collapse',
        };
    }

    // Parameters have no sampling to collapse; they come across untouched.
    for (const [name, variable] of Object.entries(sourceData.variables || {})) {
        if (variable?.kind !== 'parameter' || variables[name]) continue;
        variables[name] = { ...variable, source: 'collapse' };
    }

    const metadata = {
        numVariables: Object.keys(variables).length,
        numParams: Object.values(variables).filter(v => v.kind === 'parameter').length,
        numTimevarying: names.length,
        numTimesteps: grid.length,
        timeStart: grid.length ? grid[0] : 0,
        timeEnd: grid.length ? grid[grid.length - 1] : 0,
        timeName,
        timeKind: time.kind === 'datetime' ? 'datetime' : 'numeric',
        timeDisplayMode: time.kind === 'datetime' ? 'calendar' : 'numeric',
        timeOriginMs: time.kind === 'datetime' && grid.length ? grid[0] : 0,
        // One row per instant is the point, so the copy has nothing left to
        // repeat — and the notice must not fire again on the result.
        datetimeRepeats: { samples: grid.length, repeated: 0, longestRun: grid.length ? 1 : 0 },
        collapse: { aggregate: result.aggregate, collapsed: result.collapsed, sourceRows: time.values.length },
    };

    return { filename: '', metadata, variables, tree: this.parser._buildTree(variables) };
};

proto.commitCollapseTool = async function(options = {}) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    if (!data || !outputName) {
        this._setOutlierMessage(() => i18n.t('outlierLoadFileFirst'), 'error');
        return null;
    }
    if (this._isDataToolLazyData(data)) {
        this._setOutlierMessage(() => i18n.t('dataToolLazyDisabled'), 'error');
        return null;
    }
    const selection = this._collapseSelection();
    const plan = this._collapsePlan(data, selection);
    if (!plan.ok) {
        this._setOutlierMessage(() => i18n.t(plan.code || 'dataToolFixParameters'), 'error');
        return null;
    }
    const config = this._getCollapseConfig();
    // The selection goes into the recipe, so editing, reloading and sessions
    // rebuild the same variables.
    const recipe = {
        tool: 'collapse',
        sourceFileId: fileId,
        sourceName: selection === RESAMPLE_ALL_VARIABLES ? '' : selection,
        params: config.params,
    };
    let computed;
    try {
        computed = await this._computeCollapseDataset(fileId, data, recipe);
    } catch (err) {
        if (err?.cancelled) return null;
        const code = err?.code;
        this._setOutlierMessage(code ? () => i18n.t(code) : (err?.message || String(err)), 'error');
        return null;
    }
    const { data: built, result, names } = computed;
    const editing = this._datasetEditing;
    const target = this._registerDerivedDataset(recipe, outputName, built, {
        fileId: editing?.fileId || null,
        deferRebuild: !!options.plot,
    });
    this._exitDerivedDatasetEditing?.();
    // "and plot" draws the collapsed version next to the original, on the panel
    // that already shows it: the time axis means the same thing — only with one
    // row per instant — and comparing the two is the point. It used to go onto
    // an empty panel, opened for it when there was none. Of several variables,
    // the one the user is already looking at goes, as the resampler does.
    if (options.plot) {
        const plotted = names.find(name => this._isDataToolVariablePlotted(fileId, name));
        const name = plotted || names[0];
        this._plotDerivedDatasetVariable(target.fileId, name, { alongside: { fileId, name } });
    }

    this._setOutlierMessage(() => {
        const base = i18n.t(target.replaced ? 'dataToolCollapseUpdated' : 'dataToolCollapseCreated')
            .replace('{name}', outputName)
            .replace('{collapsed}', i18n.formatNumber(result.collapsed))
            .replace('{left}', i18n.formatNumber(result.groups))
            .replace('{how}', i18n.t(`dataToolCollapse${result.aggregate[0].toUpperCase()}${result.aggregate.slice(1)}`));
        const memory = this._isInMemoryFile?.(this.files.get(target.fileId)) ? i18n.t('dataToolResampleInMemory') : '';
        return [base, memory].filter(Boolean).join(' ');
    }, 'ok');

    this._clearDataToolDraft({ keepMessage: true });
    this._syncDataTools();
    return { fileId: target.fileId, name: outputName, tool: 'collapse', count: result.groups };
};

/** Push a recipe back into the form, for editing. */
proto._writeCollapseForm = function(recipe, name) {
    const picker = document.getElementById('outlier-variable');
    if (picker) picker.value = recipe?.sourceName || RESAMPLE_ALL_VARIABLES;
    const nameField = document.getElementById('outlier-output-name');
    if (nameField) nameField.value = name || '';
    const aggregate = document.getElementById('collapse-aggregate');
    if (aggregate) aggregate.value = normalizeCollapseAggregate(recipe?.params?.aggregate);
};

/** One line naming what a collapse recipe does, for the transformations table. */
proto._collapseRecipeDescription = function(recipe) {
    const aggregate = normalizeCollapseAggregate(recipe?.params?.aggregate);
    const what = recipe?.sourceName ? `${recipe.sourceName}: ` : '';
    return `${what}repeated timestamps → ${aggregate}`;
};

proto._suggestCollapseFileName = function() {
    const base = this.files.get(this.activeFileId)?.name || 'data';
    const candidate = `${base} ${i18n.t('dataToolCollapseFileSuffix')}`;
    const taken = name => [...this.files.values()].some(entry => entry?.name === name);
    if (!taken(candidate)) return candidate;
    let index = 2;
    while (taken(`${candidate} ${index}`)) index++;
    return `${candidate} ${index}`;
};

proto._seedCollapseDefaults = function() {
    const aggregate = document.getElementById('collapse-aggregate');
    if (aggregate && !aggregate.value) aggregate.value = COLLAPSE_DEFAULT_AGGREGATE;
    this._syncCollapseControls();
};

}
