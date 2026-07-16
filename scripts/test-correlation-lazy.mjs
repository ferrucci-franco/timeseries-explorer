import assert from 'node:assert/strict';
import { buildPairCorrelationSql, parsePairCorrelations } from '../src/data/pair-correlation-sql.js';
import { pearsonCorrelation } from '../src/utils/correlation.js';

const close = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: expected ${b}, got ${a}`);

// ── buildPairCorrelationSql: structure ──
{
    const sql = buildPairCorrelationSql(
        'epoch_ms("ts")::DOUBLE',
        'my_table',
        'epoch_ms("ts")::DOUBLE IS NOT NULL',
        [
            { i: 0, vx: '(try_cast(("a") AS DOUBLE) * 1 + 0)', vy: '(try_cast(("b") AS DOUBLE) * 1 + 0)' },
            { i: 1, vx: '(try_cast(("c") AS DOUBLE) * -3 + 0)', vy: '(try_cast(("d") AS DOUBLE) * 1 + 0)' },
        ],
    );
    // one aggregate query, all pairs
    assert.match(sql, /FROM my_table/, 'queries the file table');
    assert.match(sql, /WHERE epoch_ms\("ts"\)::DOUBLE IS NOT NULL/, 'applies the range/where clause');
    assert.match(sql, /COUNT\(\*\)::BIGINT AS n_scope/, 'reports scope count');
    // pairwise deletion + non-finite -> NULL for both pairs
    for (const i of [0, 1]) {
        assert.match(sql, new RegExp(`corr\\(py${i}, px${i}\\) AS r${i}`), `pair ${i}: corr`);
        assert.match(sql, new RegExp(`COUNT\\(px${i}\\)::BIGINT AS n${i}`), `pair ${i}: pair count`);
        assert.match(sql, new RegExp(`stddev_samp\\(px${i}\\) AS sx${i}`), `pair ${i}: sample std x`);
        assert.match(sql, new RegExp(`stddev_samp\\(py${i}\\) AS sy${i}`), `pair ${i}: sample std y`);
        assert.match(sql, new RegExp(`avg\\(px${i}\\) AS mx${i}`), `pair ${i}: mean x`);
        assert.match(sql, new RegExp(`NOT isnan\\(vx${i}\\) AND NOT isinf\\(vx${i}\\)`), `pair ${i}: non-finite x -> NULL`);
        assert.match(sql, new RegExp(`CASE WHEN .* THEN vx${i} END AS px${i}`), `pair ${i}: pairwise x`);
    }
    // the negative gain is carried into the SQL value expression (sign flip)
    assert.match(sql, /try_cast\(\("c"\) AS DOUBLE\) \* -3/, 'negative gain reaches the SQL');
}

// ── parsePairCorrelations: mapping + undefined rules ──
const parseWith = (scalars, count) => parsePairCorrelations((name) => (name in scalars ? scalars[name] : null), count);
{
    // ok pair: clamp + r2 + nExcluded
    const [res] = parseWith({ n_scope: 100, n0: 90, r0: 1.0000000004, sx0: 2, sy0: 3, mx0: 5, my0: 7 }, 1);
    assert.equal(res.status, 'ok', 'defined pair is ok');
    assert.equal(res.r, 1, 'r clamped into [-1,1]');
    assert.equal(res.r2, 1, 'r2 = r^2');
    assert.equal(res.nPair, 90, 'nPair from COUNT(px)');
    assert.equal(res.nExcluded, 10, 'nExcluded = nScope - nPair');
    assert.equal(res.meanX, 5, 'meanX carried');

    // undefined: fewer than 2 pairs
    assert.equal(parseWith({ n_scope: 5, n0: 1, r0: null, sx0: null, sy0: null }, 1)[0].status, 'undefined', 'n<2 undefined');
    // undefined: zero variance (constant) -> stddev 0
    assert.equal(parseWith({ n_scope: 5, n0: 5, r0: null, sx0: 0, sy0: 2 }, 1)[0].status, 'undefined', 'zero variance undefined');
    // undefined: corr NULL
    const u = parseWith({ n_scope: 5, n0: 5, r0: null, sx0: 2, sy0: 2 }, 1)[0];
    assert.equal(u.status, 'undefined', 'null r undefined');
    assert.ok(Number.isNaN(u.r), 'undefined r is NaN, not 0');
    assert.equal(u.nExcluded, 0, 'undefined still reports counts');
}

// ── Eager/lazy parity of the mapping: the DuckDB scalars a real query would
// return for a dataset feed parsePairCorrelations to the SAME result as the
// eager kernel on that dataset. ──
{
    const x = [1, 2, 3, 4, 5, 6, 7, NaN, 9, 10];
    const y = [2, 1, 4, 3, 6, 5, 8, 100, 10, 9]; // one row excluded by the NaN in x
    const eager = pearsonCorrelation(x, y);
    // DuckDB corr/count/stddev over the same pairwise-finite rows == kernel stats.
    const scalars = { n_scope: x.length, n0: eager.n, r0: eager.r, sx0: eager.stdX, sy0: eager.stdY, mx0: eager.meanX, my0: eager.meanY };
    const [lazy] = parseWith(scalars, 1);
    assert.equal(lazy.status, 'ok', 'parity: defined');
    close(lazy.r, eager.r, 1e-12, 'parity r');
    close(lazy.r2, eager.r2, 1e-12, 'parity r2');
    assert.equal(lazy.nPair, eager.n, 'parity nPair');
    assert.equal(lazy.nExcluded, x.length - eager.n, 'parity nExcluded');
}

console.log('Correlation lazy tests passed');
