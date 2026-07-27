import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { DERIVED_FUNCTIONS } from '../constants.js';
import { getCompiledFormula } from '../../expr/compile.js';
import { normalizeFunctionName, parse as parseExpression, tokenize as tokenizeExpression } from '../../expr/parse.js';

// The derived signals the time-axis inspector can materialize (see the
// "Time-axis derived variables" section below), in dialog order.
export const TIME_AXIS_VARIABLE_KINDS = ['index', 'delta'];

const TIME_AXIS_KIND_META = {
    index: { suffix: 'index', description: 'timeAxisIndexDescription', label: 'timeAxisOptionIndexLabel', help: 'timeAxisOptionIndexHelp' },
    delta: { suffix: 'delta', description: 'timeAxisDeltaDescription', label: 'timeAxisOptionDeltaLabel', help: 'timeAxisOptionDeltaHelp' },
};

export function installDerivedMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.createDerivedVariable = function() {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const nameInput = document.getElementById('derived-name');
    const formulaInput = document.getElementById('derived-formula');
    const name = nameInput.value.trim();
    const formula = formulaInput.value.trim();

    try {
        if (!data) throw new Error('Load a result or text file first.');
        if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) throw new Error('Use a simple name, for example slip or motor.slip.');
        if (!formula) throw new Error('Enter a formula.');
        const existing = data.variables[name];
        if (existing && !existing.derived) throw new Error(`Variable "${name}" already exists.`);

        const result = this._evaluateDerivedFormula(formula, data);
        const variable = {
            name,
            data: result.values,
            description: `Derived: ${formula}`,
            kind: 'variable',
            dataType: this.parser._detectDataType(result.values, 'variable'),
            isConstant: this.parser._isConstantValues(result.values),
            interpolation: 'linear',
            derived: true,
            formula,
            ...(result.independentIndex ? { independentIndex: true, sampleIndexLength: result.values.length } : {}),
        };

        data.variables[name] = variable;
        if (!this.derivedByFile.has(fileId)) this.derivedByFile.set(fileId, new Map());
        this.derivedByFile.get(fileId).set(name, { name, formula, variable });

        this._setDerivedMessage(`Created ${name}`, 'ok');
        nameInput.value = '';
        formulaInput.value = '';
        this._hideDerivedSuggestions();
        this._renderFilteredTree();
        this._toggleDerivedForm(false);
        this._rebuildPlotsUsingVariable(fileId, name);
    } catch (err) {
        this._setDerivedMessage(err?.message || String(err), 'error');
    }
};

// A name is a scalar operand if it is a parameter or holds a single sample —
// same rule the tree-walking evaluator applied per node. It also decides the
// generated code, so it is part of the compile cache key.
function classifyOperand(variables, name) {
    const variable = variables[name];
    if (!variable) throw new Error(`Unknown variable "${name}".`);
    return (variable.kind === 'parameter' || variable.data.length === 1) ? 'scalar' : 'series';
}

proto._evaluateDerivedFormula = function(formula, data) {
    const timeVar = this._getActiveTimeVar(data);
    if (!timeVar?.data?.length) throw new Error('No time vector found.');

    const variables = data.variables;
    const classify = (name) => classifyOperand(variables, name);
    const compiled = getCompiledFormula(formula, variables, classify);

    // Unchanged from the interpreter, quirks included: a length-1 non-parameter
    // operand still clamps n to 1. Parameters are excluded, so they never do.
    const referenced = compiled.names
        .map(name => variables[name])
        .filter(variable => variable && variable.kind !== 'parameter');
    const independentIndex = referenced.some(variable => variable.independentIndex);
    const lengths = referenced.map(variable => variable.data?.length || 0).filter(Boolean);
    const n = lengths.length ? Math.min(timeVar.data.length, ...lengths) : timeVar.data.length;

    const columns = {};
    const scalars = {};
    for (const name of compiled.names) {
        const variable = variables[name];
        if (classify(name) === 'scalar') {
            scalars[name] = Number(variable.data[0]);
            continue;
        }
        if (variable.data.length !== n) {
            throw new Error(`"${name}" has ${variable.data.length} points, but time has ${n}.`);
        }
        columns[name] = variable.data;
    }

    return { values: compiled.run(columns, scalars, n), independentIndex };
};

// The grammar moved to src/expr/parse.js so the compiler and the app share one
// front end. These stay as aliases: _derivedFormulaReferences and the
// autocomplete both call them on `this`.
proto._tokenizeDerivedFormula = function(formula, variables) {
    return tokenizeExpression(formula, variables);
};

proto._parseDerivedExpression = function(tokens) {
    return parseExpression(tokens);
};

proto._normalizeDerivedFunctionName = function(name) {
    return normalizeFunctionName(name);
};

proto._getActiveTimeVar = function(data) {
    return Object.values(data.variables).find(v => v.kind === 'abscissa') || null;
};

// ─── Time-axis derived variables ──────────────────────────────────────────
// A time axis cannot be plotted against itself. The time-axis inspector (see
// time-axis-inspector-methods.js) can instead materialize two derived signals
// built from the time vector, one checkbox each:
//   index → the sample ordinal 0, 1, 2, … (+1 per sample; vertical steps where
//           several samples share a timestamp, i.e. events / repeated times)
//   delta → Δt between consecutive samples, in seconds (flat when equidistant,
//           0 at repeated timestamps, a spike wherever samples are missing)
// They reuse the derived-variable machinery (tree row, remove button, Data
// Tools, session, live-update reapplication) and work for every format,
// including lazy files (computed over the loaded overview — the inspector's
// numbers, unlike these traces, are exact).
//
// Entries carry `timeAxisIndex: true` (the historical marker for "generated
// from the time axis", kept so old sessions keep loading) plus `timeAxisKind`;
// a missing kind means 'index', which is all that existed before.

// Kind of an existing derived entry ('index' for pre-kind sessions).
proto._timeAxisEntryKind = function(entry) {
    const kind = entry?.timeAxisKind;
    return TIME_AXIS_KIND_META[kind] ? kind : 'index';
};

// How many seconds one unit of the time vector is worth, and whether it carries
// a time unit at all. Datetime axes hold epoch milliseconds; a row-index axis is
// a step count, so Δt over it is dimensionless.
proto._timeAxisSecondsScale = function(timeVar) {
    if (timeVar?.timeKind === 'datetime') return { secondsPerUnit: 1e-3, unitless: false };
    if (timeVar?.timeKind === 'index') return { secondsPerUnit: 1, unitless: true };
    return { secondsPerUnit: 1, unitless: false };
};

// Samples of the requested signal over the current time vector. Δt is converted
// to seconds so the trace reads the same whatever the axis stores.
proto._timeAxisVariableValues = function(kind, timeVar) {
    const source = timeVar?.data || [];
    const n = source.length;
    const values = new Float64Array(n);
    if (kind === 'delta') {
        const { secondsPerUnit } = this._timeAxisSecondsScale(timeVar);
        for (let i = 1; i < n; i++) {
            values[i] = (Number(source[i]) - Number(source[i - 1])) * secondsPerUnit;
        }
        // Same convention as the diff() formula function: the first sample takes
        // the forward difference, so the length and the uniform baseline hold.
        // A fabricated 0 is not an option — in a Δt signal 0 already means "two
        // samples share a timestamp", the very thing this signal exists to show.
        if (n > 1) values[0] = values[1];
    } else {
        for (let i = 0; i < n; i++) values[i] = i;
    }
    return values;
};

// Build the variable object for the current time vector. dataType is forced to
// 'real' so a 2-sample [0,1] index is not misdetected as boolean.
proto._buildTimeAxisVariable = function(name, timeVar, kind = 'index') {
    const values = this._timeAxisVariableValues(kind, timeVar);
    const meta = TIME_AXIS_KIND_META[kind] || TIME_AXIS_KIND_META.index;
    // Units are read back out of the description's trailing bracket
    // (_extractUnit), so that bracket IS how Δt gets its [s] on the Y axis. The
    // index is a plain count and deliberately carries none.
    const unitless = this._timeAxisSecondsScale(timeVar).unitless;
    const description = kind === 'delta' && !unitless
        ? `${i18n.t(meta.description)} [s]`
        : i18n.t(meta.description);
    return {
        name,
        data: values,
        description,
        kind: 'variable',
        dataType: 'real',
        isConstant: values.length <= 1,
        interpolation: 'linear',
        derived: true,
        timeAxisIndex: true,
        timeAxisKind: kind,
    };
};

// The existing time-axis derived entry of this kind for a file, if any.
proto._findTimeAxisEntry = function(fileId, kind = 'index') {
    const derived = this.derivedByFile.get(fileId);
    if (!derived) return null;
    for (const entry of derived.values()) {
        if (entry.timeAxisIndex && this._timeAxisEntryKind(entry) === kind) return entry;
    }
    return null;
};

// A collision-free identifier derived from the time variable name (e.g.
// "time" → "time_index"). An existing time-axis variable of the same kind is
// not a collision (we reuse its name); any other variable is.
proto._timeAxisVariableName = function(fileId, data, kind = 'index') {
    const timeVar = this._getActiveTimeVar(data);
    const base = String(timeVar?.name || 'time').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
    const meta = TIME_AXIS_KIND_META[kind] || TIME_AXIS_KIND_META.index;
    const derived = this.derivedByFile.get(fileId);
    const taken = (candidate) => {
        const variable = data.variables[candidate];
        if (!variable) return false;
        const entry = derived?.get(candidate);
        return !(entry && entry.timeAxisIndex && this._timeAxisEntryKind(entry) === kind);
    };
    let candidate = `${base}_${meta.suffix}`;
    for (let suffix = 2; taken(candidate); suffix++) candidate = `${base}_${meta.suffix}_${suffix}`;
    return candidate;
};

// Create (or, with { regenerate: true }, overwrite) one of the derived
// time-axis variables and wire it into the tree and any plots already using it.
proto._createOrUpdateTimeAxisVariable = function(fileId, kind = 'index', options = {}) {
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    if (!data) return null;
    const timeVar = this._getActiveTimeVar(data);
    if (!timeVar?.data?.length) return null;

    const existing = this._findTimeAxisEntry(fileId, kind);
    const name = existing?.name || this._timeAxisVariableName(fileId, data, kind);

    // Regenerate discards any Data Tools modification of this variable.
    if (options.regenerate) {
        const toolDefs = this.dataToolVariablesByFile?.get(fileId);
        if (toolDefs?.has(name)) {
            toolDefs.delete(name);
            if (!toolDefs.size) this.dataToolVariablesByFile.delete(fileId);
        }
    }

    const variable = this._buildTimeAxisVariable(name, timeVar, kind);
    data.variables[name] = variable;
    if (!this.derivedByFile.has(fileId)) this.derivedByFile.set(fileId, new Map());
    this.derivedByFile.get(fileId).set(name, { name, timeAxisIndex: true, timeAxisKind: kind, variable });

    this._renderFilteredTree();
    this._rebuildPlotsUsingVariable(fileId, name);
    return variable;
};

// Materialize one chosen kind, creating it when needed. An existing variable is
// reused unless Data Tools edited it, in which case the user decides before we
// would overwrite their work. Returns the variable name, or null if they backed out.
proto._materializeTimeAxisVariable = async function(fileId, data, kind) {
    const entry = this._findTimeAxisEntry(fileId, kind);
    if (!entry) return this._createOrUpdateTimeAxisVariable(fileId, kind)?.name || null;

    const name = entry.name;
    if (!data.variables[name]?.dataToolModified) return name;
    const choice = await Modal.choice(
        i18n.t('timeAxisIndexModifiedBody').replace('{name}', name),
        {
            title: i18n.t('timeAxisIndexModifiedTitle'),
            icon: '⚠️',
            className: 'modal-dialog-wide',
            choices: [
                { value: 'reuse', text: i18n.t('timeAxisIndexReuse'), className: 'modal-btn-confirm', autoFocus: true },
                { value: 'regenerate', text: i18n.t('timeAxisIndexRegenerate'), className: 'modal-btn-cancel' },
                { value: 'cancel', text: i18n.t('cancel'), className: 'modal-btn-cancel' },
            ],
        },
    );
    if (choice === 'reuse') return name;
    if (choice === 'regenerate') return this._createOrUpdateTimeAxisVariable(fileId, kind, { regenerate: true })?.name || null;
    return null;
};

// Drop handler for the time axis. The inspector never plots (index and Δt live on
// incomparable scales, and a drag must not mean something different from the
// sidebar button), so this always resolves to nothing: the drag is just a third
// way to open the inspector.
proto._handleTimeAxisDrop = async function(timeVarName) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    if (!fileId || !data) return null;
    const timeVar = data.variables?.[timeVarName];
    if (!timeVar || timeVar.kind !== 'abscissa' || !(timeVar.data?.length)) return null;
    await this._openTimeAxisInspector(fileId);
    return null;
};

proto._reapplyDerivedVariables = function(fileId, data) {
    const derived = this.derivedByFile.get(fileId);
    if (!derived) return;
    for (const [name, entry] of derived) {
        this._reapplyDerivedVariable(fileId, data, name, entry);
    }
};

proto._derivedFormulaReferences = function(formula, variableNames = []) {
    const variables = Object.fromEntries([...variableNames].map(name => [name, {}]));
    return this._tokenizeDerivedFormula(formula, variables)
        .filter(token => token.type === 'name')
        .map(token => token.value);
};

proto._reapplyDerivedVariable = function(fileId, data, name, entry) {
    try {
        // Time-axis variables are generated from the time vector itself (no
        // formula). Rebuild them at the current length so they survive reloads
        // and grow with live-update. Any Data Tools edit is re-applied on top of
        // the fresh values afterwards, exactly like a formula-derived variable.
        if (entry.timeAxisIndex) {
            const timeVar = this._getActiveTimeVar(data);
            if (!timeVar?.data?.length) return false;
            const variable = this._buildTimeAxisVariable(name, timeVar, this._timeAxisEntryKind(entry));
            data.variables[name] = variable;
            entry.variable = variable;
            return true;
        }
        const result = this._evaluateDerivedFormula(entry.formula, data);
        const variable = {
            name,
            data: result.values,
            description: `Derived: ${entry.formula}`,
            kind: 'variable',
            dataType: this.parser._detectDataType(result.values, 'variable'),
            isConstant: this.parser._isConstantValues(result.values),
            interpolation: 'linear',
            derived: true,
            formula: entry.formula,
            ...(result.independentIndex ? { independentIndex: true, sampleIndexLength: result.values.length } : {}),
        };
        data.variables[name] = variable;
        entry.variable = variable;
        return true;
    } catch (err) {
        console.warn(`Could not reapply derived variable ${name}:`, err);
        return false;
    }
};

proto._removeDerivedVariable = function(name) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    if (!fileId || !data) return;
    this.derivedByFile.get(fileId)?.delete(name);
    const dataToolDefinitions = this.dataToolVariablesByFile?.get(fileId);
    dataToolDefinitions?.delete(name);
    if (dataToolDefinitions && !dataToolDefinitions.size) this.dataToolVariablesByFile.delete(fileId);
    delete data.variables[name];
    for (const [panelId, plot] of this.plotManager.plots) {
        const beforeTs = plot.traces.length;
        const beforePh = plot.phaseTraces.length;
        plot.traces = plot.traces.filter(t => !(t.fileId === fileId && t.varName === name));
        plot.phaseTraces = plot.phaseTraces.filter(t => !(t.fileId === fileId && (t.x === name || t.y === name || t.z === name)));
        if (beforeTs !== plot.traces.length || beforePh !== plot.phaseTraces.length) this.plotManager._rebuildPanel(panelId);
    }
    this._renderFilteredTree();
};

proto._rebuildPlotsUsingVariable = function(fileId, name) {
    for (const [panelId, plot] of this.plotManager.plots) {
        const usesTimeseries = plot.traces.some(t => t.fileId === fileId && t.varName === name);
        const usesPhase = plot.phaseTraces.some(t => t.fileId === fileId && (t.x === name || t.y === name || t.z === name));
        if (usesTimeseries || usesPhase) this.plotManager._rebuildPanel(panelId);
    }
};

proto._toggleDerivedForm = function(show) {
    const form = document.getElementById('derived-form');
    form.classList.toggle('collapsed', !show);
    if (show) {
        document.getElementById('derived-name').focus();
    }
    else {
        this._setDerivedMessage('', '');
        this._hideDerivedSuggestions();
    }
};

proto._setDerivedMessage = function(message, type) {
    const el = document.getElementById('derived-message');
    el.textContent = message;
    el.className = `derived-message${type ? ' ' + type : ''}`;
};

proto._toggleDerivedHelpPopover = function(show) {
    const popover = document.getElementById('derived-help-popover');
    const button = document.getElementById('derived-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
};

proto._getDerivedSuggestions = function(prefix) {
    const data = this.plotManager.data;
    if (!data || !prefix) return [];
    const needle = prefix.toLowerCase();
    const functionSuggestions = DERIVED_FUNCTIONS
        .filter(fn => fn.name.startsWith(needle))
        .map(fn => ({ type: 'function', name: fn.name, kind: 'fn' }));
    const variableSuggestions = Object.entries(data.variables)
        .map(([name, variable]) => ({ name: variable.name || name, variable }))
        .filter(({ name, variable }) => {
            // The time axis (abscissa) is a valid operand — expose it so formulas
            // like diff(time) or time/period are discoverable, not just typeable.
            if (variable.plottable === false) return false;
            const displayName = variable.displayName || '';
            return name.toLowerCase().includes(needle) || displayName.toLowerCase().includes(needle);
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, Math.max(0, 8 - functionSuggestions.length))
        .map(({ name, variable }) => ({
            type: 'variable',
            name,
            kind: variable.kind === 'parameter' ? 'param' : (variable.kind === 'abscissa' ? 'time' : 'var'),
        }));
    return [...functionSuggestions, ...variableSuggestions];
};

proto._updateDerivedSuggestions = function(e) {
    const input = e.target;
    const left = input.value.slice(0, input.selectionStart);
    const match = left.match(/`?([A-Za-z0-9_.\[\]]*)$/);
    const prefix = match ? match[1] : '';
    const suggestions = this._getDerivedSuggestions(prefix);
    const box = document.getElementById('derived-suggestions');
    box.innerHTML = '';
    this._suggestionIndex = 0;
    if (!suggestions.length) { box.hidden = true; return; }
    for (const suggestion of suggestions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'derived-suggestion';
        btn.dataset.suggestionType = suggestion.type;
        btn.dataset.suggestionName = suggestion.name;
        const name = document.createElement('span');
        name.className = 'derived-suggestion-name';
        name.textContent = suggestion.name;
        const kind = document.createElement('span');
        kind.className = 'derived-suggestion-kind';
        kind.textContent = suggestion.kind;
        btn.append(name, kind);
        btn.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            this._insertDerivedSuggestion(suggestion);
        });
        box.appendChild(btn);
    }
    this._markActiveSuggestion();
    this._positionDerivedSuggestions();
    box.hidden = false;
};

proto._handleDerivedFormulaKeydown = function(e) {
    const box = document.getElementById('derived-suggestions');
    const items = [...box.querySelectorAll('.derived-suggestion')];
    if (!box.hidden && items.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._suggestionIndex = (this._suggestionIndex + 1) % items.length; this._markActiveSuggestion(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this._suggestionIndex = (this._suggestionIndex - 1 + items.length) % items.length; this._markActiveSuggestion(); return; }
        if (e.key === 'Tab' || e.key === 'Enter') {
            e.preventDefault();
            this._insertDerivedSuggestionFromElement(items[this._suggestionIndex]);
            return;
        }
        if (e.key === 'Escape') { this._hideDerivedSuggestions(); return; }
    }
    if (e.key === 'Enter') this.createDerivedVariable();
};

proto._insertDerivedSuggestionFromElement = function(item) {
    if (!item) return;
    this._insertDerivedSuggestion({
        type: item.dataset.suggestionType,
        name: item.dataset.suggestionName,
    });
};

proto._insertDerivedSuggestion = function(suggestion) {
    const input = document.getElementById('derived-formula');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const left = input.value.slice(0, start);
    const right = input.value.slice(end);
    const match = left.match(/`?[A-Za-z0-9_.\[\]]*$/);
    const replaceStart = match ? start - match[0].length : start;
    const name = suggestion?.name || '';
    const isFunction = suggestion?.type === 'function';
    const insert = isFunction
        ? `${name}()`
        : (/^[A-Za-z_][A-Za-z0-9_.\[\]]*$/.test(name) ? name : `\`${name}\``);
    input.value = input.value.slice(0, replaceStart) + insert + right;
    const cursor = replaceStart + insert.length - (isFunction ? 1 : 0);
    input.setSelectionRange(cursor, cursor);
    input.focus();
    this._hideDerivedSuggestions();
};

proto._markActiveSuggestion = function() {
    const items = [...document.querySelectorAll('#derived-suggestions .derived-suggestion')];
    items.forEach((item, i) => item.classList.toggle('active', i === this._suggestionIndex));
};

proto._hideDerivedSuggestions = function() {
    const box = document.getElementById('derived-suggestions');
    if (box) box.hidden = true;
};

proto._positionDerivedSuggestions = function() {
    const input = document.getElementById('derived-formula');
    const box = document.getElementById('derived-suggestions');
    const sidebar = document.getElementById('sidebar');
    if (!input || !box || !sidebar) return;
    const inputRect = input.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const spaceBelow = sidebarRect.bottom - inputRect.bottom;
    const spaceAbove = inputRect.top - sidebarRect.top;
    const openUp = spaceBelow < 170 && spaceAbove > spaceBelow;
    box.classList.toggle('open-up', openUp);
    box.style.maxHeight = `${Math.max(96, Math.min(180, (openUp ? spaceAbove : spaceBelow) - 12))}px`;
};

}
