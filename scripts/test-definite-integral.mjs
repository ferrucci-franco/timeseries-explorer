// The definite-integral kernel behind the Integral analysis mode.
//
// Expected values are analytic (a constant over a known duration, a ramp whose
// area is a triangle) rather than snapshots of the implementation, so a change
// that alters the answer fails here instead of quietly re-baselining.
//
//   node scripts/test-definite-integral.mjs

import assert from 'node:assert/strict';

import {
    collectMissingDays,
    computeDefiniteIntegral,
    MS_PER_DAY,
    utcDayIndex,
} from '../src/compute/kernels/definite-integral.js';

let checks = 0;

function close(actual, expected, label, tolerance = 1e-9) {
    const scale = Math.max(1, Math.abs(expected));
    assert.ok(
        Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * scale,
        `${label}: expected ${expected}, got ${actual}`,
    );
    checks++;
}

function equal(actual, expected, label) {
    assert.deepEqual(actual, expected, label);
    checks++;
}

const HOUR = 3600000;
const day0 = Date.UTC(2030, 0, 1);

// Hourly calendar axis: `hours` samples starting at `start`.
function hourlyTime(count, start = day0) {
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) values[i] = start + i * HOUR;
    return { values, kind: 'datetime' };
}

// ─── 1. Constant signal, calendar axis ────────────────────────────────────
// 100 MW held over 24 sample points (23 hours of trapezoids) is 2300 MW·s×3600.
// The kernel answers in unit·seconds; the panel divides by 3600 for MW·h.
{
    const time = hourlyTime(24);
    const values = new Array(24).fill(100);
    const r = computeDefiniteIntegral(values, time, {});
    close(r.value, 100 * 23 * 3600, 'constant over 23 h of trapezoids');
    close(r.coveredTime, 23 * 3600, 'covered time is 23 h');
    close(r.uncoveredTime, 0, 'nothing uncovered');
    equal(r.ok, true, 'constant integral is ok');
    equal(r.timeKind, 'datetime', 'time kind travels with the value');
}

// An explicit null bound means "use the data extent". It has to be tested for
// rather than coerced: Number(null) is 0, which is finite, and would collapse a
// calendar range to [0, 0] — the panel passes exactly these nulls in Full mode.
{
    const time = hourlyTime(24);
    const values = new Array(24).fill(100);
    const nulls = computeDefiniteIntegral(values, time, { rangeStart: null, rangeEnd: null });
    close(nulls.value, 100 * 23 * 3600, 'a null range integrates the whole series');
    equal(nulls.ok, true, 'and does not report "no data"');
    const undef = computeDefiniteIntegral(values, time, { rangeStart: undefined, rangeEnd: undefined });
    close(undef.value, nulls.value, 'undefined behaves the same as null');
    // Zero is still a legitimate bound where the axis actually reaches it.
    const numeric = computeDefiniteIntegral([2, 2, 2], { values: new Float64Array([0, 1, 2]), kind: 'numeric' },
        { rangeStart: 0, rangeEnd: 1 });
    close(numeric.value, 2, 'an explicit zero bound is honoured, not treated as absent');
}

// ─── 2. Ramp, and the two quadrature rules ────────────────────────────────
// y = t hours, sampled hourly 0…10. Trapezoid over [0,10] h is exactly 50 h².
{
    const time = hourlyTime(11);
    const values = Array.from({ length: 11 }, (_, i) => i);
    const trap = computeDefiniteIntegral(values, time, { method: 'trapezoidal' });
    close(trap.value, 50 * 3600, 'trapezoidal ramp is the exact triangle');
    // Left rectangles under a ramp lose half a step per interval: 45 instead of 50.
    const rect = computeDefiniteIntegral(values, time, { method: 'rectangular' });
    close(rect.value, 45 * 3600, 'left rectangles under-count the ramp by half a step');
}

// ─── 3. Range clipping interpolates at the boundary ───────────────────────
// Half of the first hour of a constant signal is half the area, and the total
// must move continuously as the boundary sweeps — no jump at a sample.
{
    const time = hourlyTime(24);
    const values = new Array(24).fill(100);
    const half = computeDefiniteIntegral(values, time, {
        rangeStart: day0 + 0.5 * HOUR,
        rangeEnd: day0 + 1.5 * HOUR,
    });
    close(half.value, 100 * 3600, 'a one-hour window off the sample grid still integrates one hour');

    const before = computeDefiniteIntegral(values, time, { rangeStart: day0, rangeEnd: day0 + 2 * HOUR - 1 });
    const after = computeDefiniteIntegral(values, time, { rangeStart: day0, rangeEnd: day0 + 2 * HOUR + 1 });
    close(after.value - before.value, 100 * 0.002, 'crossing a sample changes the total by ~nothing', 1e-6);

    // A ramp clipped mid-interval must use the INTERPOLATED endpoint value, not
    // the neighbouring sample: ∫₀^0.5 t dt = 0.125 h², not 0 and not 0.5.
    const ramp = Array.from({ length: 11 }, (_, i) => i);
    const clipped = computeDefiniteIntegral(ramp, hourlyTime(11), {
        rangeStart: day0,
        rangeEnd: day0 + 0.5 * HOUR,
    });
    close(clipped.value, 0.125 * 3600, 'the clipped endpoint is interpolated');
}

// ─── 4. Numeric axis keeps its own units, index axis is a count ───────────
{
    const values = [2, 2, 2, 2, 2];
    const numeric = computeDefiniteIntegral(values, { values: new Float64Array([0, 1, 2, 3, 4]), kind: 'numeric' }, {});
    close(numeric.value, 8, 'a numeric axis integrates in its own x-units');
    equal(numeric.timeKind, 'numeric', 'numeric time kind is reported');

    const index = computeDefiniteIntegral(values, { values: null, kind: 'index' }, {});
    close(index.value, 8, 'an index axis integrates over row counts');
    equal(index.hasNominalStep, false, 'an index axis cannot be judged for missing rows');
}

// ─── 5. Missing VALUES (empty cells) ──────────────────────────────────────
// 100 MW hourly for 25 points (24 h) with hours 10 and 11 blank.
{
    const time = hourlyTime(25);
    const values = new Array(25).fill(100);
    values[10] = NaN;
    values[11] = NaN;
    const full = 100 * 24 * 3600;

    const zero = computeDefiniteIntegral(values, time, { missingPolicy: 'zero' });
    // Three trapezoids touch the two blanks (9→10, 10→11, 11→12): 3 h lost.
    close(zero.value, 100 * 21 * 3600, 'zero policy drops every segment touching the hole');
    close(zero.uncoveredTime, 3 * 3600, 'and says how much time that was');
    assert.ok(zero.value < full, 'so the total is a lower bound');
    checks++;

    const interpolated = computeDefiniteIntegral(values, time, { missingPolicy: 'interpolate' });
    close(interpolated.value, full, 'interpolating across a flat hole recovers the full area');
    close(interpolated.uncoveredTime, 3 * 3600,
        'the uncovered span is a property of the file, so it is reported under every policy');
}

// ─── 6. Missing ROWS agree with missing values ────────────────────────────
// The same physical hole spelled the other way: rows 10 and 11 absent.
{
    const times = [];
    const values = [];
    for (let i = 0; i < 25; i++) {
        if (i === 10 || i === 11) continue;
        times.push(day0 + i * HOUR);
        values.push(100);
    }
    const time = { values: Float64Array.from(times), kind: 'datetime' };
    const zero = computeDefiniteIntegral(values, time, { missingPolicy: 'zero' });
    close(zero.value, 100 * 21 * 3600, 'an absent row gives the same answer as an empty cell');
    equal(zero.gapCount, 1, 'and is reported as one gap');
    equal(zero.hasNominalStep, true, 'because the axis has a nominal step to judge against');

    const interpolated = computeDefiniteIntegral(values, time, { missingPolicy: 'interpolate' });
    close(interpolated.value, 100 * 24 * 3600, 'interpolate crosses the absent rows too');
}

// ─── 7. Discard whole day ─────────────────────────────────────────────────
// Three days of hourly 100 MW; day 1 (the middle) has a blank.
{
    const count = 24 * 3 + 1;
    const time = hourlyTime(count);
    const values = new Array(count).fill(100);
    values[30] = NaN; // 06:00 on the second day

    const own = computeDefiniteIntegral(values, time, {
        missingPolicy: 'discard-day-own',
        rangeStart: day0,
        rangeEnd: day0 + 3 * MS_PER_DAY,
    });
    close(own.coveredTime, 2 * 24 * 3600, 'the polluted day leaves the domain entirely');
    close(own.value, 100 * 48 * 3600, 'so exactly two clean days are integrated');
    equal(own.discardedDayCount, 1, 'and one day is reported discarded');
    equal(own.dayCount, 3, 'out of three in the range');

    // The union path: a day poisoned in ANOTHER signal is removed here too, so
    // every bar in the panel claims the same integrated duration.
    const clean = new Array(count).fill(100);
    const all = computeDefiniteIntegral(clean, time, {
        missingPolicy: 'discard-day-all',
        excludedDays: [utcDayIndex(day0 + MS_PER_DAY)],
        rangeStart: day0,
        rangeEnd: day0 + 3 * MS_PER_DAY,
    });
    close(all.coveredTime, own.coveredTime, 'a clean signal drops the same day as the dirty one');
    close(all.value, 100 * 48 * 3600, 'so the two totals stay comparable');

    const days = collectMissingDays(values, time, { rangeStart: day0, rangeEnd: day0 + 3 * MS_PER_DAY });
    equal(days.days, [utcDayIndex(day0 + MS_PER_DAY)], 'the union helper names the polluted day');
}

// ─── 8. Discard incomplete start/end days ─────────────────────────────────
// Hourly data starting at 06:00 on day 0 and ending at 12:00 on day 2.
{
    const start = day0 + 6 * HOUR;
    const count = 24 * 2 + 7; // 06:00 day0 … 12:00 day2
    const time = hourlyTime(count, start);
    const values = new Array(count).fill(100);

    const kept = computeDefiniteIntegral(values, time, { discardIncompleteEnds: false });
    close(kept.coveredTime, (count - 1) * 3600, 'without the option every hour counts');

    const trimmed = computeDefiniteIntegral(values, time, { discardIncompleteEnds: true });
    close(trimmed.coveredTime, 24 * 3600, 'only the one whole day survives');
    close(trimmed.value, 100 * 24 * 3600, 'and it integrates to a clean 24 h');
    equal(trimmed.discardedDayCount, 2, 'both ragged ends are reported');

    // A day whose last sample sits one nominal step short of midnight IS
    // complete — hourly 00:00…23:00 covers the day.
    const whole = computeDefiniteIntegral(new Array(24).fill(100), hourlyTime(24), {
        discardIncompleteEnds: true,
        rangeStart: day0,
        rangeEnd: day0 + MS_PER_DAY,
    });
    equal(whole.discardedDayCount, 0, 'one nominal step of slack keeps a full day');
}

// ─── 9. Refusals ──────────────────────────────────────────────────────────
{
    const unsorted = { values: Float64Array.from([0, 2, 1, 3].map(h => day0 + h * HOUR)), kind: 'datetime' };
    const r = computeDefiniteIntegral([1, 1, 1, 1], unsorted, {});
    equal(r.ok, false, 'disordered timestamps produce no total');
    equal(r.reason, 'unsorted', 'and say why');

    const tooShort = computeDefiniteIntegral([1], hourlyTime(1), {});
    equal(tooShort.ok, false, 'a single sample spans no time');
    equal(tooShort.reason, 'noData', 'reported as no data');

    // Every day discarded is its own answer, not "no data".
    const count = 25;
    const values = new Array(count).fill(100);
    values[5] = NaN;
    const gone = computeDefiniteIntegral(values, hourlyTime(count), {
        missingPolicy: 'discard-day-own',
        rangeStart: day0,
        rangeEnd: day0 + MS_PER_DAY,
    });
    equal(gone.ok, false, 'discarding the only day leaves nothing to integrate');
    equal(gone.reason, 'allDiscarded', 'and says so distinctly');
}

// ─── 10. Genuinely irregular sampling claims no gaps ──────────────────────
// The nominal-step gate: where there is no period, a long interval is real
// sampling, not a hole. Same rule the Missing/NaN overlay follows.
{
    const raw = [0, 300, 900, 1500, 1800, 1830, 1860, 2100, 2400, 2700,
        3000, 3300, 3540, 3600, 3900, 4200, 5400, 6600, 7200];
    const time = { values: Float64Array.from(raw, s => day0 + s * 1000), kind: 'datetime' };
    const r = computeDefiniteIntegral(new Array(raw.length).fill(10), time, {});
    equal(r.hasNominalStep, false, 'irregular sampling has no nominal step');
    equal(r.gapCount, 0, 'so nothing is called a gap');
    close(r.value, 10 * 7200, 'and the whole span is integrated');
}

console.log(`definite integral: ${checks} checks passed`);
