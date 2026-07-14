import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

const FILE_ID = 'stack-downsampling-fixture';
const SAMPLE_COUNT = 4097;
const VISUAL_POINT_LIMIT = 96;

const time = Float64Array.from({ length: SAMPLE_COUNT }, (_, index) => index * 0.01);
const signalA = Float64Array.from(
    { length: SAMPLE_COUNT },
    (_, index) => 1.4 * Math.sin(index * 0.037),
);
const signalB = Float64Array.from(
    { length: SAMPLE_COUNT },
    (_, index) => 0.9 * Math.cos(index * 0.053 + 0.31),
);

class Harness {
    static GL_POINT_THRESHOLD = 50000;

    constructor() {
        this.activeFileId = FILE_ID;
        this.language = 'en';
        this.timeseriesVisualMaxPoints = VISUAL_POINT_LIMIT;
        this.files = new Map([[FILE_ID, {
            name: 'stack-downsampling-fixture.csv',
            transform: {},
            data: {
                metadata: { timeName: 'time' },
                variables: {
                    time: {
                        name: 'time',
                        kind: 'abscissa',
                        timeKind: 'numeric',
                        description: 'Time [s]',
                        data: time,
                    },
                    signalA: {
                        name: 'signalA',
                        kind: 'variable',
                        dataType: 'real',
                        description: 'Signal A [V]',
                        data: signalA,
                    },
                    signalB: {
                        name: 'signalB',
                        kind: 'variable',
                        dataType: 'real',
                        description: 'Signal B [V]',
                        data: signalB,
                    },
                },
            },
        }]]);
    }

    _getTimeVar(fileId = this.activeFileId) {
        const data = this.files.get(fileId)?.data;
        return data?.variables?.[data.metadata.timeName] ?? null;
    }

    _isVisible(trace) {
        return trace?.visible !== false && trace?.visible !== 'legendonly';
    }

    _extractUnit(description = '') {
        return /\[([^\]]+)\]/.exec(description)?.[1] || '';
    }

    _traceName(name) {
        return name;
    }

    _escapeHTML(value) {
        return String(value);
    }

    _formatHTMLNumber(value) {
        return String(value);
    }
}

installPlotDataMethods(Harness);

const traceStates = [
    { fileId: FILE_ID, varName: 'signalA', color: '#2196f3' },
    { fileId: FILE_ID, varName: 'signalB', color: '#ff5722' },
];
const plot = {
    mode: 'timeseries',
    traces: traceStates,
    timeseriesStacked: true,
    timeseriesY2Enabled: false,
};
const harness = new Harness();

const crossesZero = values => {
    let negative = false;
    let positive = false;
    for (const value of values) {
        if (value < 0) negative = true;
        if (value > 0) positive = true;
    }
    return negative && positive;
};

const isStrictlyIncreasing = values => {
    for (let index = 1; index < values.length; index++) {
        if (!(Number(values[index]) > Number(values[index - 1]))) return false;
    }
    return true;
};

assert.ok(crossesZero(signalA), 'fixture A crosses zero');
assert.ok(crossesZero(signalB), 'fixture B crosses zero');

const traces = traceStates.map((trace, index) => harness._buildTimeTrace(trace, null, plot, index));
assert.ok(traces.every(Boolean), 'both stacked traces are built');
assert.ok(
    traces.every(trace => trace.x.length <= VISUAL_POINT_LIMIT && trace.x.length < SAMPLE_COUNT),
    'both oscillating signals exercise visual downsampling',
);
assert.ok(traces.every(trace => crossesZero(trace.y)), 'downsampling preserves both signs');
assert.ok(traces.every(trace => isStrictlyIncreasing(trace.x)), 'rendered traces contain no duplicate X values');

const xSets = traces.map(trace => new Set(Array.from(trace.x, Number)));
const onlyInA = [...xSets[0]].filter(value => !xSets[1].has(value));
const onlyInB = [...xSets[1]].filter(value => !xSets[0].has(value));
assert.ok(
    onlyInA.length > 0 && onlyInB.length > 0,
    'independent min/max downsampling produces the mismatched X arrays that triggered the artifact',
);

for (const [index, trace] of traces.entries()) {
    assert.equal(trace.type, 'scatter', `stacked trace ${index + 1} uses SVG scatter`);
    assert.equal(trace.stackgroup, 'timeseries-stack', `stacked trace ${index + 1} belongs to the stack group`);
    assert.equal(
        trace.stackgaps,
        'interpolate',
        `stacked trace ${index + 1} interpolates internal X gaps instead of inferring false zero samples`,
    );
}

assert.equal(traces[0].fill, 'tozeroy', 'first trace fills to the baseline');
assert.equal(traces[1].fill, 'tonexty', 'second trace fills to the previous trace');

console.log('Time-series Stack regression tests passed.');
