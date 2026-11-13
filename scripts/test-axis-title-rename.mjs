// The Y axis of a time pane carries the name of the one curve drawn against
// it — and keeps carrying it when that variable is renamed.
//
//   node scripts/test-axis-title-rename.mjs
//
// Renaming a variable that is already drawn does not rebuild the panel: the
// curves are relabelled in place (PlotManager.relabelTimeseriesTraces), which
// used to leave the axis title saying the old name while the legend said the
// new one. The title and the update a relabel has to apply are computed here
// (_timeseriesAxisTitle, _timeseriesAxisTitleUpdate), so both can be checked
// without a browser; that the relabel applies it is checked by the source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

// PlotManager imports Plotly, so the one method of it this needs — what a unit
// in a description is — is taken from its source, as the lazy fit test takes
// the methods it needs.
// Flattened: a checkout with CRLF line endings must find the same text.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const managerSource = read('src/plots/plot-manager.js');
const head = '    _extractUnit(description) {';
const at = managerSource.indexOf(head);
assert.ok(at > 0, '_extractUnit is where it was');
const extractUnit = new Function('description', managerSource.slice(at + head.length, managerSource.indexOf('\n    }\n', at)));
assert.equal(extractUnit('Power [kW]'), 'kW', 'and it reads a unit');

const FILE = 'f';
class Harness {
    constructor(variables) {
        this.activeFileId = FILE;
        this.language = 'en';
        this.files = new Map([[FILE, {
            name: 'rename.csv',
            transform: {},
            data: { metadata: { timeName: 'time' }, variables },
        }]]);
    }
}
installPlotDataMethods(Harness);
// What the panel would answer about its traces; the rest of the builder is not
// what is under test here.
Harness.prototype._traceYAxis = function(trace) { return trace.axis === 'y2' ? 'y2' : 'y'; };
Harness.prototype._variableLabel = function(varName) { return varName; };
Harness.prototype._extractUnit = extractUnit;

const variables = () => ({
    time: { name: 'time', kind: 'abscissa', data: [0, 1, 2] },
    power: { name: 'power', description: 'Power [kW]', data: [1, 2, 3] },
    total: { name: 'total', description: 'Derived: a + b', derived: true, data: [2, 4, 6] },
    other: { name: 'other', description: '', data: [3, 2, 1] },
});

// ── One curve names the axis, with its unit ──
{
    const h = new Harness(variables());
    const plot = { traces: [{ fileId: FILE, varName: 'power', axis: 'y' }] };
    assert.equal(h._timeseriesAxisTitle(plot, 'y'), 'power [kW]', 'the name and the unit');
    assert.equal(h._timeseriesAxisTitle(plot, 'y2'), '', 'nothing is drawn against the right axis');

    // A derived variable's description is its formula, not a unit.
    const derived = { traces: [{ fileId: FILE, varName: 'total', axis: 'y' }] };
    assert.equal(h._timeseriesAxisTitle(derived, 'y'), 'total', 'a derived variable names the axis');

    // Two curves: the legend names them, the axis stays out of it.
    const two = { traces: [{ fileId: FILE, varName: 'power', axis: 'y' }, { fileId: FILE, varName: 'other', axis: 'y' }] };
    assert.equal(h._timeseriesAxisTitle(two, 'y'), '', 'two curves leave the axis blank');

    // One on each axis: each names its own.
    const split = { traces: [{ fileId: FILE, varName: 'power', axis: 'y' }, { fileId: FILE, varName: 'total', axis: 'y2' }] };
    assert.equal(h._timeseriesAxisTitle(split, 'y'), 'power [kW]');
    assert.equal(h._timeseriesAxisTitle(split, 'y2'), 'total');

    // A state band has its own lane: it does not count as a curve.
    const banded = { traces: [{ fileId: FILE, varName: 'power', axis: 'y' }, { fileId: FILE, varName: 'other', axis: 'y', stateBand: true }] };
    Harness.prototype._isStateBandTrace = (trace) => !!trace.stateBand;
    assert.equal(h._timeseriesAxisTitle(banded, 'y'), 'power [kW]', 'the band does not take the axis name away');
    delete Harness.prototype._isStateBandTrace;
}

// ── The update a rename has to apply ──
{
    const h = new Harness(variables());
    const trace = { fileId: FILE, varName: 'total', axis: 'y' };
    const plot = { traces: [trace] };
    // The chart as it was drawn, under the old name.
    const div = { _fullLayout: { yaxis: { title: { text: 'total' } } } };
    plot.div = div;
    assert.deepEqual(h._timeseriesAxisTitleUpdate(plot, div), {}, 'nothing to do while the name is the one drawn');

    // The rename: the variable and the trace move to the new name, as
    // _renameVariable moves them.
    const data = h.files.get(FILE).data;
    data.variables.energy = { ...data.variables.total, name: 'energy' };
    delete data.variables.total;
    trace.varName = 'energy';
    assert.deepEqual(
        h._timeseriesAxisTitleUpdate(plot, div),
        { 'yaxis.title.text': 'energy' },
        'the axis is asked to say the new name',
    );

    // With the second axis on, both are considered.
    plot.timeseriesY2Enabled = true;
    div._fullLayout.yaxis2 = { title: { text: 'stale' } };
    assert.deepEqual(
        h._timeseriesAxisTitleUpdate(plot, div),
        { 'yaxis.title.text': 'energy', 'yaxis2.title.text': '' },
        'and a right axis with nothing on it is cleared',
    );
    // A chart that is not laid out yet is left alone.
    assert.deepEqual(h._timeseriesAxisTitleUpdate(plot, {}), {}, 'no layout, no update');
    assert.deepEqual(h._timeseriesAxisTitleUpdate(plot, null), {}, 'no chart, no update');
}

// ── The relabel applies it ──
{
    const source = read('src/plots/plot-manager.js');
    const block = source.slice(source.indexOf('relabelTimeseriesTraces(panelId'), source.indexOf('renameTransformCacheEntries('));
    assert.match(
        block,
        /_timeseriesAxisTitleUpdate\(plot, div\);[\s\S]*?Plotly\.relayout\(div, titles\)/,
        'relabelTimeseriesTraces renames the axis as well as the legend',
    );
    const layout = read('src/plots/methods/data-methods.js');
    assert.match(
        layout,
        /const yTitle = this\._timeseriesAxisTitle\(plot, 'y'\);/,
        'and the layout builder reads the same title',
    );
}

console.log('axis title on rename: ok');
