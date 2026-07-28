// Unit tests for the pure lazy Missing/NaN SQL builder + bucket reducer, plus
// the min/max-envelope gap-break helpers extracted from interaction-methods.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import duckdbPkg from 'duckdb';
import { closeDuckDbConnection, closeDuckDbDatabase, runDuckDb } from '../src/data/csv-to-parquet-core.js';
import { buildMissingBucketsSql, missingBucketsToIntervals } from '../src/data/missing-buckets-sql.js';
import { detectNaNRuns, detectSamplingGaps } from '../src/utils/sampling-gaps.js';

const lit = (v) => (Number.isFinite(v) ? String(v) : 'NULL');

// Extract two pure prototype methods (no `this` use) and run them on a mock.
const interactionSrc = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
const extract = (name) => {
    const marker = `proto.${name} = function`;
    const start = interactionSrc.indexOf(marker);
    assert.ok(start >= 0, `${name} present`);
    const next = interactionSrc.indexOf('\nproto.', start + marker.length);
    return interactionSrc.slice(start, next >= 0 ? next : interactionSrc.length);
};
const gapBox = { proto: {} };
vm.runInNewContext([extract('_lazyGapBreakIndices'), extract('_insertTraceGapBreaks')].join('\n'), gapBox);
const gaps = gapBox.proto;
const plain = (v) => JSON.parse(JSON.stringify(v)); // re-home cross-realm arrays

// ── _lazyGapBreakIndices ──
{
    // Uniform min/max envelope (2 pts per bucket, no hole) → no breaks.
    const x = [];
    for (let b = 0; b < 20; b++) { x.push(b * 10, b * 10 + 9); }
    assert.deepEqual(plain(gaps._lazyGapBreakIndices(x)), [], 'a uniform envelope has no gap breaks');

    // Insert a big hole between index 9 and 10.
    const g = x.slice();
    for (let i = 10; i < g.length; i++) g[i] += 5000; // shove the tail far right
    const idx = plain(gaps._lazyGapBreakIndices(g));
    assert.ok(idx.includes(9), 'the large jump is flagged as a break after index 9');
    assert.equal(idx.length, 1, 'only the real hole breaks');

    assert.deepEqual(plain(gaps._lazyGapBreakIndices([0, 1, 2])), [], 'too few points → no breaks');
}

// ── _insertTraceGapBreaks ──
{
    const out = gaps._insertTraceGapBreaks([0, 1, 2, 3], [10, 20, 30, 40], undefined, [1]);
    assert.deepEqual(plain(out.x), [0, 1, 1, 2, 3], 'x duplicated at the break');
    assert.equal(out.y.length, 5, 'one NaN point inserted');
    assert.ok(Number.isNaN(out.y[2]), 'the inserted y is NaN so the line cuts');
    assert.deepEqual([...out.y].filter(v => !Number.isNaN(v)), [10, 20, 30, 40], 'real samples preserved');
    assert.equal(out.customdata, undefined, 'no customdata stays undefined');

    const cd = gaps._insertTraceGapBreaks([0, 1], [1, 2], ['a', 'b'], [0]);
    assert.deepEqual(plain(cd.customdata), ['a', null, 'b'], 'customdata gets a null at the break');
}

// ── buildMissingBucketsSql: structure ──
{
    const sql = buildMissingBucketsSql(
        'epoch_ms("ts")::DOUBLE', 'tbl',
        ['try_cast(("a") AS DOUBLE)', 'try_cast(("b") AS DOUBLE)'],
        lit, 100, 200, 8, false);
    assert.match(sql, /FROM tbl/, 'reads the file table');
    assert.match(sql, /COUNT\(\*\)::BIGINT AS n_total/, 'counts rows per bucket');
    assert.match(sql, /SUM\(CASE WHEN miss THEN 1 ELSE 0 END\)::BIGINT AS n_missing/, 'counts missing per bucket');
    assert.match(sql, /MIN\(t\)::DOUBLE AS t_min/, 'keeps the first observed timestamp per bucket');
    assert.match(sql, /MAX\(t\)::DOUBLE AS t_max/, 'keeps the last observed timestamp per bucket');
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
    assert.equal(r.solidIntervals.length, 0, 'scattered (partial) buckets are never solid');
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
    assert.deepEqual(r.solidIntervals.map(i => [i.t0, i.t1]), [[200, 400], [700, 800]], 'full blocks are solid intervals');
}

// A block that is dense elsewhere: a fully-missing bucket surrounded by partial
// buckets is still its own SOLID interval (always painted), while the partials
// make the view dense (wash / pill).
{
    const buckets = Array.from({ length: 10 }, (_, b) => ({ b, nTotal: 100, nMissing: b === 5 ? 100 : 40 }));
    const r = missingBucketsToIntervals(buckets, opts());
    assert.equal(r.dense, true, 'the surrounding partial buckets make it dense');
    assert.deepEqual(r.solidIntervals.map(i => [i.t0, i.t1]), [[500, 600]], 'the fully-missing bucket is a solid interval');
    assert.equal(r.intervals.length, 1, 'the any-missing extent coalesces to one interval');
}

// Time gap: observed timestamp distances identify the gap. Empty pixel buckets
// caused by oversampling are not gaps by themselves.
{
    const buckets = [
        { b: 0, nTotal: 1, nMissing: 0, tMin: 0, tMax: 0 },
        { b: 2, nTotal: 1, nMissing: 0, tMin: 100, tMax: 100 },
        { b: 4, nTotal: 1, nMissing: 0, tMin: 200, tMax: 200 },
        // One expected timestamp at 300 is absent.
        { b: 8, nTotal: 1, nMissing: 0, tMin: 400, tMax: 400 },
        { b: 9, nTotal: 1, nMissing: 0, tMin: 500, tMax: 500 },
    ];
    const r = missingBucketsToIntervals(buckets, opts());
    assert.equal(r.intervals.length, 1, 'only the excessive observed timestamp distance is a gap');
    assert.deepEqual([r.intervals[0].t0, r.intervals[0].t1], [200, 400], 'gap is bounded by the real adjacent samples');
    assert.equal(r.missingBuckets, 0, 'ordinary empty pixel buckets are never counted as missing samples');
    assert.deepEqual(r.solidIntervals.map(i => [i.t0, i.t1]), [[200, 400]], 'a time gap is a solid interval');
}

// The nominal-step gate, mirrored from the eager detector so the same file is
// judged the same way in memory and in DuckDB. Aperiodic sample distances make
// the median meaningless, so no sampling gap may be claimed from it.
{
    const times = [0, 30, 33, 36, 90, 200, 210, 400, 405, 500, 700, 705, 900, 902, 903];
    const buckets = times.map((t, i) => ({ b: i, nTotal: 1, nMissing: 0, tMin: t, tMax: t }));
    const r = missingBucketsToIntervals(buckets, { t0: 0, t1: 1000, nBuckets: times.length });
    assert.equal(r.hasNominalStep, false, 'aperiodic distances yield no nominal step');
    assert.ok(r.stepAgreement < 0.8, 'the agreement statistic is what rejects it');
    assert.deepEqual(r.intervals, [], 'and no sampling gaps are invented from it');
}

// NaN blocks are a fact about the VALUES, so they stay banded even when the
// time axis has no nominal step.
{
    const times = [0, 30, 33, 36, 90, 200, 210, 400, 405, 500, 700, 705, 900, 902, 903];
    const buckets = times.map((t, i) => ({ b: i, nTotal: 1, nMissing: i === 6 ? 1 : 0, tMin: t, tMax: t }));
    const r = missingBucketsToIntervals(buckets, { t0: 0, t1: 1000, nBuckets: times.length });
    assert.equal(r.hasNominalStep, false, 'still no nominal step');
    assert.equal(r.missingBuckets, 1, 'the invalid bucket is counted');
    assert.ok(r.solidIntervals.length >= 1, 'and it is still painted as missing data');
}

// Oversampled view: consecutive invalid samples can occupy separated pixel
// buckets. Timestamp extents must join them into the same NaN run.
{
    const buckets = [
        { b: 0, nTotal: 1, nMissing: 0, tMin: 0, tMax: 0 },
        { b: 2, nTotal: 1, nMissing: 1, tMin: 100, tMax: 100 },
        { b: 4, nTotal: 1, nMissing: 1, tMin: 200, tMax: 200 },
        { b: 6, nTotal: 1, nMissing: 1, tMin: 300, tMax: 300 },
        { b: 8, nTotal: 1, nMissing: 0, tMin: 400, tMax: 400 },
    ];
    const r = missingBucketsToIntervals(buckets, opts());
    assert.deepEqual(r.solidIntervals.map(i => [i.t0, i.t1]), [[0, 400]], 'adjacent invalid samples form one eager-style run');
}

// A row deficit inside a populated coarse bucket remains detectable when the
// viewport is too wide to place each sample in its own bucket.
{
    const buckets = [
        { b: 0, nTotal: 4, nMissing: 0, tMin: 0, tMax: 300 },
        // Five timestamps would span 400..800; 600 is omitted (4 rows remain).
        { b: 1, nTotal: 4, nMissing: 0, tMin: 400, tMax: 800 },
        { b: 2, nTotal: 4, nMissing: 0, tMin: 900, tMax: 1200 },
    ];
    const r = missingBucketsToIntervals(buckets, opts({ t0: 0, t1: 1500, nBuckets: 3 }));
    assert.deepEqual(r.solidIntervals.map(i => [i.t0, i.t1]), [[500, 1000]], 'coarse bucket with a row deficit is marked');
}

// Empty input / zero span are safe.
{
    assert.equal(missingBucketsToIntervals([], opts()).intervals.length, 0, 'no buckets → nothing');
    assert.equal(missingBucketsToIntervals([{ b: 0, nTotal: 1, nMissing: 1 }], opts({ t0: 5, t1: 5 })).intervals.length, 0, 'zero span → nothing');
}

// Bucket boundaries must use the same source -> display mapping as plotted
// samples (FFT and timeseries). A scale+shift makes accidental viewport-based
// mapping obvious and also verifies interval ordering.
{
    const buckets = Array.from({ length: 10 }, (_, b) => ({
        b,
        nTotal: 10,
        nMissing: b === 2 ? 10 : 0,
    }));
    const r = missingBucketsToIntervals(buckets, opts({
        t0: 100,
        t1: 200,
        mapTime: source => 5000 - source * 2,
    }));
    assert.deepEqual(
        r.intervals.map(interval => [interval.t0, interval.t1]),
        [[4740, 4760]],
        'source bucket boundaries are mapped and normalized in display units',
    );
    assert.deepEqual(
        r.solidIntervals.map(interval => [interval.t0, interval.t1]),
        [[4740, 4760]],
        'solid intervals use the identical source/display mapping',
    );
}

// Extract the lazy refresh coordinator and prove that a newer viewport aborts
// the previous request rather than leaving a stale full-file scan queued.
{
    const coordinatorBox = {
        proto: {},
        AbortController,
        missingBucketsToIntervals,
        Plotly: { relayout: () => Promise.resolve() },
        console,
    };
    vm.runInNewContext([
        extract('_cancelLazyMissingRequest'),
        extract('_refreshLazyMissingBands'),
    ].join('\n'), coordinatorBox);

    const calls = [];
    const source = {
        getMissingIntervals(_data, _vars, _lo, _hi, _n, { signal }) {
            return new Promise((resolve, reject) => {
                const call = { signal, resolve, reject };
                calls.push(call);
                signal.addEventListener('abort', () => {
                    const err = new Error('cancelled');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            });
        },
    };
    const data = {
        _duckdb: { source, viewMode: true, totalRows: 100 },
        metadata: { timeStart: 0, timeEnd: 100 },
    };
    const div = { _fullLayout: { xaxis: { _length: 100 } } };
    const plot = {
        div,
        mode: 'timeseries',
        showMissingData: true,
        traces: [{ fileId: 'f', varName: 'v' }],
    };
    const manager = {
        ...coordinatorBox.proto,
        files: new Map([['f', { data }]]),
        _zoomTokens: new Map([['p', 1]]),
        _isVisible: () => true,
        _getTimeVar: () => ({ timeKind: 'datetime' }),
        _missingDataInfo: () => ({ bandItems: [], stepIssues: [] }),
        _missingViewIsDense: () => false,
        _missingStepNotice: () => null,
        _sourceRangeForDisplayRange: (_fid, range) => range,
        _lazyMissingBucketCount: () => 10,
        _displayTimeForFetchedSourceTime: (_fid, value) => value,
        _lazyMissingShapes: () => [],
        _setMissingDensityNotice: () => {},
    };

    const first = manager._refreshLazyMissingBands('p', plot, 0, 100, 1);
    assert.equal(calls.length, 1, 'first viewport starts one missing query');
    manager._zoomTokens.set('p', 2);
    const second = manager._refreshLazyMissingBands('p', plot, 10, 90, 2);
    assert.equal(calls.length, 2, 'new viewport starts one replacement query');
    assert.equal(calls[0].signal.aborted, true, 'new viewport aborts the stale query');
    calls[1].resolve({ buckets: Array.from({ length: 10 }, (_, b) => ({
        b,
        nTotal: 10,
        nMissing: 0,
        tMin: b * 8,
        tMax: b * 8 + 7,
    })) });
    await Promise.all([first, second]);
    assert.equal(manager._lazyMissingRequests.size, 0, 'latest request cleans up its ownership');
}

// ── Parity against the eager detector, over REAL DuckDB ──────────────────────
// Everything above feeds the reducer hand-written bucket rows, so the SQL that
// produces them in production was never executed. Here it is: same builder, a
// real in-memory DuckDB, and the rows it returns go into the same reducer the
// app uses. The assertions are that the lazy verdict matches the eager one —
// the two paths estimate the nominal step DIFFERENTLY (median of consecutive
// deltas vs median of within/cross-bucket distances), so agreement between them
// is a claim that has to be tested, not assumed.
{
    const { Database } = duckdbPkg;
    const db = new Database(':memory:');
    const connection = db.connect();
    const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

    // One bucket per sample (times 4) keeps the comparison meaningful: with
    // several samples sharing a bucket the reducer only sees their AVERAGE
    // spacing, which is a different measurement — see the divergence cases.
    const BUCKET_FACTOR = 4;

    async function lazyMissing(times, values, { bucketFactor = BUCKET_FACTOR } = {}) {
        await runDuckDb(connection, 'DROP TABLE IF EXISTS missing_data');
        await runDuckDb(connection, 'CREATE TABLE missing_data(ts TIMESTAMP, v DOUBLE)');
        const tuples = times.map((t, i) => {
            const value = Number.isNaN(values[i]) ? `'NaN'::DOUBLE` : String(values[i]);
            return `(TIMESTAMP '${iso(t)}', ${value})`;
        });
        await runDuckDb(connection, `INSERT INTO missing_data VALUES ${tuples.join(',')}`);

        const lo = Math.min(...times);
        const hi = Math.max(...times);
        const nBuckets = times.length * bucketFactor;
        const sql = buildMissingBucketsSql(
            'epoch_ms("ts")::DOUBLE',
            'missing_data',
            ['try_cast("v" AS DOUBLE)'],
            lit,
            lo,
            hi,
            nBuckets,
        );
        const rows = await runDuckDb(connection, sql);
        // The app reads these columns POSITIONALLY (duckdb-source.js extracts
        // index 0..4), so the order is part of the contract, not a detail.
        assert.deepEqual(
            Object.keys(rows[0]),
            ['b', 'n_total', 'n_missing', 't_min', 't_max'],
            'the SQL keeps the column order the app extracts by index',
        );
        const buckets = rows.map(r => ({
            b: Number(r.b),
            nTotal: Number(r.n_total),
            nMissing: Number(r.n_missing),
            tMin: Number(r.t_min),
            tMax: Number(r.t_max),
        }));
        return missingBucketsToIntervals(buckets, { t0: lo, t1: hi, nBuckets });
    }

    const covers = (intervals, t0, t1) =>
        intervals.some(i => i.t0 <= t0 + 1 && i.t1 >= t1 - 1);

    const minute = 60_000;
    const start = Date.parse('2024-06-01T00:00:00Z');
    const clean = (n) => Array.from({ length: n }, () => 1);

    try {
        // 1. Regular series with one dropped run: both paths find the same gap.
        {
            const times = [];
            for (let i = 0; i < 60; i++) {
                if (i >= 30 && i <= 38) continue; // 9 samples dropped
                times.push(start + i * minute);
            }
            const values = clean(times.length);
            const eager = detectSamplingGaps(times);
            const lazy = await lazyMissing(times, values);
            assert.equal(eager.hasNominalStep, true, 'eager: a dropped run keeps the nominal step');
            assert.equal(lazy.hasNominalStep, true, 'lazy: same verdict');
            assert.equal(eager.count, 1, 'eager finds exactly one gap');
            const gap = [start + 29 * minute, start + 39 * minute];
            assert.deepEqual([eager.gaps[0].t0, eager.gaps[0].t1], gap, 'eager bounds the gap by its real neighbours');
            assert.ok(covers(lazy.intervals, gap[0], gap[1]), 'lazy marks the same span');
        }

        // 2. Genuinely irregular sampling: neither path may claim a gap.
        {
            const offsets = [0, 300, 900, 1500, 1800, 1830, 1860, 2100, 2400, 2700,
                3000, 3300, 3540, 3600, 3900, 4200, 5400, 6600, 7200];
            const times = offsets.map(s => start + s * 1000);
            const eager = detectSamplingGaps(times);
            const lazy = await lazyMissing(times, clean(times.length));
            assert.equal(eager.hasNominalStep, false, 'eager: no nominal step');
            assert.equal(lazy.hasNominalStep, false, 'lazy: no nominal step either');
            assert.deepEqual(eager.gaps, [], 'eager claims no gaps');
            assert.deepEqual(lazy.intervals, [], 'and neither does lazy');
        }

        // 3. NaN block on a regular axis: banded by both, and not as a gap.
        {
            const times = Array.from({ length: 60 }, (_, i) => start + i * minute);
            const values = times.map((_, i) => (i >= 20 && i <= 28 ? NaN : 1));
            const eager = detectSamplingGaps(times);
            const runs = detectNaNRuns(times, values);
            const lazy = await lazyMissing(times, values);
            assert.equal(eager.count, 0, 'a NaN block does not disturb the time axis');
            assert.equal(runs.length, 1, 'eager finds the NaN run');
            assert.ok(covers(lazy.intervals, runs[0].t0, runs[0].t1), 'lazy covers the same NaN span');
        }

        // 4. THE case the gate exists for: an irregular axis carrying a NaN
        // block. No sampling-gap band may appear, but the NaN block must — it
        // is a fact about the values, independent of the time axis.
        {
            const offsets = [0, 300, 900, 1500, 1800, 1830, 1860, 2100, 2400, 2700,
                3000, 3300, 3540, 3600, 3900, 4200, 5400, 6600, 7200];
            const times = offsets.map(s => start + s * 1000);
            const values = times.map((_, i) => (i >= 8 && i <= 10 ? NaN : 1));
            const runs = detectNaNRuns(times, values);
            const lazy = await lazyMissing(times, values);
            assert.equal(lazy.hasNominalStep, false, 'still no nominal step');
            assert.equal(runs.length, 1, 'eager finds the NaN run');
            assert.ok(lazy.missingBuckets >= 3, 'lazy counts the invalid buckets');
            assert.ok(covers(lazy.solidIntervals, runs[0].t0, runs[0].t1), 'lazy still paints the NaN block');
        }

        // 5. Rate change with balanced counts: both paths refuse to call the
        // coarse stretch a gap.
        {
            const offsets = [
                ...Array.from({ length: 6 }, (_, i) => i * 300),
                ...Array.from({ length: 31 }, (_, i) => 1800 + i * 60),
                ...Array.from({ length: 12 }, (_, i) => 3900 + i * 300),
            ];
            const times = offsets.map(s => start + s * 1000);
            const eager = detectSamplingGaps(times);
            const lazy = await lazyMissing(times, clean(times.length));
            assert.equal(eager.hasNominalStep, false, 'eager: a rate change voids the step');
            assert.equal(lazy.hasNominalStep, false, 'lazy agrees');
            assert.deepEqual(lazy.intervals, [], 'so no bands are drawn');
        }

        // ── Documented divergences ──
        // These are NOT parity failures to be tuned away: they are the price of
        // measuring bucket aggregates instead of samples. Pinning them keeps the
        // limitation visible instead of letting a future change hide it.

        // 6a. Parity SURVIVES the bucket aggregation at production shapes. This
        // is the reassuring half of the divergence story and the reason the
        // ported gate is worth having: even with many samples per bucket — a
        // large file zoomed out, where within-bucket candidates are AVERAGE
        // spacings that look regular — the cross-bucket candidates keep
        // agreement around 50%, well under the gate.
        {
            const steps = [30, 300, 45, 600, 90, 150, 900, 60, 240, 30, 480, 120];
            const offsets = [0];
            for (let i = 1; i < 600; i++) offsets.push(offsets[i - 1] + steps[i % steps.length]);
            const times = offsets.map(s => start + s * 1000);
            const values = clean(times.length);
            const eager = detectSamplingGaps(times);
            assert.equal(eager.hasNominalStep, false, 'eager sees the irregular spacing');
            for (const bucketFactor of [1, 1 / 5, 1 / 15, 1 / 40]) {
                const lazy = await lazyMissing(times, values, { bucketFactor });
                assert.equal(lazy.hasNominalStep, false,
                    `lazy agrees at ~${Math.round(1 / bucketFactor)} samples per bucket`);
                assert.ok(lazy.stepAgreement < 0.8, 'and for the same reason: agreement below the gate');
                assert.deepEqual(lazy.intervals, [], 'so no bands are invented at any zoom');
            }
        }

        // 6b. Where they DO diverge: with very few buckets there are not enough
        // candidate steps for the agreement statistic to have power, so the gate
        // stands down — the same GAP_STEP_MIN_SAMPLES escape the eager path has,
        // reached at a different point because the candidates are bucket
        // distances, not sample deltas.
        {
            const steps = [30, 300, 45, 600, 90, 150, 900, 60, 240, 30, 480, 120];
            const offsets = [0];
            for (let i = 1; i < 120; i++) offsets.push(offsets[i - 1] + steps[i % steps.length]);
            const times = offsets.map(s => start + s * 1000);
            const lazy = await lazyMissing(times, clean(times.length), { bucketFactor: 3 / 120 });
            assert.equal(lazy.hasNominalStep, true, 'too few bucket candidates to judge');
            assert.ok(lazy.stepAgreement < 0.8, 'even though the candidates that exist disagree');
        }

        // 6b. Row order is invisible to the bucket query: it aggregates BY TIME
        // VALUE, so an out-of-order file looks perfectly sorted to the lazy
        // path. The eager path reports nonMonotonic; the lazy one cannot, and
        // a large unsorted file therefore gets no disorder notice.
        {
            const offsets = [0, 60, 120, 300, 240, 180, 360, 420, 480, 540, 600, 660];
            const times = offsets.map(s => start + s * 1000);
            const eager = detectSamplingGaps(times);
            const lazy = await lazyMissing(times, clean(times.length));
            assert.equal(eager.reason, 'nonMonotonic', 'eager reports the disorder');
            assert.equal(lazy.hasNominalStep, true, 'lazy cannot see it: buckets are keyed by time');
        }
    } finally {
        await closeDuckDbConnection(connection);
        await closeDuckDbDatabase(db);
    }
}

console.log('Lazy missing-data (buckets) tests passed');
