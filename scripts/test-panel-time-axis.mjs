import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

class Harness {
    constructor() { this.files = new Map(); this.language = 'en'; }
    _getTimeVar(fileId) {
        const d = this.files.get(fileId)?.data;
        if (!d) return null;
        return Object.values(d.variables).find(v => v.kind === 'abscissa') || null;
    }
    _extractUnit(description) {
        if (!description) return '';
        const m = description.match(/\[([^\]]+)\]/);
        if (!m) return '';
        const parts = m[1].split('|');
        return (parts[1] ?? parts[0]).trim();
    }
}
installPlotDataMethods(Harness);

function makeFile({ timeVar, transform = {} }) {
    return { data: { variables: { [timeVar.name]: { kind: 'abscissa', ...timeVar } } }, transform };
}

const h = new Harness();
h.files.set('cal-a',    makeFile({ timeVar: { name: 't', timeKind: 'datetime', timeDisplayMode: 'calendar' } }));
h.files.set('cal-b',    makeFile({ timeVar: { name: 't', timeKind: 'datetime', timeDisplayMode: 'calendar' } }));
h.files.set('elapsed-s',  makeFile({ timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedSeconds' } }));
h.files.set('elapsed-dt',  makeFile({ timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedDateTime' } }));
h.files.set('elapsed-dt2', makeFile({ timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedDateTime' } }));
h.files.set('num-s',  makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' } }));
h.files.set('num-s2', makeFile({ timeVar: { name: 'x', timeKind: 'numeric', description: 'sim [s]' } }));
h.files.set('num-m',  makeFile({ timeVar: { name: 'y', timeKind: 'numeric', description: 'ang [m]' } }));
h.files.set('idx',  makeFile({ timeVar: { name: 'i', timeKind: 'index', timeStepMode: 'index' } }));
h.files.set('idx2', makeFile({ timeVar: { name: 'j', timeKind: 'index', timeStepMode: 'index' } }));

const r = (...ids) => h._resolvePanelTimeAxis(ids);

// Calendar panel
assert.deepEqual(r('cal-a', 'cal-b'), { compatible: true, effectiveDisplay: 'calendar', effectiveUnit: null, alignmentPolicy: 'per-series-zero', referenceOriginMs: null });

// task b: duration + seconds mix ⇒ seconds (negative-safe default)
assert.equal(r('elapsed-s', 'elapsed-dt').effectiveDisplay, 'seconds');
assert.equal(r('elapsed-s', 'elapsed-dt').compatible, true);
assert.equal(r('elapsed-s', 'elapsed-dt').effectiveUnit, 's');

// all-duration ⇒ duration
assert.equal(r('elapsed-dt', 'elapsed-dt2').effectiveDisplay, 'duration');

// C1 non-regression: two generic-numeric [s] files overlay
assert.equal(r('num-s', 'num-s2').compatible, true);
assert.equal(r('num-s', 'num-s2').effectiveDisplay, 'seconds');
assert.equal(r('num-s', 'num-s2').effectiveUnit, 's');

// "float time = seconds": numeric axes are elapsed-seconds regardless of the unit
// label, so any two numeric axes overlay.
assert.equal(r('num-s', 'num-m').compatible, true);

// The key case: a datetime shown as Elapsed (seconds) now overlays a numeric
// (.mat-style) seconds axis — both are linear:elapsed-seconds.
assert.equal(r('elapsed-s', 'num-s').compatible, true);
assert.equal(r('elapsed-s', 'num-s').effectiveDisplay, 'seconds');

// index panel
assert.equal(r('idx', 'idx2').effectiveDisplay, 'index');
assert.equal(r('idx', 'idx2').effectiveUnit, 'count');

// single trace and empty
assert.equal(r('cal-a').effectiveDisplay, 'calendar');
assert.equal(r().effectiveDisplay, null);
assert.equal(r().compatible, true);

// ── Order independence (invariant 3) ─────────────────────────────────────────
const perms = [
    ['elapsed-s', 'elapsed-dt'],
    ['num-s', 'num-s2'],
    ['cal-a', 'cal-b'],
];
for (const [a, b] of perms) {
    assert.deepEqual(r(a, b), r(b, a), `order independence for ${a}/${b}`);
}

console.log('Panel time-axis resolution tests passed.');
