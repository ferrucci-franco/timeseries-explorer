import i18n from '../../i18n/index.js';

const OUTLIER_METHODS = new Set(['spike', 'bounds', 'iqr']);
const OUTLIER_REPLACEMENTS = new Set(['nan', 'interpolate']);

export function installDataToolsMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.initDataTools = function() {
    const toolSelect = document.getElementById('data-tool-select');
    const sourceSelect = document.getElementById('outlier-variable');
    const outputInput = document.getElementById('outlier-output-name');
    const methodSelect = document.getElementById('outlier-method');
    const helpBtn = document.getElementById('outlier-help-toggle');
    const resetBtn = document.getElementById('outlier-reset');
    if (!toolSelect || !sourceSelect || !outputInput || !methodSelect) return;

    toolSelect.value = '';
    toolSelect.addEventListener('change', () => {
        this._setOutlierMessage('', '');
        this._syncDataTools();
        this._scheduleOutlierAutoApply();
    });
    sourceSelect.addEventListener('change', () => {
        outputInput.value = this._suggestOutlierOutputName(sourceSelect.value);
        this._setOutlierMessage('', '');
        this._syncDataTools();
        this._scheduleOutlierAutoApply({ immediate: true });
    });
    outputInput.addEventListener('input', () => {
        this._syncDataTools();
        this._scheduleOutlierAutoApply();
    });
    methodSelect.addEventListener('change', () => this._handleOutlierMethodChange());

    this._outlierParameterInputs().forEach(input => {
        input.addEventListener('input', () => this._handleOutlierLiveChange());
        input.addEventListener('change', () => this._scheduleOutlierAutoApply({ immediate: true }));
    });
    document.querySelectorAll('input[name="outlier-replacement"], input[name="outlier-target"]').forEach(input => {
        input.addEventListener('change', () => this._handleOutlierOptionChange());
    });
    helpBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleOutlierHelpPopover();
    });
    resetBtn?.addEventListener('click', () => this.resetOutlierTool());
    this._syncDataTools();
};

proto._outlierParameterInputs = function() {
    return [
        'outlier-spike-sensitivity',
        'outlier-lower-bound',
        'outlier-upper-bound',
    ]
        .map(id => document.getElementById(id))
        .filter(Boolean);
};

proto._syncDataTools = function() {
    const toolSelect = document.getElementById('data-tool-select');
    const form = document.getElementById('remove-outliers-tool');
    const sourceSelect = document.getElementById('outlier-variable');
    const outputWrap = document.getElementById('outlier-output-wrap');
    const outputInput = document.getElementById('outlier-output-name');
    const methodSelect = document.getElementById('outlier-method');
    const resetBtn = document.getElementById('outlier-reset');
    if (!toolSelect || !form || !sourceSelect || !outputInput || !methodSelect) return;

    const isRemoveOutliers = toolSelect.value === 'removeOutliers';
    const targetMode = this._getOutlierTargetMode();
    const createsVariable = targetMode === 'create';
    form.classList.toggle('collapsed', !isRemoveOutliers);
    outputWrap?.classList.toggle('collapsed', !createsVariable);
    this._syncOutlierMethodControls();

    const previous = sourceSelect.value;
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const lazy = this._isDataToolLazyData(data);
    const entries = lazy ? [] : this._getOutlierSourceEntries(data);

    sourceSelect.innerHTML = '';
    if (lazy) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('dataToolLazyUnavailable');
        sourceSelect.appendChild(option);
    } else if (!entries.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('outlierNoVariables');
        sourceSelect.appendChild(option);
    } else {
        for (const [name, variable] of entries) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = this._outlierSourceLabel(name, variable);
            option.classList.toggle('data-tool-modified', !!variable.dataToolModified);
            sourceSelect.appendChild(option);
        }
    }

    const keptPrevious = entries.some(([name]) => name === previous);
    if (keptPrevious) sourceSelect.value = previous;
    if ((!keptPrevious || !outputInput.value.trim()) && sourceSelect.value) {
        outputInput.value = this._suggestOutlierOutputName(sourceSelect.value);
    }

    const hasSource = isRemoveOutliers && !lazy && !!sourceSelect.value && !!data?.variables?.[sourceSelect.value];
    const hasOutput = !createsVariable || !!outputInput.value.trim();
    const hasValidConfig = !hasSource || !!this._tryReadOutlierConfig();
    const resetTarget = hasSource
        ? this._findOutlierResetDefinition(fileId, {
            sourceName: sourceSelect.value,
            outputName: outputInput.value.trim(),
            targetMode,
        })
        : null;

    sourceSelect.disabled = !isRemoveOutliers || lazy || !entries.length;
    outputInput.disabled = !hasSource || !createsVariable;
    methodSelect.disabled = !hasSource;
    this._outlierParameterInputs().forEach(input => { input.disabled = !hasSource; });
    document.querySelectorAll('input[name="outlier-replacement"], input[name="outlier-target"]').forEach(input => { input.disabled = !hasSource; });
    if (resetBtn) resetBtn.disabled = !resetTarget;
    form.classList.toggle('data-tool-invalid', hasSource && (!hasOutput || !hasValidConfig));

    if (isRemoveOutliers && lazy) {
        this._setOutlierMessage(i18n.t('dataToolLazyDisabled'), 'error');
    }
};

proto._syncOutlierMethodControls = function() {
    const method = this._getOutlierDetectorMethod();
    document.querySelectorAll('.outlier-method-controls').forEach(el => {
        el.classList.toggle('collapsed', el.dataset.outlierMethod !== method);
    });
    const sliderValue = document.getElementById('outlier-spike-sensitivity-value');
    if (sliderValue) sliderValue.textContent = this._formatOutlierNumber(this._getOutlierSensitivity(), 0);
};

proto._handleOutlierMethodChange = function() {
    this._setOutlierMessage('', '');
    this._syncDataTools();
    this._scheduleOutlierAutoApply({ immediate: true });
};

proto._handleOutlierOptionChange = function() {
    this._syncDataTools();
    this._scheduleOutlierAutoApply({ immediate: true });
};

proto._getOutlierSourceEntries = function(data) {
    return Object.entries(data?.variables || {})
        .filter(([, variable]) => {
            if (!variable || variable.kind === 'abscissa' || variable.kind === 'parameter') return false;
            if (variable.plottable === false) return false;
            if (variable.dataType === 'string' || variable.dataType === 'boolean') return false;
            return this._isOutlierDataSeries(variable.data);
        })
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
};

proto._outlierSourceLabel = function(name, variable) {
    return variable?.dataToolModified ? `${name} ${i18n.t('outlierModifiedSuffix')}` : name;
};

proto._suggestOutlierOutputName = function(sourceName) {
    if (!sourceName) return '';
    const existing = this._findDataToolCreateDefinitionName(this.activeFileId, sourceName);
    if (existing) return existing;
    return this._uniqueDataToolVariableName(`${sourceName} no_outliers`);
};

proto.applyOutlierTool = function(options = {}) {
    const context = this._getOutlierContext({ quiet: options.silent });
    if (!context) return null;
    let config;
    try {
        config = this._getOutlierConfig();
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
    return context.targetMode === 'create'
        ? this._applyOutlierCreateMode(context, config, options)
        : this._applyOutlierModifyMode(context, config, options);
};

proto._applyOutlierCreateMode = function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable, outputName } = context;
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const previousName = this._findDataToolCreateDefinitionName(fileId, sourceName, outputName);
    const existing = data.variables[outputName];
    const existingDefinition = definitions?.get(outputName);

    try {
        if (existing && !existingDefinition) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
        if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));
        if (previousName && previousName !== outputName) {
            delete data.variables[previousName];
            definitions?.delete(previousName);
        }

        const result = this._buildOutlierResult(sourceVariable.data, sourceVariable, {
            ...config,
            sourceName,
            targetName: outputName,
            targetMode: 'create',
        });
        data.variables[outputName] = result.variable;
        this._storeDataToolDefinition(fileId, outputName, {
            name: outputName,
            tool: 'removeOutliers',
            targetMode: 'create',
            sourceName,
            method: config.method,
            params: this._cloneOutlierParams(config.params),
            replacement: config.replacement,
            variable: result.variable,
        });

        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._syncDataTools();
        if (!options.silent) {
            this._setOutlierMessage(
                i18n.t(existingDefinition ? 'outlierUpdated' : 'outlierCreated')
                    .replace('{count}', String(result.count))
                    .replace('{name}', outputName),
                'ok'
            );
        }
        return result;
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

proto._applyOutlierModifyMode = function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable } = context;
    const existingDefinition = this.dataToolVariablesByFile?.get(fileId)?.get(sourceName);
    const originalData = existingDefinition?.targetMode === 'modify' && existingDefinition.originalData
        ? Array.from(existingDefinition.originalData)
        : Array.from(sourceVariable.data);

    try {
        const result = this._buildOutlierResult(originalData, sourceVariable, {
            ...config,
            sourceName,
            targetName: sourceName,
            targetMode: 'modify',
        });
        const variable = data.variables[sourceName];
        variable.data = result.variable.data;
        variable.dataType = result.variable.dataType;
        variable.isConstant = result.variable.isConstant;
        variable.dataToolModified = true;
        variable.dataTool = result.variable.dataTool;

        this._storeDataToolDefinition(fileId, sourceName, {
            name: sourceName,
            tool: 'removeOutliers',
            targetMode: 'modify',
            sourceName,
            method: config.method,
            params: this._cloneOutlierParams(config.params),
            replacement: config.replacement,
            originalData: Array.from(originalData),
            variable,
        });

        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._syncDataTools();
        if (!options.silent) {
            this._setOutlierMessage(
                i18n.t(existingDefinition ? 'outlierModifiedUpdated' : 'outlierModified')
                    .replace('{count}', String(result.count))
                    .replace('{name}', sourceName),
                'ok'
            );
        }
        return result;
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

proto._handleOutlierLiveChange = function() {
    this._syncOutlierMethodControls();
    this._scheduleOutlierAutoApply();
};

proto._scheduleOutlierAutoApply = function(options = {}) {
    if (this._outlierAutoApplyTimer) clearTimeout(this._outlierAutoApplyTimer);
    const delay = options.immediate ? 0 : 350;
    this._outlierAutoApplyTimer = setTimeout(() => {
        this._outlierAutoApplyTimer = null;
        this._autoApplyOutlierTool();
    }, delay);
};

proto._autoApplyOutlierTool = function() {
    const toolSelect = document.getElementById('data-tool-select');
    if (toolSelect?.value !== 'removeOutliers') return;
    const context = this._getOutlierContext({ quiet: true });
    if (!context) {
        this._syncDataTools();
        return;
    }

    let config;
    try {
        config = this._getOutlierConfig();
    } catch (err) {
        this._setOutlierMessage(err?.message || String(err), 'error');
        this._syncDataTools();
        return;
    }

    const result = this.applyOutlierTool({ silent: true });
    if (result) this._setOutlierMessage(
        i18n.t('outlierAutoApplied').replace('{count}', String(result.count)),
        result.count ? 'ok' : ''
    );
    this._syncDataTools();
};

proto.resetOutlierTool = function(options = {}) {
    if (this._outlierAutoApplyTimer) {
        clearTimeout(this._outlierAutoApplyTimer);
        this._outlierAutoApplyTimer = null;
    }

    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    const targetMode = this._getOutlierTargetMode();
    const resetTarget = this._findOutlierResetDefinition(fileId, { sourceName, outputName, targetMode });

    if (!fileId || !data || !resetTarget) {
        if (!options.silent) this._setOutlierMessage(i18n.t('outlierResetNothing'), '');
        this._syncDataTools();
        return false;
    }

    const { name, definition } = resetTarget;
    if (definition.targetMode === 'modify') {
        return this._resetOutlierModifiedVariable(fileId, data, name, definition, options);
    }
    return this._resetOutlierCreatedVariable(fileId, data, name, options);
};

proto._resetOutlierModifiedVariable = function(fileId, data, name, definition, options = {}) {
    const variable = data.variables?.[name];
    const originalData = Array.from(definition.originalData || []);
    if (!variable || !originalData.length) {
        if (!options.silent) this._setOutlierMessage(i18n.t('outlierResetNothing'), '');
        this._syncDataTools();
        return false;
    }

    variable.data = originalData;
    variable.dataType = this.parser._detectDataType(originalData, 'variable');
    variable.isConstant = this.parser._isConstantValues(originalData);
    delete variable.dataToolModified;
    delete variable.dataTool;
    this._deleteDataToolDefinition(fileId, name);

    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree();
    this._rebuildPlotsUsingVariable?.(fileId, name);
    if (!options.silent) {
        this._setOutlierMessage(i18n.t('outlierResetModified').replace('{name}', name), 'ok');
    }
    this._syncDataTools();
    return true;
};

proto._resetOutlierCreatedVariable = function(fileId, data, name, options = {}) {
    if (!data.variables?.[name]) {
        this._deleteDataToolDefinition(fileId, name);
        this._syncDataTools();
        return false;
    }

    delete data.variables[name];
    this.derivedByFile?.get(fileId)?.delete(name);
    this._deleteDataToolDefinition(fileId, name);
    this._removeDataToolVariableFromPlots(fileId, name);
    this.plotManager.updateFileData(fileId, data);
    this._clearVariableSelection?.();
    this._renderFilteredTree();
    if (!options.silent) {
        this._setOutlierMessage(i18n.t('outlierResetCreated').replace('{name}', name), 'ok');
    }
    this._syncDataTools();
    return true;
};

proto._buildOutlierResult = function(sourceValues, sourceVariable, config) {
    const values = Array.from(sourceValues || []);
    const outlierIndexes = this._detectOutlierIndexes(values, config.method, config.params);
    const cleaned = config.replacement === 'interpolate'
        ? this._interpolateOutliers(values, outlierIndexes)
        : this._replaceOutliersWithNaN(values, outlierIndexes);

    const variable = {
        ...sourceVariable,
        name: config.targetName,
        data: cleaned,
        description: config.targetMode === 'create'
            ? `Data tool: remove outliers from ${config.sourceName}; ${this._outlierDetectorDescription(config)}; ${config.replacement}`
            : sourceVariable.description,
        kind: 'variable',
        dataType: this.parser._detectDataType(cleaned, 'variable'),
        isConstant: this.parser._isConstantValues(cleaned),
        interpolation: sourceVariable.interpolation || 'linear',
        derived: config.targetMode === 'create' ? true : !!sourceVariable.derived,
        dataToolModified: config.targetMode === 'modify',
        dataTool: {
            tool: 'removeOutliers',
            sourceName: config.sourceName,
            targetMode: config.targetMode,
            method: config.method,
            params: this._cloneOutlierParams(config.params),
            replacement: config.replacement,
            outlierCount: outlierIndexes.length,
            outlierIndexes,
        },
    };
    if (config.targetMode === 'create') {
        delete variable._duckdbCol;
        delete variable.formula;
    }
    return { variable, count: outlierIndexes.length };
};

proto._detectOutlierIndexes = function(values, method, params = {}) {
    if (method === 'bounds') return this._detectBoundsOutliers(values, params);
    if (method === 'iqr') return this._detectIqrOutliers(values, params);
    return this._detectSpikeOutliers(values, params);
};

proto._detectSpikeOutliers = function(values, params = {}) {
    const spike = this._spikeParamsFromSensitivity(params.sensitivity);
    const window = spike.window;
    const threshold = spike.threshold;
    const maxRun = spike.maxRun;
    const half = Math.floor(window / 2);
    const indexes = [];
    const n = Number(values?.length) || 0;

    for (let i = 0; i < n; i++) {
        const value = Number(values[i]);
        if (!Number.isFinite(value)) continue;
        const start = Math.max(0, i - half);
        const end = Math.min(n - 1, i + half);
        const local = [];
        for (let j = start; j <= end; j++) {
            const neighbor = Number(values[j]);
            if (Number.isFinite(neighbor)) local.push(neighbor);
        }
        if (local.length < 3) continue;
        local.sort((a, b) => a - b);
        const median = this._quantileSorted(local, 0.5);
        const deviations = local.map(v => Math.abs(v - median)).sort((a, b) => a - b);
        const mad = this._quantileSorted(deviations, 0.5);
        const scale = mad > 0
            ? 1.4826 * mad
            : this._zeroMadTolerance(median);
        if (Math.abs(value - median) > threshold * scale) indexes.push(i);
    }

    return this._keepReturningOutlierRuns(indexes, values, maxRun, half, threshold);
};

proto._detectBoundsOutliers = function(values, params = {}) {
    const hasLower = Number.isFinite(Number(params.lower));
    const hasUpper = Number.isFinite(Number(params.upper));
    if (!hasLower && !hasUpper) throw new Error(i18n.t('outlierBoundsMissing'));
    const lower = hasLower ? Number(params.lower) : -Infinity;
    const upper = hasUpper ? Number(params.upper) : Infinity;
    if (lower > upper) throw new Error(i18n.t('outlierBoundsInvalid'));

    const indexes = [];
    for (let i = 0; i < (values?.length || 0); i++) {
        const value = Number(values[i]);
        if (Number.isFinite(value) && (value < lower || value > upper)) indexes.push(i);
    }
    return indexes;
};

proto._detectIqrOutliers = function(values, params = {}) {
    const finite = Array.from(values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (finite.length < 4) throw new Error(i18n.t('outlierNotEnoughData'));
    const factor = this._positiveNumber(params.factor ?? params.iqrFactor, 1.5);
    const q1 = this._quantileSorted(finite, 0.25);
    const q3 = this._quantileSorted(finite, 0.75);
    const iqr = q3 - q1;
    const low = iqr > 0 ? q1 - factor * iqr : q1;
    const high = iqr > 0 ? q3 + factor * iqr : q3;

    const indexes = [];
    for (let i = 0; i < (values?.length || 0); i++) {
        const value = Number(values[i]);
        if (Number.isFinite(value) && (value < low || value > high)) indexes.push(i);
    }
    return indexes;
};

proto._keepShortOutlierRuns = function(indexes, maxRun) {
    if (!indexes.length) return indexes;
    const kept = [];
    let run = [indexes[0]];
    const flush = () => {
        if (run.length <= maxRun) kept.push(...run);
    };
    for (let i = 1; i < indexes.length; i++) {
        if (indexes[i] === indexes[i - 1] + 1) {
            run.push(indexes[i]);
        } else {
            flush();
            run = [indexes[i]];
        }
    }
    flush();
    return kept;
};

proto._keepReturningOutlierRuns = function(indexes, values, maxRun, halfWindow, threshold) {
    if (!indexes.length) return indexes;
    const kept = [];
    let run = [indexes[0]];
    const flush = () => {
        if (run.length <= maxRun && this._outlierRunReturns(run, values, halfWindow, threshold, maxRun)) kept.push(...run);
    };
    for (let i = 1; i < indexes.length; i++) {
        if (indexes[i] === indexes[i - 1] + 1) {
            run.push(indexes[i]);
        } else {
            flush();
            run = [indexes[i]];
        }
    }
    flush();
    return kept;
};

proto._outlierRunReturns = function(run, values, halfWindow, threshold, maxRun) {
    const start = run[0];
    const end = run[run.length - 1];
    const left = this._finiteValuesInRange(values, Math.max(0, start - halfWindow), start - 1);
    const right = this._finiteValuesInRange(values, end + 1, Math.min((values?.length || 0) - 1, end + halfWindow));
    if (!left.length || !right.length) return false;

    const leftMedian = this._median(left);
    const rightMedian = this._median(right);
    const surroundings = left.concat(right).sort((a, b) => a - b);
    const surroundingMedian = this._quantileSorted(surroundings, 0.5);
    const deviations = surroundings.map(v => Math.abs(v - surroundingMedian)).sort((a, b) => a - b);
    const mad = this._quantileSorted(deviations, 0.5);
    const scale = mad > 0 ? 1.4826 * mad : this._zeroMadTolerance(surroundingMedian);
    if (Math.abs(leftMedian - rightMedian) > threshold * scale) return false;

    const runValues = run
        .map(index => Number(values[index]))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if (!runValues.length) return false;
    const runMedian = this._quantileSorted(runValues, 0.5);
    const runTolerance = Math.max(threshold * scale, this._zeroMadTolerance(runMedian));
    let expandedStart = start;
    while (expandedStart > 0) {
        const value = Number(values[expandedStart - 1]);
        if (!Number.isFinite(value) || Math.abs(value - runMedian) > runTolerance) break;
        expandedStart--;
    }
    let expandedEnd = end;
    while (expandedEnd + 1 < (values?.length || 0)) {
        const value = Number(values[expandedEnd + 1]);
        if (!Number.isFinite(value) || Math.abs(value - runMedian) > runTolerance) break;
        expandedEnd++;
    }
    if (expandedEnd - expandedStart + 1 > maxRun) return false;
    return Math.abs(runMedian - surroundingMedian) > threshold * scale;
};

proto._finiteValuesInRange = function(values, start, end) {
    const out = [];
    for (let i = start; i <= end; i++) {
        const value = Number(values?.[i]);
        if (Number.isFinite(value)) out.push(value);
    }
    return out;
};

proto._median = function(values) {
    return this._quantileSorted(values.slice().sort((a, b) => a - b), 0.5);
};

proto._replaceOutliersWithNaN = function(values, outlierIndexes) {
    const cleaned = values.slice();
    outlierIndexes.forEach(index => { cleaned[index] = NaN; });
    return cleaned;
};

proto._interpolateOutliers = function(values, outlierIndexes) {
    const cleaned = values.slice();
    const outlierSet = new Set(outlierIndexes);
    outlierIndexes.forEach(index => {
        let left = index - 1;
        while (left >= 0 && (outlierSet.has(left) || !Number.isFinite(Number(values[left])))) left--;
        let right = index + 1;
        while (right < values.length && (outlierSet.has(right) || !Number.isFinite(Number(values[right])))) right++;
        const leftOk = left >= 0 && Number.isFinite(Number(values[left]));
        const rightOk = right < values.length && Number.isFinite(Number(values[right]));
        if (leftOk && rightOk) {
            const ratio = (index - left) / (right - left);
            cleaned[index] = Number(values[left]) + ratio * (Number(values[right]) - Number(values[left]));
        } else {
            cleaned[index] = NaN;
        }
    });
    return cleaned;
};

proto._getOutlierContext = function(options = {}) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    const targetMode = this._getOutlierTargetMode();
    const sourceVariable = data?.variables?.[sourceName];
    if (this._isDataToolLazyData(data)) {
        if (!options.quiet) this._setOutlierMessage(i18n.t('dataToolLazyDisabled'), 'error');
        return null;
    }
    if (!fileId || !data || !sourceVariable || (targetMode === 'create' && !outputName)) {
        if (!options.quiet) this._setOutlierMessage(i18n.t('outlierLoadFileFirst'), 'error');
        return null;
    }
    return { fileId, data, sourceName, sourceVariable, outputName, targetMode };
};

proto._getOutlierConfig = function() {
    const method = this._getOutlierDetectorMethod();
    const params = this._getOutlierParams(method);
    const replacement = this._getOutlierReplacementMethod();
    return { method, params, replacement };
};

proto._tryReadOutlierConfig = function() {
    try {
        return this._getOutlierConfig();
    } catch {
        return null;
    }
};

proto._getOutlierDetectorMethod = function() {
    const value = document.getElementById('outlier-method')?.value;
    return OUTLIER_METHODS.has(value) ? value : 'spike';
};

proto._getOutlierParams = function(method) {
    if (method === 'bounds') {
        const lower = this._optionalNumberFromInput('outlier-lower-bound');
        const upper = this._optionalNumberFromInput('outlier-upper-bound');
        if (lower === null && upper === null) throw new Error(i18n.t('outlierBoundsMissing'));
        if (lower !== null && upper !== null && lower > upper) throw new Error(i18n.t('outlierBoundsInvalid'));
        return { lower, upper };
    }
    if (method === 'iqr') return { factor: this._getOutlierIqrFactor() };
    return { sensitivity: this._getOutlierSensitivity() };
};

proto._optionalNumberFromInput = function(id) {
    const raw = document.getElementById(id)?.value;
    if (raw === '' || raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

proto._getOutlierIqrFactor = function() {
    return this._positiveNumber(document.getElementById('outlier-iqr-factor')?.value, 1.5);
};

proto._getOutlierSensitivity = function() {
    const value = Number(document.getElementById('outlier-spike-sensitivity')?.value);
    if (!Number.isFinite(value)) return 6;
    return Math.max(1, Math.min(10, Math.round(value)));
};

proto._getOutlierReplacementMethod = function() {
    const value = document.querySelector('input[name="outlier-replacement"]:checked')?.value;
    return OUTLIER_REPLACEMENTS.has(value) ? value : 'nan';
};

proto._getOutlierTargetMode = function() {
    return document.querySelector('input[name="outlier-target"]:checked')?.value === 'create'
        ? 'create'
        : 'modify';
};

proto._uniqueDataToolVariableName = function(baseName, fileId = this.activeFileId) {
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const base = String(baseName || 'cleaned').trim() || 'cleaned';
    if (!data?.variables?.[base]) return base;
    let index = 2;
    while (data.variables[`${base} ${index}`]) index++;
    return `${base} ${index}`;
};

proto._dataToolOutputExists = function(fileId, name) {
    return !!fileId && !!name && !!this.dataToolVariablesByFile?.get(fileId)?.has(name);
};

proto._isOutlierDataSeries = function(values) {
    const length = Number(values?.length);
    return Number.isFinite(length) && length > 2;
};

proto._isDataToolLazyData = function(data) {
    return !!data?._duckdb;
};

proto._storeDataToolDefinition = function(fileId, name, definition) {
    if (!this.dataToolVariablesByFile) this.dataToolVariablesByFile = new Map();
    if (!this.dataToolVariablesByFile.has(fileId)) this.dataToolVariablesByFile.set(fileId, new Map());
    this.dataToolVariablesByFile.get(fileId).set(name, this._normalizeDataToolDefinition(definition));
};

proto._deleteDataToolDefinition = function(fileId, name) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions) return;
    definitions.delete(name);
    if (!definitions.size) this.dataToolVariablesByFile.delete(fileId);
};

proto._findOutlierResetDefinition = function(fileId, options = {}) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions?.size) return null;
    const sourceName = options.sourceName || '';
    const outputName = options.outputName || '';
    const targetMode = options.targetMode || 'modify';
    const normalizeEntry = (name, rawDefinition) => {
        if (!rawDefinition) return null;
        const definition = this._normalizeDataToolDefinition(rawDefinition);
        if (definition.tool !== 'removeOutliers') return null;
        return { name, definition };
    };

    if (targetMode === 'modify') {
        const modified = normalizeEntry(sourceName, definitions.get(sourceName));
        if (modified?.definition.targetMode === 'modify') return modified;
    }

    if (targetMode === 'create') {
        const createdFromOutput = normalizeEntry(outputName, definitions.get(outputName));
        if (createdFromOutput?.definition.targetMode === 'create') return createdFromOutput;
    }

    const direct = normalizeEntry(sourceName, definitions.get(sourceName));
    if (direct) return direct;

    for (const [name, rawDefinition] of definitions) {
        const entry = normalizeEntry(name, rawDefinition);
        if (entry?.definition.targetMode === 'create' && entry.definition.sourceName === sourceName) return entry;
    }
    return null;
};

proto._removeDataToolVariableFromPlots = function(fileId, name) {
    for (const [panelId, plot] of this.plotManager.plots) {
        const beforeTs = plot.traces.length;
        const beforePh = plot.phaseTraces.length;
        plot.traces = plot.traces.filter(t => !(t.fileId === fileId && t.varName === name));
        plot.phaseTraces = plot.phaseTraces.filter(t => !(t.fileId === fileId && (t.x === name || t.y === name || t.z === name)));
        if (beforeTs !== plot.traces.length || beforePh !== plot.phaseTraces.length) {
            this.plotManager._rebuildPanel(panelId);
        }
    }
};

proto._reapplyDataToolVariables = function(fileId, data) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions) return;
    if (this._isDataToolLazyData(data)) {
        console.warn('Data tools are disabled for DuckDB-backed lazy files.');
        return;
    }
    for (const [name, rawDefinition] of definitions) {
        const definition = this._normalizeDataToolDefinition(rawDefinition);
        definitions.set(name, definition);
        try {
            if (definition.tool !== 'removeOutliers') continue;
            const sourceVariable = data.variables?.[definition.sourceName];
            if (!sourceVariable) throw new Error(`Unknown source variable "${definition.sourceName}".`);
            const targetMode = definition.targetMode || 'create';
            const result = this._buildOutlierResult(sourceVariable.data, sourceVariable, {
                sourceName: definition.sourceName,
                targetName: name,
                targetMode,
                method: definition.method,
                params: this._cloneOutlierParams(definition.params),
                replacement: definition.replacement,
            });
            if (targetMode === 'modify') {
                const originalData = Array.from(sourceVariable.data);
                sourceVariable.data = result.variable.data;
                sourceVariable.dataType = result.variable.dataType;
                sourceVariable.isConstant = result.variable.isConstant;
                sourceVariable.dataToolModified = true;
                sourceVariable.dataTool = result.variable.dataTool;
                definition.originalData = originalData;
                definition.variable = sourceVariable;
            } else {
                data.variables[name] = result.variable;
                definition.variable = result.variable;
            }
        } catch (err) {
            console.warn(`Could not reapply data tool variable ${name}:`, err);
        }
    }
};

proto._copyDataToolDefinitions = function(sourceId, targetId) {
    const sourceDefinitions = this.dataToolVariablesByFile?.get(sourceId);
    if (!sourceDefinitions?.size) return;
    const targetDefinitions = new Map();
    for (const [name, definition] of sourceDefinitions) {
        const normalized = this._normalizeDataToolDefinition(definition);
        targetDefinitions.set(name, {
            name,
            tool: normalized.tool,
            targetMode: normalized.targetMode || 'create',
            sourceName: normalized.sourceName,
            method: normalized.method,
            params: this._cloneOutlierParams(normalized.params),
            replacement: normalized.replacement,
            variable: null,
        });
    }
    this.dataToolVariablesByFile.set(targetId, targetDefinitions);
};

proto._clearDataToolDefinitions = function(fileId = null) {
    if (!this.dataToolVariablesByFile) return;
    if (fileId) this.dataToolVariablesByFile.delete(fileId);
    else this.dataToolVariablesByFile.clear();
    this._syncDataTools?.();
};

proto._normalizeDataToolDefinition = function(definition = {}) {
    let method = OUTLIER_METHODS.has(definition.method) ? definition.method : '';
    let replacement = OUTLIER_REPLACEMENTS.has(definition.replacement) ? definition.replacement : '';

    // Compatibility with the recovered prototype, where `method` meant
    // replacement and the detector was always IQR.
    if (!method && Number.isFinite(Number(definition.iqrFactor))) method = 'iqr';
    if (!replacement && OUTLIER_REPLACEMENTS.has(definition.method)) replacement = definition.method;

    method ||= 'spike';
    if (method === 'hampel') method = 'spike';
    replacement ||= 'nan';
    const params = this._normalizeOutlierParams(method, definition.params || {
        factor: definition.iqrFactor,
        iqrFactor: definition.iqrFactor,
    });

    return {
        ...definition,
        tool: definition.tool || 'removeOutliers',
        targetMode: definition.targetMode || 'create',
        method,
        params,
        replacement,
    };
};

proto._normalizeOutlierParams = function(method, params = {}) {
    if (method === 'bounds') {
        const lower = Number.isFinite(Number(params.lower)) ? Number(params.lower) : null;
        const upper = Number.isFinite(Number(params.upper)) ? Number(params.upper) : null;
        return { lower, upper };
    }
    if (method === 'iqr') {
        return { factor: this._positiveNumber(params.factor ?? params.iqrFactor, 1.5) };
    }
    if (Number.isFinite(Number(params.sensitivity))) return { sensitivity: this._normalizeSensitivity(params.sensitivity) };
    if (Number.isFinite(Number(params.threshold))) return { sensitivity: this._sensitivityFromLegacyThreshold(params.threshold) };
    return { sensitivity: 6 };
};

proto._cloneOutlierParams = function(params = {}) {
    return JSON.parse(JSON.stringify(params));
};

proto._serializeDataToolDefinitions = function(fileId) {
    return [...(this.dataToolVariablesByFile?.get(fileId) || new Map()).values()]
        .map(item => {
            const definition = this._normalizeDataToolDefinition(item);
            return {
                name: definition.name,
                tool: definition.tool,
                targetMode: definition.targetMode || 'create',
                sourceName: definition.sourceName,
                method: definition.method,
                params: this._cloneOutlierParams(definition.params),
                replacement: definition.replacement,
            };
        });
};

proto._resetDataToolPicker = function() {
    if (this._outlierAutoApplyTimer) {
        clearTimeout(this._outlierAutoApplyTimer);
        this._outlierAutoApplyTimer = null;
    }
    const toolSelect = document.getElementById('data-tool-select');
    if (toolSelect) toolSelect.value = '';
    this._toggleOutlierHelpPopover?.(false);
    this._setOutlierMessage('', '');
    this._syncDataTools?.();
};

proto._toggleOutlierHelpPopover = function(show) {
    const popover = document.getElementById('outlier-help-popover');
    const button = document.getElementById('outlier-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
};

proto._setOutlierMessage = function(message, type) {
    const el = document.getElementById('outlier-message');
    if (!el) return;
    el.textContent = message;
    el.className = `derived-message data-tool-message${type ? ' ' + type : ''}`;
};

proto._outlierDetectorDescription = function(config) {
    if (config.method === 'bounds') {
        const lower = config.params.lower ?? '-inf';
        const upper = config.params.upper ?? 'inf';
        return `bounds [${lower}, ${upper}]`;
    }
    if (config.method === 'iqr') {
        return `IQR factor ${this._formatOutlierNumber(config.params.factor, 1)}`;
    }
    return `spike/dropout sensitivity ${config.params.sensitivity}`;
};

proto._quantileSorted = function(sorted, p) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = sorted[base + 1];
    return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
};

proto._zeroMadTolerance = function(median) {
    return Math.max(Number.EPSILON * 32 * Math.max(1, Math.abs(Number(median) || 0)), 1e-12);
};

proto._normalizeOddInteger = function(value, fallback, min, max) {
    let n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = fallback;
    n = Math.max(min, Math.min(max, n));
    if (n % 2 === 0) n += n >= max ? -1 : 1;
    return n;
};

proto._positiveNumber = function(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

proto._normalizeSensitivity = function(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 6;
};

proto._spikeParamsFromSensitivity = function(sensitivity) {
    const level = this._normalizeSensitivity(sensitivity);
    const maxRuns = [1, 2, 3, 4, 5, 6, 8, 10, 13, 16];
    return {
        window: 51,
        threshold: Math.max(4, 12 - level),
        maxRun: maxRuns[level - 1],
    };
};

proto._sensitivityFromLegacyThreshold = function(threshold) {
    return this._normalizeSensitivity(12 - this._positiveNumber(threshold, 6));
};

proto._findDataToolCreateDefinitionName = function(fileId, sourceName, exceptName = '') {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions || !sourceName) return '';
    for (const [name, definition] of definitions) {
        const normalized = this._normalizeDataToolDefinition(definition);
        if (name === exceptName) continue;
        if (normalized.tool === 'removeOutliers'
            && normalized.targetMode === 'create'
            && normalized.sourceName === sourceName) {
            return name;
        }
    }
    return '';
};

proto._formatOutlierNumber = function(value, decimals = 1) {
    return Number(value).toFixed(decimals).replace(/\.0$/, '');
};

}
