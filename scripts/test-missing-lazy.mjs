// Unit tests for the pure lazy Missing/NaN SQL builder + bucket reducer.
import assert from 'node:assert/strict';
import { buildMissingBucketsSql, missingBucketsToIntervals } from '../src/data/missing-buckets-sql.js';

const lit = (v) => (Number.isFinite(v) ? String(v) : 'NULL');

// ── buildMissingBucketsSql: structure ──
{
    const sql = buildMissingBucketsSql(
        'epoch_ms("ts")::DOUBLE', 'tbl',
        ['try_cast(("a") AS DOUBLE)', 'try_cast(("b") AS DOUBLE)'],
        lit, 100, 200, 8, false);
    assert.match(sql, /FROM tbl/, 'reads the file table');
    assert.match(sql, /COUNT\(\*\)::BIGINT AS n_total/, 'counts rows per bucket');
    assert.match(sql, /SUM\(CASE WHEN miss THEN 1 ELSE 0 END\)::BIGINT AS n_missing/, 'counts missing per bucket');
    assert.match(sql, /GROUP BY b/, 'groups by bucket');
    // union of non-finite predicates across variables
    assert.match(sql, /try_cast\(\("a"\) AS DOUBLE\) IS NULL OR isnan\(try_cast\(\("a"\) AS DOUBLE\)\) OR isinf/, 'a non-finite predicate');
    assert.match(sql, / OR .*try_cast\(\("b"\) AS DOUBLE\) IS NULL/, 'union across b');
    // non-windowed time filters inside the CTE
    assert.match(sql, /FROM tbl\s*\n\s*WHERE epoch_ms\("ts"\)::DOUBLE BETWEEN 100 AND 200/, 'filters in the CTE for a plain time expr');
}

// windowed time (generated index) must NOT filter inside the CTE (window in WHERE is illegal)
{
    const sql = buildMissingBucketsSql(
        '(ROW_NUMBER() OVER () - 1)::DOUBLE', 'tbl', ['try_cast(("a") AS DOUBLE)'], lit, 0, 10, 4, true);
    assert.ok(!/FROM tbl\s*\n\s*WHERE/.test(sql), 'no WHERE inside the CTE for a windowed time expr');
    assert.match(sql, /FROM v\s*\n\s*WHERE t BETWEEN 0 AND 10/, 'filters on the computed t in the outer query');
}

// no variables → miss is always FALSE (only sampling gaps can show)
{
    const sql = buildMissingBucketsSql('t', 'tbl', [], lit, 0, 1, 2, false);
    assert.match(sql, /\(FALSE\) AS miss/, 'empty var list yields FALSE miss');
}

// ── missingBucketsToIntervals ──
const opts = (extra = {}) => ({ t0: 0, t1: 1000, nBuckets: 10, fileId: 'f', timeVar: null, ...extra });

// Clean: every bucket has rows, none missing → nothing.
{
    const buckets = Array.from({ length: 10 }, (_, b) => ({ b, nTotal: 100, nMissing: 0 }));
    const r = missingBucketsToIntervals(buckets, opts());
    assert.equal(r.intervals.length, 0, 'clean data → no intervals');
    assert.equal(r.dense, false, 'clean → not dense');
    assert.equal(r.coverage, 0, 'clean → zero coverage');
}

// Uniform scatter: every bucket partly missing → one interval, full coverage, dense.
{
    const buckets = Array.from({ length: 10 }, (_, b) => ({ b, nTotal: 100, nMissing: 6 }));
    const r = missingBucketsToIntervals(buckets, opts());
    assert.equal(r.intervals.length, 1, 'scatter coalesces to one interval');
    assert.deepEqual([r.intervals[0].t0, r.intervals[0].t1], [0, 1000], 'covering the whole view');
    assert.equal(r.partialCount, 10, 'all buckets are partial');
    assert.equal(r.coverage, 1, 'coverage is 1');
    assert.equal(r.dense, true, 'uniform scatter is dense');
    assert.equal(r.intervals[0].fileId, 'f', 'carries fileId for per-file grouping');
}

// Blocks: two fully-missing buckets (2,3) and one fully-missing (7) → two intervals,
// NOT dense (no partial buckets).
{
    const buckets = Array.from({ length: 10 }, (_, b) => ({ b, nTotal: 100, nMissing: (b === 2 || b === 3 || b === 7) ? 100 : 0 }));
    const r = missingBucketsToIntervals(buckets, opts());
    assert.equal(r.intervals.length, 2, 'adjacent full buckets coalesce; the lone one is separate');
    assert.deepEqual([r.intervals[0].t0, r.intervals[0].t1], [200, 400], 'first block spans buckets 2-3');
    assert.deepEqual([r.intervals[1].t0, r.intervals[1].t1], [700, 800], 'second block is bucket 7');
    assert.equal(r.partialCount, 0, 'fully-missing blocks are not partial');
    assert.equal(r.dense, false, 'resolvable blocks are not dense');
}

// Time gap: an ABSENT interior bucket (5) is a gap; absent edge buckets are outside data.
{
    const buckets = [];
    for (let b = 1; b <= 8; b++) if (b !== 5) buckets.push({ b, nTotal: 100, nMissing: 0 }); // 0 and 9 absent (edges), 5 absent (gap)
    const r = missingBucketsToIntervals(buckets, opts());
    assert.equal(r.intervals.length, 1, 'only the interior empty bucket is a gap');
    assert.deepEqual([r.intervals[0].t0, r.intervals[0].t1], [500, 600], 'gap spans the empty interior bucket');
    assert.equal(r.missingBuckets, 1, 'edge-absent buckets (outside data) are not missing');
}

// Empty input / zero span are safe.
{
    assert.equal(missingBucketsToIntervals([], opts()).intervals.length, 0, 'no buckets → nothing');
    assert.equal(missingBucketsToIntervals([{ b: 0, nTotal: 1, nMissing: 1 }], opts({ t0: 5, t1: 5 })).intervals.length, 0, 'zero span → nothing');
}

console.log('Lazy missing-data (buckets) tests passed');
