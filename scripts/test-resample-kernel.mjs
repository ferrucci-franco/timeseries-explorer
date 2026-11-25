// Differential test: src/compute/kernels/resample.js must select exactly the
// same points as the slice-then-decimate path it replaced.
//
//   node scripts/test-resample-kernel.mjs
//
// This is what makes the zoom change safe to ship: the plotted line must be
// pixel-identical, so the decimator has to pick the same indexes, in the same
// order, for every viewport.

import assert from 'node:assert/strict';

import { makeTrace, refVisualForRange, refDownsampleTimeseries } from '../bench/legacy-resample.mjs';
import { visualPairForRange, decimateRangeIndexes, blockIndexFor, BLOCK_SIZE, BLOCK_INDEX_MIN_LENGTH } from '../src/compute/kernels/resample.js';

let checks = 0;

function assertPairEqual(got, want, label) {
    assert.equal(got.x.length, want.x.length, `${label}: x length (${got.x.length} vs ${want.x.length})`);
    assert.equal(got.y.length, want.y.length, `${label}: y length`);
    for (let i = 0; i < want.x.length; i++) {
        assert.ok(Object.is(got.x[i], want.x[i]) || got.x[i] === want.x[i], `${label}: x[${i}] ${got.x[i]} vs ${want.x[i]}`);
        const a = got.y[i];
        const e = want.y[i];
        if (Number.isNaN(e)) assert.ok(Number.isNaN(a), `${label}: y[${i}] expected NaN, got ${a}`);
        else assert.ok(Object.is(a, e) || a === e, `${label}: y[${i}] ${a} vs ${e}`);
    }
    checks++;
}

const SIZES = [0, 1, 2, 3, 5, 51, 1999, 2000, 2001, 5000, 120_000];
const TARGETS = [2000, 4000, 10_000];

for (const n of SIZES) {
    const { x, y } = makeTrace(n, 900 + n);

    for (const target of TARGETS) {
        // Full range.
        assertPairEqual(
            visualPairForRange(x, y, 0, n, target),
            refVisualForRange(x, y, 0, n, target),
            `full n=${n} t=${target}`,
        );

        // Viewport windows, including the degenerate and off-by-one ones.
        const windows = [
            [0, Math.floor(n / 2)],
            [Math.floor(n / 3), Math.floor((2 * n) / 3)],
            [Math.max(0, n - 1), n],
            [Math.floor(n / 2), Math.floor(n / 2)],
            [0, Math.min(n, target + 1)],
            [0, Math.min(n, target)],
        ];
        for (const [start, end] of windows) {
            assertPairEqual(
                visualPairForRange(x, y, start, end, target),
                refVisualForRange(x, y, start, end, target),
                `range n=${n} t=${target} [${start},${end})`,
            );
        }
    }
}

// Plain arrays with non-numeric x, which is what _renderedTracePreview feeds in
// on a calendar axis. X must be carried through untouched, not coerced.
{
    const n = 9000;
    const { y } = makeTrace(n, 4242);
    const xDates = new Array(n);
    for (let i = 0; i < n; i++) xDates[i] = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    const yPlain = Array.from(y);

    const got = visualPairForRange(xDates, yPlain, 0, n, 2000);
    const want = refVisualForRange(xDates, yPlain, 0, n, 2000);
    assert.equal(got.x.length, want.x.length, 'iso x: length');
    for (let i = 0; i < want.x.length; i++) {
        assert.equal(got.x[i], want.x[i], `iso x[${i}]`);
    }
    assert.ok(typeof got.x[0] === 'string', 'iso x stays a string, not coerced to a number');
    checks++;
}

// The no-decimation contract of _downsampleTimeseries: return the originals.
{
    const { x, y } = makeTrace(500, 11);
    const out = refDownsampleTimeseries(x, y, 2000);
    assert.ok(out.x === x && out.y === y, 'legacy returns source arrays when under target');
    checks++;
}

// Repeated calls must not alias: the decimator reuses a scratch index buffer,
// and handing Plotly a view onto it would corrupt an earlier trace.
{
    const n = 50_000;
    const { x, y } = makeTrace(n, 55);
    const first = visualPairForRange(x, y, 0, n, 2000);
    const firstX = Array.from(first.x);
    visualPairForRange(x, y, 10_000, 40_000, 2000);
    visualPairForRange(x, y, 0, n, 4000);
    assert.deepEqual(Array.from(first.x), firstX, 'earlier result is not mutated by later calls');
    checks++;
}

// The block min/max index (long typed series, wide buckets) must pick the very
// same indexes as the plain scan — the earliest extreme of each bucket — on
// what makes ties and fallbacks hard: NaN runs, ±Infinity, a bucket with no
// finite value at all, a NaN or an Infinity on a bucket's first sample, flat
// stretches (every sample a tie), -0 next to 0, and Float32 storage (audio).
{
    const n = BLOCK_INDEX_MIN_LENGTH * 3 + 777;
    const { x, y: base } = makeTrace(n, 2026);
    let state = 99;
    const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    const y = Float64Array.from(base);
    // Quantized, so equal values (ties) are everywhere.
    for (let i = 0; i < n; i++) y[i] = Math.round(y[i] * 2) / 2;
    for (let k = 0; k < 400; k++) {
        const at = Math.floor(rand() * n);
        const kind = k % 6;
        if (kind === 0) y[at] = NaN;
        else if (kind === 1) y[at] = Infinity;
        else if (kind === 2) y[at] = -Infinity;
        else if (kind === 3) y[at] = 0;
        else if (kind === 4) y[at] = -0;
        else y.fill(NaN, at, Math.min(n, at + Math.floor(rand() * 5000)));
    }
    // A run with no finite value wider than any bucket, a flat run, and runs
    // that start or end exactly on a block boundary.
    y.fill(NaN, 100_000, 140_000);
    y.fill(3.25, 300_000, 360_000);
    y.fill(Infinity, BLOCK_SIZE * 2000, BLOCK_SIZE * 2010);
    y.fill(-0, BLOCK_SIZE * 3000 + 1, BLOCK_SIZE * 3003 - 1);
    const y32 = Float32Array.from(y);
    const yPlain = Array.from(y);

    const windows = [
        [0, n], [1, n - 1], [7, n - 3], [BLOCK_SIZE, n - BLOCK_SIZE],
        [99_999, 140_001], [123_456, 780_012], [n - 600_000, n],
        [BLOCK_SIZE * 1999 + 5, BLOCK_SIZE * 2011 + 9], [250_000, 260_000],
        [BLOCK_SIZE * 64 * 3 - 1, BLOCK_SIZE * 64 * 40 + 1], [BLOCK_SIZE * 64 * 5, BLOCK_SIZE * 64 * 150],
    ];
    for (let k = 0; k < 40; k++) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        windows.push([Math.min(a, b), Math.max(a, b) + 1]);
    }
    let indexed = 0;
    for (const [label, values] of [['float64', y], ['float32', y32]]) {
        assert.ok(blockIndexFor(values), `${label}: a long typed series is indexed`);
        for (const target of [2000, 4000, 500]) {
            for (const [start, end] of windows) {
                const got = decimateRangeIndexes(values, start, end, target);
                const gotIdx = Array.from(got.indexes.subarray(0, got.count));
                const scan = decimateRangeIndexes(values, start, end, target, { blockIndex: false });
                const scanIdx = Array.from(scan.indexes.subarray(0, scan.count));
                assert.deepEqual(gotIdx, scanIdx, `${label} t=${target} [${start},${end}): indexed = scanned`);
                if (Math.ceil((end - start - 2) / Math.max(1, Math.floor((target - 2) / 2))) >= 8 * BLOCK_SIZE) indexed++;
                assertPairEqual(
                    visualPairForRange(x, values, start, end, target),
                    refVisualForRange(x, values, start, end, target),
                    `${label} t=${target} [${start},${end}) vs the frozen reference`,
                );
            }
        }
    }
    assert.ok(indexed > 50, `the comparison went through the index (${indexed} windows)`);
    // A plain array is never indexed, and gives the reference's answer.
    assert.equal(blockIndexFor(yPlain), null, 'a plain array is not indexed');
    assertPairEqual(visualPairForRange(x, yPlain, 0, n, 2000), refVisualForRange(x, yPlain, 0, n, 2000), 'plain array, full range');
    // A series that grows (Live Update keeps a plain array's identity, and a
    // typed one's buffer) is indexed again at its new length, not read through
    // the old index.
    const grow = new Float64Array(n + 50_000);
    grow.set(y);
    const head = grow.subarray(0, n);
    assertPairEqual(visualPairForRange(x, head, 0, n, 2000), refVisualForRange(x, y, 0, n, 2000), 'a view of the first n');
    for (let i = n; i < grow.length; i++) grow[i] = 1e6 + i;
    const longer = grow.subarray(0, n + 50_000);
    const xLonger = new Float64Array(n + 50_000);
    for (let i = 0; i < xLonger.length; i++) xLonger[i] = i * 0.01;
    assertPairEqual(visualPairForRange(xLonger, longer, 0, longer.length, 2000), refVisualForRange(xLonger, longer, 0, longer.length, 2000), 'the grown series');
    checks++;
}

console.log(`resample kernel: ${checks} exact comparisons passed`);
