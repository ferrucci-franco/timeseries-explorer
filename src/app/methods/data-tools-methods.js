import i18n from '../../i18n/index.js';

const DATA_TOOLS = new Set(['removeOutliers', 'derivative', 'integrate', 'movingAverage']);
const OUTLIER_METHODS = new Set(['spike', 'bounds', 'iqr']);
const OUTLIER_REPLACEMENTS = new Set(['nan', 'interpolate']);
const DERIVATIVE_METHODS = new Set(['centered', 'forward', 'backward']);
const INTEGRAL_METHODS = new Set(['trapezoidal', 'rectangular']);

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
    this._clearDataToolTargetMode();
    toolSelect.addEventListener('change', () => {
        sourceSelect.value = '';
        outputInput.value = '';
        this._clearDataToolTargetMode();
        this._setOutlierMessage('', '');
        this._syncDataTools();
    });
    sourceSelect.addEventListener('change', () => {
        outputInput.value = this._suggestDataToolOutputName(sourceSelect.value);
        this._clearDataToolTargetMode();
        this._setOutlierMessage('', '');
        this._syncDataTools();
        this._scheduleDataToolAutoApply({ immediate: true });
    });
    outputInput.addEventListener('input', () => {
        this._syncDataTools();
        this._scheduleDataToolAutoApply();
    });
    methodSelect.addEventListener('change', () => this._handleOutlierMethodChange());
    document.getElementById('derivative-method')?.addEventListener('change', () => this._handleDataToolOptionChange());
    document.getElementById('integral-method')?.addEventListener('change', () => this._handleDataToolOptionChange());

    document.getElementById('moving-average-window-slider')?.addEventListener('input', (event) => {
        const numeric = document.getElementById('moving-average-window');
        if (numeric) numeric.value = event.target.value;
        this._syncDataTools();
        this._scheduleDataToolAutoApply({ immediate: true });
    });
    document.getElementById('moving-average-window')?.addEventListener('input', () => {
        this._syncMovingAverageSliderFromInput();
        this._syncDataTools();
        this._scheduleDataToolAutoApply({ immediate: true });
    });

    this._dataToolParameterInputs().forEach(input => {
        const isBound = input.id === 'outlier-lower-bound' || input.id === 'outlier-upper-bound';
        if (isBound) {
            // Number inputs commit on blur/Enter only. Auto-applying every
            // keystroke would run the tool on partial values (e.g. the "1" of
            // "10"), which can cut most of the signal and freeze the app.
            input.addEventListener('input', () => this._syncOutlierMethodControls());
            input.addEventListener('change', () => this._scheduleDataToolAutoApply({ immediate: true }));
        } else {
            input.addEventListener('input', () => this._handleOutlierLiveChange({ immediate: true }));
            input.addEventListener('change', () => this._scheduleDataToolAutoApply({ immediate: true }));
        }
    });
    document.querySelectorAll('input[name="outlier-replacement"], input[name="outlier-target"]').forEach(input => {
        input.addEventListener('change', () => this._handleDataToolOptionChange());
    });
    helpBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleOutlierHelpPopover();
    });
    resetBtn?.addEventListener('click', () => this.resetOutlierTool());
    this._syncDataTools();
};

proto._dataToolParameterInputs = function() {
    return [
        'outlier-spike-sensitivity',
        'outlier-lower-bound',
        'outlier-upper-bound',
    ]
        .map(id => document.getElementById(id))
        .filter(Boolean);
};

proto._outlierParameterInputs = function() {
    return this._dataToolParameterInputs();
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

    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const lazy = this._isDataToolLazyData(data);
    this._syncDataToolPickerOptions(lazy);

    const tool = this._getSelectedDataTool();
    const hasTool = !!tool;
    const targetMode = this._getOutlierTargetMode();
    const hasTargetMode = targetMode === 'modify' || targetMode === 'create';
    const createsVariable = targetMode === 'create';
    const allowed = hasTool && this._isDataToolAvailableForData(tool, data);

    form.classList.toggle('collapsed', !hasTool);
    outputWrap?.classList.toggle('collapsed', !createsVariable);
    document.getElementById('outlier-method-wrap')?.classList.toggle('collapsed', tool !== 'removeOutliers');
    document.getElementById('outlier-replacement-wrap')?.classList.toggle('collapsed', tool !== 'removeOutliers');
    document.querySelectorAll('.data-tool-controls').forEach(el => {
        el.classList.toggle('collapsed', el.dataset.toolKind !== tool);
    });
    this._syncOutlierMethodOptions(lazy && tool === 'removeOutliers');
    this._syncOutlierMethodControls();
    this._syncMovingAverageControls();

    const previous = sourceSelect.value;
    const entries = hasTool && allowed ? this._getDataToolSourceEntries(data, tool) : [];

    sourceSelect.innerHTML = '';
    if (!hasTool) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('outlierSelectVariable');
        sourceSelect.appendChild(option);
    } else if (lazy && !allowed) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('dataToolLazyToolUnavailable');
        sourceSelect.appendChild(option);
    } else if (!entries.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('outlierNoVariables');
        sourceSelect.appendChild(option);
    } else {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('outlierSelectVariable');
        sourceSelect.appendChild(option);
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
    if (!sourceSelect.value) outputInput.value = '';
    if ((!keptPrevious || !outputInput.value.trim()) && sourceSelect.value) {
        outputInput.value = this._suggestDataToolOutputName(sourceSelect.value);
    }

    const sourceVariable = sourceSelect.value ? data?.variables?.[sourceSelect.value] : null;
    const hasSource = hasTool && allowed && !!sourceSelect.value && !!sourceVariable;
    const hasOutput = !createsVariable || !!outputInput.value.trim();
    const hasValidConfig = !hasSource || !!this._tryReadDataToolConfig();
    const resetTarget = hasSource
        ? this._findOutlierResetDefinition(fileId, {
            sourceName: sourceSelect.value,
            outputName: outputInput.value.trim(),
            targetMode,
            tool,
        })
        : null;

    sourceSelect.disabled = !hasTool || !allowed || !entries.length;
    outputInput.disabled = !hasSource || !createsVariable;
    methodSelect.disabled = !hasSource || tool !== 'removeOutliers' || lazy;
    this._dataToolParameterInputs().forEach(input => { input.disabled = !hasSource || (lazy && input.id !== 'outlier-lower-bound' && input.id !== 'outlier-upper-bound'); });
    document.getElementById('derivative-method')?.toggleAttribute('disabled', !hasSource || tool !== 'derivative');
    document.getElementById('integral-method')?.toggleAttribute('disabled', !hasSource || tool !== 'integrate');
    document.getElementById('moving-average-window-slider')?.toggleAttribute('disabled', !hasSource || tool !== 'movingAverage');
    document.getElementById('moving-average-window')?.toggleAttribute('disabled', !hasSource || tool !== 'movingAverage');
    document.querySelectorAll('input[name="outlier-replacement"]').forEach(input => {
        input.disabled = !hasSource || tool !== 'removeOutliers' || lazy;
        if (lazy && input.value === 'nan') input.checked = true;
    });
    document.querySelectorAll('input[name="outlier-target"]').forEach(input => { input.disabled = !hasSource; });
    if (resetBtn) resetBtn.disabled = !resetTarget;
    form.classList.toggle('data-tool-invalid', hasSource && (!hasTargetMode || !hasOutput || !hasValidConfig));

    if (hasTool && lazy && !allowed) {
        this._setOutlierMessage(i18n.t('dataToolLazyDisabled'), 'error');
    } else if (hasSource && !hasTargetMode) {
        const messageEl = document.getElementById('outlier-message');
        if (!messageEl?.textContent) this._setOutlierMessage(i18n.t('dataToolChooseTargetMode'), '');
    } else if (hasTool && lazy && tool === 'removeOutliers') {
        const messageEl = document.getElementById('outlier-message');
        if (!messageEl?.textContent) this._setOutlierMessage(i18n.t('dataToolLazyBoundsOnly'), '');
    }
};

proto._syncDataToolPickerOptions = function(lazy) {
    const toolSelect = document.getElementById('data-tool-select');
    if (!toolSelect) return;
    for (const option of toolSelect.options) {
        if (!option.value) continue;
        option.disabled = !!lazy && option.value !== 'removeOutliers';
    }
    if (toolSelect.value && toolSelect.options[toolSelect.selectedIndex]?.disabled) {
        toolSelect.value = '';
    }
};

proto._syncOutlierMethodOptions = function(lazyBoundsOnly) {
    const methodSelect = document.getElementById('outlier-method');
    if (!methodSelect) return;
    for (const option of methodSelect.options) {
        option.disabled = !!lazyBoundsOnly && option.value !== 'bounds';
    }
    if (lazyBoundsOnly && methodSelect.value !== 'bounds') methodSelect.value = 'bounds';
};

proto._syncOutlierMethodControls = function() {
    const tool = this._getSelectedDataTool();
    const method = this._getOutlierDetectorMethod();
    document.querySelectorAll('.outlier-method-controls').forEach(el => {
        el.classList.toggle('collapsed', tool !== 'removeOutliers' || el.dataset.outlierMethod !== method);
    });
    const sliderValue = document.getElementById('outlier-spike-sensitivity-value');
    if (sliderValue) sliderValue.textContent = this._formatOutlierNumber(this._getOutlierSensitivity(), 0);
};

proto._syncMovingAverageControls = function() {
    const input = document.getElementById('moving-average-window');
    const slider = document.getElementById('moving-average-window-slider');
    const value = document.getElementById('moving-average-window-value');
    if (!input || !slider) return;
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const source = this.activeFileId
        ? this.plotManager.files.get(this.activeFileId)?.data?.variables?.[sourceName]
        : null;
    const max = Math.max(2, Number(source?.data?.length) || 2);
    input.max = String(max);
    const windowSize = this._normalizeMovingAverageWindow(input.value || slider.value, max);
    if (!input.value) input.value = String(windowSize);
    const sliderMin = Number(slider.min);
    const sliderMax = Number(slider.max);
    slider.value = String(Math.max(sliderMin, Math.min(sliderMax, windowSize)));
    if (value) value.textContent = String(windowSize);
};

proto._syncMovingAverageSliderFromInput = function() {
    const input = document.getElementById('moving-average-window');
    const slider = document.getElementById('moving-average-window-slider');
    const value = document.getElementById('moving-average-window-value');
    if (!input || !slider) return;
    const n = Number(input.value);
    if (Number.isFinite(n)) {
        const sliderMin = Number(slider.min);
        const sliderMax = Number(slider.max);
        slider.value = String(Math.max(sliderMin, Math.min(sliderMax, Math.round(n))));
    }
    if (value && Number.isFinite(n)) value.textContent = String(Math.max(2, Math.round(n)));
};

proto._handleOutlierMethodChange = function() {
    this._setOutlierMessage('', '');
    this._syncDataTools();
    this._scheduleDataToolAutoApply({ immediate: true });
};

proto._handleOutlierOptionChange = function() {
    this._handleDataToolOptionChange();
};

proto._handleDataToolOptionChange = function() {
    this._setOutlierMessage('', '');
    this._syncDataTools();
    this._scheduleDataToolAutoApply({ immediate: true });
};

proto._handleOutlierLiveChange = function(options = {}) {
    this._syncOutlierMethodControls();
    this._scheduleDataToolAutoApply(options);
};

proto._scheduleOutlierAutoApply = function(options = {}) {
    this._scheduleDataToolAutoApply(options);
};

proto._scheduleDataToolAutoApply = function(options = {}) {
    if (this._outlierAutoApplyTimer) clearTimeout(this._outlierAutoApplyTimer);
    const delay = options.immediate ? 0 : 350;
    this._outlierAutoApplyTimer = setTimeout(() => {
        this._outlierAutoApplyTimer = null;
        this._autoApplyOutlierTool();
    }, delay);
};

proto._autoApplyOutlierTool = function() {
    const tool = this._getSelectedDataTool();
    if (!tool) return;
    const context = this._getOutlierContext({ quiet: true });
    if (!context) {
        this._syncDataTools();
        return;
    }

    try {
        this._getDataToolConfig(tool, context);
    } catch (err) {
        this._setOutlierMessage(err?.message || String(err), 'error');
        this._syncDataTools();
        return;
    }

    Promise.resolve(this.applyOutlierTool({ silent: true })).then(result => {
        if (result) {
            const key = result.tool === 'removeOutliers' ? 'outlierAutoApplied' : 'dataToolAutoApplied';
            this._setOutlierMessage(
                i18n.t(key)
                    .replace('{count}', String(result.count ?? 0))
                    .replace('{name}', result.name || context.outputName || context.sourceName),
                result.warning ? 'error' : (result.count ? 'ok' : '')
            );
            if (result.warning) this._setOutlierMessage(result.warning, 'error');
        }
        this._syncDataTools();
    }).catch(err => {
        this._setOutlierMessage(err?.message || String(err), 'error');
        this._syncDataTools();
    });
};

proto._getDataToolSourceEntries = function(data, tool = this._getSelectedDataTool()) {
    const lazy = this._isDataToolLazyData(data);
    return Object.entries(data?.variables || {})
        .filter(([, variable]) => {
            if (!variable || variable.kind === 'abscissa' || variable.kind === 'parameter') return false;
            if (variable.plottable === false) return false;
            if (variable.dataType === 'string' || variable.dataType === 'boolean') return false;
            if (lazy) return tool === 'removeOutliers' && !!variable._duckdbCol;
            return this._isDataToolDataSeries(variable.data, tool);
        })
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
};

proto._getOutlierSourceEntries = function(data) {
    return this._getDataToolSourceEntries(data, 'removeOutliers');
};

proto._outlierSourceLabel = function(name, variable) {
    return variable?.dataToolModified ? `${name} ${i18n.t('outlierModifiedSuffix')}` : name;
};

proto._suggestOutlierOutputName = function(sourceName) {
    return this._suggestDataToolOutputName(sourceName, 'removeOutliers');
};

proto._suggestDataToolOutputName = function(sourceName, tool = this._getSelectedDataTool()) {
    if (!sourceName) return '';
    const existing = this._findDataToolCreateDefinitionName(this.activeFileId, sourceName, '', tool);
    if (existing) return existing;
    const suffix = {
        removeOutliers: 'no_outliers',
        derivative: 'ddt',
        integrate: 'int',
        movingAverage: 'avg',
    }[tool] || 'tool';
    return this._uniqueDataToolVariableName(`${sourceName} ${suffix}`);
};

proto.applyOutlierTool = function(options = {}) {
    const context = this._getOutlierContext({ quiet: options.silent });
    if (!context) return null;
    let config;
    try {
        config = this._getDataToolConfig(context.tool, context);
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
    return context.targetMode === 'create'
        ? this._applyDataToolCreateMode(context, config, options)
        : this._applyDataToolModifyMode(context, config, options);
};

proto._applyDataToolCreateMode = function(context, config, options = {}) {
    if (context.lazy) return this._applyLazyDataToolCreateMode(context, config, options);

    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const previousName = this._findDataToolCreateDefinitionName(fileId, sourceName, outputName, tool);
    const existing = data.variables[outputName];
    const existingDefinition = definitions?.get(outputName);

    try {
        if (existing && !existingDefinition) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
        if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));
        if (previousName && previousName !== outputName) {
            delete data.variables[previousName];
            definitions?.delete(previousName);
        }

        const result = this._buildDataToolResult(sourceVariable.data, sourceVariable, {
            ...config,
            sourceName,
            targetName: outputName,
            targetMode: 'create',
        }, data);
        data.variables[outputName] = result.variable;
        this._storeDataToolDefinition(fileId, outputName, {
            name: outputName,
            tool,
            targetMode: 'create',
            sourceName,
            method: config.method,
            params: this._cloneDataToolParams(config.params),
            replacement: config.replacement,
            variable: result.variable,
        });
        this._reapplyDataToolDependents(fileId, data, outputName);

        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._syncDataTools();
        if (!options.silent) this._setDataToolApplyMessage(result, existingDefinition ? 'updated' : 'created', outputName);
        return result;
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

proto._applyDataToolModifyMode = function(context, config, options = {}) {
    if (context.lazy) return this._applyLazyDataToolModifyMode(context, config, options);

    const { fileId, data, sourceName, sourceVariable, tool } = context;
    const existingDefinition = this.dataToolVariablesByFile?.get(fileId)?.get(sourceName);
    if (existingDefinition?.targetMode === 'create') {
        return this._applyDataToolAppendToCreatedVariable(context, config, existingDefinition, options);
    }
    const originalData = existingDefinition?.targetMode === 'modify' && existingDefinition.originalData
        ? Array.from(existingDefinition.originalData)
        : Array.from(sourceVariable.data);

    try {
        const result = this._buildDataToolResult(originalData, sourceVariable, {
            ...config,
            sourceName,
            targetName: sourceName,
            targetMode: 'modify',
        }, data);
        const variable = data.variables[sourceName];
        variable.data = result.variable.data;
        variable.dataType = result.variable.dataType;
        variable.isConstant = result.variable.isConstant;
        variable.dataToolModified = true;
        variable.dataTool = result.variable.dataTool;

        this._storeDataToolDefinition(fileId, sourceName, {
            name: sourceName,
            tool,
            targetMode: 'modify',
            sourceName,
            method: config.method,
            params: this._cloneDataToolParams(config.params),
            replacement: config.replacement,
            originalData: Array.from(originalData),
            variable,
        });
        this._reapplyDataToolDependents(fileId, data, sourceName);

        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._syncDataTools();
        if (!options.silent) this._setDataToolApplyMessage(result, existingDefinition ? 'modifiedUpdated' : 'modified', sourceName);
        return result;
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

proto._applyDataToolAppendToCreatedVariable = function(context, config, existingDefinition, options = {}) {
    const { fileId, data, sourceName, tool } = context;
    const normalized = this._normalizeDataToolDefinition(existingDefinition);
    const baseSourceName = normalized.sourceName;
    const baseVariable = data.variables?.[baseSourceName];
    if (!baseSourceName || baseSourceName === sourceName || !baseVariable) {
        if (!options.silent) this._setOutlierMessage(i18n.t('outlierOutputSameAsSource'), 'error');
        return null;
    }

    try {
        const currentSteps = this._dataToolStepsFromDefinition(normalized);
        const nextStep = this._dataToolStepFromConfig({ ...config, tool });
        const replaceLast = currentSteps.length > 0 && currentSteps[currentSteps.length - 1].tool === nextStep.tool;
        const steps = replaceLast
            ? currentSteps.slice(0, -1).concat(nextStep)
            : currentSteps.concat(nextStep);
        const last = steps[steps.length - 1];
        const result = this._buildDataToolResult(baseVariable.data, baseVariable, {
            sourceName: baseSourceName,
            targetName: sourceName,
            targetMode: 'create',
            tool: last.tool,
            method: last.method,
            params: this._cloneDataToolParams(last.params),
            replacement: last.replacement,
            steps,
        }, data);
        data.variables[sourceName] = result.variable;
        this._storeDataToolDefinition(fileId, sourceName, {
            name: sourceName,
            tool: last.tool,
            targetMode: 'create',
            sourceName: baseSourceName,
            method: last.method,
            params: this._cloneDataToolParams(last.params),
            replacement: last.replacement,
            steps,
            variable: result.variable,
        });
        this._reapplyDataToolDependents(fileId, data, sourceName);

        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._syncDataTools();
        if (!options.silent) this._setDataToolApplyMessage(result, 'updated', sourceName);
        return result;
    } catch (err) {
        if (!options.silent) this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

proto._applyOutlierCreateMode = function(context, config, options = {}) {
    return this._applyDataToolCreateMode(context, { ...config, tool: 'removeOutliers' }, options);
};

proto._applyOutlierModifyMode = function(context, config, options = {}) {
    return this._applyDataToolModifyMode(context, { ...config, tool: 'removeOutliers' }, options);
};

proto._applyLazyDataToolCreateMode = async function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    if (!this._isLazyBoundsConfig(config)) throw new Error(i18n.t('dataToolLazyDisabled'));
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const previousName = this._findDataToolCreateDefinitionName(fileId, sourceName, outputName, tool);
    const existing = data.variables[outputName];
    const existingDefinition = definitions?.get(outputName);

    if (existing && !existingDefinition) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
    if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));
    if (previousName && previousName !== outputName) {
        delete data.variables[previousName];
        definitions?.delete(previousName);
    }

    const definition = this._lazyDataToolDefinition(outputName, config, sourceName, 'create');
    const variable = {
        ...sourceVariable,
        name: outputName,
        data: this._replaceOutliersWithNaN(
            Array.from(sourceVariable.data || []),
            this._detectBoundsOutliers(sourceVariable.data || [], config.params)
        ),
        description: `Data tool: remove outliers from ${sourceName}; ${this._outlierDetectorDescription(config)}; nan`,
        kind: 'variable',
        derived: true,
        dataToolModified: false,
        dataTool: { ...definition, outlierCount: null },
        _duckdbCol: sourceVariable._duckdbCol,
        _duckdbDataTool: definition,
    };
    delete variable.formula;
    data.variables[outputName] = variable;
    this._storeDataToolDefinition(fileId, outputName, { ...definition, variable });
    const count = await this._countLazyBoundsOutliers(data, sourceName, config.params);
    variable.dataTool.outlierCount = count;
    await this._refreshLazyDataToolOverview(data);

    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree();
    this._syncDataTools();
    const result = { variable, count, tool, name: outputName };
    if (!options.silent) this._setDataToolApplyMessage(result, existingDefinition ? 'updated' : 'created', outputName);
    return result;
};

proto._applyLazyDataToolModifyMode = async function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable, tool } = context;
    if (!this._isLazyBoundsConfig(config)) throw new Error(i18n.t('dataToolLazyDisabled'));
    const existingDefinition = this.dataToolVariablesByFile?.get(fileId)?.get(sourceName);
    const originalData = existingDefinition?.targetMode === 'modify' && existingDefinition.originalData
        ? Array.from(existingDefinition.originalData)
        : Array.from(sourceVariable.data || []);
    const definition = this._lazyDataToolDefinition(sourceName, config, sourceName, 'modify');
    const variable = data.variables[sourceName];
    variable.data = this._replaceOutliersWithNaN(originalData, this._detectBoundsOutliers(originalData, config.params));
    variable.dataToolModified = true;
    variable.dataTool = { ...definition, outlierCount: null };
    variable._duckdbDataTool = definition;
    const count = await this._countLazyBoundsOutliers(data, sourceName, config.params);
    variable.dataTool.outlierCount = count;
    this._storeDataToolDefinition(fileId, sourceName, {
        ...definition,
        originalData,
        variable,
    });
    await this._refreshLazyDataToolOverview(data);

    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree();
    this._syncDataTools();
    const result = { variable, count, tool, name: sourceName };
    if (!options.silent) this._setDataToolApplyMessage(result, existingDefinition ? 'modifiedUpdated' : 'modified', sourceName);
    return result;
};

proto._lazyDataToolDefinition = function(name, config, sourceName, targetMode) {
    return {
        name,
        tool: 'removeOutliers',
        targetMode,
        sourceName,
        method: 'bounds',
        params: this._cloneDataToolParams(config.params),
        replacement: 'nan',
    };
};

proto._isLazyBoundsConfig = function(config) {
    return config?.tool === 'removeOutliers' && config.method === 'bounds';
};

proto._countLazyBoundsOutliers = async function(data, sourceName, params) {
    const source = data?._duckdb?.source;
    if (!source?.countOutOfBounds) return this._detectBoundsOutliers(data?.variables?.[sourceName]?.data || [], params).length;
    try {
        return await source.countOutOfBounds(data, sourceName, params);
    } catch (err) {
        console.warn('[duckdb] could not count lazy data-tool outliers:', err?.message || err);
        return null;
    }
};

proto._refreshLazyDataToolOverview = async function(data) {
    const source = data?._duckdb?.source;
    if (!source?.refreshOverview) return;
    try {
        await source.refreshOverview(data);
    } catch (err) {
        console.warn('[duckdb] could not refresh lazy data-tool overview:', err?.message || err);
    }
};

proto._setDataToolApplyMessage = function(result, action, name) {
    const tool = result?.tool || 'removeOutliers';
    const keyByAction = tool === 'removeOutliers'
        ? {
            created: 'outlierCreated',
            updated: 'outlierUpdated',
            modified: 'outlierModified',
            modifiedUpdated: 'outlierModifiedUpdated',
        }
        : {
            created: 'dataToolCreated',
            updated: 'dataToolUpdated',
            modified: 'dataToolModified',
            modifiedUpdated: 'dataToolModifiedUpdated',
        };
    let message = i18n.t(keyByAction[action] || 'dataToolUpdated')
        .replace('{count}', String(result?.count ?? 0))
        .replace('{name}', name || result?.name || '');
    if (result?.warning) message += ` ${result.warning}`;
    this._setOutlierMessage(message, result?.warning ? 'error' : 'ok');
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
    const resetTarget = this._findOutlierResetDefinition(fileId, {
        sourceName,
        outputName,
        targetMode,
        tool: this._getSelectedDataTool(),
    });

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
    delete variable._duckdbDataTool;
    this._deleteDataToolDefinition(fileId, name);

    if (data?._duckdb?.source?.refreshOverview) {
        data._duckdb.source.refreshOverview(data).catch(err =>
            console.warn('[duckdb] could not refresh overview after data-tool reset:', err?.message || err)
        );
    }
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
    if (data?._duckdb?.source?.refreshOverview) {
        data._duckdb.source.refreshOverview(data).catch(err =>
            console.warn('[duckdb] could not refresh overview after data-tool reset:', err?.message || err)
        );
    }
    this.plotManager.updateFileData(fileId, data);
    this._clearVariableSelection?.();
    this._renderFilteredTree();
    if (!options.silent) {
        this._setOutlierMessage(i18n.t('outlierResetCreated').replace('{name}', name), 'ok');
    }
    this._syncDataTools();
    return true;
};

proto._buildDataToolResult = function(sourceValues, sourceVariable, config, data) {
    if (Array.isArray(config.steps) && config.steps.length) {
        return this._buildDataToolPipelineResult(sourceValues, sourceVariable, config, data);
    }
    return this._buildSingleDataToolResult(sourceValues, sourceVariable, config, data);
};

proto._buildSingleDataToolResult = function(sourceValues, sourceVariable, config, data) {
    if (config.tool === 'derivative') return this._buildDerivativeResult(sourceValues, sourceVariable, config, data);
    if (config.tool === 'integrate') return this._buildIntegralResult(sourceValues, sourceVariable, config, data);
    if (config.tool === 'movingAverage') return this._buildMovingAverageResult(sourceValues, sourceVariable, config);
    return this._buildOutlierResult(sourceValues, sourceVariable, config);
};

proto._buildDataToolPipelineResult = function(sourceValues, sourceVariable, config, data) {
    const steps = config.steps.map(step => this._normalizeDataToolStep(step));
    let currentValues = sourceValues;
    let currentVariable = sourceVariable;
    let result = null;
    for (const step of steps) {
        result = this._buildSingleDataToolResult(currentValues, currentVariable, {
            ...step,
            sourceName: config.sourceName,
            targetName: config.targetName,
            targetMode: config.targetMode,
        }, data);
        currentValues = result.variable.data;
        currentVariable = result.variable;
    }

    const last = steps[steps.length - 1];
    const {
        tool: _tool,
        sourceName: _sourceName,
        targetMode: _targetMode,
        method: _method,
        params: _params,
        replacement: _replacement,
        steps: _steps,
        ...finalDataTool
    } = result?.variable?.dataTool || {};
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: last.tool,
        method: last.method,
        params: this._cloneDataToolParams(last.params),
        replacement: last.replacement,
    }, currentValues, {
        ...finalDataTool,
        steps: steps.map(step => this._cloneDataToolParams(step)),
    });
    if (config.targetMode === 'create') variable.description = this._dataToolDescription({ ...config, steps });
    return { ...result, variable, tool: last.tool, name: config.targetName };
};

proto._baseDataToolVariable = function(sourceValues, sourceVariable, config, values, extraDataTool = {}) {
    const variable = {
        ...sourceVariable,
        name: config.targetName,
        data: values,
        description: config.targetMode === 'create'
            ? this._dataToolDescription(config)
            : sourceVariable.description,
        kind: 'variable',
        dataType: this.parser._detectDataType(values, 'variable'),
        isConstant: this.parser._isConstantValues(values),
        interpolation: sourceVariable.interpolation || 'linear',
        derived: config.targetMode === 'create' ? true : !!sourceVariable.derived,
        dataToolModified: config.targetMode === 'modify',
        dataTool: {
            tool: config.tool,
            sourceName: config.sourceName,
            targetMode: config.targetMode,
            method: config.method || null,
            params: this._cloneDataToolParams(config.params),
            ...extraDataTool,
        },
    };
    if (config.replacement) variable.dataTool.replacement = config.replacement;
    if (config.targetMode === 'create') {
        delete variable._duckdbCol;
        delete variable._duckdbDataTool;
        delete variable.formula;
    }
    return variable;
};

proto._buildOutlierResult = function(sourceValues, sourceVariable, config) {
    const values = Array.from(sourceValues || []);
    const outlierIndexes = this._detectOutlierIndexes(values, config.method, config.params);
    const cleaned = config.replacement === 'interpolate'
        ? this._interpolateOutliers(values, outlierIndexes)
        : this._replaceOutliersWithNaN(values, outlierIndexes);
    const variable = this._baseDataToolVariable(values, sourceVariable, {
        ...config,
        tool: 'removeOutliers',
    }, cleaned, {
        method: config.method,
        replacement: config.replacement,
        outlierCount: outlierIndexes.length,
        outlierIndexes,
    });
    return { variable, count: outlierIndexes.length, tool: 'removeOutliers', name: config.targetName };
};

proto._buildDerivativeResult = function(sourceValues, sourceVariable, config, data) {
    const result = this._computeDerivativeValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'derivative',
    }, result.values, { method: config.params.method });
    return { variable, count: result.values.length, tool: 'derivative', name: config.targetName };
};

proto._buildIntegralResult = function(sourceValues, sourceVariable, config, data) {
    const result = this._computeIntegralValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'integrate',
    }, result.values, {
        method: config.params.method,
        negativeDtCount: result.negativeDtCount,
    });
    const warning = result.negativeDtCount > 0
        ? i18n.t('dataToolNegativeDtWarning').replace('{count}', String(result.negativeDtCount))
        : '';
    return { variable, count: result.values.length, tool: 'integrate', name: config.targetName, warning };
};

proto._buildMovingAverageResult = function(sourceValues, sourceVariable, config) {
    const values = this._computeMovingAverageValues(sourceValues, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'movingAverage',
    }, values, { window: config.params.window });
    return { variable, count: values.length, tool: 'movingAverage', name: config.targetName };
};

proto._dataToolDescription = function(config) {
    if (Array.isArray(config.steps) && config.steps.length) {
        const labels = config.steps.map(step => this._dataToolStepLabel(step)).join(' -> ');
        return `Data tool: ${labels} of ${config.sourceName}`;
    }
    if (config.tool === 'derivative') {
        return `Data tool: derivative of ${config.sourceName}; ${config.params.method}`;
    }
    if (config.tool === 'integrate') {
        return `Data tool: integral of ${config.sourceName}; ${config.params.method}`;
    }
    if (config.tool === 'movingAverage') {
        return `Data tool: moving average of ${config.sourceName}; window ${config.params.window}`;
    }
    return `Data tool: remove outliers from ${config.sourceName}; ${this._outlierDetectorDescription(config)}; ${config.replacement}`;
};

proto._dataToolStepLabel = function(step) {
    if (step.tool === 'derivative') return `derivative (${step.params.method})`;
    if (step.tool === 'integrate') return `integral (${step.params.method})`;
    if (step.tool === 'movingAverage') return `moving average (window ${step.params.window})`;
    return `remove outliers (${this._outlierDetectorDescription(step)}; ${step.replacement})`;
};

proto._computeDerivativeValues = function(sourceValues, data, params = {}) {
    const values = Array.from(sourceValues || [], Number);
    const n = values.length;
    const out = new Array(n).fill(NaN);
    if (n < 2) return { values: out };
    const time = this._getDataToolTimeContext(data, n);
    const method = DERIVATIVE_METHODS.has(params.method) ? params.method : 'centered';
    const diff = (a, b) => {
        const y0 = Number(values[a]);
        const y1 = Number(values[b]);
        const dt = this._dataToolDelta(time, a, b);
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(dt) || dt === 0) return NaN;
        return (y1 - y0) / dt;
    };
    for (let i = 0; i < n; i++) {
        if (method === 'forward') out[i] = i < n - 1 ? diff(i, i + 1) : diff(i - 1, i);
        else if (method === 'backward') out[i] = i > 0 ? diff(i - 1, i) : diff(i, i + 1);
        else out[i] = i === 0 ? diff(0, 1) : (i === n - 1 ? diff(n - 2, n - 1) : diff(i - 1, i + 1));
    }
    return { values: out };
};

proto._computeIntegralValues = function(sourceValues, data, params = {}) {
    const values = Array.from(sourceValues || [], Number);
    const n = values.length;
    const out = new Array(n).fill(0);
    if (!n) return { values: out, negativeDtCount: 0 };
    const time = this._getDataToolTimeContext(data, n);
    const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    let acc = 0;
    let negativeDtCount = 0;
    for (let i = 1; i < n; i++) {
        const dt = this._dataToolDelta(time, i - 1, i);
        if (Number.isFinite(dt)) {
            if (dt < 0) negativeDtCount++;
            const y0 = Number(values[i - 1]);
            const y1 = Number(values[i]);
            if (method === 'rectangular') {
                if (Number.isFinite(y0)) acc += y0 * dt;
            } else if (Number.isFinite(y0) && Number.isFinite(y1)) {
                acc += 0.5 * (y0 + y1) * dt;
            }
        }
        out[i] = acc;
    }
    return { values: out, negativeDtCount };
};

proto._computeMovingAverageValues = function(sourceValues, params = {}) {
    const values = Array.from(sourceValues || [], Number);
    const n = values.length;
    const window = this._normalizeMovingAverageWindow(params.window, n);
    const left = Math.floor((window - 1) / 2);
    const right = window - left - 1;
    const out = new Array(n).fill(NaN);
    let start = 0;
    let end = -1;
    let sum = 0;
    let count = 0;
    const add = index => {
        const value = Number(values[index]);
        if (!Number.isFinite(value)) return;
        sum += value;
        count++;
    };
    const remove = index => {
        const value = Number(values[index]);
        if (!Number.isFinite(value)) return;
        sum -= value;
        count--;
    };
    for (let i = 0; i < n; i++) {
        const nextStart = Math.max(0, i - left);
        const nextEnd = Math.min(n - 1, i + right);
        while (end < nextEnd) add(++end);
        while (start < nextStart) remove(start++);
        out[i] = count ? sum / count : NaN;
    }
    return out;
};

proto._getDataToolTimeContext = function(data, expectedLength) {
    const timeName = data?.metadata?.timeName;
    const timeVariable = (timeName && data?.variables?.[timeName])
        || Object.values(data?.variables || {}).find(v => v.kind === 'abscissa')
        || null;
    const values = timeVariable?.data && timeVariable.data.length === expectedLength
        ? timeVariable.data
        : null;
    const metaKind = data?.metadata?.timeKind || timeVariable?.timeKind || '';
    const kind = metaKind === 'datetime'
        ? 'datetime'
        : (metaKind === 'index' || timeVariable?.timeStepMode === 'index' ? 'index' : 'numeric');
    return { values, kind };
};

proto._dataToolDelta = function(time, a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return NaN;
    if (time.kind === 'index' || !time.values) return b - a;
    const t0 = Number(time.values[a]);
    const t1 = Number(time.values[b]);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return NaN;
    const delta = t1 - t0;
    return time.kind === 'datetime' ? delta / 1000 : delta;
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
    const cleaned = Array.from(values || []);
    outlierIndexes.forEach(index => { cleaned[index] = NaN; });
    return cleaned;
};

proto._interpolateOutliers = function(values, outlierIndexes) {
    const n = values?.length || 0;
    const cleaned = Array.from(values || []);
    if (!n || !outlierIndexes?.length) return cleaned;

    // O(n) instead of O(n²): precompute, in two passes, the nearest VALID
    // (non-outlier and finite) neighbour to each index. The old per-outlier
    // left/right walk was quadratic when most points are outliers (e.g. a
    // bound that removes the whole signal), which froze the app.
    const outlierSet = new Set(outlierIndexes);
    const valid = new Array(n);
    for (let i = 0; i < n; i++) valid[i] = !outlierSet.has(i) && Number.isFinite(Number(values[i]));

    const prevValid = new Array(n);
    let last = -1;
    for (let i = 0; i < n; i++) { if (valid[i]) last = i; prevValid[i] = last; }
    const nextValid = new Array(n);
    let next = -1;
    for (let i = n - 1; i >= 0; i--) { if (valid[i]) next = i; nextValid[i] = next; }

    for (const index of outlierIndexes) {
        const left = prevValid[index];   // nearest valid < index (index is invalid)
        const right = nextValid[index];  // nearest valid > index
        if (left >= 0 && right >= 0) {
            const l = Number(values[left]);
            const r = Number(values[right]);
            cleaned[index] = l + ((index - left) / (right - left)) * (r - l);
        } else {
            cleaned[index] = NaN;
        }
    }
    return cleaned;
};

proto._getOutlierContext = function(options = {}) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const tool = this._getSelectedDataTool();
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    const targetMode = this._getOutlierTargetMode();
    const sourceVariable = data?.variables?.[sourceName];
    const lazy = this._isDataToolLazyData(data);
    if (!tool || !fileId || !data || !sourceVariable) {
        if (!options.quiet) this._setOutlierMessage(i18n.t('outlierLoadFileFirst'), 'error');
        return null;
    }
    if (!targetMode) {
        if (!options.quiet) this._setOutlierMessage(i18n.t('dataToolChooseTargetMode'), '');
        return null;
    }
    if (targetMode === 'create' && !outputName) {
        if (!options.quiet) this._setOutlierMessage(i18n.t('dataToolOutputNameRequired'), 'error');
        return null;
    }
    if (lazy && !this._isDataToolAvailableForData(tool, data)) {
        if (!options.quiet) this._setOutlierMessage(i18n.t('dataToolLazyDisabled'), 'error');
        return null;
    }
    return { fileId, data, sourceName, sourceVariable, outputName, targetMode, tool, lazy };
};

proto._getOutlierConfig = function() {
    return this._getDataToolConfig('removeOutliers');
};

proto._getDataToolConfig = function(tool = this._getSelectedDataTool(), context = null) {
    const data = context?.data || (this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null);
    const lazy = this._isDataToolLazyData(data);
    if (tool === 'derivative') {
        const method = document.getElementById('derivative-method')?.value || 'centered';
        return { tool, params: { method: DERIVATIVE_METHODS.has(method) ? method : 'centered' } };
    }
    if (tool === 'integrate') {
        const method = document.getElementById('integral-method')?.value || 'trapezoidal';
        return { tool, params: { method: INTEGRAL_METHODS.has(method) ? method : 'trapezoidal' } };
    }
    if (tool === 'movingAverage') {
        const max = context?.sourceVariable?.data?.length
            || (document.getElementById('outlier-variable')?.value
                ? data?.variables?.[document.getElementById('outlier-variable')?.value]?.data?.length
                : 201)
            || 201;
        return { tool, params: { window: this._normalizeMovingAverageWindow(document.getElementById('moving-average-window')?.value, max) } };
    }

    const method = this._getOutlierDetectorMethod();
    if (lazy && method !== 'bounds') throw new Error(i18n.t('dataToolLazyBoundsOnly'));
    const params = this._getOutlierParams(method);
    const replacement = lazy ? 'nan' : this._getOutlierReplacementMethod();
    return { tool: 'removeOutliers', method, params, replacement };
};

proto._tryReadOutlierConfig = function() {
    return this._tryReadDataToolConfig();
};

proto._tryReadDataToolConfig = function() {
    try {
        return this._getDataToolConfig();
    } catch {
        return null;
    }
};

proto._getSelectedDataTool = function() {
    const value = document.getElementById('data-tool-select')?.value;
    return DATA_TOOLS.has(value) ? value : '';
};

proto._isDataToolAvailableForData = function(tool, data) {
    if (!this._isDataToolLazyData(data)) return DATA_TOOLS.has(tool);
    return tool === 'removeOutliers';
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

proto._clearDataToolTargetMode = function() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('input[name="outlier-target"]').forEach(input => {
        input.checked = false;
    });
};

proto._getOutlierTargetMode = function() {
    const value = document.querySelector('input[name="outlier-target"]:checked')?.value;
    return value === 'modify' || value === 'create' ? value : '';
};

proto._uniqueDataToolVariableName = function(baseName, fileId = this.activeFileId) {
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const base = String(baseName || 'tool').trim() || 'tool';
    if (!data?.variables?.[base]) return base;
    let index = 2;
    while (data.variables[`${base} ${index}`]) index++;
    return `${base} ${index}`;
};

proto._dataToolOutputExists = function(fileId, name) {
    return !!fileId && !!name && !!this.dataToolVariablesByFile?.get(fileId)?.has(name);
};

proto._isOutlierDataSeries = function(values) {
    return this._isDataToolDataSeries(values, 'removeOutliers');
};

proto._isDataToolDataSeries = function(values, tool = 'removeOutliers') {
    const length = Number(values?.length);
    if (!Number.isFinite(length)) return false;
    return length > (tool === 'removeOutliers' ? 2 : 1);
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
    const tool = options.tool || this._getSelectedDataTool();
    const normalizeEntry = (name, rawDefinition) => {
        if (!rawDefinition) return null;
        const definition = this._normalizeDataToolDefinition(rawDefinition);
        if (tool && definition.tool !== tool) return null;
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
    for (const [name, definition] of this._orderedDataToolDefinitions(fileId)) {
        this._reapplyDataToolDefinition(fileId, data, name, definition);
    }
    if (this._isDataToolLazyData(data)) {
        this._refreshLazyDataToolOverview(data);
    }
};

proto._reapplyDataToolDependents = function(fileId, data, changedName) {
    if (!changedName) return;
    const changed = new Set([changedName]);
    for (const [name, definition] of this._orderedDataToolDefinitions(fileId)) {
        if (name === changedName || !changed.has(definition.sourceName)) continue;
        if (this._reapplyDataToolDefinition(fileId, data, name, definition)) changed.add(name);
    }
};

proto._orderedDataToolDefinitions = function(fileId) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions) return [];
    const normalizedByName = new Map();
    for (const [name, rawDefinition] of definitions) {
        const normalized = this._normalizeDataToolDefinition(rawDefinition);
        definitions.set(name, normalized);
        normalizedByName.set(name, normalized);
    }

    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = name => {
        if (visited.has(name)) return;
        if (visiting.has(name)) {
            console.warn(`Circular data-tool dependency involving ${name}; using current variable values.`);
            return;
        }
        const definition = normalizedByName.get(name);
        if (!definition) return;
        visiting.add(name);
        if (definition.sourceName && definition.sourceName !== name && normalizedByName.has(definition.sourceName)) {
            visit(definition.sourceName);
        }
        visiting.delete(name);
        visited.add(name);
        ordered.push([name, definition]);
    };

    for (const name of normalizedByName.keys()) visit(name);
    return ordered;
};

proto._reapplyDataToolDefinition = function(fileId, data, name, definition) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    definitions?.set(name, definition);
    try {
        const sourceVariable = data.variables?.[definition.sourceName];
        if (!sourceVariable) throw new Error(`Unknown source variable "${definition.sourceName}".`);
        const targetMode = definition.targetMode || 'create';
        if (this._isDataToolLazyData(data)) {
            if (definition.tool !== 'removeOutliers' || definition.method !== 'bounds') return false;
            const lazyDefinition = this._lazyDataToolDefinition(name, definition, definition.sourceName, targetMode);
            if (targetMode === 'modify') {
                const originalData = definition.originalData?.length
                    ? Array.from(definition.originalData)
                    : Array.from(sourceVariable.data || []);
                sourceVariable.data = this._replaceOutliersWithNaN(originalData, this._detectBoundsOutliers(originalData, definition.params));
                sourceVariable.dataToolModified = true;
                sourceVariable.dataTool = lazyDefinition;
                sourceVariable._duckdbDataTool = lazyDefinition;
                definition.originalData = originalData;
                definition.variable = sourceVariable;
            } else {
                data.variables[name] = {
                    ...sourceVariable,
                    name,
                    data: this._replaceOutliersWithNaN(sourceVariable.data || [], this._detectBoundsOutliers(sourceVariable.data || [], definition.params)),
                    description: `Data tool: remove outliers from ${definition.sourceName}; ${this._outlierDetectorDescription(definition)}; nan`,
                    kind: 'variable',
                    derived: true,
                    dataTool: lazyDefinition,
                    _duckdbCol: sourceVariable._duckdbCol,
                    _duckdbDataTool: lazyDefinition,
                };
                definition.variable = data.variables[name];
            }
            return true;
        }
        const sourceValues = targetMode === 'modify' && definition.originalData?.length
            ? Array.from(definition.originalData)
            : Array.from(sourceVariable.data);
        const result = this._buildDataToolResult(sourceValues, sourceVariable, {
            sourceName: definition.sourceName,
            targetName: name,
            targetMode,
            tool: definition.tool,
            method: definition.method,
            params: this._cloneDataToolParams(definition.params),
            replacement: definition.replacement,
            steps: Array.isArray(definition.steps) ? definition.steps.map(step => this._cloneDataToolParams(step)) : undefined,
        }, data);
        if (targetMode === 'modify') {
            const originalData = sourceValues;
            sourceVariable.data = result.variable.data;
            sourceVariable.dataType = result.variable.dataType;
            sourceVariable.isConstant = result.variable.isConstant;
            sourceVariable.dataToolModified = true;
            sourceVariable.dataTool = result.variable.dataTool;
            definition.originalData = Array.from(originalData);
            definition.variable = sourceVariable;
        } else {
            data.variables[name] = result.variable;
            definition.variable = result.variable;
        }
        return true;
    } catch (err) {
        console.warn(`Could not reapply data tool variable ${name}:`, err);
        return false;
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
            params: this._cloneDataToolParams(normalized.params),
            replacement: normalized.replacement,
            steps: Array.isArray(normalized.steps)
                ? normalized.steps.map(step => this._cloneDataToolParams(step))
                : undefined,
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
    if (Array.isArray(definition.steps) && definition.steps.length) {
        const steps = definition.steps.map(step => this._normalizeDataToolStep(step));
        const last = steps[steps.length - 1];
        return {
            ...definition,
            tool: last.tool,
            targetMode: definition.targetMode || 'create',
            method: last.method,
            params: this._cloneDataToolParams(last.params),
            replacement: last.replacement || '',
            steps,
        };
    }

    const tool = DATA_TOOLS.has(definition.tool) ? definition.tool : 'removeOutliers';
    if (tool !== 'removeOutliers') {
        return {
            ...definition,
            tool,
            targetMode: definition.targetMode || 'create',
            params: this._normalizeDataToolParams(tool, definition.params || definition),
            method: definition.method || definition.params?.method || null,
            replacement: '',
        };
    }

    let method = OUTLIER_METHODS.has(definition.method) ? definition.method : '';
    let replacement = OUTLIER_REPLACEMENTS.has(definition.replacement) ? definition.replacement : '';
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
        tool,
        targetMode: definition.targetMode || 'create',
        method,
        params,
        replacement,
    };
};

proto._normalizeDataToolStep = function(step = {}) {
    const tool = DATA_TOOLS.has(step.tool) ? step.tool : 'removeOutliers';
    if (tool !== 'removeOutliers') {
        const params = this._normalizeDataToolParams(tool, step.params || step);
        return {
            tool,
            method: step.method || params.method || null,
            params,
            replacement: '',
        };
    }

    let method = OUTLIER_METHODS.has(step.method) ? step.method : '';
    let replacement = OUTLIER_REPLACEMENTS.has(step.replacement) ? step.replacement : '';
    if (!method && OUTLIER_METHODS.has(step.params?.method)) method = step.params.method;
    if (!replacement && OUTLIER_REPLACEMENTS.has(step.method)) replacement = step.method;
    method ||= 'spike';
    if (method === 'hampel') method = 'spike';
    replacement ||= 'nan';
    return {
        tool,
        method,
        params: this._normalizeOutlierParams(method, step.params || step),
        replacement,
    };
};

proto._dataToolStepFromConfig = function(config = {}) {
    return this._normalizeDataToolStep({
        tool: config.tool,
        method: config.method,
        params: config.params,
        replacement: config.replacement,
    });
};

proto._dataToolStepsFromDefinition = function(definition = {}) {
    const normalized = this._normalizeDataToolDefinition(definition);
    if (Array.isArray(normalized.steps) && normalized.steps.length) {
        return normalized.steps.map(step => this._normalizeDataToolStep(step));
    }
    return [this._dataToolStepFromConfig(normalized)];
};

proto._normalizeDataToolParams = function(tool, params = {}) {
    if (tool === 'derivative') {
        const method = DERIVATIVE_METHODS.has(params.method) ? params.method : 'centered';
        return { method };
    }
    if (tool === 'integrate') {
        const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
        return { method };
    }
    if (tool === 'movingAverage') {
        return { window: this._normalizeMovingAverageWindow(params.window, Number(params.maxLength) || Infinity) };
    }
    return this._normalizeOutlierParams(params.method || 'spike', params);
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
    return this._cloneDataToolParams(params);
};

proto._cloneDataToolParams = function(params = {}) {
    return JSON.parse(JSON.stringify(params));
};

proto._serializeDataToolDefinitions = function(fileId) {
    return [...(this.dataToolVariablesByFile?.get(fileId) || new Map()).values()]
        .map(item => {
            const definition = this._normalizeDataToolDefinition(item);
            const serialized = {
                name: definition.name,
                tool: definition.tool,
                targetMode: definition.targetMode || 'create',
                sourceName: definition.sourceName,
                method: definition.method || null,
                params: this._cloneDataToolParams(definition.params),
                replacement: definition.replacement || '',
            };
            if (Array.isArray(definition.steps) && definition.steps.length) {
                serialized.steps = definition.steps.map(step => this._cloneDataToolParams(step));
            }
            return serialized;
        });
};

proto._resetDataToolPicker = function() {
    if (this._outlierAutoApplyTimer) {
        clearTimeout(this._outlierAutoApplyTimer);
        this._outlierAutoApplyTimer = null;
    }
    const toolSelect = document.getElementById('data-tool-select');
    if (toolSelect) toolSelect.value = '';
    this._clearDataToolTargetMode();
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

proto._positiveNumber = function(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

proto._normalizeSensitivity = function(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 6;
};

proto._normalizeMovingAverageWindow = function(value, maxLength = Infinity) {
    let n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = 21;
    const max = Number.isFinite(maxLength) ? Math.max(2, Math.round(maxLength)) : Number.MAX_SAFE_INTEGER;
    return Math.max(2, Math.min(max, n));
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

proto._findDataToolCreateDefinitionName = function(fileId, sourceName, exceptName = '', tool = this._getSelectedDataTool()) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions || !sourceName) return '';
    for (const [name, definition] of definitions) {
        const normalized = this._normalizeDataToolDefinition(definition);
        if (normalized.tool === tool
            && normalized.targetMode === 'create'
            && normalized.sourceName === sourceName
            && name !== exceptName) {
            return name;
        }
    }
    return '';
};

proto._formatOutlierNumber = function(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return Number.isInteger(number) ? String(number) : number.toFixed(digits);
};

}
