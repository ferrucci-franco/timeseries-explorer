// Derived (formula) variables when what they read is renamed, and when they are
// edited themselves.
//
//   node scripts/test-derived-rename-edit.mjs
//
// A formula names its operands, so renaming one — a Data Tools output renamed
// in its panel, say — has to rewrite every formula that reads it. Otherwise the
// tree keeps showing the old name and the next recompute (reload, live update,
// session restore) fails on a variable that no longer exists. The same rename
// path serves the formula editor, which can rename a derived variable and change
// its formula; whatever was built on it is recomputed in dependency order.

import assert from 'node:assert/strict';
import { installDerivedMethods, renameFormulaReference, formulaNameLiteral, variableNameProblem } from '../src/app/methods/derived-methods.js';
import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';
import { emphasize, emphasizeList, emphasizedToHtml, emphasizedToPlain } from '../src/ui/emphasis.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// ── The pure rewrite ────────────────────────────────────────────────────────
{
    const vars = { x: {}, max_x: {}, 'x.y': {}, 'a[1]': {}, 'motor speed': {}, time: {} };
    const rename = (formula, from, to) => renameFormulaReference(formula, vars, from, to);

    check(() => assert.equal(rename('x * 2 + sin(x)', 'x', 'y'), 'y * 2 + sin(y)'));
    // Only whole name tokens: a longer name that merely contains x stays put.
    check(() => assert.equal(rename('max_x + x.y + x', 'x', 'y'), 'max_x + x.y + y'));
    // A function called like the variable is not the variable.
    check(() => assert.equal(renameFormulaReference('sin(sin)', { sin: {} }, 'sin', 's'), 'sin(s)'));
    // Backticked references are found, and the new name is written bare when it can be.
    check(() => assert.equal(rename('`motor speed` * 2', 'motor speed', 'speed'), 'speed * 2'));
    // A name that needs backticks gets them.
    check(() => assert.equal(rename('x + 1', 'x', 'filtered x'), '`filtered x` + 1'));
    check(() => assert.equal(rename('min([x, a[1]])', 'a[1]', 'b[1]'), 'min([x, b[1]])'));
    // The old name no longer being in the map (the rename already moved it) is the normal case.
    check(() => assert.equal(renameFormulaReference('old - 1', { new: {} }, 'old', 'new'), 'new - 1'));
    // Untouched when it does not refer to the name, or cannot even be tokenized.
    check(() => assert.equal(rename('time * 3', 'x', 'y'), 'time * 3'));
    check(() => assert.equal(rename('x + $', 'x', 'y'), 'x + $'));
    // Only the tokens matter: an unfinished formula still gets the new name.
    check(() => assert.equal(rename('x + (', 'x', 'y'), 'y + ('));
    check(() => assert.equal(formulaNameLiteral('a.b'), 'a.b'));
    check(() => assert.equal(formulaNameLiteral('2x'), '`2x`'));
}

// ── App harness ─────────────────────────────────────────────────────────────
class FakeElement {
    constructor() {
        this.value = '';
        this.textContent = '';
        this.className = '';
        this.hidden = false;
        this.classes = new Set();
        this.classList = {
            toggle: (name, on) => { if (on ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); return this.classes.has(name); },
            contains: (name) => this.classes.has(name),
        };
    }
    focus() {}
    setSelectionRange() {}
}
const elements = new Map();
globalThis.document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new FakeElement());
        return elements.get(id);
    },
};
const el = (id) => document.getElementById(id);

class Harness {
    constructor() {
        this.activeFileId = 'f1';
        this.derivedByFile = new Map();
        this.dataToolVariablesByFile = new Map();
        this.selectedVariables = new Set();
        this.rebuiltPanels = [];
        this.plotManager = {
            files: new Map(),
            plots: new Map(),
            updates: 0,
            updateFileData: () => { this.plotManager.updates++; },
            _rebuildPanel: (panelId) => { this.rebuiltPanels.push(panelId); },
        };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
        this._renderFilteredTree = () => {};
        this._rebuildPlotsUsingVariable = () => {};
        // A stand-in Data Tools transformation: ten times its source. The
        // orchestration is what is under test, not the tools themselves.
        this._reapplyDataToolDefinition = (fileId, data, name, definition) => {
            const source = data.variables[definition.sourceName];
            if (!source) return false;
            if ((definition.targetMode || 'create') === 'modify') {
                const original = definition.originalData?.length ? definition.originalData : Array.from(source.data);
                source.data = Float64Array.from(original, v => v * 10);
                source.dataToolModified = true;
                definition.originalData = Array.from(original);
                return true;
            }
            data.variables[name] = { name, kind: 'variable', derived: true, data: Float64Array.from(source.data, v => v * 10) };
            definition.variable = data.variables[name];
            return true;
        };
    }
}
installDataToolsMethods(Harness);
installDerivedMethods(Harness);

function setup() {
    const h = new Harness();
    const data = {
        variables: {
            time: { name: 'time', kind: 'abscissa', data: Float64Array.from([0, 1, 2]) },
            u: { name: 'u', kind: 'variable', data: Float64Array.from([1, 2, 3]) },
        },
    };
    h.plotManager.files.set('f1', { data, invertedVariables: new Set() });
    return { h, data };
}

function createFormula(h, name, formula) {
    h._toggleDerivedForm(true);
    el('derived-name').value = name;
    el('derived-formula').value = formula;
    h.createDerivedVariable();
    assert.notEqual(el('derived-message').className, 'derived-message error', el('derived-message').textContent);
}

function addTool(h, data, name, sourceName, targetMode = 'create') {
    const definition = { name, tool: 'scale', targetMode, sourceName, params: {} };
    h._storeDataToolDefinition('f1', name, definition);
    h._reapplyDataToolDefinition('f1', data, name, h.dataToolVariablesByFile.get('f1').get(name));
}

const values = (data, name) => Array.from(data.variables[name].data);

// A Data Tools output renamed under a formula that reads it: the bug report.
{
    const { h, data } = setup();
    addTool(h, data, 'x', 'u');
    createFormula(h, 'd', 'x + 1');
    h.plotManager.plots.set('p1', { traces: [{ fileId: 'f1', varName: 'x' }], phaseTraces: [] });
    h.plotManager.files.get('f1').invertedVariables.add('x');

    h._renameDataToolVariable('f1', data, 'x', 'y');

    const entry = h.derivedByFile.get('f1').get('d');
    check(() => assert.equal(entry.formula, 'y + 1'));
    check(() => assert.equal(data.variables.d.formula, 'y + 1'));
    check(() => assert.equal(data.variables.d.description, 'Derived: y + 1'));
    check(() => assert.ok(data.variables.y && !data.variables.x));
    check(() => assert.equal(h.plotManager.plots.get('p1').traces[0].varName, 'y'));
    check(() => assert.ok(h.plotManager.files.get('f1').invertedVariables.has('y')));
    // The rewritten formula still recomputes: this is what a reload does.
    check(() => assert.equal(h._reapplyDerivedVariable('f1', data, 'd', entry), true));
    check(() => assert.deepEqual(values(data, 'd'), [11, 21, 31]));
}

// Editing a formula: new values, dependents recomputed in order, rename propagated.
{
    const { h, data } = setup();
    createFormula(h, 'a', 'u * 2');                  // [2, 4, 6]
    addTool(h, data, 'a10', 'a');                    // a tool built on it
    createFormula(h, 'b', 'a + a10');                // reads a and the tool output
    createFormula(h, 'c', 'b - 1');                  // one more level
    check(() => assert.deepEqual(values(data, 'b'), [22, 44, 66]));

    h._editDerivedVariable('a');
    check(() => assert.equal(el('derived-name').value, 'a'));
    check(() => assert.equal(el('derived-formula').value, 'u * 2'));
    check(() => assert.equal(el('derived-create').textContent, 'Update'));

    el('derived-name').value = 'alpha';
    el('derived-formula').value = 'u * 3';           // [3, 6, 9]
    h.createDerivedVariable();
    check(() => assert.equal(el('derived-message').className, 'derived-message ok'));
    check(() => assert.equal(h._derivedEditing, null));
    check(() => assert.equal(el('derived-create').textContent, 'Create'));

    check(() => assert.ok(!data.variables.a && !h.derivedByFile.get('f1').has('a')));
    check(() => assert.deepEqual(values(data, 'alpha'), [3, 6, 9]));
    check(() => assert.equal(h.dataToolVariablesByFile.get('f1').get('a10').sourceName, 'alpha'));
    check(() => assert.deepEqual(values(data, 'a10'), [30, 60, 90]));
    // b sees the refreshed tool output, not the stale one: dependency order.
    check(() => assert.equal(h.derivedByFile.get('f1').get('b').formula, 'alpha + a10'));
    check(() => assert.deepEqual(values(data, 'b'), [33, 66, 99]));
    check(() => assert.deepEqual(values(data, 'c'), [32, 65, 98]));
}

// Guards: no cycles, no clobbering another variable, a bad formula changes nothing.
{
    const { h, data } = setup();
    createFormula(h, 'a', 'u + 1');
    createFormula(h, 'b', 'a * 2');

    const attempt = (name, formula) => {
        h._editDerivedVariable('a');
        el('derived-name').value = name;
        el('derived-formula').value = formula;
        h.createDerivedVariable();
        const outcome = { type: el('derived-message').className, text: el('derived-message').textContent };
        h._toggleDerivedForm(false);
        return outcome;
    };

    check(() => assert.equal(attempt('a', 'a + 1').type, 'derived-message error'));
    check(() => assert.equal(attempt('a', 'b + 1').type, 'derived-message error'));
    check(() => assert.match(attempt('u', 'time').text, /already exists/));
    check(() => assert.equal(attempt('z', 'nope + 1').type, 'derived-message error'));
    check(() => assert.ok(data.variables.a && !data.variables.z));
    check(() => assert.equal(h.derivedByFile.get('f1').get('a').formula, 'u + 1'));
    check(() => assert.deepEqual(values(data, 'b'), [4, 6, 8]));
    // Closing the form ends the edit, so the next Create is a new variable again.
    check(() => assert.equal(h._derivedEditing, null));
}

// A Data Tools edit in place on a derived variable starts again from the new formula's values.
{
    const { h, data } = setup();
    createFormula(h, 'a', 'u + 1');                  // [2, 3, 4]
    addTool(h, data, 'a', 'a', 'modify');            // shown as [20, 30, 40]
    check(() => assert.deepEqual(values(data, 'a'), [20, 30, 40]));

    h._editDerivedVariable('a');
    el('derived-formula').value = 'u';               // [1, 2, 3]
    h.createDerivedVariable();
    check(() => assert.deepEqual(values(data, 'a'), [10, 20, 30]));
}

// Editing a Data Tools variable (a filter's cutoff, say) recomputes the formulas
// built on it: on Update, live while previewing, and back again on Cancel.
{
    const { h, data } = setup();
    addTool(h, data, 'x', 'u');                      // [10, 20, 30]
    createFormula(h, 'd', 'x + 1');                  // [11, 21, 31]
    createFormula(h, 'e', 'd * 2');                  // [22, 42, 62]
    addTool(h, data, 'e10', 'e');                    // a tool on top of the formula

    // The chain an edit of x refreshes, in order: what the live toggle counts.
    check(() => assert.deepEqual(h._dataToolChainDependents('f1', 'x'), ['d', 'e', 'e10']));
    // None of it may become x's own source.
    const sources = h._getDataToolSourceEntries(data, 'removeOutliers', 'x').map(([name]) => name);
    check(() => assert.ok(!sources.some(name => ['x', 'd', 'e', 'e10'].includes(name)), sources.join(',')));

    // Stand-in tool run: the "parameter" is the factor.
    const run = (factor) => async (values) => ({ variable: { name: 'x', kind: 'variable', derived: true, data: Float64Array.from(values, v => v * factor) } });
    h._setOutlierMessage = (message, type) => { h.lastToolMessage = [typeof message === 'function' ? message() : message, type]; };
    h.plotManager.refreshTraceValues = () => true;
    const context = { fileId: 'f1', data, sourceName: 'u', sourceVariable: data.variables.u, outputName: 'x', tool: 'scale' };
    const config = { method: 'bounds', params: {}, replacement: 'nan' };

    // Live preview of a new parameter value.
    h._previewEditedVariable(context, { name: 'x' }, await run(100)(data.variables.u.data));
    check(() => assert.deepEqual(values(data, 'x'), [100, 200, 300]));
    check(() => assert.deepEqual(values(data, 'd'), [101, 201, 301]));
    check(() => assert.deepEqual(values(data, 'e10'), [2020, 4020, 6020]));
    // Cancel puts the formulas back with the variable.
    h._restoreEditedTraceValues();
    check(() => assert.deepEqual(values(data, 'x'), [10, 20, 30]));
    check(() => assert.deepEqual(values(data, 'e'), [22, 42, 62]));

    // Update.
    h._buildDataToolResultOffThread = run(5);
    const updates = h.plotManager.updates;
    await h._updateDataToolVariable(context, config, { name: 'x' });
    check(() => assert.deepEqual(values(data, 'x'), [5, 10, 15]));
    check(() => assert.deepEqual(values(data, 'd'), [6, 11, 16]));
    check(() => assert.deepEqual(values(data, 'e'), [12, 22, 32]));
    check(() => assert.deepEqual(values(data, 'e10'), [120, 220, 320]));
    check(() => assert.equal(h.plotManager.updates, updates + 1));
    check(() => assert.match(h.lastToolMessage[0], /3/));
}

// Deleting a Data Tools variable takes the formulas reading it down with it, and
// says so; renaming one (above) rewrites them instead.
{
    const { h, data } = setup();
    addTool(h, data, 'x', 'u');
    createFormula(h, 'd', 'x + 1');
    createFormula(h, 'e', 'd * 2');
    createFormula(h, 'keep', 'u * 2');
    addTool(h, data, 'x2', 'x');
    h._syncDataTools = () => {};
    h._setOutlierMessage = (message, type) => { h.lastToolMessage = [typeof message === 'function' ? message() : message, type]; };

    check(() => assert.equal(h._deleteDataToolVariable('f1', 'x'), true));
    for (const gone of ['x', 'd', 'e', 'x2']) {
        check(() => assert.ok(!data.variables[gone], `${gone} should be gone`));
    }
    check(() => assert.ok(!h.derivedByFile.get('f1').has('d') && !h.derivedByFile.get('f1').has('e')));
    check(() => assert.ok(data.variables.keep && h.derivedByFile.get('f1').has('keep')));
    // One message, where the delete happened, every removed name set apart.
    check(() => assert.equal(h.lastToolMessage[1], 'ok'));
    check(() => assert.equal(emphasizedToPlain(h.lastToolMessage[0]),
        'Removed “x”, and the 3 variables built from it: “d”, “e”, “x2”.'));
}

// Removing a formula variable from its row takes its chain along (once confirmed).
{
    const { h, data } = setup();
    createFormula(h, 'a', 'u + 1');
    createFormula(h, 'b', 'a * 2');
    addTool(h, data, 'b10', 'b');
    h._syncDataTools = () => {};
    const removed = await h._removeDerivedVariable('a', { confirmed: true });
    check(() => assert.equal(removed, true));
    check(() => assert.ok(!data.variables.a && !data.variables.b && !data.variables.b10));
    check(() => assert.ok(!h.dataToolVariablesByFile.get('f1')?.has('b10')));
}

// What the × asks before deleting: always something, and exactly what goes.
{
    const { h, data } = setup();
    addTool(h, data, 'lp', 'u');
    createFormula(h, 'a', 'u + 1');
    createFormula(h, 'b', 'a * 2');
    createFormula(h, 'c', 'a * 3');
    createFormula(h, 'lone', 'u - 1');
    createFormula(h, 'dl', 'lp * 2');
    const ask = (name) => emphasizedToPlain(h._derivedRemovalQuestion('f1', name, h._variableDependents('f1', data, name)));
    check(() => assert.equal(ask('lone'), 'Delete “lone”?'));
    check(() => assert.equal(ask('a'), 'Delete “a”? These 2 variables are computed from it and will be deleted too: “b”, “c”.'));
    check(() => assert.equal(ask('lp'),
        '“lp” is the output of a Data tools transformation: deleting it also deletes the transformation. “dl” is computed from it and will be deleted too.'));
}

// Names set apart without letting them inject markup.
{
    const text = `Delete ${emphasize('<img src=x onerror=alert(1)>')} and ${emphasizeList(['a&b', 'c'])}?`;
    check(() => assert.equal(emphasizedToHtml(text),
        'Delete <strong>&lt;img src=x onerror=alert(1)&gt;</strong> and <strong>a&amp;b</strong>, <strong>c</strong>?'));
    check(() => assert.equal(emphasizedToPlain(text), 'Delete “<img src=x onerror=alert(1)>” and “a&b”, “c”?'));
    // A name cannot close its own emphasis early.
    check(() => assert.equal(emphasizedToPlain(emphasize('a\u0001b')), '“ab”'));
}

// A plotted variable renamed: the legend is relabelled in place, never rebuilt;
// a name-only edit recomputes nothing.
{
    const { h, data } = setup();
    addTool(h, data, 'x', 'u');
    data.variables.x.displayName = 'x';
    createFormula(h, 'd', 'x + 1');
    h.plotManager.plots.set('p1', { mode: 'timeseries', traces: [{ fileId: 'f1', varName: 'x' }, { fileId: 'f1', varName: 'd' }], phaseTraces: [] });
    h.plotManager.plots.set('p2', { mode: 'fft', traces: [{ fileId: 'f1', varName: 'x' }], phaseTraces: [] });
    const relabelled = [];
    const transformSeries = new Map([['x\u0000n\u00001', 'cached'], ['xx\u0000n\u00001', 'other']]);
    h.plotManager.files.get('f1')._transformCache = { series: transformSeries };
    h.plotManager.captureTimeseriesLabels = (fileId, name) => new Map([['p1', { oldLabel: name }]]);
    h.plotManager.relabelTimeseriesTraces = (panelId, captured, fileId, newName) => { relabelled.push([panelId, captured.oldLabel, newName]); return true; };
    h.plotManager.renameTransformCacheEntries = function(fileId, oldName, newName) {
        // The real one, on this stub's files map.
        const series = this.files.get(fileId)?._transformCache?.series;
        for (const [key, value] of [...series]) {
            if (!key.startsWith(`${oldName}\u0000`)) continue;
            series.delete(key);
            series.set(`${newName}\u0000${key.slice(oldName.length + 1)}`, value);
        }
    };
    h.rebuiltPanels.length = 0;

    h._renameDataToolVariable('f1', data, 'x', 'y');
    check(() => assert.deepEqual(relabelled, [['p1', 'x', 'y']]));
    check(() => assert.deepEqual(h.rebuiltPanels, ['p2']));             // not a timeseries: rebuilt
    check(() => assert.equal(data.variables.y.displayName, 'y'));
    check(() => assert.deepEqual([...transformSeries.keys()].sort(), ['xx\u0000n\u00001', 'y\u0000n\u00001']));

    // The formula editor, name only: relabel, no recompute, no redraw.
    const before = data.variables.d;
    const updates = h.plotManager.updates;
    h._editDerivedVariable('d');
    el('derived-name').value = 'e';
    h.createDerivedVariable();
    check(() => assert.equal(data.variables.e, before));
    check(() => assert.equal(h.plotManager.updates, updates));
    check(() => assert.deepEqual(relabelled.at(-1), ['p1', 'd', 'e']));

    // Name and formula: no relabel (the redraw below covers it), one update.
    const count = relabelled.length;
    h._editDerivedVariable('e');
    el('derived-name').value = 'f';
    el('derived-formula').value = 'y * 3';
    h.createDerivedVariable();
    check(() => assert.equal(relabelled.length, count));
    check(() => assert.equal(h.plotManager.updates, updates + 1));
    check(() => assert.deepEqual(values(data, 'f'), [30, 60, 90]));
}

// Only a rename, as far as the Data Tools panel can tell.
{
    const { h } = setup();
    const definition = { tool: 'movingAverage', sourceName: 'u', targetMode: 'create', params: { window: 5, extra: { b: 1, a: 2 } } };
    const same = (config, source = 'u', tool = 'movingAverage') => h._dataToolConfigUnchanged(definition, config, source, tool);
    check(() => assert.equal(same({ tool: 'movingAverage', params: { extra: { a: 2, b: 1 }, window: 5 } }), true));
    check(() => assert.equal(same({ tool: 'movingAverage', params: { window: 7, extra: { a: 2, b: 1 } } }), false));
    check(() => assert.equal(same({ tool: 'movingAverage', params: definition.params }, 'v'), false));
    check(() => assert.equal(same({ tool: 'derivative', params: definition.params }, 'u', 'derivative'), false));
    check(() => assert.equal(h._dataToolConfigUnchanged(null, {}, 'u', 'x'), false));
}

// Memory and staleness: the transform cache is keyed by name. A variable that is
// recomputed or removed must neither be served from, nor stay pinned in, it.
{
    class PlotData { constructor() { this.files = new Map(); this.plots = new Map(); } }
    installPlotDataMethods(PlotData);
    const pm = new PlotData();
    // The time axis is not what is under test: no crop, no reindex.
    pm._getTransformIndexDataForVariable = () => ({ indexes: null, times: [0, 1, 2] });
    const variables = {
        time: { name: 'time', kind: 'abscissa', data: Float64Array.from([0, 1, 2]) },
        v: { name: 'v', kind: 'variable', data: Float64Array.from([1, 2, 3]) },
    };
    pm.files.set('f1', { data: { variables }, transform: { gain: 2 } });
    const read = () => Array.from(pm._getTransformedVariableData('f1', 'v'));
    check(() => assert.deepEqual(read(), [2, 4, 6]));
    // Same name, new array (a recomputed formula, or a variable created again
    // under a removed one's name): the new values, not the cached ones.
    variables.v = { name: 'v', kind: 'variable', data: Float64Array.from([10, 20, 30]) };
    check(() => assert.deepEqual(read(), [20, 40, 60]));

    // Removal takes the cached series with it, and the sign flip.
    const { h, data } = setup();
    addTool(h, data, 'x', 'u');
    const series = new Map([['x\u0000y\u00001', { values: 'pinned' }], ['u\u0000y\u00001', { values: 'kept' }]]);
    const entry = h.plotManager.files.get('f1');
    entry._transformCache = { series };
    entry.invertedVariables.add('x');
    h.plotManager.forgetVariableCache = function(fileId, name) {
        for (const key of [...series.keys()]) if (key.startsWith(`${name}\u0000`)) series.delete(key);
    };
    h._syncDataTools = () => {};
    h._setOutlierMessage = () => {};
    h._deleteDataToolVariable('f1', 'x');
    check(() => assert.deepEqual([...series.keys()], ['u\u0000y\u00001']));
    check(() => assert.ok(!entry.invertedVariables.has('x')));
}

// Any name a Data Tools output may have, a formula variable may have too, and a
// formula reaches it in backticks. Only a backtick itself is refused.
{
    check(() => assert.equal(variableNameProblem('d squared'), ''));
    check(() => assert.equal(variableNameProblem('P [kW] (phase 1)'), ''));
    check(() => assert.equal(variableNameProblem('   '), 'dataToolNameEmpty'));
    check(() => assert.equal(variableNameProblem('a`b'), 'variableNameBacktick'));

    const { h, data } = setup();
    createFormula(h, 'd squared', 'u * u');
    check(() => assert.deepEqual(values(data, 'd squared'), [1, 4, 9]));
    createFormula(h, 'half', '`d squared` / 2');
    check(() => assert.deepEqual(values(data, 'half'), [0.5, 2, 4.5]));
    // Renamed to another spaced name, the formula keeps quoting it.
    h._editDerivedVariable('d squared');
    el('derived-name').value = 'u squared';
    h.createDerivedVariable();
    check(() => assert.equal(h.derivedByFile.get('f1').get('half').formula, '`u squared` / 2'));
    // The backtick is refused with a reason, and nothing is created.
    h._toggleDerivedForm(true);
    el('derived-name').value = 'bad`name';
    el('derived-formula').value = 'u';
    h.createDerivedVariable();
    check(() => assert.equal(el('derived-message').className, 'derived-message error'));
    check(() => assert.ok(!data.variables['bad`name']));
    h._toggleDerivedForm(false);
}

console.log(`derived rename/edit: ${checks} checks passed`);
