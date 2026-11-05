// Derived variables on a phone (docs/phone-web-specification.md §5.3, §11).
//
// The desktop builds a formula in a one-line box in the side panel, or in a
// large editor driven with the mouse (formula-editor-methods.js). Neither
// survives a phone: the side panel is a 320 px column the Data sheet hides,
// the large editor is a grid of small chips laid out for a pointer, and typing
// `sqrt(x^2 + y^2)` on a phone keyboard means three trips to its symbols page
// for every bracket.
//
// So the phone gets its own page, built the way a calculator app is:
//
//   · the formula field opens without the system keyboard. It shows its
//     cursor, and a row of formula keys under it (+ − × ÷ ^ ( ) ⌫) writes
//     there — the keys never take the focus, so the cursor stays where it was;
//     ⌫ takes back a whole name, a whole operator or an empty call at once;
//   · below, three tabs: Variables (a tap writes the name, joined with + after
//     another one, so tapping five rows writes their sum), Functions (each
//     with what it does, since there is no hover to say it) and 123 (digits,
//     π, e and the cursor arrows);
//   · ⌨ hands the field to the system keyboard for whoever prefers typing, and
//     a strip of suggestions follows the name being typed;
//   · the formula is checked as it is written and, once valid, drawn: a small
//     plot of the values it gives, with their count, min and max — the answer
//     to "is this what I meant" before anything is created;
//   · "Σ Combine several…" is a page of its own: tick the variables, pick sum,
//     mean, min or max, Insert;
//   · Create (or Update) is a button at the foot of the page, enabled only once
//     there is something to create, and saying what is missing otherwise.
//
// Nothing about the variable itself lives here. The page fills the side
// panel's name and formula fields and presses its Create, as the desktop's
// large editor does: one code path for creating, editing, renaming and every
// check those make. A draft that was left (the sheet hidden to look at the
// plot) is still there when "New variable" is opened again.
import i18n from '../../i18n/index.js';
import { DERIVED_CONSTANTS, DERIVED_FUNCTIONS } from '../constants.js';
import { getCompiledFormula } from '../../expr/compile.js';
import { tokenize as tokenizeExpression } from '../../expr/parse.js';
import { formatNumber } from '../../utils/number-format.js';
import { button, el, section } from './compact-dom.js';
import { COMPACT_SIGNAL_LIST_MODES } from './compact-analyses.js';
import { derivedNameToken, formulaNameLiteral, variableNameProblem } from './derived-methods.js';
import { endsWithOperand, functionCall, listCall } from './formula-editor-methods.js';

const ICON = {
    fx: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4h-1.5A2.5 2.5 0 0 0 9 6.5V20M6 10h6"/><path d="M14 11l6 7M20 11l-6 7"/></svg>',
    keyboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
    keypad: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 14.5h.01M12 14.5h.01M16 14.5h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>',
    help: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5v.01"/></svg>',
    backspace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h12v14H8l-6-7z"/><path d="M11 9l6 6M17 9l-6 6"/></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M16 16l5 5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

// The row of keys always under the formula: what a phone keyboard hides on
// its second page. What each shows, what it writes.
export const FORMULA_KEYS = [
    ['+', ' + '], ['−', ' - '], ['×', ' * '], ['÷', ' / '], ['^', '^'], ['(', '('], [')', ')'],
];

// The 123 tab: digits, the decimal point, the list separator, the two
// constants and the cursor. `null` keeps a cell for a key built separately.
const NUMBER_KEYS = [
    ['7', '7'], ['8', '8'], ['9', '9'], ['left', null], ['right', null],
    ['4', '4'], ['5', '5'], ['6', '6'], ['pi', null], ['e', null],
    ['1', '1'], ['2', '2'], ['3', '3'], [',', ', '], ['space', ' '],
    ['0', '0'], ['.', '.'],
];

// The functions by what they are for, in the tab's order. A function the
// grammar gains later and this table does not list still shows, under Other.
export const FUNCTION_GROUPS = [
    { key: 'compactFnGroupCombine', names: ['sum', 'mean', 'min', 'max'] },
    { key: 'compactFnGroupPowers', names: ['sqrt', 'abs', 'power', 'root', 'log', 'log10'] },
    { key: 'compactFnGroupTrig', names: ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh'] },
    { key: 'compactFnGroupShape', names: ['sign', 'step', 'diff', 'cumsum'] },
];

const LIST_FUNCTIONS = ['sum', 'mean', 'min', 'max'];

// Above this many samples the formula is only compiled as it is written, not
// run: a keystroke must not wait on millions of values. Create still runs it,
// and says anything wrong there.
const PREVIEW_MAX_SAMPLES = 2_000_000;

// How a function is shown on its key: the call with its arguments named.
export function functionSignature(fn) {
    if (LIST_FUNCTIONS.includes(fn.name)) return `${fn.name}(a, b, …)`;
    if (fn.name === 'power' || fn.name === 'root') return `${fn.name}(x, n)`;
    if (fn.arity === 2) return `${fn.name}(x, y)`;
    return `${fn.name}(x)`;
}

// What ⌫ takes back, as the number of characters before the cursor. Whatever
// a key or a row wrote in one tap goes in one tap: an operator with its
// spaces, a name (backticked or not), a function's opening `name(`. Anything
// else, one character.
export function smartBackspaceLength(left) {
    if (!left) return 0;
    const patterns = [
        /\s*[-+*/^,]\s*$/,                 // an operator, with the spaces around it
        /`[^`]*`$/,                        // a quoted name
        /[A-Za-z_][A-Za-z0-9_.]*\($/,       // a function's opening
        /[A-Za-z_][A-Za-z0-9_.[\]]*$/,      // a name
        /\s+$/,                            // spaces
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(left);
        if (match && match[0].length) return match[0].length;
    }
    return 1;
}

// The values a formula gives, reduced to what a small plot can draw: per
// column, the lowest and highest finite value. Also their count, extremes and
// how many are not numbers.
export function previewEnvelope(values, columns = 120) {
    const n = values?.length || 0;
    const width = Math.max(1, Math.min(columns, n));
    const lo = new Float64Array(width).fill(NaN);
    const hi = new Float64Array(width).fill(NaN);
    let min = Infinity;
    let max = -Infinity;
    let finite = 0;
    for (let i = 0; i < n; i++) {
        const v = Number(values[i]);
        if (!Number.isFinite(v)) continue;
        finite++;
        if (v < min) min = v;
        if (v > max) max = v;
        const c = Math.min(width - 1, Math.floor((i * width) / n));
        if (!(v >= lo[c])) lo[c] = v;
        if (!(v <= hi[c])) hi[c] = v;
    }
    return { n, finite, nan: n - finite, min: finite ? min : NaN, max: finite ? max : NaN, lo, hi };
}

// The envelope as SVG path data in a `w`×`h` box: a filled band where the
// column spans a range, its midline as the curve. Columns without a number
// break the line, as a gap does on the plot.
export function envelopePaths(env, w = 300, h = 56, pad = 3) {
    const { lo, hi, min, max } = env;
    const columns = lo.length;
    if (!Number.isFinite(min)) return { band: '', line: '' };
    const span = max - min;
    const y = (v) => (span > 0 ? pad + (h - 2 * pad) * (1 - (v - min) / span) : h / 2);
    const x = (c) => (columns > 1 ? (c * w) / (columns - 1) : w / 2);
    let line = '';
    let band = '';
    let run = [];
    const flush = () => {
        if (!run.length) return;
        const top = run.map(c => `${x(c).toFixed(1)},${y(hi[c]).toFixed(1)}`);
        const bottom = run.slice().reverse().map(c => `${x(c).toFixed(1)},${y(lo[c]).toFixed(1)}`);
        band += `M${top.join('L')}L${bottom.join('L')}Z`;
        line += `M${run.map(c => `${x(c).toFixed(1)},${y((lo[c] + hi[c]) / 2).toFixed(1)}`).join('L')}`;
        run = [];
    };
    for (let c = 0; c < columns; c++) {
        if (Number.isFinite(lo[c])) run.push(c);
        else flush();
    }
    flush();
    return { band, line };
}

// A key or row that writes into the formula must not take the focus from it:
// the cursor would be lost, and with the system keyboard up, the keyboard.
const keepFocus = (node) => {
    const stop = (event) => event.preventDefault();
    node.addEventListener('pointerdown', stop);
    node.addEventListener('mousedown', stop);
    return node;
};

export function installCompactDerivedMethods(ViewerClass) {
    const proto = ViewerClass.prototype;

    // A formula row's ✎ in the tree: on a phone, the phone's editor.
    const desktopEdit = proto._editDerivedVariable;
    proto._editDerivedVariable = function(name) {
        if (this._compactIsActive?.()) {
            this._openCompactDerivedEditor({ edit: name });
            return;
        }
        desktopEdit.call(this, name);
    };

    proto._compactDerivedData = function(fileId = this.activeFileId) {
        return fileId != null ? this.plotManager.files.get(fileId)?.data || null : null;
    };

    // The plot a new variable can be put on at once: the one on screen, when
    // a tap in Data adds a signal to it (not a 2D plot, which pairs them).
    proto._compactDerivedPlotTarget = function() {
        const panelId = this._compactActivePanelId?.();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        if (!plot || !COMPACT_SIGNAL_LIST_MODES.has(plot.mode || 'timeseries')) return null;
        return { panelId, n: this._compactPanelIds().indexOf(panelId) + 1 };
    };

    // ─── Opening and closing ──────────────────────────────────────

    proto._openCompactDerivedEditor = function({ edit = null } = {}) {
        if (!this._compact?.active) return;
        const fileId = this.activeFileId;
        const data = this._compactDerivedData(fileId);
        if (!data) {
            this._compactToast(i18n.t('derivedNewVariableNeedsFile'));
            return;
        }
        const entry = edit ? this.derivedByFile?.get(fileId)?.get(edit) : null;
        if (edit && !entry?.formula) return;
        // Pages go inside a sheet: from the tree or the Data button, the Data
        // sheet; from Analyze, Analyze.
        if (!this._compact.sheet) this._openCompactSheet('data', { toggle: false });

        const draft = this._compact.derivedDraft;
        const keepDraft = !edit && draft && draft.fileId === fileId;
        const state = {
            fileId,
            editing: edit ? { fileId, name: edit } : null,
            name: edit ? edit : (keepDraft ? draft.name : ''),
            formula: edit ? entry.formula : (keepDraft ? draft.formula : ''),
            tab: keepDraft ? draft.tab : 'variables',
            filter: '',
            keyboard: !!this._compact.derivedKeyboard,
            addToPlot: this._compact.derivedAddToPlot !== false,
            caret: null,
            validateTimer: null,
            done: false,
            sheetSize: this._compact.sheetSize,
            sheet: this._compact.sheet,
        };
        state.caret = [state.formula.length, state.formula.length];
        this._compactDerived = state;
        // The side panel's form is what creates; it learns of the edit here.
        this._derivedEditing = state.editing;

        const node = el('div', 'compact-page compact-page-derived');
        const page = {
            title: i18n.t(edit ? 'compactDerivedEditTitle' : 'compactDerivedNew'),
            node,
            persist: true,
            lang: i18n.currentLang,
            rebuild: () => {
                page.title = i18n.t(state.editing ? 'compactDerivedEditTitle' : 'compactDerivedNew');
                page.lang = i18n.currentLang;
                const pages = this._compact.pages;
                if (pages[pages.length - 1] === page) this._compactSheetTitle.textContent = page.title;
                this._renderCompactDerivedPage(node);
            },
            onClose: () => this._closeCompactDerivedEditor(state),
        };
        state.page = page;
        this._renderCompactDerivedPage(node);
        this._pushCompactPage(page);
        // A formula wants the room: the page opens at full height (sideways
        // the sheet is a side sheet, and keeps its width).
        this._setCompactSheetSize('full');
        // The formula field opens on its keys, showing its cursor. Nothing
        // brings the system keyboard up by itself: it would cover the page
        // before the user has seen it.
        requestAnimationFrame(() => {
            if (!state.keyboard) this._compactDerivedFocusFormula();
        });
    };

    proto._closeCompactDerivedEditor = function(state) {
        if (this._compactDerived !== state) return;
        clearTimeout(state.validateTimer);
        // Left without creating: kept as a draft, for the next "New variable".
        // An edit is not a draft: its variable is still what it was.
        if (!state.done && !state.editing && (state.name.trim() || state.formula.trim())) {
            this._compact.derivedDraft = { fileId: state.fileId, name: state.name, formula: state.formula, tab: state.tab };
        } else if (state.done) {
            this._compact.derivedDraft = null;
        }
        this._compactDerived = null;
        if (this._derivedEditing === state.editing) this._derivedEditing = null;
        // The side panel's form goes back to rest, as it was.
        const form = document.getElementById('derived-form');
        form?.classList.add('collapsed');
        form?.classList.remove('editing');
        const toggle = document.getElementById('derived-toggle');
        if (toggle) toggle.hidden = false;
        // Back to the height the sheet had before, if it is still that sheet.
        if (this._compact.sheet === state.sheet && state.sheetSize !== this._compact.sheetSize) {
            this._setCompactSheetSize(state.sheetSize);
        }
    };

    // ─── The page ─────────────────────────────────────────────────

    proto._renderCompactDerivedPage = function(node) {
        const state = this._compactDerived;
        if (!state) return;
        const data = this._compactDerivedData(state.fileId);
        node.replaceChildren();

        // ── Name ──
        const nameField = el('label', 'compact-derived-field');
        nameField.appendChild(el('span', 'compact-derived-label', i18n.t('formulaEditorName')));
        const nameInput = el('input', 'compact-derived-name');
        nameInput.type = 'text';
        nameInput.value = state.name;
        nameInput.placeholder = i18n.t('compactDerivedNamePlaceholder');
        nameInput.spellcheck = false;
        nameInput.autocomplete = 'off';
        nameInput.setAttribute('autocapitalize', 'off');
        nameInput.setAttribute('autocorrect', 'off');
        nameInput.setAttribute('enterkeyhint', 'next');
        nameInput.addEventListener('input', () => {
            state.name = nameInput.value;
            this._compactDerivedSyncFooter();
        });
        nameInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            this._compactDerivedFocusFormula();
        });
        nameField.appendChild(nameInput);
        const nameHint = el('div', 'compact-derived-name-hint');
        nameHint.setAttribute('aria-live', 'polite');
        nameField.appendChild(nameHint);
        node.appendChild(nameField);
        state.nameInput = nameInput;
        state.nameHint = nameHint;

        // ── Formula ──
        const formulaBox = el('div', 'compact-derived-formula-box');
        const formulaHead = el('div', 'compact-derived-formula-head');
        const formulaLabel = el('label', 'compact-derived-label', i18n.t('formulaEditorFormula'));
        formulaLabel.htmlFor = 'compact-derived-formula';
        const helpBtn = button('compact-icon-btn compact-derived-head-btn', '', () => this._openCompactDerivedHelp(), { icon: ICON.help, title: i18n.t('compactDerivedHelp') });
        const keyboardBtn = button('compact-icon-btn compact-derived-head-btn compact-derived-keyboard', '', () => this._compactDerivedToggleKeyboard(), { icon: '' });
        keepFocus(keyboardBtn);
        formulaHead.append(formulaLabel, helpBtn, keyboardBtn);
        const formulaInput = el('textarea', 'compact-derived-formula');
        formulaInput.id = 'compact-derived-formula';
        formulaInput.rows = 2;
        formulaInput.value = state.formula;
        formulaInput.placeholder = i18n.t('compactDerivedFormulaPlaceholder');
        formulaInput.spellcheck = false;
        formulaInput.autocomplete = 'off';
        formulaInput.setAttribute('autocapitalize', 'off');
        formulaInput.setAttribute('autocorrect', 'off');
        const remember = () => {
            state.caret = [formulaInput.selectionStart, formulaInput.selectionEnd];
        };
        for (const type of ['keyup', 'pointerup', 'select', 'focus']) formulaInput.addEventListener(type, () => {
            remember();
            this._compactDerivedSyncSuggestions();
        });
        formulaInput.addEventListener('blur', remember);
        formulaInput.addEventListener('input', () => {
            remember();
            state.formula = formulaInput.value;
            this._compactDerivedAfterEdit();
        });
        formulaInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                // One line: Enter is the keyboard's way to say "done".
                event.preventDefault();
                this._compactDerivedSubmit();
            }
        });
        state.formulaInput = formulaInput;
        state.keyboardBtn = keyboardBtn;

        const keys = el('div', 'compact-derived-keys');
        keys.setAttribute('role', 'group');
        keys.setAttribute('aria-label', i18n.t('formulaEditorOperators'));
        for (const [label, text] of FORMULA_KEYS) {
            const key = keepFocus(button('compact-derived-key is-operator', label, () => this._compactDerivedInsert(text), { title: text.trim() || text }));
            key.dataset.key = text.trim() || text;
            keys.appendChild(key);
        }
        const backspace = keepFocus(button('compact-derived-key is-backspace', '', () => this._compactDerivedBackspace(), { icon: ICON.backspace, title: i18n.t('compactDerivedBackspace') }));
        this._compactDerivedRepeat(backspace, () => this._compactDerivedBackspace());
        keys.appendChild(backspace);

        const status = el('div', 'compact-derived-status');
        status.setAttribute('aria-live', 'polite');
        state.status = status;

        const suggestions = el('div', 'compact-derived-suggestions');
        suggestions.hidden = true;
        state.suggestions = suggestions;

        formulaBox.append(formulaHead, formulaInput, keys, suggestions, status);
        node.appendChild(formulaBox);

        // ── Preview ──
        const preview = el('div', 'compact-derived-preview');
        preview.hidden = true;
        state.preview = preview;
        node.appendChild(preview);

        // ── Tabs: what goes into the formula ──
        const tabsBar = el('div', 'compact-derived-tabs-bar');
        const tabs = el('div', 'compact-segmented compact-derived-tabs');
        tabs.setAttribute('role', 'tablist');
        tabsBar.appendChild(tabs);
        const panels = el('div', 'compact-derived-panels');
        state.tabButtons = new Map();
        state.panels = new Map();
        const tabDefs = [
            ['variables', i18n.t('compactDerivedTabVariables'), () => this._buildCompactDerivedVariables(data)],
            ['functions', i18n.t('compactDerivedTabFunctions'), () => this._buildCompactDerivedFunctions(data)],
            ['numbers', '123', () => this._buildCompactDerivedNumbers(data)],
        ];
        for (const [id, label, build] of tabDefs) {
            const tab = button(`compact-segment compact-derived-tab${state.tab === id ? ' is-active' : ''}`, label, () => this._compactDerivedSetTab(id));
            keepFocus(tab);
            tab.setAttribute('role', 'tab');
            tab.dataset.tab = id;
            tabs.appendChild(tab);
            state.tabButtons.set(id, tab);
            const panel = build();
            panel.setAttribute('role', 'tabpanel');
            panel.dataset.tab = id;
            panels.appendChild(panel);
            state.panels.set(id, panel);
        }
        node.append(tabsBar, panels);

        // ── Edit: the way out for the variable itself ──
        if (state.editing) {
            const remove = button('compact-list-btn compact-list-btn-danger compact-derived-delete', i18n.t('compactDerivedDelete'), () => this._compactDerivedDelete(), { icon: ICON.trash });
            const wrap = el('div', 'compact-list compact-derived-delete-list');
            wrap.appendChild(remove);
            node.appendChild(wrap);
        }

        // ── Footer: create, always in reach ──
        const footer = el('div', 'compact-derived-footer');
        const message = el('div', 'compact-derived-message');
        message.setAttribute('role', 'status');
        message.hidden = true;
        state.message = message;
        // One row, so the page keeps its height for the formula (sideways a
        // phone has ~300 px): ✕, whether it goes on the plot, Create.
        const actions = el('div', 'compact-derived-actions');
        const cancel = button('compact-secondary-btn compact-derived-cancel', '', () => this._compactDerivedCancel(), { icon: ICON.close, title: i18n.t('cancel') });
        // Put on the plot at once: a toggle that says which plot.
        const plotChip = button('compact-derived-plot-chip', '', () => {
            state.addToPlot = !state.addToPlot;
            this._compact.derivedAddToPlot = state.addToPlot;
            this._compactDerivedSyncFooter();
        }, { icon: ICON.check });
        plotChip.appendChild(el('span', 'compact-btn-label'));
        keepFocus(plotChip);
        state.plotChip = plotChip;
        const submit = button('compact-primary-btn compact-derived-submit', i18n.t(state.editing ? 'derivedUpdate' : 'derivedCreate'), () => this._compactDerivedSubmit());
        keepFocus(submit);
        state.submit = submit;
        actions.append(cancel, plotChip, submit);
        footer.append(message, actions);
        node.appendChild(footer);

        this._compactDerivedSetTab(state.tab, { focus: false });
        this._compactDerivedSyncKeyboard();
        this._compactDerivedAutosize();
        this._compactDerivedValidate();
        this._compactDerivedSyncSuggestions();
    };

    proto._compactDerivedSetTab = function(id, { focus = true } = {}) {
        const state = this._compactDerived;
        if (!state?.panels.has(id)) return;
        state.tab = id;
        state.tabButtons.forEach((tab, key) => {
            const on = key === id;
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-selected', String(on));
        });
        state.panels.forEach((panel, key) => { panel.hidden = key !== id; });
        if (focus) this._compactDerivedRefocus();
    };

    // ── Variables ──

    proto._buildCompactDerivedVariables = function(data) {
        const state = this._compactDerived;
        const panel = el('div', 'compact-derived-panel compact-derived-variables');
        const bar = el('div', 'compact-derived-var-bar');
        const searchWrap = el('label', 'compact-derived-search');
        const searchIcon = el('span', 'compact-derived-search-icon');
        searchIcon.innerHTML = ICON.search;
        const search = el('input', 'compact-derived-filter');
        search.type = 'search';
        search.placeholder = i18n.t('formulaEditorFilter');
        search.setAttribute('aria-label', i18n.t('formulaEditorFilter'));
        search.setAttribute('autocapitalize', 'off');
        search.setAttribute('autocorrect', 'off');
        search.spellcheck = false;
        search.value = state.filter;
        search.addEventListener('input', () => {
            state.filter = search.value.trim().toLowerCase();
            this._compactDerivedApplyFilter();
        });
        searchWrap.append(searchIcon, search);
        const combine = button('compact-secondary-btn compact-derived-combine', i18n.t('formulaEditorCombine'), () => this._openCompactDerivedCombine());
        bar.append(searchWrap, combine);
        panel.appendChild(bar);

        const list = el('div', 'compact-list compact-derived-var-list');
        state.varRows = new Map();
        for (const variable of this._compactDerivedVariables(data)) {
            const row = keepFocus(button('compact-list-btn compact-derived-var', '', () => {
                this._compactDerivedInsertOperand(formulaNameLiteral(variable.name));
            }));
            row.dataset.name = variable.name;
            row.dataset.kind = variable.kind;
            const text = el('span', 'compact-derived-var-text');
            text.appendChild(el('span', 'compact-derived-var-name', variable.name));
            if (variable.detail) text.appendChild(el('span', 'compact-derived-var-detail', variable.detail));
            row.appendChild(text);
            if (variable.tag) row.appendChild(el('span', `compact-derived-var-tag tag-${variable.kind}`, variable.tag));
            const mark = el('span', 'compact-derived-var-add');
            mark.innerHTML = ICON.plus;
            row.appendChild(mark);
            row.setAttribute('aria-label', `${variable.name}${variable.detail ? ` — ${variable.detail}` : ''}`);
            state.varRows.set(variable.name, row);
            list.appendChild(row);
        }
        const empty = el('p', 'compact-note compact-derived-var-empty', i18n.t('compactDerivedNoMatch'));
        empty.hidden = true;
        state.varEmpty = empty;
        state.varHint = el('p', 'compact-note compact-note-muted compact-derived-var-hint', i18n.t('compactDerivedVariablesHint'));
        panel.append(state.varHint, list, empty);
        this._compactDerivedApplyFilter();
        return panel;
    };

    // Every variable the formula can read, in the file's order. While editing,
    // not the variable itself nor anything built on it: the formula would have
    // no order to be computed in.
    proto._compactDerivedVariables = function(data) {
        const state = this._compactDerived;
        const blocked = new Set();
        if (state?.editing && data) {
            blocked.add(state.editing.name);
            for (const name of this._variableDependents?.(state.fileId, data, state.editing.name) || []) blocked.add(name);
        }
        return (this._formulaEditorVariables?.(data) || [])
            .filter(variable => !blocked.has(variable.name))
            .map((variable) => {
                const source = data.variables[variable.name];
                const entry = this.derivedByFile?.get(state?.fileId)?.get(variable.name);
                const detail = entry?.formula
                    ? `= ${entry.formula}`
                    : (source?.description && source.description !== variable.name ? source.description : '');
                return { ...variable, detail };
            });
    };

    proto._compactDerivedApplyFilter = function() {
        const state = this._compactDerived;
        if (!state?.varRows) return;
        let shown = 0;
        state.varRows.forEach((row, name) => {
            const detail = row.querySelector('.compact-derived-var-detail')?.textContent || '';
            const match = !state.filter
                || name.toLowerCase().includes(state.filter)
                || detail.toLowerCase().includes(state.filter);
            row.hidden = !match;
            if (match) shown++;
        });
        state.varEmpty.hidden = shown > 0 || !state.varRows.size;
    };

    // ── Functions ──

    proto._buildCompactDerivedFunctions = function(data) {
        const panel = el('div', 'compact-derived-panel compact-derived-functions');
        const available = new Map(DERIVED_FUNCTIONS.map(fn => [fn.name, fn]));
        const placed = new Set();
        const groups = FUNCTION_GROUPS.map(group => ({ key: group.key, fns: group.names.filter(name => available.has(name)) }));
        groups.forEach(group => group.fns.forEach(name => placed.add(name)));
        const rest = [...available.keys()].filter(name => !placed.has(name));
        if (rest.length) groups.push({ key: 'compactFnGroupOther', fns: rest });
        for (const group of groups) {
            if (!group.fns.length) continue;
            const wrap = section(i18n.t(group.key));
            const grid = el('div', 'compact-derived-fn-grid');
            for (const name of group.fns) {
                const fn = available.get(name);
                const tile = keepFocus(button('compact-derived-fn', '', () => this._compactDerivedInsertFunction(name)));
                tile.dataset.fn = name;
                tile.appendChild(el('span', 'compact-derived-fn-sig', functionSignature(fn)));
                const descriptionKey = `compactFn_${name}`;
                const description = i18n.t(descriptionKey);
                if (description && description !== descriptionKey) tile.appendChild(el('span', 'compact-derived-fn-text', description));
                tile.setAttribute('aria-label', `${name}: ${description}`);
                grid.appendChild(tile);
            }
            wrap.appendChild(grid);
            panel.appendChild(wrap);
        }
        // The constants, written as this file lets them be: `pi`, or
        // `math.pi` where a variable of the file already holds that name.
        const constants = [...DERIVED_CONSTANTS.keys()].filter(name => !name.startsWith('math.'));
        if (constants.length) {
            const wrap = section(i18n.t('compactFnGroupConstants'));
            const grid = el('div', 'compact-derived-fn-grid');
            for (const name of constants) {
                const written = this._compactDerivedConstant(name, data);
                const tile = keepFocus(button('compact-derived-fn is-constant', '', () => this._compactDerivedInsertOperand(written)));
                tile.dataset.constant = name;
                tile.appendChild(el('span', 'compact-derived-fn-sig', written));
                tile.appendChild(el('span', 'compact-derived-fn-text', i18n.t(`compactFnConst_${name}`)));
                grid.appendChild(tile);
            }
            wrap.appendChild(grid);
            panel.appendChild(wrap);
        }
        const help = el('div', 'compact-list compact-derived-help-link');
        const helpRow = button('compact-list-btn', i18n.t('compactDerivedHelp'), () => this._openCompactDerivedHelp(), { icon: ICON.help });
        const chevron = el('span', 'compact-derived-chevron');
        chevron.innerHTML = ICON.chevron;
        helpRow.appendChild(chevron);
        help.appendChild(helpRow);
        panel.appendChild(help);
        return panel;
    };

    proto._compactDerivedConstant = function(name, data = this._compactDerivedData(this._compactDerived?.fileId)) {
        return data?.variables?.[name] ? `math.${name}` : name;
    };

    // ── 123 ──

    proto._buildCompactDerivedNumbers = function(data) {
        const panel = el('div', 'compact-derived-panel compact-derived-numbers');
        const pad = el('div', 'compact-derived-numpad');
        for (const [label, text] of NUMBER_KEYS) {
            let key;
            if (label === 'left' || label === 'right') {
                const step = label === 'left' ? -1 : 1;
                key = button('compact-derived-key is-cursor', '', () => this._compactDerivedMoveCaret(step), {
                    icon: ICON[label],
                    title: i18n.t(label === 'left' ? 'compactDerivedCaretLeft' : 'compactDerivedCaretRight'),
                });
                this._compactDerivedRepeat(key, () => this._compactDerivedMoveCaret(step));
            } else if (label === 'pi' || label === 'e') {
                const written = this._compactDerivedConstant(label, data);
                key = button('compact-derived-key is-constant', label === 'pi' ? 'π' : 'e', () => this._compactDerivedInsertOperand(written), { title: written });
            } else if (label === 'space') {
                key = button('compact-derived-key is-space', '␣', () => this._compactDerivedInsert(text), { title: i18n.t('compactDerivedSpace') });
            } else {
                key = button(`compact-derived-key${/\d/.test(label) ? ' is-digit' : ''}`, label, () => this._compactDerivedInsert(text));
            }
            key.dataset.key = label;
            pad.appendChild(keepFocus(key));
        }
        const backspace = keepFocus(button('compact-derived-key is-backspace', '', () => this._compactDerivedBackspace(), { icon: ICON.backspace, title: i18n.t('compactDerivedBackspace') }));
        this._compactDerivedRepeat(backspace, () => this._compactDerivedBackspace());
        backspace.dataset.key = 'backspace';
        const enter = keepFocus(button('compact-derived-key is-enter', '', () => this._compactDerivedSubmit(), { icon: ICON.check, title: i18n.t('derivedCreate') }));
        enter.dataset.key = 'enter';
        pad.append(backspace, enter);
        panel.appendChild(pad);
        return panel;
    };

    // A key held down keeps going, as on a keyboard: ⌫ and the arrows.
    proto._compactDerivedRepeat = function(key, action) {
        let timer = null;
        let repeated = false;
        const stop = () => {
            clearTimeout(timer);
            timer = null;
        };
        key.addEventListener('pointerdown', () => {
            repeated = false;
            stop();
            const tick = (delay) => {
                timer = setTimeout(() => {
                    repeated = true;
                    action();
                    tick(70);
                }, delay);
            };
            tick(450);
        });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave']) key.addEventListener(type, stop);
        // The click that ends a held key is not one more step.
        key.addEventListener('click', (event) => {
            if (!repeated) return;
            repeated = false;
            event.stopImmediatePropagation();
        }, true);
    };

    // ─── Writing into the formula ─────────────────────────────────

    // The formula field holds the focus — with its cursor showing, and the
    // system keyboard only when the user asked for it.
    proto._compactDerivedFocusFormula = function() {
        const state = this._compactDerived;
        const input = state?.formulaInput;
        if (!input?.isConnected) return;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
        input.setSelectionRange(start, end);
    };

    // After a key: the field gets its cursor back, unless the system keyboard
    // is the way in and it was not up (a key must not bring it up).
    proto._compactDerivedRefocus = function() {
        const state = this._compactDerived;
        if (!state?.formulaInput) return;
        if (state.keyboard && document.activeElement !== state.formulaInput) return;
        this._compactDerivedFocusFormula();
    };

    proto._compactDerivedInsert = function(text, { caretFromEnd = 0 } = {}) {
        const state = this._compactDerived;
        const input = state?.formulaInput;
        if (!input) return;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        // Spaces are never doubled where an operator brings its own.
        let insert = text;
        if (/\s$/.test(before) && /^\s/.test(insert)) insert = insert.replace(/^\s+/, '');
        if (/^\s/.test(after) && /\s$/.test(insert)) insert = insert.replace(/\s+$/, '');
        input.value = before + insert + after;
        const caret = before.length + insert.length - caretFromEnd;
        state.caret = [caret, caret];
        state.formula = input.value;
        this._compactDerivedRefocus();
        input.setSelectionRange(caret, caret);
        this._compactDerivedAfterEdit();
    };

    // An operand — a variable, a constant — right after another is joined with
    // " + ": tapping five rows writes their sum.
    proto._compactDerivedInsertOperand = function(literal) {
        const state = this._compactDerived;
        if (!state?.formulaInput) return;
        const [start] = state.caret || [state.formulaInput.value.length];
        const before = state.formulaInput.value.slice(0, start);
        this._compactDerivedInsert(endsWithOperand(before) ? ` + ${literal}` : literal);
    };

    // A function wraps what is selected, or opens empty with the cursor
    // between its brackets; after an operand it multiplies, as `2 sin(x)` means.
    proto._compactDerivedInsertFunction = function(name) {
        const state = this._compactDerived;
        const input = state?.formulaInput;
        if (!input) return;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        const selected = input.value.slice(start, end);
        if (selected.trim()) {
            this._compactDerivedInsert(functionCall(name, selected));
            return;
        }
        const before = input.value.slice(0, start);
        const lead = endsWithOperand(before) ? ' * ' : '';
        this._compactDerivedInsert(lead + functionCall(name), { caretFromEnd: 1 });
    };

    proto._compactDerivedBackspace = function() {
        const state = this._compactDerived;
        const input = state?.formulaInput;
        if (!input) return;
        let [start, end] = state.caret || [input.value.length, input.value.length];
        let value = input.value;
        if (end > start) {
            value = value.slice(0, start) + value.slice(end);
        } else if (start > 0) {
            const left = value.slice(0, start);
            const length = smartBackspaceLength(left);
            let right = value.slice(start);
            // A call opened and left empty goes whole: `sqrt(|)` → nothing.
            if (/\($/.test(left) && right.startsWith(')')) right = right.slice(1);
            value = left.slice(0, left.length - length) + right;
            start -= length;
        }
        input.value = value;
        state.caret = [start, start];
        state.formula = value;
        this._compactDerivedRefocus();
        input.setSelectionRange(start, start);
        this._compactDerivedAfterEdit();
    };

    proto._compactDerivedMoveCaret = function(step) {
        const state = this._compactDerived;
        const input = state?.formulaInput;
        if (!input) return;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        const from = step < 0 ? start : end;
        const caret = start !== end ? from : Math.max(0, Math.min(input.value.length, from + step));
        state.caret = [caret, caret];
        this._compactDerivedFocusFormula();
        this._compactDerivedSyncSuggestions();
    };

    // ⌨: the system keyboard, or the formula keys. A field whose inputmode
    // changes while it has the focus keeps its old keyboard until it is
    // focused again, so it is let go and taken back.
    proto._compactDerivedToggleKeyboard = function() {
        const state = this._compactDerived;
        if (!state) return;
        state.keyboard = !state.keyboard;
        this._compact.derivedKeyboard = state.keyboard;
        this._compactDerivedSyncKeyboard();
        const input = state.formulaInput;
        if (document.activeElement === input) input.blur();
        this._compactDerivedFocusFormula();
    };

    proto._compactDerivedSyncKeyboard = function() {
        const state = this._compactDerived;
        if (!state?.formulaInput) return;
        state.formulaInput.inputMode = state.keyboard ? 'text' : 'none';
        state.formulaInput.setAttribute('inputmode', state.keyboard ? 'text' : 'none');
        const btn = state.keyboardBtn;
        const label = i18n.t(state.keyboard ? 'compactDerivedKeypad' : 'compactDerivedKeyboard');
        btn.querySelector('.compact-btn-icon')?.remove();
        const icon = el('span', 'compact-btn-icon');
        icon.innerHTML = state.keyboard ? ICON.keypad : ICON.keyboard;
        btn.prepend(icon);
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', String(state.keyboard));
        btn.classList.toggle('is-active', state.keyboard);
    };

    proto._compactDerivedAutosize = function() {
        const input = this._compactDerived?.formulaInput;
        if (!input) return;
        input.style.height = 'auto';
        // Two lines at rest, up to six; past that the field scrolls.
        const style = getComputedStyle(input);
        const line = parseFloat(style.lineHeight) || 22;
        const chrome = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + 2;
        const height = Math.min(Math.max(input.scrollHeight, line * 2 + chrome), line * 6 + chrome);
        input.style.height = `${Math.ceil(height)}px`;
    };

    proto._compactDerivedAfterEdit = function() {
        const state = this._compactDerived;
        if (!state) return;
        state.message.hidden = true;
        this._compactDerivedAutosize();
        this._compactDerivedSyncSuggestions();
        clearTimeout(state.validateTimer);
        state.validateTimer = setTimeout(() => this._compactDerivedValidate(), 160);
    };

    // ─── Suggestions while typing ─────────────────────────────────

    proto._compactDerivedSyncSuggestions = function() {
        const state = this._compactDerived;
        const box = state?.suggestions;
        if (!box) return;
        const input = state.formulaInput;
        const caret = state.caret?.[0] ?? input.value.length;
        const token = derivedNameToken(input.value.slice(0, caret));
        const prefix = token.replace(/^`/, '');
        // Only the name being typed: a name already whole (followed by more of
        // itself or by nothing that types) is not offered back.
        const continues = /^[A-Za-z0-9_.]/.test(input.value.slice(caret));
        const list = prefix && !continues ? (this._getDerivedSuggestions?.(prefix) || []) : [];
        const exact = list.length === 1 && list[0].name === prefix;
        box.replaceChildren();
        box.hidden = !list.length || exact;
        if (box.hidden) return;
        for (const suggestion of list) {
            const chip = keepFocus(button(`compact-derived-suggestion kind-${suggestion.kind}`, suggestion.type === 'function' ? `${suggestion.name}( )` : suggestion.name, () => this._compactDerivedTakeSuggestion(suggestion)));
            chip.dataset.name = suggestion.name;
            box.appendChild(chip);
        }
    };

    proto._compactDerivedTakeSuggestion = function(suggestion) {
        const state = this._compactDerived;
        const input = state?.formulaInput;
        if (!input) return;
        const [start, end] = state.caret || [input.value.length, input.value.length];
        const left = input.value.slice(0, start);
        const token = derivedNameToken(left);
        const right = token.startsWith('`') && input.value.slice(end).startsWith('`')
            ? input.value.slice(end + 1)
            : input.value.slice(end);
        const isFunction = suggestion.type === 'function';
        const insert = isFunction ? `${suggestion.name}()` : formulaNameLiteral(suggestion.name);
        const from = start - token.length;
        input.value = input.value.slice(0, from) + insert + right;
        const caret = from + insert.length - (isFunction ? 1 : 0);
        state.caret = [caret, caret];
        state.formula = input.value;
        this._compactDerivedRefocus();
        input.setSelectionRange(caret, caret);
        this._compactDerivedAfterEdit();
        state.suggestions.hidden = true;
    };

    // ─── Checking and previewing ──────────────────────────────────

    // Compiled against the file as it is written, then run: an unknown name or
    // a missing bracket is said at once, and a valid formula is drawn.
    proto._compactDerivedValidate = function() {
        const state = this._compactDerived;
        if (!state?.status) return;
        const data = this._compactDerivedData(state.fileId);
        const formula = state.formula.replace(/\s*\n\s*/g, ' ').trim();
        const used = new Set();
        state.valid = false;
        state.result = null;
        let text = i18n.t('compactDerivedFormulaEmpty');
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
                const samples = this._getActiveTimeVar?.(data)?.data?.length || 0;
                if (samples <= PREVIEW_MAX_SAMPLES) state.result = this._evaluateDerivedFormula(formula, data);
                state.valid = true;
                tone = 'ok';
                text = i18n.t('formulaEditorValid').replace('{count}', String(used.size));
            } catch (error) {
                tone = 'error';
                text = error?.message || String(error);
                try {
                    tokenizeExpression(formula, data.variables)
                        .filter(token => token.type === 'name')
                        .forEach(token => used.add(token.value));
                } catch (_) { /* unreadable: nothing to mark */ }
            }
        }
        state.status.replaceChildren();
        if (tone) {
            const icon = el('span', 'compact-derived-status-icon');
            icon.innerHTML = tone === 'ok' ? ICON.check : '!';
            state.status.appendChild(icon);
        }
        state.status.appendChild(el('span', 'compact-derived-status-text', text));
        state.status.className = `compact-derived-status${tone ? ` is-${tone}` : ''}`;
        state.varRows?.forEach((row, name) => row.classList.toggle('is-used', used.has(name)));
        this._compactDerivedRenderPreview();
        this._compactDerivedSyncFooter();
    };

    proto._compactDerivedRenderPreview = function() {
        const state = this._compactDerived;
        const box = state?.preview;
        if (!box) return;
        const values = state.result?.values;
        box.replaceChildren();
        box.hidden = !state.valid || !values?.length;
        if (box.hidden) return;
        const env = previewEnvelope(values);
        const head = el('div', 'compact-derived-preview-head');
        head.appendChild(el('span', 'compact-derived-label', i18n.t('compactDerivedPreview')));
        const fmt = (v) => formatNumber(v, this.numberFormat, { significantDigits: 4 });
        const count = formatNumber(env.n, this.numberFormat, { maximumFractionDigits: 0 });
        head.appendChild(el('span', 'compact-derived-preview-count', i18n.t('compactDerivedPreviewPoints').replace('{n}', count)));
        box.appendChild(head);
        if (!env.finite) {
            box.appendChild(el('p', 'compact-derived-preview-none', i18n.t('compactDerivedPreviewNoNumbers')));
            return;
        }
        const W = 300;
        const H = 56;
        const { band, line } = envelopePaths(env, W, H);
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'compact-derived-spark');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', i18n.t('compactDerivedPreview'));
        // A zero line, where zero is in view: the sign of a result is often
        // the first thing to check.
        if (env.min < 0 && env.max > 0) {
            const zero = document.createElementNS(ns, 'line');
            const y0 = 3 + (H - 6) * (1 - (0 - env.min) / (env.max - env.min));
            zero.setAttribute('x1', '0');
            zero.setAttribute('x2', String(W));
            zero.setAttribute('y1', y0.toFixed(1));
            zero.setAttribute('y2', y0.toFixed(1));
            zero.setAttribute('class', 'compact-derived-spark-zero');
            svg.appendChild(zero);
        }
        const area = document.createElementNS(ns, 'path');
        area.setAttribute('d', band);
        area.setAttribute('class', 'compact-derived-spark-band');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', line);
        path.setAttribute('class', 'compact-derived-spark-line');
        svg.append(area, path);
        box.appendChild(svg);
        const stats = el('div', 'compact-derived-preview-stats');
        const stat = (label, value) => {
            const item = el('span', 'compact-derived-stat');
            item.append(el('span', 'compact-derived-stat-label', label), el('span', 'compact-derived-stat-value', value));
            return item;
        };
        stats.append(stat(i18n.t('compactDerivedPreviewMin'), fmt(env.min)), stat(i18n.t('compactDerivedPreviewMax'), fmt(env.max)));
        if (env.nan) {
            stats.appendChild(stat(i18n.t('compactDerivedPreviewNaN'), formatNumber(env.nan, this.numberFormat, { maximumFractionDigits: 0 })));
        }
        box.appendChild(stats);
    };

    // What Create is waiting for, and which field it is about; null when it
    // is ready.
    proto._compactDerivedProblem = function() {
        const state = this._compactDerived;
        if (!state) return { field: 'formula', text: '' };
        const data = this._compactDerivedData(state.fileId);
        const name = state.name.trim();
        const nameProblem = variableNameProblem(name);
        if (nameProblem === 'dataToolNameEmpty') return { field: 'name', text: i18n.t('compactDerivedNeedName') };
        if (nameProblem) return { field: 'name', text: i18n.t(nameProblem) };
        const existing = data?.variables?.[name];
        const renaming = state.editing && name !== state.editing.name;
        if (existing && (renaming || (!state.editing && !existing.derived))) {
            return { field: 'name', text: i18n.t('derivedNameTaken').replace('{name}', name) };
        }
        if (!state.formula.trim()) return { field: 'formula', text: i18n.t('compactDerivedNeedFormula') };
        if (!state.valid) return { field: 'formula', text: i18n.t('compactDerivedNeedValid') };
        return null;
    };

    proto._compactDerivedSyncFooter = function() {
        const state = this._compactDerived;
        if (!state?.submit) return;
        const problem = this._compactDerivedProblem();
        state.submit.disabled = !!problem;
        state.submit.title = problem?.text || '';
        const name = state.name.trim();
        const data = this._compactDerivedData(state.fileId);
        // Under the name: what is wrong with it once something is typed (an
        // empty field says so with its placeholder), or that it will replace
        // a derived variable of that name.
        const nameError = problem?.field === 'name' && name ? problem.text : '';
        const replaces = !state.editing && !nameError && name && data?.variables?.[name]?.derived;
        state.nameHint.textContent = nameError || (replaces ? i18n.t('compactDerivedReplaces').replace('{name}', name) : '');
        state.nameHint.classList.toggle('is-error', !!nameError);
        state.nameInput.setAttribute('aria-invalid', String(!!nameError));
        // Put on the plot at once: only a new variable, and only where a tap in
        // Data would add it (a time series or one of its analyses).
        const target = !state.editing ? this._compactDerivedPlotTarget() : null;
        const chip = state.plotChip;
        chip.hidden = !target;
        if (target) {
            const label = i18n.t('compactDerivedAddToPlot').replace('{n}', String(target.n));
            chip.querySelector('.compact-btn-label').textContent = i18n.t('compactPlotN').replace('{n}', String(target.n));
            chip.querySelector('.compact-btn-icon').innerHTML = state.addToPlot ? ICON.check : ICON.plus;
            chip.classList.toggle('is-active', state.addToPlot);
            chip.setAttribute('aria-pressed', String(state.addToPlot));
            chip.title = label;
            chip.setAttribute('aria-label', label);
        }
    };

    // ─── Create, cancel, delete ───────────────────────────────────

    proto._compactDerivedSubmit = async function() {
        const state = this._compactDerived;
        if (!state || state.busy) return;
        // A formula typed a moment ago may not have been checked yet.
        clearTimeout(state.validateTimer);
        this._compactDerivedValidate();
        const problem = this._compactDerivedProblem();
        if (problem) {
            this._compactDerivedShowMessage(problem.text, 'error');
            if (problem.field === 'name') state.nameInput.focus();
            return;
        }
        if (this.activeFileId !== state.fileId) {
            this._compactDerivedShowMessage(i18n.t('derivedEditGone').replace('{name}', state.editing?.name || state.name), 'error');
            return;
        }
        const sideName = document.getElementById('derived-name');
        const sideFormula = document.getElementById('derived-formula');
        const form = document.getElementById('derived-form');
        const sideMessage = document.getElementById('derived-message');
        if (!sideName || !sideFormula || !form) return;
        const name = state.name.trim();
        sideName.value = name;
        sideFormula.value = state.formula.replace(/\s*\n\s*/g, ' ').trim();
        this._derivedEditing = state.editing;
        form.classList.remove('collapsed');
        state.busy = true;
        try {
            this.createDerivedVariable();
        } finally {
            state.busy = false;
        }
        // Created (or updated): the side panel closed its form. Otherwise its
        // message says why not, here where the user is.
        if (!form.classList.contains('collapsed')) {
            this._compactDerivedShowMessage(sideMessage?.textContent || i18n.t('compactDerivedNeedValid'), 'error');
            return;
        }
        const warning = sideMessage?.classList.contains('warn') ? sideMessage.textContent : '';
        const editing = state.editing;
        const target = !editing && state.addToPlot ? this._compactDerivedPlotTarget() : null;
        state.done = true;
        this._compactPopDerivedPages();
        if (target) {
            const plot = this.plotManager.plots.get(target.panelId);
            const already = (plot?.traces || []).some(trace => trace.varName === name && trace.fileId === state.fileId);
            if (!already) await this._compactToggleVariable(name);
        }
        // A new formula may give values far from the old ones: the plot on
        // screen would show an empty window. Its Y is fitted to them.
        if (editing) this._compactDerivedRefitShown(state.fileId, name);
        const key = editing ? 'compactDerivedUpdated' : (target ? 'compactDerivedCreatedOnPlot' : 'compactDerivedCreated');
        this._compactToast(warning || i18n.t(key).replace('{name}', name).replace('{n}', String(target?.n || '')));
        this._compactDerivedHighlight(name);
    };

    proto._compactDerivedRefitShown = function(fileId, name) {
        const panelId = this._compactActivePanelId?.();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        if (!plot || (plot.mode || 'timeseries') !== 'timeseries') return;
        if (!(plot.traces || []).some(trace => trace.fileId === fileId && trace.varName === name)) return;
        // Once the redraw with the new values is on screen.
        setTimeout(() => {
            if (plot.div?.isConnected && plot.div._fullLayout) this._compactFit(plot.div, 'y');
        }, 150);
    };

    // Off the stack: the editor and anything above it (the combine page).
    proto._compactPopDerivedPages = function() {
        const pages = this._compact.pages;
        const index = pages.findIndex(page => page === this._compactDerived?.page);
        if (index < 0) return;
        while (pages.length > index) this._popCompactPage();
    };

    proto._compactDerivedShowMessage = function(text, tone = '') {
        const state = this._compactDerived;
        if (!state?.message) return;
        state.message.textContent = text;
        state.message.className = `compact-derived-message${tone ? ` is-${tone}` : ''}`;
        state.message.hidden = !text;
    };

    proto._compactDerivedCancel = function() {
        const state = this._compactDerived;
        if (!state) return;
        // Cancel means it: no draft is kept.
        state.done = true;
        this._compact.derivedDraft = null;
        this._compactPopDerivedPages();
    };

    proto._compactDerivedDelete = async function() {
        const state = this._compactDerived;
        if (!state?.editing) return;
        const name = state.editing.name;
        const removed = await this._removeDerivedVariable(name);
        if (!removed) return;
        if (this._compactDerived === state) {
            state.done = true;
            this._compactPopDerivedPages();
        }
        this._compactToast(i18n.t('compactDerivedDeleted').replace('{name}', name));
    };

    // Back in the tree: the new row is brought into view and lit for a moment.
    proto._compactDerivedHighlight = function(name) {
        // After the sheet has settled back to its height: centred in the
        // taller sheet, the row would end up below the shorter one.
        setTimeout(() => {
            const row = [...document.querySelectorAll('#variables-tree .tree-item[data-var-name]:not([data-file-id])')]
                .find(item => item.dataset.varName === name);
            if (!row?.offsetParent) return;
            row.scrollIntoView?.({ block: 'center' });
            row.classList.remove('compact-flash');
            void row.offsetWidth;
            row.classList.add('compact-flash');
            setTimeout(() => row.classList.remove('compact-flash'), 1600);
        }, 280);
    };

    // ─── Σ Combine several ────────────────────────────────────────

    proto._openCompactDerivedCombine = function() {
        const state = this._compactDerived;
        if (!state) return;
        const data = this._compactDerivedData(state.fileId);
        const combine = { selection: [], fn: 'sum', filter: '', rows: new Map() };
        const node = el('div', 'compact-page compact-page-derived-combine');
        node.appendChild(el('p', 'compact-note compact-derived-combine-lead', i18n.t('compactDerivedCombineLead')));

        const fnSection = section(i18n.t('compactDerivedCombineFunction'));
        const fnRow = el('div', 'compact-segmented compact-derived-combine-fns');
        fnRow.setAttribute('role', 'radiogroup');
        const fnButtons = [];
        for (const name of LIST_FUNCTIONS.filter(fn => DERIVED_FUNCTIONS.some(entry => entry.name === fn))) {
            const btn = button('compact-segment', name, () => {
                combine.fn = name;
                sync();
            }, { title: i18n.t(`compactFn_${name}`) });
            btn.dataset.fn = name;
            btn.setAttribute('role', 'radio');
            fnButtons.push(btn);
            fnRow.appendChild(btn);
        }
        fnSection.appendChild(fnRow);
        node.appendChild(fnSection);

        const varSection = section('');
        const varHead = el('div', 'compact-derived-combine-head');
        const count = el('span', 'compact-derived-combine-count');
        const all = button('compact-link-btn', i18n.t('formulaEditorSelectShown'), () => {
            combine.rows.forEach((row, name) => {
                // The time axis is an operand, never what "all of them" means.
                if (row.hidden || row.dataset.kind === 'time' || combine.selection.includes(name)) return;
                combine.selection.push(name);
            });
            sync();
        });
        const clear = button('compact-link-btn', i18n.t('formulaEditorClearSelection'), () => {
            combine.selection = [];
            sync();
        });
        varHead.append(count, all, clear);
        const searchWrap = el('label', 'compact-derived-search');
        const searchIcon = el('span', 'compact-derived-search-icon');
        searchIcon.innerHTML = ICON.search;
        const search = el('input', 'compact-derived-filter');
        search.type = 'search';
        search.placeholder = i18n.t('formulaEditorFilter');
        search.setAttribute('aria-label', i18n.t('formulaEditorFilter'));
        search.setAttribute('autocapitalize', 'off');
        search.setAttribute('autocorrect', 'off');
        search.spellcheck = false;
        search.addEventListener('input', () => {
            combine.filter = search.value.trim().toLowerCase();
            sync();
        });
        searchWrap.append(searchIcon, search);
        const list = el('div', 'compact-list compact-derived-combine-list');
        for (const variable of this._compactDerivedVariables(data)) {
            const row = button('compact-list-btn compact-derived-pick', '', () => {
                const index = combine.selection.indexOf(variable.name);
                if (index >= 0) combine.selection.splice(index, 1);
                else combine.selection.push(variable.name);
                sync();
            });
            row.dataset.name = variable.name;
            row.dataset.kind = variable.kind;
            row.setAttribute('role', 'checkbox');
            row.appendChild(el('span', 'compact-derived-pick-box'));
            const text = el('span', 'compact-derived-var-text');
            text.appendChild(el('span', 'compact-derived-var-name', variable.name));
            if (variable.detail) text.appendChild(el('span', 'compact-derived-var-detail', variable.detail));
            row.appendChild(text);
            if (variable.tag) row.appendChild(el('span', `compact-derived-var-tag tag-${variable.kind}`, variable.tag));
            combine.rows.set(variable.name, row);
            list.appendChild(row);
        }
        varSection.append(varHead, searchWrap, list);
        node.appendChild(varSection);

        const footer = el('div', 'compact-derived-footer');
        const preview = el('div', 'compact-derived-combine-preview');
        preview.setAttribute('aria-live', 'polite');
        const insert = button('compact-primary-btn compact-derived-combine-insert', i18n.t('compactDerivedCombineInsert'), () => {
            if (!combine.selection.length || !combine.fn) return;
            const [start] = state.caret || [state.formula.length];
            const lead = endsWithOperand(state.formula.slice(0, start)) ? ' + ' : '';
            const call = listCall(combine.fn, combine.selection);
            this._popCompactPage();
            this._compactDerivedInsert(lead + call);
        });
        footer.append(preview, insert);
        node.appendChild(footer);

        const sync = () => {
            fnButtons.forEach((btn) => {
                const on = btn.dataset.fn === combine.fn;
                btn.classList.toggle('is-active', on);
                btn.setAttribute('aria-checked', String(on));
            });
            combine.rows.forEach((row, name) => {
                const index = combine.selection.indexOf(name);
                row.classList.toggle('is-selected', index >= 0);
                row.setAttribute('aria-checked', String(index >= 0));
                row.querySelector('.compact-derived-pick-box').textContent = index >= 0 ? String(index + 1) : '';
                const detail = row.querySelector('.compact-derived-var-detail')?.textContent || '';
                row.hidden = !!combine.filter && !name.toLowerCase().includes(combine.filter) && !detail.toLowerCase().includes(combine.filter);
            });
            count.textContent = i18n.t('formulaEditorSelected').replace('{count}', String(combine.selection.length));
            insert.disabled = !combine.selection.length;
            preview.textContent = combine.selection.length
                ? listCall(combine.fn, combine.selection)
                : i18n.t('formulaEditorCombineNeedVariables');
            preview.classList.toggle('is-ready', !!combine.selection.length);
        };
        sync();
        this._pushCompactPage({ title: i18n.t('compactDerivedCombineTitle'), node, persist: true });
    };

    // ─── Help ─────────────────────────────────────────────────────

    // The desktop's formula help, as a page: the same text, already in the
    // user's language. Its line about the desktop's ⤢ editor is replaced by
    // the phone's own.
    proto._openCompactDerivedHelp = function() {
        const node = el('div', 'compact-page compact-page-derived-help');
        const grid = document.querySelector('#derived-help-popover .derived-help-grid');
        if (grid) {
            const copy = grid.cloneNode(true);
            copy.querySelectorAll('[id]').forEach(item => item.removeAttribute('id'));
            const variablesRow = copy.querySelector('[data-i18n="derivedHelpVariablesText"]');
            if (variablesRow) variablesRow.textContent = i18n.t('compactDerivedHelpVariables');
            copy.classList.add('compact-derived-help');
            node.appendChild(copy);
        }
        this._pushCompactPage({ title: i18n.t('compactDerivedHelp'), node, persist: true });
    };

    // ─── Entry points ─────────────────────────────────────────────

    // The Data sheet's button beside Open file.
    proto._compactDerivedNewButton = function() {
        const btn = button('compact-secondary-btn compact-derived-new', i18n.t('compactDerivedNew'), () => this._openCompactDerivedEditor(), { icon: ICON.fx });
        btn.disabled = !this._compactDerivedData();
        if (btn.disabled) btn.title = i18n.t('derivedNewVariableNeedsFile');
        return btn;
    };

    // The Analyze sheet's section: what makes new signals out of the others.
    proto._compactDerivedAnalyzeSection = function() {
        const wrap = section(i18n.t('compactNewSignals'));
        const list = el('div', 'compact-list compact-menu-list');
        const row = el('button', 'compact-menu-btn compact-derived-analyze-row');
        row.type = 'button';
        const icon = el('span', 'compact-btn-icon compact-menu-icon');
        icon.innerHTML = ICON.fx;
        const text = el('span', 'compact-menu-text');
        text.appendChild(el('span', 'compact-menu-label', i18n.t('derivedVariables')));
        const count = this.derivedByFile?.get(this.activeFileId);
        const formulas = count ? [...count.values()].filter(entry => entry.formula).length : 0;
        const subtitle = this._compactDerivedData()
            ? (formulas ? i18n.t('compactDerivedAnalyzeCount').replace('{count}', String(formulas)) : i18n.t('compactDerivedAnalyzeSubtitle'))
            : i18n.t('derivedNewVariableNeedsFile');
        text.appendChild(el('span', 'compact-menu-subtitle', subtitle));
        row.append(icon, text);
        row.disabled = !this._compactDerivedData();
        row.addEventListener('click', (event) => {
            event.stopPropagation();
            this._openCompactDerivedEditor();
        });
        list.appendChild(row);
        wrap.appendChild(list);
        return wrap;
    };
}
