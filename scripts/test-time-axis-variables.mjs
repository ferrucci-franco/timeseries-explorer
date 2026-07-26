// Tests for the time-axis inspector and the derived signals it can build.
//
// The inspector answers "is this series equidistant, and if not, where does it
// break?" as numbers (exact even for lazy files), and can materialize two
// derived signals from the time vector:
//   index → the sample ordinal 0, 1, 2, … (vertical steps at repeated times)
//   delta → seconds since the previous sample (flat when equidistant)
// It never plots: index and Δt live on incomparable scales, and the three entry
// points (file panel, tree row, drag) must all do the same thing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index.js';
import { installDerivedMethods, TIME_AXIS_VARIABLE_KINDS } from '../src/app/methods/derived-methods.js';
import { installTimeAxisInspectorMethods } from '../src/app/methods/time-axis-inspector-methods.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';
import {
    computeTimeAxisDiagnostics,
    finalizeTimeAxisDiagnostics,
    rawFromTimeAxisSummary,
    mergeTimeAxisSteps,
    buildTimeAxisSummarySql,
    buildTimeAxisStepsSql,
} from '../src/data/time-axis-diagnostics.js';

// The span formatter delegates to PlotManager's duration helper (the same one
// the measurement cursor uses), so the stub carries the real implementation
// rather than a copy that could drift from it.
class PlotManagerStub {
    constructor() { this.files = new Map(); }
}
installPlotDataMethods(PlotManagerStub);

class Harness {
    constructor() {
        this.activeFileId = 'f1';
        this.files = new Map([['f1', { name: 'run.csv' }]]);
        this.derivedByFile = new Map();
        this.dataToolVariablesByFile = new Map();
        this.treeRenders = 0;
        this.rebuilds = [];
        this.plotManager = new PlotManagerStub();
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
        // Instance stubs shadow the prototype methods installed below.
        this._renderFilteredTree = () => { this.treeRenders++; };
        this._rebuildPlotsUsingVariable = (fileId, name) => { this.rebuilds.push([fileId, name]); };
    }

    // Stand in for the dialog (Modal needs a DOM): tick a fixed set of kinds and
    // record what the inspector was asked for.
    stubInspector(kinds) {
        this.inspected = [];
        this._openTimeAxisInspector = async (fileId) => {
            this.inspected.push(fileId);
            const data = this.plotManager.files.get(fileId)?.data;
            const created = [];
            for (const kind of kinds) {
                const name = await this._materializeTimeAxisVariable(fileId, data, kind);
                if (name) created.push(name);
            }
            return created;
        };
    }
}
installDerivedMethods(Harness);
installTimeAxisInspectorMethods(Harness);

function makeFile(h, fileId, times, extra = {}, timeProps = {}) {
    const variables = {
        time: { name: 'time', kind: 'abscissa', data: Float64Array.from(times), ...timeProps },
        ...extra,
    };
    const data = { variables, metadata: { timeName: 'time' } };
    h.plotManager.files.set(fileId, { data });
    if (!h.files.has(fileId)) h.files.set(fileId, { name: `${fileId}.csv` });
    return data;
}

// ── The two kinds and their sample values ─────────────────────────────────────
{
    assert.deepEqual(TIME_AXIS_VARIABLE_KINDS, ['index', 'delta'], 'two kinds, dialog order');

    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 1, 2, 4]); // duplicate at t=1, gap 2→4

    const index = h._createOrUpdateTimeAxisVariable('f1', 'index');
    assert.equal(index.name, 'time_index', 'name derives from the time variable');
    assert.deepEqual(Array.from(index.data), [0, 1, 2, 3, 4], 'the sample ordinal');

    const delta = h._createOrUpdateTimeAxisVariable('f1', 'delta');
    assert.equal(delta.name, 'time_delta');
    // Backward difference; the first sample repeats the second. A fabricated 0
    // is not an option: in a Δt signal 0 already means "repeated timestamp".
    assert.deepEqual(Array.from(delta.data), [1, 1, 0, 1, 2], 'seconds since the previous sample');

    for (const variable of [index, delta]) {
        assert.equal(variable.dataType, 'real', 'forced real (a 2-sample [0,1] index must not read as boolean)');
        assert.equal(variable.derived, true, 'flagged as derived');
        assert.equal(variable.timeAxisIndex, true, 'flagged as generated from the time axis');
        assert.ok(data.variables[variable.name], 'stored in data.variables');
        const entry = h.derivedByFile.get('f1').get(variable.name);
        assert.equal(entry.timeAxisIndex, true, 'tracked in derivedByFile');
        assert.equal(entry.timeAxisKind, variable.timeAxisKind, 'the entry records the kind');
    }
    assert.deepEqual([index, delta].map(v => v.timeAxisKind), ['index', 'delta']);
    assert.deepEqual(h.rebuilds, [['f1', 'time_index'], ['f1', 'time_delta']], 'plots using them are rebuilt');

    // A 2-sample index would be [0,1]; confirm it is still typed real.
    const two = h._buildTimeAxisVariable('x', { data: Float64Array.from([0, 5]) }, 'index');
    assert.deepEqual(Array.from(two.data), [0, 1]);
    assert.equal(two.dataType, 'real');
    // Δt of a single sample has no neighbour to subtract.
    const one = h._buildTimeAxisVariable('x', { data: Float64Array.from([7]) }, 'delta');
    assert.deepEqual(Array.from(one.data), [0]);
}

// ── Units: Δt is seconds, and the unit rides in the description bracket ───────
{
    const h = new Harness();
    // Units are read back out with _extractUnit(description), so the trailing
    // bracket IS the unit. The index is a plain count and carries none.
    const seconds = h._buildTimeAxisVariable('t_delta', { data: Float64Array.from([0, 2, 4]) }, 'delta');
    assert.ok(seconds.description.endsWith('[s]'), 'Δt declares seconds');
    assert.deepEqual(Array.from(seconds.data), [2, 2, 2]);

    // A datetime axis holds epoch milliseconds → converted to seconds.
    const datetime = h._buildTimeAxisVariable('t_delta', {
        data: Float64Array.from([1000, 3000, 5500]),
        timeKind: 'datetime',
    }, 'delta');
    assert.deepEqual(Array.from(datetime.data), [2, 2, 2.5], 'epoch ms become seconds');
    assert.ok(datetime.description.endsWith('[s]'));

    // A row-index axis is a step count: Δt over it is dimensionless.
    const rowIndex = h._buildTimeAxisVariable('t_delta', {
        data: Float64Array.from([0, 1, 2]),
        timeKind: 'index',
    }, 'delta');
    assert.ok(!rowIndex.description.includes('['), 'a row-index axis declares no unit');

    const index = h._buildTimeAxisVariable('t_index', { data: Float64Array.from([0, 2, 4]) }, 'index');
    assert.ok(!index.description.includes('['), 'the sample index carries no unit');
}

// ── Name collision with a real variable falls back to a suffix ────────────────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 2], {
        time_index: { name: 'time_index', kind: 'variable', data: Float64Array.from([9, 9, 9]) },
    });
    assert.equal(h._timeAxisVariableName('f1', data, 'index'), 'time_index_2',
        'a pre-existing real variable named time_index is not overwritten');
    assert.equal(h._timeAxisVariableName('f1', data, 'delta'), 'time_delta', 'free names are used as-is');
}

// ── The inspector creates the ticked kinds and reuses them on a second run ────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 2, 3]);
    h.stubInspector(['delta']);

    assert.deepEqual(await h._openTimeAxisInspector('f1'), ['time_delta'], 'one name per ticked option');
    assert.equal(h.derivedByFile.get('f1').size, 1, 'only the ticked kind is created');
    assert.deepEqual(await h._openTimeAxisInspector('f1'), ['time_delta'], 'a second run reuses it');
    assert.equal(h.derivedByFile.get('f1').size, 1, 'no duplicates are created');

    h.stubInspector([]);
    assert.deepEqual(await h._openTimeAxisInspector('f1'), [], 'ticking nothing creates nothing');
}

// ── Dragging the time axis opens the inspector and plots NOTHING ──────────────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 2, 3]);
    h.stubInspector(['index', 'delta']);

    const dropped = await h._handleTimeAxisDrop('time');
    assert.equal(dropped, null, 'the drop resolves to no trace — index and Δt are not comparable');
    assert.deepEqual(h.inspected, ['f1'], 'the drag is just a third way to open the inspector');
    assert.equal(h.derivedByFile.get('f1').size, 2, 'the ticked variables are still created');

    // Dragging something that is not the time axis is ignored entirely.
    h.inspected = [];
    assert.equal(await h._handleTimeAxisDrop('nope'), null);
    assert.deepEqual(h.inspected, [], 'no dialog for a non-abscissa drag');
}

// ── Reapply regenerates each kind at the current length (reload / live-update) ─
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 2]);
    for (const kind of TIME_AXIS_VARIABLE_KINDS) h._createOrUpdateTimeAxisVariable('f1', kind);
    data.variables.time.data = Float64Array.from([0, 1, 2, 3, 4, 5]);
    h._reapplyDerivedVariables('f1', data);
    assert.deepEqual(Array.from(data.variables.time_index.data), [0, 1, 2, 3, 4, 5], 'the index grows');
    assert.deepEqual(Array.from(data.variables.time_delta.data), [1, 1, 1, 1, 1, 1], 'Δt is recomputed');
}

// ── Sessions written before the kinds existed reapply as the sample index ─────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 2, 4]);
    const legacy = { name: 'time_index', timeAxisIndex: true, variable: null }; // no timeAxisKind
    h.derivedByFile.set('f1', new Map([['time_index', legacy]]));
    assert.equal(h._timeAxisEntryKind(legacy), 'index', 'a missing kind means the sample index');
    assert.equal(h._reapplyDerivedVariable('f1', data, 'time_index', legacy), true);
    assert.deepEqual(Array.from(data.variables.time_index.data), [0, 1, 2], 'rebuilt as an index, not as Δt');
    assert.equal(h._findTimeAxisEntry('f1', 'index'), legacy, 'and it is found as the index entry');
    assert.equal(h._findTimeAxisEntry('f1', 'delta'), null, 'without shadowing the other kind');
}

// ── Regenerate discards a Data Tools modification of the variable ─────────────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 2, 3]);
    h._createOrUpdateTimeAxisVariable('f1', 'delta');
    data.variables.time_delta.data = Float64Array.from([9, 9, 9, 9]);
    data.variables.time_delta.dataToolModified = true;
    h.dataToolVariablesByFile.set('f1', new Map([['time_delta', { targetMode: 'modify' }]]));

    const regen = h._createOrUpdateTimeAxisVariable('f1', 'delta', { regenerate: true });
    assert.deepEqual(Array.from(regen.data), [1, 1, 1, 1], 'regeneration restores fresh values');
    assert.equal(data.variables.time_delta.dataToolModified, undefined, 'the modified flag is cleared');
    assert.ok(!h.dataToolVariablesByFile.get('f1'), 'the Data Tools definition is removed');
}

// ── Dymola time axis "Time" produces valid identifier names ───────────────────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 2]);
    data.variables.time.name = 'Time';
    assert.deepEqual(TIME_AXIS_VARIABLE_KINDS.map(kind => h._timeAxisVariableName('f1', data, kind)),
        ['Time_index', 'Time_delta']);
}

// ─── Diagnostics core (pure, shared by the eager and lazy paths) ──────────────

// ── Verdicts over the shapes the inspector exists to tell apart ───────────────
{
    const uniform = computeTimeAxisDiagnostics([0, 1, 2, 3, 4]);
    assert.equal(uniform.nSamples, 5);
    assert.equal(uniform.intervals, 4);
    assert.equal(uniform.span, 4);
    assert.deepEqual([uniform.dtMin, uniform.dtMean, uniform.dtMax], [1, 1, 1]);
    assert.equal(uniform.verdict, 'equidistant', 'a uniform series reads as equidistant');
    assert.deepEqual([uniform.repeated, uniform.gaps, uniform.backwards], [0, 0, 0]);

    const gapped = computeTimeAxisDiagnostics([0, 1, 2, 10, 11]);
    assert.equal(gapped.verdict, 'irregular');
    assert.equal(gapped.gaps, 1, 'the missing stretch is counted as one gap');
    assert.equal(gapped.dtMax, 8);

    const backwards = computeTimeAxisDiagnostics([0, 1, 0.5, 2]);
    assert.equal(backwards.backwards, 1, 'time stepping back is detected in file order');
    assert.equal(backwards.verdict, 'irregular');

    // Float time vectors jitter in the last bits; that must not read as irregular.
    const floaty = computeTimeAxisDiagnostics(Array.from({ length: 1000 }, (_, i) => i * 0.1));
    assert.equal(floaty.verdict, 'equidistant', 'float noise stays within the tolerance');

    // Degenerate inputs must not throw or claim a verdict they cannot support.
    assert.equal(computeTimeAxisDiagnostics([7]).verdict, null, 'one sample has no interval');
    assert.equal(computeTimeAxisDiagnostics([5, 5, 5]).verdict, null, 'no interval advances time');
    assert.equal(computeTimeAxisDiagnostics([]).nSamples, 0);
    assert.equal(computeTimeAxisDiagnostics([0, NaN, 2, 4]).nSamples, 3, 'non-finite samples are skipped');
}

// ── A repeated timestamp must not make a uniform series look irregular ────────
{
    // The shape of every Modelica result: uniform sampling with a duplicated
    // timestamp at each event. Reporting "Δt min 0 s → irregular" for that would
    // be a false alarm on the most common file this app opens.
    const pendulum = [];
    for (let i = 0; i <= 20000; i++) pendulum.push(i * 0.001);
    pendulum.splice(5000, 0, pendulum[5000]); // the duplicated event timestamp

    const d = computeTimeAxisDiagnostics(pendulum);
    assert.equal(d.nSamples, 20002);
    assert.equal(d.intervals, 20001, 'every neighbour pair is an interval');
    assert.equal(d.steps, 20000, 'but only these advance time');
    assert.equal(d.repeated, 1, 'the duplicate is its own category');
    assert.ok(Math.abs(d.dtMin - 0.001) < 1e-12, 'the minimum is the real step, not zero');
    assert.equal(d.dtMean, 0.001, 'span over the advancing intervals — exactly 1 ms, not 0.99995 ms');
    assert.equal(d.gaps, 0);
    assert.equal(d.verdict, 'equidistantRepeats', 'equidistant, with repeats called out separately');

    const simple = computeTimeAxisDiagnostics([0, 1, 1, 2]);
    assert.equal(simple.repeated, 1);
    assert.equal(simple.dtMin, 1, 'zero-length intervals are excluded from the Δt range');
    assert.equal(simple.verdict, 'equidistantRepeats');
}

// ── Seconds conversion applies to every time-valued field ─────────────────────
{
    const ms = computeTimeAxisDiagnostics([0, 1000, 2000, 3000], { secondsPerUnit: 1e-3 });
    assert.deepEqual([ms.dtMin, ms.dtMean, ms.dtMax, ms.span], [1, 1, 1, 3], 'epoch ms become seconds');
    assert.equal(ms.unitless, false);

    const steps = computeTimeAxisDiagnostics([0, 1, 2], { unitless: true });
    assert.equal(steps.unitless, true, 'a row-index axis reports plain counts');
    assert.equal(steps.dtMean, 1);
}

// ── Lazy path: phase 1 stands alone, phase 2 completes the verdict ────────────
{
    // Phase 1 is a plain aggregate: count, bounds, and duplicates via
    // COUNT(*) − COUNT(DISTINCT), which needs no ordering at all.
    const raw = rawFromTimeAxisSummary({ n: 5, tMin: 0, tMax: 11, nDistinct: 5 });
    const partial = finalizeTimeAxisDiagnostics(raw);
    assert.equal(partial.nSamples, 5);
    assert.equal(partial.span, 11);
    assert.equal(partial.dtMean, 2.75, 'the mean needs no sort');
    assert.equal(partial.verdict, null, 'no verdict before the step pass');
    assert.equal(partial.gaps, null, 'and no gap count');
    assert.equal(partial.backwards, null, 'a sorted walk cannot see time going backwards');

    const complete = finalizeTimeAxisDiagnostics(mergeTimeAxisSteps(raw, { dtMin: 1, dtMax: 8, gaps: 1 }));
    assert.equal(complete.verdict, 'irregular');
    assert.equal(complete.gaps, 1);
    assert.equal(complete.backwards, null, 'still not checked — reported as such, not as zero');

    // Same pendulum shape through the lazy path: duplicates come from the
    // distinct count, and the mean divides by the advancing intervals only, so
    // eager and lazy agree on 1 ms exactly.
    const pendulumRaw = rawFromTimeAxisSummary({ n: 20002, tMin: 0, tMax: 20, nDistinct: 20001 });
    assert.equal(pendulumRaw.repeated, 1, 'duplicates come from the distinct count');
    const pendulum = finalizeTimeAxisDiagnostics(
        mergeTimeAxisSteps(pendulumRaw, { dtMin: 0.001, dtMax: 0.001, gaps: 0 }));
    assert.equal(pendulum.steps, 20000);
    assert.equal(pendulum.dtMean, 0.001);
    assert.equal(pendulum.verdict, 'equidistantRepeats');

    // Phase 1 must not sort or window; phase 2 owns the ordered walk.
    const summarySql = buildTimeAxisSummarySql('"t"::DOUBLE', 'tbl');
    assert.ok(!/ORDER BY|LAG\(/i.test(summarySql), 'phase 1 is a plain streaming aggregate');
    assert.match(summarySql, /COUNT\(DISTINCT t\)/, 'duplicates without ordering');
    const stepsSql = buildTimeAxisStepsSql('"t"::DOUBLE', 'tbl', 1.5, v => String(v));
    assert.match(stepsSql, /LAG\(t\) OVER \(ORDER BY t\)/, 'phase 2 walks consecutive steps');
    assert.match(stepsSql, /dt > 1\.5/, 'the gap threshold comes from phase 1');
    assert.match(stepsSql, /dt <> 0/, 'repeated timestamps stay out of the Δt range');
    for (const sql of [summarySql, stepsSql]) {
        assert.match(sql, /isnan\(t\)/, 'non-finite timestamps are excluded');
    }
}

// ── Formatting: one unit per row, chosen from the largest value ───────────────
{
    const h = new Harness();
    const fmt = (values, target = values[0]) =>
        h._formatTimeAxisValue(target, h._timeAxisUnit(values));

    // The bug this replaces: per-value thresholds printed the mean of a 1 ms
    // series as "1.000e-3 s" beside a max of "0.001 s" — two notations, one row,
    // and the exponential rounding hid that the mean was not exactly 1 ms.
    assert.equal(fmt([0.001]), '1 ms');
    assert.equal(fmt([0.00099995]), '999.95 µs', 'six significant digits keep the difference visible');
    const row = [0.0009, 0.001, 0.0011];
    assert.deepEqual(row.map(v => fmt(row, v)), ['0.9 ms', '1 ms', '1.1 ms'],
        'every value in a row shares the unit of the largest');
    assert.equal(fmt([20]), '20 s');
    assert.equal(fmt([900]), '15 min');
    assert.equal(fmt([7200]), '2 h');
    assert.equal(fmt([172800]), '2 d');
    assert.equal(fmt([2e-7]), '200 ns');
    assert.equal(fmt([0]), '0 s');
    assert.equal(h._formatTimeAxisValue(NaN, h._timeAxisUnit([NaN])), '—');
    assert.equal(h._formatTimeAxisValue(3, h._timeAxisUnit([3], true)), '3', 'a row-index axis has no unit');
    // No exponential notation survives anywhere in the ladder's range.
    for (const value of [1e-9, 1e-6, 1e-3, 1, 60, 3600, 86400, 1e6]) {
        assert.ok(!/e[+-]/i.test(fmt([value])), `${value} formats without an exponent`);
    }
}

// ── A span is a duration, not a magnitude ─────────────────────────────────────
{
    const h = new Harness();
    // 6816 samples every 15 min: "70.9896 d" is arithmetically right and unreadable.
    // Past a minute the span reuses the app's compound duration form — the same
    // one the measurement cursor shows for Δx.
    assert.equal(h._formatTimeAxisSpan(6815 * 900), '70 d 23 h 45 min');
    assert.equal(h._formatTimeAxisSpan(7200), '2 h');
    assert.equal(h._formatTimeAxisSpan(3725), '1 h 2 min 5 s');
    // Below a minute a single unit already reads naturally, so the ladder stays.
    assert.equal(h._formatTimeAxisSpan(20), '20 s');
    assert.equal(h._formatTimeAxisSpan(1e-4), '100 µs');
    assert.equal(h._formatTimeAxisSpan(6815 * 900, true), '6133500', 'a row-index axis counts steps');
    assert.equal(h._formatTimeAxisSpan(NaN), '—');
}

// ── The summary line lists only the anomalies that exist, pluralized ──────────
{
    const h = new Harness();
    const line = times => h._timeAxisSummaryLine(computeTimeAxisDiagnostics(times));

    assert.equal(line([0, 1, 2, 3]), '4 samples · Δt 1 s · equidistant');

    const pendulum = [];
    for (let i = 0; i <= 20000; i++) pendulum.push(i * 0.001);
    pendulum.splice(5000, 0, pendulum[5000]);
    assert.equal(line(pendulum), '20002 samples · Δt 1 ms · 1 repeated time',
        'singular, and "0 gaps" is not worth printing');

    assert.equal(line([0, 1, 1, 2, 2, 3]), '6 samples · Δt 1 s · 2 repeated times', 'plural');
    assert.equal(line([0, 1, 2, 10, 11]), '5 samples · Δt 1 s–8 s · 1 gap',
        'an irregular series shows the range instead of one step');
    assert.equal(line([]), i18n.t('timeAxisSummaryEmpty'));

    // Lazy phase 1 has no step data yet, so it reports what it does know.
    const partial = finalizeTimeAxisDiagnostics(rawFromTimeAxisSummary({ n: 5, tMin: 0, tMax: 11, nDistinct: 5 }));
    assert.equal(h._timeAxisSummaryLine(partial), '5 samples · span 11 s');
}

// ── The panel verdict line never triggers work on a lazy file ─────────────────
{
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 2, 3]);
    const eager = h._timeAxisDiagnosticsForPanel('f1');
    assert.equal(eager.verdict, 'equidistant', 'eager files compute inline');
    assert.match(h._timeAxisSummaryLine(eager), /4/, 'the line reports the sample count');

    // Second call comes from the cache (same transform signature).
    assert.equal(h._timeAxisDiagnosticsForPanel('f1'), eager, 'the result is cached');

    // A lazy file reports nothing until the inspector has actually run.
    const lazy = new Harness();
    const data = makeFile(lazy, 'f1', [0, 1, 2, 3]);
    data._duckdb = { source: {} };
    assert.equal(lazy._timeAxisDiagnosticsForPanel('f1'), null,
        'no query may start from a sidebar render — DuckDB serializes on one connection');
}

// ── Wiring assertions across modules (kept in source, not duplicated here) ────
const readSrc = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

const plotManagerSrc = readSrc('plots/plot-manager.js');
assert.match(plotManagerSrc, /onTimeAxisVariableDrop/, 'PlotManager exposes the time-axis drop hook');
assert.match(plotManagerSrc, /kind === 'abscissa'[\s\S]{0,120}onTimeAxisVariableDrop/, 'an abscissa drop is delegated to the hook');

const interactionSrc = readSrc('plots/methods/interaction-methods.js');
assert.match(interactionSrc, /droppedVar\?\.derived && !droppedVar\._duckdbCol/, 'lazy path renders eager derived series without a DuckDB query');

const viewerSrc = readSrc('app/viewer-app.js');
assert.match(viewerSrc, /onTimeAxisVariableDrop\s*=\s*\(timeVarName\)\s*=>\s*this\._handleTimeAxisDrop/, 'the viewer wires the hook to the handler');
assert.match(viewerSrc, /installTimeAxisInspectorMethods\(OpenModelicaViewer\)/, 'the inspector methods are installed');

const sessionSrc = readSrc('app/methods/session-methods.js');
assert.match(sessionSrc, /timeAxisIndex: true, timeAxisKind:/, 'sessions serialize the marker and the kind');
assert.match(sessionSrc, /timeAxisKind: item\.timeAxisKind \|\| 'index'/, 'sessions without a kind restore as the index');
assert.match(sessionSrc, /entry\.timeAxisIndex\s*\n?\s*\?\s*\[\]/, 'session reapply skips formula parsing for these');

// Entry point A: the file's "Time axis" panel, one call site for every axis kind.
const fileSrc = readSrc('app/methods/file-methods.js');
assert.match(fileSrc, /file-transform-wide-action[\s\S]{0,300}_openTimeAxisInspector\(fileId\)/,
    'the file panel opens the inspector');
assert.match(fileSrc, /_timeAxisSummaryLine\?\.\(this\._timeAxisDiagnosticsForPanel\?\.\(fileId\)\)/,
    'the panel shows the cached verdict line');

// Entry point B: the abscissa row in the tree.
const treeSrc = readSrc('app/methods/tree-methods.js');
assert.match(treeSrc, /kind === 'abscissa'[\s\S]{0,900}_openTimeAxisInspector\(this\.activeFileId\)/,
    'the time-axis tree row opens the same inspector');

// The lazy diagnostic must be cancellable and must not outlive its dialog.
const inspectorSrc = readSrc('app/methods/time-axis-inspector-methods.js');
assert.match(inspectorSrc, /new AbortController\(\)/, 'the lazy diagnostic is abortable');
assert.match(inspectorSrc, /finally \{[\s\S]{0,200}controller\?\.abort\(\)/,
    'closing the dialog aborts the scan holding the single DuckDB connection');
assert.match(inspectorSrc, /onPartial/, 'phase 1 is shown before phase 2 finishes');

const duckdbSrc = readSrc('data/duckdb-source.js');
assert.match(duckdbSrc, /getTimeAxisSummary[\s\S]{0,600}_interactiveQuery\(sql, \{ signal: options\?\.signal \}\)/,
    'phase 1 passes the abort signal through');
assert.match(duckdbSrc, /getTimeAxisSteps[\s\S]{0,800}_interactiveQuery\(sql, \{ signal: options\?\.signal \}\)/,
    'phase 2 passes the abort signal through');

// ── diff() derived function + time exposed as a formula operand ───────────────
{
    const h = new Harness();
    const data = makeFile(h, 'f1', [0, 1, 1, 2, 4]); // duplicate at t=1, gap 2->4
    // diff(time) = Δt: forward at the first sample, 0 at the duplicate (no ÷Δt,
    // so no divide-by-zero), and a spike at the gap — the same convention as the
    // delta time-axis variable, deliberately, so the app has ONE Δt.
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(time)', data).values), [1, 1, 0, 1, 2],
        'diff(time) yields Δt with 0 at duplicates and a spike at gaps');
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(time)', data).values),
        Array.from(h._buildTimeAxisVariable('t', data.variables.time, 'delta').data),
        'the delta variable matches diff(time)');
    // Second difference is zero for uniform sampling, non-zero only at anomalies.
    data.variables.time.data = Float64Array.from([0, 1, 2, 3, 4]);
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(diff(time))', data).values), [0, 0, 0, 0, 0],
        'diff(diff(time)) is zero for a uniform time axis');
    // Plain neighbour difference of a regular signal (no division anywhere).
    data.variables.y = { name: 'y', kind: 'variable', data: Float64Array.from([10, 20, 45, 45, 50]) };
    assert.deepEqual(Array.from(h._evaluateDerivedFormula('diff(y)', data).values), [10, 10, 25, 0, 5],
        'diff(y) is the plain backward difference (forward at the first sample)');

    // The time axis is offered by the formula autocomplete — that is how you get
    // the time values themselves, which is why there is no derived copy of them.
    h.plotManager.data = data;
    const timeSuggestion = h._getDerivedSuggestions('tim').find(s => s.name === 'time');
    assert.ok(timeSuggestion, 'the time axis appears in formula autocomplete');
    assert.equal(timeSuggestion.kind, 'time', 'the time axis is tagged as a time operand');
    assert.ok(h._getDerivedSuggestions('dif').some(s => s.type === 'function' && s.name === 'diff'),
        'diff() is offered as a formula function');
    assert.ok(i18n.t('timeAxisInspectHint').includes('{time}'), 'the dialog points at that formula');
}

// ── The sample index is drawn as stairs by default ────────────────────────────
{
    // Between two samples there is no fractional sample, so a ramp would invent
    // one; as stairs, a repeated timestamp reads as the vertical jump it is.
    const pm = new PlotManagerStub();
    const h = new Harness();
    makeFile(h, 'f1', [0, 1, 1, 2]);
    const index = h._createOrUpdateTimeAxisVariable('f1', 'index');
    const delta = h._createOrUpdateTimeAxisVariable('f1', 'delta');

    assert.equal(pm._variableDefaultsToStairs(index), true, 'the sample index defaults to stairs');
    assert.equal(pm._variableDefaultsToStairs(delta), false, 'Δt stays a straight line');
    assert.equal(pm._variableDefaultsToStairs({ dataType: 'boolean' }), true, 'booleans keep stepping');
    assert.equal(pm._variableDefaultsToStairs({ dataType: 'real' }), false, 'ordinary signals do not');
    assert.equal(pm._variableDefaultsToStairs(null), false);
    // Sessions written before the kinds existed carry no timeAxisKind.
    assert.equal(pm._variableDefaultsToStairs({ timeAxisIndex: true }), true, 'a legacy index still steps');

    // The rendering and the legend menu must read the same predicate, or the
    // menu would offer "Stairs" for a trace that is already stepped.
    const dataSrc = readSrc('plots/methods/data-methods.js');
    assert.match(dataSrc, /const isStep = t\.lineShape \? t\.lineShape === 'hv' : this\._variableDefaultsToStairs\(variable\)/,
        'the drawing asks the shared predicate');
    assert.match(plotManagerSrc, /_traceIsStepped\(trace\) \{[\s\S]{0,220}_variableDefaultsToStairs\(variable\)/,
        'the legend menu asks the same one');
}

// ── Legend "stairs vs linear" per-trace line shape (helps read the index) ─────
const dataMethodsSrc = readSrc('plots/methods/data-methods.js');

assert.match(plotManagerSrc, /_setTimeseriesTraceLineShape/, 'the legend menu can set a trace line shape');
assert.match(plotManagerSrc, /_traceIsStepped/, 'the menu reflects the current (effective) shape');
assert.match(plotManagerSrc, /legendMenuLineStairs[\s\S]{0,80}legendMenuLineLinear|stepped \? 'legendMenuLineLinear' : 'legendMenuLineStairs'/,
    'the menu offers stairs and linear labels');
assert.match(plotManagerSrc, /trace\.lineShape = shape === 'hv'[\s\S]{0,300}_rebuildPanel\(panelId, \{ preserveView: true \}\)/,
    'changing shape rebuilds the panel preserving the view (handles scattergl<->scatter)');
assert.match(interactionSrc, /trace\.lineShape\) return trace\.lineShape === 'hv' \? 'step' : 'linear'/,
    'the measurement cursor honors the per-trace stairs shape');

const modalSrc = readSrc('ui/modal.js');
assert.match(modalSrc, /checklist\(message, options = \{\}\)/, 'Modal exposes a checkbox-list dialog');
assert.match(modalSrc, /boxes\.filter\(box => box\.checked\)\.map\(box => box\.value\)/, 'it resolves to the ticked values');
assert.match(modalSrc, /confirmBtn\.disabled = !boxes\.some\(box => box\.checked\)/, 'confirm is disabled while nothing is ticked');
assert.match(modalSrc, /if \(options\.bodyElement\) content\.appendChild\(options\.bodyElement\)/,
    'a caller-owned body element can be filled in asynchronously');
assert.match(modalSrc, /modal-checklist-section/, 'the list is wrapped so it can sit beside the body');
assert.match(modalSrc, /options\.listTitle/, 'the checkbox group can carry a section heading');
assert.match(modalSrc, /modal\.className = 'modal-dialog';\s*\n\s*if \(options\.className\)/, 'Modal.confirm supports a custom className (wide dialog)');

const overlaysCss = readFileSync(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
assert.match(overlaysCss, /\.modal-checklist-item\s*\{/, 'the checkbox rows are styled');
assert.match(overlaysCss, /\.time-axis-diag-grid\s*\{/, 'the diagnostic block is styled');
assert.match(overlaysCss, /@media \(min-width: 860px\)[\s\S]{0,400}grid-template-columns/,
    'the inspector uses the extra width for a second column, not longer lines');
const sidebarCss = readFileSync(new URL('../src/styles/sidebar.css', import.meta.url), 'utf8');
assert.match(sidebarCss, /\.tree-time-axis-inspect\s*\{/, 'the tree shortcut is styled');

console.log('Time-axis inspector tests passed.');
