// Filter design: the specification → coefficients kernel, the second-order
// section path through the IIR kernel, and the panel's design mode.
//
// The Butterworth reference coefficients are MATLAB's to the digits its console
// prints, the prototype poles are the textbook tables; every other assertion is a PROPERTY of the response —
// −3 dB at the cut-off, the ripple depth asked for, unit gain at DC — because a
// property is what the user was promised and what a reference table cannot
// cover for every family, response and order.
import assert from 'node:assert/strict';
import {
    FILTER_DESIGN_MAX_ORDER,
    analogPrototype,
    designFilter,
    designedMagnitudeDb,
    normalizeFilterDesign,
    sosMagnitudeDb,
    zpkToSos,
    zpkToTransferFunction,
} from '../src/compute/kernels/filter-design.js';
import {
    applyFilter,
    cascadeInitialState,
    inspectFilter,
    inspectSos,
    normalizeSos,
    schurCohnStable,
    sosToTransferFunction,
} from '../src/compute/kernels/iir.js';
import { runDataToolStep } from '../src/compute/kernels/index.js';
import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';
import { installResampleMethods } from '../src/app/methods/resample-methods.js';
import { installFilterMethods } from '../src/app/methods/filter-methods.js';

const near = (actual, expected, tol, label) => {
    assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ± ${tol}, got ${actual}`);
};
const nearList = (actual, expected, tol, label) => {
    assert.equal(actual.length, expected.length, `${label}: length`);
    expected.forEach((value, i) => near(actual[i], value, tol, `${label}[${i}]`));
};

// ── Reference coefficients ────────────────────────────────────────────────

{
    // MATLAB: [b, a] = butter(2, 0.5) → b = 0.2929 0.5858 0.2929, a = 1 0 0.1716
    const r = designFilter({ family: 'butterworth', response: 'lowpass', order: 2, cutoff: [0.25], sampleRate: 1 });
    nearList(r.b, [0.292893, 0.585786, 0.292893], 5e-6, 'butter(2, 0.5) b');
    nearList(r.a, [1, 0, 0.171573], 5e-6, 'butter(2, 0.5) a');
    assert.equal(r.sos.length, 1, 'order 2 is one section');
}
{
    // MATLAB: butter(1, 0.5) → b = 0.5 0.5, a = 1 0
    const r = designFilter({ family: 'butterworth', response: 'lowpass', order: 1, cutoff: [0.25], sampleRate: 1 });
    nearList(r.b, [0.5, 0.5], 1e-12, 'butter(1, 0.5) b');
    nearList(r.a, [1, 0], 1e-12, 'butter(1, 0.5) a');
}
{
    // MATLAB: butter(4, 0.2, 'high') → b = 0.4328 -1.7314 2.5971 -1.7314 0.4328,
    //                                   a = 1 -2.3695 2.3140 -1.0547 0.1874
    const r = designFilter({ family: 'butterworth', response: 'highpass', order: 4, cutoff: [0.1], sampleRate: 1 });
    nearList(r.b, [0.4328, -1.7314, 2.5971, -1.7314, 0.4328], 5e-5, 'butter(4, 0.2, high) b');
    nearList(r.a, [1, -2.3695, 2.3140, -1.0547, 0.1874], 5e-5, 'butter(4, 0.2, high) a');
}
{
    // The 1 dB Chebyshev I analog prototype of order 3 (standard table):
    // poles at −0.4942 and −0.2471 ± j0.9660.
    const { poles, zeros, gain } = analogPrototype('chebyshev1', 3, { rippleDb: 1 });
    assert.equal(zeros.length, 0, 'all-pole');
    const real = poles.find(p => p[1] === 0 || Math.abs(p[1]) < 1e-9);
    const pair = poles.filter(p => Math.abs(p[1]) > 1e-9).sort((p, q) => p[1] - q[1]);
    near(real[0], -0.4942, 5e-4, 'cheby1 3 real pole');
    near(pair[0][0], -0.2471, 5e-4, 'cheby1 3 pair re');
    near(Math.abs(pair[0][1]), 0.9660, 5e-4, 'cheby1 3 pair im');
    // Odd order: unit gain at DC, i.e. k = Π(−p).
    near(gain, 0.4942 * (0.2471 ** 2 + 0.9660 ** 2), 2e-3, 'cheby1 3 gain');
    // Even order: the DC gain is the ripple trough, 1/√(1+ε²) = −1 dB.
    const r = designFilter({ family: 'chebyshev1', response: 'lowpass', order: 4, cutoff: [50], sampleRate: 1000, rippleDb: 1 });
    near(sosMagnitudeDb(r.sos, 0), -1, 1e-9, 'even-order Chebyshev I sits at −1 dB at DC');
}
{
    // The analog Bessel prototype of order 2, −3 dB normalised. Derived by hand:
    // the unit-delay polynomial s² + 3s + 3 has poles −1.5 ± j√3/2 and
    // |H(jω)|² = 9 / ((3 − ω²)² + 9ω²) = ½ at ω² = (√45 − 3)/2, i.e. ω₃ = 1.36165;
    // dividing the poles by ω₃ gives −1.10160 ± j0.63601.
    const { poles } = analogPrototype('bessel', 2);
    const sorted = [...poles].sort((p, q) => p[1] - q[1]);
    const w3 = Math.sqrt((Math.sqrt(45) - 3) / 2);
    near(sorted[0][0], -1.5 / w3, 1e-9, 'bessel 2 pole re');
    near(Math.abs(sorted[0][1]), (Math.sqrt(3) / 2) / w3, 1e-9, 'bessel 2 pole im');
    // And order 1 IS a first-order Butterworth.
    const one = analogPrototype('bessel', 1);
    near(one.poles[0][0], -1, 1e-9, 'bessel 1 = butterworth 1');
}

// ── Response properties, every family × response × several orders ────────

const fs = 1000;
for (const family of ['butterworth', 'chebyshev1', 'chebyshev2', 'bessel']) {
    for (const response of ['lowpass', 'highpass', 'bandpass', 'bandstop']) {
        for (const order of [1, 2, 3, 5, 8, FILTER_DESIGN_MAX_ORDER]) {
            const cutoff = response === 'bandpass' || response === 'bandstop' ? [40, 120] : [50];
            const label = `${family} ${response} N=${order}`;
            const r = designFilter({ family, response, order, cutoff, sampleRate: fs, rippleDb: 1, attenuationDb: 40 });

            const expectedOrder = cutoff.length === 2 ? 2 * order : order;
            assert.equal(r.order, expectedOrder, `${label}: digital order`);
            assert.equal(r.sos.length, Math.ceil(expectedOrder / 2), `${label}: section count`);

            // Every section stable, and every pole strictly inside the circle.
            const inspection = inspectSos(r.sos);
            assert.equal(inspection.stable, true, `${label}: stable`);
            assert.ok(inspection.maxPoleRadius < 1, `${label}: max pole radius ${inspection.maxPoleRadius}`);
            assert.equal(inspection.order, expectedOrder, `${label}: inspected order`);

            // The gain at the cut-off is what the family promises.
            const expectedAtCutoff = family === 'chebyshev1' ? -1 : (family === 'chebyshev2' ? -40 : -20 * Math.log10(Math.SQRT2));
            for (const f of cutoff) {
                near(designedMagnitudeDb(r.sos, f, fs), expectedAtCutoff, 1e-6, `${label}: gain at ${f} Hz`);
            }

            // DC and Nyquist: passed or stopped as the response says.
            const dc = sosMagnitudeDb(r.sos, 0);
            const nyq = sosMagnitudeDb(r.sos, Math.PI);
            const passesDc = response === 'lowpass' || response === 'bandstop';
            const passesNyquist = response === 'highpass' || response === 'bandstop';
            // An even-order Chebyshev I sits at the ripple trough at the band edge
            // extremes, so "passed" there means within the ripple.
            const passTol = family === 'chebyshev1' ? 1 + 1e-6 : 1e-6;
            // An even-order Chebyshev II ends at exactly its stopband level, so
            // "stopped" for it means at or below the attenuation asked for.
            const stopped = family === 'chebyshev2' ? -40 + 1e-6 : -60;
            if (passesDc) near(dc, 0, passTol, `${label}: DC passed`);
            else assert.ok(dc <= stopped, `${label}: DC stopped (${dc} dB)`);
            if (passesNyquist) near(nyq, 0, passTol, `${label}: Nyquist passed`);
            else assert.ok(nyq <= stopped, `${label}: Nyquist stopped (${nyq} dB)`);

            // The passband never exceeds 0 dB (Butterworth/Bessel/Chebyshev II)
            // or the ripple bound (Chebyshev I), sampled across it.
            const inPassband = f => (response === 'lowpass' ? f < cutoff[0]
                : response === 'highpass' ? f > cutoff[0]
                    : response === 'bandpass' ? f > cutoff[0] && f < cutoff[1]
                        : f < cutoff[0] || f > cutoff[1]);
            for (let f = 1; f < fs / 2; f += 1) {
                if (!inPassband(f)) continue;
                const g = designedMagnitudeDb(r.sos, f, fs);
                assert.ok(g <= 1e-6, `${label}: passband gain ${g} dB at ${f} Hz exceeds 0`);
                if (family === 'chebyshev1') assert.ok(g >= -1 - 1e-6, `${label}: ripple deeper than 1 dB at ${f} Hz (${g})`);
            }
            // Chebyshev II: the stopband stays at or below −40 dB beyond the edge.
            if (family === 'chebyshev2') {
                const inStopband = f => (response === 'lowpass' ? f > cutoff[0]
                    : response === 'highpass' ? f < cutoff[0]
                        : response === 'bandpass' ? f < cutoff[0] || f > cutoff[1]
                            : f > cutoff[0] && f < cutoff[1]);
                for (let f = 1; f < fs / 2; f += 1) {
                    if (!inStopband(f)) continue;
                    const g = designedMagnitudeDb(r.sos, f, fs);
                    assert.ok(g <= -40 + 1e-6, `${label}: stopband only ${g} dB at ${f} Hz`);
                }
            }
        }
    }
}

// Butterworth is monotone: the response never rises with frequency in a low-pass.
{
    const r = designFilter({ family: 'butterworth', response: 'lowpass', order: 6, cutoff: [100], sampleRate: fs });
    let previous = Infinity;
    for (let f = 0; f < fs / 2; f += 2) {
        const g = designedMagnitudeDb(r.sos, f, fs);
        assert.ok(g <= previous + 1e-9, `monotone: ${g} > ${previous} at ${f} Hz`);
        previous = g;
    }
}

// Chebyshev I reaches its full ripple depth somewhere inside the passband:
// the ripple is a specification, not an upper bound nobody meets.
{
    const r = designFilter({ family: 'chebyshev1', response: 'lowpass', order: 4, cutoff: [100], sampleRate: fs, rippleDb: 2 });
    let deepest = 0;
    for (let f = 0; f < 100; f += 0.25) deepest = Math.min(deepest, designedMagnitudeDb(r.sos, f, fs));
    near(deepest, -2, 1e-3, 'Chebyshev I ripple depth');
}

// ── The polynomial matches the sections, where the polynomial is sound ────

{
    const r = designFilter({ family: 'butterworth', response: 'bandpass', order: 2, cutoff: [100, 200], sampleRate: fs });
    const expanded = sosToTransferFunction(r.sos);
    nearList(expanded.b, r.b, 1e-12, 'expanded sections = designed b');
    nearList(expanded.a, r.a, 1e-12, 'expanded sections = designed a');
    // Same response by either route.
    const { b, a } = zpkToTransferFunction({ zeros: r.zeros, poles: r.poles, gain: r.gain });
    nearList(b, r.b, 1e-12, 'zpk → tf b');
    nearList(a, r.a, 1e-12, 'zpk → tf a');
}

// ── Why the sections exist: the polynomial fails where the cascade does not ──

{
    const r = designFilter({ family: 'butterworth', response: 'lowpass', order: 8, cutoff: [1], sampleRate: fs });
    assert.equal(inspectSos(r.sos).stable, true, 'order-8 Butterworth at fs/1000 runs as sections');
    // The very same design as one polynomial: rounding alone puts a pole across
    // the unit circle and the honest verdict on the polynomial is "unstable".
    assert.equal(inspectFilter(r.b, r.a).stable, false, 'the expanded polynomial is NOT stable — the reason sections exist');
    // And the cascade produces the right thing on a constant.
    const constant = new Float64Array(3000).fill(300);
    const out = applyFilter(constant, { sos: r.sos }).values;
    near(out[0], 300, 1e-6, 'steady start on a constant');
    near(out[2999], 300, 1e-6, 'constant preserved through the cascade');
}

// ── The SOS path through applyFilter equals the b/a path where both are sound ──

{
    const r = designFilter({ family: 'butterworth', response: 'lowpass', order: 2, cutoff: [0.1], sampleRate: 1 });
    const x = Float64Array.from({ length: 300 }, (_, i) => 300 + Math.sin(i * 0.3) + (i > 150 ? 5 : 0));
    x[70] = NaN;
    for (const mode of ['forward', 'zeroPhase']) {
        for (const init of ['steady', 'zero', 'level']) {
            const params = { mode, init, initState: [310], restartGap: 0 };
            const viaSos = applyFilter(x, { ...params, sos: r.sos }).values;
            const viaBa = applyFilter(x, { ...params, b: r.b, a: r.a }).values;
            for (let i = 0; i < x.length; i++) {
                if (Number.isNaN(viaBa[i])) { assert.ok(Number.isNaN(viaSos[i]), `${mode}/${init}: NaN kept at ${i}`); continue; }
                near(viaSos[i], viaBa[i], 1e-9, `${mode}/${init} sample ${i}`);
            }
        }
    }
    // A two-section cascade through the same machinery, with the steady state
    // propagated section by section (sosfilt_zi): a constant in is a constant out.
    const four = designFilter({ family: 'butterworth', response: 'lowpass', order: 4, cutoff: [0.05], sampleRate: 1 });
    const zis = cascadeInitialState(normalizeSos(four.sos));
    assert.equal(zis.length, 2, 'one state per section');
    const flat = applyFilter(new Float64Array(50).fill(-7), { sos: four.sos }).values;
    for (const value of flat) near(value, -7, 1e-9, 'constant through two sections');
    // Zero phase leaves a symmetric bump where it was.
    const bump = Float64Array.from({ length: 401 }, (_, i) => Math.exp(-((i - 200) ** 2) / 200));
    const zp = applyFilter(bump, { sos: four.sos, mode: 'zeroPhase' }).values;
    let peak = 0;
    for (let i = 1; i < zp.length; i++) if (zp[i] > zp[peak]) peak = i;
    assert.equal(peak, 200, 'zero phase keeps the peak in place');
    // Past samples cannot initialise a cascade: the kernel reads it as steady.
    const past = applyFilter(new Float64Array(20).fill(2), { sos: four.sos, init: 'past', initState: [1, 1, 1, 1, 1, 1, 1, 1] }).values;
    near(past[0], 2, 1e-9, 'past on a cascade falls back to steady state');
}

// The pipeline carries the sections and the specification through its meta.
{
    const r = designFilter({ family: 'bessel', response: 'lowpass', order: 3, cutoff: [50], sampleRate: fs });
    const values = Float64Array.from({ length: 100 }, (_, i) => Math.sin(i));
    const time = { values: Float64Array.from({ length: 100 }, (_, i) => i / fs), kind: 'numeric' };
    const step = runDataToolStep(values, time, { tool: 'filter', params: { sos: r.sos, b: r.b, a: r.a, design: r.design, source: 'design', mode: 'forward' } });
    assert.equal(step.meta.sos.length, 2, 'meta carries the sections');
    assert.equal(step.meta.design.family, 'bessel', 'meta carries the specification');
    assert.equal(step.values.length, 100);
}

// ── Validation ────────────────────────────────────────────────────────────

{
    const base = { family: 'butterworth', response: 'lowpass', order: 4, sampleRate: 1000 };
    const codeOf = params => { try { designFilter(params); return ''; } catch (err) { return err.code; } };
    assert.equal(codeOf({ ...base, cutoff: [500] }), 'dataToolFilterDesignCutoffNyquist', 'at Nyquist is refused');
    assert.equal(codeOf({ ...base, cutoff: [600] }), 'dataToolFilterDesignCutoffNyquist', 'above Nyquist is refused');
    assert.equal(codeOf({ ...base, cutoff: [0] }), 'dataToolFilterDesignCutoffPositive', 'zero is refused');
    assert.equal(codeOf({ ...base, cutoff: [-5] }), 'dataToolFilterDesignCutoffPositive', 'negative is refused');
    assert.equal(codeOf({ ...base, cutoff: [NaN] }), 'dataToolFilterDesignCutoffMissing', 'empty is refused');
    assert.equal(codeOf({ ...base, cutoff: [] }), 'dataToolFilterDesignCutoffMissing', 'no cut-off is refused');
    assert.equal(codeOf({ ...base, response: 'bandpass', cutoff: [200, 100] }), 'dataToolFilterDesignBandOrder', 'edges out of order');
    assert.equal(codeOf({ ...base, response: 'bandpass', cutoff: [100, 100] }), 'dataToolFilterDesignBandOrder', 'equal edges');
    assert.equal(codeOf({ ...base, response: 'bandpass', cutoff: [100] }), 'dataToolFilterDesignCutoffMissing', 'a band needs two edges');
    assert.equal(codeOf({ ...base, cutoff: [10], sampleRate: 0 }), 'dataToolFilterDesignNoRate', 'no rate');
    assert.equal(codeOf({ ...base, cutoff: [499.9] }), '', 'just below Nyquist is fine');
}

{
    const n = normalizeFilterDesign({ family: 'nonsense', response: 'bandstop', order: 99, cutoff: '5', rippleDb: -1, attenuationDb: 1e9 });
    assert.equal(n.family, 'butterworth', 'unknown family falls back');
    assert.equal(n.order, FILTER_DESIGN_MAX_ORDER, 'order is clamped');
    assert.deepEqual(n.cutoff.length, 2, 'a band-stop carries two edges');
    assert.equal(n.cutoff[0], 5);
    assert.ok(Number.isNaN(n.cutoff[1]), 'the missing edge is NaN, to be refused by the design');
    assert.equal(n.rippleDb, 1, 'a non-positive ripple falls back to the default');
    assert.equal(n.attenuationDb, 150, 'attenuation is capped');
    const lp = normalizeFilterDesign({ response: 'lowpass', cutoff: [5, 9] });
    assert.equal(lp.cutoff.length, 1, 'a low-pass keeps one edge');
}

// zpkToSos on a hand-made system: real poles pair up, a lone one stays first order.
{
    const sos = zpkToSos({ zeros: [[-1, 0], [-1, 0], [-1, 0]], poles: [[0.5, 0], [0.2, 0], [0.9, 0]], gain: 2 });
    assert.equal(sos.length, 2, 'three real poles → one quadratic and one first-order section');
    const first = sos.find(section => section[5] === 0 && section[2] === 0);
    assert.ok(first, 'a first-order section exists');
    for (const section of sos) assert.equal(schurCohnStable(section.slice(3)).stable, true);
    const { a } = sosToTransferFunction(sos);
    nearList(a, [1, -1.6, 0.73, -0.09], 1e-12, 'the sections multiply back to the polynomial');
}

// ── The panel ─────────────────────────────────────────────────────────────

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
            readOnly: false,
            placeholder: '',
            min: id.endsWith('-slider') ? '1' : '',
            max: id.endsWith('-slider') ? '12' : '',
            dataset: {},
            classList: {
                toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name),
            },
            setAttribute: () => {},
            toggleAttribute: (_name, on) => { element.disabled = !!on; },
            querySelector: () => null,
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
            _buildTree: variables => ({ _type: 'root', _name: '', _children: {}, _variables: { ...variables } }),
        };
        this.files = new Map();
        this._nextFileId = 1;
        this.plotManager = {
            files: new Map(),
            activeFileId: null,
            _extractUnit: description => (description.match(/\[([^\]]+)\]/) || [])[1] || '',
        };
    }
    get activeFileId() { return this.plotManager.activeFileId; }
}
installDataToolsMethods(Harness);
installResampleMethods(Harness);
installFilterMethods(Harness);

const withDocument = (mockDocument, fn) => {
    const previous = globalThis.document;
    globalThis.document = mockDocument;
    try { return fn(); } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
};

const addFile = (harness, { kind = 'numeric', unit = 's', step = 0.001, count = 200, time = null } = {}) => {
    const scale = kind === 'datetime' ? 1000 : 1;
    const axis = time || Float64Array.from({ length: count }, (_, i) => i * step * scale);
    const timeVariable = { name: 'time', data: axis, kind: 'abscissa', description: kind === 'datetime' ? '[datetime]' : `[${unit}]` };
    if (kind === 'datetime') timeVariable.timeKind = 'datetime';
    const data = {
        metadata: { timeName: 'time', timeKind: kind, numTimesteps: axis.length },
        variables: {
            time: timeVariable,
            signal: { name: 'signal', data: Float64Array.from({ length: axis.length }, (_, i) => Math.sin(i)), kind: 'variable', description: '[V]' },
        },
    };
    const fileId = `f${harness._nextFileId++}`;
    harness.files.set(fileId, { name: 'run', extension: '.csv', file: null, transform: {} });
    harness.plotManager.files.set(fileId, { name: 'run', data });
    harness.plotManager.activeFileId = fileId;
    return { fileId, data };
};

const designDom = (fields = {}) => fakeDocument({
    'data-tool-select': 'filter', 'outlier-variable': 'signal', 'filter-source': 'design',
    'filter-design-family': 'butterworth', 'filter-design-response': 'lowpass',
    'filter-design-order': '4', 'filter-design-order-slider': '4',
    'filter-design-cutoff': '50', 'filter-design-cutoff-high': '',
    'filter-design-ripple': '1', 'filter-design-attenuation': '40',
    'filter-mode': 'forward', 'filter-init': 'steady', 'filter-restart-gap': '0',
    ...fields,
});

// Sample rate from a numeric axis in seconds: 1 ms step → 1000 Hz.
{
    const h = new Harness();
    addFile(h, { step: 0.001 });
    withDocument(designDom(), () => {
        const rate = h._filterDesignRate();
        assert.equal(rate.ok, true);
        near(rate.sampleRate, 1000, 1e-9, 'fs from a 1 ms step');
        assert.equal(rate.unit, 'Hz');
        const plan = h._filterPlan();
        assert.equal(plan.ok, true, plan.text);
        assert.match(plan.text, /^Butterworth low-pass, order 4 · −3\.01 dB at 50 Hz$/);
        const config = h._getDataToolConfig('filter');
        assert.equal(config.params.source, 'design');
        assert.equal(config.params.sos.length, 2, 'two sections for order 4');
        near(config.params.design.sampleRate, 1000, 1e-9, 'the rate the design ran against is stored');
        assert.equal(config.params.design.unit, 'Hz');
        assert.deepEqual(config.params.design.cutoff, [50]);
        assert.equal(config.params.b.length, 5, 'the expanded polynomial is stored for display');
        // The description a definition carries.
        assert.equal(h._filterDescription(config.params), 'Butterworth low-pass, order 4, 50 Hz; forward');
        // The boxes received the polynomial, read-only.
        h._syncFilterControls();
        const bBox = document.getElementById('filter-b');
        assert.equal(bBox.readOnly, true, 'b is read-only in design mode');
        assert.ok(bBox.value.split(',').length === 5, `b box holds the five coefficients (${bBox.value})`);
        assert.equal(document.getElementById('filter-design-wrap').classList.contains('collapsed'), false);
        assert.equal(document.getElementById('filter-design-ripple-wrap').classList.contains('collapsed'), true, 'no ripple field for Butterworth');
        assert.match(document.getElementById('filter-design-rate').textContent, /1000 Hz · Nyquist 500 Hz/);
    });
}

// A millisecond axis converts to hertz; an unknown unit stays cycles per unit.
{
    const h = new Harness();
    addFile(h, { unit: 'ms', step: 2 });
    withDocument(designDom(), () => {
        const rate = h._filterDesignRate();
        near(rate.sampleRate, 500, 1e-9, '2 ms step in a [ms] axis → 500 Hz');
        assert.equal(rate.unit, 'Hz');
    });
    const g = new Harness();
    addFile(g, { unit: 'km', step: 0.5 });
    withDocument(designDom({ 'filter-design-cutoff': '0.2' }), () => {
        const rate = g._filterDesignRate();
        near(rate.sampleRate, 2, 1e-9, 'per axis unit');
        assert.equal(rate.unit, 'cycles per km');
        assert.equal(g._filterPlan().ok, true);
    });
}

// A calendar axis stores milliseconds; 100 ms steps are 10 Hz.
{
    const h = new Harness();
    addFile(h, { kind: 'datetime', step: 0.1 });
    withDocument(designDom({ 'filter-design-cutoff': '2' }), () => {
        const rate = h._filterDesignRate();
        near(rate.sampleRate, 10, 1e-9, 'datetime axis → Hz');
        assert.equal(h._filterPlan().ok, true);
    });
}

// No time axis: cycles per sample, Nyquist 0.5.
{
    const h = new Harness();
    const { data } = addFile(h);
    data.metadata.timeKind = 'index';
    withDocument(designDom({ 'filter-design-cutoff': '0.1' }), () => {
        const rate = h._filterDesignRate();
        assert.equal(rate.kind, 'index');
        assert.equal(rate.sampleRate, 1);
        assert.equal(rate.unit, 'cycles/sample');
        assert.equal(h._filterPlan().ok, true);
    });
    withDocument(designDom({ 'filter-design-cutoff': '0.5' }), () => {
        const plan = h._filterPlan();
        assert.equal(plan.code, 'dataToolFilterDesignCutoffNyquist');
        assert.match(plan.text, /0\.5 cycles\/sample/);
    });
}

// An irregular axis is a refusal in design mode — and the manual tool still runs.
{
    const h = new Harness();
    const time = Float64Array.from({ length: 200 }, () => 0);
    let t = 0;
    for (let i = 0; i < 200; i++) { t += 0.5 + ((i * 7919) % 13) / 13; time[i] = t; }
    addFile(h, { time });
    withDocument(designDom(), () => {
        const plan = h._filterPlan();
        assert.equal(plan.ok, false);
        assert.equal(plan.code, 'dataToolFilterDesignIrregular');
        assert.match(plan.text, /Resample/);
        assert.equal(h._dataToolCommitBlocker({ hasSource: true, hasValidConfig: true, editing: null, fileId: h.activeFileId, data: h.plotManager.files.get(h.activeFileId).data }),
            'dataToolFilterDesignIrregular', 'the Create buttons are blocked by name');
        assert.throws(() => h._getDataToolConfig('filter'), err => err.code === 'dataToolFilterDesignIrregular');
    });
    withDocument(designDom({ 'filter-source': 'manual', 'filter-b': '0.5, 0.5', 'filter-a': '1' }), () => {
        assert.equal(h._filterPlan().ok, true, 'typed coefficients are not refused on an irregular axis');
    });
    // Backwards time has its own sentence.
    const g = new Harness();
    addFile(g, { time: Float64Array.from({ length: 50 }, (_, i) => (i === 25 ? 3 : i)) });
    withDocument(designDom(), () => assert.equal(g._filterPlan().code, 'dataToolFilterDesignBackwards'));
}

// Cut-off validation reaches the panel with the Nyquist frequency spelled out.
{
    const h = new Harness();
    addFile(h, { step: 0.001 });
    withDocument(designDom({ 'filter-design-cutoff': '600' }), () => {
        const plan = h._filterPlan();
        assert.equal(plan.code, 'dataToolFilterDesignCutoffNyquist');
        assert.match(plan.text, /500 Hz/);
    });
    withDocument(designDom({ 'filter-design-cutoff': '' }), () => {
        assert.equal(h._filterPlan().code, 'dataToolFilterDesignCutoffMissing');
    });
    withDocument(designDom({ 'filter-design-response': 'bandpass', 'filter-design-cutoff': '80', 'filter-design-cutoff-high': '40' }), () => {
        assert.equal(h._filterPlan().code, 'dataToolFilterDesignBandOrder');
    });
    withDocument(designDom({ 'filter-design-response': 'bandpass', 'filter-design-cutoff': '40', 'filter-design-cutoff-high': '80', 'filter-design-family': 'chebyshev1', 'filter-design-ripple': '0.5' }), () => {
        const plan = h._filterPlan();
        assert.equal(plan.ok, true, plan.text);
        assert.match(plan.text, /^Chebyshev I band-pass, order 8 · −0\.5 dB \/ −0\.5 dB at 40 – 80 Hz$/);
        const config = h._getDataToolConfig('filter');
        assert.equal(h._filterDescription(config.params), 'Chebyshev I band-pass, order 4, 40–80 Hz, ripple 0.5 dB; forward');
        h._syncFilterControls();
        assert.equal(document.getElementById('filter-design-cutoff-high-wrap').classList.contains('collapsed'), false);
        assert.equal(document.getElementById('filter-design-ripple-wrap').classList.contains('collapsed'), false);
    });
}

// Past samples are withdrawn for a designed filter: the config never stores it.
{
    const h = new Harness();
    addFile(h, { step: 0.001 });
    withDocument(designDom({ 'filter-init': 'past', 'filter-init-x': '1, 2, 3, 4', 'filter-init-y': '1, 2, 3, 4' }), () => {
        h._syncFilterControls();
        assert.equal(document.getElementById('filter-init').value, 'steady', 'the select falls back to steady');
        const config = h._getDataToolConfig('filter');
        assert.equal(config.params.init, 'steady');
    });
}

// A stored definition round-trips: sections, specification and mode survive
// normalisation; a broken sections list demotes the definition to its b/a.
{
    const h = new Harness();
    addFile(h, { step: 0.001 });
    const config = withDocument(designDom(), () => h._getDataToolConfig('filter'));
    const restored = h._normalizeDataToolParams('filter', JSON.parse(JSON.stringify(config.params)));
    assert.equal(restored.source, 'design');
    assert.equal(restored.sos.length, 2);
    assert.equal(restored.design.family, 'butterworth');
    near(restored.design.sampleRate, 1000, 1e-9, 'restored sample rate');
    assert.equal(restored.design.unit, 'Hz');
    const out = applyFilter(new Float64Array(10).fill(1), restored).values;
    near(out[9], 1, 1e-9, 'the restored definition runs as a cascade');

    const broken = h._normalizeDataToolParams('filter', { ...config.params, sos: [[1, 2]] });
    assert.equal(broken.source, 'manual', 'a broken sections list falls back to manual');
    assert.equal(broken.sos, undefined);
    const legacy = h._normalizeDataToolParams('filter', { b: [0.5, 0.5], a: [1], mode: 'forward' });
    assert.equal(legacy.source, 'manual', 'a session from before design mode is a manual filter');

    // And the form is repopulated from the stored specification.
    withDocument(designDom({ 'filter-source': 'manual', 'filter-design-cutoff': '' }), () => {
        h._writeDataToolForm({ tool: 'filter', sourceName: 'signal', params: restored }, 'out');
        assert.equal(document.getElementById('filter-source').value, 'design');
        assert.equal(document.getElementById('filter-design-cutoff').value, '50');
        assert.equal(document.getElementById('filter-design-order').value, '4');
    });
}

// The causality picker is not part of a design (#121).
//
// It anchors each side of an equation the reader typed — which is why its help
// talks about where b0 and a0 sit. A design writes that equation itself (the
// coefficient boxes are read-only while it owns them), so there is nothing to
// anchor, and the future is already reachable the way a designed filter
// reaches it: Forward and back.
{
    const h = new Harness();
    addFile(h, { step: 0.001 });
    withDocument(designDom({ 'filter-causality': 'nonCausal', 'filter-advance-a': '1', 'filter-advance-b': '3' }), () => {
        h._syncFilterControls();
        assert.equal(document.getElementById('filter-causality-wrap').classList.contains('collapsed'), true,
            'the picker is off screen while a specification owns the coefficients');
        assert.deepEqual({ ...h._filterAnchors() }, { causal: true, advanceA: 0, advanceB: 0, advance: 0 },
            'and the numbers left behind in its boxes reach nothing');
        const config = h._getDataToolConfig('filter');
        assert.equal(config.params.advance, 0, 'so the definition carries no advance');
        assert.equal(config.params.advanceB, 0);
    });

    // Typing b and a is where an anchor means something, and there it still does.
    withDocument(designDom({
        'filter-source': 'manual', 'filter-b': '1', 'filter-a': '1',
        'filter-causality': 'nonCausal', 'filter-advance-a': '1', 'filter-advance-b': '3',
    }), () => {
        h._syncFilterControls();
        assert.equal(document.getElementById('filter-causality-wrap').classList.contains('collapsed'), false,
            'the picker comes back for a typed equation');
        assert.equal(h._getDataToolConfig('filter').params.advance, 2);
    });

    // A definition saved while the picker was still on screen in design mode
    // carried an advance that would shift the output. Reading it back drops it.
    const designed = withDocument(designDom(), () => h._getDataToolConfig('filter'));
    const stale = h._normalizeDataToolParams('filter', {
        ...JSON.parse(JSON.stringify(designed.params)), advanceA: 0, advanceB: 4, advance: 4,
    });
    assert.equal(stale.source, 'design', 'still a design');
    assert.equal(stale.advance, 0, 'which anchors nothing, whatever the session says');
    assert.equal(stale.advanceA, 0);
    assert.equal(stale.advanceB, 0);
}

console.log('filter design tests passed');
