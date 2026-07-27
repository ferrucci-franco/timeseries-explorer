// Min/max bucket decimation for the timeseries visual path.
//
// The algorithm is unchanged from the original `_downsampleTimeseries` — same
// bucket sizing, same tie handling, same forced first/last points. What changed
// is that it works over a [start, end) RANGE of the source instead of over a
// freshly sliced copy of it.
//
// That slice was the actual cost of zooming: `_buildTimeseriesVisualData` did
//     const sliceX = timeData.slice(start, end);
//     const sliceY = values.slice(start, end);
// on every relayout event, for every trace. Zoomed to 80% of a 5M-point trace
// that is two 4M-element copies per zoom step, to then throw away all but 2000
// of them.
//
// X is deliberately NOT assumed numeric: `_renderedTracePreview` feeds raw
// Plotly x values through here, which on a calendar axis are strings or Dates.
// So decimation reads only Y, and returns indexes the caller materializes.

// Scratch buffer for the index list. Never handed to Plotly — the output arrays
// are freshly allocated at their exact final size, because Plotly keeps a
// reference to whatever it is given and mutating that later corrupts hover.
let scratchIndexes = new Int32Array(8192);

function ensureScratch(size) {
    if (scratchIndexes.length < size) {
        scratchIndexes = new Int32Array(1 << (32 - Math.clz32(size - 1)));
    }
    return scratchIndexes;
}

/**
 * Decimate y[start..end) to at most `target` points.
 * @returns {{ indexes: Int32Array, count: number }} absolute indexes into y,
 *   ascending. The returned array is a shared scratch buffer: read it, do not
 *   keep it.
 */
export function decimateRangeIndexes(yValues, start, end, target) {
    const n = Math.max(0, end - start);
    // Upper bound on emitted points: first + 2 per bucket + last.
    const indexes = ensureScratch(Math.max(4, target + 4));
    let count = 0;

    if (n <= 0) return { indexes, count: 0 };
    if (n <= target || n <= 2) {
        const flat = ensureScratch(n);
        for (let i = 0; i < n; i++) flat[i] = start + i;
        return { indexes: flat, count: n };
    }

    const bucketCount = Math.max(1, Math.floor((target - 2) / 2));
    const bucketSize = Math.max(1, Math.ceil((n - 2) / bucketCount));

    indexes[count++] = start;
    let last = 0;   // local index of the most recently emitted point

    for (let bucketStart = 1; bucketStart < n - 1; bucketStart += bucketSize) {
        const bucketEnd = Math.min(n - 1, bucketStart + bucketSize);
        let minIdx = bucketStart;
        let maxIdx = bucketStart;
        let minVal = yValues[start + bucketStart];
        let maxVal = minVal;

        for (let i = bucketStart + 1; i < bucketEnd; i++) {
            const value = yValues[start + i];
            if (!Number.isFinite(value)) continue;
            if (!Number.isFinite(minVal) || value < minVal) { minVal = value; minIdx = i; }
            if (!Number.isFinite(maxVal) || value > maxVal) { maxVal = value; maxIdx = i; }
        }

        // Emit in source order so the drawn line never doubles back on itself.
        if (minIdx === maxIdx) {
            if (minIdx > last) { indexes[count++] = start + minIdx; last = minIdx; }
        } else if (minIdx < maxIdx) {
            if (minIdx > last) { indexes[count++] = start + minIdx; last = minIdx; }
            if (maxIdx > last) { indexes[count++] = start + maxIdx; last = maxIdx; }
        } else {
            if (maxIdx > last) { indexes[count++] = start + maxIdx; last = maxIdx; }
            if (minIdx > last) { indexes[count++] = start + minIdx; last = minIdx; }
        }
    }

    if (last !== n - 1) indexes[count++] = start + n - 1;
    return { indexes, count };
}

/**
 * Materialize `src` at the given indexes. Typed sources produce a Float64Array;
 * anything else produces a plain Array, because x can hold Dates or strings.
 */
export function pickAt(src, indexes, count) {
    if (ArrayBuffer.isView(src)) {
        const out = new Float64Array(count);
        for (let i = 0; i < count; i++) out[i] = src[indexes[i]];
        return out;
    }
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = src[indexes[i]];
    return out;
}

/** Copy src[start..end) preserving typedness. */
export function copyRange(src, start, end) {
    const count = Math.max(0, end - start);
    if (ArrayBuffer.isView(src)) return src.subarray(start, start + count).slice();
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = src[start + i];
    return out;
}

/**
 * The visual pair for y[start..end): decimated when the range exceeds `target`,
 * copied verbatim when it does not.
 */
export function visualPairForRange(xValues, yValues, start, end, target) {
    const n = Math.max(0, end - start);
    if (n <= target || n <= 2) {
        return { x: copyRange(xValues, start, end), y: copyRange(yValues, start, end) };
    }
    const { indexes, count } = decimateRangeIndexes(yValues, start, end, target);
    return { x: pickAt(xValues, indexes, count), y: pickAt(yValues, indexes, count) };
}
