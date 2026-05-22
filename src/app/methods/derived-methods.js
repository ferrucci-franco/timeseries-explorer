import i18n from '../../i18n/index.js';
import { DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES } from '../constants.js';

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
            formula
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

proto._evaluateDerivedFormula = function(formula, data) {
    const timeVar = this._getActiveTimeVar(data);
    if (!timeVar?.data?.length) throw new Error('No time vector found.');
    const tokens = this._tokenizeDerivedFormula(formula, data.variables);
    const ast = this._parseDerivedExpression(tokens);
    const n = timeVar.data.length;
    const evaluated = this._evalDerivedNode(ast, data, n);
    const values = evaluated.kind === 'series' ? evaluated.values : Array.from({ length: n }, () => evaluated.value);
    return { values };
};

proto._tokenizeDerivedFormula = function(formula, variables) {
    const tokens = [];
    let i = 0;
    while (i < formula.length) {
        const ch = formula[i];
        if (/\s/.test(ch)) { i++; continue; }
        if ('+-*/^(),'.includes(ch)) { tokens.push({ type: ch, value: ch }); i++; continue; }
        if (ch === '`') {
            const end = formula.indexOf('`', i + 1);
            if (end < 0) throw new Error('Missing closing backtick.');
            const name = formula.slice(i + 1, end);
            if (!variables[name]) throw new Error(`Unknown variable "${name}".`);
            tokens.push({ type: 'name', value: name });
            i = end + 1;
            continue;
        }
        if (/\d|\./.test(ch)) {
            const match = formula.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
            if (!match) throw new Error(`Unexpected "." at position ${i + 1}.`);
            tokens.push({ type: 'number', value: Number(match[0]) });
            i += match[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let j = i + 1;
            while (j < formula.length && /[A-Za-z0-9_.\[\]]/.test(formula[j])) j++;
            const name = formula.slice(i, j);
            const nextNonSpace = this._nextNonSpaceChar(formula, j);
            const functionName = this._normalizeDerivedFunctionName(name);
            if (nextNonSpace === '(' && functionName) {
                tokens.push({ type: 'func', value: functionName });
                i = j;
                continue;
            }
            if (!variables[name]) throw new Error(`Unknown variable "${name}".`);
            tokens.push({ type: 'name', value: name });
            i = j;
            continue;
        }
        throw new Error(`Unexpected "${ch}" at position ${i + 1}.`);
    }
    return tokens;
};

proto._nextNonSpaceChar = function(text, start) {
    let i = start;
    while (i < text.length && /\s/.test(text[i])) i++;
    return text[i] || '';
};

proto._normalizeDerivedFunctionName = function(name) {
    const lower = String(name).toLowerCase();
    if (DERIVED_FUNCTIONS.some(fn => fn.name === lower)) return lower;
    return DERIVED_FUNCTION_ALIASES.get(lower) || '';
};

proto._parseDerivedExpression = function(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const take = (type) => (peek()?.type === type ? tokens[pos++] : null);
    const parsePrimary = () => {
        const token = peek();
        if (!token) throw new Error('Unexpected end of formula.');
        if (take('number')) return { type: 'number', value: token.value };
        if (take('name')) return { type: 'name', value: token.value };
        if (take('func')) {
            const name = token.value;
            if (!take('(')) throw new Error(`Missing opening parenthesis after "${name}".`);
            const args = [];
            if (!take(')')) {
                do {
                    args.push(parseAddSub());
                } while (take(','));
                if (!take(')')) throw new Error(`Missing closing parenthesis for "${name}".`);
            }
            return { type: 'func', name, args };
        }
        if (take('(')) {
            const expr = parseAddSub();
            if (!take(')')) throw new Error('Missing closing parenthesis.');
            return expr;
        }
        throw new Error(`Unexpected "${token.value}".`);
    };
    const parsePower = () => {
        let node = parsePrimary();
        if (take('^')) {
            node = { type: 'binary', op: '^', left: node, right: parseUnary() };
        }
        return node;
    };
    const parseUnary = () => {
        if (take('+')) return parseUnary();
        if (take('-')) return { type: 'unary', op: '-', expr: parseUnary() };
        return parsePower();
    };
    const parseMulDiv = () => {
        let node = parseUnary();
        while (peek()?.type === '*' || peek()?.type === '/') {
            const op = tokens[pos++].type;
            node = { type: 'binary', op, left: node, right: parseUnary() };
        }
        return node;
    };
    const parseAddSub = () => {
        let node = parseMulDiv();
        while (peek()?.type === '+' || peek()?.type === '-') {
            const op = tokens[pos++].type;
            node = { type: 'binary', op, left: node, right: parseMulDiv() };
        }
        return node;
    };
    const ast = parseAddSub();
    if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}".`);
    return ast;
};

proto._evalDerivedNode = function(node, data, n) {
    if (node.type === 'number') return { kind: 'scalar', value: node.value };
    if (node.type === 'name') {
        const variable = data.variables[node.value];
        if (!variable) throw new Error(`Unknown variable "${node.value}".`);
        if (variable.kind === 'parameter' || variable.data.length === 1) return { kind: 'scalar', value: Number(variable.data[0]) };
        if (variable.data.length !== n) throw new Error(`"${node.value}" has ${variable.data.length} points, but time has ${n}.`);
        return { kind: 'series', values: variable.data };
    }
    if (node.type === 'unary') {
        const v = this._evalDerivedNode(node.expr, data, n);
        return v.kind === 'scalar' ? { kind: 'scalar', value: -v.value } : { kind: 'series', values: v.values.map(x => -x) };
    }
    if (node.type === 'func') return this._evalDerivedFunction(node, data, n);
    const left = this._evalDerivedNode(node.left, data, n);
    const right = this._evalDerivedNode(node.right, data, n);
    const apply = (a, b) => {
        switch (node.op) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': return a / b;
            case '^': return Math.pow(a, b);
            default: throw new Error(`Unknown operator "${node.op}".`);
        }
    };
    if (left.kind === 'scalar' && right.kind === 'scalar') return { kind: 'scalar', value: apply(left.value, right.value) };
    const values = new Array(n);
    for (let i = 0; i < n; i++) values[i] = apply(left.kind === 'series' ? left.values[i] : left.value, right.kind === 'series' ? right.values[i] : right.value);
    return { kind: 'series', values };
};

proto._evalDerivedFunction = function(node, data, n) {
    const name = node.name;
    const args = node.args.map(arg => this._evalDerivedNode(arg, data, n));
    const arity = args.length;
    const requireArity = (expected, label = name) => {
        if (arity !== expected) throw new Error(`${label}() expects ${expected} argument${expected === 1 ? '' : 's'}.`);
    };
    const valueAt = (arg, i) => arg.kind === 'series' ? arg.values[i] : arg.value;
    const mapUnary = (fn) => {
        const a = args[0];
        if (a.kind === 'scalar') return { kind: 'scalar', value: fn(a.value) };
        return { kind: 'series', values: a.values.map(fn) };
    };
    const mapBinary = (fn) => {
        const [a, b] = args;
        if (a.kind === 'scalar' && b.kind === 'scalar') return { kind: 'scalar', value: fn(a.value, b.value) };
        const values = new Array(n);
        for (let i = 0; i < n; i++) values[i] = fn(valueAt(a, i), valueAt(b, i));
        return { kind: 'series', values };
    };

    if (name === 'sqrt') {
        requireArity(1, name);
        return mapUnary(v => Math.sqrt(v));
    }
    if (name === 'abs') {
        requireArity(1, name);
        return mapUnary(v => Math.abs(v));
    }
    if (name === 'log') {
        requireArity(1, name);
        return mapUnary(v => Math.log(v));
    }
    if (name === 'log10') {
        requireArity(1, name);
        return mapUnary(v => Math.log10(v));
    }
    if (name === 'square') {
        requireArity(1, name);
        return mapUnary(v => v * v);
    }
    if (name === 'root') {
        requireArity(2, name);
        return mapBinary((v, degree) => this._nthRoot(v, degree));
    }
    if (name === 'power') {
        requireArity(2, name);
        return mapBinary((v, exponent) => Math.pow(v, exponent));
    }
    throw new Error(`Unknown function "${name}".`);
};

proto._nthRoot = function(value, degree) {
    const d = Number(degree);
    if (!Number.isFinite(d) || d === 0) return NaN;
    const rounded = Math.round(d);
    const isIntegerDegree = Math.abs(d - rounded) <= 1e-12;
    let result;
    if (value < 0 && isIntegerDegree && rounded % 2 !== 0) {
        result = -Math.pow(Math.abs(value), 1 / rounded);
    } else {
        result = Math.pow(value, 1 / d);
    }
    return this._cleanDerivedNumber(result);
};

proto._cleanDerivedNumber = function(value) {
    if (!Number.isFinite(value)) return value;
    const rounded = Math.round(value);
    const tolerance = Math.max(1, Math.abs(value)) * 1e-12;
    return Math.abs(value - rounded) <= tolerance ? rounded : value;
};

proto._getActiveTimeVar = function(data) {
    return Object.values(data.variables).find(v => v.kind === 'abscissa') || null;
};

proto._reapplyDerivedVariables = function(fileId, data) {
    const derived = this.derivedByFile.get(fileId);
    if (!derived) return;
    for (const [name, entry] of derived) {
        try {
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
                formula: entry.formula
            };
            data.variables[name] = variable;
            entry.variable = variable;
        } catch (err) {
            console.warn(`Could not reapply derived variable ${name}:`, err);
        }
    }
};

proto._removeDerivedVariable = function(name) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    if (!fileId || !data) return;
    this.derivedByFile.get(fileId)?.delete(name);
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

proto._toggleTimeseriesDownsamplingHelpPopover = function(show) {
    const popover = document.getElementById('timeseries-downsampling-help-popover');
    const button = document.getElementById('timeseries-downsampling-help-toggle');
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
        .filter(({ name, variable }) => variable.kind !== 'abscissa' && name.toLowerCase().includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, Math.max(0, 8 - functionSuggestions.length))
        .map(({ name, variable }) => ({
            type: 'variable',
            name,
            kind: variable.kind === 'parameter' ? 'param' : 'var',
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
