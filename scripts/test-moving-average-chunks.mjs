// The moving average fed a chunk at a time gives the doubles the array
// function gives, however the series is cut.
//
//   node scripts/test-moving-average-chunks.mjs
//
// The incremental form (createMovingAverage) is what the chunked executor runs
// over a file too large to hold, and what computeMovingAverage runs over an
// array. Checked here, bit for bit:
//   · the array function against the loop it replaced, kept below verbatim;
//   · chunks of 1, 2, 7, 1000 rows and random sizes against one push, with
//     windows wider than the series, holes, ±∞ and values whose sum overflows;
//   · the moving-average detrend, its fit points included, the same way.
import assert from 'node:assert/strict';
import { computeMovingAverage, createMovingAverage } from '../src/compute/kernels/moving-average.js';
import { computeDetrend, createMovingAverageDetrend, normalizeDetrendWindow } from '../src/compute/kernels/detrend.js';
import { normalizeMovingAverageWindow } from '../src/compute/kernels/shared.js';

// The kernel as it was before the incremental form, verbatim.
function referenceMovingAverage(values, params = {}) {
    const n = values.length;
    const window = normalizeMovingAverageWindow(params.window, n);
    const left = Math.floor((window - 1) / 2);
    const right = window - left - 1;
    const out = new Float64Array(n).fill(NaN);
    let start = 0;
    let end = -1;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
        const nextStart = i - left > 0 ? i - left : 0;
        const nextEnd = i + right < n - 1 ? i + right : n - 1;
        while (end < nextEnd) {
            const value = values[++end];
            if (Number.isFinite(value)) { sum += value; count++; }
        }
        while (start < nextStart) {
            const value = values[start++];
            if (Number.isFinite(value)) { sum -= value; count--; }
        }
        out[i] = count ? sum / count : NaN;
    }
    return out;
}

function referenceDetrend(values, windowParam) {
    const n = values.length;
    const out = new Float64Array(n).fill(NaN);
    const window = normalizeDetrendWindow(normalizeDetrendWindow(windowParam), n);
    const baseline = referenceMovingAverage(values, { window });
    let used = 0;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(values[i]) || !Number.isFinite(baseline[i])) continue;
        out[i] = values[i] - baseline[i];
        used++;
    }
    return { values: out, used };
}

let seed = 11;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function series(n, kind) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let v = Math.sin(i / 37) * 100 + random() * 3 + i / 50;
        if (kind === 'holes' && (i % 11 === 3 || (i > n / 3 && i < n / 3 + 40))) v = NaN;
        if (kind === 'wild') {
            if (i % 97 === 5) v = Infinity;
            else if (i % 89 === 7) v = -Infinity;
            else if (i % 13 === 0) v = NaN;
            else if (i % 31 === 1) v = (i % 2 ? 1 : -1) * 1.7e308;
        }
        out[i] = v;
    }
    return out;
}

const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
}

// Feed `values` cut by `sizes` (a number, or a function giving each size).
function chunked(kernel, values, sizes) {
    const parts = [];
    let at = 0;
    let k = 0;
    while (at < values.length) {
        const size = typeof sizes === 'function' ? sizes(k++) : sizes;
        const piece = values.subarray(at, Math.min(values.length, at + size));
        parts.push(kernel.push(piece));
        at += piece.length;
    }
    parts.push(kernel.flush());
    const out = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
    let pos = 0;
    for (const part of parts) { out.set(part, pos); pos += part.length; }
    return out;
}

const cuts = [1, 2, 7, 1000, k => 1 + Math.floor(random() * 300), k => (k % 2 ? 0 : 5)];
const windows = [2, 3, 4, 21, 22, 101, 999, 5000, 0, -3, 'x', 1e9];
const lengths = [0, 1, 2, 3, 20, 21, 22, 1003, 6000];
let checked = 0;

for (const kind of ['plain', 'holes', 'wild']) {
    for (const n of lengths) {
        const values = series(n, kind);
        for (const window of windows) {
            const params = { window };
            const expected = referenceMovingAverage(values, params);
            assertBitwise(computeMovingAverage(values, params), expected, `array, ${kind}, n=${n}, window=${window}`);
            // A plain array in, as the worker can hand it.
            assertBitwise(computeMovingAverage(Array.from(values), params), expected, `JS array, ${kind}, n=${n}, window=${window}`);
            for (const cut of cuts) {
                const label = `chunks of ${typeof cut === 'function' ? 'varying size' : cut}, ${kind}, n=${n}, window=${window}`;
                assertBitwise(chunked(createMovingAverage(params), values, cut), expected, label);
                checked++;
            }
            if (typeof window === 'number' && window >= 3) {
                const ref = referenceDetrend(values, window);
                const report = computeDetrend(values, null, { method: 'movingAverage', window });
                if (n) {
                    assertBitwise(report.values, ref.values, `detrend, ${kind}, n=${n}, window=${window}`);
                    assert.equal(report.fitPoints, ref.used, `detrend fit points, ${kind}, n=${n}, window=${window}`);
                }
                for (const cut of [1, 7, 1000]) {
                    const detrend = createMovingAverageDetrend({ window });
                    assertBitwise(chunked(detrend, values, cut), ref.values, `detrend in chunks of ${cut}, ${kind}, n=${n}, window=${window}`);
                    assert.equal(detrend.used, ref.used, `detrend fit points in chunks of ${cut}`);
                }
            }
        }
    }
}
console.log(`moving average: the incremental form matches the array loop bit for bit (${checked} cuts, windows wider than the series, holes, ±∞, overflow)`);

// Outputs trail the input by `right` samples once a window's worth has come,
// and nothing is held beyond a window.
{
    const average = createMovingAverage({ window: 5 });
    assert.equal(average.push(new Float64Array([1, 2, 3, 4])).length, 0, 'below a window: nothing yet');
    const out = average.push(new Float64Array([5, 6]));
    assert.equal(average.lag, 2, 'window 5 looks 2 ahead');
    assert.equal(out.length, 4, '6 in, 2 still waiting');
    assert.equal(average.flush().length, 2, 'the last 2 at the end');
    assert.throws(() => average.push(new Float64Array([1])), /after flush/, 'a flushed kernel takes nothing more');
}
console.log('moving average: outputs trail the input by half a window, and a flush closes it');
