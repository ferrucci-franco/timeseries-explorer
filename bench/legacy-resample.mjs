// Verbatim copy of the timeseries visual path as it existed BEFORE the
// src/compute/kernels/resample.js rewrite: `_downsampleTimeseries` plus the
// slice-then-decimate shape `_buildTimeseriesVisualData` used.
//
// Frozen on purpose, same contract as bench/legacy-data-tools.mjs — the test
// asserts against it, the benchmark measures against it. Do not optimize it.

export function refPickIndexed(values, indexes) {
    if (!Array.isArray(indexes) || !indexes.length) return values;
    const picked = new Array(indexes.length);
    for (let i = 0; i < indexes.length; i++) picked[i] = values[indexes[i]];
    return picked;
}

export function refDownsampleTimeseries(xValues, yValues, target) {
    const n = Math.min(xValues?.length || 0, yValues?.length || 0);
    if (n <= target || n <= 2) return { x: xValues, y: yValues };

    const bucketCount = Math.max(1, Math.floor((target - 2) / 2));
    const bucketSize = Math.max(1, Math.ceil((n - 2) / bucketCount));
    const indexes = [0];

    for (let start = 1; start < n - 1; start += bucketSize) {
        const end = Math.min(n - 1, start + bucketSize);
        let minIdx = start;
        let maxIdx = start;
        let minVal = yValues[start];
        let maxVal = yValues[start];

        for (let i = start + 1; i < end; i++) {
            const value = yValues[i];
            if (!Number.isFinite(value)) continue;
            if (!Number.isFinite(minVal) || value < minVal) { minVal = value; minIdx = i; }
            if (!Number.isFinite(maxVal) || value > maxVal) { maxVal = value; maxIdx = i; }
        }

        if (minIdx === maxIdx) {
            if (minIdx > indexes[indexes.length - 1]) indexes.push(minIdx);
        } else if (minIdx < maxIdx) {
            if (minIdx > indexes[indexes.length - 1]) indexes.push(minIdx);
            if (maxIdx > indexes[indexes.length - 1]) indexes.push(maxIdx);
        } else {
            if (maxIdx > indexes[indexes.length - 1]) indexes.push(maxIdx);
            if (minIdx > indexes[indexes.length - 1]) indexes.push(minIdx);
        }
    }

    if (indexes[indexes.length - 1] !== n - 1) indexes.push(n - 1);
    return {
        x: refPickIndexed(xValues, indexes),
        y: refPickIndexed(yValues, indexes),
    };
}

// The exact shape of the old zoom path: slice the visible window out of BOTH
// source arrays, then decimate the copies.
export function refVisualForRange(xValues, yValues, start, end, target) {
    const sliceX = xValues.slice(start, end);
    const sliceY = yValues.slice(start, end);
    if (sliceX.length <= target) return { x: sliceX, y: sliceY };
    return refDownsampleTimeseries(sliceX, sliceY, target);
}

// A trace with structure the min/max decimator has to preserve: a slow carrier
// so buckets have a real min and max, narrow spikes that must survive
// decimation, NaN gaps, and flat stretches where min and max coincide.
export function makeTrace(n, seed = 777) {
    let state = seed >>> 0;
    const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        x[i] = i * 0.01;
        y[i] = 30 * Math.sin(i * 0.0004) + 5 * Math.sin(i * 0.05) + (rand() - 0.5) * 2;
    }
    for (let k = 0; k < Math.max(1, n / 1000); k++) {
        const idx = Math.floor(rand() * n);
        y[idx] += (rand() < 0.5 ? -1 : 1) * 120;
    }
    for (let k = 0; k < Math.max(1, n / 5000); k++) {
        const idx = Math.floor(rand() * Math.max(1, n - 10));
        for (let j = idx; j < Math.min(n, idx + 1 + Math.floor(rand() * 5)); j++) y[j] = NaN;
    }
    for (let k = 0; k < 4; k++) {
        const idx = Math.floor(rand() * Math.max(1, n - 200));
        const v = y[idx];
        for (let j = idx; j < Math.min(n, idx + 150); j++) y[j] = v;
    }
    return { x, y };
}
