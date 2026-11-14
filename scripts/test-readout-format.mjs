// The numbers in the hover boxes (utils/readout-format.js) and the readout a
// declared trace carries (utils/hover-readout.js), which src/vendor/plotly.js
// writes on every draw and restyle. The browser side is
// scripts/e2e-hover-readout.mjs.
import assert from 'node:assert/strict';
import {
    formatReadout,
    formatReadouts,
    readoutDigitsForResolution,
    unitTakesPrefix,
} from '../src/utils/readout-format.js';
import {
    HOVER_READOUT_POINT_LIMIT,
    HOVER_READOUT_TOKEN,
    buildHoverReadoutText,
    fillHoverReadout,
    hoverReadoutRestyle,
} from '../src/utils/hover-readout.js';

const dot = { decimal: '.' };
const comma = { decimal: ',' };
const read = (value, options = {}) => formatReadout(value, { format: dot, ...options });

// ── The case that started it: the spectrum's period and amplitude ──
assert.equal(read(0.000627379, { unit: 's' }), '627.4 µs', 'a period under a millisecond reads in µs');
assert.equal(read(0.00721255), '7.213 m', 'a small unitless amplitude takes the prefix alone');
assert.equal(read(0.00721255, { unit: 'V' }), '7.213 mV', 'with a unit, the prefix joins it');

// ── Four significant digits, trailing zeros dropped ──
assert.equal(read(0.1234567, { unit: 'V' }), '0.1235 V', 'inside 0.01–10 000 a value stays a plain decimal');
assert.equal(read(1593.93, { unit: 'Hz' }), '1594 Hz', 'four digits, not six');
assert.equal(read(1), '1', 'no padding zeros ("1.000")');
assert.equal(read(12.5, { unit: '%' }), '12.5 %', 'a percentage');
assert.equal(read(0.01), '0.01', 'the lower edge of the band is plain');
assert.equal(read(9999), '9999', 'the top of the band is plain, ungrouped');
assert.equal(read(9999.96), '10 k', 'rounding up across 10 000 moves to the prefixed side');
assert.equal(read(123456, { unit: 'Pa' }), '123.5 kPa', 'large values take k, M, G…');
assert.equal(read(2.5e9, { unit: 'Hz' }), '2.5 GHz');
assert.equal(read(-0.000999996, { unit: 'V' }), '−1 mV', '999.996 µ rounds to 1 m, with a true minus sign');
assert.equal(read(-0.25), '−0.25', 'a negative plain value uses U+2212 like Plotly');
assert.equal(read(0, { unit: 'V' }), '0 V');

// ── Never an exponent ──
for (const value of [1e-5, 1.2345e-7, 4.2e-11, 3.3e7, 12345, 6.02e23]) {
    assert.doesNotMatch(read(value, { unit: 's' }), /e[-+]?\d/i, `${value} reads without an exponent`);
}
assert.equal(read(1e-30, { unit: 's' }), '1×10⁻³⁰ s', 'past the prefixes, a power of ten — still no "e"');

// ── Units that do not take a prefix ──
assert.equal(unitTakesPrefix('V'), true);
assert.equal(unitTakesPrefix('m/s'), true, 'a compound unit takes one when its first symbol does');
assert.equal(unitTakesPrefix('V/√Hz'), true);
assert.equal(unitTakesPrefix('°C'), false);
assert.equal(unitTakesPrefix('kg'), false, 'a unit that already carries a prefix');
assert.equal(unitTakesPrefix('ms'), false);
assert.equal(unitTakesPrefix('min'), false);
assert.equal(unitTakesPrefix('dB'), false);
assert.equal(unitTakesPrefix('%'), false);
assert.equal(read(0.00123, { unit: '°C' }), '1.23×10⁻³ °C', '"1.23 m°C" would be wrong; a power of ten is not');
assert.equal(read(0.00123, { unit: 'kg' }), '1.23×10⁻³ kg', '"1.23 mkg" would be wrong');
assert.equal(read(0.0012, { unit: 'm/s' }), '1.2 mm/s');
assert.equal(read(-0.005, { unit: 'dB' }), '−5×10⁻³ dB');

// ── The decimal mark from Settings ──
assert.equal(formatReadout(0.000627379, { unit: 's', format: comma }), '627,4 µs');
assert.equal(formatReadout(0.1234, { unit: 'V', format: comma }), '0,1234 V');
assert.equal(formatReadout(1234.5, { format: { decimal: ',', group: '.', groupFrom: 4 } }), '1235',
    'never grouped: "1.235" next to a decimal comma would read as one and a bit');

// ── Not a number ──
assert.equal(read(NaN), '—');
assert.equal(read(null), '—');
assert.equal(read(undefined), '—');
assert.equal(read(Infinity, { unit: 's' }), '∞');
assert.equal(read(-Infinity), '−∞');

// ── An abscissa keeps the digits its resolution needs ──
assert.equal(readoutDigitsForResolution(1593.93, 0.26), 5, 'down to the step, plus one');
assert.equal(readoutDigitsForResolution(5, 1), 4, 'never fewer than four');
assert.equal(readoutDigitsForResolution(1000.000001, 1e-9), 14);
assert.equal(read(1593.93, { unit: 'Hz', resolution: 0.26 }), '1593.9 Hz');
assert.notEqual(read(1593.93, { unit: 'Hz', resolution: 0.26 }), read(1594.19, { unit: 'Hz', resolution: 0.26 }),
    'two neighbouring bins never read the same');
assert.equal(read(0.000123456, { unit: 's', resolution: 1e-9 }), '123.456 µs', 'a fine time axis keeps its digits');
assert.equal(read(12345, { resolution: 1 }), '12.345 k', 'an integer axis reads exactly, not "1.234e+4"');

assert.deepEqual(formatReadouts([0.001, 0.5, 2000], { unit: 'V', format: dot }), ['1 mV', '0.5 V', '2000 V']);

// ── A declared trace's readout ──
const spec = {
    lines: [
        { label: '<b>Time</b>', source: 'x', unit: 's', resolution: 5e-6 },
        { label: '<b>sig</b>', source: 'y', unit: 'V' },
    ],
    fallback: '<b>Time</b> = %{x:.6g} s<br><b>sig</b> = %{y:.4~g} V',
};
assert.deepEqual(
    buildHoverReadoutText(spec, { x: [0.00025, 0.004], y: [0.003, -0.0001884] }, dot),
    ['<b>Time</b> = 250 µs<br><b>sig</b> = 3 mV', '<b>Time</b> = 4 ms<br><b>sig</b> = −188.4 µV'],
);
assert.deepEqual(
    buildHoverReadoutText({ lines: [{ label: 'v', source: 'y', unit: '<x>' }] }, { y: [1] }, dot),
    ['v = 1 &lt;x&gt;'],
    'a unit from the file is escaped: the readout is HTML',
);

// The spectrum's lines: the other reading of x, a 'local' resolution, and the
// natural duration of a long period.
const spectrum = {
    lines: [
        { label: 'F', source: 'x', unit: 'Hz', resolution: 'local' },
        { label: 'P', source: 'x', unit: 's', map: 'reciprocal', suffix: 'naturalDuration' },
        { label: 'A', source: 'y' },
    ],
};
const [zero, slow, , fast] = buildHoverReadoutText(spectrum,
    { x: [0, 1 / 3600, 1593.67, 1593.93], y: [0.1, 0.002, 0.003, 0.00721255] }, dot);
assert.equal(zero, 'F = 0 Hz<br>P = ∞<br>A = 0.1', 'the zero bin has an infinite period');
assert.match(slow, /P = 3600 s \(1 h\)/, 'an hour-long period also reads as a duration');
assert.equal(fast, 'F = 1593.9 Hz<br>P = 627.4 µs<br>A = 7.213 m');

// customdata columns
assert.deepEqual(
    buildHoverReadoutText({ lines: [{ label: 'σ', source: 'customdata', index: 0, unit: 'V' }] },
        { customdata: [[0.002, 'x'], [5, 'y']] }, dot),
    ['σ = 2 mV', 'σ = 5 V'],
);

// ── fillHoverReadout: in place, and the fallback past the point limit ──
const trace = {
    x: [0.001, 0.002], y: [0.5, 0.25],
    hovertemplate: `${HOVER_READOUT_TOKEN}<extra></extra>`,
    _hoverReadout: structuredClone(spec),
};
fillHoverReadout(trace, dot);
assert.deepEqual(trace.hovertext, ['<b>Time</b> = 1 ms<br><b>sig</b> = 0.5 V', '<b>Time</b> = 2 ms<br><b>sig</b> = 0.25 V']);
assert.equal(trace.hovertemplate, `${HOVER_READOUT_TOKEN}<extra></extra>`);

const huge = HOVER_READOUT_POINT_LIMIT + 1;
const long = {
    x: new Float64Array(huge), y: new Float64Array(huge),
    hovertemplate: `${HOVER_READOUT_TOKEN}<extra></extra>`,
    _hoverReadout: structuredClone(spec),
};
fillHoverReadout(long, dot);
assert.equal(long.hovertext, undefined, 'no string per point for a trace drawn without downsampling');
assert.equal(long.hovertemplate, `${spec.fallback}<extra></extra>`, 'the d3 fallback takes the readout\'s place');
// …and when the trace is short again, its own template comes back.
long.x = [1, 2];
long.y = [1, 2];
fillHoverReadout(long, dot);
assert.equal(long.hovertemplate, `${HOVER_READOUT_TOKEN}<extra></extra>`);
assert.equal(long.hovertext.length, 2);

// ── hoverReadoutRestyle: the readout follows every redraw ──
const plain = { x: [1], y: [1], hovertemplate: 'own', hovertext: 'kept' };
const data = [
    plain,
    { x: [0.001], y: [0.5], hovertemplate: `${HOVER_READOUT_TOKEN}`, _hoverReadout: structuredClone(spec) },
];
fillHoverReadout(data[1], dot);

assert.equal(hoverReadoutRestyle(data, { visible: false }, [1], dot).hovertext, undefined,
    'an update that touches no data leaves the readout alone');

const zoom = hoverReadoutRestyle(data, { x: [[0.004, 0.005]], y: [[0.002, 0.003]] }, [1], dot);
assert.deepEqual(zoom.hovertext, [['<b>Time</b> = 4 ms<br><b>sig</b> = 2 mV', '<b>Time</b> = 5 ms<br><b>sig</b> = 3 mV']],
    'a zoom carries the readout of the new points');
assert.deepEqual(zoom.hovertemplate, [HOVER_READOUT_TOKEN]);

const onlyY = hoverReadoutRestyle(data, { y: [[0.007]] }, [1], dot);
assert.deepEqual(onlyY.hovertext, [['<b>Time</b> = 1 ms<br><b>sig</b> = 7 mV']], 'x missing from the update is the drawn x');

const both = hoverReadoutRestyle(data, { x: [[5], [0.002]], y: [[6], [0.004]] }, [0, 1], comma);
assert.deepEqual(both.hovertext, ['kept', ['<b>Time</b> = 2 ms<br><b>sig</b> = 4 mV']],
    'an undeclared trace in the same restyle keeps its own hovertext');
assert.deepEqual(both.hovertemplate, ['own', HOVER_READOUT_TOKEN]);

const relabel = hoverReadoutRestyle(data, { name: ['n'], hovertemplate: [`X${HOVER_READOUT_TOKEN}`] }, [1], comma);
assert.deepEqual(relabel.hovertemplate, [`X${HOVER_READOUT_TOKEN}`], 'a per-trace template array is one template per trace');
assert.deepEqual(relabel.hovertext, [['<b>Time</b> = 1 ms<br><b>sig</b> = 0,5 V']], 'and a new template rewrites the readout');

assert.equal(hoverReadoutRestyle(data, 'visible', [1], dot), 'visible', 'the string form passes through');

console.log('Readout format checks passed.');
