// A panel getting its FIRST curve opens on the window its linked panels show.
//
//   node scripts/test-linked-panel-window.mjs
//
// Two panels, a trace from a different file in each. The second panel was laid
// out from its own trace alone, so it opened fitted to that record — and when
// that record is shorter, or starts later, than what the first panel shows, the
// two charts sat side by side on different time windows with the time axes
// linked and nobody having asked for a zoom. The link only ever moved a window
// that already existed; it had no say in the one a panel is born with.
//
// Dropping onto a chart that EXISTS already keeps the window (only Y expands),
// so this is that rule extended to the first drop. Sliced out of the sources
// rather than imported: the modules pull in Plotly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const interaction = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');

// ── The two helpers, run ────────────────────────────────────────────────────
// Evaluated in THIS realm, not a vm context: the arrays they return are then
// ordinary arrays, which deepEqual can compare against the ones here.
const context = { proto: {} };
const slice = (name) => {
    const start = interaction.indexOf(`proto.${name} = function`);
    assert.ok(start >= 0, `${name} is there`);
    const end = interaction.indexOf('\nproto.', start + 10);
    assert.ok(end > start, `${name} ends`);
    return interaction.slice(start, end);
};
new Function('proto', [slice('_linkedTimeWindow'), slice('_timeWindowsOverlap'), slice('_mergedTimeWindow')]
    .join('\n'))(context.proto);

class Harness {
    constructor(plots, { syncAxes = true } = {}) {
        this.syncAxes = syncAxes;
        this.plots = new Map(plots);
        this.independentFiles = new Set();
        this.displayModes = new Map();
    }
    _plotAxisIsIndependent(plot) {
        const traces = plot?.traces || [];
        return traces.length > 0 && traces.every(t => this.independentFiles.has(t.fileId));
    }
    _linkTimeFileId(plot) {
        return (plot?.traces || []).find(t => !this.independentFiles.has(t.fileId))?.fileId
            ?? plot?.traces?.[0]?.fileId ?? null;
    }
    _timeDisplayMode(fileId) { return this.displayModes.get(fileId) || 'calendar'; }
    // The real one (interaction-methods.js) parses the floating ISO the app
    // writes; Date.parse reads the forms used here.
    _coerceAxisValue(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : Date.parse(String(value).replace(' ', 'T') + 'Z');
    }
    _timeDisplayModeForVar(fileId) { return this._timeDisplayMode(fileId); }
    _isGeneratedCalendarTime() { return false; }
    _getTimeVar() { return {}; }
    _plotlyTimeArray(_fileId, values) {
        return Array.from(values, v => new Date(v).toISOString().replace('T', ' ').slice(0, 19));
    }
}
Harness.prototype._linkedTimeWindow = context.proto._linkedTimeWindow;
Harness.prototype._timeWindowsOverlap = context.proto._timeWindowsOverlap;
Harness.prototype._mergedTimeWindow = context.proto._mergedTimeWindow;

// A panel already on screen, showing `range`.
const live = (fileId, range, extra = {}) => ({
    mode: 'timeseries',
    traces: [{ fileId, varName: 'v' }],
    div: { _fullLayout: { xaxis: { range } } },
    ...extra,
});
// The panel being born: traces pushed, no chart yet.
const newborn = (fileId, extra = {}) => ({
    mode: 'timeseries',
    traces: [{ fileId, varName: 'w' }],
    div: null,
    ...extra,
});

const WINDOW = ['2026-06-02 13:45:00', '2026-06-02 15:40:00'];

// ── The case from the report ────────────────────────────────────────────────
{
    const born = newborn('energy');
    const h = new Harness([['top', live('rec', WINDOW)], ['bottom', born]]);
    assert.deepEqual(h._linkedTimeWindow('bottom', born), WINDOW,
        'the second panel adopts the window the first one is showing');
    // A copy: writing it into a layout must not alias the donor's own array.
    assert.notEqual(h._linkedTimeWindow('bottom', born), WINDOW);
}

// ── Nothing to adopt ────────────────────────────────────────────────────────
{
    // The first panel of all: no donor, so it keeps fitting to its own trace.
    const born = newborn('rec');
    const h = new Harness([['only', born]]);
    assert.equal(h._linkedTimeWindow('only', born), null);
}
{
    // A panel that exists but has never been drawn has no window to lend.
    const born = newborn('energy');
    const h = new Harness([['empty', newborn('rec')], ['bottom', born]]);
    assert.equal(h._linkedTimeWindow('bottom', born), null);
}
{
    // Nor has one whose axis carries no range yet.
    const born = newborn('energy');
    const h = new Harness([['top', live('rec', null)], ['bottom', born]]);
    assert.equal(h._linkedTimeWindow('bottom', born), null);
}
{
    // Linking off: the panels are meant to be independent, so the new one is
    // fitted to its own trace, as before.
    const born = newborn('energy');
    const h = new Harness([['top', live('rec', WINDOW)], ['bottom', born]], { syncAxes: false });
    assert.equal(h._linkedTimeWindow('bottom', born), null);
}

// ── The eligibility is the link's own (see _syncXAxisUpdate) ────────────────
{
    // Clocks that display differently are not on one axis, so one cannot hand
    // the other a window — the same test that keeps a pan from crossing.
    const born = newborn('energy');
    const h = new Harness([['top', live('rec', WINDOW)], ['bottom', born]]);
    h.displayModes.set('rec', 'calendar');
    h.displayModes.set('energy', 'elapsedSeconds');
    assert.equal(h._linkedTimeWindow('bottom', born), null);
}
{
    // A correlation's lag axis is not a clock: it neither sends nor receives.
    const born = newborn('energy');
    const h = new Harness([['lag', live('xcorr', [-5, 5])], ['bottom', born]]);
    h.independentFiles.add('xcorr');
    assert.equal(h._linkedTimeWindow('bottom', born), null);
    // And a panel that is itself on one adopts nothing.
    const lagBorn = newborn('xcorr');
    const h2 = new Harness([['top', live('rec', WINDOW)], ['lag', lagBorn]]);
    h2.independentFiles.add('xcorr');
    assert.equal(h2._linkedTimeWindow('lag', lagBorn), null);
}
{
    // Only time plots are in the link. An FFT panel is not a donor.
    const born = newborn('energy');
    const h = new Harness([
        ['fft', { ...live('rec', WINDOW), mode: 'fft' }],
        ['bottom', born],
    ]);
    assert.equal(h._linkedTimeWindow('bottom', born), null);
    // Nor is the panel being born, when it is not a time plot.
    const phase = { ...newborn('energy'), mode: 'phase2d' };
    const h2 = new Harness([['top', live('rec', WINDOW)], ['p', phase]]);
    assert.equal(h2._linkedTimeWindow('p', phase), null);
}
{
    // Several linked panels are kept in step, so the first eligible one speaks
    // for all of them — and an ineligible panel ahead of it is stepped over.
    const born = newborn('energy');
    const h = new Harness([
        ['lag', live('xcorr', [-5, 5])],
        ['top', live('rec', WINDOW)],
        ['other', live('rec', ['2026-06-02 14:00:00', '2026-06-02 14:30:00'])],
        ['bottom', born],
    ]);
    h.independentFiles.add('xcorr');
    assert.deepEqual(h._linkedTimeWindow('bottom', born), WINDOW);
}

// ── A record that does not reach the shared window ──────────────────────────
// Adopting it would open the panel on an empty chart. The trace is fitted to
// itself instead — the zoom fit the panel would have had before all this.
{
    const h = new Harness([]);
    const own = ['2026-06-02 16:00:00', '2026-06-02 17:00:00'];
    assert.equal(h._timeWindowsOverlap(own, WINDOW), false, 'a record wholly after the window');
    assert.equal(h._timeWindowsOverlap(['2026-06-01 09:00:00', '2026-06-01 10:00:00'], WINDOW), false,
        'and wholly before it');
    // Any contact at all is enough: the curve is drawn in the window, even when
    // it only reaches the edge, and even when it dwarfs or nests inside it.
    assert.equal(h._timeWindowsOverlap(['2026-06-02 15:40:00', '2026-06-02 17:00:00'], WINDOW), true,
        'touching at one instant');
    assert.equal(h._timeWindowsOverlap(['2026-06-02 14:00:00', '2026-06-02 14:30:00'], WINDOW), true,
        'a record inside the window');
    assert.equal(h._timeWindowsOverlap(['2026-06-01 00:00:00', '2026-06-03 00:00:00'], WINDOW), true,
        'a record that spans past both ends');
    // Order within a range is not promised; a reversed one still overlaps.
    assert.equal(h._timeWindowsOverlap([WINDOW[1], WINDOW[0]], WINDOW), true);
    // Numeric axes (elapsed seconds, index) go through the same test.
    assert.equal(h._timeWindowsOverlap([0, 10], [20, 30]), false);
    assert.equal(h._timeWindowsOverlap([0, 25], [20, 30]), true);
    // Nothing to compare against is not an overlap.
    for (const bad of [null, undefined, [], [NaN, 1], ['not a time', 'either']]) {
        assert.equal(h._timeWindowsOverlap(bad, WINDOW), false, `rejects ${JSON.stringify(bad)}`);
        assert.equal(h._timeWindowsOverlap(WINDOW, bad), false);
    }

    // No single window holds both, and the link allows only one, so it widens
    // to cover the two records — written the way the panel's own range is.
    const plot = newborn('energy');
    assert.deepEqual(
        h._mergedTimeWindow(plot, own, WINDOW),
        ['2026-06-02 13:45:00', '2026-06-02 17:00:00'],
        'the union runs from the earliest start to the latest end',
    );
    // Order of the two, and order within either, does not matter.
    assert.deepEqual(h._mergedTimeWindow(plot, WINDOW, own), ['2026-06-02 13:45:00', '2026-06-02 17:00:00']);
    assert.deepEqual(
        h._mergedTimeWindow(plot, [own[1], own[0]], [WINDOW[1], WINDOW[0]]),
        ['2026-06-02 13:45:00', '2026-06-02 17:00:00'],
    );
    // A numeric axis keeps numbers: only a calendar one is written as instants.
    const numeric = newborn('elapsed');
    h.displayModes.set('elapsed', 'elapsedSeconds');
    assert.deepEqual(h._mergedTimeWindow(numeric, [0, 10], [900, 1000]), [0, 1000]);
    // A range that cannot be read is no basis for a window.
    for (const bad of [null, undefined, [], ['nope', 'nope']]) {
        assert.equal(h._mergedTimeWindow(plot, bad, WINDOW), null);
        assert.equal(h._mergedTimeWindow(plot, WINDOW, bad), null);
    }
}

// ── The wiring ──────────────────────────────────────────────────────────────
// The chooser is only consulted for a panel getting its first curve, and only
// when no view is being restored. Read from the source: running it would mean
// a real Plotly and a real chart.
{
    const addTimeseries = manager.slice(
        manager.indexOf('    _addTimeseries(panelId, varName, panelEl, plot, options = {}) {'),
        manager.indexOf('    _addTimeseriesBatch('),
    );
    assert.ok(addTimeseries.length > 100, 'sliced _addTimeseries');
    assert.match(
        addTimeseries,
        /if \(!plot\.div\) \{[\s\S]*plot\._adoptLinkedTimeWindow = true;[\s\S]*_createChart\(panelId, panelEl\);/,
        'the flag is raised on the branch that has no chart yet, before it is created',
    );
    // The branch that adds to a chart already on screen must not raise it: that
    // path keeps the window by not touching the x axis at all.
    const existingChartBranch = addTimeseries.slice(addTimeseries.indexOf('} else {'));
    assert.doesNotMatch(existingChartBranch, /_adoptLinkedTimeWindow/);

    const createChart = manager.slice(
        manager.indexOf('        const { traces, layout } = this._buildPlotData(plot);'),
        manager.indexOf('            this._refreshActionBtns(panelId);'),
    );
    assert.ok(createChart.includes('Plotly.newPlot'), 'sliced across newPlot');
    assert.match(createChart, /delete plot\._adoptLinkedTimeWindow;/,
        'the flag is consumed, so a later rebuild does not inherit it');
    assert.match(createChart, /adoptLinkedWindow && !restoreView/,
        'a view being restored still wins');
    assert.ok(
        createChart.indexOf('layout.xaxis.range = linkedWindow;') < createChart.indexOf('Plotly.newPlot'),
        'the window is written into the layout before the chart is drawn, not relaid out after',
    );
    assert.match(createChart, /layout\.xaxis\.autorange = false;/,
        'an explicit range needs autorange off, or Plotly refits it');
    assert.match(createChart, /this\._timeWindowsOverlap\(ownRange, shared\)/,
        'the shared window is only taken as it stands when the record reaches it');
    assert.match(createChart, /widen[\s\S]*this\._mergedTimeWindow\(plot, ownRange, shared\)/,
        'and is widened to cover both when it does not');
    assert.ok(
        createChart.indexOf('this._timeWindowsOverlap') < createChart.indexOf('layout.xaxis.range = linkedWindow;'),
        'the choice is made before the window is written into the layout',
    );
    // The point of widening: the panels already on screen come along. Fitting
    // this one alone is the misalignment the whole change exists to stop.
    assert.match(
        createChart,
        /if \(widen && linkedWindow\) \{\s*this\._syncXAxisUpdate\(panelId, \{\s*'xaxis\.range': linkedWindow,\s*'xaxis\.autorange': false,/,
        'a widened window is carried to the linked panels, the way a pan carries one',
    );
    assert.ok(
        createChart.indexOf('Plotly.newPlot') < createChart.indexOf('_syncXAxisUpdate'),
        'and only once this panel is drawn, so the link has something to sync against',
    );
    // Adopting a window unchanged must NOT move the other panels: they are
    // already on it, and a relayout each would be work for nothing.
    assert.doesNotMatch(createChart, /if \(linkedWindow\) \{?\s*this\._syncXAxisUpdate/);
}

console.log('Linked-panel time window tests passed.');
