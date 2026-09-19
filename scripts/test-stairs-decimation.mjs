// A stepped trace is reduced for the screen like any other trace.
//
// It used to be the one exception: a trace drawn with shape 'hv' skipped the
// visual path entirely and handed Plotly every sample it had, on the first
// draw and again on every zoom — while the linear trace beside it, over the
// same file, was reduced to two thousand points. Plotly then expanded each of
// those samples into two SVG segments, so the stepped trace cost several times
// the linear one, which is exactly how it read to the user.
//
// The staircase says something a straight line does not only when one sample
// interval is wide enough on screen to show the horizontal run and the
// vertical jump apart. At that zoom the window holds fewer samples than the
// budget and is copied out whole, so the steps are exact to the sample — which
// is the guarantee the tests below pin down.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

const FILE_ID = 'stairs-fixture';
const TARGET = 2000;

// A digital signal: holds a level for a run of samples, then jumps. This is
// what defaults to stairs in the app — booleans, and the sample-index axis.
function digitalSignal(count, seed = 20260919) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const time = new Float64Array(count);
    const values = new Float64Array(count);
    let level = 0;
    let hold = 0;
    for (let i = 0; i < count; i++) {
        time[i] = i * 1e-5;
        if (hold-- <= 0) { level = Math.round(rnd() * 3); hold = 50 + Math.floor(rnd() * 900); }
        values[i] = level;
    }
    return { time, values };
}

class Harness {
    static GL_POINT_THRESHOLD = 50_000;

    constructor(count, { visualMaxPoints = TARGET, dataType = 'real' } = {}) {
        this.activeFileId = FILE_ID;
        this.language = 'en';
        this.timeseriesVisualMaxPoints = visualMaxPoints;
        const { time, values } = digitalSignal(count);
        this.source = { time, values };
        this.files = new Map([[FILE_ID, {
            name: 'stairs-fixture.csv',
            transform: {},
            data: {
                metadata: { timeName: 'time' },
                variables: {
                    time: { name: 'time', kind: 'abscissa', timeKind: 'numeric', description: 'Time [s]', data: time },
                    y: { name: 'y', kind: 'variable', dataType, description: 'Level [-]', data: values },
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

const build = (harness, state = {}, visibleRange = null) => {
    const trace = { fileId: FILE_ID, varName: 'y', color: '#2196f3', ...state };
    const plot = { mode: 'timeseries', traces: [trace], timeseriesStacked: false, timeseriesY2Enabled: false };
    return { trace, built: harness._buildTimeTrace(trace, visibleRange, plot, 0) };
};

const STEP = { lineShape: 'hv' };
const LINE = { lineShape: 'linear' };

// ─── The whole series, as drawn when the panel first opens ─────────
{
    const harness = new Harness(300_000);
    const { built: step } = build(harness, STEP);
    const { built: line } = build(harness, LINE);

    assert.ok(step.x.length <= TARGET, `a stepped trace is reduced to the budget (got ${step.x.length})`);
    assert.equal(step.x.length, line.x.length,
        'and to exactly what the linear trace over the same data gets — that is the whole fix');
    assert.equal(step.line.shape, 'hv', 'it is still drawn as a staircase');
    assert.equal(step.type, 'scatter', 'and still through SVG');
}

// ─── Zoomed out, with a visible range (every relayout event) ───────
{
    const harness = new Harness(300_000);
    const { time } = harness.source;
    const range = [time[0], time[time.length - 1]];
    const { built: step } = build(harness, STEP, range);
    assert.ok(step.x.length <= TARGET, `a zoom event hands Plotly the budget, not the file (got ${step.x.length})`);
}

// ─── The envelope survives the reduction ───────────────────────────
// Min/max bucket decimation keeps the extremes of every bucket, so the drawn
// staircase still reaches the highest and lowest level the signal visits.
{
    const harness = new Harness(300_000);
    const { values } = harness.source;
    let srcMin = Infinity;
    let srcMax = -Infinity;
    for (const value of values) { if (value < srcMin) srcMin = value; if (value > srcMax) srcMax = value; }
    const { built } = build(harness, STEP);
    let outMin = Infinity;
    let outMax = -Infinity;
    for (const value of built.y) { if (value < outMin) outMin = value; if (value > outMax) outMax = value; }
    assert.equal(outMin, srcMin, 'the lowest level is still drawn');
    assert.equal(outMax, srcMax, 'and so is the highest');
}

// ─── Zoomed in far enough to see the steps: exact, sample for sample ──
// This is the guarantee the fix rests on. Once the window holds fewer samples
// than the budget it is copied out whole, so nothing about the staircase is
// approximated at the zoom where a reader could tell.
{
    const harness = new Harness(300_000);
    const { time, values } = harness.source;
    const start = 100_000;
    const end = start + 1200;              // well under TARGET
    const { built } = build(harness, STEP, [time[start], time[end - 1]]);

    // The window is padded by one sample on each side (the segment entering and
    // leaving the view), so look for the requested span inside what came back.
    const at = built.x.indexOf(time[start]);
    assert.ok(at >= 0, 'the first visible sample is in the drawn trace');
    for (let i = 0; i < end - start; i++) {
        assert.equal(built.x[at + i], time[start + i], `x[${i}] is the sample itself`);
        assert.equal(built.y[at + i], values[start + i], `y[${i}] is the sample itself`);
    }
    assert.ok(built.x.length <= (end - start) + 4, 'and nothing beyond the window plus its padding is sent');
}

// ─── A boolean variable takes the same path without being told to ──
{
    const harness = new Harness(300_000, { dataType: 'boolean' });
    const { built } = build(harness);
    assert.equal(built.line.shape, 'hv', 'a boolean defaults to stairs');
    assert.ok(built.x.length <= TARGET, `and is reduced like everything else (got ${built.x.length})`);
}

// ─── "No downsampling" still means no downsampling ─────────────────
{
    const harness = new Harness(120_000, { visualMaxPoints: null });
    const { built } = build(harness, STEP);
    assert.equal(built.x.length, 120_000, 'the escape hatch still draws every sample');
    assert.equal(built.line.shape, 'hv');
}

// ─── The full-series overview is cached for stepped traces too ─────
// Entering FFT or switching modes must not rescan the source to redraw the
// same two thousand points; stepped traces were excluded from this cache only
// because they had no reduced overview to cache.
{
    const harness = new Harness(300_000);
    const { trace, built: first } = build(harness, STEP);
    assert.ok(trace._fullVisualCache, 'the overview is kept');
    const plot = { mode: 'timeseries', traces: [trace], timeseriesStacked: false, timeseriesY2Enabled: false };
    const second = harness._buildTimeTrace(trace, null, plot, 0);
    assert.equal(second.y, first.y, 'and reused verbatim on the next build');
}

// ─── Nothing in the visual path knows about stairs any more ────────
{
    const source = readFileSync(new URL('../src/plots/methods/data-methods.js', import.meta.url), 'utf8');
    assert.match(source, /_buildTimeseriesVisualData = function\(timeData, values, visibleRange = null\) \{/,
        'the reduction takes no step flag');
    assert.doesNotMatch(source, /isStep \? \{ x: timeData, y: values \}/,
        'and has no bypass that hands Plotly the whole series');
    assert.doesNotMatch(source, /fullVisualCacheable = !visibleRange[\s\S]{0,120}!isStep/,
        'the overview cache no longer excludes stepped traces');
}

console.log('Stairs decimation checks passed.');
