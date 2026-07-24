// Tests for the time-axis "sample index" derived variable: dragging the time
// axis onto a plot creates a derived signal whose value is the sample ordinal
// (0, 1, 2, …). Plotted against time it advances by 1 per sample and, where
// samples share a timestamp (events), climbs by that count. The variable reuses
// the derived-variable machinery so it persists, removes, and reapplies like any
// other, and works for every format including lazy (computed over the overview).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index.js';
import { installDerivedMethods } from '../src/app/methods/derived-methods.js';

class Harness {
    constructor() {
        this.activeFileId = 'f1';
        this.derivedByFile = new Map();
        this.dataToolVariablesByFile = new Map();
        this.treeRenders = 0;
        this.rebuilds = [];
        this.plotManager = { files: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
        // Instance stubs shadow the prototype methods installed below.
        this._renderFilteredTree = () => { this.treeRenders++; };
        this._rebuildPlotsUsingVariable = (fileId, name) => { this.rebuilds.push([fileId, name]); };
    }
}
installDerivedMethods(Harness);

function makeFile(h, fileId, times, extra = {}) {
    const variables = {
        time: { name: 'time', kind: 'abscissa', data: Float64Array.from(times) },
        ...extra,
    };
    const data = { variables, metadata: { timeName: 'time' } };
    h.plotManager.files.set(fileId, { data });
    return data;
}

// ── Index generation: ordinal 0..n-1, forced real, marked, stored everywhere ──
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 1, 2, 3]); // one duplicate timestamp at t=1
    const v = h._createOrUpdateTimeAxisIndexVariable('f1');
    assert.equal(v.name, 'time_index', 'name derives from the time variable');
    assert.deepEqual(Array.from(v.data), [0, 1, 2, 3, 4], 'value is the sample ordinal');
    assert.equal(v.dataType, 'real', 'forced real (a 2-sample [0,1] index must not read as boolean)');
    assert.equal(v.derived, true, 'flagged as derived');
    assert.equal(v.timeAxisIndex, true, 'flagged as the time-axis index');
    assert.ok(data.variables.time_index, 'stored in data.variables');
    assert.equal(h.derivedByFile.get('f1').get('time_index').timeAxisIndex, true, 'tracked in derivedByFile');
    assert.equal(h.treeRenders, 1, 'the tree is re-rendered once');
    assert.deepEqual(h.rebuilds, [['f1', 'time_index']], 'plots using it are rebuilt');

    // A 2-sample index would be [0,1]; confirm it is still typed real, not boolean.
    const two = h._buildTimeAxisIndexVariable('x', { data: Float64Array.from([0, 5]) });
    assert.deepEqual(Array.from(two.data), [0, 1]);
    assert.equal(two.dataType, 'real');
}

// ── Name collision with a real variable falls back to a suffix ────────────────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 2], { time_index: { name: 'time_index', kind: 'variable', data: Float64Array.from([9, 9, 9]) } });
    assert.equal(h._timeAxisIndexName('f1', h.plotManager.files.get('f1').data), 'time_index_2',
        'a pre-existing real variable named time_index is not overwritten');
}

// ── Re-drag reuses the existing index silently when it was not edited ─────────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 2, 3]);
    const created = h._createOrUpdateTimeAxisIndexVariable('f1');
    assert.equal(h._findTimeAxisIndexEntry('f1').name, created.name, 'the entry is discoverable');
    const dropped = await h._handleTimeAxisIndexDrop('time');
    assert.equal(dropped, 'time_index', 'a second drag returns the existing index (no dialog)');
    assert.equal(h.derivedByFile.get('f1').size, 1, 'no duplicate index is created');
}

// ── Reapply regenerates the index at the current length (reload / live-update) ─
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 2]);
    h._createOrUpdateTimeAxisIndexVariable('f1');
    const entry = h._findTimeAxisIndexEntry('f1');
    // Simulate live-update growing the time vector, then reapply.
    data.variables.time.data = Float64Array.from([0, 1, 2, 3, 4, 5]);
    assert.equal(h._reapplyDerivedVariable('f1', data, 'time_index', entry), true, 'reapply succeeds');
    assert.deepEqual(Array.from(data.variables.time_index.data), [0, 1, 2, 3, 4, 5], 'index grows with the time vector');
}

// ── Regenerate discards a Data Tools modification of the index ────────────────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 2, 3]);
    h._createOrUpdateTimeAxisIndexVariable('f1');
    // Pretend Data Tools modified it in place.
    data.variables.time_index.data = Float64Array.from([9, 9, 9, 9]);
    data.variables.time_index.dataToolModified = true;
    h.dataToolVariablesByFile.set('f1', new Map([['time_index', { targetMode: 'modify' }]]));

    const regen = h._createOrUpdateTimeAxisIndexVariable('f1', { regenerate: true });
    assert.deepEqual(Array.from(regen.data), [0, 1, 2, 3], 'regeneration restores a fresh index');
    assert.equal(data.variables.time_index.dataToolModified, undefined, 'the modified flag is cleared');
    assert.ok(!h.dataToolVariablesByFile.get('f1'), 'the Data Tools definition is removed');
}

// ── Dymola time axis "Time" produces a valid identifier name ──────────────────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 2]);
    h.plotManager.files.get('f1').data.variables.time.name = 'Time';
    assert.equal(h._timeAxisIndexName('f1', h.plotManager.files.get('f1').data), 'Time_index');
}

// ── Description comes from i18n and carries no unit bracket ───────────────────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1]);
    const v = h._createOrUpdateTimeAxisIndexVariable('f1');
    assert.equal(v.description, i18n.t('timeAxisIndexDescription'));
    assert.ok(!/\[.*\]/.test(v.description), 'no unit bracket to confuse unit extraction');
}

// ── Wiring assertions across modules (kept in source, not duplicated here) ────
const readSrc = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

const plotManagerSrc = readSrc('plots/plot-manager.js');
assert.match(plotManagerSrc, /onTimeAxisVariableDrop/, 'PlotManager exposes the time-axis drop hook');
assert.match(plotManagerSrc, /_handleVariableDrop/, 'PlotManager routes drops through _handleVariableDrop');
assert.match(plotManagerSrc, /kind === 'abscissa'[\s\S]{0,120}onTimeAxisVariableDrop/, 'an abscissa drop is delegated to the hook');

const interactionSrc = readSrc('plots/methods/interaction-methods.js');
assert.match(interactionSrc, /droppedVar\?\.derived && !droppedVar\._duckdbCol/, 'lazy path renders eager derived series without a DuckDB query');

const viewerSrc = readSrc('app/viewer-app.js');
assert.match(viewerSrc, /onTimeAxisVariableDrop\s*=\s*\(timeVarName\)\s*=>\s*this\._handleTimeAxisIndexDrop/, 'the viewer wires the hook to the handler');

const sessionSrc = readSrc('app/methods/session-methods.js');
assert.match(sessionSrc, /timeAxisIndex: true/, 'sessions serialize the time-axis-index marker');
assert.match(sessionSrc, /entry\.timeAxisIndex\s*\n?\s*\?\s*\[\]/, 'session reapply skips formula parsing for the index');

// ── diff() derived function + time exposed as a formula operand ───────────────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 1, 2, 4]); // duplicate at t=1, gap 2->4
    // diff(time) = Δt: forward at the first sample, 0 at the duplicate (no ÷Δt,
    // so no divide-by-zero), and a spike at the gap.
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(time)', data).values), [1, 1, 0, 1, 2],
        'diff(time) yields Δt with 0 at duplicates and a spike at gaps');
    // Second difference is zero for uniform sampling, non-zero only at anomalies.
    data.variables.time.data = Float64Array.from([0, 1, 2, 3, 4]);
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(diff(time))', data).values), [0, 0, 0, 0, 0],
        'diff(diff(time)) is zero for a uniform time axis');
    // Plain neighbour difference of a regular signal (no division anywhere).
    data.variables.y = { name: 'y', kind: 'variable', data: Float64Array.from([10, 20, 45, 45, 50]) };
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(y)', data).values), [10, 10, 25, 0, 5],
        'diff(y) is the plain backward difference (forward at the first sample)');

    // The time axis is now offered by the formula autocomplete (it was always
    // typeable, just hidden), tagged as a "time" operand.
    h.plotManager.data = data;
    const timeSuggestion = h._getDerivedSuggestions('tim').find(s => s.name === 'time');
    assert.ok(timeSuggestion, 'the time axis appears in formula autocomplete');
    assert.equal(timeSuggestion.kind, 'time', 'the time axis is tagged as a time operand');
    assert.ok(h._getDerivedSuggestions('dif').some(s => s.type === 'function' && s.name === 'diff'),
        'diff() is offered as a formula function');

    // The drag warning points users to a derived `y = time` for the raw values,
    // filling {time} with the actual time-axis name.
    assert.ok(i18n.t('timeAxisDragWarnBody').includes('{time}'), 'the warning body references a {time} placeholder');
    assert.match(readSrc('app/methods/derived-methods.js'), /replaceAll\('\{time\}', timeVarName\)/,
        'the handler fills {time} with the actual time-axis name');
}

// ── Legend "stairs vs linear" per-trace line shape (helps read the index) ─────
const dataMethodsSrc = readSrc('plots/methods/data-methods.js');
assert.match(dataMethodsSrc, /const isStep = t\.lineShape \? t\.lineShape === 'hv' : variable\.dataType === 'boolean'/,
    'a per-trace lineShape override drives the rendered step shape');

assert.match(plotManagerSrc, /_setTimeseriesTraceLineShape/, 'the legend menu can set a trace line shape');
assert.match(plotManagerSrc, /_traceIsStepped/, 'the menu reflects the current (effective) shape');
assert.match(plotManagerSrc, /legendMenuLineStairs[\s\S]{0,80}legendMenuLineLinear|stepped \? 'legendMenuLineLinear' : 'legendMenuLineStairs'/,
    'the menu offers stairs and linear labels');
assert.match(plotManagerSrc, /trace\.lineShape = shape === 'hv'[\s\S]{0,300}_rebuildPanel\(panelId, \{ preserveView: true \}\)/,
    'changing shape rebuilds the panel preserving the view (handles scattergl<->scatter)');
// The cursor A|B intersection dot must use step interpolation for stairs traces.
assert.match(interactionSrc, /trace\.lineShape\) return trace\.lineShape === 'hv' \? 'step' : 'linear'/,
    'the measurement cursor honors the per-trace stairs shape');

const modalSrc = readSrc('ui/modal.js');
// Unique to confirm(): its HTML body assigns `message` (alert assigns `body`),
// and only confirm creates a bare 'modal-dialog' immediately before the
// className hook (choice/alert append a variant class in the same string).
assert.match(modalSrc, /if \(options\.html\) messageDiv\.innerHTML = message/, 'Modal.confirm supports an HTML body');
assert.match(modalSrc, /modal\.className = 'modal-dialog';\s*\n\s*if \(options\.className\)/, 'Modal.confirm supports a custom className (wide dialog)');

console.log('Time-axis sample-index tests passed.');
