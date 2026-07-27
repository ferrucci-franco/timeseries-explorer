import { asFloat64, normalizeMovingAverageWindow } from './shared.js';

// Centred moving average over a sliding window, skipping non-finite samples.
//
// The original was already an O(n) running sum — the only changes here are
// typed input/output and inlining the add/remove closures. The running sum is
// order-sensitive in floating point, so the add/remove sequence is preserved
// exactly as it was rather than recomputed per window.
export function computeMovingAverage(sourceValues, params = {}) {
    const values = asFloat64(sourceValues);
    const n = values.length;
    const window = normalizeMovingAverageWindow(params.window, n);
    const left = Math.floor((window - 1) / 2);
    const right = window - left - 1;
    const out = new Float64Array(n).fill(NaN);

    let start = 0;
    let end = -1;
    let sum = 0;
    let count = 0;

    for (let i = 0; i < n; i++) {
        const nextStart = i - left > 0 ? i - left : 0;
        const nextEnd = i + right < n - 1 ? i + right : n - 1;
        while (end < nextEnd) {
            const value = values[++end];
            if (Number.isFinite(value)) { sum += value; count++; }
        }
        while (start < nextStart) {
            const value = values[start++];
            if (Number.isFinite(value)) { sum -= value; count--; }
        }
        out[i] = count ? sum / count : NaN;
    }
    return out;
}
