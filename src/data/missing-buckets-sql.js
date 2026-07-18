// Pure, dependency-free SQL builder + result reducer for lazy (DuckDB)
// Missing/NaN detection. Kept separate from DuckDbSource (which imports the
// Vite-only WASM engine) so it is unit-testable in Node.
//
// The idea: a randomly-sampled overview can't reveal where a lazy file's gaps
// really are, so instead of scanning full-resolution arrays in JS we ask DuckDB
// to bucket the VISIBLE range into ~one bucket per pixel and count, per bucket,
// how many rows fall in it (n_total) and how many have a missing value
// (n_missing = any requested variable NULL / NaN / Inf). One cheap aggregate
// query, O(nBuckets) output. Empty buckets INSIDE the data are time gaps.

// `valueExprs` are DOUBLE SQL value expressions (try_cast, transforms already
// applied). A row is "missing" if ANY of them is non-finite — the band layer is
// the union across the visible variables, mirroring the eager band semantics.
// `windowedTime` = the time expression is a window function (generated-time
// files use ROW_NUMBER() OVER ()), which cannot appear in a WHERE — so filter
// on the computed `t` in the outer query instead of inside the CTE.
export function buildMissingBucketsSql(tExpr, tableName, valueExprs, lit, lo, hi, nBuckets, windowedTime = false) {
    const nb = Math.max(1, Math.floor(nBuckets));
    const nonFinite = (e) => `(${e} IS NULL OR isnan(${e}) OR isinf(${e}))`;
    const missExpr = valueExprs.length
        ? valueExprs.map(nonFinite).join(' OR ')
        : 'FALSE';
    const cteWhere = windowedTime ? '' : `WHERE ${tExpr} BETWEEN ${lit(lo)} AND ${lit(hi)}`;
    return `
        WITH v AS (
            SELECT ${tExpr} AS t,
                   (${missExpr}) AS miss
            FROM ${tableName}
            ${cteWhere}
        )
        SELECT CAST(LEAST(${nb - 1},
                    GREATEST(0,
                        FLOOR((t - ${lit(lo)}) / NULLIF(${lit(hi)} - ${lit(lo)}, 0) * ${nb})))
                    AS BIGINT) AS b,
               COUNT(*)::BIGINT AS n_total,
               SUM(CASE WHEN miss THEN 1 ELSE 0 END)::BIGINT AS n_missing
        FROM v
        WHERE t BETWEEN ${lit(lo)} AND ${lit(hi)}
        GROUP BY b
        ORDER BY b;
    `;
}

// Reduce the per-bucket counts into coalesced missing intervals in DISPLAY units
// plus the density signals the renderer needs.
//
// `buckets`: [{ b, nTotal, nMissing }] (sparse — only buckets that held rows).
// `t0`/`t1`: the visible range in display units; bucket i spans
//   [t0 + i/nB*(t1-t0), t0 + (i+1)/nB*(t1-t0)].
//
// Rules:
//  - A bucket is "missing" when it is a time gap (no rows, but INSIDE the data)
//    or holds at least one non-finite value.
//  - "partial" = holds rows AND some but not all are missing → scattered data
//    you cannot resolve at this zoom; drives the "dense" (zoom-in) signal.
//  - Buckets before the first / after the last populated bucket are OUTSIDE the
//    data, not gaps, so they never produce bands.
export function missingBucketsToIntervals(buckets, { t0, t1, nBuckets, fileId = null, timeVar = null } = {}) {
    const nb = Math.max(1, Math.floor(nBuckets));
    const span = t1 - t0;
    const empty = { intervals: [], partialCount: 0, coverage: 0, dense: false, missingBuckets: 0 };
    if (!(span > 0) || !Array.isArray(buckets) || !buckets.length) return empty;

    const total = new Float64Array(nb);
    const missing = new Float64Array(nb);
    let first = nb;
    let last = -1;
    for (const row of buckets) {
        const b = Math.trunc(Number(row.b));
        if (!Number.isFinite(b) || b < 0 || b >= nb) continue;
        const nt = Number(row.nTotal) || 0;
        if (nt <= 0) continue;
        total[b] = nt;
        missing[b] = Number(row.nMissing) || 0;
        if (b < first) first = b;
        if (b > last) last = b;
    }
    if (last < first) return empty;

    const bucketLo = (i) => t0 + (i / nb) * span;
    const intervals = [];
    let partialCount = 0;
    let missingBuckets = 0;
    let run = null; // [startBucket, endBucket]
    for (let i = first; i <= last; i++) {
        const present = total[i] > 0;
        const miss = missing[i];
        const isMissing = !present || miss > 0; // gap inside data, or some NaN
        if (present && miss > 0 && miss < total[i]) partialCount++;
        if (isMissing) {
            missingBuckets++;
            if (run) run[1] = i; else run = [i, i];
        } else if (run) {
            intervals.push({ fileId, timeVar, t0: bucketLo(run[0]), t1: bucketLo(run[1] + 1) });
            run = null;
        }
    }
    if (run) intervals.push({ fileId, timeVar, t0: bucketLo(run[0]), t1: bucketLo(run[1] + 1) });

    const coverage = missingBuckets / nb;
    // Dense = enough partial buckets that the scattered missing cannot be
    // resolved at this zoom (blocks/gaps alone stay resolvable → not dense).
    const dense = partialCount >= Math.max(3, Math.floor(nb * 0.01));
    return { intervals, partialCount, coverage, dense, missingBuckets };
}
