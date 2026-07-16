import assert from 'node:assert/strict';
import {
    pearsonCorrelation,
    groupDropIntoPairs,
    CORRELATION_MANY_PAIRS_WARNING,
    CORRELATION_MAX_PAIRS,
} from '../src/utils/correlation.js';

const close = (actual, expected, tolerance, label) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`,
    );
};

// ── Perfect correlations ──
{
    const x = [1, 2, 3, 4, 5];
    const yPos = [2, 4, 6, 8, 10];   // y = 2x  → r = +1
    const yNeg = [10, 8, 6, 4, 2];   // y = -2x + c → r = -1
    const rPos = pearsonCorrelation(x, yPos);
    const rNeg = pearsonCorrelation(x, yNeg);
    assert.equal(rPos.status, 'ok', '+1 case is defined');
    close(rPos.r, 1, 1e-12, 'perfect positive r');
    close(rPos.r2, 1, 1e-12, 'perfect positive r2');
    assert.equal(rPos.n, 5, 'perfect positive n');
    assert.equal(rPos.nExcluded, 0, 'perfect positive nExcluded');
    close(rNeg.r, -1, 1e-12, 'perfect negative r');
    close(rNeg.r2, 1, 1e-12, 'perfect negative r2');
}

// ── Hand-computed reference (proves exactness, not just self-consistency) ──
// x=[1..5], y=[2,1,4,3,6]: Σdx·dy = 10, Σdx² = 10, Σdy² = 14.8
// r = 10/sqrt(148) = 0.8219949365267865 ; r² = 100/148 = 0.6756756756...
{
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 6]);
    close(r.r, 10 / Math.sqrt(148), 1e-12, 'reference r');
    close(r.r2, 100 / 148, 1e-12, 'reference r2');
    close(r.meanX, 3, 1e-12, 'reference meanX');
    close(r.meanY, 3.2, 1e-12, 'reference meanY');
}

// ── Zero correlation, still defined ──
{
    // meanX=meanY=0, Σdx·dy = -2+1-1+2 = 0 → r = 0 with variance > 0
    const r = pearsonCorrelation([-2, -1, 1, 2], [1, -1, -1, 1]);
    assert.equal(r.status, 'ok', 'r≈0 case is defined');
    close(r.r, 0, 1e-12, 'zero correlation r');
}

// ── Same variable ──
{
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    assert.equal(r.status, 'ok', 'X=Y defined when variance > 0');
    close(r.r, 1, 1e-12, 'X=Y gives r=1');
}

// ── Constants → undefined (never coerced to 0) ──
{
    const xConst = pearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4]);
    const yConst = pearsonCorrelation([1, 2, 3, 4], [7, 7, 7, 7]);
    const both = pearsonCorrelation([3, 3, 3], [9, 9, 9]);
    for (const [label, res] of [['X const', xConst], ['Y const', yConst], ['both const', both]]) {
        assert.equal(res.status, 'undefined', `${label} → undefined`);
        assert.ok(Number.isNaN(res.r), `${label} → r is NaN, not 0`);
        assert.ok(Number.isNaN(res.r2), `${label} → r2 is NaN`);
    }
}

// ── n = 0 and n = 1 → undefined ──
{
    const empty = pearsonCorrelation([], []);
    assert.equal(empty.status, 'undefined', 'empty → undefined');
    assert.equal(empty.n, 0, 'empty n = 0');
    const one = pearsonCorrelation([3], [7]);
    assert.equal(one.status, 'undefined', 'single row → undefined');
    assert.equal(one.n, 1, 'single row n = 1');
}

// ── Pairwise deletion of NaN / ±Infinity on either side ──
{
    const x = [1, 2, NaN, 4, 5];
    const y = [2, 4, 6, Infinity, 10];
    const r = pearsonCorrelation(x, y);
    // Valid rows: i=0,1,4 → x=[1,2,5], y=[2,4,10] (y = 2x) → r = 1, n = 3, 2 excluded
    assert.equal(r.n, 3, 'pairwise: valid rows counted');
    assert.equal(r.nExcluded, 2, 'pairwise: invalid rows excluded');
    close(r.r, 1, 1e-12, 'pairwise: r over surviving rows');
    // null and -Infinity are also treated as missing.
    const r2 = pearsonCorrelation([1, null, 3], [1, 2, -Infinity]);
    assert.equal(r2.nExcluded, 2, 'null and -Infinity both excluded');
    assert.equal(r2.status, 'undefined', 'only one valid row → undefined');
}

// ── Large-offset numerical stability ──
{
    // Naive Σx·Σy sums would lose precision here; Welford stays exact.
    const x = [1e9 + 1, 1e9 + 2, 1e9 + 3, 1e9 + 4, 1e9 + 5];
    const y = [1, 2, 3, 4, 5]; // linear in x → r = 1
    const r = pearsonCorrelation(x, y);
    close(r.r, 1, 1e-9, 'large-offset r stays ~1');
}

// ── Boolean 0/1 series ──
{
    const same = pearsonCorrelation([0, 1, 0, 1, 1], [0, 1, 0, 1, 1]);
    close(same.r, 1, 1e-12, 'identical booleans → r=1');
    const opposite = pearsonCorrelation([0, 1, 0, 1], [1, 0, 1, 0]);
    close(opposite.r, -1, 1e-12, 'opposite booleans → r=-1');
}

// ── Gain applied upstream: negative gain flips the sign, positive keeps r ──
{
    const x = [1, 2, 3, 4, 5];
    const y = [2, 1, 4, 3, 6];
    const base = pearsonCorrelation(x, y);
    const negY = pearsonCorrelation(x, y.map(v => -3 * v));   // negative gain
    const posY = pearsonCorrelation(x, y.map(v => 10 * v + 100)); // positive gain + offset
    close(negY.r, -base.r, 1e-12, 'negative gain flips sign');
    close(posY.r, base.r, 1e-12, 'positive gain + offset preserves r');
}

// ── Length mismatch → aligned intersection, no crash ──
{
    const r = pearsonCorrelation([1, 2, 3, 4, 5, 6], [2, 4, 6]);
    assert.equal(r.n, 3, 'mismatch: only aligned rows used');
    assert.equal(r.nExcluded, 0, 'mismatch: extra rows are not "excluded"');
    close(r.r, 1, 1e-12, 'mismatch: r over the intersection');
}

// ── Reported std (sample) ──
{
    const r = pearsonCorrelation([2, 4, 4, 4, 5, 5, 7, 9], [1, 1, 1, 1, 1, 1, 1, 2]);
    // stdX of [2,4,4,4,5,5,7,9] sample = 2.138089935...
    close(r.stdX, 2.138089935299395, 1e-9, 'sample stdX');
}

// ── groupDropIntoPairs: two-by-two, odd leftover, pending completion ──
{
    const even = groupDropIntoPairs(['a', 'b', 'c', 'd']);
    assert.deepEqual(even.pairs, [['a', 'b'], ['c', 'd']], 'even drop → two pairs');
    assert.equal(even.pendingX, null, 'even drop → no pending');

    const odd = groupDropIntoPairs(['a', 'b', 'c']);
    assert.deepEqual(odd.pairs, [['a', 'b']], 'odd drop → one pair');
    assert.equal(odd.pendingX, 'c', 'odd drop → last is pending X');

    const completePending = groupDropIntoPairs(['b'], 'a');
    assert.deepEqual(completePending.pairs, [['a', 'b']], 'pending X is completed first');
    assert.equal(completePending.pendingX, null, 'pending consumed');

    const pendingPlusOdd = groupDropIntoPairs(['b', 'c', 'd'], 'a');
    assert.deepEqual(pendingPlusOdd.pairs, [['a', 'b'], ['c', 'd']], 'pending + drops group two-by-two');
    assert.equal(pendingPlusOdd.pendingX, null, 'even total → no pending');

    const single = groupDropIntoPairs(['a']);
    assert.deepEqual(single.pairs, [], 'single drop → no pair yet');
    assert.equal(single.pendingX, 'a', 'single drop → pending X');

    const noneKeepsPending = groupDropIntoPairs([], 'a');
    assert.equal(noneKeepsPending.pendingX, 'a', 'empty drop keeps existing pending');
    assert.deepEqual(noneKeepsPending.pairs, [], 'empty drop makes no pair');
}

// ── Guardrail constants exist and are ordered ──
{
    assert.ok(CORRELATION_MANY_PAIRS_WARNING < CORRELATION_MAX_PAIRS, 'warning threshold below hard max');
    assert.equal(CORRELATION_MAX_PAIRS, 64, 'hard max pairs = 64');
}

console.log('Correlation tests passed');
