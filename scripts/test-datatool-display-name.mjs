// The name a data tool's output shows.
//
// Some formats give a variable a display name that is not its key: a pandas
// pickle names a column the way pandas does, and netCDF and audio do the same.
// The data tools build their output by spreading the SOURCE variable, so that
// label was copied onto the result — and the legend, the tree and the panel
// statistics went on showing the source's name for a signal the user had just
// named something else. CSV and Modelica files never set a display name, which
// is why it only ever showed up on pickles.
//
// One rule, both directions: a display name belongs to the variable that
// carries it. Written under a new name, the output shows that name; copied
// under its own name, the label comes along.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';
import { installResampleMethods } from '../src/app/methods/resample-methods.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

const PARSER = {
    _detectDataType: () => 'real',
    _isConstantValues: () => false,
    _buildTree: (variables) => ({ _variables: { ...variables } }),
};

class ToolHarness {
    constructor() { this.parser = PARSER; }
}
installDataToolsMethods(ToolHarness);
installResampleMethods(ToolHarness);
const tools = new ToolHarness();

// The legend, the tree and the statistics all read the label through this.
class LabelHarness {
    constructor(variables) {
        this.activeFileId = 'f1';
        this.files = new Map([['f1', { name: 'run.pkl', transform: {}, data: { metadata: { timeName: 'time' }, variables } }]]);
    }
}
installPlotDataMethods(LabelHarness);

// A pandas pickle: the key is sanitised, the label is what pandas called it.
const pickled = (name, displayName) => ({
    name,
    displayName,
    data: Float64Array.from([1, 2, 3]),
    description: '[V]',
    kind: 'variable',
    dataType: 'real',
    interpolation: 'linear',
});

// movingAverage, because its description needs nothing but this module.
const config = (targetMode, targetName) => ({
    tool: 'movingAverage',
    sourceName: 'sensor_a',
    targetMode,
    targetName,
    method: 'movingAverage',
    params: { window: 5 },
});

// ─── Creating a new variable ───────────────────────────────────────
{
    const source = pickled('sensor_a', 'sensor.a [V]');
    const created = tools._baseDataToolVariable(
        source.data, source, config('create', 'sensor_a_filtered'), Float64Array.from([1, 1, 1]),
    );
    assert.equal(created.name, 'sensor_a_filtered');
    assert.equal(created.displayName, 'sensor_a_filtered',
        'the output shows the name the user typed, not the source label it was spread from');

    const label = new LabelHarness({ sensor_a: source, sensor_a_filtered: created });
    assert.equal(label._variableLabel('sensor_a_filtered', 'f1'), 'sensor_a_filtered',
        'which is what the legend reads');
    assert.equal(label._variableLabel('sensor_a', 'f1'), 'sensor.a [V]',
        'and the source keeps its own label');
}

// ─── Modifying a variable in place ─────────────────────────────────
{
    const source = pickled('sensor_a', 'sensor.a [V]');
    const modified = tools._baseDataToolVariable(
        source.data, source, config('modify', 'sensor_a'), Float64Array.from([2, 2, 2]),
    );
    assert.equal(modified.displayName, 'sensor.a [V]',
        'the same variable keeps the label it had — the tool changed its values, not what it is');
    assert.equal(modified.description, source.description, 'and its description');
}

// ─── A source with no label is unaffected ──────────────────────────
{
    const plain = { ...pickled('a', undefined), displayName: undefined };
    delete plain.displayName;
    const created = tools._baseDataToolVariable(plain.data, plain, config('create', 'a_filtered'), plain.data);
    const label = new LabelHarness({ a: plain, a_filtered: created });
    assert.equal(label._variableLabel('a_filtered', 'f1'), 'a_filtered',
        'a CSV or Modelica variable reads exactly as it did before');
}

// ─── A resampled copy keeps its label ──────────────────────────────
{
    const source = pickled('sensor_a', 'sensor.a [V]');
    const sourceData = {
        metadata: { timeName: 'time' },
        variables: {
            time: { name: 'time', kind: 'abscissa', data: Float64Array.from([0, 1, 2]), description: '[s]' },
            sensor_a: source,
            gain: { name: 'gain', displayName: 'gain.k', kind: 'parameter', data: Float64Array.from([2]) },
        },
    };
    const resampled = tools._buildResampledData(
        sourceData,
        { kind: 'numeric', name: 'time', variable: sourceData.variables.time },
        { params: { method: 'linear', gridMode: 'step', gapPolicy: 'keep' } },
        ['sensor_a'],
        { grid: Float64Array.from([0, 0.5, 1]), columns: [Float64Array.from([1, 1.5, 2])], step: 0.5 },
    );
    assert.equal(resampled.variables.sensor_a.displayName, 'sensor.a [V]',
        'the copy is the same signal on a new grid, so it reads the same');
    assert.equal(resampled.variables.gain.displayName, 'gain.k',
        'parameters came across untouched already');

    const label = new LabelHarness(resampled.variables);
    assert.equal(label._variableLabel('sensor_a', 'f1'), 'sensor.a [V]',
        'so the resampled file does not show a different name from the original beside it');
}

// ─── Every data-tool creation site, not just the shared one ────────
const dataTools = readFileSync(new URL('../src/app/methods/data-tools-methods.js', import.meta.url), 'utf8');
// Three places build the output by spreading the source variable; every one of
// them has to say what the result is called, or the label rides along again.
const lines = dataTools.split('\n');
const spreadAt = lines.map((line, i) => (line.trim() === '...sourceVariable,' ? i : -1)).filter(i => i >= 0);
assert.ok(spreadAt.length >= 3, `the data tools still spread the source variable (found ${spreadAt.length})`);
for (const at of spreadAt) {
    const block = lines.slice(at, at + 12).join('\n');
    assert.match(block, /displayName:/,
        `a variable spread from its source must say what it is called (line ${at + 1}):\n${block}`);
}

console.log('Data-tool display-name checks passed.');
