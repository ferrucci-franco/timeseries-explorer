// Cross-correlation: the kernel and the panel.
//
// The kernel is held to the MATLAB convention on a delayed copy (a peak at the
// NEGATIVE lag when y is the delayed one), to the four normalisations by their
// definitions, to pairwise-finite handling of holes, and to the FFT route
// agreeing with the direct one to rounding. The panel is held to the axis rule
// (a lag is a time only on a uniform Δt), to the dataset it produces (a lag
// axis in the file's unit, the peak as parameters), and to the recipe round
// trip through the derived-dataset machinery.
import assert from 'node:assert/strict';
import {
    XCORR_DIRECT_LIMIT,
    computeCrossCorrelation,
    normalizeXcorrParams,
} from '../src/compute/kernels/xcorr.js';
import { runCrossCorrelation } from '../src/compute/kernels/index.js';
import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';
import { installResampleMethods } from '../src/app/methods/resample-methods.js';
import { installFilterMethods } from '../src/app/methods/filter-methods.js';
import { installDerivedDatasetMethods } from '../src/app/methods/derived-dataset-methods.js';
import { installXcorrMethods } from '../src/app/methods/xcorr-methods.js';

const near = (actual, expected, tol, label) => {
    assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ± ${tol}, got ${actual}`);
};

// ── The kernel ────────────────────────────────────────────────────────────

const n = 400;
const signal = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.2) + 0.1 * Math.cos(i * 1.3));

{
    // y is x delayed by d samples: y[n] = x[n − d]. r_xy[k] = Σ x[n+k]·y[n] peaks
    // where n + k = n − d, i.e. at k = −d. A NEGATIVE lag says y is the delayed one.
    const d = 7;
    const delayed = Float64Array.from({ length: n }, (_, i) => (i >= d ? signal[i - d] : 0));
    const r = computeCrossCorrelation(signal, delayed, { maxLag: 20, normalization: 'coeff', removeMean: false });
    assert.equal(r.peakLag, -d, 'MATLAB convention: the delayed second signal peaks at a negative lag');
    assert.ok(r.peakValue > 0.98, `near-perfect match at the peak (${r.peakValue})`);
    assert.equal(r.route, 'direct');
    assert.equal(r.lags.length, 41);
    assert.equal(r.lags[0], -20);
    assert.equal(r.lags[40], 20);
    // And the other way round: x delayed ⇒ positive lag.
    const flipped = computeCrossCorrelation(delayed, signal, { maxLag: 20, normalization: 'coeff', removeMean: false });
    assert.equal(flipped.peakLag, d, 'the delayed FIRST signal peaks at a positive lag');
}

{
    const auto = computeCrossCorrelation(signal, signal, { maxLag: 10, normalization: 'coeff' });
    near(auto.zeroLagValue, 1, 1e-12, 'coeff autocorrelation is exactly 1 at lag 0');
    assert.equal(auto.peakLag, 0);
    for (let k = 1; k <= 10; k++) {
        near(auto.values[10 + k], auto.values[10 - k], 1e-12, `autocorrelation is even (k=${k})`);
        assert.ok(Math.abs(auto.values[10 + k]) <= 1 + 1e-12, 'within [−1, 1]');
    }
}

{
    // The four normalisations by definition, with no holes.
    const y = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.2));
    const none = computeCrossCorrelation(signal, y, { maxLag: 3, normalization: 'none', removeMean: false });
    const biased = computeCrossCorrelation(signal, y, { maxLag: 3, normalization: 'biased', removeMean: false });
    const unbiased = computeCrossCorrelation(signal, y, { maxLag: 3, normalization: 'unbiased', removeMean: false });
    const coeff = computeCrossCorrelation(signal, y, { maxLag: 3, normalization: 'coeff', removeMean: false });
    // none at lag 0 is the plain dot product.
    let dot = 0;
    for (let i = 0; i < n; i++) dot += signal[i] * y[i];
    near(none.values[3], dot, 1e-9, 'none at lag 0 is the dot product');
    // none at lag +2: Σ x[n+2] y[n]
    let dot2 = 0;
    for (let i = 0; i + 2 < n; i++) dot2 += signal[i + 2] * y[i];
    near(none.values[5], dot2, 1e-9, 'none at lag 2 is Σ x[n+2]·y[n]');
    for (let i = 0; i < 7; i++) {
        near(biased.values[i], none.values[i] / n, 1e-12, `biased = none / N at index ${i}`);
        near(unbiased.values[i], none.values[i] / (n - Math.abs(i - 3)), 1e-12, `unbiased = none / (N − |k|) at index ${i}`);
        assert.equal(unbiased.counts[i], n - Math.abs(i - 3), 'the pair count is N − |k|');
    }
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < n; i++) { xx += signal[i] ** 2; yy += y[i] ** 2; }
    near(coeff.values[3], dot / Math.sqrt(xx * yy), 1e-12, 'coeff = none / √(rxx0·ryy0)');
}

{
    // Mean removal: a constant offset must not correlate.
    const flat = new Float64Array(n).fill(300);
    const bumpy = Float64Array.from({ length: n }, (_, i) => 20 + Math.sin(i * 0.3));
    const raw = computeCrossCorrelation(flat, bumpy, { maxLag: 2, normalization: 'coeff', removeMean: false });
    assert.ok(raw.values[2] > 0.99, 'on raw values two offsets correlate almost perfectly');
    // A constant minus its mean has no energy left: coeff has nothing to
    // normalise by and says so with NaN, never with a spurious 1.
    const centred = computeCrossCorrelation(flat, bumpy, { maxLag: 2, normalization: 'coeff', removeMean: true });
    assert.ok(Number.isNaN(centred.values[2]), 'no energy ⇒ NaN, not a correlation');
    // Two offset signals that DO vary together keep their correlation once centred.
    const shifted = Float64Array.from(bumpy, v => v + 280);
    const both = computeCrossCorrelation(shifted, bumpy, { maxLag: 2, normalization: 'coeff', removeMean: true });
    near(both.values[2], 1, 1e-12, 'identical variation about different means is r = 1 at lag 0');
}

{
    // Holes remove pairs, never poison lags.
    const y = Float64Array.from(signal);
    const holed = Float64Array.from(signal);
    holed[10] = NaN;
    holed[11] = NaN;
    const r = computeCrossCorrelation(holed, y, { maxLag: 2, normalization: 'unbiased', removeMean: false });
    assert.equal(r.counts[2], n - 2, 'two holes remove two pairs at lag 0');
    for (const v of r.values) assert.ok(Number.isFinite(v), 'every lag finite');
    // unbiased divides by the pairs that exist, so a clean autocorrelation at lag 0
    // (the mean square) is recovered despite the holes.
    let meanSquare = 0;
    let count = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(holed[i])) { meanSquare += holed[i] ** 2; count++; }
    near(r.values[2], meanSquare / count, 1e-12, 'unbiased at lag 0 is the mean square over the finite pairs');
    // A series with nothing finite is refused.
    assert.throws(() => computeCrossCorrelation(new Float64Array(n).fill(NaN), y, {}), err => err.code === 'dataToolXcorrNoOverlap');
    assert.throws(() => computeCrossCorrelation(signal, signal.subarray(0, 10), {}), err => err.code === 'dataToolXcorrLengthMismatch');
    assert.throws(() => computeCrossCorrelation([1], [2], {}), err => err.code === 'dataToolXcorrTooShort');
}

{
    // The FFT route agrees with the direct one, holes included.
    const big = 3000;
    const L = 1500;
    const bx = Float64Array.from({ length: big }, (_, i) => Math.sin(i * 0.05) + ((i * 7919) % 13) / 13);
    const by = Float64Array.from({ length: big }, (_, i) => Math.cos(i * 0.05));
    bx[100] = NaN;
    by[2000] = NaN;
    assert.ok(big * (2 * L + 1) > XCORR_DIRECT_LIMIT, 'this size takes the FFT route');
    const fast = computeCrossCorrelation(bx, by, { maxLag: L, normalization: 'unbiased' });
    assert.equal(fast.route, 'fft');
    const slow = computeCrossCorrelation(bx, by, { maxLag: 300, normalization: 'unbiased' });
    assert.equal(slow.route, 'direct');
    for (let k = -300; k <= 300; k++) {
        near(slow.values[k + 300], fast.values[k + L], 1e-9, `fft = direct at lag ${k}`);
        assert.equal(slow.counts[k + 300], fast.counts[k + L], `same pair count at lag ${k}`);
    }
}

{
    const p = normalizeXcorrParams({ maxLag: 1e9, normalization: 'nonsense', removeMean: undefined }, 500);
    assert.equal(p.maxLag, 499, 'the lag is capped at N − 1');
    assert.equal(p.normalization, 'coeff', 'unknown normalisation falls back');
    assert.equal(p.removeMean, true, 'mean removal defaults on');
    assert.equal(normalizeXcorrParams({ maxLag: -3 }, 500).maxLag, 499, 'a negative lag means the whole range');
    assert.equal(normalizeXcorrParams({ maxLag: 2.7 }, 500).maxLag, 2, 'lags are whole samples');
    // Ties at the peak go to the lag nearest zero.
    const constant = Float64Array.from({ length: 50 }, () => 1);
    const r = runCrossCorrelation({ x: constant, y: constant, params: { maxLag: 5, normalization: 'unbiased', removeMean: false } });
    assert.equal(r.peakLag, 0, 'a flat correlation peaks at 0 by the tie rule');
}

// ── The panel ─────────────────────────────────────────────────────────────

function fakeDocument(values = {}) {
    const elements = new Map();
    const make = (id) => {
        const classes = new Set();
        const children = [];
        const element = {
            id,
            value: values[id] ?? '',
            defaultValue: values[id] ?? '',
            checked: values[id] === true || values[id] === 'true' || values[id] === undefined,
            defaultChecked: true,
            textContent: '',
            hidden: false,
            disabled: false,
            options: children,
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
            appendChild: (child) => { children.push(child); },
            addEventListener: () => {},
        };
        Object.defineProperty(element, 'innerHTML', { set() { children.length = 0; }, get() { return ''; } });
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
            addFile(id, name, data, transform) { this.files.set(id, { name, data, transform, invertedVariables: new Set() }); this.activeFileId = id; },
            updateFileData(id, data) { this.files.get(id).data = data; },
            setActiveFile(id) { if (this.files.has(id)) this.activeFileId = id; },
            removeFile(id) { this.files.delete(id); },
            setFileTransform() {},
            hasTracesForFile() { return false; },
            withActiveFile(id, fn) { return fn(); },
            _extractUnit: description => (String(description || '').match(/\[([^\]]+)\]/) || [])[1] || '',
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
        this.messages = [];
    }
    get activeFileId() { return this.plotManager.activeFileId; }
    _defaultFileTransform() { return {}; }
    _normalizeFileTransform(t) { return { ...(t || {}) }; }
    _cloneSerializable(v) { return JSON.parse(JSON.stringify(v)); }
    _fileDisplayName(e) { return `${e.name}${e.extension || ''}`; }
    _renderFilesList() {}
    renderVariablesTree() {}
    _renderDataToolTable() {}
    _updateTopBar() {}
    _updateActionButtons() {}
    _clearVariableSelection() {}
    _isDataToolLazyData() { return false; }
    _isDataToolVariablePlotted() { return false; }
    _isInMemoryFile() { return true; }
    setActiveFile(id) { this.plotManager.setActiveFile(id); }
}
installDataToolsMethods(Harness);
installResampleMethods(Harness);
installFilterMethods(Harness);
installDerivedDatasetMethods(Harness);
installXcorrMethods(Harness);
// The installs write onto the prototype, so the harness's stand-ins for the
// message line and the plot hook go on AFTER them.
Harness.prototype._setOutlierMessage = function(message, kind) {
    this.messages.push([typeof message === 'function' ? message() : message, kind]);
};
Harness.prototype._plotResampledVariable = function() { this.plotted = true; };

const withDocument = (mockDocument, fn) => {
    const previous = globalThis.document;
    globalThis.document = mockDocument;
    const restore = () => {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    };
    let result;
    try { result = fn(); } catch (err) { restore(); throw err; }
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
};

const addFile = (harness, { kind = 'numeric', unit = 's', step = 0.001, count = 2000, time = null, delay = 25 } = {}) => {
    const scale = kind === 'datetime' ? 1000 : 1;
    const axis = time || Float64Array.from({ length: count }, (_, i) => i * step * scale);
    const timeVariable = { name: 'time', data: axis, kind: 'abscissa', description: kind === 'datetime' ? '[datetime]' : `[${unit}]` };
    if (kind === 'datetime') timeVariable.timeKind = 'datetime';
    const x = Float64Array.from({ length: axis.length }, (_, i) => Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.31));
    const y = Float64Array.from({ length: axis.length }, (_, i) => (i >= delay ? x[i - delay] : 0));
    const data = {
        metadata: { timeName: 'time', timeKind: kind, numTimesteps: axis.length },
        variables: {
            time: timeVariable,
            x: { name: 'x', data: x, kind: 'variable', description: '[V]' },
            y: { name: 'y', data: y, kind: 'variable', description: '[V]' },
        },
        tree: {},
    };
    const fileId = `f${harness._nextFileId++}`;
    harness.files.set(fileId, { name: 'run', extension: '.csv', transform: {}, buffer: new ArrayBuffer(1) });
    harness.plotManager.addFile(fileId, 'run', data, {});
    return { fileId, data };
};

const xcorrDom = (fields = {}) => fakeDocument({
    'data-tool-select': 'xcorr', 'outlier-variable': 'x', 'xcorr-second': 'y', 'xcorr-max-lag': '0.1',
    'xcorr-normalization': 'coeff', 'outlier-output-name': 'x xcorr',
    ...fields,
});

// The plan on a uniform axis: Δt, lag range, and the sign sentence at commit.
{
    const h = new Harness();
    const { fileId, data } = addFile(h, { step: 0.001, delay: 25 });
    await withDocument(xcorrDom(), async () => {
        const plan = h._xcorrPlan(data);
        assert.equal(plan.ok, true, plan.text);
        assert.equal(plan.lags, 100, '0.1 s at 1 ms is 100 lags');
        assert.match(plan.text, /Δt 0\.001 s · lags ±100 samples \(±0\.1 s\)/);
        assert.equal(h._dataToolCommitBlocker({ hasSource: true, hasValidConfig: true, editing: null, fileId, data }), '');

        const result = await h.commitXcorrTool();
        assert.equal(result.tool, 'xcorr');
        assert.equal(result.count, 201);
        const entry = h.files.get(result.fileId);
        assert.equal(entry.name, 'x xcorr');
        assert.deepEqual(h._derivedDatasetRecipe(entry), {
            tool: 'xcorr', sourceFileId: fileId, sourceName: 'x',
            params: { second: 'y', maxLag: 0.1, normalization: 'coeff', removeMean: true },
        });
        const built = h.plotManager.files.get(result.fileId).data;
        assert.equal(built.metadata.timeName, 'lag');
        assert.equal(built.variables.lag.kind, 'abscissa');
        assert.equal(built.variables.lag.description, '[s]');
        near(built.variables.lag.data[0], -0.1, 1e-12, 'the lag axis starts at −maxLag');
        near(built.variables.lag.data[200], 0.1, 1e-12, 'and ends at +maxLag');
        assert.ok(built.variables.r_xy, 'the correlation is r_xy');
        assert.equal(built.variables.peak_lag.kind, 'parameter');
        // y is x delayed by 25 samples = 0.025 s ⇒ peak at lag −0.025 s.
        near(built.variables.peak_lag.data[0], -0.025, 1e-12, 'the peak lag is a time');
        assert.ok(built.variables.peak_value.data[0] > 0.95);
        near(built.metadata.xcorr.peakLag, -0.025, 1e-12);
        const [message] = h.messages.at(-1);
        assert.match(message, /Created the file x xcorr: 201 lags\. Peak r = 0\.9\d+ at lag −?-?0\.025 s\./);
        assert.match(message, /y runs behind x by 0\.025 s\./, 'the sign is read out for the user');
        assert.equal(h.activeFileId, fileId, 'the source stays active');
        assert.equal(h._derivedDatasetDescription(h._derivedDatasetRecipe(entry)), 'x × y; coeff, mean removed, lags ±0.1');
    });
}

// Autocorrelation: the second picker defaults to the first signal.
{
    const h = new Harness();
    const { data } = addFile(h);
    await withDocument(xcorrDom({ 'xcorr-second': '' }), async () => {
        h._syncXcorrControls();
        assert.equal(document.getElementById('xcorr-second').value, 'x', 'defaults to the same signal');
        const plan = h._xcorrPlan(data);
        assert.equal(plan.ok, true);
        assert.match(plan.text, /autocorrelation/);
        const result = await h.commitXcorrTool();
        const built = h.plotManager.files.get(result.fileId).data;
        assert.ok(built.variables.r_xx, 'the autocorrelation is r_xx');
        near(built.variables.r_xx.data[100], 1, 1e-12, 'coeff autocorrelation is 1 at lag 0');
        assert.equal(built.variables.peak_lag.data[0], 0);
        assert.doesNotMatch(h.messages.at(-1)[0], /runs behind/, 'no delay sentence for an autocorrelation');
    });
}

// Units: a calendar axis gives seconds; an index axis gives samples; a declared
// unit is kept.
{
    const h = new Harness();
    addFile(h, { kind: 'datetime', step: 0.1 });
    withDocument(xcorrDom({ 'xcorr-max-lag': '2' }), () => {
        const plan = h._xcorrPlan(h.plotManager.files.get(h.activeFileId).data);
        assert.equal(plan.ok, true, plan.text);
        assert.equal(plan.axis.unit, 's');
        near(plan.axis.dt, 0.1, 1e-9, 'a 100 ms calendar step is 0.1 s');
        assert.equal(plan.lags, 20);
    });
    const g = new Harness();
    const { data } = addFile(g);
    data.metadata.timeKind = 'index';
    withDocument(xcorrDom({ 'xcorr-max-lag': '50' }), () => {
        const plan = g._xcorrPlan(data);
        assert.equal(plan.ok, true, plan.text);
        assert.equal(plan.axis.kind, 'index');
        assert.equal(plan.lags, 50, 'on an index axis the lag is typed in samples');
        assert.match(plan.text, /No time axis/);
    });
    const k = new Harness();
    addFile(k, { unit: 'ms', step: 2 });
    withDocument(xcorrDom({ 'xcorr-max-lag': '40' }), () => {
        const plan = k._xcorrPlan(k.plotManager.files.get(k.activeFileId).data);
        assert.equal(plan.axis.unit, 'ms');
        assert.equal(plan.lags, 20, '40 ms at 2 ms per sample');
    });
}

// Refusals: irregular axis, missing second signal, bad lag, mismatched lengths.
{
    const h = new Harness();
    let t = 0;
    const time = Float64Array.from({ length: 300 }, (_, i) => { t += 0.5 + ((i * 7919) % 13) / 13; return t; });
    const { fileId, data } = addFile(h, { time });
    withDocument(xcorrDom(), () => {
        const plan = h._xcorrPlan(data);
        assert.equal(plan.ok, false);
        assert.equal(plan.code, 'dataToolXcorrIrregular');
        assert.equal(h._dataToolCommitBlocker({ hasSource: true, hasValidConfig: true, editing: null, fileId, data }), 'dataToolXcorrIrregular');
    });
    const g = new Harness();
    const source = addFile(g);
    withDocument(xcorrDom({ 'xcorr-second': '' , 'outlier-variable': 'x' }), () => {
        // The sync would default the second picker; read the plan raw.
        assert.equal(g._xcorrPlan(source.data).code, 'dataToolXcorrChooseSecond');
    });
    withDocument(xcorrDom({ 'xcorr-max-lag': '' }), () => assert.equal(g._xcorrPlan(source.data).code, 'dataToolXcorrMaxLagInvalid'));
    withDocument(xcorrDom({ 'xcorr-max-lag': '0' }), () => assert.equal(g._xcorrPlan(source.data).code, 'dataToolXcorrMaxLagInvalid'));
    source.data.variables.short = { name: 'short', data: new Float64Array(10), kind: 'variable', description: '' };
    withDocument(xcorrDom({ 'xcorr-second': 'short' }), () => assert.equal(g._xcorrPlan(source.data).code, 'dataToolXcorrLengthMismatch'));
    // A lag longer than the record is clamped, not refused.
    withDocument(xcorrDom({ 'xcorr-max-lag': '1e9' }), () => {
        const plan = g._xcorrPlan(source.data);
        assert.equal(plan.ok, true);
        assert.equal(plan.lags, 1999);
    });
}

// The recipe round trip: recompute from the recipe, edit form, session record.
{
    const h = new Harness();
    const { fileId, data } = addFile(h, { delay: 10 });
    const recipe = { tool: 'xcorr', sourceFileId: fileId, sourceName: 'x', params: { second: 'y', maxLag: 0.05, normalization: 'unbiased', removeMean: false } };
    const computed = await h._computeDerivedDataset(recipe);
    assert.equal(computed.data.metadata.numTimesteps, 101);
    assert.equal(computed.result.normalization, 'unbiased');
    assert.equal(computed.result.removeMean, false);
    near(computed.data.variables.peak_lag.data[0], -0.01, 1e-12);
    const made = h._registerDerivedDataset(recipe, 'xy', computed.data);
    // The source changes: the dataset follows.
    data.variables.y = { name: 'y', data: Float64Array.from({ length: 2000 }, (_, i) => (i >= 40 ? data.variables.x.data[i - 40] : 0)), kind: 'variable', description: '' };
    await withDocument(fakeDocument({}), () => h._recomputeDerivedDataset(made.fileId));
    near(h.plotManager.files.get(made.fileId).data.variables.peak_lag.data[0], -0.04, 1e-12, 'recomputed against the new delay');
    // Editing reopens the form with the recipe.
    const dom = xcorrDom({ 'data-tool-select': '', 'outlier-variable': '', 'xcorr-second': '', 'xcorr-max-lag': '', 'xcorr-normalization': 'coeff' });
    withDocument(dom, () => {
        h._editDerivedDataset(made.fileId);
        assert.deepEqual(h._datasetEditing, { fileId: made.fileId, name: 'xy' });
        assert.equal(dom.getElementById('data-tool-select').value, 'xcorr');
        assert.equal(dom.getElementById('outlier-variable').value, 'x');
        assert.equal(dom.getElementById('xcorr-second').value, 'y');
        assert.equal(dom.getElementById('xcorr-max-lag').value, '0.05');
        assert.equal(dom.getElementById('xcorr-normalization').value, 'unbiased');
        assert.equal(dom.getElementById('xcorr-remove-mean').checked, false);
    });
    const record = h._serializeDerivedDataset(made.fileId);
    assert.equal(record.tool, 'xcorr');
    assert.deepEqual(record.params, recipe.params);
    assert.equal(record.sourceName, 'x');
}

console.log('cross-correlation tests passed');
