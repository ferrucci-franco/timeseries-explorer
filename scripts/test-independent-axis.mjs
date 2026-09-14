// A cross-correlation's lag axis stands on its own.
//
// It is a duration in seconds, so it looks exactly like elapsed time and would
// otherwise pass every compatibility test the panel makes — but its zero is
// "no shift", not the start of the record. So a panel drawing NOTHING BUT
// correlations must not have its x-axis tied to the panels showing the
// signals, in either direction, and the synchronized hover must not carry a
// moment across to it. A panel that draws signals too keeps its place in the
// link: its axis is their time, and the lag trace rides along.
//
// Two cross-correlations do not link their axes either: each was asked for its
// own lag range, and comparing them means putting them in ONE panel.
//
// `_syncXAxisUpdate` is a prototype function in interaction-methods.js, which
// imports Plotly at module scope; as elsewhere in these tests, the function is
// sliced out and run against a mock `this` and a mock Plotly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

const source = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
const startMarker = 'proto._syncXAxisUpdate = function(sourcePanelId, update) {';
const start = source.indexOf(startMarker);
assert.ok(start >= 0, '_syncXAxisUpdate is present');
const end = source.indexOf('\nproto.', start + 1);
assert.ok(end > start, 'method end located');

const relayouted = [];
const proto = {};
vm.runInNewContext(source.slice(start, end), {
    proto,
    Promise,
    Plotly: { relayout: (div) => { relayouted.push(div.id); return Promise.resolve(); } },
});

class Harness {
    static GL_POINT_THRESHOLD = 50000;

    constructor() {
        this.activeFileId = 'signals';
        this.syncAxes = true;
        const file = (metadata, values) => ({
            name: 'f', transform: {},
            data: { metadata, variables: { [metadata.timeName]: { name: metadata.timeName, kind: 'abscissa', data: Float64Array.from(values) } } },
        });
        this.files = new Map([
            ['signals', file({ timeName: 'time', timeKind: 'numeric', numTimesteps: 3 }, [0, 1, 2])],
            ['more-signals', file({ timeName: 'time', timeKind: 'numeric', numTimesteps: 3 }, [0, 1, 2])],
            ['xcorr-a', file({ timeName: 'lag', timeKind: 'numeric', numTimesteps: 3, independentAxis: true, xcorr: { x: 'theta', y: 'omega' } }, [-1, 0, 1])],
            // Stored before the flag existed: the xcorr block alone must name it.
            ['xcorr-b', file({ timeName: 'lag', timeKind: 'numeric', numTimesteps: 3, xcorr: { x: 'theta', y: 'theta' } }, [-3, 0, 3])],
        ]);
        const panel = (id, fileId) => [id, { mode: 'timeseries', div: { id }, traces: [{ fileId, varName: 'y' }] }];
        this.plots = new Map([
            panel('p-signals', 'signals'),
            panel('p-more', 'more-signals'),
            panel('p-xcorr-a', 'xcorr-a'),
            panel('p-xcorr-b', 'xcorr-b'),
        ]);
    }

    _getTimeVar(fileId = this.activeFileId) {
        const data = this.files.get(fileId)?.data;
        return data?.variables?.[data.metadata.timeName] ?? null;
    }

    _extractUnit(description = '') { return /\[([^\]]+)\]/.exec(description)?.[1] || ''; }
    _refreshTimeseriesVisuals() {}
}
installPlotDataMethods(Harness);
Harness.prototype._syncXAxisUpdate = proto._syncXAxisUpdate;

const h = new Harness();
const sync = (panelId) => {
    relayouted.length = 0;
    h._syncing = false;
    h._syncXAxisUpdate(panelId, { 'xaxis.range': [0, 1] });
    return [...relayouted].sort();
};

// ── Knowing a lag axis when it sees one ───────────────────────────────────
assert.equal(h._hasIndependentAxis('signals'), false, 'a plain file rides the shared clock');
assert.equal(h._hasIndependentAxis('xcorr-a'), true, 'the flag marks the lag axis');
assert.equal(h._hasIndependentAxis('xcorr-b'), true, 'an older dataset is known by its xcorr block');
assert.equal(h._hasIndependentAxis('nothing-here'), false, 'an unknown file is not independent');

// ── Who follows whom ──────────────────────────────────────────────────────
assert.deepEqual(sync('p-signals'), ['p-more'], 'signals follow signals, never a lag panel');
assert.deepEqual(sync('p-xcorr-a'), [], 'a lag panel moves nothing');
assert.deepEqual(sync('p-xcorr-b'), [], 'not even the other cross-correlation');
assert.equal(h._syncing, false, 'a lag panel never even opens a sync');

// A panel that ALSO draws signals keeps its place in the link: it is their
// time axis that moves, and the lag trace rides along. Only a panel drawing
// nothing but correlations stands apart.
h.plots.get('p-more').traces.push({ fileId: 'xcorr-a', varName: 'r_xy' });
assert.equal(h._plotAxisIsIndependent(h.plots.get('p-more')), false, 'signals plus a lag trace is still a signal panel');
assert.deepEqual(sync('p-signals'), ['p-more'], 'so it still follows');
assert.deepEqual(sync('p-more'), ['p-signals'], 'and still leads, without waking the lag panels');
// Even when the lag trace is the first one on the panel, which is what names
// the panel's file elsewhere.
h.plots.get('p-more').traces.reverse();
assert.equal(h._linkTimeFileId(h.plots.get('p-more')), 'more-signals', 'the link reads the clock from a signal trace');
assert.deepEqual(sync('p-signals'), ['p-more'], 'order on the panel makes no difference');
h.plots.get('p-more').traces = h.plots.get('p-more').traces.filter(t => t.fileId !== 'xcorr-a');
assert.deepEqual(sync('p-signals'), ['p-more'], 'and nothing changed once the lag trace is gone');
assert.equal(h._plotAxisIsIndependent({ traces: [] }), false, 'an empty panel is not a lag panel');

// ── The shared hover obeys the same line ──────────────────────────────────
// _onHover reads the DOM and Plotly's layout, so the rule is read off the
// source: a panel takes part only when its axis is the same KIND as the
// hovered one.
const hover = source.slice(source.indexOf('proto._onHover = function'), source.indexOf('proto._onUnhover'));
assert.match(
    hover,
    /const sourceIsIndependent = this\._plotAxisIsIndependent\(srcPlot\);/,
    'the hover knows whether it started on a lag axis',
);
assert.match(
    hover,
    /if \(this\._plotAxisIsIndependent\(plot\) !== sourceIsIndependent\) continue;/,
    'and skips every panel of the other kind',
);

console.log('independent-axis tests passed');
