// Changing a file's time-axis FORMAT must stay cheap, and must take the view
// with it.
//
// Two defects this pins, both seen on a ten-minute 44.1 kHz recording
// (26,460,000 samples) whose numeric axis was promoted to a calendar:
//
//   1. The rebuild blocked the main thread for 29 seconds — long enough for
//      Firefox to offer to stop the page. _timeDisplayValueForVar was called
//      once per sample at 1.75 µs a call (46 s on its own) to re-derive an axis
//      mode and origin that are fixed for the whole file, and a 26.46M-entry
//      row map was built by push and then thrown away.
//
//   2. Afterwards the plot was empty until the user pressed auto-scale: the
//      0-600 s view was carried over unconverted and, read as epoch
//      milliseconds, landed in 1970.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ── The per-sample loop ────────────────────────────────────────────────────
const dataMethods = read('src/plots/methods/data-methods.js');
const start = dataMethods.indexOf('proto._getTransformIndexData = function');
const end = dataMethods.indexOf('\nproto.', start + 1);
assert.ok(start >= 0 && end > start, 'the transform loop can be isolated');
const transformProto = {};
vm.runInNewContext(dataMethods.slice(start, end), { proto: transformProto });

const ORIGIN_MS = 1767225600000; // 2026-01-01T00:00:00Z
const N = 5000;

function harness({ numericCalendar = false, elapsed = false, crop = null } = {}) {
    const rawTimes = new Float64Array(N);
    for (let i = 0; i < N; i++) rawTimes[i] = i * 0.25;
    const calls = { displayValue: 0, originLookups: 0 };
    const app = {
        _transformCache: () => null,
        _getTimeVar: () => ({ data: rawTimes, timeKind: 'numeric' }),
        _fileTransform: () => ({ cropStart: crop?.[0] ?? null, cropEnd: crop?.[1] ?? null, timeShift: 0 }),
        _isGeneratedIndexTime: () => false,
        _isGeneratedFromDetectedTime: () => false,
        _isNumericCalendarAxis: () => numericCalendar,
        _isElapsedTimeForVar: () => elapsed,
        _parseTimeBoundary: (_id, value) => (value === null || value === undefined ? null : Number(value)),
        _parseTimeShift: () => 0,
        _timeOriginMsForVar: () => { calls.originLookups++; return ORIGIN_MS; },
        _isGeneratedCalendarTime: () => false,
        _isHighResolutionGeneratedCalendarTime: () => false,
        _indexTimeStepMode: () => null,
        _indexTimeStepSeconds: () => 0,
        _approxRowIndexFromSourceTime: (_id, _t, i) => i,
        // The regression itself: this was invoked once per sample.
        _timeDisplayValueForVar: (_id, rawTime) => {
            calls.displayValue++;
            return numericCalendar ? ORIGIN_MS + Number(rawTime) * 1000
                : elapsed ? (rawTime - ORIGIN_MS) / 1000
                : rawTime;
        },
    };
    return { app, rawTimes, calls, run: () => transformProto._getTransformIndexData.call(app, 'f1') };
}

// Numeric axis promoted to a calendar: the expensive per-sample call must be
// gone entirely, not merely reduced.
{
    const { run, calls, rawTimes } = harness({ numericCalendar: true });
    const result = run();
    assert.equal(calls.displayValue, 0,
        'the per-sample display mapper must be hoisted out of the loop, not called N times');
    assert.ok(calls.originLookups <= 2,
        `the origin must be read a constant number of times, got ${calls.originLookups}`);
    assert.equal(result.times.constructor.name, 'Float64Array',
        'an uncropped result has a known length and must be filled in place');
    assert.equal(result.times.length, N);
    assert.equal(result.indexes, null,
        'the row map is discarded for this axis, so it must never be built');
    // Bit-exact against the expression the removed call used.
    for (const i of [0, 1, 17, N - 1]) {
        assert.equal(result.times[i], ORIGIN_MS + Number(rawTimes[i]) * 1000, `sample ${i} maps exactly`);
    }
}

// Elapsed axis: same hoist, but here the row map IS consumed, so it survives —
// and as a plain Array, because a caller maps it to floats.
{
    const { run, calls, rawTimes } = harness({ elapsed: true });
    const result = run();
    assert.equal(calls.displayValue, 0, 'elapsed axes must not call the mapper per sample either');
    assert.ok(Array.isArray(result.indexes), 'the row map must stay a plain Array where it is kept');
    assert.equal(result.indexes.length, N);
    assert.equal(result.indexes[N - 1], N - 1);
    for (const i of [0, 3, N - 1]) {
        // Bit-exact: (raw - origin) / 1000, NOT raw/1000 - origin/1000.
        assert.equal(result.times[i], (rawTimes[i] - ORIGIN_MS) / 1000, `elapsed sample ${i} rounds identically`);
    }
}

// A crop still filters, and still reports the rows it kept.
{
    const { run, calls } = harness({ numericCalendar: true, crop: [ORIGIN_MS + 1000, ORIGIN_MS + 3000] });
    const result = run();
    assert.equal(calls.displayValue, 0, 'cropping must not reintroduce the per-sample call');
    assert.ok(Array.isArray(result.indexes), 'a cropped result reports which rows survived');
    assert.equal(result.indexes.length, result.times.length, 'rows and times stay in step');
    assert.ok(result.times.length > 0 && result.times.length < N, 'the crop actually dropped samples');
    for (const t of result.times) {
        assert.ok(t >= ORIGIN_MS + 1000 && t <= ORIGIN_MS + 3000, 'every kept sample is inside the crop');
    }
}

// ── The view that follows the axis ─────────────────────────────────────────
const plotManager = read('src/plots/plot-manager.js');
const mapStart = plotManager.indexOf('    _mapTimeRangeBetweenModes(');
const mapEnd = plotManager.indexOf('\n    }', mapStart) + '\n    }'.length;
assert.ok(mapStart >= 0 && mapEnd > mapStart, 'the range mapper can be isolated');
const mapper = vm.runInNewContext(`({\n${plotManager.slice(mapStart, mapEnd)}\n})`, {});
// The origin is a property of the CURRENT transform, so it must be modelled as
// one — an earlier version of this test stubbed it as a constant, which is
// exactly what hid the demotion bug below: promoting sets the origin, demoting
// clears it, and the mapper runs after the transform has already been swapped.
const makeMapperApp = (currentOriginMs) => Object.assign(Object.create(null), mapper, {
    _timeOriginMs: () => currentOriginMs,
    _timeShiftForMode: () => 0,
    _coerceAxisValue: value => (typeof value === 'string' ? Date.parse(value) : Number(value)),
});
const promoting = makeMapperApp(ORIGIN_MS); // calendar is now active
const demoting = makeMapperApp(0);          // origin already cleared

// The reported case: the whole ten-minute signal, in seconds, promoted.
{
    const mapped = promoting._mapTimeRangeBetweenModes('f1', [0, 600], 'numeric', 'calendar', null, null, 0);
    assert.equal(mapped[0], new Date(ORIGIN_MS).toISOString(), 'the view start follows the origin, not 1970');
    assert.equal(mapped[1], new Date(ORIGIN_MS + 600000).toISOString(), 'the view end follows too');
    assert.ok(!String(mapped[0]).startsWith('1970'), 'a promoted view must never land in 1970');
}

// Coming back, the origin the values were built from is gone from the file and
// only survives as the captured fallback. Without it the view became seconds
// since 1970 (1767225600) and the trace left the screen.
{
    const back = demoting._mapTimeRangeBetweenModes(
        'f1', [new Date(ORIGIN_MS).toISOString(), new Date(ORIGIN_MS + 15).toISOString()],
        'calendar', 'numeric', null, null, ORIGIN_MS,
    );
    assert.equal(back[0], 0, 'demoting returns seconds from the origin, not from the epoch');
    assert.ok(Math.abs(back[1] - 0.015) < 1e-9, 'the 15 ms window comes back as 0.015 s');
}

// Round trip through both directions, each with the origin its own step sees.
{
    const there = promoting._mapTimeRangeBetweenModes('f1', [12.5, 480], 'numeric', 'calendar', null, null, 0);
    const back = demoting._mapTimeRangeBetweenModes('f1', there, 'calendar', 'numeric', null, null, ORIGIN_MS);
    assert.equal(back[0], 12.5, 'round-trip preserves the view start');
    assert.equal(back[1], 480, 'round-trip preserves the view end');
}

// numeric ↔ duration is value-preserving: both are seconds, and neither side
// carries an origin, so it must stay identity rather than pick one up.
{
    const plain = makeMapperApp(0);
    const mapped = plain._mapTimeRangeBetweenModes('f1', [3, 90], 'numeric', 'elapsedDateTime', null, null, 0);
    assert.equal(mapped[0], 3, 'seconds stay seconds');
    assert.equal(mapped[1], 90, 'seconds stay seconds');
}

// ── Sub-millisecond samples must stay distinct on a calendar axis ──────────
{
    const valueStart = dataMethods.indexOf('proto._plotlyTimeValue = function');
    const valueEnd = dataMethods.indexOf('\nproto.', valueStart + 1);
    assert.ok(valueStart >= 0 && valueEnd > valueStart, 'the axis-value formatter can be isolated');
    const valueProto = {};
    vm.runInNewContext(dataMethods.slice(valueStart, valueEnd), { proto: valueProto, Date, Math, String });
    const calendarApp = {
        _timeDisplayModeForVar: () => 'calendar',
        _isHighResolutionGeneratedCalendarTime: () => false,
    };
    const format = value => valueProto._plotlyTimeValue.call(calendarApp, 'f1', value);

    // 44.1 kHz: 22.6757 µs apart. Three decimals put ~44 of these on one
    // timestamp, which is what flattened the waveform into vertical bars.
    const stamps = [];
    for (let i = 0; i < 200; i++) stamps.push(format(ORIGIN_MS + i * 0.0226757));
    assert.equal(new Set(stamps).size, 200,
        'every sub-millisecond sample must get its own timestamp, not share one per millisecond');

    // Whole milliseconds keep the exact string they always had.
    assert.equal(format(ORIGIN_MS), new Date(ORIGIN_MS).toISOString(), 'whole milliseconds are unchanged');
    assert.equal(format(ORIGIN_MS + 5), new Date(ORIGIN_MS + 5).toISOString(), 'whole milliseconds are unchanged');

    // The wall clock must not move: the extra digits are appended to the same
    // instant, never a rounded or shifted one.
    assert.ok(format(ORIGIN_MS + 0.000023).startsWith(new Date(ORIGIN_MS).toISOString().slice(0, -1)),
        'sub-millisecond stamps extend the same instant');
    assert.equal(format(ORIGIN_MS + 1.5), `${new Date(ORIGIN_MS + 1).toISOString().slice(0, -1)}500`,
        'the fractional millisecond becomes microseconds, carrying nothing into the seconds');

    // Stated as properties rather than exact strings, because how fine a
    // fraction survives is a property of float64 at this magnitude, not of the
    // formatter: an epoch-millisecond around 2026 carries ~0.24 µs per unit in
    // the last place, so 1767225600000.9999 IS exactly ...001 here and takes
    // the whole-millisecond path legitimately. Asserting a literal string for
    // it pinned arithmetic this code does not own.
    for (const fraction of [0.0226757, 0.5, 0.25, 0.999]) {
        const value = ORIGIN_MS + fraction;
        if (value === Math.floor(value)) continue; // below the float64 floor here
        const stamp = format(value);
        assert.match(stamp, /T\d\d:\d\d:\d\d\.\d{6}$/,
            `${fraction} ms must print exactly six fractional digits and no zone suffix`);
        const [datePart, microPart] = [stamp.slice(0, 23), stamp.slice(23)];
        const roundTripped = Date.parse(`${datePart}Z`) + Number(microPart) / 1000;
        assert.ok(Math.abs(roundTripped - value) <= 0.0005,
            `${fraction} ms must survive the round trip, got ${roundTripped - value} ms of drift`);
    }

    // Non-calendar axes are untouched.
    const numericApp = { _timeDisplayModeForVar: () => 'numeric', _isHighResolutionGeneratedCalendarTime: () => false };
    assert.equal(valueProto._plotlyTimeValue.call(numericApp, 'f1', 12.5), 12.5, 'numeric axes pass values through');
}

console.log('Time-axis transform performance and view-mapping checks passed.');
