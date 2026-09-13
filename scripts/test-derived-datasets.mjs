// Derived datasets: a resample is a file that carries its recipe.
//
// What is checked here is the recipe's whole life: it is stored on commit, it
// recomputes the dataset from the source's current data (and datasets built
// from THAT dataset, in turn), it reopens the tool for editing and an Update
// rewrites the same file, it travels through a session as a recipe rather
// than as rows and comes back mapped so panels find their traces, and the
// dataset closes with its source.
import assert from 'node:assert/strict';
import Modal from '../src/ui/modal.js';
import { installDataToolsMethods, RESAMPLE_ALL_VARIABLES } from '../src/app/methods/data-tools-methods.js';
import { installResampleMethods } from '../src/app/methods/resample-methods.js';
import { installFilterMethods } from '../src/app/methods/filter-methods.js';
import { installDerivedDatasetMethods } from '../src/app/methods/derived-dataset-methods.js';
import { installSessionMethods } from '../src/app/methods/session-methods.js';

const confirms = [];
let confirmAnswer = true;
Modal.confirm = async (message) => { confirms.push(message); return confirmAnswer; };
const alerts = [];
Modal.alert = async (title, body) => { alerts.push({ title, body }); };

// The smallest document these methods can run against.
function fakeDocument(values = {}) {
    const elements = new Map();
    const make = (id) => {
        const classes = new Set();
        const element = {
            id,
            value: values[id] ?? '',
            defaultValue: values[id] ?? '',
            textContent: '',
            hidden: false,
            disabled: false,
            options: [],
            dataset: {},
            classList: {
                toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name),
            },
            setAttribute: () => {},
            removeAttribute: () => {},
            getAttribute: () => null,
            toggleAttribute: (_name, on) => { element.disabled = !!on; },
            querySelector: () => null,
            scrollIntoView: () => {},
            appendChild: () => {},
            addEventListener: () => {},
        };
        Object.defineProperty(element, 'innerHTML', { set() {}, get() { return ''; } });
        return element;
    };
    return {
        elements,
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, make(id));
            return elements.get(id);
        },
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: () => make(`el${elements.size}`),
    };
}

class Harness {
    constructor() {
        this.files = new Map();
        this._nextFileId = 1;
        this.plotManager = {
            files: new Map(),
            plots: new Map(),
            activeFileId: null,
            updates: [],
            removed: [],
            addFile(id, name, data, transform) {
                this.files.set(id, { name, data, transform, invertedVariables: new Set() });
                this.activeFileId = id;
            },
            updateFileData(id, data) { this.files.get(id).data = data; this.updates.push(id); },
            setActiveFile(id) { if (this.files.has(id)) this.activeFileId = id; },
            removeFile(id, options = {}) {
                this.removed.push([id, options]);
                for (const plot of this.plots.values()) plot.traces = plot.traces.filter(t => t.fileId !== id);
                this.files.delete(id);
                if (this.activeFileId === id) this.activeFileId = [...this.files.keys()][0] || null;
            },
            setFileTransform() {},
            hasTracesForFile(id) { return [...this.plots.values()].some(p => p.traces.some(t => t.fileId === id)); },
            _capturePlotView() { return {}; },
            withActiveFile(id, fn) { const previous = this.activeFileId; this.activeFileId = id; try { return fn(); } finally { this.activeFileId = previous; } },
        };
        this.parser = {
            _detectDataType: () => 'real',
            _isConstantValues: () => false,
            _buildTree: variables => ({ _type: 'root', _children: {}, _variables: { ...variables } }),
        };
        this.derivedByFile = new Map();
        this.dataToolVariablesByFile = new Map();
        this._expandedFileTransforms = new Set();
        this.selectedVariables = new Set();
        this.layoutManager = { root: { type: 'panel', id: 'p1' } };
        this.theme = 'light';
        this.language = 'en';
        this.advancedSettings = {};
        this.rendered = { list: 0, tree: 0, table: 0 };
    }
    get activeFileId() { return this.plotManager.activeFileId; }
    _defaultFileTransform() { return {}; }
    _normalizeFileTransform(t) { return { ...(t || {}) }; }
    _cloneSerializable(v) { return JSON.parse(JSON.stringify(v)); }
    _fileDisplayName(e) { return `${e.name}${e.extension || ''}`; }
    _renderFilesList() { this.rendered.list++; }
    renderVariablesTree() { this.rendered.tree++; }
    _renderDataToolTable() { this.rendered.table++; }
    _updateTopBar() {}
    _updateActionButtons() {}
    _clearVariableSelection() { this.selectedVariables.clear(); }
    _clearDataToolDefinitions(id) { this.dataToolVariablesByFile.delete(id); }
    _isDataToolLazyData() { return false; }
    _isDataToolVariablePlotted() { return false; }
    _isFileTransformActive() { return false; }
    setActiveFile(id) { this.plotManager.setActiveFile(id); }
    _releaseQueryEngineIfIdle() {}
    // The app's removeFile, reduced to what the cascade needs.
    async removeFile(fileId, options = {}) {
        if (!this.files.has(fileId)) return;
        let confirmed = !!options.cascade || !!options.confirmed;
        let cascaded = false;
        if (!options.cascade && this._derivedDatasetsUnder(fileId).length) {
            if (!(await this._confirmClosingDerivedDatasets(fileId))) return;
            await this._closeDerivedDatasetsUnder(fileId);
            confirmed = true;
            cascaded = true;
        }
        if (!confirmed && this.plotManager.hasTracesForFile(fileId)) {
            if (!(await Modal.confirm('closeFileWarning'))) return;
        }
        if (this._datasetEditing?.fileId === fileId) this._exitDerivedDatasetEditing();
        this.plotManager.removeFile(fileId, { deferRebuild: !!options.cascade, rebuildAll: cascaded });
        this.files.delete(fileId);
    }
}
installDataToolsMethods(Harness);
installResampleMethods(Harness);
installFilterMethods(Harness);
installDerivedDatasetMethods(Harness);
installSessionMethods(Harness);

// Async-aware: a method that awaits a worker (the resample) must still find
// the document when it comes back to update the panel.
const withDocument = (mockDocument, fn) => {
    const previous = globalThis.document;
    globalThis.document = mockDocument;
    const restore = () => {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    };
    let result;
    try {
        result = fn();
    } catch (err) {
        restore();
        throw err;
    }
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
};

const makeSource = (harness, { amplitude = 1, count = 101, step = 0.01 } = {}) => {
    const time = Float64Array.from({ length: count }, (_, i) => i * step);
    const data = {
        metadata: { timeName: 'time', timeKind: 'numeric', numTimesteps: count },
        variables: {
            time: { name: 'time', data: time, kind: 'abscissa', description: '[s]' },
            x: { name: 'x', data: Float64Array.from(time, t => amplitude * Math.sin(t * 20)), kind: 'variable', description: '[V]' },
            y: { name: 'y', data: Float64Array.from(time, t => t), kind: 'variable', description: '' },
        },
        tree: {},
    };
    const fileId = `f${harness._nextFileId++}`;
    harness.files.set(fileId, { name: 'run', extension: '.csv', transform: {}, buffer: new ArrayBuffer(1) });
    harness.plotManager.addFile(fileId, 'run', data, {});
    return { fileId, data };
};

const recipeFor = (sourceFileId, step, sourceName = '') => ({
    tool: 'resample', sourceFileId, sourceName, params: { gridMode: 'step', method: 'linear', step, gapPolicy: 'nan' },
});

// ── Compute and register ──────────────────────────────────────────────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h);
    const recipe = recipeFor(fileId, 0.05);
    const computed = await h._computeResampleDataset(fileId, data, recipe);
    assert.equal(computed.data.metadata.numTimesteps, 21, '1 s at 0.05 s is 21 samples');
    assert.deepEqual(computed.names, ['x', 'y'], 'every variable rides along by default');

    const registered = h._registerDerivedDataset(recipe, 'run 20Hz', computed.data);
    assert.equal(registered.replaced, false);
    const entry = h.files.get(registered.fileId);
    assert.ok(h._isDerivedDataset(entry), 'the file entry is a derived dataset');
    assert.deepEqual(h._derivedDatasetRecipe(entry), recipe, 'the recipe is stored as given');
    assert.notEqual(h._derivedDatasetRecipe(entry).params, recipe.params, 'the params are a copy, not the caller’s object');
    assert.equal(entry.resampledFrom, fileId, 'the older marker is kept for code that reads it');
    assert.equal(typeof entry.syntheticBytes, 'function', 'a project save can still write it out');
    assert.equal(h.activeFileId, fileId, 'the SOURCE stays the active file: that is where the dataset is listed');
    assert.deepEqual(h._derivedDatasetsOf(fileId).map(([id]) => id), [registered.fileId]);
    assert.equal(h._derivedDatasetDescription(recipe), 'linear, step 0.05, gaps: nan');

    // Same name under the same source ⇒ rewritten in place, not duplicated.
    const again = h._registerDerivedDataset(recipeFor(fileId, 0.1), 'run 20Hz', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.1))).data);
    assert.equal(again.replaced, true);
    assert.equal(again.fileId, registered.fileId);
    assert.equal(h.files.size, 2, 'still one source and one dataset');
    assert.equal(h._derivedDatasetRecipe(again.fileId).params.step, 0.1, 'the recipe follows the rewrite');
    assert.equal(h.plotManager.files.get(again.fileId).data.metadata.numTimesteps, 11);
}

// ── Recompute follows the source, through a chain ─────────────────────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h, { amplitude: 1 });
    const first = h._registerDerivedDataset(recipeFor(fileId, 0.05), 'a', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.05))).data);
    // A dataset built from the dataset.
    const childRecipe = recipeFor(first.fileId, 0.1);
    const child = h._registerDerivedDataset(childRecipe, 'b', (await h._computeResampleDataset(first.fileId, h.plotManager.files.get(first.fileId).data, childRecipe)).data);
    assert.deepEqual(h._derivedDatasetsUnder(fileId).map(([id]) => id), [first.fileId, child.fileId], 'the chain is walked source-first');

    const peak = id => Math.max(...h.plotManager.files.get(id).data.variables.x.data);
    assert.ok(Math.abs(peak(first.fileId) - 1) < 0.05);
    data.variables.x.data = Float64Array.from(data.variables.time.data, t => 3 * Math.sin(t * 20));
    h.plotManager.updates.length = 0;
    h.rendered.tree = 0;
    await withDocument(fakeDocument({}), () => h._recomputeDerivedDatasetsOf(fileId));
    assert.ok(Math.abs(peak(first.fileId) - 3) < 0.15, `the dataset follows its source (peak ${peak(first.fileId)})`);
    assert.ok(Math.abs(peak(child.fileId) - 3) < 0.3, `and so does the dataset built from it (peak ${peak(child.fileId)})`);
    assert.deepEqual(h.plotManager.updates, [first.fileId, child.fileId], 'each dataset is replaced in place, once, in order');
    assert.equal(h.rendered.tree, 1, 'the tree is redrawn once, after the whole chain');
}

// ── Editing: the form reopens with the recipe, Update rewrites the same file ──

{
    const h = new Harness();
    const { fileId, data } = makeSource(h);
    const recipe = recipeFor(fileId, 0.05, 'x');
    const made = h._registerDerivedDataset(recipe, 'x only', (await h._computeResampleDataset(fileId, data, recipe)).data);
    const dom = fakeDocument({ 'data-tool-select': '', 'resample-grid-mode': 'step', 'resample-method': 'linear' });
    withDocument(dom, () => {
        h._editDerivedDataset(made.fileId);
        assert.deepEqual(h._datasetEditing, { fileId: made.fileId, name: 'x only' });
        assert.equal(dom.getElementById('data-tool-select').value, 'resample');
        assert.equal(dom.getElementById('outlier-output-name').value, 'x only');
        assert.equal(dom.getElementById('outlier-variable').value, 'x');
        assert.equal(dom.getElementById('resample-step').value, '0.05');
        assert.equal(dom.getElementById('resample-gap-policy').value, 'nan');
    });
    // Whole-file recipes reopen on the "every variable" entry.
    const whole = h._registerDerivedDataset(recipeFor(fileId, 0.05), 'all', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.05))).data);
    withDocument(fakeDocument({}), () => {
        h._editDerivedDataset(whole.fileId);
        assert.equal(document.getElementById('outlier-variable').value, RESAMPLE_ALL_VARIABLES);
    });
    // Committing while editing rewrites the edited dataset even under a new name.
    const commitDom = fakeDocument({
        'data-tool-select': 'resample', 'outlier-variable': 'x', 'outlier-output-name': 'x renamed',
        'resample-grid-mode': 'step', 'resample-method': 'linear', 'resample-step': '0.2', 'resample-gap-policy': 'nan',
    });
    h._datasetEditing = { fileId: made.fileId, name: 'x only' };
    const result = await withDocument(commitDom, () => h.commitResampleTool());
    assert.equal(result.fileId, made.fileId, 'the same file was rewritten');
    assert.equal(h.files.get(made.fileId).name, 'x renamed', 'under its new name');
    assert.equal(h._derivedDatasetRecipe(made.fileId).params.step, 0.2, 'with the new recipe');
    assert.equal(h._datasetEditing, null, 'editing ends with the commit');
    assert.equal(h.files.size, 3, 'no extra file was made');
    // Clearing the draft abandons an edit.
    h._datasetEditing = { fileId: made.fileId, name: 'x renamed' };
    withDocument(fakeDocument({}), () => h._clearDataToolDraft());
    assert.equal(h._datasetEditing, null);
}

// ── Sessions: a recipe under the source, mapped back on restore ───────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h);
    const made = h._registerDerivedDataset(recipeFor(fileId, 0.05), 'run 20Hz', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.05))).data);
    const childRecipe = recipeFor(made.fileId, 0.1, 'x');
    const child = h._registerDerivedDataset(childRecipe, 'coarser', (await h._computeResampleDataset(made.fileId, h.plotManager.files.get(made.fileId).data, childRecipe)).data);
    h._expandedFileTransforms.add(child.fileId);
    h.plotManager.files.get(made.fileId).invertedVariables = new Set(['x']);

    const snapshot = h._createSessionSnapshot({ includeData: true });
    assert.deepEqual(snapshot.files.map(f => f.id), [fileId], 'datasets are not files of the session');
    assert.equal(snapshot.files[0].archivePath.startsWith('data/'), true, 'the source still gets its bytes in a project');
    const [record] = snapshot.files[0].derivedDatasets;
    assert.equal(record.id, made.fileId);
    assert.equal(record.name, 'run 20Hz');
    assert.equal(record.tool, 'resample');
    assert.equal(record.params.step, 0.05);
    assert.deepEqual(record.invertedVariables, ['x']);
    assert.equal(record.derivedDatasets.length, 1, 'the chain nests');
    assert.equal(record.derivedDatasets[0].name, 'coarser');
    assert.equal(record.derivedDatasets[0].transformPanelExpanded, true);
    assert.equal(JSON.stringify(snapshot).includes('"data":'), false, 'no rows in the session');

    // Restore into a fresh app where the source got a new id.
    const g = new Harness();
    const restored = makeSource(g);
    g._nextFileId = 50;
    const fileMap = new Map([[fileId, restored.fileId]]);
    await g._applySessionDerivedDatasets(snapshot, fileMap);
    assert.equal(fileMap.get(made.fileId), 'f50', 'the dataset id is mapped for the plots');
    assert.equal(fileMap.get(child.fileId), 'f51');
    assert.equal(g.files.get('f50').name, 'run 20Hz');
    assert.equal(g._derivedDatasetRecipe('f50').sourceFileId, restored.fileId, 'the recipe points at the restored source');
    assert.equal(g._derivedDatasetRecipe('f51').sourceFileId, 'f50');
    assert.equal(g.plotManager.files.get('f50').data.metadata.numTimesteps, 21);
    assert.deepEqual([...g.plotManager.files.get('f50').invertedVariables], ['x']);
    assert.equal(g._expandedFileTransforms.has('f51'), true);
    assert.equal(g.activeFileId, restored.fileId, 'restoring does not steal the active file');

    // Restoring over an app that already holds datasets for the matched file
    // replaces them: the session brings its own recipes.
    g._clearGeneratedVariablesForSession(new Map([[fileId, restored.fileId]]));
    assert.deepEqual([...g.files.keys()], [restored.fileId], 'the old datasets are gone before the recipes are applied');
    assert.deepEqual(g.plotManager.removed.map(([id]) => id), ['f51', 'f50'], 'deepest first');
}

// ── Closing the source closes the datasets, after one question ────────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h);
    const made = h._registerDerivedDataset(recipeFor(fileId, 0.05), 'run 20Hz', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.05))).data);
    h.plotManager.plots.set('p1', { mode: 'timeseries', traces: [{ fileId: made.fileId, varName: 'x' }] });
    confirms.length = 0;
    confirmAnswer = false;
    await h.removeFile(fileId);
    assert.equal(confirms.length, 1, 'one question');
    assert.match(confirms[0], /run 20Hz\.csv/, 'naming the dataset');
    assert.equal(h.files.size, 2, 'declining keeps both');

    confirmAnswer = true;
    confirms.length = 0;
    await h.removeFile(fileId);
    assert.equal(confirms.length, 1, 'the dataset question also covers the plots: no second dialog');
    assert.equal(h.files.size, 0, 'both are gone');
    assert.deepEqual(h.plotManager.removed.map(([id, o]) => [id, !!o.deferRebuild, !!o.rebuildAll]),
        [[made.fileId, true, false], [fileId, false, true]],
        'the cascade defers its rebuilds to the close that started it');

    // Closing the dataset alone asks nothing beyond the ordinary plot question.
    const { fileId: src2, data: data2 } = makeSource(h);
    const ds2 = h._registerDerivedDataset(recipeFor(src2, 0.05), 'd', (await h._computeResampleDataset(src2, data2, recipeFor(src2, 0.05))).data);
    confirms.length = 0;
    assert.equal(await h._removeDerivedDataset(ds2.fileId), true);
    assert.equal(confirms.length, 0);
    assert.equal(h.files.size, 1, 'the source stays');
}

// ── A recipe whose source is gone is left alone ───────────────────────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h);
    const made = h._registerDerivedDataset(recipeFor(fileId, 0.05), 'orphan', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.05))).data);
    h.files.delete(fileId);
    h.plotManager.files.delete(fileId);
    assert.equal(await h._recomputeDerivedDataset(made.fileId), false, 'nothing to recompute from');
    const snapshot = h._createSessionSnapshot({ includeData: false });
    assert.deepEqual(snapshot.files.map(f => f.id), [made.fileId], 'an orphan is saved as the plain file it now is');
}

// ── "Create and plot": an empty panel, or a new one ───────────────────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h);
    const made = h._registerDerivedDataset(recipeFor(fileId, 0.05), 'ds', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.05))).data);
    // A layout with two panels, both drawing something.
    const panels = ['p1', 'p2'];
    h.layoutManager = {
        root: { type: 'split', children: panels.map(id => ({ type: 'panel', id })) },
        _collectPanelIds() { return [...panels]; },
        splitPanel(anchor, direction) { this.split = { anchor, direction }; panels.push('p3'); },
    };
    for (const id of panels) h.plotManager.plots.set(id, { mode: 'timeseries', traces: [{ fileId, varName: 'x' }] });
    const added = [];
    h.plotManager.addTrace = (panelId, name) => { added.push([panelId, name, h.plotManager.activeFileId]); };
    h.plotManager._rebuildAllPanels = () => { h.plotManager.rebuilt = (h.plotManager.rebuilt || 0) + 1; };
    const dom = fakeDocument({});
    dom.querySelector = selector => (selector.includes('data-id="p3"') ? { dataset: { id: 'p3' } } : null);
    withDocument(dom, () => h._plotDerivedDatasetVariable(made.fileId, 'x'));
    assert.deepEqual(h.layoutManager.split, { anchor: 'p2', direction: 'h' }, 'no empty panel: the last one is split below');
    assert.deepEqual(added, [['p3', 'x', made.fileId]], 'the trace lands on the new panel, with the dataset active for the call');
    assert.equal(h.activeFileId, fileId, 'and the source is active again afterwards');
    assert.equal(h.plotManager.rebuilt || 0, 0, 'the split’s own render redraws; no extra rebuild');

    // With an empty time-series panel nothing is split, and the rebuild the
    // registration deferred runs here instead.
    h.plotManager.plots.get('p2').traces = [];
    h.layoutManager.split = null;
    added.length = 0;
    dom.querySelector = selector => (selector.includes('data-id="p2"') ? { dataset: { id: 'p2' } } : null);
    withDocument(dom, () => h._plotDerivedDatasetVariable(made.fileId, 'x'));
    assert.equal(h.layoutManager.split, null, 'an empty panel is used as is');
    assert.deepEqual(added, [['p2', 'x', made.fileId]]);
    assert.equal(h.plotManager.rebuilt, 1, 'the deferred rebuild ran');
}

// ── The read-only values view and the CSV header ──────────────────────────

{
    const h = new Harness();
    const { fileId, data } = makeSource(h, { count: 401 });
    const made = h._registerDerivedDataset(recipeFor(fileId, 0.01), 'ds', (await h._computeResampleDataset(fileId, data, recipeFor(fileId, 0.01))).data);
    const table = h._datasetValuesTable(made.fileId);
    assert.deepEqual(table.headers, ['time [s]', 'x [V]', 'y'], 'units ride on the headers where known');
    assert.equal(table.total, 401);
    assert.equal(table.shown, 200, 'the view is capped');
    assert.equal(table.rows.length, 200);
    assert.equal(table.rows[0][0], '0');
    assert.equal(table.rows[1][0], '0.01');
    assert.deepEqual(table.parameters, [], 'a resample of a file without parameters has none');
    // The CSV the save button writes carries the same headers.
    const csv = new TextDecoder().decode(h.files.get(made.fileId).syntheticBytes());
    assert.equal(csv.split('\n')[0], 'time [s],x [V],y');
}

// ── The busy state around a commit ────────────────────────────────────────

{
    const h = new Harness();
    h._setOutlierMessage = function(message, type) { this._dataToolMessage = { message, type }; };
    h._syncDataTools = function() { this.synced = (this.synced || 0) + 1; };
    const dom = fakeDocument({ 'data-tool-select': 'resample' });
    withDocument(dom, () => {
        const stop = h._beginDataToolBusy();
        assert.equal(h._dataToolBusy, true);
        assert.equal(dom.getElementById('data-tool-create').disabled, true, 'the buttons go dead at once');
        assert.equal(dom.getElementById('data-tool-create-plot').disabled, true);
        assert.equal(dom.getElementById('data-tool-clear').disabled, true);
        assert.equal(h._dataToolMessage, undefined, 'nothing is said yet: a fast tool never flashes "computing"');
        h._dataToolMessage = { message: 'computing', type: 'busy' };
        stop();
        assert.equal(h._dataToolBusy, false);
        assert.equal(h._dataToolMessage.message, '', 'a line still saying "computing" is taken down');
        assert.equal(h.synced, 1, 'the panel is re-synced, which re-enables the buttons');
        // A verdict the commit wrote is left alone.
        const again = h._beginDataToolBusy();
        h._dataToolMessage = { message: 'Created', type: 'ok' };
        again();
        assert.equal(h._dataToolMessage.message, 'Created');
    });
}

console.log('derived dataset tests passed');
