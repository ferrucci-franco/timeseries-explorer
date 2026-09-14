// The Cross-correlation data tool.
//
// Two signals of the same file in, one derived dataset out: r_xy as a function
// of lag, on a `lag` axis of its own (in the file's time unit, or in samples
// when the file has no time axis). It is the second derived-dataset tool after
// the resampler and rides on the same infrastructure — recipe, tree family,
// files-list nesting, Transformations row, edit in place, reload, sessions,
// cascade close (derived-dataset-methods.js). What lives here is the form, the
// plan the summary and the Create buttons read, the compute (off-thread when a
// worker is there), and the shape of the dataset it produces.
//
// The mathematics and the sign convention are the kernel's
// (src/compute/kernels/xcorr.js): r_xy[k] = Σ x[n+k]·y[n], MATLAB's and
// SciPy's, a peak at a positive lag meaning x runs behind y.

import i18n from '../../i18n/index.js';
import { getComputePool, translateKernelError } from './data-tools-methods.js';
import { runCrossCorrelation } from '../../compute/kernels/index.js';
import { XCORR_NORMALIZATIONS, XCORR_DEFAULT_NORMALIZATION, normalizeXcorrParams } from '../../compute/kernels/xcorr.js';
import * as kernelShared from '../../compute/kernels/shared.js';

export const XCORR_FIELD_IDS = ['xcorr-second', 'xcorr-max-lag', 'xcorr-normalization', 'xcorr-remove-mean'];

export function installXcorrMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.initXcorrTool = function() {
    const rerun = () => {
        this._setOutlierMessage('', '');
        this._syncDataTools();
    };
    for (const id of ['xcorr-second', 'xcorr-normalization', 'xcorr-remove-mean', 'xcorr-max-lag']) {
        document.getElementById(id)?.addEventListener('change', rerun);
    }
    document.getElementById('xcorr-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleXcorrHelpPopover();
    });
};

proto._toggleXcorrHelpPopover = function(show) {
    const popover = document.getElementById('xcorr-help-popover');
    const button = document.getElementById('xcorr-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
    if (willShow) this._positionFilterHelpPopover?.(popover, button);
};

// ─── The axis ─────────────────────────────────────────────────────────────

/**
 * What a lag is worth on this file. `dt` is the nominal step in the unit the
 * panel shows (seconds for a calendar axis, the declared unit otherwise, a
 * sample for an index axis), so lag_k = k · dt.
 *
 * Measuring the step sorts every Δt of the axis, and a sync of the panel asks
 * for it several times over; the measurement is kept per axis array (a reload
 * or a recompute makes a new array, so it can never go stale) and only the
 * cheap labelling is redone.
 *
 * @returns {{ ok: boolean, code: string, kind: string, unit: string, dt: number, length: number }}
 */
proto._xcorrAxis = function(data) {
    const time = this._resampleTimeContext?.(data) || { values: null, kind: 'index', variable: null };
    const length = Number(data?.metadata?.numTimesteps) || Number(time.values?.length) || 0;
    const blank = { ok: false, code: '', kind: time.kind, unit: '', dt: NaN, length };
    if (!data) return blank;
    const unit = this._resampleUnitLabel(time.kind, time.variable);
    if (time.kind === 'index' || !time.values || time.values.length !== length) {
        return { ok: true, code: '', kind: 'index', unit: i18n.t('dataToolResampleUnitSamples'), dt: 1, length };
    }
    const info = this._xcorrAxisStep(time.values);
    if (!info.hasNominalStep || !(info.medianDt > 0)) {
        return {
            ...blank,
            code: info.reason === 'nonMonotonic' ? 'dataToolXcorrBackwards' : 'dataToolXcorrIrregular',
        };
    }
    return { ok: true, code: '', kind: time.kind, unit, dt: info.medianDt / this._resampleAxisScale(time.kind), length };
};

/** The step measurement behind `_xcorrAxis`: the panel-wide one, per array. */
proto._xcorrAxisStep = function(values) {
    return this._axisStepInfo(values);
};

// ─── Reading the form ─────────────────────────────────────────────────────

proto._readXcorrForm = function() {
    const number = value => (value === '' || value === undefined || value === null ? NaN : Number(value));
    const normalization = document.getElementById('xcorr-normalization')?.value;
    return {
        second: document.getElementById('xcorr-second')?.value || '',
        maxLag: number(document.getElementById('xcorr-max-lag')?.value),
        normalization: XCORR_NORMALIZATIONS.has(normalization) ? normalization : XCORR_DEFAULT_NORMALIZATION,
        removeMean: document.getElementById('xcorr-remove-mean')?.checked !== false,
    };
};

proto._getXcorrConfig = function() {
    const form = this._readXcorrForm();
    return {
        tool: 'xcorr',
        // `maxLag` is kept in the unit the user typed (the axis unit); the
        // conversion to samples happens against the source when computing.
        params: { second: form.second, maxLag: form.maxLag, normalization: form.normalization, removeMean: form.removeMean },
    };
};

/** Max lag in samples for a recipe against a given axis. */
function lagSamples(maxLag, axis) {
    if (!Number.isFinite(maxLag) || !(maxLag > 0)) return NaN;
    if (!(axis.dt > 0)) return NaN;
    return Math.max(1, Math.min(axis.length - 1, Math.round(maxLag / axis.dt)));
}

/**
 * Everything the summary and the Create buttons need to know about the draft.
 * @returns {{ ok: boolean, code: string, text: string, x: string, y: string, axis: object, lags: number }}
 */
proto._xcorrPlan = function(data) {
    const x = document.getElementById('outlier-variable')?.value || '';
    const form = this._readXcorrForm();
    const y = form.second;
    const blank = { ok: false, code: '', text: '', x, y, axis: null, lags: 0 };
    if (!data || !x) return { ...blank, code: 'dataToolChooseVariable', text: '' };
    if (!y) return { ...blank, code: 'dataToolXcorrChooseSecond', text: i18n.t('dataToolXcorrChooseSecond') };
    const xVar = data.variables?.[x];
    const yVar = data.variables?.[y];
    if (!xVar || !yVar) return { ...blank, code: 'dataToolChooseVariable', text: '' };
    if ((xVar.data?.length || 0) !== (yVar.data?.length || 0)) {
        return { ...blank, code: 'dataToolXcorrLengthMismatch', text: i18n.t('dataToolXcorrLengthMismatch') };
    }
    const axis = this._xcorrAxis(data);
    if (!axis.ok) return { ...blank, code: axis.code, text: i18n.t(axis.code), axis };
    if (axis.length < 2) return { ...blank, code: 'dataToolXcorrTooShort', text: i18n.t('dataToolXcorrTooShort'), axis };
    const lags = lagSamples(form.maxLag, axis);
    if (!Number.isFinite(lags)) {
        return { ...blank, code: 'dataToolXcorrMaxLagInvalid', text: i18n.t('dataToolXcorrMaxLagInvalid'), axis };
    }
    const lines = [];
    if (axis.kind === 'index') {
        lines.push(i18n.t('dataToolXcorrInfoIndex').replace('{lags}', formatCount(lags)));
    } else {
        lines.push(i18n.t('dataToolXcorrInfo')
            .replace('{dt}', formatNumber(axis.dt))
            .replace('{lags}', formatCount(lags))
            .replace('{span}', formatNumber(lags * axis.dt))
            .replace(/\{unit\}/g, axis.unit));
    }
    if (x === y) lines.push(i18n.t('dataToolXcorrAuto'));
    return { ok: true, code: '', text: lines.join('\n'), x, y, axis, lags };
};

// A sensible lag range to open with: a quarter of the record. The whole record
// is allowed (the far lags are then estimated from a handful of pairs), but it
// is rarely what anyone wants to look at first.
proto._seedXcorrDefaults = function() {
    const input = document.getElementById('xcorr-max-lag');
    if (!input) return;
    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    const axis = data ? this._xcorrAxis(data) : null;
    if (!axis?.ok || !(axis.length > 1)) { input.value = ''; return; }
    const span = (axis.length - 1) * axis.dt;
    input.value = String(Number((span / 4).toPrecision(3)));
};

proto._syncXcorrControls = function() {
    const select = document.getElementById('xcorr-second');
    const info = document.getElementById('xcorr-info');
    const unitLabel = document.getElementById('xcorr-max-lag-unit');
    const selected = this._getSelectedDataTool() === 'xcorr';
    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;

    if (select) {
        // The same candidates as the first picker; the default is the first
        // signal itself, i.e. the autocorrelation, until the user says otherwise.
        const previous = select.value;
        const entries = selected && data ? this._getDataToolSourceEntries(data, 'xcorr') : [];
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = i18n.t('outlierSelectVariable');
        select.appendChild(placeholder);
        for (const [name, variable] of entries) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = this._outlierSourceLabel(name, variable);
            select.appendChild(option);
        }
        const first = document.getElementById('outlier-variable')?.value || '';
        if (entries.some(([name]) => name === previous)) select.value = previous;
        else if (entries.some(([name]) => name === first)) select.value = first;
        else select.value = '';
    }

    if (unitLabel) {
        const axis = data ? this._xcorrAxis(data) : null;
        unitLabel.textContent = axis?.unit || i18n.t('dataToolResampleUnitAxis');
    }
    if (!info) return;
    if (!selected || !data) {
        info.textContent = '';
        info.classList.remove('invalid');
        return;
    }
    const plan = this._xcorrPlan(data);
    info.textContent = plan.text;
    info.classList.toggle('invalid', !plan.ok);
};

// ─── Computing ────────────────────────────────────────────────────────────

proto._runXcorrOffThread = async function(x, y, params) {
    // Rebuilt for every attempt: a transfer list neuters the buffers on this
    // side, so a worker attempt that has to fall back cannot reuse them.
    const payload = () => ({
        x: kernelShared.copyFloat64(x),
        y: kernelShared.copyFloat64(y),
        params,
    });
    const pool = getComputePool();
    if (!pool?.available) return runCrossCorrelation(payload());
    const input = payload();
    try {
        return await pool.run('dataTool:xcorr', input, { transfer: [input.x.buffer, input.y.buffer], key: 'dataTool:xcorr' });
    } catch (err) {
        if (err?.cancelled) throw err;
        if (err?.workerUnavailable) return runCrossCorrelation(payload());
        throw translateKernelError(err);
    }
};

/**
 * The dataset for a recipe, against the source's CURRENT data. Shared by the
 * commit, editing, a reload of the source and session restore.
 * @returns {Promise<{ data: object, result: object, axis: object }>}
 */
proto._computeXcorrDataset = async function(sourceFileId, sourceData, recipe) {
    const x = recipe.sourceName;
    const y = recipe.params?.second;
    const xVar = sourceData?.variables?.[x];
    const yVar = sourceData?.variables?.[y];
    if (!xVar?.data || !yVar?.data) throw new kernelShared.DataToolError('dataToolChooseVariable');
    const axis = this._xcorrAxis(sourceData);
    if (!axis.ok) throw new kernelShared.DataToolError(axis.code);
    const lags = lagSamples(Number(recipe.params?.maxLag), axis);
    const params = normalizeXcorrParams({
        maxLag: Number.isFinite(lags) ? lags : axis.length - 1,
        normalization: recipe.params?.normalization,
        removeMean: recipe.params?.removeMean,
    }, axis.length);
    const result = await this._runXcorrOffThread(xVar.data, yVar.data, params);
    const data = this._buildXcorrData(sourceData, recipe, axis, result);
    return { data, result, axis };
};

proto._buildXcorrData = function(sourceData, recipe, axis, result) {
    const x = recipe.sourceName;
    const y = recipe.params?.second;
    const same = x === y;
    const lagName = 'lag';
    const lag = new Float64Array(result.lags.length);
    for (let i = 0; i < lag.length; i++) lag[i] = result.lags[i] * axis.dt;
    const unit = axis.kind === 'index' ? 'samples' : axis.unit;
    const variables = {};
    variables[lagName] = {
        name: lagName,
        data: lag,
        description: `[${unit}]`,
        kind: 'abscissa',
        dataType: this.parser._detectDataType(lag, 'abscissa'),
        isConstant: false,
        interpolation: 'linear',
        negate: false,
        source: 'xcorr',
    };
    const rName = same ? 'r_xx' : 'r_xy';
    const normalization = result.normalization;
    const what = same ? `autocorrelation of ${x}` : `cross-correlation of ${x} and ${y}`;
    variables[rName] = {
        name: rName,
        data: result.values,
        // No square brackets here: a bracketed token in a description reads as
        // the variable's unit, everywhere from the tree to the CSV header.
        description: `${what}; ${normalization}${result.removeMean ? ', mean removed' : ''}; r(k) = Σ x(n+k)·y(n)`,
        kind: 'variable',
        dataType: this.parser._detectDataType(result.values, 'variable'),
        isConstant: this.parser._isConstantValues(result.values),
        interpolation: 'linear',
        negate: false,
        source: 'xcorr',
    };
    // The two numbers a reader takes away, as parameters: they show with their
    // value in the tree, next to the curve they summarise.
    const parameter = (name, value, description) => ({
        name,
        data: [value],
        description,
        kind: 'parameter',
        dataType: 'real',
        isConstant: true,
        source: 'xcorr',
    });
    variables.peak_lag = parameter('peak_lag', result.peakLag * axis.dt, `[${unit}] lag of the largest |r|`);
    variables.peak_value = parameter('peak_value', result.peakValue, 'r at the peak');

    const metadata = {
        numVariables: Object.keys(variables).length,
        numParams: 2,
        numTimevarying: 1,
        numTimesteps: lag.length,
        timeStart: lag[0],
        timeEnd: lag[lag.length - 1],
        timeName: lagName,
        timeKind: 'numeric',
        timeDisplayMode: 'numeric',
        timeOriginMs: 0,
        xcorr: {
            x,
            y,
            normalization,
            removeMean: result.removeMean,
            maxLagSamples: result.maxLag,
            dt: axis.dt,
            unit,
            peakLag: result.peakLag * axis.dt,
            peakValue: result.peakValue,
            route: result.route,
        },
    };
    return { filename: '', metadata, variables, tree: this.parser._buildTree(variables) };
};

// ─── Committing ───────────────────────────────────────────────────────────

proto.commitXcorrTool = async function(options = {}) {
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
    const plan = this._xcorrPlan(data);
    if (!plan.ok) {
        this._setOutlierMessage(plan.text || (() => i18n.t(plan.code || 'dataToolFixParameters')), 'error');
        return null;
    }
    const config = this._getXcorrConfig();
    const recipe = { tool: 'xcorr', sourceFileId: fileId, sourceName: plan.x, params: config.params };
    let computed;
    try {
        computed = await this._computeXcorrDataset(fileId, data, recipe);
    } catch (err) {
        if (err?.cancelled) return null;
        const code = err?.code;
        this._setOutlierMessage(code ? () => i18n.t(code) : (err?.message || String(err)), 'error');
        return null;
    }
    const { data: built, result, axis } = computed;
    const editing = this._datasetEditing;
    const target = this._registerDerivedDataset(recipe, outputName, built, { fileId: editing?.fileId || null, deferRebuild: !!options.plot });
    this._exitDerivedDatasetEditing?.();
    const rName = plan.x === plan.y ? 'r_xx' : 'r_xy';
    if (options.plot) this._plotDerivedDatasetVariable(target.fileId, rName);

    this._setOutlierMessage(() => {
        const base = i18n.t(target.replaced ? 'dataToolXcorrUpdated' : 'dataToolXcorrCreated')
            .replace('{name}', outputName)
            .replace('{lags}', formatCount(result.lags.length))
            .replace('{value}', formatNumber(result.peakValue))
            .replace('{lag}', formatNumber(result.peakLag * axis.dt))
            .replace('{unit}', built.metadata.xcorr.unit);
        const delay = this._xcorrPeakSentence(plan.x, plan.y, result.peakLag, axis.dt, built.metadata.xcorr.unit);
        const memory = this._isInMemoryFile?.(this.files.get(target.fileId)) ? i18n.t('dataToolResampleInMemory') : '';
        return [base, delay, memory].filter(Boolean).join(' ');
    }, 'ok');

    this._clearDataToolDraft({ keepMessage: true });
    this._syncDataTools();
    return { fileId: target.fileId, name: outputName, tool: 'xcorr', count: result.lags.length };
};

// The peak, read for the user: which signal runs behind which. A peak at a
// positive lag k means x[n+k] matches y[n], i.e. x is the delayed one.
proto._xcorrPeakSentence = function(x, y, peakLag, dt, unit) {
    if (!Number.isFinite(peakLag) || x === y) return '';
    if (peakLag === 0) return i18n.t('dataToolXcorrPeakZero');
    const amount = `${formatNumber(Math.abs(peakLag) * dt)} ${unit}`;
    return i18n.t(peakLag > 0 ? 'dataToolXcorrPeakDelayX' : 'dataToolXcorrPeakDelayY')
        .replace('{x}', x)
        .replace('{y}', y)
        .replace('{lag}', amount);
};

/** Push a recipe back into the form, for editing. */
proto._writeXcorrForm = function(recipe, name) {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el && value !== undefined && value !== null) el.value = String(value);
    };
    const params = recipe?.params || {};
    set('outlier-variable', recipe?.sourceName || '');
    set('outlier-output-name', name);
    // The second picker is filled by the sync from the first; its value can only
    // be written once the options exist.
    this._syncXcorrControls?.();
    set('xcorr-second', params.second || recipe?.sourceName || '');
    set('xcorr-max-lag', Number.isFinite(Number(params.maxLag)) ? params.maxLag : '');
    set('xcorr-normalization', params.normalization || XCORR_DEFAULT_NORMALIZATION);
    const mean = document.getElementById('xcorr-remove-mean');
    if (mean) mean.checked = params.removeMean !== false;
};

/** One line naming what a cross-correlation recipe does. */
proto._xcorrRecipeDescription = function(recipe) {
    const params = recipe?.params || {};
    const pair = recipe?.sourceName === params.second
        ? `autocorrelation of ${recipe?.sourceName}`
        : `${recipe?.sourceName} × ${params.second}`;
    const lag = Number.isFinite(Number(params.maxLag)) ? `, lags ±${params.maxLag}` : '';
    return `${pair}; ${params.normalization || XCORR_DEFAULT_NORMALIZATION}${params.removeMean === false ? '' : ', mean removed'}${lag}`;
};

proto._suggestXcorrFileName = function(sourceName) {
    const base = sourceName || this.files.get(this.activeFileId)?.name || 'data';
    const candidate = `${base} ${i18n.t('dataToolXcorrFileSuffix')}`;
    const taken = name => [...this.files.values()].some(entry => entry?.name === name);
    if (!taken(candidate)) return candidate;
    let index = 2;
    while (taken(`${candidate} ${index}`)) index++;
    return `${candidate} ${index}`;
};

}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '?';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e6 || abs < 1e-4) return n.toExponential(3);
    return String(Number(n.toPrecision(4)));
}

function formatCount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '?';
}
