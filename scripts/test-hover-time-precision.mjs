// The time readout in a time-series hover has to distinguish the sample under
// the cursor from its neighbour.
//
// It was fixed at four significant digits. On a record sampled every 100 ns
// that makes 0.1234567 s and 0.1234568 s both read "0.1235": the hover says the
// same thing wherever the reader moves, which is the one thing it exists not to
// do. From the other end, sample 12345 of an index axis read "1.234e+4".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';
import {
    HOVER_MAX_SIGNIFICANT_DIGITS,
    HOVER_MIN_SIGNIFICANT_DIGITS,
    hoverNumberFormat,
    hoverSignificantDigits,
} from '../src/utils/hover-precision.js';

const ramp = (start, step, count) => Float64Array.from({ length: count }, (_, i) => start + i * step);

// ─── The kernel ────────────────────────────────────────────────────
// An ordinary axis reads exactly as it did before.
assert.equal(hoverSignificantDigits(ramp(0, 0.01, 1001)), HOVER_MIN_SIGNIFICANT_DIGITS,
    '10 ms over 10 s needs no more than the four digits it always had');

// The reported case: a 100 ns step.
const fine = hoverSignificantDigits(ramp(0, 1e-7, 100_000));
assert.ok(fine >= 6, `a 100 ns step needs more than four digits (got ${fine})`);
assert.ok((0.0012345).toPrecision(fine) !== (0.0012346).toPrecision(fine),
    'and enough of them to tell two neighbouring samples apart');

// An axis that starts far from zero spends digits on the offset before it can
// spend any on the step, so it needs more of them.
assert.ok(
    hoverSignificantDigits(ramp(1000, 1e-7, 100_000)) > fine,
    'an offset axis needs the digits its magnitude eats, not just its step',
);

// The index axis, from the other end: 20000 samples must not print as 2e+4.
const indexDigits = hoverSignificantDigits(ramp(0, 1, 20_001));
assert.ok(indexDigits >= 5, `a 20,001-sample index axis needs 5+ digits (got ${indexDigits})`);

// Never past what a double carries: more digits only print binary noise.
assert.equal(hoverSignificantDigits(ramp(1000, 1e-15, 1_000_000)), HOVER_MAX_SIGNIFICANT_DIGITS,
    'the digit count stops where the double does');

// Degenerate axes fall back instead of throwing or asking for NaN digits.
for (const [label, values] of [
    ['empty', []],
    ['one sample', [1]],
    ['constant', [5, 5, 5]],
    ['all NaN', [NaN, NaN, NaN]],
    ['null', null],
]) {
    assert.equal(hoverSignificantDigits(values), HOVER_MIN_SIGNIFICANT_DIGITS, `${label} falls back`);
}

// A NaN at either end is ordinary and must not cost the axis its digits.
const holed = Array.from(ramp(0, 1e-7, 50_000));
holed[0] = NaN;
holed[holed.length - 1] = NaN;
assert.ok(hoverSignificantDigits(holed) >= 6, 'a NaN at the edge does not reset the precision');

assert.equal(hoverNumberFormat(ramp(0, 0.01, 1001)), '.4g', 'the format is a d3 spec');

// ─── Through the trace the panel actually builds ───────────────────
const FILE_ID = 'hover-fixture';

class Harness {
    static GL_POINT_THRESHOLD = 50_000;

    constructor(step, count) {
        this.activeFileId = FILE_ID;
        this.language = 'en';
        this.timeseriesVisualMaxPoints = 2000;
        const time = ramp(0, step, count);
        const values = Float64Array.from({ length: count }, (_, i) => Math.sin(i * 0.01));
        this.files = new Map([[FILE_ID, {
            name: 'hover-fixture.csv',
            transform: {},
            data: {
                metadata: { timeName: 'time' },
                variables: {
                    time: { name: 'time', kind: 'abscissa', timeKind: 'numeric', description: 'Time [s]', data: time },
                    y: { name: 'y', kind: 'variable', dataType: 'real', description: 'Signal [V]', data: values },
                },
            },
        }]]);
    }

    _getTimeVar(fileId = this.activeFileId) {
        const data = this.files.get(fileId)?.data;
        return data?.variables?.[data.metadata.timeName] ?? null;
    }

    _isVisible(trace) { return trace?.visible !== false && trace?.visible !== 'legendonly'; }
    _extractUnit(description = '') { return /\[([^\]]+)\]/.exec(description)?.[1] || ''; }
    _traceName(name) { return name; }
    _escapeHTML(value) { return String(value); }
    _formatHTMLNumber(value) { return String(value); }
}

installPlotDataMethods(Harness);

const hoverFormatOf = (step, count) => {
    const harness = new Harness(step, count);
    const trace = { fileId: FILE_ID, varName: 'y', color: '#2196f3' };
    const plot = { mode: 'timeseries', traces: [trace], timeseriesStacked: false, timeseriesY2Enabled: false };
    const built = harness._buildTimeTrace(trace, null, plot, 0);
    return /Time \[s\]<\/b> = %\{x:(\.\d+g)\}/.exec(built.hovertemplate)?.[1];
};

assert.equal(hoverFormatOf(0.01, 1001), '.4g', 'an ordinary axis keeps its four digits');
const fineFormat = hoverFormatOf(1e-7, 100_000);
assert.ok(fineFormat && Number(fineFormat.slice(1, -1)) >= 6,
    `the 100 ns trace asks Plotly for more digits (got ${fineFormat})`);

// The decimated x array is what Plotly gets, but the digits come from the file:
// decimation drops samples, it does not make the timestamps coarser.
assert.equal(hoverFormatOf(1e-7, 100_000), hoverFormatOf(1e-7, 100_000), 'stable across builds');

const dataMethods = readFileSync(new URL('../src/plots/methods/data-methods.js', import.meta.url), 'utf8');
assert.match(dataMethods, /hoverNumberFormat\(timeData\)/, 'the time hover asks the axis how many digits it needs');
assert.doesNotMatch(dataMethods, /Time \[\$\{hoverTimeUnit\}\]<\/b> = %\{x:\.4g\}/,
    'the hardcoded four digits are gone from the time readout');

console.log('Hover time-precision checks passed.');
