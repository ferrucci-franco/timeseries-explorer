// Reading a period as a duration (#108).
//
// The period axis is in seconds, which is the honest unit and the wrong label:
// a daily oscillation is 86400, a weekly one 604800, and a reader looking for
// either has to divide. These are the labels that spare them that — and the
// tick positions a calendar would put them at, which are not the ones a decade
// would.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    PERIOD_UNIT_DEFAULT,
    PERIOD_UNIT_MODES,
    formatPeriodDuration,
    normalizePeriodUnitMode,
    periodTickText,
    periodTickValues,
} from '../src/utils/period-units.js';

// ── The two readings ────────────────────────────────────────────────────────
assert.deepEqual(PERIOD_UNIT_MODES, ['seconds', 'calendar']);
assert.equal(PERIOD_UNIT_DEFAULT, 'seconds', 'a panel that says nothing is in seconds, as it always was');
assert.equal(normalizePeriodUnitMode('calendar'), 'calendar');
assert.equal(normalizePeriodUnitMode('weeks'), 'seconds', 'an unknown reading falls back');
assert.equal(normalizePeriodUnitMode(undefined), 'seconds', 'and so does a session saved before this existed');

// ── One duration, one unit ──────────────────────────────────────────────────
assert.equal(formatPeriodDuration(86400), '1 d', 'the whole point');
assert.equal(formatPeriodDuration(604800), '7 d');
assert.equal(formatPeriodDuration(3600), '1 h');
assert.equal(formatPeriodDuration(21600), '6 h');
assert.equal(formatPeriodDuration(90), '1.5 min');
assert.equal(formatPeriodDuration(2), '2 s');
assert.equal(formatPeriodDuration(0.5), '500 ms', 'below a second there is still a unit that fits');
assert.equal(formatPeriodDuration(1e-7), '100 ns');
assert.equal(formatPeriodDuration(108000), '1.25 d',
    'a tick is read at a glance: one unit and three digits, not "1 d 6 h"');
assert.equal(formatPeriodDuration(86400, { unitSymbol: 'h' }), '24 h', 'unless the caller wants one unit throughout');
assert.equal(formatPeriodDuration(0), '', 'a period of nothing is not a duration');
assert.equal(formatPeriodDuration(-5), '');
assert.equal(formatPeriodDuration(NaN), '');

// ── Where a reader expects a tick ───────────────────────────────────────────
{
    const values = periodTickValues(1, 1e6);
    assert.ok(values.includes(86400), 'a day is a tick');
    assert.ok(values.includes(3600), 'and an hour');
    assert.ok(values.every(value => value >= 1 && value <= 1e6), 'nothing outside the window');
    assert.ok(values.length <= 10, 'and not so many that they collide');
    const labels = periodTickText(values);
    assert.equal(labels.length, values.length);
    assert.ok(labels.includes('1 d'));
}
{
    // Sub-second: no calendar left, so decades of 1, 2 and 5.
    const values = periodTickValues(0.002, 0.5);
    assert.ok(values.includes(0.01) && values.includes(0.1));
    assert.deepEqual(periodTickText([0.002, 0.01, 0.1]), ['2 ms', '10 ms', '100 ms']);
}
{
    // A window between two anchors would leave the axis bare, so it is swept.
    const values = periodTickValues(70000, 90000);
    assert.ok(values.length >= 3, 'a zoom inside one decade still gets ticks');
    assert.ok(values.every(value => value >= 70000 && value <= 90000 * 1.001));
    const labels = periodTickText(values);
    assert.ok(labels.every(label => label.endsWith(' h')),
        'and they are all in the same unit: 19 to 25 hours, not "23 h" beside "1 d"');
}
assert.deepEqual(periodTickValues(5, 5), [], 'a window of no width has no ticks');
assert.deepEqual(periodTickValues(NaN, 10), []);
assert.deepEqual(periodTickText([]), []);
assert.deepEqual(periodTickText(null), []);
// The unit comes from the middle of the window, not from either end.
assert.deepEqual(periodTickText([0.5, 1, 2]), ['0.5 s', '1 s', '2 s'],
    'the smallest would have said 500 ms, 1000 ms, 2000 ms');

// ── Wired into the panel ────────────────────────────────────────────────────
const fft = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');
assert.match(fft, /periodUnit: normalizePeriodUnitMode\(raw\.periodUnit\)/, 'the reading is part of the panel state');
assert.match(fft, /proto\._fftPeriodShowsDurations = function\(plot\) \{/, 'and one place decides whether it applies');
assert.match(fft, /return this\._fftCursorPeriodUnit\(plot\) === 's';/,
    'a file counted in samples has no hours in it');
assert.match(fft, /const tickvals = periodTickValues\(range\[0\], range\[1\]\);/, 'the ticks are chosen for the window on screen');
assert.match(fft, /if \(signature !== plot\._fftPeriodTickSignature\) \{/, 'a zoom picks new ones, once');
assert.match(fft, /if \(this\._fftPeriodShowsDurations\(plot\)\) return i18n\.t\('fftPeriod'\);/,
    'and the title drops the unit, because every tick carries its own');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['fftPeriodUnit', 'fftPeriodUnitSeconds', 'fftPeriodUnitCalendar', 'fftPeriodUnitTooltip']) {
    assert.equal([...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

console.log('Period-unit checks passed.');
