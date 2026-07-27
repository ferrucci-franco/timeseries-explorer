import {
    asFloat64,
    copyFloat64,
    DataToolError,
    positiveNumber,
    quantileSorted,
    spikeParamsFromSensitivity,
    zeroMadTolerance,
} from './shared.js';

// ─── Spike detection ──────────────────────────────────────────────────────
//
// The original implementation, for EVERY sample, built a scratch array of the
// 51-wide window, sorted it, mapped it into a second array of absolute
// deviations, and sorted that too. Two heap allocations and ~600 comparator
// calls per sample: at 7.5M rows that is 15M short-lived arrays, which is why
// moving the sensitivity slider froze the tab for seconds.
//
// This version keeps the window itself sorted as it slides (binary-search
// insert / delete into a fixed 51-slot Float64Array) so the median is a rank
// lookup, and obtains the MAD without ever materializing the deviations:
// against a sorted window the deviations split into two already-ascending runs
// (med - s[j] walking left, s[j] - med walking right), so the median deviation
// is the k-th element of a merge of two sorted sequences — a ~27-step
// two-pointer walk with no allocation.
//
// Results are bit-for-bit identical to the sorted-scratch version: same
// multiset, same ranks, and `Math.abs(a - b)` for a <= b is exactly `b - a` in
// IEEE-754, so the deviation values themselves are unchanged.

// Interpolated quantile over a Float64Array prefix.
//
// This duplicates shared.js's quantileSorted on purpose. The run filter below
// calls the shared one with plain Arrays; if the hot detection loop called it
// too, that call site would go polymorphic and V8 would deoptimize it. Measured
// at 7.5M rows: 3.2 s on the first pass (monomorphic, before the run filter has
// ever run) and 11.5 s on every pass after it — a 3.6x cliff from one shared
// helper. Keeping the typed path monomorphic is what removes that cliff.
function quantileTyped(sorted, p, length) {
    if (!length) return NaN;
    const pos = (length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = base + 1 < length ? sorted[base + 1] : undefined;
    return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

// Insert `value` into the ascending prefix sorted[0..count-1]. Returns count+1.
function sortedInsert(sorted, count, value) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    sorted.copyWithin(lo + 1, lo, count);
    sorted[lo] = value;
    return count + 1;
}

// Remove one occurrence of `value`. Returns count-1 (or count if absent).
function sortedRemove(sorted, count, value) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    if (lo >= count || sorted[lo] !== value) return count;
    sorted.copyWithin(lo, lo + 1, count);
    return count - 1;
}

// First index whose value is strictly greater than `pivot`.
function upperBound(sorted, count, pivot) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= pivot) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Median absolute deviation of the sorted window around `median`, computed by
// merging the two monotone deviation runs. Equivalent to
// quantileSorted(window.map(v => Math.abs(v - median)).sort(), 0.5).
function medianAbsoluteDeviation(sorted, count, median) {
    if (!count) return NaN;
    const split = upperBound(sorted, count, median);
    const pos = (count - 1) * 0.5;
    const base = Math.floor(pos);
    const rest = pos - base;
    const limit = Math.min(base + 1, count - 1);

    let li = 0;              // walking left run: med - sorted[split-1-li]
    let ri = 0;              // walking right run: sorted[split+ri] - med
    let atBase = NaN;
    let atNext;

    for (let c = 0; c <= limit; c++) {
        const lv = li < split ? median - sorted[split - 1 - li] : Infinity;
        const rv = split + ri < count ? sorted[split + ri] - median : Infinity;
        let value;
        if (lv <= rv) { value = lv; li++; } else { value = rv; ri++; }
        if (c === base) atBase = value;
        else if (c === base + 1) atNext = value;
    }
    return atNext === undefined ? atBase : atBase + rest * (atNext - atBase);
}

// The scan is kept in its own function, taking and returning only typed arrays
// and numbers.
//
// This is not stylistic. When the loop lived inside detectSpikeOutliers — which
// also reads `params.sensitivity`, pushes into a JSArray and calls the
// plain-Array run filter — V8 deoptimized it after the first invocation
// ("Insufficient type feedback for generic keyed access") and never recovered:
// 2.5 s on the first call, 11 s on every call after it, on the same 7.5M-row
// input. Nothing here touches a JSArray or an object property, so there is no
// site that can go generic.
//
// `out` is written up to its capacity; `found` is the true candidate count and
// may exceed it, which tells the caller to re-scan with a bigger buffer. It is
// deliberately NOT grown in place: a grow branch inside the loop is cold, so
// the first time it is taken V8 hits a site with no type feedback and bails out
// of the optimized code — and once that happened, every later call ran ~4x
// slower for the rest of the process. Overflow is rare (candidates are well
// under 1% of samples in practice), so paying for one extra scan when it does
// happen is far cheaper than poisoning the common path.
function scanSpikeCandidates(src, threshold, half, out) {
    const n = src.length;
    const capacity = out.length;
    const sorted = new Float64Array(2 * half + 2);
    const buffer = out;
    let found = 0;
    let count = 0;
    let lo = 0;
    let hi = -1;

    for (let i = 0; i < n; i++) {
        const nextLo = i - half > 0 ? i - half : 0;
        const nextHi = i + half < n - 1 ? i + half : n - 1;
        while (hi < nextHi) {
            const value = src[++hi];
            if (Number.isFinite(value)) count = sortedInsert(sorted, count, value);
        }
        while (lo < nextLo) {
            const value = src[lo++];
            if (Number.isFinite(value)) count = sortedRemove(sorted, count, value);
        }

        const value = src[i];
        if (!Number.isFinite(value)) continue;
        if (count < 3) continue;

        const median = quantileTyped(sorted, 0.5, count);
        const mad = medianAbsoluteDeviation(sorted, count, median);
        // zeroMadTolerance() inlined: it is only reached on a flat window, so as
        // a call it is a cold site inside a hot loop — exactly the shape that
        // costs the whole function its optimized code on first use.
        const scale = mad > 0
            ? 1.4826 * mad
            : Math.max(Number.EPSILON * 32 * Math.max(1, Math.abs(median)), 1e-12);
        if (Math.abs(value - median) > threshold * scale) {
            if (found < capacity) buffer[found] = i;
            found++;
        }
    }
    return found;
}

export function detectSpikeOutliers(values, params = {}) {
    const src = asFloat64(values);
    const n = src.length;
    if (!n) return [];

    const spike = spikeParamsFromSensitivity(params.sensitivity);
    const half = Math.floor(spike.window / 2);

    // ~3% of samples is far above any realistic candidate rate; the re-scan
    // below is the correctness net for the pathological case.
    let buffer = new Int32Array(Math.max(4096, Math.min(n, n >> 5)));
    let found = scanSpikeCandidates(src, spike.threshold, half, buffer);
    if (found > buffer.length) {
        buffer = new Int32Array(found);
        found = scanSpikeCandidates(src, spike.threshold, half, buffer);
    }

    const indexes = new Array(found);
    for (let i = 0; i < found; i++) indexes[i] = buffer[i];
    return keepReturningOutlierRuns(indexes, src, spike.maxRun, half, spike.threshold);
}

export function detectBoundsOutliers(values, params = {}) {
    const hasLower = Number.isFinite(Number(params.lower));
    const hasUpper = Number.isFinite(Number(params.upper));
    if (!hasLower && !hasUpper) throw new DataToolError('outlierBoundsMissing');
    const lower = hasLower ? Number(params.lower) : -Infinity;
    const upper = hasUpper ? Number(params.upper) : Infinity;
    if (lower > upper) throw new DataToolError('outlierBoundsInvalid');

    const src = asFloat64(values);
    const indexes = [];
    for (let i = 0; i < src.length; i++) {
        const value = src[i];
        if (Number.isFinite(value) && (value < lower || value > upper)) indexes.push(i);
    }
    return indexes;
}

export function detectIqrOutliers(values, params = {}) {
    const src = asFloat64(values);
    // Typed sort with no comparator: TypedArray#sort is numeric by definition,
    // so this drops both the boxed intermediate array and the per-comparison
    // callback the original `.filter().sort((a,b) => a-b)` paid for.
    const finite = new Float64Array(src.length);
    let m = 0;
    for (let i = 0; i < src.length; i++) {
        const value = src[i];
        if (Number.isFinite(value)) finite[m++] = value;
    }
    if (m < 4) throw new DataToolError('outlierNotEnoughData');
    const sorted = finite.subarray(0, m);
    sorted.sort();

    const factor = positiveNumber(params.factor ?? params.iqrFactor, 1.5);
    const q1 = quantileTyped(sorted, 0.25, m);
    const q3 = quantileTyped(sorted, 0.75, m);
    const iqr = q3 - q1;
    const low = iqr > 0 ? q1 - factor * iqr : q1;
    const high = iqr > 0 ? q3 + factor * iqr : q3;

    const indexes = [];
    for (let i = 0; i < src.length; i++) {
        const value = src[i];
        if (Number.isFinite(value) && (value < low || value > high)) indexes.push(i);
    }
    return indexes;
}

export function detectOutlierIndexes(values, method, params = {}) {
    if (method === 'bounds') return detectBoundsOutliers(values, params);
    if (method === 'iqr') return detectIqrOutliers(values, params);
    return detectSpikeOutliers(values, params);
}

// ─── Run filtering ────────────────────────────────────────────────────────
// Unchanged logic: these only ever run over the (few) detected candidates, not
// over the whole signal, so they were never the bottleneck.

function finiteValuesInRange(values, start, end) {
    const out = [];
    for (let i = start; i <= end; i++) {
        const value = Number(values?.[i]);
        if (Number.isFinite(value)) out.push(value);
    }
    return out;
}

function median(values) {
    return quantileSorted(values.slice().sort((a, b) => a - b), 0.5);
}

function outlierRunReturns(run, values, halfWindow, threshold, maxRun) {
    const start = run[0];
    const end = run[run.length - 1];
    const left = finiteValuesInRange(values, Math.max(0, start - halfWindow), start - 1);
    const right = finiteValuesInRange(values, end + 1, Math.min((values?.length || 0) - 1, end + halfWindow));
    if (!left.length || !right.length) return false;

    const leftMedian = median(left);
    const rightMedian = median(right);
    const surroundings = left.concat(right).sort((a, b) => a - b);
    const surroundingMedian = quantileSorted(surroundings, 0.5);
    const deviations = surroundings.map(v => Math.abs(v - surroundingMedian)).sort((a, b) => a - b);
    const mad = quantileSorted(deviations, 0.5);
    const scale = mad > 0 ? 1.4826 * mad : zeroMadTolerance(surroundingMedian);
    if (Math.abs(leftMedian - rightMedian) > threshold * scale) return false;

    const runValues = run
        .map(index => Number(values[index]))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if (!runValues.length) return false;
    const runMedian = quantileSorted(runValues, 0.5);
    const runTolerance = Math.max(threshold * scale, zeroMadTolerance(runMedian));
    let expandedStart = start;
    while (expandedStart > 0) {
        const value = Number(values[expandedStart - 1]);
        if (!Number.isFinite(value) || Math.abs(value - runMedian) > runTolerance) break;
        expandedStart--;
    }
    let expandedEnd = end;
    while (expandedEnd + 1 < (values?.length || 0)) {
        const value = Number(values[expandedEnd + 1]);
        if (!Number.isFinite(value) || Math.abs(value - runMedian) > runTolerance) break;
        expandedEnd++;
    }
    if (expandedEnd - expandedStart + 1 > maxRun) return false;
    return Math.abs(runMedian - surroundingMedian) > threshold * scale;
}

export function keepReturningOutlierRuns(indexes, values, maxRun, halfWindow, threshold) {
    if (!indexes.length) return indexes;
    const kept = [];
    let run = [indexes[0]];
    const flush = () => {
        if (run.length <= maxRun && outlierRunReturns(run, values, halfWindow, threshold, maxRun)) kept.push(...run);
    };
    for (let i = 1; i < indexes.length; i++) {
        if (indexes[i] === indexes[i - 1] + 1) {
            run.push(indexes[i]);
        } else {
            flush();
            run = [indexes[i]];
        }
    }
    flush();
    return kept;
}

// ─── Replacement ──────────────────────────────────────────────────────────

export function replaceOutliersWithNaN(values, outlierIndexes) {
    const cleaned = copyFloat64(values);
    for (let i = 0; i < outlierIndexes.length; i++) cleaned[outlierIndexes[i]] = NaN;
    return cleaned;
}

export function interpolateOutliers(values, outlierIndexes) {
    const src = asFloat64(values);
    const n = src.length;
    const cleaned = copyFloat64(src);
    if (!n || !outlierIndexes?.length) return cleaned;

    // O(n): two passes precompute the nearest VALID (non-outlier, finite)
    // neighbour on each side. Uint8Array/Int32Array instead of boxed arrays and
    // a flag array instead of a Set — at 7.5M rows the Set alone was hundreds
    // of megabytes.
    const invalid = new Uint8Array(n);
    for (let i = 0; i < outlierIndexes.length; i++) invalid[outlierIndexes[i]] = 1;

    const prevValid = new Int32Array(n);
    let last = -1;
    for (let i = 0; i < n; i++) {
        if (!invalid[i] && Number.isFinite(src[i])) last = i;
        prevValid[i] = last;
    }
    const nextValid = new Int32Array(n);
    let next = -1;
    for (let i = n - 1; i >= 0; i--) {
        if (!invalid[i] && Number.isFinite(src[i])) next = i;
        nextValid[i] = next;
    }

    for (let k = 0; k < outlierIndexes.length; k++) {
        const index = outlierIndexes[k];
        const left = prevValid[index];
        const right = nextValid[index];
        if (left >= 0 && right >= 0) {
            const l = src[left];
            const r = src[right];
            cleaned[index] = l + ((index - left) / (right - left)) * (r - l);
        } else {
            cleaned[index] = NaN;
        }
    }
    return cleaned;
}
