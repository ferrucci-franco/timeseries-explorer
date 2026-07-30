// The Resample data tool.
//
// It sits in the Data Tools panel next to the others, but it is the one tool
// whose result is NOT a variable: putting a series on a new Δt gives it a new
// time axis, and a file has exactly one of those (PlotManager._getTimeVar finds
// the single `kind: 'abscissa'`). A resampled variable dropped into the source
// file would therefore be drawn against the old axis — silently, at the wrong
// times. So the result arrives as a new FILE sitting next to the original, with
// its own axis, which is also what makes the two overlayable, comparable and
// exportable through the machinery that already exists for several open files.
//
// Consequences of that choice, all deliberate:
//   · The whole file is resampled, not one variable. A dataset with one column
//     on a new axis and the rest missing is not something anyone wants.
//   · Resample rows never appear in the Transformations table, which lists
//     variables of the current file. Re-running under the same name updates the
//     file that name already belongs to, which is the edit story.
//   · The new file carries a lazy CSV serializer so saving a project session
//     keeps working: that path reads bytes for every open file, and an in-memory
//     dataset has none.

import i18n from '../../i18n/index.js';
import { getComputePool, translateKernelError, RESAMPLE_ALL_VARIABLES } from './data-tools-methods.js';
import { runResample, medianStep } from '../../compute/kernels/index.js';
import {
    RESAMPLE_METHODS,
    RESAMPLE_GRID_MODES,
    RESAMPLE_BIN_METHODS,
    normalizeResampleParams,
    planResampleGrid,
} from '../../compute/kernels/regrid.js';
import * as kernelShared from '../../compute/kernels/shared.js';
import { detectSamplingGaps } from '../../utils/sampling-gaps.js';

export function installResampleMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.initResampleTool = function() {
    const rerun = () => {
        this._setOutlierMessage('', '');
        this._syncDataTools();
    };
    document.getElementById('resample-grid-mode')?.addEventListener('change', rerun);
    document.getElementById('resample-method')?.addEventListener('change', rerun);
    document.getElementById('resample-gap-policy')?.addEventListener('change', rerun);
    // Number inputs settle on blur/Enter. Recomputing the summary on every
    // keystroke would read the "0." of "0.05" and announce a 20× upsample.
    for (const id of ['resample-step', 'resample-factor', 'resample-count']) {
        document.getElementById(id)?.addEventListener('change', rerun);
    }
    document.getElementById('resample-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleResampleHelpPopover();
    });
};

proto._toggleResampleHelpPopover = function(show) {
    const popover = document.getElementById('resample-help-popover');
    const button = document.getElementById('resample-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
};

// ─── Reading the form ─────────────────────────────────────────────────────

proto._getResampleConfig = function() {
    const gridMode = document.getElementById('resample-grid-mode')?.value || 'step';
    const method = document.getElementById('resample-method')?.value || 'linear';
    return {
        tool: 'resample',
        params: normalizeResampleParams({
            gridMode: RESAMPLE_GRID_MODES.has(gridMode) ? gridMode : 'step',
            method: RESAMPLE_METHODS.has(method) ? method : 'linear',
            // Kept in the UNIT THE USER TYPED. The conversion to axis units (ms
            // for a calendar axis) happens once, in _resampleGridParams, so the
            // form and the saved description never disagree about what "0.5"
            // meant.
            step: Number(document.getElementById('resample-step')?.value),
            factor: Number(document.getElementById('resample-factor')?.value),
            count: Number(document.getElementById('resample-count')?.value),
            gapPolicy: document.getElementById('resample-gap-policy')?.value,
        }),
    };
};

// The abscissa of a file, with the flag that says what a step in it means.
proto._resampleTimeContext = function(data) {
    const timeName = data?.metadata?.timeName;
    const variable = (timeName && data?.variables?.[timeName])
        || Object.values(data?.variables || {}).find(v => v.kind === 'abscissa')
        || null;
    const metaKind = data?.metadata?.timeKind || variable?.timeKind || '';
    const kind = metaKind === 'datetime'
        ? 'datetime'
        : (metaKind === 'index' || variable?.timeStepMode === 'index' ? 'index' : 'numeric');
    return { variable, values: variable?.data || null, kind, name: variable?.name || 'time' };
};

// A calendar axis stores milliseconds, but nobody types a sampling period in
// milliseconds — the field is seconds and this is the only place that knows it.
proto._resampleAxisScale = function(kind) {
    return kind === 'datetime' ? 1000 : 1;
};

// What a step is measured in. A numeric axis usually declares its own unit in
// the description ("time [s]"), and reusing it means the Δt field is labelled
// the same way the plot's x-axis is; "axis units" is only the honest answer when
// the file never said.
proto._resampleUnitLabel = function(kind, timeVariable = null) {
    if (kind === 'datetime') return i18n.t('dataToolResampleUnitSeconds');
    if (kind === 'index') return i18n.t('dataToolResampleUnitSamples');
    const declared = timeVariable?.description
        ? this.plotManager?._extractUnit?.(timeVariable.description)
        : '';
    return declared || i18n.t('dataToolResampleUnitAxis');
};

// Form params → kernel params: the same object with `step` moved into axis units.
proto._resampleGridParams = function(params, kind) {
    const scale = this._resampleAxisScale(kind);
    return { ...params, step: params.step * scale };
};

// ─── The live summary ─────────────────────────────────────────────────────
// "Factor 2.5" is not a fact anyone can check. The resulting Δt and sample count
// are, and they are what tells the user before committing that they asked for
// 40 million points or for a Δt coarser than the whole recording.

// Open the tool showing the file's OWN Δt rather than a hardcoded 1. Starting
// from the status quo means the field always reads as a change from something,
// and "1" against a 60-second axis is a 21 000-sample upsample nobody asked for.
// Called from the parameter reset, so it lands whenever a fresh draft starts.
proto._seedResampleDefaults = function() {
    const input = document.getElementById('resample-step');
    if (!input) return;
    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    if (!data) return;
    const time = this._resampleTimeContext(data);
    const length = Number(time.values?.length) || 0;
    if (length < 2) return;
    const { sourceStep } = this._resampleAxisMeasure(time.values, length);
    if (!Number.isFinite(sourceStep) || sourceStep <= 0) return;
    const inUiUnits = sourceStep / this._resampleAxisScale(time.kind);
    input.value = String(Number(inUiUnits.toPrecision(6)));
};

proto._syncResampleControls = function() {
    const gridMode = document.getElementById('resample-grid-mode')?.value || 'step';
    document.querySelectorAll('.resample-grid-controls').forEach(el => {
        el.classList.toggle('collapsed', el.dataset.resampleGrid !== gridMode);
    });

    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    const time = this._resampleTimeContext(data);
    const unit = document.getElementById('resample-step-unit');
    if (unit) unit.textContent = this._resampleUnitLabel(time.kind, time.variable);

    const info = document.getElementById('resample-info');
    if (!info) return;
    if (this._getSelectedDataTool() !== 'resample' || !data) {
        info.textContent = '';
        info.classList.remove('invalid');
        return;
    }

    const summary = this._resamplePlan(data, time);
    info.textContent = summary.text;
    info.classList.toggle('invalid', !summary.ok);
    this._syncResampleGapControls(data, time);
};

// The gap policy only means something for the point methods. A bin method never
// reaches across anything — an interval holding no samples has always come out
// empty — so rather than leave a live control that changes nothing, it is
// disabled and says why.
proto._syncResampleGapControls = function(data, time) {
    const select = document.getElementById('resample-gap-policy');
    const note = document.getElementById('resample-gap-note');
    if (!select) return;
    const method = document.getElementById('resample-method')?.value || 'linear';
    const isBin = RESAMPLE_BIN_METHODS.has(method);
    select.disabled = select.disabled || isBin;

    if (!note) return;
    if (isBin) {
        note.textContent = i18n.t('dataToolResampleGapBinNote');
        note.className = 'data-tool-count idle';
        return;
    }
    // How many rows the source is actually missing, so the choice is made against
    // a number rather than in the abstract.
    const gaps = this._resampleSourceGaps(data, time);
    if (!gaps) {
        note.textContent = '';
        note.className = 'data-tool-count idle';
        return;
    }
    const leaving = select.value !== 'bridge';
    note.textContent = i18n.t(leaving ? 'dataToolResampleGapNoteLeave' : 'dataToolResampleGapNoteBridge')
        .replace('{gaps}', formatCount(gaps.count))
        .replace('{samples}', formatCount(gaps.missing));
    note.className = `data-tool-count${leaving ? ' idle' : ' warn'}`;
};

// Gaps in the SOURCE axis: stretches the file has no rows for. Cached with the
// axis measurement, since both come from one pass over the same array.
proto._resampleSourceGaps = function(data, time = this._resampleTimeContext(data)) {
    const values = time?.values;
    if (!values || time.kind === 'index') return null;
    const cached = this._resampleGapsCache;
    if (cached?.source === values) return cached.gaps;
    const info = detectSamplingGaps(kernelShared.asFloat64(values));
    const gaps = info.hasNominalStep && info.count > 0
        ? { count: info.count, missing: info.totalMissing }
        : null;
    this._resampleGapsCache = { source: values, gaps };
    return gaps;
};

// Span and native Δt of a file's axis. Measuring them is a full pass plus a
// sort, and _syncDataTools runs on every keystroke in the panel, so the answer
// is cached against the very array it was measured from — a reload or an edit
// replaces that array, which invalidates the entry by identity alone.
proto._resampleAxisMeasure = function(x, length) {
    const cached = this._resampleAxisCache;
    if (cached?.source === x && cached.length === length) return cached;
    const values = kernelShared.asFloat64(x);
    const measure = {
        source: x,
        length,
        span: Number(values[length - 1]) - Number(values[0]),
        sourceStep: medianStep(values),
    };
    this._resampleAxisCache = measure;
    return measure;
};

// What the chosen grid works out to, or the reason it does not work out. Shares
// planResampleGrid with the commit path, so the summary cannot promise a sample
// count the resample then produces differently.
proto._resamplePlan = function(data, time = this._resampleTimeContext(data)) {
    const length = Number(time.values?.length) || Number(data?.metadata?.numTimesteps) || 0;
    if (length < 2) return { ok: false, text: i18n.t('dataToolResampleTooShort') };

    const config = this._getResampleConfig();
    const params = this._resampleGridParams(config.params, time.kind);
    const scale = this._resampleAxisScale(time.kind);
    const x = time.values && time.values.length === length ? time.values : null;

    // With no axis of its own the file is sampled by row, so a step is one row.
    const measured = x ? this._resampleAxisMeasure(x, length) : { span: length - 1, sourceStep: 1 };
    const span = measured.span;
    const sourceStep = Number.isFinite(measured.sourceStep) && measured.sourceStep > 0
        ? measured.sourceStep
        : (span > 0 ? span / (length - 1) : NaN);

    let step;
    let count;
    try {
        ({ step, count } = planResampleGrid({ span, sourceStep, params }));
    } catch (err) {
        return { ok: false, text: i18n.t(err?.code || 'dataToolResampleStepInvalid') };
    }

    const ratio = Number.isFinite(sourceStep) && sourceStep > 0 ? sourceStep / step : NaN;
    const sameRate = Number.isFinite(ratio) && Math.abs(ratio - 1) < 1e-9;
    // "same rate, uniform grid" is true but says nothing about what the user is
    // usually after when they choose the file's own Δt on a file with holes in it:
    // materialising the rows that are not there. Name that instead.
    const gaps = sameRate ? this._resampleSourceGaps(data, time) : null;
    const change = gaps
        ? i18n.t(gaps.count === 1 ? 'dataToolResampleCompletesRowsOne' : 'dataToolResampleCompletesRows')
            .replace('{samples}', formatCount(gaps.missing))
            .replace('{gaps}', formatCount(gaps.count))
        : (!Number.isFinite(ratio) || sameRate
            ? i18n.t('dataToolResampleSame')
            : i18n.t(ratio > 1 ? 'dataToolResampleUp' : 'dataToolResampleDown')
                .replace('{factor}', formatNumber(ratio > 1 ? ratio : 1 / ratio)));

    const unit = this._resampleUnitLabel(time.kind, time.variable);
    const text = i18n.t('dataToolResampleInfo')
        .replace('{oldStep}', Number.isFinite(sourceStep) ? formatNumber(sourceStep / scale) : '?')
        .replace('{newStep}', formatNumber(step / scale))
        .replace('{unit}', unit)
        .replace('{oldCount}', formatCount(length))
        .replace('{newCount}', formatCount(count))
        .replace('{change}', change);

    return { ok: true, text, step, sourceStep, count, length, ratio };
};

// ─── Committing ───────────────────────────────────────────────────────────

proto.commitResampleTool = async function(options = {}) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    const selection = document.getElementById('outlier-variable')?.value || '';
    if (!data || !outputName) {
        this._setOutlierMessage(() => i18n.t('outlierLoadFileFirst'), 'error');
        return null;
    }
    if (this._isDataToolLazyData(data)) {
        this._setOutlierMessage(() => i18n.t('dataToolLazyDisabled'), 'error');
        return null;
    }

    const time = this._resampleTimeContext(data);
    const config = this._getResampleConfig();
    const plan = this._resamplePlan(data, time);
    if (!plan.ok) {
        this._setOutlierMessage(plan.text, 'error');
        return null;
    }

    const names = this._resampleTargetNames(data, selection);
    if (!names.length) {
        this._setOutlierMessage(() => i18n.t('outlierNoVariables'), 'error');
        return null;
    }

    let resampled;
    try {
        resampled = await this._runResampleOffThread(data, time, config.params, names);
    } catch (err) {
        if (err?.cancelled) return null;
        this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }

    const built = this._buildResampledData(data, time, config, names, resampled);
    const target = this._registerResampleFile(fileId, outputName, built);
    // "and plot" draws the resampled version of what the user was already
    // looking at, when there is one; alphabetically-first is a poor guess.
    if (options.plot) {
        const plotted = names.find(name => this._isDataToolVariablePlotted(fileId, name));
        this._plotResampledVariable(target.fileId, plotted || names[0]);
    }

    const emptyTotal = resampled.emptyCounts.reduce((sum, value) => sum + value, 0);
    // How much of the new series was reached for rather than measured: target
    // samples produced by spanning an interval wider than the file's own Δt. On a
    // file with absent rows this is the number that says the gaps were crossed —
    // which is usually what the user wanted, and never something to leave unsaid.
    const bridgedTotal = (resampled.bridgedCounts || []).reduce((sum, value) => sum + value, 0);
    const bridgedPerVariable = names.length ? Math.round(bridgedTotal / names.length) : 0;
    // The counterpart: samples deliberately left NaN because the source had no
    // rows there. Reported just as loudly, because it is the number the user needs
    // in order to know there is a second step to take.
    const gapLeftTotal = (resampled.gapLeftCounts || []).reduce((sum, value) => sum + value, 0);
    const gapLeftPerVariable = names.length ? Math.round(gapLeftTotal / names.length) : 0;
    this._setOutlierMessage(() => {
        const one = names.length === 1;
        const key = target.replaced
            ? (one ? 'dataToolResampleUpdatedOne' : 'dataToolResampleUpdated')
            : (one ? 'dataToolResampleCreatedOne' : 'dataToolResampleCreated');
        const base = i18n.t(key)
            .replace('{name}', outputName)
            .replace('{count}', formatCount(built.metadata.numTimesteps))
            .replace('{variables}', String(names.length));
        // Holes are reported, not hidden: a resample that came out 5 % missing
        // looks identical to a clean one on the plot until you zoom in on it.
        const holes = emptyTotal > 0
            ? i18n.t(emptyTotal === 1 ? 'dataToolResampleHolesOne' : 'dataToolResampleHoles')
                .replace('{count}', formatCount(emptyTotal))
            : '';
        const bridged = bridgedPerVariable > 0
            ? i18n.t(bridgedPerVariable === 1 ? 'dataToolResampleBridgedOne' : 'dataToolResampleBridged')
                .replace('{count}', formatCount(bridgedPerVariable))
            : '';
        const left = gapLeftPerVariable > 0
            ? i18n.t(gapLeftPerVariable === 1 ? 'dataToolResampleGapLeftOne' : 'dataToolResampleGapLeft')
                .replace('{count}', formatCount(gapLeftPerVariable))
            : '';
        return [base, bridged, left, holes].filter(Boolean).join(' ');
    }, emptyTotal > 0 ? 'error' : 'ok');

    this._clearDataToolDraft({ keepMessage: true });
    this._syncDataTools();
    return { fileId: target.fileId, name: outputName, tool: 'resample', count: built.metadata.numTimesteps };
};

// Which variables ride along. Everything numeric and plottable, or the one the
// picker names — strings, booleans and the abscissa itself never do (the axis is
// rebuilt, not resampled; a string has no value between two samples).
//
// A variable shorter than the axis (a MATLAB matrix column, say) is left out
// rather than resampled: it is sampled on its own index range, and stretching
// that over the file's timestamps would time-stamp it wrongly.
proto._resampleTargetNames = function(data, selection) {
    const length = Number(this._resampleTimeContext(data).values?.length) || 0;
    const fits = ([, variable]) => !length || Number(variable?.data?.length) === length;
    const entries = this._getDataToolSourceEntries(data, 'resample').filter(fits);
    if (selection && selection !== RESAMPLE_ALL_VARIABLES) {
        return entries.some(([name]) => name === selection) ? [selection] : [];
    }
    return entries.map(([name]) => name);
};

proto._runResampleOffThread = async function(data, time, params, names) {
    const kind = time.kind;
    const gridParams = this._resampleGridParams(params, kind);
    const length = Number(time.values?.length)
        || Number(data.variables[names[0]]?.data?.length)
        || 0;
    const usableTime = time.values && time.values.length === length ? time.values : null;

    // Rebuilt on every call, never reused: posting with a transfer list neuters
    // the buffers on this side, so a worker attempt that has to fall back cannot
    // hand the inline path the same arrays it just gave away.
    const payload = () => ({
        columns: names.map(name => kernelShared.copyFloat64(data.variables[name]?.data || [])),
        time: { values: usableTime ? kernelShared.copyFloat64(usableTime) : null, kind },
        params: gridParams,
    });

    const pool = getComputePool();
    if (!pool?.available) return runResample(payload());

    const input = payload();
    const transfer = input.columns.map(column => column.buffer);
    if (input.time.values) transfer.push(input.time.values.buffer);
    try {
        return await pool.run('dataTool:resample', input, { transfer, key: 'dataTool:resample' });
    } catch (err) {
        if (err?.cancelled) throw err;
        if (err?.workerUnavailable) return runResample(payload());
        throw translateKernelError(err);
    }
};

// ─── The new dataset ──────────────────────────────────────────────────────

proto._buildResampledData = function(sourceData, time, config, names, resampled) {
    const { grid, columns, step } = resampled;
    const kind = time.kind;
    const scale = this._resampleAxisScale(kind);
    const timeName = time.name || 'time';
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
        source: 'resample',
    };
    if (kind === 'datetime') {
        abscissa.timeKind = 'datetime';
        // The grid is uniform by construction, so the "stalled axis" fallback that
        // pushes an irregular datetime column to an index display cannot apply.
        abscissa.timeDisplayMode = 'calendar';
        abscissa.timeOriginMs = grid[0];
        abscissa.description = abscissa.description || '[datetime]';
    } else if (kind === 'index') {
        // A resampled index axis is no longer a row count — the values are
        // fractional row positions — so it is published as the plain numbers it
        // now holds rather than as an index the app would renumber.
        abscissa.description = abscissa.description || '[sample]';
    }
    variables[timeName] = abscissa;

    for (let i = 0; i < names.length; i++) {
        const source = sourceData.variables[names[i]];
        const values = columns[i];
        variables[names[i]] = {
            name: names[i],
            data: values,
            description: source?.description || '',
            kind: 'variable',
            dataType: this.parser._detectDataType(values, 'variable'),
            isConstant: this.parser._isConstantValues(values),
            interpolation: source?.interpolation || 'linear',
            negate: false,
            source: 'resample',
        };
    }

    // Parameters are constants: they have no sampling to change, so they come
    // across untouched rather than being dropped from the copy.
    for (const [name, variable] of Object.entries(sourceData.variables || {})) {
        if (variable?.kind !== 'parameter' || variables[name]) continue;
        variables[name] = { ...variable, source: 'resample' };
    }

    const metadata = {
        numVariables: Object.keys(variables).length,
        numParams: Object.values(variables).filter(v => v.kind === 'parameter').length,
        numTimevarying: names.length,
        numTimesteps: grid.length,
        timeStart: grid[0],
        timeEnd: grid[grid.length - 1],
        timeName,
        timeKind: kind === 'datetime' ? 'datetime' : 'numeric',
        timeDisplayMode: kind === 'datetime' ? 'calendar' : 'numeric',
        timeOriginMs: kind === 'datetime' ? grid[0] : 0,
        resample: {
            method: config.params.method,
            gridMode: config.params.gridMode,
            gapPolicy: config.params.gapPolicy,
            step: step / scale,
            sourceKind: kind,
        },
    };

    return {
        filename: '',
        metadata,
        variables,
        tree: this.parser._buildTree(variables),
    };
};

// Register (or refresh) the file the resampled data lives in. Same output name
// as a previous run ⇒ that file is rewritten in place, so re-running with a
// different Δt does not leave a trail of near-duplicate files behind.
proto._registerResampleFile = function(sourceFileId, name, data) {
    const existingId = this._findResampleFileByName(name);
    if (existingId) {
        const entry = this.files.get(existingId);
        if (entry) entry.syntheticBytes = () => this._resampleCsvBytes(data);
        this.plotManager.updateFileData(existingId, data);
        this.plotManager.setActiveFile(existingId);
        this._renderFilesList();
        this._clearVariableSelection();
        this.renderVariablesTree(data.tree);
        this._updateActionButtons();
        return { fileId: existingId, replaced: true };
    }

    const fileId = `f${this._nextFileId++}`;
    const transform = this._defaultFileTransform();
    this.files.set(fileId, {
        file: null,
        fileHandle: null,
        localPath: '',
        temporaryParquetPath: '',
        buffer: null,
        contentHash: '',
        name,
        // The bytes below really are CSV, so a project session saves this file
        // and reloads it through the ordinary CSV path on restore.
        extension: '.csv',
        transform,
        excel: null,
        matlab: null,
        resampledFrom: sourceFileId,
        syntheticBytes: () => this._resampleCsvBytes(data),
    });
    this.plotManager.addFile(fileId, name, data, transform);
    document.getElementById('drop-zone')?.classList.remove('active');
    this._updateTopBar?.();
    this._renderFilesList();
    this._clearVariableSelection();
    this.renderVariablesTree(data.tree);
    this._updateActionButtons();
    return { fileId, replaced: false };
};

proto._findResampleFileByName = function(name) {
    for (const [fileId, entry] of this.files) {
        if (entry?.resampledFrom !== undefined && entry.name === name) return fileId;
    }
    return null;
};

proto._plotResampledVariable = function(fileId, name) {
    if (!name) return;
    this.plotManager.setActiveFile(fileId);
    // An empty panel first: the new file has its own time axis, and dropping it
    // onto a panel already drawing the original would trip the incompatible-axis
    // guard rather than show anything.
    let panelId = null;
    for (const [id, plot] of this.plotManager.plots) {
        if (plot.mode === 'timeseries' && !plot.traces.length) { panelId = id; break; }
    }
    if (panelId === null) {
        const first = document.querySelector('.layout-panel');
        panelId = first?.dataset.id ?? null;
    }
    if (panelId === null) return;
    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    if (panelEl) this.plotManager.addTrace(panelId, name, panelEl);
};

// ─── Serialization ────────────────────────────────────────────────────────
// Saving a project session reads the bytes of every open file. A dataset built
// in memory has none, so it makes them on demand — and it makes CSV, because
// that is the format the restore path can read straight back.

proto._resampleCsvBytes = function(data) {
    const timeName = data?.metadata?.timeName;
    const abscissa = data?.variables?.[timeName];
    const rows = abscissa?.data?.length || 0;
    const columns = Object.entries(data?.variables || {})
        .filter(([name, variable]) => name !== timeName && variable?.kind !== 'parameter');
    if (!rows) throw new Error('Resampled dataset is empty');
    // ~2 GB of text is not a file anyone wants written into a session zip, and
    // failing here is far kinder than an out-of-memory crash mid-save.
    if (rows * (columns.length + 1) > 60_000_000) throw new Error('Resampled dataset is too large to serialize');

    const isDatetime = data.metadata?.timeKind === 'datetime';
    const parts = [[timeName, ...columns.map(([name]) => name)].join(',')];
    for (let r = 0; r < rows; r++) {
        const cells = new Array(columns.length + 1);
        const t = abscissa.data[r];
        cells[0] = isDatetime
            ? (Number.isFinite(t) ? new Date(t).toISOString() : '')
            : formatCell(t);
        for (let c = 0; c < columns.length; c++) cells[c + 1] = formatCell(columns[c][1].data?.[r]);
        parts.push(cells.join(','));
    }
    return new TextEncoder().encode(`${parts.join('\n')}\n`);
};

}

function formatCell(value) {
    return Number.isFinite(value) ? String(value) : '';
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '?';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e6 || abs < 1e-4) return n.toExponential(3);
    return String(Number(n.toPrecision(6)));
}

function formatCount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : '?';
}
