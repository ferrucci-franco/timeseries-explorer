// Panel-level tests for the two sampling tools: how the form is read, what the
// resample summary claims, and the shape of the file a resample produces.
// The kernels themselves are covered by test-interpolate-regrid.mjs.
import assert from 'node:assert/strict';
import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';
import { installResampleMethods } from '../src/app/methods/resample-methods.js';
import { installFilterMethods } from '../src/app/methods/filter-methods.js';

// The smallest document these methods can run against: an id → value map with
// the class-list and dataset surface the sync functions touch.
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
            min: id.endsWith('-slider') ? '1' : '',
            max: id.endsWith('-slider') ? '200' : '',
            dataset: {},
            classList: {
                toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name),
            },
            setAttribute: () => {},
            toggleAttribute: (_name, on) => { element.disabled = !!on; },
        };
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
    };
}

class Harness {
    constructor() {
        this.parser = {
            _detectDataType: () => 'real',
            _isConstantValues: values => {
                const finite = Array.from(values || []).filter(Number.isFinite);
                return finite.length > 0 && finite.every(value => value === finite[0]);
            },
            _buildTree: variables => ({
                _type: 'root', _name: '', _children: {}, _variables: { ...variables },
            }),
        };
        this.files = new Map();
        this._nextFileId = 1;
        this.plotManager = { files: new Map(), activeFileId: null };
    }
    get activeFileId() { return this.plotManager.activeFileId; }
}

installDataToolsMethods(Harness);
installResampleMethods(Harness);
installFilterMethods(Harness);

const withDocument = (mockDocument, fn) => {
    const previous = globalThis.document;
    globalThis.document = mockDocument;
    try {
        return fn();
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
};

const numericFile = (harness, { name = 'run', step = 1, count = 11, kind = 'numeric' } = {}) => {
    const scale = kind === 'datetime' ? 1000 : 1;
    const time = Float64Array.from({ length: count }, (_, i) => i * step * scale);
    const signal = Float64Array.from({ length: count }, (_, i) => i * 2);
    const timeVariable = {
        name: 'time', data: time, kind: 'abscissa', description: kind === 'datetime' ? '[datetime]' : '[s]',
    };
    if (kind === 'datetime') timeVariable.timeKind = 'datetime';
    const data = {
        metadata: { timeName: 'time', timeKind: kind, numTimesteps: count },
        variables: {
            time: timeVariable,
            signal: { name: 'signal', data: signal, kind: 'variable', description: '[V]' },
            constant: { name: 'constant', data: [42], kind: 'parameter', description: '' },
        },
    };
    const fileId = `f${harness._nextFileId++}`;
    harness.files.set(fileId, { name, extension: '.csv', file: null, transform: {} });
    harness.plotManager.files.set(fileId, { name, data });
    harness.plotManager.activeFileId = fileId;
    return { fileId, data };
};

// ── The tool taxonomy ─────────────────────────────────────────────────────

{
    const h = new Harness();
    withDocument(fakeDocument({ 'data-tool-select': 'interpolate' }), () => {
        assert.equal(h._getSelectedDataTool(), 'interpolate');
        assert.equal(h._isFileDataTool(), false, 'filling holes produces a variable');
    });
    withDocument(fakeDocument({ 'data-tool-select': 'resample' }), () => {
        assert.equal(h._getSelectedDataTool(), 'resample');
        assert.equal(h._isFileDataTool(), true, 'resampling produces a file');
    });
    withDocument(fakeDocument({ 'data-tool-select': 'nonsense' }), () => {
        assert.equal(h._getSelectedDataTool(), '', 'an unknown tool selects nothing');
    });
    assert.equal(h._dataToolLabel('interpolate'), 'Fill missing data');
    assert.equal(h._dataToolLabel('resample'), 'Resample');
}

// ── Reading the fill form ─────────────────────────────────────────────────

{
    const h = new Harness();
    const config = withDocument(fakeDocument({
        'data-tool-select': 'interpolate',
        'interpolate-method': 'smooth',
        'interpolate-max-gap': '25',
        'interpolate-edges': 'hold',
        'interpolate-window': '31',
    }), () => h._getDataToolConfig('interpolate'));
    assert.deepEqual(config, {
        tool: 'interpolate',
        params: { method: 'smooth', maxGap: 25, edges: 'hold', window: 31 },
    });
}

{
    // The point of having a box next to the slider: a typed value ABOVE the
    // slider's range must survive, with the slider parked at its maximum and the
    // read-out showing the real number.
    const h = new Harness();
    const dom = fakeDocument({
        'data-tool-select': 'interpolate',
        'interpolate-method': 'linear',
        'interpolate-max-gap': '5000',
    });
    withDocument(dom, () => {
        h._syncInterpolateControls();
        assert.equal(h._getDataToolConfig('interpolate').params.maxGap, 5000,
            'the commit reads the box, not the slider');
    });
    assert.equal(dom.getElementById('interpolate-max-gap').value, '5000',
        'the typed value is never clamped back into the box');
    assert.equal(dom.getElementById('interpolate-max-gap-slider').value, '200',
        'the slider parks at its own maximum');
    assert.equal(dom.getElementById('interpolate-max-gap-value').textContent, '5000',
        'the read-out shows what will actually be used');
}

{
    // An empty box is a no-limit fill, not a zero-length one, and the read-out
    // has to say so rather than print a nine-digit number.
    const h = new Harness();
    const dom = fakeDocument({ 'data-tool-select': 'interpolate', 'interpolate-max-gap': '' });
    const config = withDocument(dom, () => {
        h._syncInterpolateControls();
        return h._getDataToolConfig('interpolate');
    });
    assert.equal(config.params.maxGap, 1e9, 'an empty gap limit means no limit');
    assert.equal(dom.getElementById('interpolate-max-gap-value').textContent, 'no limit');
}

{
    // The smoothing window belongs to one method, and is hidden under the others.
    const h = new Harness();
    for (const [method, collapsed] of [['smooth', false], ['linear', true]]) {
        const dom = fakeDocument({ 'data-tool-select': 'interpolate', 'interpolate-method': method });
        withDocument(dom, () => h._syncInterpolateControls());
        assert.equal(
            dom.getElementById('interpolate-window-wrap').classList.contains('collapsed'),
            collapsed,
            `the window is ${collapsed ? 'hidden' : 'shown'} for ${method}`,
        );
    }
}

{
    const h = new Harness();
    assert.equal(
        h._interpolateDescription({ method: 'smooth', maxGap: 12, window: 21, edges: 'hold' }),
        'smooth, window 21; gaps up to 12 samples, ends held',
    );
    assert.equal(
        h._interpolateDescription({ method: 'linear', maxGap: 1e9, window: 21, edges: 'leave' }),
        'linear; gaps any length',
    );
}

{
    // The warning has to name what was NOT done, or a gap limit that refused
    // every hole looks like a clean run.
    const h = new Harness();
    assert.equal(h._interpolateWarning({ skippedRuns: 0, filledCount: 3, usedTimeAxis: true }), '');
    const warned = h._interpolateWarning({ skippedRuns: 2, skippedCount: 40, longestSkipped: 30, filledCount: 1, usedTimeAxis: true });
    assert.match(warned, /2 gaps left untouched \(40 samples, longest 30\)/);
    const rowBased = h._interpolateWarning({ skippedRuns: 0, filledCount: 5, usedTimeAxis: false });
    assert.match(rowBased, /row number/);
}

// ── The resample summary ──────────────────────────────────────────────────

{
    const h = new Harness();
    const { data } = numericFile(h, { step: 0.1, count: 101 });
    const plan = withDocument(fakeDocument({
        'data-tool-select': 'resample',
        'resample-grid-mode': 'step',
        'resample-step': '0.25',
        'resample-method': 'linear',
    }), () => h._resamplePlan(data));
    assert.equal(plan.ok, true);
    assert.ok(Math.abs(plan.step - 0.25) < 1e-12);
    assert.equal(plan.count, 41, 'floor(10 / 0.25) + 1');
    assert.match(plan.text, /downsample/, 'a coarser Δt is announced as a downsample');
    assert.match(plan.text, /101 → 41/);
}

{
    // A calendar axis stores milliseconds and the field is seconds. Getting this
    // conversion wrong is a factor of a thousand, so it gets its own test.
    const h = new Harness();
    const { data } = numericFile(h, { step: 1, count: 11, kind: 'datetime' });
    const plan = withDocument(fakeDocument({
        'data-tool-select': 'resample',
        'resample-grid-mode': 'step',
        'resample-step': '2',
        'resample-method': 'linear',
    }), () => h._resamplePlan(data));
    assert.equal(plan.ok, true);
    assert.equal(plan.step, 2000, 'two seconds is two thousand milliseconds on the axis');
    assert.equal(plan.count, 6);
    assert.match(plan.text, /Δt 1 → 2 s/, 'the summary speaks seconds, not milliseconds');
}

{
    const h = new Harness();
    const { data } = numericFile(h, { step: 1, count: 11 });
    const factor = withDocument(fakeDocument({
        'data-tool-select': 'resample',
        'resample-grid-mode': 'factor',
        'resample-factor': '4',
    }), () => h._resamplePlan(data));
    assert.equal(factor.step, 0.25, 'factor 4 quarters the step');
    assert.match(factor.text, /upsample ×4/);

    const counted = withDocument(fakeDocument({
        'data-tool-select': 'resample',
        'resample-grid-mode': 'count',
        'resample-count': '21',
    }), () => h._resamplePlan(data));
    assert.equal(counted.count, 21);
}

{
    const h = new Harness();
    const { data } = numericFile(h, { step: 1, count: 11 });
    for (const [inputs, pattern] of [
        [{ 'resample-grid-mode': 'step', 'resample-step': '0' }, /greater than zero/],
        [{ 'resample-grid-mode': 'step', 'resample-step': '999' }, /longer than the whole recording/],
        [{ 'resample-grid-mode': 'step', 'resample-step': '0.0000001' }, /20 million/],
    ]) {
        const plan = withDocument(fakeDocument({ 'data-tool-select': 'resample', ...inputs }),
            () => h._resamplePlan(data));
        assert.equal(plan.ok, false);
        assert.match(plan.text, pattern);
    }
}

// ── The dataset a resample produces ───────────────────────────────────────

{
    const h = new Harness();
    const { data } = numericFile(h, { step: 1, count: 11 });
    const built = withDocument(fakeDocument({ 'data-tool-select': 'resample' }), () => {
        const time = h._resampleTimeContext(data);
        const resampled = {
            grid: Float64Array.from([0, 2, 4, 6, 8, 10]),
            columns: [Float64Array.from([0, 4, 8, 12, 16, 20])],
            step: 2,
            sourceStep: 1,
            emptyCounts: [0],
        };
        return h._buildResampledData(data, time, { params: { method: 'linear', gridMode: 'step' } }, ['signal'], resampled);
    });

    const abscissas = Object.values(built.variables).filter(v => v.kind === 'abscissa');
    assert.equal(abscissas.length, 1, 'the new file owns exactly one time axis');
    assert.equal(abscissas[0].name, 'time');
    assert.equal(built.metadata.timeName, 'time');
    assert.equal(built.metadata.numTimesteps, 6);
    assert.equal(built.metadata.timeStart, 0);
    assert.equal(built.metadata.timeEnd, 10);
    assert.equal(built.variables.signal.data.length, 6);
    assert.equal(built.variables.signal.description, '[V]', 'units come across with the variable');
    assert.equal(built.variables.constant.kind, 'parameter', 'parameters are copied, not resampled');
    assert.equal(built.variables.constant.data[0], 42);
    assert.ok(built.tree, 'the sidebar tree is built');
    assert.equal(built.metadata.resample.step, 2);
}

{
    // A calendar axis has to come out as one, or the new file plots as raw
    // milliseconds since 1970.
    const h = new Harness();
    const { data } = numericFile(h, { step: 1, count: 11, kind: 'datetime' });
    const built = withDocument(fakeDocument({ 'data-tool-select': 'resample' }), () => {
        const time = h._resampleTimeContext(data);
        return h._buildResampledData(data, time, { params: { method: 'mean', gridMode: 'step' } }, ['signal'], {
            grid: Float64Array.from([0, 2000, 4000]),
            columns: [Float64Array.from([0, 4, 8])],
            step: 2000,
            sourceStep: 1000,
            emptyCounts: [0],
        });
    });
    assert.equal(built.variables.time.timeKind, 'datetime');
    assert.equal(built.variables.time.timeDisplayMode, 'calendar');
    assert.equal(built.variables.time.timeOriginMs, 0);
    assert.equal(built.metadata.timeKind, 'datetime');
    assert.equal(built.metadata.resample.step, 2, 'the recipe records seconds, like the form');
}

// ── Serializing, so a project session can still be saved ──────────────────

{
    const h = new Harness();
    const built = {
        metadata: { timeName: 'time', timeKind: 'numeric' },
        variables: {
            time: { name: 'time', kind: 'abscissa', data: Float64Array.from([0, 1, 2]) },
            signal: { name: 'signal', kind: 'variable', data: Float64Array.from([0, NaN, 4]) },
            constant: { name: 'constant', kind: 'parameter', data: [42] },
        },
    };
    const text = new TextDecoder().decode(h._resampleCsvBytes(built));
    assert.deepEqual(text.trim().split('\n'), ['time,signal', '0,0', '1,', '2,4']);

    const calendar = {
        metadata: { timeName: 'time', timeKind: 'datetime' },
        variables: {
            time: { name: 'time', kind: 'abscissa', data: Float64Array.from([0, 1000]) },
            signal: { name: 'signal', kind: 'variable', data: Float64Array.from([1, 2]) },
        },
    };
    const calendarText = new TextDecoder().decode(h._resampleCsvBytes(calendar));
    assert.match(calendarText, /1970-01-01T00:00:00\.000Z,1/, 'a calendar axis is written as ISO timestamps');
}

// ── The stability gate, as the panel enforces it ──────────────────────────

{
    const h = new Harness();
    const filterDom = (b, a, mode = 'forward') => fakeDocument({
        'data-tool-select': 'filter', 'filter-b': b, 'filter-a': a, 'filter-mode': mode,
    });

    // Stable: the summary states the pole and the gain, and nothing blocks.
    const okPlan = withDocument(filterDom('1', '1, -1.8, 0.81'), () => h._filterPlan());
    assert.equal(okPlan.ok, true);
    assert.equal(okPlan.code, '');
    // The kind is named in both cases: an FIR line that says "FIR" next to an
    // IIR line that says nothing reads as an omission rather than a distinction.
    assert.match(okPlan.text, /^IIR, order 2/);
    assert.match(okPlan.text, /0\.9/, 'the furthest pole is quoted');

    // Unstable: refused, and the message names WHERE the pole is, because that is
    // the number that tells the user which coefficient to pull back.
    const badPlan = withDocument(filterDom('1', '1, -2.2, 1.21'), () => h._filterPlan());
    assert.equal(badPlan.ok, false);
    assert.equal(badPlan.code, 'dataToolFilterUnstable');
    assert.match(badPlan.text, /1\.1/, 'the offending pole radius is named');

    // ...and the commit blocker reports that same specific reason, not a generic
    // "check the parameters". This is the gate the whole feature turns on.
    const blocker = withDocument(filterDom('1', '1, -2.2, 1.21'), () => h._dataToolCommitBlocker({
        hasSource: true, hasValidConfig: false, editing: null, fileId: 'f1', data: { variables: {} },
    }));
    assert.equal(blocker, 'dataToolFilterUnstable', 'an unstable filter blocks the Create buttons by name');

    // Reading the config throws rather than returning one, so the preview and the
    // commit both refuse through a single check.
    withDocument(filterDom('1', '1, -2.2, 1.21'), () => {
        assert.throws(() => h._getDataToolConfig('filter'), err => err.code === 'dataToolFilterUnstable');
        assert.equal(h._tryReadDataToolConfig(), null, 'there is no config for an unstable filter');
    });

    // A pole exactly on the unit circle is refused too: it neither decays nor
    // stays bounded, and "marginally stable" is not a thing a data tool can
    // offer. It also gets its own sentence — calling a pole that sits ON the
    // circle "outside" it would be plainly wrong to the people reading this.
    for (const a of ['1, -1', '1, 1', '1, -2, 1']) {
        const plan = withDocument(filterDom('1', a), () => h._filterPlan());
        assert.equal(plan.ok, false, `a = [${a}] is refused`);
        assert.equal(plan.code, 'dataToolFilterUnstable');
        assert.match(plan.text, /exactly on the unit circle/, `a = [${a}] is described as on the circle`);
        assert.doesNotMatch(plan.text, /outside/, `a = [${a}] is not described as outside it`);
    }
}

{
    const h = new Harness();
    // Nonsense in the box is its own diagnosis, naming the token.
    const plan = withDocument(fakeDocument({
        'data-tool-select': 'filter', 'filter-b': '1', 'filter-a': '1, oops',
    }), () => h._filterPlan());
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'dataToolFilterNotNumeric');
    assert.match(plan.text, /"oops"/);

    const zero = withDocument(fakeDocument({
        'data-tool-select': 'filter', 'filter-b': '1', 'filter-a': '0, 1',
    }), () => h._filterPlan());
    assert.equal(zero.code, 'dataToolFilterLeadingZero');
}

{
    const h = new Harness();
    // An FIR has no poles, and the summary says so rather than quoting |z| = 0.
    const plan = withDocument(fakeDocument({
        'data-tool-select': 'filter', 'filter-b': '[0.25 0.5 0.25]', 'filter-a': '1',
    }), () => h._filterPlan());
    assert.equal(plan.ok, true);
    assert.match(plan.text, /FIR, order 2/);
    assert.match(plan.text, /gain at DC 1/);

    // The stored config is NORMALIZED, so a restored session reproduces the
    // recursion that ran rather than the text that was typed.
    const config = withDocument(fakeDocument({
        'data-tool-select': 'filter', 'filter-b': '2, 1', 'filter-a': '4, 2', 'filter-mode': 'zeroPhase',
    }), () => h._getDataToolConfig('filter'));
    assert.deepEqual(config.params.b, [0.5, 0.25]);
    assert.deepEqual(config.params.a, [1, 0.5]);
    assert.equal(config.params.mode, 'zeroPhase');
}

// ── The detrend form ──────────────────────────────────────────────────────

{
    const h = new Harness();
    const config = withDocument(fakeDocument({
        'data-tool-select': 'detrend',
        'detrend-method': 'polynomial',
        'detrend-order': '5',
        'detrend-window': '51',
    }), () => h._getDataToolConfig('detrend'));
    assert.deepEqual(config, { tool: 'detrend', params: { method: 'polynomial', order: 5, window: 51 } });

    // Order belongs to the polynomial and the window to the baseline; each is
    // hidden under the methods that never read it.
    for (const [method, orderHidden, windowHidden] of [
        ['linear', true, true],
        ['polynomial', false, true],
        ['movingAverage', true, false],
    ]) {
        const dom = fakeDocument({ 'data-tool-select': 'detrend', 'detrend-method': method });
        withDocument(dom, () => h._syncDetrendControls());
        assert.equal(dom.getElementById('detrend-order-wrap').classList.contains('collapsed'), orderHidden,
            `order visibility for ${method}`);
        assert.equal(dom.getElementById('detrend-window-wrap').classList.contains('collapsed'), windowHidden,
            `window visibility for ${method}`);
    }

    assert.equal(h._detrendDescription({ method: 'polynomial', order: 3 }), 'polynomial order 3');
    assert.equal(h._detrendDescription({ method: 'linear' }), 'least-squares line');
    assert.equal(h._dataToolLabel('detrend'), 'Detrend');
    assert.equal(h._dataToolLabel('filter'), 'Digital filter');
    // The drift is quoted per second on a real time axis and per sample without one.
    assert.match(h._detrendNote({ slope: 0.25, usedTimeAxis: true }, { method: 'linear' }), /0\.25 per second/);
    assert.match(h._detrendNote({ slope: 0.25, usedTimeAxis: false }, { method: 'linear' }), /per sample/);
    assert.equal(h._detrendNote({ slope: null }, { method: 'mean' }), '', 'no slope, nothing to say');
}

console.log('data tools sampling panel tests passed');
