import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

// Proves that _fftTimeKind's delegation to the canonical model (_canonicalFftKind)
// is behavior-identical to its former inline implementation, across a fixture matrix
// that exercises every branch (pure index, generated duration, generated calendar,
// high-resolution generated calendar, datetime calendar/elapsed/index, and numeric).

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

// The ORIGINAL fft-methods.js:1059 logic, kept here as the reference oracle.
function originalFftKind(h, fileId) {
    const timeVar = h._getTimeVar(fileId);
    if (h._isGeneratedIndexTime(fileId, timeVar) && h._indexTimeStepMode(fileId) === 'index') return 'index';
    if (h._timeDisplayModeForVar(fileId, timeVar) === 'calendar'
        && !h._isHighResolutionGeneratedCalendarTime(fileId, timeVar)) return 'datetime';
    return 'numeric';
}

// Reference copies of the PRE-INVERSION _timeKind / _timeDisplayMode /
// _timeUnitLabel logic, computed straight from the primitives, so they stay
// independent of the now-wrapper implementations under test.
function refTimeKind(h, id) {
    if (h._isGeneratedCalendarTime(id)) return 'datetime';
    return h._getTimeVar(id)?.timeKind === 'datetime' ? 'datetime' : 'numeric';
}
function refDisplayMode(h, id) {
    const transform = h._fileTransform(id);
    const timeVar = h._getTimeVar(id);
    if (h._isGeneratedIndexTime(id, timeVar)) return h._isGeneratedCalendarTime(id, timeVar) ? 'calendar' : 'index';
    if (timeVar?.timeKind !== 'datetime') return 'numeric';
    return transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar';
}
function refUnit(h, id) {
    if (h._isGeneratedCalendarTime(id)) return 'datetime';
    if (h._isGeneratedIndexTime(id)) return h._indexTimeStepMode(id) === 'index' ? 'index' : 'duration';
    const dm = refDisplayMode(h, id);
    if (dm === 'calendar') return 'datetime';
    if (dm === 'elapsedDateTime') return 'duration';
    if (dm === 'elapsedSeconds') return 's';
    const timeVar = h._getTimeVar(id);
    return timeVar ? h._extractUnit(timeVar.description) : 's';
}

function makeFile({ timeVar, transform = {} }) {
    return { data: { variables: { [timeVar.name]: { kind: 'abscissa', ...timeVar } } }, transform };
}

const ORIGIN = '2020-01-01T00:00:00';
const h = new Harness();
const fixtures = {
    'dt-cal':            { timeVar: { name: 't', timeKind: 'datetime', timeDisplayMode: 'calendar' } },
    'dt-elapsed-s':      { timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedSeconds' } },
    'dt-elapsed-dt':     { timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'elapsedDateTime' } },
    'dt-index':          { timeVar: { name: 't', timeKind: 'datetime' }, transform: { timeDisplayMode: 'index' } },
    'numeric':           { timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' } },
    'idx-pure':          { timeVar: { name: 'i', timeKind: 'index', timeStepMode: 'index' } },
    'gen-duration':      { timeVar: { name: 'i', timeKind: 'index' }, transform: { timeStepMode: 'seconds' } },
    'gen-calendar':      { timeVar: { name: 'i', timeKind: 'index' }, transform: { timeStepMode: 'seconds', timeStepOriginMode: 'calendar', timeStepOriginDate: ORIGIN } },
    'gen-calendar-hires': { timeVar: { name: 'i', timeKind: 'index' }, transform: { timeStepMode: 'custom', customTimeStep: '1us', timeStepOriginMode: 'calendar', timeStepOriginDate: ORIGIN } },
};
for (const [id, cfg] of Object.entries(fixtures)) h.files.set(id, makeFile(cfg));

// 1) Equivalence: canonical == original for every fixture (the core guarantee).
for (const id of Object.keys(fixtures)) {
    assert.equal(
        h._canonicalFftKind(id),
        originalFftKind(h, id),
        `${id}: _canonicalFftKind must match the original _fftTimeKind logic`,
    );
}

// 1b) Core inversion equivalence: the now-wrapper readers reproduce the original
//     primitive logic exactly (the proof that deriving them from _timeAxisModel
//     changed nothing).
for (const id of Object.keys(fixtures)) {
    assert.equal(h._timeKind(id), refTimeKind(h, id), `${id}: _timeKind (inverted)`);
    assert.equal(h._timeDisplayMode(id), refDisplayMode(h, id), `${id}: _timeDisplayMode (inverted)`);
    assert.equal(h._timeUnitLabel(id), refUnit(h, id), `${id}: _timeUnitLabel (inverted)`);
}

// 2) Anchor a few expected values so a shared regression in both can't hide.
const expected = {
    'dt-cal': 'datetime',
    'dt-elapsed-s': 'numeric',
    'dt-index': 'index',
    'numeric': 'numeric',
    'idx-pure': 'index',
    'gen-duration': 'numeric',
    'gen-calendar': 'datetime',
};
for (const [id, want] of Object.entries(expected)) {
    assert.equal(h._canonicalFftKind(id), want, `${id}: expected fft-kind ${want}`);
}

// 3) Pin the primitive readers too, as a safety net for the deeper future inversion
//    of _timeKind / _timeDisplayMode.
assert.equal(h._timeKind('dt-cal'), 'datetime');
assert.equal(h._timeKind('numeric'), 'numeric');
assert.equal(h._timeKind('gen-calendar'), 'datetime');
assert.equal(h._timeDisplayMode('dt-elapsed-s'), 'elapsedSeconds');
assert.equal(h._timeDisplayMode('idx-pure'), 'index');
assert.equal(h._timeDisplayMode('gen-calendar'), 'calendar');

console.log('Time-axis reader migration tests passed.');
