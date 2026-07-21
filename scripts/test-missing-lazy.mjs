// Unit tests for the pure lazy Missing/NaN SQL builder + bucket reducer, plus
// the min/max-envelope gap-break helpers extracted from interaction-methods.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildMissingBucketsSql, missingBucketsToIntervals } from '../src/data/missing-buckets-sql.js';

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
        _missingDataInfo: () => ({ bandItems: [] }),
        _missingViewIsDense: () => false,
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

console.log('Lazy missing-data (buckets) tests passed');
