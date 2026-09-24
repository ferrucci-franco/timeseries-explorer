// The Samples toggle (docs/sample-markers-design.md): when a time-series trace
// may draw its samples as dots. The decision is a pure function; the window it
// judges comes from _buildTimeseriesVisualData, which is extracted from source
// and run against a small mock `this`, like test-missing-data does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    sampleMarkersVisible,
    SAMPLE_MARKERS_MIN_PX_ON,
    SAMPLE_MARKERS_MIN_PX_OFF,
} from '../src/utils/sample-markers.js';
import { visualPairForRange } from '../src/compute/kernels/resample.js';

// ── The decision ──
{
    assert.equal(SAMPLE_MARKERS_MIN_PX_ON, 4);
    assert.equal(SAMPLE_MARKERS_MIN_PX_OFF, 3);
    const decide = (over) => sampleMarkersVisible({ exact: true, visibleCount: 100, plotWidthPx: 400, ...over });

    assert.equal(decide({}), true, '4 px per sample turns dots on');
    assert.equal(decide({ visibleCount: 101 }), false, 'just under 4 px does not');
    assert.equal(decide({ exact: false }), false, 'a decimated window never gets dots, however wide');
    assert.equal(decide({ exact: false, visibleCount: 2 }), false, 'not even with room to spare');

    // Hysteresis: between 3 and 4 px the previous answer stands.
    assert.equal(decide({ visibleCount: 120, wasShown: false }), false, '3.33 px: stays off when it was off');
    assert.equal(decide({ visibleCount: 120, wasShown: true }), true, '3.33 px: stays on when it was on');
    assert.equal(decide({ visibleCount: 134, wasShown: true }), false, 'below 3 px: goes off');

    assert.equal(decide({ plotWidthPx: 0 }), false, 'axis not laid out: no claim');
    assert.equal(decide({ plotWidthPx: undefined }), false, 'no width at all: no claim');
    assert.equal(decide({ visibleCount: 0 }), false, 'nothing visible: nothing to mark');
    assert.equal(decide({ visibleCount: 1 }), true, 'one lone sample has all the room there is');

    assert.equal(decide({ visibleCount: 50, minPxOn: 10 }), false, 'thresholds are parameters');
    assert.equal(decide({ visibleCount: 40, minPxOn: 10 }), true);
}

// ── The window: exact and visible count come from the visual builder ──
const dataMethodsSource = readFileSync(new URL('../src/plots/methods/data-methods.js', import.meta.url), 'utf8');
const methodSource = (name) => {
    const marker = `proto.${name} = function`;
    const start = dataMethodsSource.indexOf(marker);
    assert.ok(start >= 0, `${name} is present in data-methods.js`);
    const next = dataMethodsSource.indexOf('\nproto.', start + marker.length);
    return dataMethodsSource.slice(start, next >= 0 ? next : dataMethodsSource.length);
};

class Harness {
    constructor({ target = 2000, files = {} } = {}) {
        this.timeseriesVisualMaxPoints = target;
        this.files = new Map(Object.entries(files));
    }
    _coerceAxisValue(v) { return Number(v); }
}
const PlotManager = {
    VISUAL_MAX_POINTS_TIMESERIES: 2000,
    SAMPLE_MARKERS_MIN_PX_ON,
    SAMPLE_MARKERS_MIN_PX_OFF,
    SAMPLE_MARKER_SIZE: 5,
};
vm.runInNewContext([
    methodSource('_downsampleTimeseries'),
    methodSource('_lowerBound'),
    methodSource('_upperBound'),
    methodSource('_buildTimeseriesVisualData'),
    methodSource('_timeseriesSamplesEnabled'),
    methodSource('_timeseriesSampleMarkersEligible'),
    methodSource('_timeseriesSampleMarkersShown'),
    methodSource('_timeseriesSampleMarker'),
].join('\n'), {
    proto: Harness.prototype,
    PlotManager,
    visualPairForRange,
    sampleMarkersVisible,
    WeakMap,
});

const ramp = (n) => Float64Array.from({ length: n }, (_, i) => i);

{
    const h = new Harness({ target: 2000 });
    const t = ramp(10000);
    const y = ramp(10000);

    const full = h._buildTimeseriesVisualData(t, y);
    assert.equal(full.sampleWindow.exact, false, 'the whole 10k series is decimated to 2k');
    assert.equal(full.sampleWindow.visibleCount, 10000);

    const zoomed = h._buildTimeseriesVisualData(t, y, [100, 199]);
    assert.equal(zoomed.sampleWindow.exact, true, 'a 100-sample window is copied verbatim');
    assert.equal(zoomed.sampleWindow.visibleCount, 100, 'visible count excludes the one-sample padding');
    assert.equal(zoomed.x.length, 102, 'the drawn window keeps its padding either side');

    const wide = h._buildTimeseriesVisualData(t, y, [0, 5000]);
    assert.equal(wide.sampleWindow.exact, false, 'a 5k window exceeds the 2k budget');

    const small = h._buildTimeseriesVisualData(ramp(500), ramp(500));
    assert.equal(small.sampleWindow.exact, true, 'a series under the budget is exact without a range');
    assert.equal(small.sampleWindow.visibleCount, 500);

    const off = new Harness({ target: null });
    const all = off._buildTimeseriesVisualData(t, y, [0, 5000]);
    assert.equal(all.sampleWindow.exact, true, 'downsampling off: always exact');
    assert.equal(all.sampleWindow.visibleCount, 5001, 'and the count is still the visible one');

    const outside = h._buildTimeseriesVisualData(t, y, [20000, 30000]);
    assert.equal(outside.sampleWindow.visibleCount, 0, 'a window past the data holds nothing');
}

// Repeated timestamps are samples like any other: a burst at one instant is
// counted in full, since each of those rows is drawn.
{
    const h = new Harness({ target: 2000 });
    const t = Float64Array.from([0, 1, 2, 2, 2, 3, 4]);
    const w = h._buildTimeseriesVisualData(t, ramp(7), [1, 3]);
    assert.equal(w.sampleWindow.visibleCount, 5, 'the three rows at t = 2 all count');
    assert.equal(w.sampleWindow.exact, true);
}

// ── Eligibility and per-trace hysteresis ──
{
    const eager = { data: { variables: { v: { kind: 'variable' }, p: { kind: 'parameter' } } } };
    const lazy = { data: { _duckdb: {}, variables: { v: { kind: 'variable' } } } };
    const h = new Harness({ files: { eager, lazy } });
    const plot = { mode: 'timeseries', showSamples: true, div: { _fullLayout: { xaxis: { _length: 400 } } } };
    const tv = { fileId: 'eager', varName: 'v', color: '#123' };
    const window = (visibleCount, exact = true) => ({ sampleWindow: { exact, visibleCount } });

    assert.equal(h._timeseriesSampleMarkersShown(plot, tv, window(100)), true, 'room for dots');
    assert.equal(h._timeseriesSampleMarkersShown(plot, tv, window(120)), true, 'hysteresis keeps them');
    assert.equal(h._timeseriesSampleMarkersShown(plot, tv, window(134)), false, 'below 3 px they go');
    assert.equal(h._timeseriesSampleMarkersShown(plot, tv, window(120)), false, 'and do not come back until 4 px');

    const other = { fileId: 'eager', varName: 'v', color: '#456' };
    assert.equal(h._timeseriesSampleMarkersShown(plot, other, window(100)), true, 'state is per trace');

    assert.equal(h._timeseriesSampleMarkersShown(plot, { fileId: 'lazy', varName: 'v' }, window(10)), false,
        'a memory-saving (lazy) file never gets dots');
    assert.equal(h._timeseriesSampleMarkersShown(plot, { fileId: 'eager', varName: 'p' }, window(2)), false,
        'a parameter is not samples');
    assert.equal(h._timeseriesSampleMarkersShown(plot, { ...tv, markersOnly: true }, window(10)), false,
        'a markers-only preview keeps its own markers');

    assert.equal(h._timeseriesSampleMarkersShown({ ...plot, showSamples: false }, tv, window(10)), false, 'toggle off');
    assert.equal(h._timeseriesSampleMarkersShown({ ...plot, timeseriesStacked: true }, tv, window(10)), false,
        'stacked y is cumulative, so no dots');
    assert.equal(h._timeseriesSampleMarkersShown({ ...plot, mode: 'fft' }, tv, window(10)), false,
        'only the time-series panel');
    assert.equal(h._timeseriesSampleMarkersShown({ ...plot, div: null }, tv, window(10)), false,
        'before the axis lays out there is no width to judge');

    const marker = h._timeseriesSampleMarker(tv);
    assert.equal(marker.color, '#123');
    assert.equal(marker.size, 5);
}

console.log('sample markers tests passed');
