// Every row of the sidebar's "Derived variables" section carries a ✎.
//
//   node scripts/test-derived-tree-edit-button.mjs
//
// The section mixes two kinds of variable: formulas, edited in the Derived
// variables form, and Data Tools outputs, edited in the Data Tools panel. Only
// the formulas used to get a pencil, so an integral or a derivative read as
// something that could be deleted but never changed — the recipe was editable
// all along, from a row of the Transformations table far below in the sidebar,
// which is not where anyone looks after clicking the variable itself. The
// pencil is now on both; where it leads depends on what the variable is.

import assert from 'node:assert/strict';
import { installTreeMethods } from '../src/app/methods/tree-methods.js';

// ── A fake DOM, just enough for one leaf ────────────────────────────────────
class FakeElement {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.textContent = '';
        this.innerHTML = '';
        this.title = '';
        this.className = '';
        this.attributes = new Map();
        this.listeners = new Map();
        this.classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(n => this.classes.add(n)),
            remove: (...names) => names.forEach(n => this.classes.delete(n)),
            contains: (name) => this.classes.has(name),
            toggle: (name, on) => {
                const next = on ?? !this.classes.has(name);
                if (next) this.classes.add(name); else this.classes.delete(name);
                return next;
            },
        };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { this.children.push(child); return child; }
    append(...nodes) { nodes.forEach(node => this.children.push(node)); }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    click() {
        const event = { preventDefault() {}, stopPropagation() {} };
        for (const handler of this.listeners.get('click') || []) handler(event);
    }
    // Every element in this tree: the leaf renderer only ever reads its own.
    descendants() {
        return this.children.flatMap(child =>
            child instanceof FakeElement ? [child, ...child.descendants()] : []);
    }
    find(className) {
        return this.descendants().find(el => (el.className || '').split(/\s+/).includes(className)) || null;
    }
}

globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
};
// No touch support here: node's own `navigator` reports no touch points, and
// this window has no `ontouchstart`, so the leaf skips the touch-drag source.
globalThis.window = { matchMedia: () => ({ matches: false }) };

// ── The app, stubbed down to what one derived leaf reads ────────────────────
class Harness {
    constructor() {
        this.activeFileId = 'f1';
        this.selectedVariables = new Set();
        this.showDescriptions = false;
        this.parser = { getVariableIcon: () => '📈', getVariableInfo: () => '(real)' };
        this.plotManager = { isVariableSignInverted: () => false };
        // `P1 (W) int Wh` is a formula; `P1 (W) int` and `P1 (W) int ddt` came
        // out of the Data Tools panel — the three rows of the report.
        this.derivedByFile = new Map([['f1', new Map([
            ['P1 (W) int Wh', { formula: '`P1 (W) int`/3600' }],
        ])]]);
        this.dataToolVariablesByFile = new Map([['f1', new Map([
            ['P1 (W) int', { tool: 'integrate', sourceName: 'P1 (W)' }],
            ['P1 (W) int ddt', { tool: 'derivative', sourceName: 'P1 (W) int' }],
        ])]]);
        this.formulaEdits = [];
        this.dataToolEdits = [];
        this._editDerivedVariable = (name) => { this.formulaEdits.push(name); };
        this._enterDataToolEditing = (fileId, name) => { this.dataToolEdits.push([fileId, name]); };
    }
}
installTreeMethods(Harness);

const render = (app, name, variable, options = { derivedActions: true }) => {
    const parent = new FakeElement();
    app._renderVarLeaves([[name, variable]], parent, options);
    return parent;
};

const variableOf = (name) => ({ name, kind: 'variable', derived: true, dataType: 'real' });

// ── A Data Tools output: the pencil opens its recipe ────────────────────────
{
    const app = new Harness();
    const name = 'P1 (W) int ddt';
    const edit = render(app, name, variableOf(name)).find('tree-derived-edit');
    assert.ok(edit, 'a derivative made with Data tools has an edit button');
    assert.equal(edit.title, 'Edit transformation', 'it says what it edits: the transformation, not a formula');
    assert.equal(edit.getAttribute('aria-label'), 'Edit transformation');
    edit.click();
    assert.deepEqual(app.dataToolEdits, [['f1', name]], 'the click opens the Data Tools panel on this variable');
    assert.deepEqual(app.formulaEdits, [], 'and never the formula form, which has no recipe to show');
}

// ── A formula: the pencil still opens the formula form ──────────────────────
{
    const app = new Harness();
    const name = 'P1 (W) int Wh';
    const node = render(app, name, variableOf(name));
    const edit = node.find('tree-derived-edit');
    assert.ok(edit, 'a formula variable keeps its edit button');
    assert.equal(edit.title, 'Edit formula');
    edit.click();
    assert.deepEqual(app.formulaEdits, [name]);
    assert.deepEqual(app.dataToolEdits, [], 'a formula is not a Data Tools recipe');
    // The formula line under the name is what tells the two kinds apart; the
    // shared pencil must not have blurred that.
    assert.ok(node.find('tree-derived-formula'), 'the formula is still shown under the name');
    assert.equal(node.find('tree-derived-origin'), null);
}

// A Data Tools output says where it came from, as before.
{
    const app = new Harness();
    const node = render(app, 'P1 (W) int', variableOf('P1 (W) int'));
    assert.equal(node.find('tree-derived-origin')?.textContent, 'Created with Data tools');
    assert.equal(node.find('tree-derived-formula'), null);
}

// ── Rows that are neither get no pencil ─────────────────────────────────────
{
    // An ordinary variable of the file, rendered without derivedActions.
    const app = new Harness();
    const plain = render(app, 'P1 (W)', { name: 'P1 (W)', kind: 'variable', dataType: 'real' }, {});
    assert.equal(plain.find('tree-derived-edit'), null, 'the file tree has no edit buttons');

    // A derived row the app knows nothing about — a time-axis signal shares
    // this section — must not offer an edit that would open an empty form.
    const unknown = render(app, 'Time', variableOf('Time'));
    assert.equal(unknown.find('tree-derived-edit'), null, 'nothing to edit, no pencil');
}

console.log('Derived tree edit button tests passed.');
