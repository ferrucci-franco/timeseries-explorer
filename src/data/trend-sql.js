// Pure, dependency-free SQL builders and result parsers for the Trend analysis
// over a lazy (DuckDB) file. Kept out of DuckDbSource (which imports the
// Vite-only WASM engine) so it can be unit-tested in Node.
//
// The analysis summarises SEGMENTS of a signal — each its own time range, its
// own signal and its own value band — and a segment's numbers must come from
// every row in its range, never from the overview. Two passes, mirroring the
// kernel (src/utils/trend-fit.js) so that what lazy reports and what memory
// reports differ only by the rounding of their sums:
//
//  • Pass 1 — one aggregate row holding, per segment, the rows in its range,
//    the rows its band dropped, the pairwise-finite count, the means, the
//    central second moments (regr_sxx/syy/sxy) and the spans of t′ and y.
//    linearFromMoments reads these directly; the mean and the spread come from
//    the same row; and they give the centre/scale of pass 2.
//  • Pass 2 — for the segments that want a parabola, the sufficient statistics
//    S0..S4, T0..T2, YY in the centred, scaled coordinate u = (t′−centre)/scale,
//    which quadraticFromMoments solves. Centring is what keeps the normal
//    equations conditioned when t′ is large.
//
// EVERY SEGMENT IN ONE QUERY. The segments of a file are masked by their own
// range inside a single scan (`CASE WHEN t BETWEEN lo AND hi …`) instead of one
// query each: on a CSV a scan is the whole cost, and a panel with eight
// segments would otherwise re-read the file eight times per pass.
//
// A segment entry is
//   { i, y, lo, hi, origin, divisor, lower, upper }
// where `y` is a DOUBLE SQL value expression with gain, sign and offset already
// applied by the caller, `lo`/`hi` bound the SOURCE time column, t′ is
// (t − origin) / divisor in that same source time (the affine map the panel's
// time transform defines), and `lower`/`upper` are the value band's bounds
// (non-finite ⇒ open).

import { isFin } from './pair-regression-sql.js';

// The band test of one segment: the rows the kernel keeps (trendInBand). An
// open bound contributes nothing, and a segment with no band is always TRUE.
export function bandSql(expr, { lower, upper }, lit) {
    const clauses = [];
    if (Number.isFinite(lower)) clauses.push(`${expr} >= ${lit(lower)}`);
    if (Number.isFinite(upper)) clauses.push(`${expr} <= ${lit(upper)}`);
    return clauses.length ? `(${clauses.join(' AND ')})` : 'TRUE';
}

// The CTEs both passes share: the value and t′ of every segment, the flags that
// say which rows it uses, and the masked px/py the aggregates read. One row of
// the file per row here, so a segment's mask is independent of every other's.
export function trendCteSql(tableName, where, tExpr, segExprs, lit) {
    const valsCols = segExprs
        .map(s => `${s.y} AS vy${s.i}`)
        .join(',\n                           ');
    const segCols = segExprs.map(s => {
        const inRange = `(ts >= ${lit(Math.min(s.lo, s.hi))} AND ts <= ${lit(Math.max(s.lo, s.hi))})`;
        const tp = s.divisor === 1
            ? `(ts - ${lit(s.origin)})`
            : `((ts - ${lit(s.origin)}) / ${lit(s.divisor)})`;
        return `${inRange} AS in${s.i}, ${tp} AS tp${s.i}, vy${s.i}`;
    }).join(',\n                           ');
    const keptCols = segExprs.map(s => {
        const usable = `in${s.i} AND ${isFin(`tp${s.i}`)} AND ${isFin(`vy${s.i}`)}`;
        const band = bandSql(`vy${s.i}`, s, lit);
        return `CASE WHEN in${s.i} THEN 1 ELSE 0 END AS scope${s.i}, `
            + `CASE WHEN ${usable} AND ${band} THEN tp${s.i} END AS px${s.i}, `
            + `CASE WHEN ${usable} AND ${band} THEN vy${s.i} END AS py${s.i}, `
            + `CASE WHEN ${usable} AND NOT ${band} THEN 1 ELSE 0 END AS outl${s.i}`;
    }).join(',\n                           ');
    return `
                WITH vals AS (
                    SELECT ${tExpr} AS ts, ${valsCols}
                    FROM ${tableName}
                    WHERE ${where}
                ),
                segs AS (
                    SELECT ${segCols}
                    FROM vals
                ),
                kept AS (
                    SELECT ${keptCols}
                    FROM segs
                )`;
}

// Pass 1: counts, means, central second moments and spans, per segment.
export function buildTrendPass1Sql(tableName, where, tExpr, segExprs, lit) {
    const aggCols = segExprs.map(s => (
        `SUM(scope${s.i})::BIGINT AS nscope${s.i}, SUM(outl${s.i})::BIGINT AS nout${s.i}, `
        + `regr_count(py${s.i}, px${s.i})::BIGINT AS n${s.i}, `
        + `regr_avgx(py${s.i}, px${s.i}) AS ax${s.i}, regr_avgy(py${s.i}, px${s.i}) AS ay${s.i}, `
        + `regr_sxx(py${s.i}, px${s.i}) AS sxx${s.i}, regr_syy(py${s.i}, px${s.i}) AS syy${s.i}, `
        + `regr_sxy(py${s.i}, px${s.i}) AS sxy${s.i}, `
        + `min(px${s.i}) AS mnx${s.i}, max(px${s.i}) AS mxx${s.i}, `
        + `min(py${s.i}) AS mny${s.i}, max(py${s.i}) AS mxy${s.i}`
    )).join(',\n                       ');
    return `${trendCteSql(tableName, where, tExpr, segExprs, lit)}
                SELECT ${aggCols}
                FROM kept;
            `;
}

/**
 * Parse pass 1 into, per segment: `{ nScope, nOutliers, moments, minY, maxY,
 * centerX, scaleX }` — `moments` in the shape linearFromMoments and
 * quadraticFromMoments expect, and the centre/scale pass 2 needs.
 */
export function parseTrendPass1(getScalar, segExprs) {
    const num = (name) => { const v = getScalar(name); return v == null ? NaN : Number(v); };
    const int = (name) => { const v = num(name); return Number.isFinite(v) ? v : 0; };
    return segExprs.map((s) => {
        const nScope = int(`nscope${s.i}`);
        const n = int(`n${s.i}`);
        const m2x = num(`sxx${s.i}`);
        const centerX = num(`ax${s.i}`);
        // The sample stddev of t′, the scale the eager kernel centres by.
        const scaleX = n >= 2 && m2x > 0 ? Math.sqrt(m2x / (n - 1)) : NaN;
        return {
            i: s.i,
            nScope,
            nOutliers: int(`nout${s.i}`),
            minY: num(`mny${s.i}`),
            maxY: num(`mxy${s.i}`),
            moments: {
                n,
                nRowsSeen: nScope,
                nExcluded: Math.max(0, nScope - n),
                meanX: centerX,
                meanY: num(`ay${s.i}`),
                m2x,
                m2y: num(`syy${s.i}`),
                cMoment: num(`sxy${s.i}`),
                minX: num(`mnx${s.i}`),
                maxX: num(`mxx${s.i}`),
            },
            centerX,
            scaleX,
        };
    });
}

// Pass 2: the centred sufficient statistics, for the segments that asked for a
// parabola and whose centre/scale pass 1 could define. `quadExprs` are pass-1
// segment entries with `centerX`/`scaleX` filled in.
export function buildTrendPass2Sql(tableName, where, tExpr, segExprs, quadExprs, lit) {
    const aggCols = quadExprs.map(q => {
        const u = `((px${q.i} - ${lit(q.centerX)}) / ${lit(q.scaleX)})`;
        return `count(px${q.i})::BIGINT AS s0_${q.i}, `
            + `sum(${u}) AS s1_${q.i}, sum(${u}*${u}) AS s2_${q.i}, `
            + `sum(${u}*${u}*${u}) AS s3_${q.i}, sum(${u}*${u}*${u}*${u}) AS s4_${q.i}, `
            + `sum(py${q.i}) AS t0_${q.i}, sum(${u}*py${q.i}) AS t1_${q.i}, `
            + `sum(${u}*${u}*py${q.i}) AS t2_${q.i}, sum(py${q.i}*py${q.i}) AS yy_${q.i}`;
    }).join(',\n                       ');
    return `${trendCteSql(tableName, where, tExpr, segExprs, lit)}
                SELECT ${aggCols}
                FROM kept;
            `;
}

// Parse pass 2 → { S0..S4, T0..T2, YY } per segment index.
export function parseTrendPass2(getScalar, quadExprs) {
    const num = (name) => { const v = getScalar(name); return v == null ? NaN : Number(v); };
    const map = new Map();
    for (const q of quadExprs) {
        map.set(q.i, {
            S0: num(`s0_${q.i}`), S1: num(`s1_${q.i}`), S2: num(`s2_${q.i}`),
            S3: num(`s3_${q.i}`), S4: num(`s4_${q.i}`),
            T0: num(`t0_${q.i}`), T1: num(`t1_${q.i}`), T2: num(`t2_${q.i}`),
            YY: num(`yy_${q.i}`),
        });
    }
    return map;
}
