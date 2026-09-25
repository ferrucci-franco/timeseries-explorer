// The NaN/Inf and Gaps tools of the Marks menu (docs/marks-menu-nan-gaps-design.md):
// the automatic step, the gap and NaN-run scanners, the NaN/Inf strip, the lazy
// gap reducer, and the plot methods that tie them together.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    GAP_DEFAULT_FACTOR,
    detectGapIndices,
    detectSamplingGaps,
    estimateNominalStep,
    nanRunIndices,
    nominalStepFromHistogram,
    stepBinKey,
    stepHistogram,
} from '../src/utils/sampling-gaps.js';
import {
    NAN_STRIP_HEIGHT_PX,
    gapIntervalsInRange,
    isNonDecreasing,
    nanBreakIntervals,
    nanStripForView,
    nanStripFromBuckets,
    nanStripLevel,
} from '../src/utils/nan-strip.js';
import { buildGapSummarySql, buildStepHistogramSql, lazyGapsFromBuckets } from '../src/data/missing-buckets-sql.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ── The automatic step: the mode, not the median ──
{
    // Regular 1 s series.
    const regular = Float64Array.from({ length: 1000 }, (_, i) => i);
    const r = estimateNominalStep(regular);
    assert.ok(close(r.dt, 1), 'a regular step is recovered exactly');
    assert.equal(r.agreement, 1, 'every step agrees');
    assert.equal(r.monotonic, true);

    // ±4 % jitter: still 1 s, still full agreement.
    let t = 0;
    const jitter = [0];
    for (let i = 1; i < 2000; i++) { t += 1 + 0.04 * Math.sin(i * 1.7); jitter.push(t); }
    const j = estimateNominalStep(jitter);
    assert.ok(Math.abs(j.dt - 1) < 0.01, 'jitter averages out');
    assert.ok(j.agreement > 0.99, 'and the steps agree with it');

    // THE case the median gate got backwards: 1 s data with 30 % of its
    // intervals being dropouts of assorted lengths. The classic detector sees
    // an agreement below 80 % and refuses to mark anything; the mode still
    // names the step, and every dropout becomes a gap.
    const holes = [0];
    for (let i = 1; i < 1000; i++) holes.push(holes[i - 1] + (i % 10 < 3 ? 2 + (i % 4) : 1));
    const classic = detectSamplingGaps(holes);
    assert.equal(classic.hasNominalStep, false, 'the classic gate gives up on this file');
    assert.equal(classic.count, 0, 'and marks nothing');
    const m = estimateNominalStep(holes);
    assert.ok(close(m.dt, 1), 'the mode still finds 1 s');
    assert.ok(Math.abs(m.agreement - 0.7) < 0.01, 'and reports the 70 % agreement honestly');
    const gaps = detectGapIndices(holes, m.dt, GAP_DEFAULT_FACTOR);
    assert.equal(gaps.count, 299, 'every dropout is a gap');

    // Tie between two populations: the smaller step wins (gaps are multiples
    // of the step, never fractions of it).
    const tie = [0];
    for (let i = 1; i < 401; i++) tie.push(tie[i - 1] + (i % 2 ? 1 : 2));
    assert.ok(close(estimateNominalStep(tie).dt, 1), 'a tie goes to the smaller step');

    // A clear majority wins even when it is the larger step.
    const coarse = [0];
    for (let i = 1; i < 401; i++) coarse.push(coarse[i - 1] + (i % 5 === 0 ? 1 : 10));
    assert.ok(close(estimateNominalStep(coarse).dt, 10), 'the most common step wins');

    // Out of order: reported, never measured along the wrong sequence.
    assert.equal(estimateNominalStep([0, 2, 1, 3, 4]).monotonic, false, 'backward steps are reported');
    // Repeats (zero steps) do not count as steps at all.
    assert.ok(close(estimateNominalStep([0, 0, 1, 1, 2, 3, 4]).dt, 1), 'repeated timestamps are ignored');
    // Nothing to measure.
    assert.ok(Number.isNaN(estimateNominalStep([5]).dt), 'one sample has no step');
    assert.ok(Number.isNaN(estimateNominalStep([5, 5, 5]).dt), 'nor does one instant');

    // The DuckDB rows ({key, count, sum}) give the same answer as the Map.
    const { bins, positive } = stepHistogram(holes);
    const rows = [...bins].map(([key, bin]) => ({ key, count: bin.count, sum: bin.sum }));
    const fromRows = nominalStepFromHistogram(rows, positive);
    assert.ok(close(fromRows.dt, m.dt) && close(fromRows.agreement, m.agreement), 'histogram rows = in-memory histogram');
    assert.equal(stepBinKey(1), 0, 'a 1-unit step sits in bin 0');
}

// ── Gaps for a given step, in typed arrays ──
{
    const times = [0, 1, 2, 5, 6, 7, 17, 18];
    const g = detectGapIndices(times, 1, 1.5);
    assert.deepEqual([...g.ends], [3, 6], 'the row after each gap');
    assert.equal(g.totalMissing, 2 + 9, 'round(step / Δt) − 1 missing per gap');
    assert.equal(detectGapIndices(times, 1, 4).count, 1, 'a larger factor ignores short dropouts');
    assert.equal(detectGapIndices(times, 0.1, 1.5).count, 7, 'a too-small manual step makes every interval a gap');
    assert.equal(detectGapIndices([0, 2, 1], 1).monotonic, false, 'disorder voids the gaps');
    assert.equal(detectGapIndices(times, NaN).count, 0, 'no step, no gaps');
}

// ── NaN runs as row indices ──
{
    const r = nanRunIndices([1, NaN, NaN, 4, Infinity, 6, -Infinity]);
    assert.deepEqual([...r.starts], [1, 4, 6]);
    assert.deepEqual([...r.ends], [2, 4, 6]);
    assert.equal(r.nonFinite, 4);
    assert.equal(nanRunIndices(Float64Array.of(1, 2, 3)).count, 0, 'clean data has no runs');
}

// ── The NaN/Inf strip ──
{
    assert.deepEqual([0, 0.01, 0.1, 0.5, 0.99, 1].map(nanStripLevel), [0, 1, 2, 3, 3, 4], 'fraction → level');

    const n = 1000;
    const times = Float64Array.from({ length: n }, (_, i) => i);
    const values = Float64Array.from({ length: n }, (_, i) => {
        if (i >= 100 && i < 200) return NaN;          // a block: level 4
        if (i === 500) return NaN;                     // one sample: level 1, still visible
        if (i > 700 && i % 5 === 0) return Infinity;   // scattered 20 %: level 2
        return 1;
    });
    const runs = nanRunIndices(values);
    const source = { key: 'a', times, values, runs, monotonic: true };
    const view = nanStripForView([source], 0, 999, 100, 2); // 50 columns of ~20 rows
    const levels = view.regions.map(r => r.level);
    assert.ok(levels.includes(4), 'the full block is fully dark');
    assert.ok(levels.includes(1), 'a single NaN is still drawn');
    assert.ok(levels.includes(2), 'a scattered stretch reads as partial');
    const block = view.regions.find(r => r.level === 4);
    assert.ok(block.t0 <= 100 && block.t1 >= 199, 'the block spans its rows');
    assert.deepEqual(block.perKey.a, { nan: 100, total: 100 }, 'and counts them');

    // The monotonic fast path and the plain scan agree.
    const scan = nanStripForView([{ ...source, monotonic: false }], 0, 999, 100, 2);
    assert.deepEqual(JSON.stringify(scan.regions), JSON.stringify(view.regions), 'fast path = linear scan');

    // Zoomed in on part of the block: only what is on screen, clipped.
    const zoom = nanStripForView([source], 150, 250, 100, 2);
    assert.equal(zoom.regions[0].t0, 150, 'regions start at the view');
    assert.ok(zoom.regions.every(r => r.t1 <= 250), 'and end inside it');

    // Two traces: a column takes the LARGEST fraction among them.
    const other = { key: 'b', times, values: new Float64Array(n).fill(1), runs: nanRunIndices(new Float64Array(n).fill(1)), monotonic: true };
    const both = nanStripForView([source, other], 0, 999, 100, 2);
    assert.deepEqual(both.regions.map(r => r.level), levels, 'a clean trace does not dilute a missing one');
    assert.equal(nanStripForView([other], 0, 999, 500).regions.length, 0, 'clean data draws nothing');
    assert.equal(isNonDecreasing([0, 1, NaN, 2]), true);
    assert.equal(isNonDecreasing([0, 2, 1]), false);

    // Buckets (the lazy path): n_missing / n_total per bucket, merged by level.
    const buckets = [
        { b: 0, nTotal: 10, nMissing: 0 },
        { b: 1, nTotal: 10, nMissing: 10 },
        { b: 2, nTotal: 10, nMissing: 10 },
        { b: 3, nTotal: 10, nMissing: 1 },
    ];
    const lazy = nanStripFromBuckets(buckets, 4, i => i * 100);
    assert.deepEqual(lazy.map(r => [r.t0, r.t1, r.level, r.nan, r.total]),
        [[100, 300, 4, 20, 20], [300, 400, 2, 1, 10]], 'bucket regions merge and carry their counts');

    // Line breaks: last good → first good, only in range, null when too dense.
    assert.deepEqual(nanBreakIntervals(times, runs, 0, 300), [{ t0: 99, t1: 200 }], 'break across the block');
    assert.equal(nanBreakIntervals(times, runs, 0, 999, 5), null, 'more runs than the limit: no breaks');
    const gi = detectGapIndices([0, 1, 5, 6, 10], 1);
    assert.deepEqual(gapIntervalsInRange([0, 1, 5, 6, 10], gi.ends, 4, 20), [{ t0: 1, t1: 5 }, { t0: 6, t1: 10 }],
        'gaps touching the range');
    assert.deepEqual(gapIntervalsInRange([0, 1, 5, 6, 10], gi.ends, 7, 8), [{ t0: 6, t1: 10 }], 'a gap spanning the view');
}

// ── Lazy gaps: a GIVEN step, not a per-viewport estimate ──
{
    const bucket = (b, nTotal, tMin, tMax) => ({ b, nTotal, nMissing: 0, tMin, tMax });
    // 10 buckets over [0, 100), 1 row per unit; rows missing in 30..49.
    const rows = [];
    for (let b = 0; b < 10; b++) {
        if (b === 3 || b === 4) continue;
        rows.push(bucket(b, 10, b * 10, b * 10 + 9));
    }
    const gaps = lazyGapsFromBuckets(rows, { t0: 0, t1: 100, nBuckets: 10, nominalStep: 1, factor: 1.5 });
    assert.deepEqual(gaps.map(g => [g.t0, g.t1]), [[29, 50]], 'the hole between populated buckets');
    // The same rows judged against a much larger step: nothing.
    assert.equal(lazyGapsFromBuckets(rows, { t0: 0, t1: 100, nBuckets: 10, nominalStep: 30 }).length, 0,
        'a coarse step sees no gap');
    // A row deficit inside a pixel: 5 rows over a 9-unit span at Δt = 1.
    const deficit = lazyGapsFromBuckets([bucket(0, 5, 0, 9)], { t0: 0, t1: 10, nBuckets: 1, nominalStep: 1 });
    assert.deepEqual(deficit.map(g => [g.t0, g.t1]), [[0, 10]], 'a deficit marks its pixel');
    // Display mapping goes through mapTime.
    const mapped = lazyGapsFromBuckets(rows, { t0: 0, t1: 100, nBuckets: 10, nominalStep: 1, mapTime: v => v * 1000 });
    assert.deepEqual(mapped.map(g => [g.t0, g.t1]), [[29000, 50000]], 'intervals come out in display units');

    const sql = buildStepHistogramSql('"t"::DOUBLE', 'tbl', 40);
    assert.match(sql, /LAG\(t\) OVER \(ORDER BY t\)/, 'steps are measured in time order');
    assert.match(sql, /ROUND\(LN\(dt\) \* 40\)/, 'on the same log bins as the eager histogram');
    const summary = buildGapSummarySql('"t"::DOUBLE', 'tbl', String, 2, 1.5);
    assert.match(summary, /WHERE dt > 3/, 'the summary counts steps above factor × Δt');
}

// ── The plot methods ──
// marks-methods.js imports Plotly at module scope; load it with that import
// swapped for a stub and the relative imports made absolute.
const relayouts = [];
globalThis.__marksTestPlotly = { relayout: (div, update) => { relayouts.push({ div, update }); } };
const marksUrl = new URL('../src/plots/methods/marks-methods.js', import.meta.url);
const marksSource = readFileSync(marksUrl, 'utf8')
    .replace("import Plotly from '../../vendor/plotly.js';", 'const Plotly = globalThis.__marksTestPlotly;')
    .replace(/from '(\.\.\/[^']+)'/g, (_, rel) => `from '${new URL(rel, marksUrl).href}'`);
const marksCopy = join(mkdtempSync(join(tmpdir(), 'marks-methods-')), 'marks-methods.mjs');
writeFileSync(marksCopy, marksSource);
const { installPlotMarksMethods } = await import(pathToFileURL(marksCopy).href);

class Harness {
    constructor() {
        this.files = new Map();
        this.plots = new Map();
        this.refreshed = [];
        this.notices = [];
        this.theme = 'light';
        this.axis = { semantic: 'absolute', display: 'calendar', highResGeneratedCalendar: false };
    }
    addFile(fileId, times, variables, extra = {}) {
        const vars = {};
        for (const [name, values] of Object.entries(variables)) vars[name] = { kind: 'variable', data: values };
        this.files.set(fileId, { name: `${fileId}.csv`, data: { variables: vars, metadata: {}, ...extra }, times });
    }
    _isVisible(t) { return t.visible !== false && t.visible !== 'legendonly'; }
    _getTransformedTimeData(fileId) { return this.files.get(fileId).times; }
    _getTransformedTimeDataForVariable(fileId) { return this.files.get(fileId).times; }
    _getTransformedVariableData(fileId, varName) { return this.files.get(fileId).data.variables[varName].data; }
    _getTimeVar() { return null; }
    _timeAxisModel() { return this.axis; }
    _displayTimeForFetchedSourceTime(_fileId, value) { return value; }
    _coerceAxisValue(value) { return Number(value); }
    _plotlyTimeValue(_fileId, value) { return value; }
    _missTraceKey(t) { return `${t.fileId}\u0000${t.varName}`; }
    _variableLabel(varName) { return varName; }
    _escapeHTML(text) { return String(text); }
    _missingViewIsDense(_plot, items) { return items.length > 1000; }
    _adaptiveGapBandShapes(_plot, items) { return items.map(it => ({ type: 'rect', gap: true, x0: it.t0, x1: it.t1 })); }
    _refreshTimeseriesVisuals(panelId) { this.refreshed.push(panelId); }
    _setMissingDensityNotice(_plot, state) { this.notices.push(state); }
    _cancelLazyMissingRequest(panelId) {
        const request = this._lazyMissingRequests?.get(panelId);
        request?.controller?.abort();
        this._lazyMissingRequests?.delete(panelId);
    }
    _sourceRangeForDisplayRange(_fileId, range) { return range; }
    _lazyMissingBucketCount() { return 10; }
}
installPlotMarksMethods(Harness);
// No DOM here: the Gaps panel and the menu find nothing to render into.
globalThis.document = { querySelector: () => null, activeElement: null };

const i18nKeys = (await import('../src/i18n/translations.js')).default.en;
const plotWith = (traces, extra = {}) => ({
    mode: 'timeseries',
    traces,
    div: {
        _fullLayout: { xaxis: { range: [0, 100], _length: 200 }, _size: { h: 400, t: 20 } },
        addEventListener() {},
        closest: () => null,
    },
    ...extra,
});

// Settings: per file, sanitized, and a change redraws every panel showing it.
{
    const h = new Harness();
    h.addFile('f', Float64Array.from({ length: 101 }, (_, i) => i), { v: new Float64Array(101).fill(1) });
    assert.deepEqual(h._gapSettings('f'), { dt: null, factor: 1.5 }, 'auto and 1.5 by default');
    h.files.get('f').gapSettings = { dt: -3, factor: 0.5 };
    assert.deepEqual(h._gapSettings('f'), { dt: null, factor: 1.5 }, 'nonsense falls back to the defaults');
    h.plots.set('p1', plotWith([{ fileId: 'f', varName: 'v' }], { showGaps: true }));
    h.plots.set('p2', plotWith([{ fileId: 'f', varName: 'v' }], { showGaps: false }));
    h.plots.set('p3', plotWith([{ fileId: 'other', varName: 'v' }], { showGaps: true }));
    h._setGapSettings('f', { dt: 2 });
    assert.deepEqual(h._gapSettings('f'), { dt: 2, factor: 1.5 });
    assert.deepEqual(h.refreshed, ['p1'], 'only panels showing the file with Gaps on redraw');
    const step = h._resolvedGapStep('f');
    assert.equal(step.dt, 2, 'the manual step wins');
    assert.equal(step.manual, true);
    assert.ok(close(step.auto.dt, 1), 'the automatic one is still reported');
    h._setGapSettings('f', { dt: null });
    assert.equal(h._resolvedGapStep('f').manual, false, 'Auto switches back');

    // A manual step keeps its meaning when the axis is shown another way.
    h._setGapSettings('f', { dt: 60000 });                  // 1 min on a calendar axis (ms)
    h.axis = { semantic: 'elapsed', display: 'seconds' };   // the same axis as elapsed seconds
    assert.equal(h._gapSettings('f').dt, 60, 'ms → s: still one minute');
    h.axis = { semantic: 'count', display: 'index' };       // reindexed to rows
    assert.equal(h._gapSettings('f').dt, null, 'a row index has no time step: back to automatic');
}

// Formatting a step in the axis units.
{
    const h = new Harness();
    assert.equal(h._formatGapStep('f', 1000), '1 s', 'calendar axes are in ms');
    assert.equal(h._formatGapStep('f', 600000), '10 min');
    h.axis = { semantic: 'elapsed', display: 'seconds' };
    assert.equal(h._formatGapStep('f', 0.5), '500 ms', 'elapsed axes are in seconds');
    h.axis = { semantic: 'count', display: 'index' };
    assert.equal(h._formatGapStep('f', 3), '3', 'a row index is a plain count');
}

// Line breaks: NaN runs always, gaps only while Gaps is on.
{
    const h = new Harness();
    const times = Float64Array.from([0, 1, 2, 3, 4, 10, 11, 12, 13, 14]);
    const values = Float64Array.from([1, 1, NaN, 1, 1, 1, 1, 1, 1, 1]);
    h.addFile('f', times, { v: values });
    const t = { fileId: 'f', varName: 'v' };
    const off = h._traceBreakIntervals(plotWith([t]), t);
    assert.deepEqual(off, [{ t0: 1, t1: 3 }], 'NaN/Inf off, Gaps off: the NaN run still breaks the line');
    const on = h._traceBreakIntervals(plotWith([t], { showGaps: true }), t);
    assert.deepEqual(on, [{ t0: 1, t1: 3 }, { t0: 4, t1: 10 }], 'Gaps on: the gap breaks it too');
    h.addFile('d', Float64Array.from([0, 1, 2, 3, 4, 5]), { v: Float64Array.from([1, NaN, 1, NaN, 1, 1]) });
    const dense = { fileId: 'd', varName: 'v' };
    assert.equal(h._traceBreakIntervals(plotWith([dense]), dense, -Infinity, Infinity, 2), null,
        'a kind denser than half the pixels is skipped');
    assert.equal(h._traceBreakIntervals(plotWith([dense]), dense, -Infinity, Infinity, 4).length, 2,
        'and kept when the pixels can show it');
    h.files.get('f').data._duckdb = { viewMode: true };
    assert.equal(h._traceBreakIntervals(plotWith([t]), t), null, 'lazy traces carry their own rows');
}

// The overlays for the view: strip under the Repeated slot, gap bands, order.
{
    const h = new Harness();
    const n = 101;
    const times = Float64Array.from({ length: n }, (_, i) => i);
    const values = Float64Array.from({ length: n }, (_, i) => (i >= 40 && i < 50 ? NaN : 1));
    h.addFile('f', times, { v: values });
    const plot = plotWith([{ fileId: 'f', varName: 'v' }], { showNaN: true });
    h._updateTimeseriesMarks(plot);
    assert.ok(plot._nanShapes.length >= 1, 'the NaN block is on the strip');
    const shape = plot._nanShapes[0];
    assert.equal(shape.ysizemode, 'pixel', 'the strip has a fixed pixel height');
    assert.equal(shape.yanchor, 1, 'anchored to the top of the plot');
    assert.deepEqual([shape.y0, shape.y1], [-NAN_STRIP_HEIGHT_PX, 0], 'flush with the top while Repeated is off');
    assert.ok(plot._nanStripHover[0].text.includes('10'), 'the hover counts the NaN');
    plot.showRepeated = true;
    h._updateTimeseriesMarks(plot);
    assert.ok(plot._nanShapes[0].y1 < 0, 'under the Repeated strip while Repeated is on');
    plot._repeatedShapes = [{ repeated: true }];
    plot.showGaps = true;
    h._updateTimeseriesMarks(plot);
    const all = h._timeseriesOverlayShapes(plot);
    assert.equal(all[all.length - 1].repeated, true, 'Repeated is drawn last');
    assert.ok(all.indexOf(plot._nanShapes[0]) > -1, 'the strip is in');
    plot.showNaN = false;
    assert.equal(h._timeseriesOverlayShapes(plot).includes(plot._nanShapes[0]), false, 'a toggle off drops its shapes');
}

// Gap bands from the resolved step, and the step notice.
{
    const h = new Harness();
    const times = [];
    for (let i = 0; i <= 100; i++) if (i < 30 || i > 45) times.push(i);
    h.addFile('f', Float64Array.from(times), { v: new Float64Array(times.length).fill(1) });
    const plot = plotWith([{ fileId: 'f', varName: 'v' }], { showGaps: true });
    h._updateTimeseriesMarks(plot);
    assert.deepEqual(plot._gapShapes.map(s => [s.x0, s.x1]), [[29, 46]], 'one band across the hole');
    assert.equal(h._gapsStepNotice(plot), null, 'a clean step raises no notice');

    const unsorted = new Harness();
    unsorted.addFile('u', Float64Array.from([0, 1, 3, 2, 4]), { v: new Float64Array(5).fill(1) });
    assert.equal(unsorted._gapsStepNotice(plotWith([{ fileId: 'u', varName: 'v' }], { showGaps: true })).mode, 'unsorted');

    const irregular = new Harness();
    const holes = [0];
    for (let i = 1; i < 200; i++) holes.push(holes[i - 1] + (i % 10 < 4 ? 3 : 1));
    irregular.addFile('i', Float64Array.from(holes), { v: new Float64Array(holes.length).fill(1) });
    const iplot = plotWith([{ fileId: 'i', varName: 'v' }], { showGaps: true });
    const notice = irregular._gapsStepNotice(iplot);
    assert.equal(notice.mode, 'irregular', 'weak agreement is reported');
    assert.ok(!notice.label.includes('{'), 'with its placeholders filled');
    irregular._setGapSettings('i', { dt: 1 });
    assert.equal(irregular._gapsStepNotice(iplot), null, 'a manual step is the user’s call: no nagging');
}

// Marks count and line shape state.
{
    const h = new Harness();
    // Stack is a View setting now: Marks counts only what it draws.
    assert.equal(h._marksActiveCount({ showNaN: true, showGaps: true, timeseriesStacked: true }), 2);
    assert.equal(h._panelLineShapeState({ traces: [] }), 'auto');
    assert.equal(h._panelLineShapeState({ traces: [{ lineShape: 'hv' }, { lineShape: 'linear' }] }), 'mixed');
}

// Lazy: the automatic step comes from a step histogram queried once per data
// object, and the panel redraws when it arrives.
{
    const h = new Harness();
    let queries = 0;
    const source = {
        async getStepHistogram() {
            queries++;
            const { bins, positive } = stepHistogram(Float64Array.from({ length: 50 }, (_, i) => i * 2));
            return { bins: [...bins].map(([key, bin]) => ({ key, ...bin })), positive };
        },
    };
    h.addFile('L', new Float64Array(0), { v: new Float64Array(0) }, { _duckdb: { viewMode: true, source } });
    h.files.get('L').data.metadata = { timeStart: 0, timeEnd: 100 };
    h.plots.set('p', plotWith([{ fileId: 'L', varName: 'v' }], { showGaps: true }));
    const first = h._autoGapStep('L');
    assert.equal(first.pending, true, 'pending until DuckDB answers');
    h._autoGapStep('L');
    await h.files.get('L').data._gapStepEstimate.promise;
    assert.equal(queries, 1, 'one query per data object');
    assert.ok(close(h._autoGapStep('L').dt, 2), 'then the step is known');
    assert.deepEqual(h.refreshed, ['p'], 'and the panel showing it redraws');
}

// Lazy marks coordinator: latest viewport wins, NaN regions and gaps (for the
// file's step) come back from one bucket query.
{
    const h = new Harness();
    const calls = [];
    const source = {
        getMissingIntervals(_data, _vars, _lo, _hi, _n, { signal }) {
            return new Promise((resolve, reject) => {
                calls.push({ resolve });
                signal.addEventListener('abort', () => {
                    const err = new Error('cancelled');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            });
        },
    };
    h.addFile('L', new Float64Array(0), { v: new Float64Array(0) }, { _duckdb: { viewMode: true, source } });
    h.files.get('L').gapSettings = { dt: 1, factor: 1.5 };
    h._zoomTokens = new Map([['p', 1]]);
    const plot = plotWith([{ fileId: 'L', varName: 'v' }], { showNaN: true, showGaps: true });
    const first = h._refreshLazyTimeseriesMarks('p', plot, 0, 100, 1);
    assert.equal(h.notices.at(-1), 'loading', 'a spinner while DuckDB works');
    h._zoomTokens.set('p', 2);
    const second = h._refreshLazyTimeseriesMarks('p', plot, 0, 100, 2);
    assert.equal(calls.length, 2, 'the new viewport starts its own query');
    const buckets = [];
    for (let b = 0; b < 10; b++) {
        if (b === 4) continue;
        buckets.push({ b, nTotal: 10, nMissing: b === 7 ? 10 : 0, tMin: b * 10, tMax: b * 10 + 9 });
    }
    calls[1].resolve({ buckets });
    await Promise.all([first, second]);
    assert.deepEqual(plot._lazyGapItems.map(g => [g.t0, g.t1]), [[39, 50]], 'the gap, for the file’s own step');
    assert.deepEqual(plot._lazyNanRegions.map(r => [r.t0, r.t1, r.level]), [[70, 80, 4]], 'the NaN bucket');
    assert.equal(h._lazyMissingRequests.size, 0, 'the request cleans up after itself');
    assert.ok(relayouts.length > 0, 'and the overlays are painted');
}

assert.ok(i18nKeys.timeseriesNaNHover.includes('{percent}'), 'the hover text has its placeholders');
console.log('NaN/Inf and Gaps marks tests passed');
