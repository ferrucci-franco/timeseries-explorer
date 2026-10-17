// Play and ◀ ▶ on a gridded map: by a step of the file, or by a time.
//
// Play only ever moved one step at a time, at most 8 a second: a year of
// hourly ERA5 took eighteen minutes, and there was no moving by the day. A
// stride (6 h, a day, a week, a month, a year) now moves to the step that far
// ahead on the axis itself, and Play goes up to 30 steps a second.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { axisSpacingMs, batchIndices, strideIndex, strideOptions } from '../src/gridded/time-stride.js';

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
const play = gridded.slice(gridded.indexOf('proto._griddedPlayLoop'), gridded.indexOf('// Maps already read'));
assert.match(play, /const next = this\._griddedStrideFrom\(view, index, 1\);\s*index = next < 0 \|\| next >= size \? 0 : next;/,
    'Play moves by the stride, and loops past the end');
assert.match(gridded, /_griddedStep = function\(step\) \{[\s\S]*?this\._griddedStrideFrom\(view, current, step === 'next' \? 1 : -1\)/,
    '◀ ▶ (and the arrow keys) move by the stride');
assert.match(gridded, /_griddedPrefetchNext = function\(view, request\) \{[\s\S]*?const direction = view\.stepDirection \|\| 1;[\s\S]*?next = this\._griddedStrideFrom\(view, next, direction\);/,
    'the step read ahead is the next stride, not the next step');

// ── Play keeps to the clock ─────────────────────────────────────────────────
// Drawing slower than the speed asked skips strides (a few at most), so the
// speed is the speed of time; a step that had to be read restarts the clock.
assert.match(play, /const due = Math\.floor\(\(performance\.now\(\) - clock\) \/ interval\) \+ 1;\s*const strides = Math\.min\(PLAY_MAX_SKIP, Math\.max\(1, due - shown\)\);/,
    'behind the clock, several strides at once');
assert.match(play, /if \(now - started > PLAY_STALL_INTERVALS \* interval \|\| clock \+ shown \* interval < now - PLAY_MAX_SKIP \* interval\) \{\s*clock = now;\s*shown = 0;/,
    'a read that stalled, or a lag past catching up, restarts the clock');
assert.match(play, /const run = \(view\.playRun \|\| 0\) \+ 1;\s*view\.playRun = run;[\s\S]*?while \(view\.playing && view\.playRun === run/,
    'Pause and Play again quickly: one loop plays, not two at twice the speed');
assert.match(play, /if \(view\.playRun !== run\) return;\s*view\.playing = false;/, 'and the old one does not stop the new one');
assert.match(play, /if \(view\.speed !== speed\) \{\s*speed = view\.speed;\s*clock = performance\.now\(\);/, 'and so does a new speed');

// ── Batches for files of many steps per chunk ──────────────────────────────
{
    const axis = datetimeAxis('2025-01-01T00:00:00Z', 8760, HOUR);
    const plan = (index, stride, options) => batchIndices(axis, index, stride, 1, { chunk: 2920, limit: 500, ...options });
    const daily = plan(5, '1d');
    assert.equal(daily[0], 5, 'the step asked first');
    assert.equal(daily.length, 122, 'a day at a time, to the end of its chunk of 2920 steps');
    assert.ok(daily.every((index, k) => index === 5 + 24 * k));
    assert.equal(plan(2915, '1d').length, 1, 'the next day is in the next chunk: read with that one');
    assert.equal(plan(0, 'step').length, 500, 'at most `limit` maps');
    assert.deepEqual(plan(0, '1d', { isCached: index => index % 48 === 24 }).slice(0, 4), [0, 48, 96, 144], 'steps in hand are left out');
    assert.deepEqual(batchIndices(axis, 100, '1d', -1, { chunk: 2920, limit: 10 }), [100, 76, 52, 28, 4], 'backwards, down to the chunk start');
    const months = plan(0, '1mo');
    // 2920 hours are 121.7 days: the first chunk runs to 2 May, 16:00.
    assert.deepEqual(months.map(index => iso(axis, index)), ['2025-01-01T00:00', '2025-02-01T00:00', '2025-03-01T00:00', '2025-04-01T00:00', '2025-05-01T00:00'],
        'months: those that begin in the first chunk');
}
assert.match(gridded, /const batch = this\._griddedBatchFor\(view, request, view\.stepDirection \|\| 1\);\s*if \(batch\?\.length > 1\) \{\s*const map = await this\._griddedReadBatch\(view, request, batch\);/,
    'a map of a time-chunked file is read with the steps after it');
assert.match(gridded, /for \(let count = 0; count < \(chunked \? BATCH_LOOKAHEAD : 1\); count\+\+\)/,
    'and the next batch is read before Play gets to it');
assert.match(gridded, /if \(view\.prefetch\?\.keys\.has\(key\)\) \{\s*await view\.prefetch\.promise/, 'a step being read ahead is waited for, not read twice');

console.log('Gridded time stride tests passed: hours, days, calendar months and years, gaps, model calendars, step counts.');
