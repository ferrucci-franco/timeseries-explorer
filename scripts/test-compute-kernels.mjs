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
            // The integral gained a gap policy, so the pre-policy behaviour is
            // no longer the DEFAULT — it is one reachable configuration:
            // gapPolicy 'zero' (a non-finite segment adds nothing, as before)
            // with detectGaps off (a missing row is not identified, so the
            // quadrature runs straight across it, as before). Pinning that
            // combination keeps the old code verifiable bit-for-bit while the
            // default is free to be the corrected one.
            const legacy = { method, gapPolicy: 'zero', detectGaps: false };
            const got = computeIntegral(values, time, legacy);
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

// ─── Integral gap policy ──────────────────────────────────────────────────
// Behavioural, not differential: this is the part that deliberately no longer
// matches the legacy reference. Signal and expected numbers mirror
// test-files/csv/integral-missing/, where they are derived by hand.
//
// Triangular power pulse, breakpoints at 1800/2700/3600 s, sampled every 60 s.
// The trapezoidal rule is EXACT on the complete data, so the reference is
// 54000 exactly and any deviation is the policy, not discretisation.
{
    const triangle = (t) => {
        if (t <= 1800 || t >= 3600) return 0;
        if (t <= 2700) return (t - 1800) / 15;
        return (3600 - t) / 15;
    };
    const seconds = [];
    for (let t = 0; t <= 7200; t += 60) seconds.push(t);
    const numericTime = (list) => ({ values: list, kind: 'numeric' });

    const full = { time: numericTime(seconds), values: seconds.map(triangle) };
    // The same physical hole, 2040..3360 s, written the two ways a file can
    // express it: the rows are gone, or the rows are there with empty cells.
    const absentRows = seconds.filter(t => t <= 2040 || t >= 3360);
    const missingRows = { time: numericTime(absentRows), values: absentRows.map(triangle) };
    const missingValues = {
        time: numericTime(seconds),
        values: seconds.map(t => (t > 2040 && t < 3360 ? NaN : triangle(t))),
    };
    const total = (input, params) => {
        const r = computeIntegral(input.values, input.time, params);
        return r.values[r.values.length - 1];
    };

    // Complete data: every policy agrees, and agrees with the exact answer.
    for (const gapPolicy of ['zero', 'interpolate', 'propagate']) {
        assert.equal(total(full, { gapPolicy }), 54000, `complete data is exact under ${gapPolicy}`);
    }

    // THE regression. Before the policy existed these two returned 24960 and
    // 3840 — the same hole, a 6.5x difference, decided by how the file happened
    // to spell it. Every policy must now give one answer for both.
    const expected = { zero: 3840, interpolate: 24960 };
    for (const [gapPolicy, want] of Object.entries(expected)) {
        assert.equal(total(missingRows, { gapPolicy }), want, `missing rows, ${gapPolicy}`);
        assert.equal(total(missingValues, { gapPolicy }), want, `empty cells, ${gapPolicy}`);
    }
    assert.ok(Number.isNaN(total(missingRows, { gapPolicy: 'propagate' })), 'missing rows, propagate');
    assert.ok(Number.isNaN(total(missingValues, { gapPolicy: 'propagate' })), 'empty cells, propagate');
    checks += 8;

    // 'zero' is the default: the corrected behaviour is what you get without
    // asking, and it is the one that leaves a visible plateau in the curve.
    assert.equal(total(missingRows, {}), 3840, 'zero is the default policy');

    // 'propagate' blanks everything AFTER the hole, not just the hole: the
    // cumulative value past an unknown increment is unknown too.
    {
        const r = computeIntegral(missingRows.values, missingRows.time, { gapPolicy: 'propagate' });
        const firstNaN = r.values.findIndex(Number.isNaN);
        assert.ok(firstNaN > 0, 'values before the hole survive');
        assert.ok(r.values.slice(0, firstNaN).every(Number.isFinite), 'and are all finite');
        assert.ok(r.values.slice(firstNaN).every(Number.isNaN), 'nothing after the hole is finite');
    }

    // 'zero' keeps the curve finite and flat across the hole — the plateau is
    // what makes the loss visible without reading any warning.
    {
        const r = computeIntegral(missingValues.values, missingValues.time, { gapPolicy: 'zero' });
        assert.ok(r.values.every(Number.isFinite), 'zero never produces NaN');
        const inHole = seconds.map((t, i) => ({ t, i })).filter(({ t }) => t > 2100 && t < 3300);
        const level = r.values[inHole[0].i];
        assert.ok(inHole.every(({ i }) => r.values[i] === level), 'the curve plateaus across the hole');
    }

    // Diagnostics: both spellings report the hole, each in its own currency.
    {
        const byRow = computeIntegral(missingRows.values, missingRows.time, {});
        const byCell = computeIntegral(missingValues.values, missingValues.time, {});
        assert.equal(byRow.gapCount, 1, 'the absent rows are reported as one gap');
        assert.equal(byRow.nanSegmentCount, 0, 'and not as NaN segments');
        assert.equal(byCell.gapCount, 0, 'empty cells leave the time axis intact');
        assert.ok(byCell.nanSegmentCount > 0, 'and are reported as NaN segments');
        assert.equal(byRow.uncoveredTime, 1320, 'the uncovered span is reported in dt units');
        assert.equal(byRow.hasNominalStep, true, 'the axis has a nominal step');
        assert.equal(byRow.timeKind, 'numeric', 'the axis kind travels with it, to give it a unit');
    }

    // How much of the span has no data is a property of the FILE, so it must not
    // move with the policy — otherwise the same file reports 22 minutes missing
    // under one choice and none under another. It read 0 under 'interpolate'
    // until the count was taken from the source instead of the bridged values.
    {
        for (const input of [missingRows, missingValues]) {
            const seen = ['zero', 'interpolate', 'propagate']
                .map(gapPolicy => computeIntegral(input.values, input.time, { gapPolicy }).uncoveredTime);
            assert.deepEqual(seen, [1320, 1320, 1320],
                'the uncovered span is the same under every policy');
        }
    }

    // Genuinely irregular sampling: no nominal step, so nothing is called a gap
    // and the quadrature runs over the real deltas — the same rule the
    // Missing/NaN overlay follows, so the two features cannot disagree.
    {
        const irregular = [0, 300, 900, 1500, 1800, 1830, 1860, 2100, 2400, 2700,
            3000, 3300, 3540, 3600, 3900, 4200, 5400, 6600, 7200];
        const input = { time: numericTime(irregular), values: irregular.map(triangle) };
        const r = computeIntegral(input.values, input.time, {});
        assert.equal(r.hasNominalStep, false, 'irregular sampling has no nominal step');
        assert.equal(r.gapCount, 0, 'so no interval is called a gap');
        assert.equal(r.values[r.values.length - 1], 54000, 'and the trapezoid answer stands');
    }

    // An index axis carries no timestamps, so a missing row is undetectable —
    // reported as "no nominal step", not as "no gaps found".
    {
        const r = computeIntegral(absentRows.map(triangle), { values: null, kind: 'index' }, {});
        assert.equal(r.hasNominalStep, false, 'an index axis cannot be judged');
        assert.equal(r.gapCount, 0, 'and nothing is claimed about it');
    }
    checks += 4;
}

console.log(`compute kernels: ${checks} bit-exact comparisons passed`);
