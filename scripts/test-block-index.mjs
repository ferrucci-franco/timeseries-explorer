// The block min/max index (src/compute/kernels/block-index.js) answers the
// queries that used to read every sample of a series held in memory — the
// finite extent of a range, for an autoscale or a Fit Y — and must give the
// very same numbers as those scans.
//
//   · finiteRangeExtent = the plain scan, on NaN runs, ±Infinity, ties, -0 next
//     to 0, a range with no finite value, Float32 and Float64 storage, ranges
//     that start and end on and off block edges;
//   · isSortedFiniteAxis: true for an ordered finite typed axis (repeated
//     instants included), false for one that goes back, holds a NaN, or is a
//     plain array; remembered per array and length;
//   · PlotManager._finiteExtent and _finiteYExtentInXRange — sliced out of
//     plot-manager.js and run as they are — equal verbatim copies of the
//     versions that scanned (kept below), on the axes the fast path takes and
//     on the ones it leaves to the scan (unordered, NaN time, plain arrays,
//     positive-only for a log axis).
//
//   node scripts/test-block-index.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
    BLOCK_INDEX_MIN_LENGTH, BLOCK_SIZE, SUPER_SIZE, blockIndexFor, finiteRangeExtent,
    isSortedFiniteAxis, sortedLowerBound, sortedUpperBound,
} from '../src/compute/kernels/block-index.js';
import { createExtentCache, scanFiniteExtent } from '../src/utils/finite-extent.js';

let checks = 0;
const same = (a, b) => Object.is(a, b);
function assertExtent(got, want, label) {
    assert.ok(same(got.min, want.min) && same(got.max, want.max),
        `${label}: {${got.min}, ${got.max}} vs {${want.min}, ${want.max}}`);
    checks++;
}

let state = 4242;
const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };

function hardSeries(n) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = Math.round((40 * Math.sin(i * 0.0003) + 8 * (rand() - 0.5)) * 4) / 4;
    for (let k = 0; k < 600; k++) {
        const at = Math.floor(rand() * n);
        const kind = k % 7;
        if (kind === 0) y[at] = NaN;
        else if (kind === 1) y[at] = Infinity;
        else if (kind === 2) y[at] = -Infinity;
        else if (kind === 3) y[at] = 0;
        else if (kind === 4) y[at] = -0;
        else if (kind === 5) y[at] = (rand() < 0.5 ? -1 : 1) * 500;   // spikes: the extremes
        else y.fill(NaN, at, Math.min(n, at + Math.floor(rand() * 3000)));
    }
    y.fill(NaN, 50_000, 90_000);                                   // wider than any query below
    y.fill(-0, BLOCK_SIZE * 1000, BLOCK_SIZE * 1004);              // -0 on block edges
    y.fill(0, BLOCK_SIZE * 1004, BLOCK_SIZE * 1006);
    return y;
}

// ── finiteRangeExtent = the scan ───────────────────────────────────────────
const n = BLOCK_INDEX_MIN_LENGTH * 2 + 333;
const SUPER = BLOCK_SIZE * SUPER_SIZE;
const y64 = hardSeries(n);
const y32 = Float32Array.from(y64);
// Only zeros, -0 first: which zero is the extent is decided by who comes first.
const zeros = new Float64Array(n);
zeros.fill(-0, 0, BLOCK_SIZE * 3 + 5);
for (const [label, y] of [['float64', y64], ['float32', y32], ['zeros', zeros]]) {
    assert.ok(blockIndexFor(y), `${label}: indexed`);
    const ranges = [
        [0, n], [1, n - 1], [BLOCK_SIZE, n - BLOCK_SIZE], [BLOCK_SIZE - 1, BLOCK_SIZE * 9 + 1],
        [50_000, 90_000], [49_999, 90_001], [BLOCK_SIZE * 999 + 7, BLOCK_SIZE * 1007 - 3],
        [100, 100], [100, 101], [n - 10, n], [n - 600, n],
        // On and off super-block edges, and ranges with one or two of them.
        [SUPER, 3 * SUPER], [SUPER - 1, 3 * SUPER + 1], [SUPER + BLOCK_SIZE, 2 * SUPER - BLOCK_SIZE],
        [SUPER - BLOCK_SIZE - 3, 2 * SUPER + BLOCK_SIZE + 3], [7 * SUPER + 5, 9 * SUPER - 5],
    ];
    for (let k = 0; k < 60; k++) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        ranges.push([Math.min(a, b), Math.max(a, b)]);
    }
    for (const [from, to] of ranges) {
        assertExtent(finiteRangeExtent(y, from, to), scanFiniteExtent(y.subarray(from, to)), `${label} [${from},${to})`);
    }
    assertExtent(finiteRangeExtent(y), scanFiniteExtent(y), `${label} whole`);
}
assert.ok(Object.is(finiteRangeExtent(zeros).min, -0), 'the earliest zero is the extent, sign and all');
{
    const empty = new Float64Array(n).fill(NaN);
    assertExtent(finiteRangeExtent(empty), { min: Infinity, max: -Infinity }, 'no finite value');
    const plain = Array.from(y64.subarray(0, 5000));
    assertExtent(finiteRangeExtent(plain, 10, 4000), scanFiniteExtent(plain.slice(10, 4000)), 'a plain array is scanned');
    assert.equal(blockIndexFor(plain), null, 'and not indexed');
    assert.equal(blockIndexFor(new Float64Array(1000)), null, 'nor is a short series');
}

// ── isSortedFiniteAxis ──────────────────────────────────────────────────────
{
    const t = new Float64Array(2000);
    for (let i = 0; i < t.length; i++) t[i] = Math.floor(i / 3) * 0.5;   // repeated instants
    assert.equal(isSortedFiniteAxis(t), true, 'ordered, with repeats');
    const back = t.slice(); back[1500] = 1;
    assert.equal(isSortedFiniteAxis(back), false, 'goes back');
    const hole = t.slice(); hole[7] = NaN;
    assert.equal(isSortedFiniteAxis(hole), false, 'a NaN time');
    assert.equal(isSortedFiniteAxis(Array.from(t)), false, 'a plain array is not taken');
    const grown = new Float64Array(2001); grown.set(t); grown[2000] = -5;
    assert.equal(isSortedFiniteAxis(grown.subarray(0, 2000)), true, 'a view of the ordered part');
    assert.equal(isSortedFiniteAxis(grown), false, 'the whole, which goes back at the end');
    assert.equal(sortedLowerBound(t, 2), 12, 'lower bound: first >= 2');
    assert.equal(sortedUpperBound(t, 2), 15, 'upper bound: first > 2');
    checks += 8;
}

// ── PlotManager's extents, as they are, against the scans they replaced ─────
// Flattened: a Windows checkout has CRLF line ends.
const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const classMethod = (name) => {
    const sig = source.match(new RegExp(`^ {4}${name}\\(([^)]*)\\) \\{$`, 'm'));
    assert.ok(sig, `${name} is present`);
    const stop = source.indexOf('\n    }\n', sig.index) + '\n    }'.length;
    return source.slice(sig.index, stop).replace(sig[0], `proto.${name} = function(${sig[1]}) {`);
};
const proto = {};
vm.runInNewContext(['_finiteExtent', '_arrayExtent', '_finiteYExtentInXRange'].map(classMethod).join('\n'), {
    proto, ArrayBuffer, Number, Math, Infinity,
    createExtentCache, scanFiniteExtent, finiteRangeExtent, isSortedFiniteAxis, sortedLowerBound, sortedUpperBound,
});

// Verbatim copies of the two methods before the block index.
function legacyFiniteExtent(arrays, options = {}) {
    const positive = !!options.positive;
    let min = Infinity;
    let max = -Infinity;
    for (const arr of arrays) {
        if (!arr) continue;
        for (const value of arr) {
            if (!Number.isFinite(value)) continue;
            if (positive && !(value > 0)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
        }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}
function legacyFiniteYExtentInXRange(series, xRange, options = {}) {
    const positive = !!options.positive;
    const a = this._coerceAxisValue(xRange?.[0]);
    const b = this._coerceAxisValue(xRange?.[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const minX = Math.min(a, b);
    const maxX = Math.max(a, b);
    let min = Infinity;
    let max = -Infinity;
    for (const item of series || []) {
        const x = item?.x || [];
        const y = item?.y || [];
        const count = Math.min(x.length, y.length);
        for (let i = 0; i < count; i++) {
            const xv = this._coerceAxisValue(x[i]);
            if (!Number.isFinite(xv) || xv < minX || xv > maxX) continue;
            const yv = Number(y[i]);
            if (!Number.isFinite(yv)) continue;
            if (positive && !(yv > 0)) continue;
            if (yv < min) min = yv;
            if (yv > max) max = yv;
        }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}
const harness = {
    ...proto,
    // The app's coercion for a number; strings are not used here.
    _coerceAxisValue(value) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : NaN; },
};
const assertNullableExtent = (got, want, label) => {
    if (want === null) { assert.equal(got, null, label); checks++; return; }
    assert.ok(got, `${label}: an extent`);
    assertExtent(got, want, label);
};

{
    const time = new Float64Array(n);
    for (let i = 0; i < n; i++) time[i] = Math.floor(i / 2) / 1000;   // repeated instants
    const shuffled = time.slice(); shuffled[n >> 1] = 0;             // goes back once
    const holed = time.slice(); holed[1234] = NaN;
    const other = hardSeries(n - 1000);
    const otherTime = time.subarray(0, n - 1000);
    const cases = [
        ['ordered', [{ x: time, y: y64 }, { x: otherTime, y: other }]],
        ['float32 values', [{ x: time, y: y32 }]],
        ['time goes back', [{ x: shuffled, y: y64 }]],
        ['a NaN time', [{ x: holed, y: y64 }]],
        ['plain arrays', [{ x: Array.from(time.subarray(0, 20_000)), y: Array.from(y64.subarray(0, 20_000)) }]],
        ['y shorter than x', [{ x: time, y: y64.subarray(0, n - 777) }]],
    ];
    const windows = [[0, time[n - 1]], [-5, 1e9], [10, 20], [25, 45], [20.0005, 20.0005], [30, 29], [1e6, 2e6], [time[1000], time[1001]]];
    for (let k = 0; k < 10; k++) {
        const a = rand() * time[n - 1];
        const b = rand() * time[n - 1];
        windows.push([a, b]);
    }
    for (const [label, series] of cases) {
        for (const positive of [false, true]) {
            for (const window of windows) {
                assertNullableExtent(
                    harness._finiteYExtentInXRange(series, window, { positive }),
                    legacyFiniteYExtentInXRange.call(harness, series, window, { positive }),
                    `Fit Y, ${label}${positive ? ', log' : ''}, [${window}]`,
                );
            }
        }
        const arrays = series.map(s => s.y);
        for (const positive of [false, true]) {
            assertNullableExtent(harness._finiteExtent(arrays, { positive }), legacyFiniteExtent(arrays, { positive }), `autoscale, ${label}${positive ? ', log' : ''}`);
            assertNullableExtent(harness._finiteExtent(arrays, { positive, cache: true }), legacyFiniteExtent(arrays, { positive }), `autoscale (cached), ${label}${positive ? ', log' : ''}`);
        }
        assertNullableExtent(harness._finiteExtent(series.map(s => s.x)), legacyFiniteExtent(series.map(s => s.x)), `time extent, ${label}`);
    }
    assertNullableExtent(harness._finiteExtent([new Float64Array(n).fill(NaN), null]), null, 'nothing finite: null');
    assertNullableExtent(harness._finiteExtent([[1, 'x', 3], new Set([7, -2])]), legacyFiniteExtent([[1, 'x', 3], new Set([7, -2])]), 'a Set is still iterated');
}

console.log(`block index: ${checks} exact comparisons passed`);
