// Pure, dependency-free SQL builder + result reducer for lazy (DuckDB)
// Missing/NaN detection. Kept separate from DuckDbSource (which imports the
// Vite-only WASM engine) so it is unit-testable in Node.
//
// The idea: a randomly-sampled overview can't reveal where a lazy file's gaps
// really are, so instead of scanning full-resolution arrays in JS we ask DuckDB
// to bucket the VISIBLE range into ~one bucket per pixel and count, per bucket,
// how many rows fall in it (n_total) and how many have a missing value
// (n_missing = any requested variable NULL / NaN / Inf). One cheap aggregate
// query, O(nBuckets) output. MIN/MAX timestamps distinguish real gaps from
// intentionally empty screen-pixel buckets.

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
               SUM(CASE WHEN miss THEN 1 ELSE 0 END)::BIGINT AS n_missing,
               MIN(t)::DOUBLE AS t_min,
               MAX(t)::DOUBLE AS t_max
        FROM v
        WHERE t BETWEEN ${lit(lo)} AND ${lit(hi)}
        GROUP BY b
        ORDER BY b;
    `;
}

// Reduce the per-bucket counts into coalesced missing intervals in DISPLAY units
// plus the density signals the renderer needs.
//
// `buckets`: [{ b, nTotal, nMissing, tMin, tMax }] (sparse — only buckets
// that held rows). The timestamp bounds let us distinguish a real sampling gap
// from the intentionally-empty buckets created when there are more pixels than
// samples in the viewport.
// `t0`/`t1`: the queried range in source units; bucket i spans
//   [t0 + i/nB*(t1-t0), t0 + (i+1)/nB*(t1-t0)].
// `mapTime`, when supplied, converts every bucket boundary through the same
// source -> display mapping used by plotted samples. This is important for
// shifted/elapsed/generated axes: deriving boundaries from the display viewport
// works only while that mapping happens to be affine and identically clipped.
//
// Rules:
//  - A bucket is "missing" when it holds at least one non-finite value.
//  - Sampling gaps come from observed timestamp distances (or a row deficit
//    inside a populated bucket), never from an empty pixel bucket by itself.
//  - "partial" = holds rows AND some but not all are missing → scattered data
//    you cannot resolve at this zoom; drives the "dense" (zoom-in) signal.
//  - Buckets before the first / after the last populated bucket are OUTSIDE the
//    data, not gaps, so they never produce bands.
export function missingBucketsToIntervals(buckets, {
    t0,
    t1,
    nBuckets,
    fileId = null,
    timeVar = null,
    mapTime = null,
} = {}) {
    const nb = Math.max(1, Math.floor(nBuckets));
    const span = t1 - t0;
    const empty = { intervals: [], solidIntervals: [], partialCount: 0, coverage: 0, dense: false, missingBuckets: 0 };
    if (!(span > 0) || !Array.isArray(buckets) || !buckets.length) return empty;

    const total = new Float64Array(nb);
    const missing = new Float64Array(nb);
    const timeMin = new Float64Array(nb);
    const timeMax = new Float64Array(nb);
    timeMin.fill(NaN);
    timeMax.fill(NaN);
    let first = nb;
    let last = -1;
    for (const row of buckets) {
        const b = Math.trunc(Number(row.b));
        if (!Number.isFinite(b) || b < 0 || b >= nb) continue;
        const nt = Number(row.nTotal) || 0;
        if (nt <= 0) continue;
        total[b] = nt;
        missing[b] = Number(row.nMissing) || 0;
        const rowMin = Number(row.tMin);
        const rowMax = Number(row.tMax);
        if (Number.isFinite(rowMin) && Number.isFinite(rowMax) && rowMax >= rowMin) {
            timeMin[b] = rowMin;
            timeMax[b] = rowMax;
        }
        if (b < first) first = b;
        if (b > last) last = b;
    }
    if (last < first) return empty;

    const bucketLo = (i) => t0 + (i / nb) * span;
    const displayBoundary = (i) => {
        const sourceValue = bucketLo(i);
        return typeof mapTime === 'function' ? Number(mapTime(sourceValue)) : sourceValue;
    };
    const mk = (r) => {
        const a = displayBoundary(r[0]);
        const b = displayBoundary(r[1] + 1);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        return { fileId, timeVar, t0: Math.min(a, b), t1: Math.max(a, b) };
    };
    const append = (target, run) => {
        const interval = mk(run);
        if (interval && interval.t1 > interval.t0) target.push(interval);
    };
    const mappedInterval = (sourceA, sourceB) => {
        const a = typeof mapTime === 'function' ? Number(mapTime(sourceA)) : sourceA;
        const b = typeof mapTime === 'function' ? Number(mapTime(sourceB)) : sourceB;
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
        return { fileId, timeVar, t0: Math.min(a, b), t1: Math.max(a, b) };
    };
    const mergeIntervals = (items) => {
        if (items.length < 2) return items;
        items.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
        const merged = [{ ...items[0] }];
        for (let i = 1; i < items.length; i++) {
            const current = merged[merged.length - 1];
            const next = items[i];
            if (next.t0 <= current.t1) current.t1 = Math.max(current.t1, next.t1);
            else merged.push({ ...next });
        }
        return merged;
    };

    // Robust nominal timestep from both within-bucket and cross-bucket sample
    // distances. The median ignores the few large distances we are looking for.
    const stepCandidates = [];
    let previousPopulated = -1;
    for (let i = first; i <= last; i++) {
        if (!(total[i] > 0) || !Number.isFinite(timeMin[i]) || !Number.isFinite(timeMax[i])) continue;
        if (total[i] > 1 && timeMax[i] > timeMin[i]) {
            stepCandidates.push((timeMax[i] - timeMin[i]) / (total[i] - 1));
        }
        if (previousPopulated >= 0 && timeMin[i] > timeMax[previousPopulated]) {
            stepCandidates.push(timeMin[i] - timeMax[previousPopulated]);
        }
        previousPopulated = i;
    }
    stepCandidates.sort((a, b) => a - b);
    const nominalStep = stepCandidates.length
        ? stepCandidates[Math.floor(stepCandidates.length / 2)]
        : NaN;

    const samplingGaps = [];
    const fullMissingExtents = [];
    previousPopulated = -1;
    for (let i = first; i <= last; i++) {
        if (!(total[i] > 0) || !Number.isFinite(timeMin[i]) || !Number.isFinite(timeMax[i])) continue;
        if (previousPopulated >= 0 && Number.isFinite(nominalStep)) {
            const dt = timeMin[i] - timeMax[previousPopulated];
            if (dt > nominalStep * 1.5) {
                const gap = mappedInterval(timeMax[previousPopulated], timeMin[i]);
                if (gap) samplingGaps.push(gap);
            }
        }
        // If several samples share this pixel bucket, MIN/MAX/count can still
        // reveal omitted timestamps inside it. The bucket is the narrowest
        // truthful location available at this zoom, so mark that pixel region.
        if (total[i] > 1 && Number.isFinite(nominalStep)) {
            const observedSpan = timeMax[i] - timeMin[i];
            if (observedSpan > (total[i] - 0.5) * nominalStep) {
                const gap = mappedInterval(bucketLo(i), bucketLo(i + 1));
                if (gap) samplingGaps.push(gap);
            }
        }
        // A fully-invalid bucket may hold just one sample while neighbouring
        // pixel buckets are empty. Expand by one nominal sample on each side,
        // matching eager detectNaNRuns (last good -> first good), so a real NaN
        // run remains contiguous instead of turning into dozens of stripes.
        if (missing[i] >= total[i] && Number.isFinite(nominalStep)) {
            const extent = mappedInterval(
                Math.max(t0, timeMin[i] - nominalStep),
                Math.min(t1, timeMax[i] + nominalStep),
            );
            if (extent) fullMissingExtents.push(extent);
        }
        previousPopulated = i;
    }
    const intervals = [];      // ANY missing (drives the wash / coverage / dense)
    const solidIntervals = []; // FULLY missing (gaps + full blocks) — always drawn
    let partialCount = 0;
    let missingBuckets = 0;
    let anyRun = null;   // run of any-missing buckets
    let solidRun = null; // run of fully-missing buckets
    for (let i = first; i <= last; i++) {
        const present = total[i] > 0;
        const miss = missing[i];
        const isMissing = present && miss > 0;
        const isFull = present && miss >= total[i];
        const hasTimestampExtent = isFull
            && Number.isFinite(nominalStep)
            && Number.isFinite(timeMin[i])
            && Number.isFinite(timeMax[i]);
        if (present && miss > 0 && miss < total[i]) partialCount++;
        if (isMissing) missingBuckets++;
        // Full buckets with timestamp bounds are represented by the expanded
        // eager-style extents above. Do not also add their pixel buckets: when
        // buckets outnumber samples those would reintroduce striped artifacts.
        if (isMissing && !hasTimestampExtent) { if (anyRun) anyRun[1] = i; else anyRun = [i, i]; }
        else if (anyRun) { append(intervals, anyRun); anyRun = null; }
        if (isFull && !hasTimestampExtent) { if (solidRun) solidRun[1] = i; else solidRun = [i, i]; }
        else if (solidRun) { append(solidIntervals, solidRun); solidRun = null; }
    }
    if (anyRun) append(intervals, anyRun);
    if (solidRun) append(solidIntervals, solidRun);

    intervals.push(...samplingGaps);
    intervals.push(...fullMissingExtents);
    solidIntervals.push(...samplingGaps.map(interval => ({ ...interval })));
    solidIntervals.push(...fullMissingExtents.map(interval => ({ ...interval })));
    const mergedIntervals = mergeIntervals(intervals);
    const mergedSolidIntervals = mergeIntervals(solidIntervals);

    const coverage = missingBuckets / nb;
    // Dense = enough partial buckets that the scattered missing cannot be
    // resolved at this zoom (blocks/gaps alone stay resolvable → not dense).
    const dense = partialCount >= Math.max(3, Math.floor(nb * 0.01));
    return {
        intervals: mergedIntervals,
        solidIntervals: mergedSolidIntervals,
        partialCount,
        coverage,
        dense,
        missingBuckets,
    };
}
