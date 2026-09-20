// The time-axis verdict after a reload (#67).
//
// The diagnostics are cached per file under a key built from the time vector.
// That key named the vector's file, name, kind and length — all four of which a
// re-run of the same simulation reproduces exactly — so reloading a file whose
// sampling had changed served the verdict of the data that had just been
// replaced: "300 samples · Δt 100 ms · equidistant" over a file that now had
// two gaps in it.
//
// The derived signals built from the axis (time_index, time_delta) were never
// part of this: _reapplyDerivedVariable rebuilds them from the new time vector
// on every reload. That is asserted here too, so the two halves of the report
// stay separable if one of them ever breaks again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import i18n from '../src/i18n/index.js';
import { installDerivedMethods } from '../src/app/methods/derived-methods.js';
import { installTimeAxisInspectorMethods } from '../src/app/methods/time-axis-inspector-methods.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

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
        this.plotManager = new PlotManagerStub();
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
        this._renderFilteredTree = () => {};
        this._rebuildPlotsUsingVariable = () => {};
    }
}
installDerivedMethods(Harness);
installTimeAxisInspectorMethods(Harness);

// i18n defaults to English without a DOM; setLanguage() would look for one.

// 300 rows either way. `irregular` punches two holes in an otherwise clean
// 0.1 s step — the shape of a simulation re-run with a different solver.
const makeData = (irregular) => {
    const time = new Float64Array(300);
    let t = 0;
    for (let i = 0; i < 300; i++) {
        t += (irregular && (i === 100 || i === 200)) ? 0.7 : 0.1;
        time[i] = t;
    }
    return {
        variables: {
            time: { name: 'time', data: time, kind: 'abscissa', timeKind: 'numeric', description: 'Time [s]' },
            a: { name: 'a', data: new Float64Array(300), kind: 'variable' },
        },
    };
};

const app = new Harness();
const setData = (data) => { app.plotManager.files.set('f1', { data }); };

// ── The verdict follows the file ─────────────────────────────────────────────
const first = makeData(false);
setData(first);
const clean = app._timeAxisDiagnosticsForPanel('f1');
assert.equal(clean.verdict, 'equidistant', 'setup: the first load is equidistant');
assert.equal(app._timeAxisSummaryLine(clean), '300 samples · Δt 100 ms · equidistant');

// Nothing changed: the cache must still answer, and answer the same object.
assert.equal(app._timeAxisDiagnosticsForPanel('f1'), clean, 'an unchanged file is not measured twice');

// The reload: same file id, same variable name, same kind, same 300 rows.
const second = makeData(true);
assert.equal(second.variables.time.data.length, first.variables.time.data.length,
    'setup: the row count is what made the old key collide');
setData(second);

const afterReload = app._timeAxisDiagnosticsForPanel('f1');
assert.equal(afterReload.verdict, 'irregular', 'the reloaded file is measured, not the replaced one');
assert.equal(afterReload.gaps, 2, 'and its gaps are counted');
assert.match(app._timeAxisSummaryLine(afterReload), /2 gaps/, 'the panel line says so');

// ── And it is the array, not the file id, that carries the identity ──────────
// Re-pointing at the FIRST data object again must bring the first verdict back,
// which a monotonic "the file changed" counter would not do.
setData(first);
assert.equal(app._timeAxisDiagnosticsForPanel('f1').verdict, 'equidistant',
    'the original vector still measures as it did');

// A copy of the same numbers is a different vector, and may be measured again —
// what must never happen is the previous vector's verdict being reused for it.
const copy = makeData(true);
setData(copy);
assert.equal(app._timeAxisDiagnosticsForPanel('f1').verdict, 'irregular',
    'a different array with the same shape gets its own verdict');

// ── The key itself ───────────────────────────────────────────────────────────
setData(first);
const keyFirst = app._timeAxisDiagnosticsKey('f1');
setData(second);
const keySecond = app._timeAxisDiagnosticsKey('f1');
assert.notEqual(keyFirst, keySecond, 'two different time vectors cannot share a key');
setData(first);
assert.equal(app._timeAxisDiagnosticsKey('f1'), keyFirst, 'and the same vector keeps its own');
assert.equal(app._timeAxisDiagnosticsKey('missing'), null, 'a file that is not loaded has no key');

// The id is handed out per array, so a file with no time vector at all still
// produces a key rather than throwing.
setData({ variables: { a: { name: 'a', data: new Float64Array(3), kind: 'variable' } } });
assert.equal(typeof app._timeAxisDiagnosticsKey('f1'), 'string', 'a file with no abscissa still keys');
assert.equal(app._timeAxisDiagnosticsForPanel('f1'), null, 'and has nothing to report');

// ── The derived signals were already correct; keep it that way ───────────────
const app2 = new Harness();
const before = makeData(false);
app2.plotManager.files.set('f1', { data: before });
await app2._materializeTimeAxisVariable('f1', before, 'index');
await app2._materializeTimeAxisVariable('f1', before, 'delta');
const deltaMax = values => Math.max(...Array.from(values));
assert.ok(Math.abs(deltaMax(before.variables.time_delta.data) - 0.1) < 1e-9,
    'setup: Δt over the clean file is the clean step');
assert.equal(before.variables.time_index.data.length, 300, 'setup: the index covers every row');

const reloaded = makeData(true);
app2._reapplyDerivedVariables('f1', reloaded);
assert.ok(Math.abs(deltaMax(reloaded.variables.time_delta.data) - 0.7) < 1e-9,
    'Δt is rebuilt from the reloaded time vector');
assert.equal(reloaded.variables.time_index.data.length, 300, 'and so is the sample index');

// ── The wiring the reload depends on ─────────────────────────────────────────
const files = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
assert.match(files, /reloadActiveFile = async function[\s\S]*?_reapplyDerivedVariables\(id, data\)/,
    'a reload rebuilds the derived variables');
assert.match(files, /reloadActiveFile = async function[\s\S]*?_renderFilesList\(\)/,
    'and re-renders the panel that prints the verdict');

const inspector = readFileSync(new URL('../src/app/methods/time-axis-inspector-methods.js', import.meta.url), 'utf8');
assert.match(inspector, /new WeakMap\(\)/,
    'the vector ids are held weakly — the key must not keep a replaced file alive');
assert.match(inspector, /_timeAxisDiagnosticsKey = function\(fileId\)[\s\S]*?timeVectorId\(timeVar\?\.data\)/,
    'the key carries the vector identity');

console.log('Time-axis reload-cache checks passed.');
