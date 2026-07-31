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
const mapperApp = Object.assign(Object.create(null), mapper, {
    _timeOriginMs: () => ORIGIN_MS,
    _timeShiftForMode: () => 0,
    _coerceAxisValue: value => (typeof value === 'string' ? Date.parse(value) : Number(value)),
});

// The reported case: the whole ten-minute signal, in seconds, promoted.
{
    const mapped = mapperApp._mapTimeRangeBetweenModes('f1', [0, 600], 'numeric', 'calendar');
    assert.equal(mapped[0], new Date(ORIGIN_MS).toISOString(), 'the view start follows the origin, not 1970');
    assert.equal(mapped[1], new Date(ORIGIN_MS + 600000).toISOString(), 'the view end follows too');
    assert.ok(!String(mapped[0]).startsWith('1970'), 'a promoted view must never land in 1970');
}

// And back again, losslessly — otherwise switching format twice walks the view.
{
    const there = mapperApp._mapTimeRangeBetweenModes('f1', [12.5, 480], 'numeric', 'calendar');
    const back = mapperApp._mapTimeRangeBetweenModes('f1', there, 'calendar', 'numeric');
    assert.equal(back[0], 12.5, 'round-trip preserves the view start');
    assert.equal(back[1], 480, 'round-trip preserves the view end');
}

// numeric ↔ duration is value-preserving: both are seconds, so it is identity.
{
    const mapped = mapperApp._mapTimeRangeBetweenModes('f1', [3, 90], 'numeric', 'elapsedDateTime');
    assert.equal(mapped[0], 3, 'seconds stay seconds');
    assert.equal(mapped[1], 90, 'seconds stay seconds');
}

console.log('Time-axis transform performance and view-mapping checks passed.');
