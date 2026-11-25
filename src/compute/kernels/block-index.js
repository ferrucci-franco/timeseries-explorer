// Block min/max index of a long typed series, and the queries it answers
// without reading every sample: the extremes of a bucket (for the min/max
// decimation in resample.js) and the finite extent of a range (for an axis
// range — autoscale, Fit Y).
//
// Why: a series held in memory is read whole by both, on every zoom, pan or
// autoscale. A 3½-minute song decoded at 44.1 kHz is 9.5 M samples a channel;
// zoomed out, decimating it was more than half of what a relayout cost, and an
// autoscale scanned every value of every trace and of the time axis (~0.5 s on
// a two-channel recording).
//
// The index records, for each block of BLOCK_SIZE samples, where its smallest
// and largest finite values are — the EARLIEST such index, by a strict
// comparison. A range is then read as its ragged head, the recorded extremes
// of the whole blocks inside it, and its ragged tail: ~2·BLOCK_SIZE +
// range/BLOCK_SIZE reads.
//
// The answers are the same, not close: same indexes, same values. The plain
// scan keeps the earliest index of the smallest (largest) finite value; a
// block keeps its earliest by the same strict comparison, and blocks are
// combined left to right by it too, so the earliest index wins across blocks
// as it does within one (which also settles -0 against 0). Non-finite values
// (NaN, ±Infinity) are skipped by both. scripts/test-resample-kernel.mjs and
// scripts/test-block-index.mjs compare them on NaN runs, ±Infinity, ties, -0
// and Float32 storage.
//
// The index is cached per array (WeakMap: it goes with the array) and trusted
// while the array keeps its length. That is the contract the plot already
// relies on for a signal's values (data-methods.js, _getTransformedVariableData
// caches by the same two): a series that changes is a new array — a data tool,
// a reload, a transform, a live append (a new subarray) — never the same one
// written over. Only typed arrays are indexed: they hold every numeric signal,
// and a plain array is what a caller may still be filling.
//
// Memory: two Int32 per block (and per super block), 1/8 of a byte per
// sample — 1.2 MB for 9.5 M samples, beside the 38 MB (Float32) or 76 MB
// (Float64) of the series itself.
//
// Pure: no DOM, no Plotly.

export const BLOCK_SIZE = 64;
// Below this length a scan is already cheap, and the index not worth keeping.
export const BLOCK_INDEX_MIN_LENGTH = 1 << 18;
// A range narrower than this has too few whole blocks in it to gain.
export const BLOCK_BUCKET_MIN = 8 * BLOCK_SIZE;

const blockIndexes = new WeakMap();

// A second level, of SUPER blocks (SUPER_SIZE blocks each), keeps a whole-record
// query to a few thousand reads: one per block of a 9.5 M-sample song would
// be 150 000, each to a different place in memory.
export const SUPER_SIZE = 64;

function buildBlockIndex(y) {
    const n = y.length;
    const blocks = Math.ceil(n / BLOCK_SIZE);
    const minAt = new Int32Array(blocks);
    const maxAt = new Int32Array(blocks);
    for (let b = 0; b < blocks; b++) {
        const from = b * BLOCK_SIZE;
        const to = Math.min(n, from + BLOCK_SIZE);
        let minIdx = -1;
        let maxIdx = -1;
        let minVal = 0;
        let maxVal = 0;
        for (let i = from; i < to; i++) {
            const value = y[i];
            if (!Number.isFinite(value)) continue;
            if (minIdx < 0 || value < minVal) { minVal = value; minIdx = i; }
            if (maxIdx < 0 || value > maxVal) { maxVal = value; maxIdx = i; }
        }
        minAt[b] = minIdx;
        maxAt[b] = maxIdx;
    }
    // Each super block from its blocks, left to right, by the same strict
    // comparison: its earliest extreme.
    const supers = Math.ceil(blocks / SUPER_SIZE);
    const superMinAt = new Int32Array(supers);
    const superMaxAt = new Int32Array(supers);
    for (let s = 0; s < supers; s++) {
        reset();
        takeBlocks(y, minAt, maxAt, s * SUPER_SIZE, Math.min(blocks, (s + 1) * SUPER_SIZE));
        superMinAt[s] = minIdx;
        superMaxAt[s] = maxIdx;
    }
    return { length: n, minAt, maxAt, superMinAt, superMaxAt };
}

/** The block index of `y`, built on first use; null where it does not apply. */
export function blockIndexFor(y) {
    if (!ArrayBuffer.isView(y) || y.length < BLOCK_INDEX_MIN_LENGTH) return null;
    const cached = blockIndexes.get(y);
    if (cached && cached.length === y.length) return cached;
    const index = buildBlockIndex(y);
    blockIndexes.set(y, index);
    return index;
}

// The running answer of a query, as it is read left to right. Module state
// rather than an object per call: a zoom asks a thousand of them.
let minIdx = -1;
let maxIdx = -1;
let minVal = 0;
let maxVal = 0;

function reset() {
    minIdx = -1;
    maxIdx = -1;
    minVal = 0;
    maxVal = 0;
}

// Samples y[from..to).
function takeSamples(y, from, to) {
    for (let i = from; i < to; i++) {
        const value = y[i];
        if (!Number.isFinite(value)) continue;
        if (minIdx < 0 || value < minVal) { minVal = value; minIdx = i; }
        if (maxIdx < 0 || value > maxVal) { maxVal = value; maxIdx = i; }
    }
}

// Units [from..to) of one level: their recorded extremes (-1: none finite).
function takeBlocks(y, lowAt, highAt, from, to) {
    for (let b = from; b < to; b++) {
        const lo = lowAt[b];
        if (lo < 0) continue;
        const low = y[lo];
        if (minIdx < 0 || low < minVal) { minVal = low; minIdx = lo; }
        const hi = highAt[b];
        const high = y[hi];
        if (maxIdx < 0 || high > maxVal) { maxVal = high; maxIdx = hi; }
    }
}

// Returned by indexedExtremes: one object, overwritten by every call (it runs
// once per bucket, a thousand times per zoom). Read it, do not keep it.
const found = { minAt: -1, maxAt: -1 };

/**
 * Earliest index of the smallest and of the largest finite value in
 * y[from..to), read through `index` (blockIndexFor(y)); -1 where the range has
 * no finite value. The result object is shared: read it, do not keep it.
 *
 * Read left to right: the samples before the first whole block, the whole
 * blocks before the first whole super block, the whole super blocks, the
 * whole blocks after them, the samples after those.
 */
export function indexedExtremes(y, index, from, to) {
    reset();
    const headBlock = Math.ceil(from / BLOCK_SIZE);
    const tailBlock = Math.floor(to / BLOCK_SIZE);
    if (headBlock >= tailBlock) {
        takeSamples(y, from, to);
    } else {
        takeSamples(y, from, headBlock * BLOCK_SIZE);
        const headSuper = Math.ceil(headBlock / SUPER_SIZE);
        const tailSuper = Math.floor(tailBlock / SUPER_SIZE);
        if (headSuper < tailSuper) {
            takeBlocks(y, index.minAt, index.maxAt, headBlock, headSuper * SUPER_SIZE);
            takeBlocks(y, index.superMinAt, index.superMaxAt, headSuper, tailSuper);
            takeBlocks(y, index.minAt, index.maxAt, tailSuper * SUPER_SIZE, tailBlock);
        } else {
            takeBlocks(y, index.minAt, index.maxAt, headBlock, tailBlock);
        }
        takeSamples(y, tailBlock * BLOCK_SIZE, to);
    }
    found.minAt = minIdx;
    found.maxAt = maxIdx;
    return found;
}

/**
 * The smallest and largest finite value of y[from..to) — `{ min: Infinity,
 * max: -Infinity }` when it has none — through the block index where it
 * applies, by a plain scan otherwise. The same numbers either way.
 *
 * `y` is a typed array or a plain array of numbers; values are not converted
 * (a string is not finite here), as in the scans it replaces.
 */
export function finiteRangeExtent(y, from = 0, to = y?.length ?? 0) {
    const start = Math.max(0, from);
    const end = Math.min(y?.length ?? 0, to);
    const index = end - start >= BLOCK_BUCKET_MIN ? blockIndexFor(y) : null;
    if (index) {
        const { minAt, maxAt } = indexedExtremes(y, index, start, end);
        return minAt >= 0 ? { min: y[minAt], max: y[maxAt] } : { min: Infinity, max: -Infinity };
    }
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end; i++) {
        const value = y[i];
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    return { min, max };
}

const sortedAxes = new WeakMap();

/**
 * Whether `x` is a typed array of finite values in non-decreasing order — the
 * shape of almost every time axis. On one, the samples inside an x window are
 * one contiguous run, found by binary search instead of a test per sample.
 * Remembered per array and length, as the block index is.
 */
export function isSortedFiniteAxis(x) {
    if (!ArrayBuffer.isView(x)) return false;
    const cached = sortedAxes.get(x);
    if (cached && cached.length === x.length) return cached.sorted;
    let sorted = true;
    let previous = -Infinity;
    for (let i = 0; i < x.length; i++) {
        const value = x[i];
        if (!Number.isFinite(value) || value < previous) { sorted = false; break; }
        previous = value;
    }
    sortedAxes.set(x, { length: x.length, sorted });
    return sorted;
}

/** First index of the sorted `x` whose value is >= `target`. */
export function sortedLowerBound(x, target, end = x.length) {
    let lo = 0;
    let hi = end;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** First index of the sorted `x` whose value is > `target`. */
export function sortedUpperBound(x, target, end = x.length) {
    let lo = 0;
    let hi = end;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
