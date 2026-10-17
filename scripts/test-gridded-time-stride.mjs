// Play and ◀ ▶ on a gridded map: by a step of the file, or by a time.
//
// Play only ever moved one step at a time, at most 8 a second: a year of
// hourly ERA5 took eighteen minutes, and there was no moving by the day. A
// stride (6 h, a day, a week, a month, a year) now moves to the step that far
// ahead on the axis itself, and Play goes up to 30 steps a second.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { axisSpacingMs, strideIndex, strideOptions } from '../src/gridded/time-stride.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const datetimeAxis = (startIso, count, stepMs) => {
    const start = Date.parse(startIso);
    return { kind: 'datetime', size: count, values: Float64Array.from({ length: count }, (_, index) => start + index * stepMs) };
};
const ids = axis => strideOptions(axis).map(option => option.id);
const iso = (axis, index) => new Date(axis.values[index]).toISOString().slice(0, 16);

// ── A year of hourly fields (2024, a leap year) ────────────────────────────
{
    const axis = datetimeAxis('2024-01-01T00:00:00Z', 8784, HOUR);
    assert.equal(axisSpacingMs(axis), HOUR);
    assert.deepEqual(strideOptions(axis)[0], { id: 'step', label: { key: 'hours', n: 1 } }, 'one step of the file reads "1 h"');
    assert.deepEqual(ids(axis), ['step', '6h', '1d', '1w', '1mo'], 'a year is not offered on an axis shorter than one');
    assert.equal(strideIndex(axis, 5, 'step', 1), 6);
    assert.equal(strideIndex(axis, 5, '6h', 1), 11);
    assert.equal(strideIndex(axis, 5, '1d', 1), 29, 'a day on is 24 steps on');
    assert.equal(strideIndex(axis, 29, '1d', -1), 5, 'and back');
    assert.equal(strideIndex(axis, 0, '1w', 1), 168);
    // Months are calendar months: 31 January + 1 month is 29 February.
    const jan31 = 30 * 24 + 12;
    assert.equal(iso(axis, jan31), '2024-01-31T12:00');
    assert.equal(iso(axis, strideIndex(axis, jan31, '1mo', 1)), '2024-02-29T12:00', 'the last day of a shorter month');
    assert.equal(iso(axis, strideIndex(axis, strideIndex(axis, 0, '1mo', 1), '1mo', 1)), '2024-03-01T00:00', 'month after month from the 1st');
    assert.equal(iso(axis, strideIndex(axis, strideIndex(axis, 0, '1mo', 1), '1mo', -1)), '2024-01-01T00:00', 'and back');
    // Past either end: -1, for the caller to stop or loop.
    assert.equal(strideIndex(axis, 8783, 'step', 1), -1);
    assert.equal(strideIndex(axis, 8770, '1d', 1), -1);
    assert.equal(strideIndex(axis, 3, '1d', -1), -1);
    assert.equal(strideIndex(axis, 0, 'step', -1), -1);
    // A year of days, at 8 a second: 46 s where steps of an hour took 18 min.
    let index = 0;
    let moves = 0;
    while ((index = strideIndex(axis, index, '1d', 1)) >= 0) moves += 1;
    assert.equal(moves, 365);
}

// ── Several years: a year is offered, and lands on the same date ───────────
{
    const axis = datetimeAxis('2020-01-01T00:00:00Z', 3 * 8766, HOUR);
    assert.ok(ids(axis).includes('1y'));
    const feb29 = (31 + 28) * 24;
    assert.equal(iso(axis, feb29), '2020-02-29T00:00');
    assert.equal(iso(axis, strideIndex(axis, feb29, '1y', 1)), '2021-02-28T00:00', '29 February + 1 year is 28 February');
}

// ── Three-hourly: what is not longer than a step is not offered ────────────
{
    const axis = datetimeAxis('2024-01-01T00:00:00Z', 2000, 3 * HOUR);
    assert.deepEqual(strideOptions(axis)[0].label, { key: 'hours', n: 3 });
    assert.deepEqual(ids(axis), ['step', '6h', '1d', '1w', '1mo']);
    assert.equal(strideIndex(axis, 0, '1d', 1), 8);
}

// ── Gaps: the next step at or after the target ────────────────────────────
{
    const values = [0, 1, 2, 3, 30, 31, 32, 80].map(hour => Date.UTC(2024, 0, 1) + hour * HOUR);
    const axis = { kind: 'datetime', size: values.length, values: Float64Array.from(values) };
    assert.equal(strideIndex(axis, 0, '1d', 1), 4, 'over a gap, the first step after a day');
    assert.equal(strideIndex(axis, 5, '1d', 1), 7);
    assert.equal(strideIndex(axis, 7, '1d', -1), 6, 'back: the last step at or before a day earlier');
}

// ── Daily and monthly files ────────────────────────────────────────────────
{
    const daily = datetimeAxis('2000-01-01T00:00:00Z', 3000, DAY);
    assert.deepEqual(strideOptions(daily)[0].label, { key: 'day', n: 1 });
    assert.deepEqual(ids(daily), ['step', '1w', '1mo', '1y']);
    const monthly = { kind: 'datetime', size: 36, values: Float64Array.from({ length: 36 }, (_, month) => Date.UTC(2000, month, 1)) };
    assert.deepEqual(strideOptions(monthly)[0].label, { key: 'month', n: 1 });
    assert.deepEqual(ids(monthly), ['step', '1y']);
    assert.equal(strideIndex(monthly, 3, '1y', 1), 15);
}

// ── A model calendar: values in days since the origin ──────────────────────
{
    const axis = { kind: 'calendar', size: 365 * 4 * 2, values: Float64Array.from({ length: 365 * 4 * 2 }, (_, index) => index / 4) };
    assert.deepEqual(strideOptions(axis)[0].label, { key: 'hours', n: 6 });
    assert.deepEqual(ids(axis), ['step', '1d', '1w', '1mo', '1y']);
    assert.equal(strideIndex(axis, 0, '1d', 1), 4);
    assert.equal(strideIndex(axis, 0, '1y', 1), Math.ceil(365.2425 * 4 - 1e-6), 'a year there is its mean length');
}

// ── Not a time: numbers of steps ───────────────────────────────────────────
{
    const axis = { kind: 'index', size: 500, values: Float64Array.from({ length: 500 }, (_, index) => index) };
    assert.deepEqual(strideOptions(axis), [
        { id: 'step', label: { key: 'step', n: 1 } },
        { id: 'n10', label: { key: 'steps', n: 10 } },
        { id: 'n100', label: { key: 'steps', n: 100 } },
    ]);
    assert.equal(strideIndex(axis, 7, 'n10', 1), 17);
    assert.equal(strideIndex(axis, 7, 'n10', -1), -1);
    assert.equal(strideIndex(axis, 495, 'n10', 1), -1);
    // Times out of order: counted in steps, never searched.
    const unordered = { kind: 'datetime', size: 50, values: Float64Array.from({ length: 50 }, (_, index) => Date.UTC(2024, 0, 1) + ((index * 7) % 50) * HOUR) };
    assert.deepEqual(ids(unordered), ['step', 'n10']);
    assert.equal(strideIndex(unordered, 3, '1d', 1), 4, 'a time stride on such an axis is one step');
}

// ── The map uses it ─────────────────────────────────────────────────────────
const gridded = readFileSync(new URL('../src/app/methods/gridded-methods.js', import.meta.url), 'utf8');
assert.match(gridded, /const PLAY_SPEEDS = \[1, 2, 4, 8, 16, 30\];/, 'Play goes up to 30 steps a second');
assert.match(gridded, /<select data-role="stride" class="gridded-speed gridded-stride"><\/select>/, 'the stride is chosen next to the speed');
assert.match(gridded, /_griddedPlayLoop = async function\(view\) \{[\s\S]*?const next = this\._griddedStrideFrom\(view, view\.selection\[dim\] \|\| 0, 1\);\s*view\.selection\[dim\] = next < 0 \|\| next >= size \? 0 : next;/,
    'Play moves by the stride, and loops past the end');
assert.match(gridded, /_griddedStep = function\(step\) \{[\s\S]*?this\._griddedStrideFrom\(view, current, step === 'next' \? 1 : -1\)/,
    '◀ ▶ (and the arrow keys) move by the stride');
assert.match(gridded, /_griddedPrefetchNext = function\(view, request\) \{[\s\S]*?let next = this\._griddedStrideFrom\(view, current, view\.stepDirection \|\| 1\);/,
    'the step read ahead is the next stride, not the next step');

console.log('Gridded time stride tests passed: hours, days, calendar months and years, gaps, model calendars, step counts.');
