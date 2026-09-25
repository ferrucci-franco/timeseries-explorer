// What the NaN/Inf toggle draws for the current view
// (docs/marks-menu-nan-gaps-design.md).
//
// A NaN run belongs to one variable, so a full-height band would cover the
// other traces, which have data there. Instead the runs show on a thin strip
// along the top of the plot, like the zoomed-out Repeated bars. The visible
// range is cut into screen columns; each column gets the fraction of its
// samples that are non-finite — the LARGEST fraction among the traces, so a
// variable that is fully missing there reads as fully missing whatever the
// others do — quantized to a few opacity levels. Adjacent columns of the same
// level merge into one bar. The number of bars is bounded by the plot width.
//
// Pure: the plot methods hand in time/value arrays and NaN runs (row indices
// from nanRunIndices), and get time spans back in the units of `times`.

/** Width of the screen column the samples are grouped into, in pixels. */
export const NAN_STRIP_COLUMN_PX = 2;
/** Height of the strip, in pixels. */
export const NAN_STRIP_HEIGHT_PX = 5;
/** Opacity of each level (index = level). Level 0 is "nothing missing". */
export const NAN_STRIP_LEVEL_ALPHA = [0, 0.35, 0.55, 0.8, 1];

/** Level of a column from its non-finite fraction: 0 none … 4 all. */
export function nanStripLevel(fraction) {
    const f = Number(fraction);
    if (!(f > 0)) return 0;
    if (f >= 1) return 4;
    if (f >= 0.5) return 3;
    if (f >= 0.1) return 2;
    return 1;
}

// First index i with a[i] >= x (a ascending).
function lowerBound(a, x, lo = 0, hi = a.length) {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (a[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// First index i with a[i] > x (a ascending).
function upperBound(a, x, lo = 0, hi = a.length) {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (a[mid] <= x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Whether a time vector never steps backwards (NaN times are skipped). */
export function isNonDecreasing(times) {
    const n = times?.length || 0;
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
        const t = Number(times[i]);
        if (!Number.isFinite(t)) continue;
        if (t < prev) return false;
        prev = t;
    }
    return true;
}

/**
 * Per-column counts for one source.
 * @returns {{ nan: Float64Array, total: Float64Array }}
 */
function columnCounts(source, a, b, columns) {
    const { times, values, runs } = source;
    const nan = new Float64Array(columns);
    const total = new Float64Array(columns);
    const n = Math.min(times?.length || 0, values?.length || 0);
    if (!n) return { nan, total };
    const span = b - a;
    const columnOf = (t) => (span > 0 ? Math.min(columns - 1, Math.floor(((t - a) / span) * columns)) : 0);

    if (!source.monotonic || !runs) {
        // Out-of-order time (or no runs given): one pass over the rows. Rare, and
        // exactly the file whose NaN a reader still wants located.
        for (let i = 0; i < n; i++) {
            const t = Number(times[i]);
            if (!(t >= a && t <= b)) continue;
            const c = columnOf(t);
            total[c]++;
            const v = values[i];
            if (typeof v === 'number' ? !Number.isFinite(v) : !Number.isFinite(Number(v))) nan[c]++;
        }
        return { nan, total };
    }

    // Monotonic: column boundaries are row indices by binary search, and the NaN
    // count per column is the overlap of each run with those index ranges — the
    // cost is the number of runs in view plus the columns they touch, not n.
    const bounds = new Int32Array(columns + 1);
    for (let c = 0; c < columns; c++) bounds[c] = lowerBound(times, a + (c / columns) * span, 0, n);
    bounds[columns] = upperBound(times, b, 0, n);
    for (let c = 0; c < columns; c++) total[c] = Math.max(0, bounds[c + 1] - bounds[c]);
    const first = bounds[0];
    const last = bounds[columns] - 1;
    if (last < first) return { nan, total };
    // First run that ends at or after the first visible row.
    let r = lowerBound(runs.ends, first, 0, runs.count);
    let c = 0;
    for (; r < runs.count; r++) {
        const s = Math.max(runs.starts[r], first);
        const e = Math.min(runs.ends[r], last);
        if (s > last) break;
        if (e < s) continue;
        // Column holding row s: last c with bounds[c] <= s.
        while (c + 1 < columns && bounds[c + 1] <= s) c++;
        let k = c;
        let row = s;
        while (row <= e && k < columns) {
            const end = Math.min(e, bounds[k + 1] - 1);
            if (end >= row) nan[k] += end - row + 1;
            row = Math.max(row, bounds[k + 1]);
            k++;
        }
    }
    return { nan, total };
}

/**
 * @param {Array<{key: string, times: ArrayLike<number>, values: ArrayLike<number>,
 *   runs?: {starts: Int32Array, ends: Int32Array, count: number}, monotonic?: boolean}>} sources
 *   one entry per visible trace; `runs` from nanRunIndices(values).
 * @param {number} lo  visible range start, in the units of `times`
 * @param {number} hi  visible range end
 * @param {number} widthPx  plot area width
 * @param {number} [columnPx]
 * @returns {{ regions: Array<{t0: number, t1: number, level: number,
 *   perKey: Object<string, {nan: number, total: number}>}> }}
 *   Bars in time order. `perKey` sums, over the bar's columns, each source's
 *   non-finite and total samples (for the hover).
 */
export function nanStripForView(sources, lo, hi, widthPx, columnPx = NAN_STRIP_COLUMN_PX) {
    const none = { regions: [] };
    let a = Number(lo);
    let b = Number(hi);
    const width = Number(widthPx);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(width > 0)) return none;
    if (a > b) [a, b] = [b, a];
    const step = Math.max(1, Number(columnPx) || NAN_STRIP_COLUMN_PX);
    const columns = Math.max(1, Math.floor(width / step));

    const counted = [];
    for (const source of sources || []) {
        if (!source?.times || !source?.values) continue;
        if (source.runs && !source.runs.count) continue; // nothing missing at all
        counted.push({ key: source.key, ...columnCounts(source, a, b, columns) });
    }
    if (!counted.length) return none;

    const levels = new Uint8Array(columns);
    for (let c = 0; c < columns; c++) {
        let best = 0;
        for (const s of counted) {
            if (s.total[c] > 0 && s.nan[c] > 0) best = Math.max(best, s.nan[c] / s.total[c]);
        }
        levels[c] = nanStripLevel(best);
    }

    const span = b - a;
    const at = (c) => a + (c / columns) * span;
    const regions = [];
    let c = 0;
    while (c < columns) {
        const level = levels[c];
        if (!level) { c++; continue; }
        let end = c;
        while (end + 1 < columns && levels[end + 1] === level) end++;
        const perKey = {};
        for (const s of counted) {
            let nanSum = 0;
            let totalSum = 0;
            for (let k = c; k <= end; k++) { nanSum += s.nan[k]; totalSum += s.total[k]; }
            if (totalSum > 0) perKey[s.key] = { nan: nanSum, total: totalSum };
        }
        regions.push({ t0: at(c), t1: at(end + 1), level, perKey });
        c = end + 1;
    }
    return { regions };
}

/**
 * The same strip from DuckDB buckets (`n_missing / n_total` per bucket, the
 * union across the requested variables). `boundary(i)` maps bucket edge i to
 * display time. Adjacent buckets of one level merge.
 * @returns {Array<{t0: number, t1: number, level: number, nan: number, total: number}>}
 */
export function nanStripFromBuckets(buckets, nBuckets, boundary) {
    const nb = Math.max(1, Math.floor(nBuckets));
    const nan = new Float64Array(nb);
    const total = new Float64Array(nb);
    for (const row of buckets || []) {
        const bi = Math.trunc(Number(row.b));
        if (!(bi >= 0 && bi < nb)) continue;
        total[bi] = Number(row.nTotal) || 0;
        nan[bi] = Number(row.nMissing) || 0;
    }
    const regions = [];
    let i = 0;
    while (i < nb) {
        const level = total[i] > 0 ? nanStripLevel(nan[i] / total[i]) : 0;
        if (!level) { i++; continue; }
        let end = i;
        let nanSum = nan[i];
        let totalSum = total[i];
        while (end + 1 < nb && total[end + 1] > 0 && nanStripLevel(nan[end + 1] / total[end + 1]) === level) {
            end++;
            nanSum += nan[end];
            totalSum += total[end];
        }
        const x0 = Number(boundary(i));
        const x1 = Number(boundary(end + 1));
        if (Number.isFinite(x0) && Number.isFinite(x1) && x1 !== x0) {
            regions.push({ t0: Math.min(x0, x1), t1: Math.max(x0, x1), level, nan: nanSum, total: totalSum });
        }
        i = end + 1;
    }
    return regions;
}

/**
 * NaN runs of one trace as line-break intervals for [lo, hi]: from the last
 * finite sample before a run to the first after it (the span the line must not
 * bridge). Only runs touching the range are materialized. Monotonic time
 * required; returns null when there are more than `limit` runs in view (the
 * caller then skips the breaks: too dense to draw them usefully).
 */
export function nanBreakIntervals(times, runs, lo, hi, limit = Infinity) {
    if (!runs?.count) return [];
    const n = times?.length || 0;
    const a = Number.isFinite(lo) ? lo : -Infinity;
    const b = Number.isFinite(hi) ? hi : Infinity;
    const first = Number.isFinite(a) ? Math.max(0, lowerBound(times, a, 0, n) - 1) : 0;
    const last = Number.isFinite(b) ? Math.min(n - 1, upperBound(times, b, 0, n)) : n - 1;
    let r = lowerBound(runs.ends, first, 0, runs.count);
    const out = [];
    for (; r < runs.count; r++) {
        const s = runs.starts[r];
        const e = runs.ends[r];
        if (s > last) break;
        const t0 = Number(times[s > 0 ? s - 1 : s]);
        const t1 = Number(times[e < n - 1 ? e + 1 : e]);
        if (!(Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0)) continue;
        if (out.length >= limit) return null;
        out.push({ t0, t1 });
    }
    return out;
}

/**
 * Gaps (row index after each gap, from detectGapIndices) as {t0, t1} spans
 * for [lo, hi], materialized only where they touch the range. Null past
 * `limit` (too dense).
 */
export function gapIntervalsInRange(times, gapEnds, lo, hi, limit = Infinity) {
    const count = gapEnds?.length || 0;
    if (!count) return [];
    const a = Number.isFinite(lo) ? lo : -Infinity;
    const b = Number.isFinite(hi) ? hi : Infinity;
    // Gap k spans times[end-1] → times[end]; its end time is ascending in k.
    let loK = 0;
    let hiK = count;
    while (loK < hiK) {
        const mid = (loK + hiK) >>> 1;
        if (Number(times[gapEnds[mid]]) < a) loK = mid + 1;
        else hiK = mid;
    }
    const out = [];
    for (let k = loK; k < count; k++) {
        const i = gapEnds[k];
        const t0 = Number(times[i - 1]);
        const t1 = Number(times[i]);
        if (t0 > b) break;
        if (out.length >= limit) return null;
        out.push({ t0, t1 });
    }
    return out;
}
