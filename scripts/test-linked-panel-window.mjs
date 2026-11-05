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
new Function('proto', [slice('_linkedTimeWindow'), slice('_timeWindowsOverlap')].join('\n'))(context.proto);

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
}
Harness.prototype._linkedTimeWindow = context.proto._linkedTimeWindow;
Harness.prototype._timeWindowsOverlap = context.proto._timeWindowsOverlap;

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
        'the shared window is only taken when the record reaches it');
    assert.ok(
        createChart.indexOf('this._timeWindowsOverlap') < createChart.indexOf('layout.xaxis.range = linkedWindow;'),
        'and the test comes first, so a record outside it keeps the fit the layout already holds',
    );
}

console.log('Linked-panel time window tests passed.');
