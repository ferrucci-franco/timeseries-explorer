import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import PypsaNetcdfParser from '../src/parsers/pypsa-netcdf-parser.js';
import { installSessionMethods } from '../src/app/methods/session-methods.js';

const fixture = 'test-files/pypsa/vetea_example_01.nc';

if (!existsSync(fixture)) {
    console.warn(`Skipping PyPSA session test: fixture not found at ${fixture}`);
    process.exit(0);
}

class PlotHarness {
    constructor() {
        this.files = new Map();
        this.plots = new Map();
        this.activeFileId = null;
        this.syncAxes = true;
        this.syncHover = false;
        this.hoverInfoCorner = 'bl';
        this.hoverProximity = true;
        this.legendPosition = 'overlay';
        this.legendOverlayCorner = 'tl';
        this.mouseWheelZoom = true;
        this.timeseriesVisualMaxPoints = 2000;
        this.phaseVisualMaxPoints = 4000;
    }

    setSyncAxes(value) { this.syncAxes = !!value; }
    setSyncHover(value) { this.syncHover = !!value; }
    setHoverInfoCorner(value) { this.hoverInfoCorner = value; }
    setHoverProximity(value) { this.hoverProximity = !!value; }
    setLegendPosition(value) { this.legendPosition = value; }
    setLegendOverlayCorner(value) { this.legendOverlayCorner = value; }
    setMouseWheelZoom(value) { this.mouseWheelZoom = !!value; }
    setTimeseriesDownsamplingLimit(value) { this.timeseriesVisualMaxPoints = value; }
    setPhaseDownsamplingLimit(value) { this.phaseVisualMaxPoints = value; }
    setFileTransform(fileId, transform) { this.files.get(fileId).transform = transform; }
    _defaultLiveViewPolicy() { return {}; }
    _defaultCursors() { return { enabled: false }; }
    _capturePlotView() { return null; }
    _stopAnim() {}
    _rebuildPanel() {}
}

class LayoutHarness {
    constructor() {
        this.root = { type: 'grid', children: [{ id: 'panel-a' }, { id: 'panel-b' }] };
    }

    setScrollablePlotArea(value) { this.scrollablePlotArea = !!value; }
    _collectPanelIds(root) {
        const ids = [];
        const walk = node => {
            if (!node) return;
            if (node.id) ids.push(node.id);
            for (const child of node.children || []) walk(child);
        };
        walk(root);
        return ids;
    }
    render() {}
    reset() { this.root = { type: 'grid', children: [] }; }
}

class SessionHarness {
    constructor(data, fileId) {
        this.files = new Map();
        this.plotManager = new PlotHarness();
        this.layoutManager = new LayoutHarness();
        this.derivedByFile = new Map();
        this._expandedFileTransforms = new Set();
        this.selectedVariables = new Set();
        this.theme = 'light';
        this.language = 'en';
        this.showDescriptions = false;
        this.sortAlphabetical = true;
        this.reloadAsNewVersionMode = false;
        this.scrollablePlotArea = false;
        this.mouseWheelZoom = true;
        this.activeFileId = fileId;
        this.addFile(fileId, data);
    }

    addFile(fileId, data) {
        const transform = this._defaultFileTransform();
        this.files.set(fileId, {
            name: 'vetea_example_01',
            extension: '.nc',
            contentHash: 'fixture-hash',
            transform,
        });
        this.plotManager.files.set(fileId, {
            name: 'vetea_example_01',
            data,
            transform,
        });
        this.plotManager.activeFileId = fileId;
    }

    _defaultFileTransform() {
        return { timeDisplayMode: null, calendarTimeFormat: null, timeShift: 0, timeStepMode: null, customTimeStep: '', timeStepOriginMode: null, gain: 1, yOffset: 0, cropStart: null, cropEnd: null };
    }
    _normalizeFileTransform(transform = null) { return { ...this._defaultFileTransform(), ...(transform || {}) }; }
    _fileExtension(filename) { return String(filename || '').toLowerCase().match(/\.[^.]+$/)?.[0] || ''; }
    _fileDisplayName(entry) { return `${entry?.name || ''}${entry?.extension || '.mat'}`; }
    _fileBaseName(filename) { return String(filename || '').replace(/\.[^.]+$/, ''); }
    _clearVariableSelection() { this.selectedVariables.clear(); }
    _reapplyDerivedVariables() {}
    setLanguage(value) { this.language = value; }
    applyTheme(value) { this.theme = value; }
    _syncScrollablePlotAreaUI() {}
}

installSessionMethods(SessionHarness);

const bytes = readFileSync(fixture);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const data = await new PypsaNetcdfParser().parse(buffer, fixture);
const generatorId = 'pypsa:generators/PV1/p_max_pu';
const loadId = 'pypsa:loads/L1/p_set';

assert(data.variables[generatorId], 'generator series should exist before session capture');
assert(data.variables[loadId], 'load series should exist before session capture');

const source = new SessionHarness(data, 'f1');
source.plotManager.plots.set('panel-a', {
    mode: 'timeseries',
    traces: [{ fileId: 'f1', varName: generatorId, color: '#2196F3' }],
    phaseTraces: [],
    phasePending: { x: null, y: null, z: null, fileId: null },
    stateSlots: { x: [], dx: [], fileId: null },
    stateConfig: {},
});
source.plotManager.plots.set('panel-b', {
    mode: 'phase2d',
    traces: [],
    phaseTraces: [{ fileId: 'f1', x: generatorId, y: loadId, z: null, color: '#FF5722' }],
    phasePending: { x: null, y: null, z: null, fileId: null },
    stateSlots: { x: [], dx: [], fileId: null },
    stateConfig: {},
});

const snapshot = source._createSessionSnapshot({ includeData: false });
assert.equal(snapshot.files[0].extension, '.nc');
assert(snapshot.files[0].variableNames.includes(generatorId));
assert.equal(snapshot.plots[0].traces[0].varName, generatorId);
assert.equal(snapshot.plots[1].phaseTraces[0].x, generatorId);

const restored = new SessionHarness(data, 'f99');
restored.plotManager.plots.set('panel-a', {
    mode: 'timeseries',
    traces: [],
    phaseTraces: [],
    phasePending: { x: null, y: null, z: null, fileId: null },
    stateSlots: { x: [], dx: [], fileId: null },
    stateConfig: {},
});
restored.plotManager.plots.set('panel-b', {
    mode: 'timeseries',
    traces: [],
    phaseTraces: [],
    phasePending: { x: null, y: null, z: null, fileId: null },
    stateSlots: { x: [], dx: [], fileId: null },
    stateConfig: {},
});

const fileMap = restored._matchSessionFiles(snapshot);
assert.equal(fileMap.get('f1'), 'f99', 'session should match a reopened PyPSA file by hash/name/variables');
await restored._applySessionFileMetadata(snapshot, fileMap);
restored._applySessionLayout(snapshot.layout);
await restored._applySessionPlots(snapshot.plots, fileMap);

const restoredTimeseries = restored.plotManager.plots.get('panel-a');
assert.equal(restoredTimeseries.mode, 'timeseries');
assert.equal(restoredTimeseries.traces.length, 1);
assert.equal(restoredTimeseries.traces[0].fileId, 'f99');
assert.equal(restoredTimeseries.traces[0].varName, generatorId);

const restoredPhase = restored.plotManager.plots.get('panel-b');
assert.equal(restoredPhase.mode, 'phase2d');
assert.equal(restoredPhase.phaseTraces.length, 1);
assert.equal(restoredPhase.phaseTraces[0].fileId, 'f99');
assert.equal(restoredPhase.phaseTraces[0].x, generatorId);
assert.equal(restoredPhase.phaseTraces[0].y, loadId);

console.log('PyPSA session save/restore checks passed.');
