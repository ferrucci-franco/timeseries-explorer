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
import { visualPairForRange } from '../src/compute/kernels/resample.js';

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

console.log(`resample kernel: ${checks} exact comparisons passed`);
