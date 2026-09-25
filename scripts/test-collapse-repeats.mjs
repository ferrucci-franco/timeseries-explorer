// "Collapse repeated timestamps": one row per instant, the reader choosing
// which one (#154).
//
// The app keeps a file's time axis however often its stamps repeat, which
// leaves several rows at one instant drawn as a vertical segment. This is how
// a reader turns that into one row — and nothing here decides for them which.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installCollapseMethods } from '../src/app/methods/collapse-methods.js';
import { RESAMPLE_ALL_VARIABLES } from '../src/app/methods/data-tools-methods.js';
import {
    COLLAPSE_AGGREGATES,
    COLLAPSE_DEFAULT_AGGREGATE,
    normalizeCollapseAggregate,
    runCollapseRepeats,
    timestampRuns,
} from '../src/compute/kernels/collapse-repeats.js';

// ── Where the runs are ──────────────────────────────────────────────────────
const runs = timestampRuns([0, 1, 1, 1, 1, 2]);
assert.equal(runs.groups, 3, 'three instants');
assert.equal(runs.collapsed, 3, 'and three rows the file would lose');
assert.deepEqual(Array.from(runs.lengths), [1, 4, 1]);
assert.equal(timestampRuns([]).groups, 0);
assert.equal(timestampRuns([5, 5, 5]).collapsed, 2, 'a file that is one instant throughout');

// A row whose time could not be read is at no instant, so it joins nothing —
// not even another unreadable one.
const withGaps = timestampRuns([1, NaN, NaN, 1]);
assert.equal(withGaps.groups, 4, 'NaT rows stand alone');
assert.equal(withGaps.collapsed, 0);

// ── What the rows become ────────────────────────────────────────────────────
const burst = { time: [0, 1, 1, 1, 1, 2], columns: [[1, 10, 20, 30, 40, 2]] };
const of = (aggregate) => Array.from(runCollapseRepeats({ ...burst, params: { aggregate } }).columns[0]);
assert.deepEqual(of('mean'), [1, 25, 2]);
assert.deepEqual(of('max'), [1, 40, 2]);
assert.deepEqual(of('min'), [1, 10, 2]);
assert.deepEqual(of('first'), [1, 10, 2], 'the row that arrived first, not the smallest');
assert.deepEqual(of('last'), [1, 40, 2]);
assert.deepEqual(Array.from(runCollapseRepeats({ ...burst, params: { aggregate: 'mean' } }).time), [0, 1, 2],
    'the instant is kept, once');

// Every column of the file goes through the same grouping, so the rows stay rows.
const two = runCollapseRepeats({ time: [1, 1, 2], columns: [[4, 6, 9], [10, 20, 30]], params: { aggregate: 'mean' } });
assert.deepEqual(two.columns.map(c => Array.from(c)), [[5, 9], [15, 30]]);

// A hole in one row of a burst is a missing reading, not a reason to throw the
// burst away — but a burst with nothing in it has nothing to average.
assert.deepEqual(Array.from(runCollapseRepeats({
    time: [1, 1, 1], columns: [[2, NaN, 4]], params: { aggregate: 'mean' },
}).columns[0]), [3], 'the finite values are what there is to average');
assert.ok(Number.isNaN(runCollapseRepeats({
    time: [1, 1], columns: [[NaN, NaN]], params: { aggregate: 'max' },
}).columns[0][0]), 'and no finite value says so');
// first/last mean the first and last ROW, whatever it holds.
assert.ok(Number.isNaN(runCollapseRepeats({
    time: [1, 1], columns: [[NaN, 5]], params: { aggregate: 'first' },
}).columns[0][0]), 'the first row of the burst is the first row of the burst');

// A file with nothing repeated comes through unchanged.
const untouched = runCollapseRepeats({ time: [1, 2, 3], columns: [[7, 8, 9]], params: {} });
assert.equal(untouched.collapsed, 0);
assert.deepEqual(Array.from(untouched.columns[0]), [7, 8, 9]);
assert.equal(untouched.aggregate, COLLAPSE_DEFAULT_AGGREGATE);

assert.deepEqual(COLLAPSE_AGGREGATES, ['mean', 'max', 'min', 'first', 'last']);
assert.equal(normalizeCollapseAggregate('median'), 'mean', 'an aggregate this kernel does not know falls back');
assert.equal(normalizeCollapseAggregate(undefined), 'mean');

// ── Wired in as a derived-dataset tool ──────────────────────────────────────
const methods = readFileSync(new URL('../src/app/methods/collapse-methods.js', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/app/methods/data-tools-methods.js', import.meta.url), 'utf8');
const datasets = readFileSync(new URL('../src/app/methods/derived-dataset-methods.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');

assert.match(tools, /const FILE_DATA_TOOLS = new Set\(\['resample', 'xcorr', 'collapse'\]\);/,
    'it makes a file, not a variable: the row count changes');
assert.match(tools, /const wholeFileTool = tool === 'resample' \|\| tool === 'collapse';/,
    'and its Variable picker offers "All variables", like the resampler');
assert.match(tools, /if \(fileTool === 'collapse'\) return this\.commitCollapseTool\(options\);/, 'Create reaches it');
assert.match(datasets, /if \(recipe\.tool === 'collapse'\) return this\._computeCollapseDataset\(/,
    'so a reload of the source recomputes it from its recipe');
assert.match(datasets, /if \(recipe\.tool === 'collapse'\) this\._writeCollapseForm\?\.\(recipe, entry\.name\);/,
    'and the pencil reopens the tool with that recipe');
assert.match(app, /installCollapseMethods\(OpenModelicaViewer\);/);
assert.match(html, /<option value="collapse" data-i18n="dataToolCollapse">/, 'it is in the tool picker');
assert.match(html, /<select id="collapse-aggregate"/, 'with the choice the report asked for');
for (const aggregate of COLLAPSE_AGGREGATES) {
    assert.ok(html.includes(`<option value="${aggregate}"`), `${aggregate} is offered`);
}

// A row index counts rows and cannot repeat; collapsing it would merge rows
// that were never said to be at one instant.
assert.match(methods, /if \(time\.kind === 'index' \|\| !time\.values\?\.length\) return \{ \.\.\.blank, code: 'dataToolCollapseNoTimeAxis' \};/);
assert.match(methods, /if \(!runs\.collapsed\) return \{ \.\.\.blank, code: 'dataToolCollapseNothing'/,
    'and a file with nothing repeated is not worth a copy of itself');
assert.match(methods, /datetimeRepeats: \{ samples: grid\.length, repeated: 0, longestRun: grid\.length \? 1 : 0 \}/,
    'the result has one row per instant, so the notice must not fire on it');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['dataToolCollapse', 'dataToolCollapseAggregate', 'dataToolCollapseSummary',
    'dataToolCollapseCreated', 'dataToolCollapseNothing', 'dataToolCollapseNoTimeAxis',
    'dataToolCollapseFileSuffix', ...COLLAPSE_AGGREGATES.map(a => `dataToolCollapse${a[0].toUpperCase()}${a.slice(1)}`)]) {
    assert.equal([...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

// ── The Variable picker, and where "Create and plot" draws ─────────────────
// Run the real methods against a small app: the picker used to be shown and
// then ignored (every variable was written whatever it said), and the plot
// used to land on a new, empty panel instead of beside the original.
{
    const fields = new Map();
    globalThis.document = { getElementById: id => fields.get(id) || null };
    const field = (id, value) => fields.set(id, { value });

    class App {
        constructor() {
            this.activeFileId = 'src';
            this.files = new Map([['src', { name: 'logger.csv' }]]);
            this.plotted = [];
            this.registered = [];
            this.messages = [];
            this.source = {
                variables: {
                    time: { kind: 'abscissa', data: [0, 1, 1, 2] },
                    a: { kind: 'variable', data: [1, 2, 4, 5], description: '' },
                    b: { kind: 'variable', data: [9, 8, 6, 5], description: '' },
                    p: { kind: 'parameter', data: [7] },
                },
            };
            this.plotManager = { files: new Map([['src', { data: this.source }]]) };
            this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false, _buildTree: () => ({}) };
            this.onScreen = new Set();
        }
        _isDataToolLazyData() { return false; }
        _resampleTimeContext() { return { values: [0, 1, 1, 2], kind: 'numeric', name: 'time' }; }
        // The resampler's reading of the picker, reproduced: all, or the one named.
        _resampleTargetNames(_data, selection) {
            const all = ['a', 'b'];
            if (selection && selection !== RESAMPLE_ALL_VARIABLES) return all.includes(selection) ? [selection] : [];
            return all;
        }
        _setOutlierMessage(message, kind) { this.messages.push({ kind, text: typeof message === 'function' ? message() : message }); }
        _registerDerivedDataset(recipe, name, data) {
            this.registered.push({ recipe, name, data });
            return { fileId: 'derived', replaced: false };
        }
        _exitDerivedDatasetEditing() {}
        _isDataToolVariablePlotted(fileId, name) { return this.onScreen.has(`${fileId}|${name}`); }
        _plotDerivedDatasetVariable(fileId, name, options) { this.plotted.push({ fileId, name, options }); }
        _isInMemoryFile() { return false; }
        _clearDataToolDraft() {}
        _syncDataTools() {}
    }
    installCollapseMethods(App);

    const run = async (selection, { plot = true, onScreen = [] } = {}) => {
        const app = new App();
        onScreen.forEach(key => app.onScreen.add(key));
        field('outlier-variable', selection);
        field('outlier-output-name', 'logger collapsed');
        field('collapse-aggregate', 'mean');
        const outcome = await app.commitCollapseTool({ plot });
        return { app, outcome };
    };

    // One variable picked: only that one is written, and the recipe keeps it.
    let { app } = await run('a');
    let written = app.registered[0];
    assert.deepEqual(Object.keys(written.data.variables).sort(), ['a', 'p', 'time'],
        'one variable picked: the copy holds it (with the time axis and the parameters), not the whole file');
    assert.deepEqual(Array.from(written.data.variables.a.data), [1, 3, 5], 'collapsed');
    assert.equal(written.recipe.sourceName, 'a', 'the recipe remembers the pick, for edit / reload / sessions');
    assert.equal(app._collapseRecipeDescription(written.recipe), 'a: repeated timestamps → mean');

    // Recomputing from the recipe (a reload of the source) gives the same variables.
    const again = await app._computeCollapseDataset('src', app.source, written.recipe);
    assert.deepEqual(again.names, ['a']);

    // "All variables": the whole file, as before.
    ({ app } = await run(RESAMPLE_ALL_VARIABLES));
    written = app.registered[0];
    assert.deepEqual(Object.keys(written.data.variables).sort(), ['a', 'b', 'p', 'time']);
    assert.equal(written.recipe.sourceName, '', 'all variables keeps the old recipe shape');
    assert.equal(app._collapseRecipeDescription(written.recipe), 'repeated timestamps → mean');

    // A picked variable that is not there is refused, not silently widened.
    ({ app } = await run('nope', { plot: false }));
    assert.equal(app.registered.length, 0);
    assert.equal(app.messages.at(-1).kind, 'error');

    // The plan the form reads follows the picker too.
    field('outlier-variable', 'b');
    assert.deepEqual(new App()._collapsePlan(new App().source).names, ['b']);

    // "Create and plot" draws beside the original, on its panel.
    ({ app } = await run('b'));
    assert.deepEqual(app.plotted, [{ fileId: 'derived', name: 'b', options: { alongside: { fileId: 'src', name: 'b' } } }],
        'the collapsed variable goes where the source variable is drawn');
    ({ app } = await run(RESAMPLE_ALL_VARIABLES, { onScreen: ['src|b'] }));
    assert.equal(app.plotted[0].name, 'b', 'of all variables, the one already on screen is plotted');
    assert.deepEqual(app.plotted[0].options.alongside, { fileId: 'src', name: 'b' });
    ({ app } = await run('a', { plot: false }));
    assert.equal(app.plotted.length, 0, 'plain Create draws nothing');

    // Editing puts the pick back in the picker.
    const edit = new App();
    field('outlier-variable', '');
    edit._writeCollapseForm({ sourceName: 'b', params: { aggregate: 'max' } }, 'x');
    assert.equal(fields.get('outlier-variable').value, 'b');
    edit._writeCollapseForm({ sourceName: '', params: {} }, 'x');
    assert.equal(fields.get('outlier-variable').value, RESAMPLE_ALL_VARIABLES, 'an all-variables recipe shows "All"');
    delete globalThis.document;
}

console.log('Collapse-repeats checks passed.');
