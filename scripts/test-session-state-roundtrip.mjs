import assert from 'node:assert/strict';
import { installSessionMethods } from '../src/app/methods/session-methods.js';
import Modal from '../src/ui/modal.js';

class StateHarness {
    constructor(fileId = 'f1') {
        this.files = new Map();
        this.plotManager = {
            files: new Map(),
            plots: new Map(),
            activeFileId: fileId,
            syncAxes: true,
            syncHover: false,
            hoverInfoCorner: 'bl',
            hoverProximity: true,
            legendPosition: 'overlay',
            legendOverlayCorner: 'tl',
            mouseWheelZoom: true,
            timeseriesVisualMaxPoints: 2000,
            phaseVisualMaxPoints: 4000,
            relayoutRefreshMode: 'auto',
            liveViewDefaults: {
                timeseries: { xMode: 'sliding', windowSeconds: 30, yMode: 'keep' },
                phase: { viewMode: 'autoscale' },
            },
            hasAnyTraces() { return [...this.plots.values()].some(plot => plot.traces?.length || plot.phaseTraces?.length); },
            setSyncAxes(value) { this.syncAxes = !!value; },
            setSyncHover(value) { this.syncHover = !!value; },
            setHoverInfoCorner(value) { this.hoverInfoCorner = value; },
            setHoverProximity(value) { this.hoverProximity = !!value; },
            setLegendPosition(value) { this.legendPosition = value; },
            setLegendOverlayCorner(value) { this.legendOverlayCorner = value; },
            setMouseWheelZoom(value) { this.mouseWheelZoom = !!value; },
            setTimeseriesDownsamplingLimit(value) { this.timeseriesVisualMaxPoints = value; },
            setPhaseDownsamplingLimit(value) { this.phaseVisualMaxPoints = value; },
            setRelayoutRefreshMode(value) { this.relayoutRefreshMode = value; },
            setFileTransform(id, transform) { this.files.get(id).transform = transform; },
            _capturePlotView() { return { xRange: [1, 2], yRange: [3, 4] }; },
            _defaultFftState() { return {}; },
            _defaultHistogramState() { return { binCount: 20, normalization: 'count' }; },
            _defaultCalendarHeatmapState() { return {}; },
            _defaultCorrelationState() { return {}; },
            _defaultPhase2dState() { return {}; },
            _defaultLiveViewPolicy() { return {}; },
            _defaultCursors() { return { enabled: false }; },
            _normalizeFftState(value) { return { ...value }; },
            _normalizeHistogramState(value) { return { ...this._defaultHistogramState(), ...value }; },
            _normalizeCalendarHeatmapState(value) { return { ...value }; },
            _normalizeCorrelationState(value) { return { ...value }; },
            _normalizePhase2dState(value) { return { ...value }; },
            _stopAnim() {},
            _rebuildPanel() {},
        };
        this.layoutManager = {
            root: { type: 'panel', id: 'panel-1' },
            onPanelUnmount: null,
            setScrollablePlotArea(value) { this.scrollablePlotArea = !!value; },
            _collectPanelIds() { return []; },
            render() {},
            reset() { this.root = { type: 'panel', id: 'panel-reset' }; },
        };
        this.derivedByFile = new Map();
        this.dataToolVariablesByFile = new Map();
        this._expandedFileTransforms = new Set();
        this.selectedVariables = new Set();
        this.theme = 'dark';
        this.language = 'es';
        this.showDescriptions = true;
        this.sortAlphabetical = false;
        this.reloadAsNewVersionMode = true;
        this.scrollablePlotArea = true;
        this.mouseWheelZoom = false;
        this.advancedSettings = { panZoomRefreshMode: 'responsive', matlabFullLoadMb: 777 };
        this._filterText = 'temperature';
        this.activeFileId = fileId;
        this._nextId = 100;
        this.addFile(fileId);
    }

    addFile(fileId, name = 'results') {
        const transform = { gain: 1, yOffset: 0 };
        const data = { variables: { base: {}, x: {}, y: {}, z: {}, dx: {} }, tree: {} };
        this.files.set(fileId, { name, extension: '.mat', buffer: new ArrayBuffer(1), contentHash: `${name}-hash`, transform });
        this.plotManager.files.set(fileId, { name, data, transform, invertedVariables: new Set(), _transformCache: null });
        this.plotManager.activeFileId = fileId;
    }

    _fileDisplayName(entry) { return `${entry.name}${entry.extension}`; }
    _fileExtension(name) { return String(name).match(/\.[^.]+$/)?.[0]?.toLowerCase() || ''; }
    _fileBaseName(name) { return String(name).replace(/\.[^.]+$/, ''); }
    _normalizeFileTransform(value) { return { gain: 1, yOffset: 0, ...(value || {}) }; }
    _normalizeAdvancedSettings(value) { return { ...value }; }
    _saveAdvancedSettings(value) { this.advancedSettings = { ...value }; }
    _clearVariableSelection() { this.selectedVariables.clear(); }
    _clearDataToolDefinitions() { this.dataToolVariablesByFile.clear(); }
    _syncScrollablePlotAreaUI() {}
    _syncHoverCornerPicker() {}
    _syncLegendCornerPicker() {}
    _applyReloadModeUI() {}
    _updateTopBar() {}
    _renderFilesList() {}
    _updateActionButtons() {}
    renderVariablesTree() {}
    _resetDataToolPicker() {}
    setActiveFile(fileId) { this.activeFileId = fileId; this.plotManager.activeFileId = fileId; }
    setLanguage(value) { this.language = value; }
    applyTheme(value) { this.theme = value; }
}

installSessionMethods(StateHarness);

const source = new StateHarness('f1');
source._expandedFileTransforms.add('f1');
source.plotManager.files.get('f1').invertedVariables = new Set(['x']);
source.plotManager.plots.set('panel-1', {
    mode: 'histogram',
    traces: [{ fileId: 'f1', varName: 'x', axis: 'y' }],
    phaseTraces: [],
    phasePending: { x: 'x', y: 'y', z: null, fileId: 'f1' },
    stateSlots: { x: ['x'], dx: ['dx'], fileId: 'f1' },
    stateAnimDim: 2,
    stateConfig: {},
    fft: {},
    histogram: { binCount: 77, normalization: 'percent', layout: 'horizontal' },
    heatmap: {},
    correlation: {},
    phase2d: {},
    liveView: {},
    cursors: {},
    cursorsSpectrum: {},
    timeseriesStacked: false,
    timeseriesY2Enabled: false,
    showMissingData: true,
    animPlaying: true,
    _modeViews: { fft: { mode: '2d', xRange: [10, 20], fftSpectrum: { xRange: [1, 5] } } },
});

const snapshot = source._createSessionSnapshot({ includeData: false });
assert.equal(snapshot.settings.advancedSettings.panZoomRefreshMode, 'responsive');
assert.equal(snapshot.settings.variableFilterText, 'temperature');
assert.equal(snapshot.files[0].transformPanelExpanded, true);
assert.equal(snapshot.plots[0].histogram.binCount, 77);
assert.equal(snapshot.plots[0].showMissingData, true);
assert.equal(snapshot.plots[0].animPlaying, true);
assert.deepEqual(snapshot.plots[0].modeViews.fft.xRange, [10, 20]);

const restored = new StateHarness('f99');
restored.plotManager.plots.set('panel-1', {
    mode: 'timeseries', traces: [], phaseTraces: [], phasePending: {}, stateSlots: {}, stateConfig: {},
    histogram: {}, fft: {}, heatmap: {}, correlation: {}, phase2d: {},
});
const fileMap = new Map([['f1', 'f99']]);
restored._applySessionSettings(snapshot.settings);
await restored._applySessionFileMetadata(snapshot, fileMap);
await restored._applySessionPlots(snapshot.plots, fileMap);
const restoredPlot = restored.plotManager.plots.get('panel-1');
assert.equal(restoredPlot.histogram.binCount, 77);
assert.equal(restoredPlot.histogram.normalization, 'percent');
assert.equal(restoredPlot.showMissingData, true);
assert.equal(restoredPlot.autoPlayOnRender, true);
assert.deepEqual(restoredPlot._modeViews.fft.fftSpectrum.xRange, [1, 5]);
assert.deepEqual(restoredPlot.phasePending, { x: 'x', y: 'y', z: null, fileId: 'f99' });
assert.deepEqual(restoredPlot.stateSlots, { x: ['x'], dx: ['dx'], fileId: 'f99' });
assert.equal(restored.mouseWheelZoom, false);
assert.equal(restored.plotManager.mouseWheelZoom, false);
assert.equal(restored.plotManager.relayoutRefreshMode, 'responsive');
assert.deepEqual(restored.plotManager.liveViewDefaults.phase, { viewMode: 'autoscale' });
assert.equal(restored._expandedFileTransforms.has('f99'), true);

// A complete project must restore a custom CSV profile from the archived File
// directly. Chromium must never ask the user to locate the original source.
const archivedCsv = new StateHarness('csv-new');
const csvEntry = archivedCsv.files.get('csv-new');
csvEntry.name = 'archived';
csvEntry.extension = '.csv';
csvEntry.file = new File(['time,value\n0,1\n'], 'archived.csv');
csvEntry.buffer = null;
archivedCsv._canParseFromFile = () => true;
archivedCsv._readLatestFileForStreamableReload = async () => { throw new Error('must not reselect an archived project file'); };
archivedCsv._fileFingerprint = () => 'archive-fingerprint';
archivedCsv._parseCsvResultBuffer = async (_name, _buffer, file, options) => ({
    variables: { base: {} },
    tree: {},
    metadata: { csvProfile: options.csvProfile, restoredFile: file.name },
});
archivedCsv.plotManager.updateFileData = (fileId, data) => { archivedCsv.plotManager.files.get(fileId).data = data; };
await archivedCsv._applySessionFileMetadata({ files: [{
    id: 'csv-old',
    transform: {},
    csvProfile: { profileSource: 'user', delimiter: ';' },
}] }, new Map([['csv-old', 'csv-new']]), { projectData: true });
assert.equal(archivedCsv.plotManager.files.get('csv-new').data.metadata.restoredFile, 'archived.csv');

// Cross-dependency orchestration: a data-tool output feeds a derived variable,
// then inversions are restored only after both generated variables exist.
const generatedSession = {
    files: [{
        id: 'f1',
        derived: [{ name: 'derivedFromTool', formula: 'toolOutput' }],
        dataTools: [{ name: 'toolOutput', sourceName: 'base', targetMode: 'create', tool: 'removeOutliers' }],
        invertedVariables: ['toolOutput', 'derivedFromTool'],
    }],
};
restored._reapplyDerivedVariable = (_fileId, data, name, entry) => {
    if (!data.variables.toolOutput) return false;
    data.variables[name] = { generatedFrom: entry.formula };
    return true;
};
restored._derivedFormulaReferences = () => ['toolOutput'];
restored._reapplyDataToolDefinition = (_fileId, data, name, definition) => {
    if (!data.variables[definition.sourceName]) return false;
    data.variables[name] = { generatedFrom: definition.sourceName };
    return true;
};
restored._applySessionDerivedVariables(generatedSession, fileMap, { defer: true });
restored._applySessionDataToolVariables(generatedSession, fileMap, { defer: true });
restored._reapplySessionGeneratedVariables(generatedSession, fileMap);
restored._applySessionInvertedVariables(generatedSession, fileMap);
assert(restored.plotManager.files.get('f99').data.variables.toolOutput);
assert(restored.plotManager.files.get('f99').data.variables.derivedFromTool);
assert.deepEqual([...restored.plotManager.files.get('f99').invertedVariables].sort(), ['derivedFromTool', 'toolOutput']);

// A staged project load failure leaves the original file map and active file intact.
const originalConfirm = Modal.confirm;
Modal.confirm = async () => true;
try {
    const transactional = new StateHarness('old');
    transactional.loadFile = async file => {
        if (file.name.includes('bad')) throw new Error('parse failed');
        const id = `staged-${transactional._nextId++}`;
        transactional.addFile(id, file.name.replace(/\.[^.]+$/, ''));
        return { fileId: id, data: transactional.plotManager.files.get(id).data };
    };
    const projectSession = {
        ...snapshot,
        files: [
            { ...snapshot.files[0], id: 'p1', displayName: 'good.mat', archivePath: 'data/good.mat' },
            { ...snapshot.files[0], id: 'p2', displayName: 'bad.mat', archivePath: 'data/bad.mat' },
        ],
    };
    await assert.rejects(
        () => transactional._loadProjectDataFromZip(projectSession, {
            'data/good.mat': new Uint8Array([1]),
            'data/bad.mat': new Uint8Array([2]),
        }),
        /parse failed/,
    );
    assert.deepEqual([...transactional.files.keys()], ['old']);
    assert.deepEqual([...transactional.plotManager.files.keys()], ['old']);
    assert.equal(transactional.plotManager.activeFileId, 'old');

    const rollbackHarness = new StateHarness('old');
    rollbackHarness.loadFile = async file => {
        const id = `staged-${rollbackHarness._nextId++}`;
        rollbackHarness.addFile(id, file.name.replace(/\.[^.]+$/, ''));
        return { fileId: id, data: rollbackHarness.plotManager.files.get(id).data };
    };
    const successfulProject = {
        ...snapshot,
        files: [{ ...snapshot.files[0], id: 'p1', displayName: 'good.mat', archivePath: 'data/good.mat' }],
        plots: [],
    };
    const transaction = await rollbackHarness._loadProjectDataFromZip(successfulProject, {
        'data/good.mat': new Uint8Array([1]),
    });
    assert.equal(transaction.fileMap.get('p1').startsWith('staged-'), true);
    assert.deepEqual([...rollbackHarness.files.keys()], [transaction.fileMap.get('p1')]);
    await rollbackHarness._rollbackProjectTransaction(transaction);
    assert.deepEqual([...rollbackHarness.files.keys()], ['old']);
    assert.deepEqual([...rollbackHarness.plotManager.files.keys()], ['old']);
    assert.equal(rollbackHarness.plotManager.activeFileId, 'old');
} finally {
    Modal.confirm = originalConfirm;
}

console.log('Session state round-trip and transactional loading checks passed.');
