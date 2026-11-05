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

// ── The chooser, run ────────────────────────────────────────────────────────
const start = interaction.indexOf('proto._linkedTimeWindow = function');
assert.ok(start >= 0, '_linkedTimeWindow is there');
const end = interaction.indexOf('\nproto.', start + 10);
assert.ok(end > start, 'its end is there');
// Evaluated in THIS realm, not a vm context: the arrays it returns are then
// ordinary arrays, which deepEqual can compare against the ones here.
const context = { proto: {} };
new Function('proto', interaction.slice(start, end))(context.proto);

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
}
Harness.prototype._linkedTimeWindow = context.proto._linkedTimeWindow;

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
}

console.log('Linked-panel time window tests passed.');
