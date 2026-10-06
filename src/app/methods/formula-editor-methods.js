import i18n from '../../i18n/index.js';
import { DERIVED_CONSTANTS, DERIVED_FUNCTIONS } from '../constants.js';
import { getCompiledFormula } from '../../expr/compile.js';
import { tokenize as tokenizeExpression } from '../../expr/parse.js';
import { formulaNameLiteral } from './derived-methods.js';

// ─── The formula editor, full size ───────────────────────────────────────────
//
// The side panel's formula box is one line in a 320 px column. That is enough
// for `x / y^2`, and not for adding up ten signals whose names run to forty
// characters: the user scrolls inside the field, types names back from memory
// and counts pluses. This is the same form, opened large, built to be driven
// with the mouse:
//
//   · the formula is a multi-line box, so a long one is read whole;
//   · operators, functions and constants are buttons — a click inserts at the
//     cursor (a function wraps whatever is selected), a drag drops them where
//     the mouse lets go;
//   · every variable of the file is a pill. In "Click inserts" mode a click
//     inserts it at the cursor, as many times as it is clicked: a variable used
//     twice is simply clicked twice. Clicked right after another operand, it is
//     joined with " + ", so clicking ten pills in a row writes a sum;
//   · in "Click selects" mode a click selects, a second click deselects, the
//     order of selection is kept and numbered, and one button writes sum(…),
//     mean(…), min(…) or max(…) over the whole selection;
//   · pills already in the formula are marked, and a filter narrows the list.
//
// It never holds a formula of its own: the side panel's name and formula
// fields stay the single source, kept in step on every keystroke, and Create
// is the side panel's Create. Minimise goes back to the side panel with
// everything as it was; so does Escape.

// The functions offered over a selection, in the order of the buttons.
const LIST_FUNCTIONS = ['sum', 'mean', 'min', 'max'];

// Operator buttons: what they show, what they insert.
const OPERATORS = [
    ['+', ' + '], ['−', ' - '], ['×', ' * '], ['÷', ' / '], ['^', '^'],
    ['(', '('], [')', ')'], [',', ', '],
];

// Function groups, in the palette's order. Anything in DERIVED_FUNCTIONS not
// listed here lands in the last group, so a new function is never missing.
const FUNCTION_GROUPS = [
    ['sum', 'mean', 'min', 'max'],
    ['sqrt', 'abs', 'square', 'power', 'root', 'log', 'log10'],
    ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh'],
    ['sign', 'step', 'diff', 'cumsum'],
];

const MINIMIZE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// Whether the text before the cursor ends with an operand — a name, a number,
// a closing bracket or backtick — after which a new operand needs an operator.
export function endsWithOperand(text) {
    return /[A-Za-z0-9_.\])`]\s*$/.test(text);
}

// What a pill or palette button writes into the formula.
export function functionCall(name, inner = '') {
    return `${name}(${inner})`;
}

export function listCall(name, names) {
    return functionCall(name, names.map(formulaNameLiteral).join(', '));
}

export function installFormulaEditorMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // The button beside the side panel's formula box.
    proto._installFormulaEditorButton = function() {
        const wrap = document.querySelector('#derived-form .derived-formula-wrap');
        if (!wrap || wrap.querySelector('.derived-expand-btn')) return;
        const btn = el('button', 'derived-expand-btn');
        btn.type = 'button';
        btn.id = 'derived-expand';
        btn.innerHTML = EXPAND_ICON;
        btn.title = i18n.t('formulaEditorOpen');
        btn.setAttribute('aria-label', i18n.t('formulaEditorOpen'));
        // Retranslated with the rest of the page on a language switch.
        btn.dataset.i18nTitle = 'formulaEditorOpen';
        btn.dataset.i18nAriaLabel = 'formulaEditorOpen';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            this._openFormulaEditor();
        });
        wrap.classList.add('has-expand');
        wrap.appendChild(btn);
    };

    proto._formulaEditorData = function() {
        const fileId = this.activeFileId;
        return fileId ? this.plotManager.files.get(fileId)?.data || null : null;
    };

    proto._openFormulaEditor = function() {
        if (this._formulaEditor) return;
        const sideName = document.getElementById('derived-name');
        const sideFormula = document.getElementById('derived-formula');
        if (!sideName || !sideFormula) return;
        this._hideDerivedSuggestions?.();

        const editing = !!this._derivedEditing;
        const state = {
            mode: 'insert',
            selection: [],
            filter: '',
            pills: new Map(),
            validateTimer: null,
            returnFocus: document.activeElement,
        };
        this._formulaEditor = state;

        const overlay = el('div', 'formula-editor-overlay');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'formula-editor-title');
        const box = el('div', 'formula-editor');
        overlay.appendChild(box);
        state.overlay = overlay;

        // ── Header ──
        const header = el('div', 'formula-editor-header');
        const title = el('div', 'formula-editor-title', i18n.t('formulaEditorTitle'));
        title.id = 'formula-editor-title';
        const fileEntry = this.activeFileId != null ? this.files.get(this.activeFileId) : null;
        const fileName = fileEntry ? (this._fileDisplayName?.(fileEntry) || fileEntry.name || '') : '';
        if (fileName) title.appendChild(el('span', 'formula-editor-file', fileName));
        const minimize = el('button', 'formula-editor-minimize');
        minimize.type = 'button';
        minimize.innerHTML = MINIMIZE_ICON;
        minimize.title = i18n.t('formulaEditorMinimize');
        minimize.setAttribute('aria-label', i18n.t('formulaEditorMinimize'));
        minimize.addEventListener('click', () => this._closeFormulaEditor());
        header.append(title, minimize);

        // ── Name and formula ──
        const main = el('div', 'formula-editor-main');
        const nameLabel = el('label', 'formula-editor-field formula-editor-name-field');
        nameLabel.appendChild(el('span', 'formula-editor-label', i18n.t('formulaEditorName')));
        const nameInput = el('input', 'formula-editor-name');
        nameInput.type = 'text';
        nameInput.value = sideName.value;
        nameInput.placeholder = sideName.placeholder || 'name';
        nameInput.spellcheck = false;
        nameLabel.appendChild(nameInput);
        const formulaLabel = el('label', 'formula-editor-field formula-editor-formula-field');
        formulaLabel.appendChild(el('span', 'formula-editor-label', i18n.t('formulaEditorFormula')));
        const formulaInput = el('textarea', 'formula-editor-formula');
        formulaInput.value = sideFormula.value;
        formulaInput.rows = 4;
        formulaInput.spellcheck = false;
        formulaInput.placeholder = sideFormula.placeholder || '';
        formulaInput.setAttribute('autocomplete', 'off');
        formulaLabel.appendChild(formulaInput);
        const status = el('div', 'formula-editor-status');
        status.setAttribute('aria-live', 'polite');
        main.append(nameLabel, formulaLabel, status);
        state.nameInput = nameInput;
        state.formulaInput = formulaInput;
        state.status = status;

        // ── Operators, functions, constants ──
        const palette = el('div', 'formula-editor-palette');
        const operators = el('div', 'formula-editor-group formula-editor-operators');
        operators.appendChild(el('span', 'formula-editor-group-label', i18n.t('formulaEditorOperators')));
        for (const [label, text] of OPERATORS) {
            operators.appendChild(this._formulaEditorChip(label, 'formula-editor-op', {
                drag: text.trim() || text,
                onClick: () => this._formulaEditorInsert(text),
            }));
        }
        palette.appendChild(operators);

        const functions = el('div', 'formula-editor-group formula-editor-functions');
        functions.appendChild(el('span', 'formula-editor-group-label', i18n.t('formulaEditorFunctions')));
        const available = DERIVED_FUNCTIONS.map(fn => fn.name);
        const placed = new Set();
        const groups = FUNCTION_GROUPS.map(group => group.filter(name => available.includes(name)));
        groups.forEach(group => group.forEach(name => placed.add(name)));
        const rest = available.filter(name => !placed.has(name));
        if (rest.length) groups.push(rest);
        groups.forEach((group, index) => {
            if (!group.length) return;
            if (index > 0) functions.appendChild(el('span', 'formula-editor-sep'));
            for (const name of group) {
                functions.appendChild(this._formulaEditorChip(`${name}( )`, 'formula-editor-fn', {
                    drag: functionCall(name),
                    title: name,
                    onClick: () => this._formulaEditorInsertFunction(name),
                }));
            }
        });
        const data = this._formulaEditorData();
        const constants = [...DERIVED_CONSTANTS.keys()].filter(name => !name.startsWith('math.'));
        if (constants.length) {
            functions.appendChild(el('span', 'formula-editor-sep'));
            for (const name of constants) {
                const written = data?.variables?.[name] ? `math.${name}` : name;
                functions.appendChild(this._formulaEditorChip(written, 'formula-editor-const', {
                    drag: written,
                    onClick: () => this._formulaEditorInsertOperand(written),
                }));
            }
        }
        palette.appendChild(functions);

        // ── Variables ──
        const vars = el('div', 'formula-editor-variables');
        const varBar = el('div', 'formula-editor-var-bar');
        const varTitle = el('span', 'formula-editor-group-label formula-editor-var-title');
        const filter = el('input', 'formula-editor-filter');
        filter.type = 'search';
        filter.placeholder = i18n.t('formulaEditorFilter');
        filter.setAttribute('aria-label', i18n.t('formulaEditorFilter'));
        filter.addEventListener('input', () => {
            state.filter = filter.value.trim().toLowerCase();
            this._formulaEditorApplyFilter();
        });
        const modes = el('div', 'formula-editor-modes');
        modes.setAttribute('role', 'radiogroup');
        state.modeButtons = new Map();
        for (const [mode, key] of [['insert', 'formulaEditorModeInsert'], ['select', 'formulaEditorModeSelect']]) {
            const btn = el('button', 'formula-editor-mode', i18n.t(key));
            btn.type = 'button';
            btn.dataset.mode = mode;
            btn.setAttribute('role', 'radio');
            btn.addEventListener('click', () => this._formulaEditorSetMode(mode));
            state.modeButtons.set(mode, btn);
            modes.appendChild(btn);
        }
        varBar.append(varTitle, filter, modes);
        const hint = el('div', 'formula-editor-hint');
        const selectionBar = el('div', 'formula-editor-selection-bar');
        const selectionCount = el('span', 'formula-editor-selection-count');
        selectionBar.appendChild(selectionCount);
        state.listButtons = [];
        for (const name of LIST_FUNCTIONS.filter(fn => available.includes(fn))) {
            const btn = el('button', 'formula-editor-list-btn', `${name}(…)`);
            btn.type = 'button';
            btn.dataset.fn = name;
            btn.title = i18n.t('formulaEditorInsertList').replace('{fn}', name);
            btn.addEventListener('click', () => this._formulaEditorInsertSelection(name));
            state.listButtons.push(btn);
            selectionBar.appendChild(btn);
        }
        const selectShown = el('button', 'formula-editor-link-btn', i18n.t('formulaEditorSelectShown'));
        selectShown.type = 'button';
        selectShown.addEventListener('click', () => this._formulaEditorSelectShown());
        const clear = el('button', 'formula-editor-link-btn', i18n.t('formulaEditorClearSelection'));
        clear.type = 'button';
        clear.addEventListener('click', () => {
            state.selection = [];
            this._formulaEditorSyncSelection();
        });
        selectionBar.append(selectShown, clear);
        const pills = el('div', 'formula-editor-pills');
        vars.append(varBar, hint, selectionBar, pills);
        state.varTitle = varTitle;
        state.hint = hint;
        state.selectionBar = selectionBar;
        state.selectionCount = selectionCount;
        state.pillBox = pills;
        state.filterInput = filter;

        for (const variable of this._formulaEditorVariables(data)) {
            const pill = this._formulaEditorChip('', 'formula-editor-pill', {
                drag: formulaNameLiteral(variable.name),
                title: variable.title,
                onClick: () => this._formulaEditorPillClick(variable.name),
            });
            pill.dataset.name = variable.name;
            pill.dataset.kind = variable.kind;
            const order = el('span', 'formula-editor-pill-order');
            const label = el('span', 'formula-editor-pill-name', variable.name);
            pill.append(order, label);
            if (variable.tag) pill.appendChild(el('span', 'formula-editor-pill-tag', variable.tag));
            state.pills.set(variable.name, pill);
            pills.appendChild(pill);
        }
        if (!state.pills.size) pills.appendChild(el('div', 'formula-editor-empty', i18n.t('formulaEditorNoFile')));

        // ── Footer ──
        const footer = el('div', 'formula-editor-footer');
        const message = el('div', 'formula-editor-message');
        message.setAttribute('aria-live', 'polite');
        const shortcut = el('span', 'formula-editor-shortcut', i18n.t('formulaEditorShortcut'));
        const cancel = el('button', 'derived-cancel-btn formula-editor-cancel', i18n.t('cancel'));
        cancel.type = 'button';
        cancel.addEventListener('click', () => {
            this._closeFormulaEditor();
            this._toggleDerivedForm(false);
        });
        const create = el('button', 'derived-create-btn formula-editor-create', i18n.t(editing ? 'derivedUpdate' : 'derivedCreate'));
        create.type = 'button';
        create.addEventListener('click', () => this._formulaEditorCreate());
        footer.append(message, shortcut, cancel, create);
        state.message = message;

        const body = el('div', 'formula-editor-body');
        body.append(main, palette, vars);
        box.append(header, body, footer);

        // ── Keeping the side panel in step ──
        const syncSide = () => {
            sideName.value = nameInput.value;
            // The side panel's box is one line; a newline there would be lost.
            sideFormula.value = formulaInput.value.replace(/\s*\n\s*/g, ' ');
        };
        state.syncSide = syncSide;
        nameInput.addEventListener('input', syncSide);
        formulaInput.addEventListener('input', () => {
            syncSide();
            this._formulaEditorScheduleValidate();
        });
        // Remember where the cursor was: a click on a pill or a button takes
        // the focus away, and the insertion belongs where the user left it.
        const rememberCaret = () => {
            state.caret = [formulaInput.selectionStart, formulaInput.selectionEnd];
        };
        for (const type of ['keyup', 'mouseup', 'select', 'input', 'blur']) formulaInput.addEventListener(type, rememberCaret);
        // A drop is an edit like any other.
        formulaInput.addEventListener('drop', () => setTimeout(() => {
            syncSide();
            rememberCaret();
            this._formulaEditorScheduleValidate();
        }, 0));

        state.onKey = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this._closeFormulaEditor();
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                this._formulaEditorCreate();
            }
        };
        document.addEventListener('keydown', state.onKey, true);
        overlay.addEventListener('mousedown', (event) => {
            if (event.target === overlay) this._closeFormulaEditor();
        });

        document.body.appendChild(overlay);
        this._formulaEditorSetMode('insert');
        this._formulaEditorSyncSelection();
        this._formulaEditorApplyFilter();
        this._formulaEditorValidate();
        requestAnimationFrame(() => overlay.classList.add('show'));
        const focusTarget = nameInput.value.trim() ? formulaInput : nameInput;
        focusTarget.focus();
        if (focusTarget === formulaInput) {
            const end = formulaInput.value.length;
            formulaInput.setSelectionRange(end, end);
        }
        state.caret = [formulaInput.value.length, formulaInput.value.length];
    };

    // Back to the side panel, with the name and formula as they are now.
    proto._closeFormulaEditor = function() {
        const state = this._formulaEditor;
        if (!state) return;
        state.syncSide?.();
        clearTimeout(state.validateTimer);
        document.removeEventListener('keydown', state.onKey, true);
        state.overlay.remove();
        this._formulaEditor = null;
        const sideFormula = document.getElementById('derived-formula');
        const form = document.getElementById('derived-form');
        if (sideFormula && form && !form.classList.contains('collapsed')) {
            sideFormula.focus({ preventScroll: true });
            const end = sideFormula.value.length;
            sideFormula.setSelectionRange(end, end);
        }
    };

    proto._formulaEditorCreate = function() {
        const state = this._formulaEditor;
        if (!state) return;
        state.syncSide();
        this.createDerivedVariable();
        const form = document.getElementById('derived-form');
        const sideMessage = document.getElementById('derived-message');
        // Created (or updated): the side panel closed its form. Otherwise its
        // message says why not, and the editor shows it where the user is.
        if (form?.classList.contains('collapsed')) {
            this._closeFormulaEditor();
            return;
        }
        state.message.textContent = sideMessage?.textContent || '';
        state.message.className = `formula-editor-message ${sideMessage?.classList.contains('error') ? 'error' : ''}`;
    };

    proto._formulaEditorChip = function(text, className, { drag = null, title = '', onClick } = {}) {
        const chip = el('button', `formula-editor-chip ${className}`, text);
        chip.type = 'button';
        if (title) chip.title = title;
        // No preventDefault on mousedown to keep the formula box focused: it
        // would also stop the chip from being dragged. The box's cursor is
        // remembered on blur instead (state.caret), and restored on insertion.
        chip.addEventListener('click', () => onClick?.());
        if (drag) {
            chip.draggable = true;
            chip.addEventListener('dragstart', (event) => {
                event.dataTransfer.setData('text/plain', drag);
                event.dataTransfer.effectAllowed = 'copy';
            });
        }
        return chip;
    };

    // Every variable a formula can read, in the file's own order.
    proto._formulaEditorVariables = function(data) {
        if (!data?.variables) return [];
        const out = [];
        for (const [key, variable] of Object.entries(data.variables)) {
            if (variable.plottable === false || variable.previewOnly) continue;
            const name = variable.name || key;
            const kind = variable.kind === 'abscissa' ? 'time'
                : variable.kind === 'parameter' ? 'param'
                    : variable.derived ? 'derived' : 'var';
            const description = variable.description ? ` — ${variable.description}` : '';
            out.push({
                name,
                kind,
                // Said only where the name does not say it already ("time").
                tag: kind === 'var' || name.toLowerCase() === kind ? '' : kind,
                title: `${name}${description}`,
            });
        }
        return out;
    };

    // ── Writing into the formula ──

    // Puts `text` where the cursor was, or over the selection, and leaves the
    // cursor `caretFromEnd` characters before the end of what was written.
    proto._formulaEditorInsert = function(text, { caretFromEnd = 0, replaceSelection = true } = {}) {
        const state = this._formulaEditor;
        if (!state) return;
        const input = state.formulaInput;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        const before = input.value.slice(0, start);
        const after = input.value.slice(replaceSelection ? end : start);
        input.value = before + text + after;
        const caret = start + text.length - caretFromEnd;
        input.focus();
        input.setSelectionRange(caret, caret);
        state.caret = [caret, caret];
        state.syncSide();
        this._formulaEditorScheduleValidate();
    };

    // An operand: a variable, a constant. After another operand it is joined
    // with " + ", so clicking ten pills in a row writes their sum.
    proto._formulaEditorInsertOperand = function(literal) {
        const state = this._formulaEditor;
        if (!state) return;
        const input = state.formulaInput;
        const [start] = state.caret || [input.value.length];
        const before = input.value.slice(0, start);
        this._formulaEditorInsert(endsWithOperand(before) ? ` + ${literal}` : literal);
    };

    // A function wraps what is selected in the formula, or opens empty with
    // the cursor between its brackets.
    proto._formulaEditorInsertFunction = function(name) {
        const state = this._formulaEditor;
        if (!state) return;
        const input = state.formulaInput;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        const selected = input.value.slice(start, end);
        if (selected.trim()) {
            this._formulaEditorInsert(functionCall(name, selected));
        } else {
            const before = input.value.slice(0, start);
            const lead = endsWithOperand(before) ? ' * ' : '';
            this._formulaEditorInsert(lead + functionCall(name), { caretFromEnd: 1 });
        }
    };

    proto._formulaEditorPillClick = function(name) {
        const state = this._formulaEditor;
        if (!state) return;
        if (state.mode === 'select') {
            const index = state.selection.indexOf(name);
            if (index >= 0) state.selection.splice(index, 1);
            else state.selection.push(name);
            this._formulaEditorSyncSelection();
            return;
        }
        this._formulaEditorInsertOperand(formulaNameLiteral(name));
    };

    proto._formulaEditorInsertSelection = function(fn) {
        const state = this._formulaEditor;
        if (!state || !state.selection.length) return;
        const input = state.formulaInput;
        const [start] = state.caret || [input.value.length];
        const before = input.value.slice(0, start);
        const lead = endsWithOperand(before) ? ' + ' : '';
        this._formulaEditorInsert(lead + listCall(fn, state.selection));
        state.selection = [];
        this._formulaEditorSyncSelection();
    };

    proto._formulaEditorSelectShown = function() {
        const state = this._formulaEditor;
        if (!state) return;
        for (const [name, pill] of state.pills) {
            if (pill.hidden || state.selection.includes(name)) continue;
            // The time axis is a valid operand but never what "all of them"
            // means in a sum: picked by hand only.
            if (pill.dataset.kind === 'time') continue;
            state.selection.push(name);
        }
        this._formulaEditorSyncSelection();
    };

    // ── State shown ──

    proto._formulaEditorSetMode = function(mode) {
        const state = this._formulaEditor;
        if (!state) return;
        state.mode = mode === 'select' ? 'select' : 'insert';
        state.modeButtons.forEach((btn, id) => {
            const on = id === state.mode;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-checked', String(on));
        });
        state.overlay.classList.toggle('is-selecting', state.mode === 'select');
        state.hint.textContent = i18n.t(state.mode === 'select' ? 'formulaEditorSelectHint' : 'formulaEditorInsertHint');
        this._formulaEditorSyncSelection();
    };

    proto._formulaEditorSyncSelection = function() {
        const state = this._formulaEditor;
        if (!state) return;
        const count = state.selection.length;
        state.pills.forEach((pill, name) => {
            const index = state.selection.indexOf(name);
            pill.classList.toggle('is-selected', index >= 0);
            pill.setAttribute('aria-pressed', String(index >= 0));
            pill.querySelector('.formula-editor-pill-order').textContent = index >= 0 ? String(index + 1) : '';
        });
        state.selectionBar.hidden = state.mode !== 'select';
        state.selectionCount.textContent = i18n.t('formulaEditorSelected').replace('{count}', String(count));
        state.listButtons.forEach(btn => { btn.disabled = count === 0; });
    };

    proto._formulaEditorApplyFilter = function() {
        const state = this._formulaEditor;
        if (!state) return;
        let shown = 0;
        state.pills.forEach((pill, name) => {
            const match = !state.filter || name.toLowerCase().includes(state.filter);
            pill.hidden = !match;
            if (match) shown++;
        });
        const total = state.pills.size;
        state.varTitle.textContent = state.filter
            ? i18n.t('formulaEditorVariablesFiltered').replace('{shown}', String(shown)).replace('{count}', String(total))
            : i18n.t('formulaEditorVariables').replace('{count}', String(total));
    };

    proto._formulaEditorScheduleValidate = function() {
        const state = this._formulaEditor;
        if (!state) return;
        clearTimeout(state.validateTimer);
        state.validateTimer = setTimeout(() => this._formulaEditorValidate(), 120);
    };

    // Checked as it is typed: compiled (not run) against the file, so an
    // unknown name or a missing bracket is said before Create is pressed.
    // Variables the formula reads are marked among the pills.
    proto._formulaEditorValidate = function() {
        const state = this._formulaEditor;
        if (!state) return;
        const formula = state.formulaInput.value.replace(/\s*\n\s*/g, ' ').trim();
        const data = this._formulaEditorData();
        const used = new Set();
        let text = i18n.t('formulaEditorEmpty');
        let tone = '';
        if (formula && data?.variables) {
            try {
                const variables = data.variables;
                const classify = (name) => {
                    const variable = variables[name];
                    if (!variable) throw new Error(`Unknown variable "${name}".`);
                    return (variable.kind === 'parameter' || variable.data?.length === 1) ? 'scalar' : 'series';
                };
                const compiled = getCompiledFormula(formula, variables, classify);
                compiled.names.forEach(name => used.add(name));
                text = i18n.t('formulaEditorValid').replace('{count}', String(used.size));
                tone = 'ok';
            } catch (error) {
                text = error?.message || String(error);
                tone = 'error';
                // Still mark what it does mention, as far as it can be read.
                try {
                    tokenizeExpression(formula, data.variables)
                        .filter(token => token.type === 'name')
                        .forEach(token => used.add(token.value));
                } catch (_) { /* unreadable: nothing to mark */ }
            }
        }
        state.status.textContent = text;
        state.status.className = `formula-editor-status${tone ? ` ${tone}` : ''}`;
        state.pills.forEach((pill, name) => pill.classList.toggle('is-used', used.has(name)));
    };
}
