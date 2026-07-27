// Differential test: the src/compute/kernels/* rewrites must agree bit-for-bit
// with the original data-tools implementations they replaced.
//
// The expected values come from bench/legacy-data-tools.mjs, which holds
// verbatim copies of the pre-rewrite code. They are deliberately NOT imported
// from the app: the point is to pin the old behaviour independently, so a
// future edit to the fast path cannot silently drag the expected values along
// with it.
//
//   node scripts/test-compute-kernels.mjs

import assert from 'node:assert/strict';

import { computeDerivative } from '../src/compute/kernels/derivative.js';
import { computeIntegral } from '../src/compute/kernels/integral.js';
import { computeMovingAverage } from '../src/compute/kernels/moving-average.js';
import {
    detectOutlierIndexes,
    interpolateOutliers,
    replaceOutliersWithNaN,
} from '../src/compute/kernels/outliers.js';

import {
    makeSignal,
    makeTime,
    refDerivative,
    refDetectOutlierIndexes,
    refIntegral,
    refInterpolate,
    refMovingAverage,
    refReplaceWithNaN,
} from '../bench/legacy-data-tools.mjs';

// ─── Assertions ───────────────────────────────────────────────────────────

let checks = 0;

function assertBitEqual(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        const a = actual[i];
        const e = expected[i];
        if (Number.isNaN(e)) {
            assert.ok(Number.isNaN(a), `${label}[${i}]: expected NaN, got ${a}`);
            continue;
        }
        // Object.is separates +0 from -0 and is the strictest available check.
        assert.ok(
            Object.is(a, e) || a === e,
            `${label}[${i}]: expected ${e}, got ${a} (delta ${a - e})`,
        );
    }
    checks++;
}

function assertIndexesEqual(actual, expected, label) {
    assert.deepEqual(Array.from(actual), Array.from(expected), `${label}: indexes`);
    checks++;
}

// ─── Test matrix ──────────────────────────────────────────────────────────

const SIZES = [0, 1, 2, 3, 7, 51, 52, 200, 5000, 20000];
const TIME_KINDS = ['numeric', 'datetime', 'index'];

for (const n of SIZES) {
    const values = makeSignal(n, 4242 + n, { plateaus: n > 200 });

    for (const kind of TIME_KINDS) {
        const time = makeTime(n, kind);
        for (const method of ['centered', 'forward', 'backward', 'difference']) {
            const got = computeDerivative(values, time, { method });
            const want = refDerivative(values, time, { method });
            assertBitEqual(got.values, want.values, `derivative n=${n} ${kind}/${method}`);
        }
        for (const method of ['trapezoidal', 'rectangular']) {
            const got = computeIntegral(values, time, { method });
            const want = refIntegral(values, time, { method });
            assertBitEqual(got.values, want.values, `integral n=${n} ${kind}/${method}`);
            assert.equal(got.negativeDtCount, want.negativeDtCount, `integral n=${n} ${kind}/${method}: negativeDtCount`);
        }
    }

    for (const window of [2, 3, 21, 50, 51, 1000]) {
        const got = computeMovingAverage(values, { window });
        const want = refMovingAverage(values, { window });
        assertBitEqual(got, want, `movingAverage n=${n} w=${window}`);
    }

    for (const sensitivity of [1, 3, 6, 9, 10]) {
        const got = detectOutlierIndexes(values, 'spike', { sensitivity });
        const want = refDetectOutlierIndexes(values, 'spike', { sensitivity });
        assertIndexesEqual(got, want, `spike n=${n} s=${sensitivity}`);

        assertBitEqual(
            replaceOutliersWithNaN(values, got),
            refReplaceWithNaN(values, want),
            `spike/nan n=${n} s=${sensitivity}`,
        );
        assertBitEqual(
            interpolateOutliers(values, got),
            refInterpolate(values, want),
            `spike/interp n=${n} s=${sensitivity}`,
        );
    }

    for (const factor of [0.5, 1.5, 3]) {
        if (n < 4) continue;
        const got = detectOutlierIndexes(values, 'iqr', { factor });
        const want = refDetectOutlierIndexes(values, 'iqr', { factor });
        assertIndexesEqual(got, want, `iqr n=${n} f=${factor}`);
    }

    for (const bounds of [{ lower: -50 }, { upper: 50 }, { lower: -30, upper: 30 }]) {
        const got = detectOutlierIndexes(values, 'bounds', bounds);
        const want = refDetectOutlierIndexes(values, 'bounds', bounds);
        assertIndexesEqual(got, want, `bounds n=${n} ${JSON.stringify(bounds)}`);
    }
}

// Degenerate inputs the sliding window has to survive.
{
    const flat = new Float64Array(500).fill(7);
    assertIndexesEqual(
        detectOutlierIndexes(flat, 'spike', { sensitivity: 6 }),
        refDetectOutlierIndexes(flat, 'spike', { sensitivity: 6 }),
        'spike constant signal',
    );

    const allNaN = new Float64Array(300).fill(NaN);
    assertIndexesEqual(
        detectOutlierIndexes(allNaN, 'spike', { sensitivity: 6 }),
        refDetectOutlierIndexes(allNaN, 'spike', { sensitivity: 6 }),
        'spike all-NaN signal',
    );

    // Heavy duplicates stress the sorted-window remove path (equal keys).
    const dup = new Float64Array(2000);
    for (let i = 0; i < dup.length; i++) dup[i] = Math.round(Math.sin(i * 0.05) * 3);
    dup[1000] = 999;
    assertIndexesEqual(
        detectOutlierIndexes(dup, 'spike', { sensitivity: 6 }),
        refDetectOutlierIndexes(dup, 'spike', { sensitivity: 6 }),
        'spike duplicate-heavy signal',
    );

    // Signed zero must survive the sorted window untouched.
    const zeros = new Float64Array(200);
    for (let i = 0; i < zeros.length; i++) zeros[i] = i % 2 === 0 ? 0 : -0;
    zeros[100] = 5;
    assertIndexesEqual(
        detectOutlierIndexes(zeros, 'spike', { sensitivity: 6 }),
        refDetectOutlierIndexes(zeros, 'spike', { sensitivity: 6 }),
        'spike signed-zero signal',
    );
}

// Error codes must survive the move off i18n strings.
{
    assert.throws(() => detectOutlierIndexes(new Float64Array(10), 'bounds', {}), /outlierBoundsMissing/);
    assert.throws(() => detectOutlierIndexes(new Float64Array(10), 'bounds', { lower: 5, upper: 1 }), /outlierBoundsInvalid/);
    assert.throws(() => detectOutlierIndexes(new Float64Array(2), 'iqr', {}), /outlierNotEnoughData/);
    checks += 3;
}

console.log(`compute kernels: ${checks} bit-exact comparisons passed`);
