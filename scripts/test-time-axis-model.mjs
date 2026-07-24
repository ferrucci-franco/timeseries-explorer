import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

// Lightweight harness: install the data methods onto a plain class and stub the
// two cross-module helpers _timeAxisModel depends on (both are class methods on
// PlotManager in the app: plot-manager.js:3061 and :3282).
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
    return {
        data: { variables: { [timeVar.name]: { kind: 'abscissa', ...timeVar } } },
        transform,
    };
}

const h = new Harness();
h.files.set('datetime-cal', makeFile({ timeVar: { name: 't', timeKind: 'datetime', timeDisplayMode: 'calendar', description: '' } }));
h.files.set('datetime-elapsed', makeFile({ timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedSeconds' } }));
h.files.set('datetime-duration', makeFile({ timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedDateTime' } }));
h.files.set('numeric-seconds', makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' } }));
h.files.set('numeric-seconds-b', makeFile({ timeVar: { name: 'x', timeKind: 'numeric', description: 'sim time [s]' } }));
h.files.set('numeric-duration', makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' }, transform: { numericTimeDisplay: 'duration' } }));
h.files.set('numeric-calendar', makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]', data: [0, 10, 20] }, transform: { numericTimeDisplay: 'calendar', timeStepOriginDate: '2020-01-01 00:00' } }));
h.files.set('index', makeFile({ timeVar: { name: 'i', timeKind: 'index', timeDisplayMode: 'index', timeStepMode: 'index' } }));

// ── Canonical descriptor ────────────────────────────────────────────────────
const cases = [
    ['datetime-cal',      { semantic: 'absolute', storageEncoding: 'epoch-ms',   display: 'calendar', sig: 'date' }],
    ['datetime-elapsed',  { semantic: 'absolute', storageEncoding: 'epoch-ms',   display: 'seconds',  sig: 'linear:elapsed-seconds' }],
    ['datetime-duration', { semantic: 'absolute', storageEncoding: 'epoch-ms',   display: 'duration', sig: 'linear:elapsed-seconds' }],
    ['numeric-seconds',   { semantic: 'elapsed',  storageEncoding: 'raw-number', display: 'seconds',  sig: 'linear:elapsed-seconds' }],
    // A numeric (float-seconds) axis the user chose to SHOW as a duration: same
    // value/encoding/signature as numeric-seconds (overlay preserved), only the
    // display differs (hh:mm:ss ticks). This is the .mat "Duration" format.
    ['numeric-duration',  { semantic: 'elapsed',  storageEncoding: 'raw-number', display: 'duration', sig: 'linear:elapsed-seconds' }],
    // Numeric seconds PROMOTED to an absolute calendar via an origin date: kind
    // becomes datetime, so it renders as (and overlays) a real calendar axis.
    ['numeric-calendar',  { semantic: 'absolute', storageEncoding: 'epoch-ms',   display: 'calendar', sig: 'date' }],
    ['index',             { semantic: 'count',    storageEncoding: 'row-count',  display: 'index',    sig: 'linear:count' }],
];
for (const [id, want] of cases) {
    const m = h._timeAxisModel(id);
    assert.equal(m.semantic, want.semantic, `${id}: semantic`);
    assert.equal(m.storageEncoding, want.storageEncoding, `${id}: storageEncoding`);
    assert.equal(m.display, want.display, `${id}: display`);
    assert.equal(h._renderSignature(id), want.sig, `${id}: renderSignature`);
}

// ── C1 non-regression: two generic-numeric files must stay overlay-compatible ─
assert.equal(
    h._renderSignature('numeric-seconds'),
    h._renderSignature('numeric-seconds-b'),
    'two numeric-seconds files must share a render signature (overlay preserved)',
);

// ── duration + seconds share a signature (the intended task-b mixing) ─────────
assert.equal(
    h._renderSignature('datetime-elapsed'),
    h._renderSignature('datetime-duration'),
    'duration and seconds must share the elapsed-seconds signature',
);

// ── operation capabilities ──────────────────────────────────────────────────
assert.equal(h._operationCapabilities('datetime-cal').hasGregorianCalendar, true);
assert.equal(h._operationCapabilities('numeric-seconds').hasGregorianCalendar, false);
assert.equal(h._operationCapabilities('numeric-seconds').hasElapsed, true);
assert.equal(h._operationCapabilities('datetime-elapsed').hasElapsed, true);

// numeric→calendar promotion: gains a gregorian calendar, and the transformed
// times are value-preserving epoch-ms (origin + rawSeconds·1000), NOT reindexed.
assert.equal(h._operationCapabilities('numeric-calendar').hasGregorianCalendar, true);

// Analysis-mode gating routes through the canonical model (_canonicalFftKind is
// what _fftTimeKind delegates to). A numeric axis shown as duration stays
// 'numeric' (blocked from heatmap/temporal-profile); promoting it to a calendar
// makes it 'datetime' (eligible), matching the gregorian-calendar capability.
assert.equal(h._canonicalFftKind('numeric-seconds'), 'numeric');
assert.equal(h._canonicalFftKind('numeric-duration'), 'numeric');
assert.equal(h._canonicalFftKind('numeric-calendar'), 'datetime');
assert.equal(h._canonicalFftKind('datetime-cal'), 'datetime');
const originMs = Date.UTC(2020, 0, 1);
assert.deepEqual(
    Array.from(h._getTransformedTimeData('numeric-calendar')),
    [originMs, originMs + 10000, originMs + 20000],
    'numeric calendar time = origin + rawSeconds*1000',
);

// ── No behavior change: legacy readers still return their original values ─────
assert.equal(h._timeKind('datetime-cal'), 'datetime');
assert.equal(h._timeKind('numeric-seconds'), 'numeric');
assert.equal(h._timeDisplayMode('numeric-seconds'), 'numeric');
assert.equal(h._timeDisplayMode('datetime-elapsed'), 'elapsedSeconds');
assert.equal(h._timeDisplayMode('index'), 'index');

console.log('Time-axis model tests passed.');
