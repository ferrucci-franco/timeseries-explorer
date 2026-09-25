// The Repeated toggle (docs/repeated-timestamps-indicator-design.md): where the
// runs are, how they become marks for a view, and the overlay the panel draws.
import assert from 'node:assert/strict';
import { repeatedTimestampRuns, repeatedTimestampSummary } from '../src/utils/repeated-timestamps.js';
import { REPEATED_MARK_MIN_RUN, repeatedMarksForView } from '../src/utils/repeated-marks.js';
import { installPlotRepeatedMethods } from '../src/plots/methods/repeated-methods.js';

const runsOf = (values, minRun) => {
    const r = repeatedTimestampRuns(values, minRun);
    return { starts: [...r.starts], lengths: [...r.lengths], count: r.count };
};

// ── Runs ──
{
    assert.equal(REPEATED_MARK_MIN_RUN, 2);
    assert.deepEqual(runsOf([0, 1, 1, 1, 2, NaN, NaN, 3, 3, 4, 4]),
        { starts: [1, 7, 9], lengths: [3, 2, 2], count: 3 }, 'runs by first row and length; NaN is no run');
    assert.deepEqual(runsOf([5, 5, 5]), { starts: [0], lengths: [3], count: 1 }, 'a run at the start, to the end');
    assert.deepEqual(runsOf([1, 1, NaN, 1, 1]), { starts: [0, 3], lengths: [2, 2], count: 2 },
        'a NaN stamp ends a run, even between equal instants');
    assert.deepEqual(runsOf([3, 3, 1, 1, 3, 3]), { starts: [0, 2, 4], lengths: [2, 2, 2], count: 3 },
        'an unsorted column is read by position, not searched by value');
    assert.equal(runsOf([1, 1, 2, 2, 2], 3).count, 1, 'minRun filters short runs');
    assert.equal(runsOf([]).count, 0);
    assert.equal(runsOf(null).count, 0);
    assert.equal(runsOf([1]).count, 0);

    // Agrees with the load-time summary on the same column.
    const column = Float64Array.from({ length: 5000 }, (_, i) => Math.floor(i / 3) + (i > 2500 ? 0.5 : 0));
    const runs = repeatedTimestampRuns(column);
    const summary = repeatedTimestampSummary(column);
    let repeated = 0;
    let longest = 0;
    for (let i = 0; i < runs.count; i++) {
        repeated += runs.lengths[i] - 1;
        longest = Math.max(longest, runs.lengths[i]);
    }
    assert.equal(repeated, summary.repeated, 'rows beyond the first of each run = the summary\'s count');
    assert.equal(longest, summary.longestRun);

    // Growth past the initial buffer.
    const many = Float64Array.from({ length: 1000 }, (_, i) => Math.floor(i / 2));
    assert.equal(repeatedTimestampRuns(many).count, 500);
}

// ── Marks for a view ──
{
    const times = [0, 1, 1, 2, 3, 3, 3, 4, 50, 50, 99, 99];
    const source = { key: 'f', times, runs: repeatedTimestampRuns(times) };

    const wide = repeatedMarksForView([source], 0, 100, 300);
    assert.deepEqual(wide.marks.map(m => [m.t, m.instants, m.longest]), [[1, 1, 2], [3, 1, 3], [50, 1, 2], [99, 1, 2]]);
    assert.deepEqual(wide.marks[0].keys, ['f']);
    // 100 columns of 3 px: 1 and 3 fall in columns 1 and 3, not adjacent.
    assert.equal(wide.regions.length, 4, 'one bar per isolated marked column');
    assert.deepEqual(wide.regions[0], { t0: 1, t1: 2 }, 'a bar spans its column');

    const zoomed = repeatedMarksForView([source], 0, 10, 300);
    assert.deepEqual(zoomed.marks.map(m => m.t), [1, 3], 'only the runs in view');

    const reversed = repeatedMarksForView([source], 10, 0, 300);
    assert.deepEqual(reversed.marks.map(m => m.t), [1, 3], 'a reversed range reads the same');

    // Two columns of 3 px on 6 px: 1 and 3 share column 0 and 50 sits in 1.
    const narrow = repeatedMarksForView([source], 0, 100, 6);
    assert.equal(narrow.marks[0].instants, 2, 'one column, two instants');
    assert.equal(narrow.marks[0].t, 3, 'placed on the instant with the longest run');
    assert.equal(narrow.marks[0].longest, 3);
    assert.deepEqual(narrow.regions, [{ t0: 0, t1: 100 }], 'adjacent marked columns merge into one bar');

    assert.equal(repeatedMarksForView([source], 0, 100, 0).marks.length, 0, 'no width, no marks');
    assert.equal(repeatedMarksForView([source], 200, 300, 300).marks.length, 0, 'nothing in view');
    assert.equal(repeatedMarksForView([], 0, 1, 300).marks.length, 0);

    // Two files: the marks name both when they share a column.
    const other = { key: 'g', times: [3, 3, 7], runs: repeatedTimestampRuns([3, 3, 7]) };
    const both = repeatedMarksForView([source, other], 0, 10, 300);
    const at3 = both.marks.find(m => m.t === 3);
    assert.deepEqual(at3.keys.sort(), ['f', 'g']);

    // Bounded by the plot width, whatever the file holds.
    const huge = Float64Array.from({ length: 200000 }, (_, i) => Math.floor(i / 2));
    const bounded = repeatedMarksForView([{ key: 'h', times: huge, runs: repeatedTimestampRuns(huge) }], 0, 100000, 900);
    assert.ok(bounded.marks.length <= 300, `at most one mark per 3 px column (${bounded.marks.length})`);
    assert.equal(bounded.regions.length, 1, 'every column marked: one bar across');
}

// ── The panel overlay, through the real mixin ──
class Manager {
    constructor(files) {
        this.files = new Map(Object.entries(files));
        this.theme = 'light';
    }
    _getTransformedTimeData(fileId) { return this.files.get(fileId).data.time; }
    _coerceAxisValue(v) { return Number(v); }
    _plotlyTimeValue(_fileId, v) { return v; }
    _getTimeVar() { return {}; }
    _escapeHTML(text) { return String(text); }
    _lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
    _upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
    _hasContent(plot) { return !!plot?.traces?.length; }
}
Manager.SAMPLE_MARKER_SIZE = 5;
Manager.REPEATED_MARK_MIN_RUN = 2;
installPlotRepeatedMethods(Manager);

{
    const time = Float64Array.from([0, 1, 2, 2, 2, 3, 4, 5, 5, 6]);
    const m = new Manager({
        a: { name: 'a.csv', data: { time } },
        clean: { name: 'clean.csv', data: { time: Float64Array.from([0, 1, 2]) } },
        lazy: { name: 'big.parquet', data: { _duckdb: {}, time: Float64Array.from([0, 0]) } },
    });
    const div = { _fullLayout: { xaxis: { range: [0, 10], _length: 600 } } };
    const plot = { mode: 'timeseries', showRepeated: true, div, traces: [{ fileId: 'a', color: '#123' }] };

    assert.equal(m._repeatedRunsForTimes(time), m._repeatedRunsForTimes(time), 'runs are cached per array');

    const overlay = m._repeatedOverlay(plot);
    assert.equal(overlay.state, null);
    assert.ok(overlay.shapes.length >= 1 && overlay.shapes.every(sh => sh.type === 'rect' && sh.y0 > 0.9),
        'bars on the top strip');
    assert.deepEqual(overlay.hoverMarks.map(mark => mark.x), [2, 5], 'a hover per repeated instant');
    assert.ok(overlay.hoverMarks[0].text.length > 0);

    // A trace showing its dots takes its file off the strip: the rings say it.
    const dotted = { ...plot, _sampleMarkerState: new WeakMap([[plot.traces[0], true]]) };
    assert.equal(m._repeatedOverlay(dotted).shapes.length, 0, 'dots on screen: no bars');
    assert.equal(m._repeatedOverlay(dotted).hoverMarks.length, 0);

    assert.equal(m._repeatedOverlay({ ...plot, showRepeated: false }).shapes.length, 0, 'off: nothing');
    assert.equal(m._repeatedOverlay({ ...plot, mode: 'fft' }).shapes.length, 0, 'time-series panels only');

    assert.equal(m._repeatedAvailability(plot), 'some');
    assert.equal(m._repeatedAvailability({ ...plot, traces: [{ fileId: 'clean' }] }), 'none', 'no repeats: none');
    assert.equal(m._repeatedAvailability({ ...plot, traces: [{ fileId: 'clean' }, { fileId: 'lazy' }] }), 'lazy',
        'nothing found, but a memory-saving file could not be read');
    assert.equal(m._repeatedAvailability({ ...plot, traces: [] }), 'none');
    assert.equal(m._repeatedOverlay({ ...plot, traces: [{ fileId: 'lazy' }] }).state, 'lazy');

    // A hidden trace's file is not marked, but it still counts for the button.
    const hidden = { ...plot, traces: [{ fileId: 'a', visible: 'legendonly' }] };
    assert.equal(m._repeatedOverlay(hidden).shapes.length, 0);
    assert.equal(m._repeatedAvailability(hidden), 'some');

    // Rings on Samples dots: full run length even when the window cuts the run.
    assert.deepEqual(m._repeatedRunLengthsForPoints(time, [1, 2, 2, 2, 3]), [0, 3, 3, 3, 0]);
    assert.deepEqual(m._repeatedRunLengthsForPoints(time, [2, 3, 4, 5]), [3, 0, 0, 2],
        'a run cut by either edge of the window still reads its whole length');
    const decoration = m._repeatedSampleDecoration({ color: '#123' }, [0, 3, 3, 3, 0]);
    assert.equal(decoration.marker.color, '#123', 'every sample keeps its filled dot');
    assert.deepEqual(decoration.marker.line.width, [0, 2, 2, 2, 0], 'repeated ones get a ring');
    assert.equal(decoration.marker.line.color[1], 'rgba(211, 47, 47, 1)', 'in red');
    assert.ok(decoration.marker.size[1] > decoration.marker.size[0], 'the ring sits around the dot');
    assert.equal(decoration.text[0], '');
    assert.ok(decoration.text[1].includes('3'), 'hover says how many rows');
    assert.equal(m._repeatedSampleDecoration({ color: '#123' }, [0, 0]), null, 'nothing repeated: plain dots');
}

// Zoomed out on many repeats: bars, bounded by the width, never one per repeat.
{
    const time = Float64Array.from({ length: 20000 }, (_, i) => Math.floor(i / 2));
    const m = new Manager({ a: { name: 'a.csv', data: { time } } });
    const plot = {
        mode: 'timeseries', showRepeated: true,
        div: { _fullLayout: { xaxis: { range: [0, 10000], _length: 600 } } },
        traces: [{ fileId: 'a' }],
    };
    const overlay = m._repeatedOverlay(plot);
    assert.equal(overlay.state, null);
    assert.equal(overlay.shapes.length, 1, '10 000 repeats across the view: one bar');
    assert.ok(overlay.hoverMarks.length <= 200, 'hover marks bounded by the columns');
}

console.log('repeated marks tests passed');
