// Verbatim copies of the Data Tools implementations as they existed BEFORE the
// src/compute/kernels/* rewrite, plus the fixture generators both the
// differential test and the benchmark share.
//
// These are kept frozen on purpose. scripts/test-compute-kernels.mjs asserts the
// new kernels agree with them bit-for-bit, and scripts/bench-data-tools.mjs
// measures against them. Do not "fix" or optimize anything in this file: its
// only job is to preserve what the old behaviour and the old cost were.

// ─── Reference (original) implementations ─────────────────────────────────

export const DERIVATIVE_METHODS = new Set(['centered', 'forward', 'backward', 'difference']);
export const INTEGRAL_METHODS = new Set(['trapezoidal', 'rectangular']);

export const refQuantileSorted = (sorted, p) => {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = sorted[base + 1];
    return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
};
export const refZeroMadTolerance = (median) =>
    Math.max(Number.EPSILON * 32 * Math.max(1, Math.abs(Number(median) || 0)), 1e-12);
export const refPositiveNumber = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const refNormalizeSensitivity = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 6;
};
export const refSpikeParams = (sensitivity) => {
    const level = refNormalizeSensitivity(sensitivity);
    const maxRuns = [1, 2, 3, 4, 5, 6, 8, 10, 13, 16];
    return { window: 51, threshold: Math.max(4, 12 - level), maxRun: maxRuns[level - 1] };
};
export const refNormalizeWindow = (value, maxLength = Infinity) => {
    let n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = 21;
    const max = Number.isFinite(maxLength) ? Math.max(2, Math.round(maxLength)) : Number.MAX_SAFE_INTEGER;
    return Math.max(2, Math.min(max, n));
};
export const refDelta = (time, a, b) => {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return NaN;
    if (time.kind === 'index' || !time.values) return b - a;
    const t0 = Number(time.values[a]);
    const t1 = Number(time.values[b]);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return NaN;
    const delta = t1 - t0;
    return time.kind === 'datetime' ? delta / 1000 : delta;
};

export function refDerivative(sourceValues, time, params = {}) {
    const values = Array.from(sourceValues || [], Number);
    const n = values.length;
    const out = new Array(n).fill(NaN);
    if (n < 2) return { values: out };
    const method = DERIVATIVE_METHODS.has(params.method) ? params.method : 'centered';
    if (method === 'difference') {
        const delta = (a, b) => {
            const y0 = Number(values[a]);
            const y1 = Number(values[b]);
            return (Number.isFinite(y0) && Number.isFinite(y1)) ? y1 - y0 : NaN;
        };
        for (let i = 0; i < n; i++) out[i] = i === 0 ? delta(0, 1) : delta(i - 1, i);
        return { values: out };
    }
    const diff = (a, b) => {
        const y0 = Number(values[a]);
        const y1 = Number(values[b]);
        const dt = refDelta(time, a, b);
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(dt) || dt === 0) return NaN;
        return (y1 - y0) / dt;
    };
    for (let i = 0; i < n; i++) {
        if (method === 'forward') out[i] = i < n - 1 ? diff(i, i + 1) : diff(i - 1, i);
        else if (method === 'backward') out[i] = i > 0 ? diff(i - 1, i) : diff(i, i + 1);
        else out[i] = i === 0 ? diff(0, 1) : (i === n - 1 ? diff(n - 2, n - 1) : diff(i - 1, i + 1));
    }
    return { values: out };
}

export function refIntegral(sourceValues, time, params = {}) {
    const values = Array.from(sourceValues || [], Number);
    const n = values.length;
    const out = new Array(n).fill(0);
    if (!n) return { values: out, negativeDtCount: 0 };
    const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    let acc = 0;
    let negativeDtCount = 0;
    for (let i = 1; i < n; i++) {
        const dt = refDelta(time, i - 1, i);
        if (Number.isFinite(dt)) {
            if (dt < 0) negativeDtCount++;
            const y0 = Number(values[i - 1]);
            const y1 = Number(values[i]);
            if (method === 'rectangular') {
                if (Number.isFinite(y0)) acc += y0 * dt;
            } else if (Number.isFinite(y0) && Number.isFinite(y1)) {
                acc += 0.5 * (y0 + y1) * dt;
            }
        }
        out[i] = acc;
    }
    return { values: out, negativeDtCount };
}

export function refMovingAverage(sourceValues, params = {}) {
    const values = Array.from(sourceValues || [], Number);
    const n = values.length;
    const window = refNormalizeWindow(params.window, n);
    const left = Math.floor((window - 1) / 2);
    const right = window - left - 1;
    const out = new Array(n).fill(NaN);
    let start = 0;
    let end = -1;
    let sum = 0;
    let count = 0;
    const add = (index) => {
        const value = Number(values[index]);
        if (!Number.isFinite(value)) return;
        sum += value; count++;
    };
    const remove = (index) => {
        const value = Number(values[index]);
        if (!Number.isFinite(value)) return;
        sum -= value; count--;
    };
    for (let i = 0; i < n; i++) {
        const nextStart = Math.max(0, i - left);
        const nextEnd = Math.min(n - 1, i + right);
        while (end < nextEnd) add(++end);
        while (start < nextStart) remove(start++);
        out[i] = count ? sum / count : NaN;
    }
    return out;
}

export const refFiniteValuesInRange = (values, start, end) => {
    const out = [];
    for (let i = start; i <= end; i++) {
        const value = Number(values?.[i]);
        if (Number.isFinite(value)) out.push(value);
    }
    return out;
};
export const refMedian = (values) => refQuantileSorted(values.slice().sort((a, b) => a - b), 0.5);

export function refOutlierRunReturns(run, values, halfWindow, threshold, maxRun) {
    const start = run[0];
    const end = run[run.length - 1];
    const left = refFiniteValuesInRange(values, Math.max(0, start - halfWindow), start - 1);
    const right = refFiniteValuesInRange(values, end + 1, Math.min((values?.length || 0) - 1, end + halfWindow));
    if (!left.length || !right.length) return false;
    const leftMedian = refMedian(left);
    const rightMedian = refMedian(right);
    const surroundings = left.concat(right).sort((a, b) => a - b);
    const surroundingMedian = refQuantileSorted(surroundings, 0.5);
    const deviations = surroundings.map(v => Math.abs(v - surroundingMedian)).sort((a, b) => a - b);
    const mad = refQuantileSorted(deviations, 0.5);
    const scale = mad > 0 ? 1.4826 * mad : refZeroMadTolerance(surroundingMedian);
    if (Math.abs(leftMedian - rightMedian) > threshold * scale) return false;
    const runValues = run.map(i => Number(values[i])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!runValues.length) return false;
    const runMedian = refQuantileSorted(runValues, 0.5);
    const runTolerance = Math.max(threshold * scale, refZeroMadTolerance(runMedian));
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

export function refKeepRuns(indexes, values, maxRun, halfWindow, threshold) {
    if (!indexes.length) return indexes;
    const kept = [];
    let run = [indexes[0]];
    const flush = () => {
        if (run.length <= maxRun && refOutlierRunReturns(run, values, halfWindow, threshold, maxRun)) kept.push(...run);
    };
    for (let i = 1; i < indexes.length; i++) {
        if (indexes[i] === indexes[i - 1] + 1) run.push(indexes[i]);
        else { flush(); run = [indexes[i]]; }
    }
    flush();
    return kept;
}

export function refDetectSpikeOutliers(values, params = {}) {
    const spike = refSpikeParams(params.sensitivity);
    const { window, threshold, maxRun } = spike;
    const half = Math.floor(window / 2);
    const indexes = [];
    const n = Number(values?.length) || 0;
    for (let i = 0; i < n; i++) {
        const value = Number(values[i]);
        if (!Number.isFinite(value)) continue;
        const start = Math.max(0, i - half);
        const end = Math.min(n - 1, i + half);
        const local = [];
        for (let j = start; j <= end; j++) {
            const neighbor = Number(values[j]);
            if (Number.isFinite(neighbor)) local.push(neighbor);
        }
        if (local.length < 3) continue;
        local.sort((a, b) => a - b);
        const median = refQuantileSorted(local, 0.5);
        const deviations = local.map(v => Math.abs(v - median)).sort((a, b) => a - b);
        const mad = refQuantileSorted(deviations, 0.5);
        const scale = mad > 0 ? 1.4826 * mad : refZeroMadTolerance(median);
        if (Math.abs(value - median) > threshold * scale) indexes.push(i);
    }
    return refKeepRuns(indexes, values, maxRun, half, threshold);
}

export function refDetectBounds(values, params = {}) {
    const hasLower = Number.isFinite(Number(params.lower));
    const hasUpper = Number.isFinite(Number(params.upper));
    if (!hasLower && !hasUpper) throw new Error('outlierBoundsMissing');
    const lower = hasLower ? Number(params.lower) : -Infinity;
    const upper = hasUpper ? Number(params.upper) : Infinity;
    if (lower > upper) throw new Error('outlierBoundsInvalid');
    const indexes = [];
    for (let i = 0; i < (values?.length || 0); i++) {
        const value = Number(values[i]);
        if (Number.isFinite(value) && (value < lower || value > upper)) indexes.push(i);
    }
    return indexes;
}

export function refDetectIqr(values, params = {}) {
    const finite = Array.from(values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (finite.length < 4) throw new Error('outlierNotEnoughData');
    const factor = refPositiveNumber(params.factor ?? params.iqrFactor, 1.5);
    const q1 = refQuantileSorted(finite, 0.25);
    const q3 = refQuantileSorted(finite, 0.75);
    const iqr = q3 - q1;
    const low = iqr > 0 ? q1 - factor * iqr : q1;
    const high = iqr > 0 ? q3 + factor * iqr : q3;
    const indexes = [];
    for (let i = 0; i < (values?.length || 0); i++) {
        const value = Number(values[i]);
        if (Number.isFinite(value) && (value < low || value > high)) indexes.push(i);
    }
    return indexes;
}

export function refDetectOutlierIndexes(values, method, params = {}) {
    if (method === 'bounds') return refDetectBounds(values, params);
    if (method === 'iqr') return refDetectIqr(values, params);
    return refDetectSpikeOutliers(values, params);
}

export function refReplaceWithNaN(values, outlierIndexes) {
    const cleaned = Array.from(values || []);
    outlierIndexes.forEach(index => { cleaned[index] = NaN; });
    return cleaned;
}

export function refInterpolate(values, outlierIndexes) {
    const n = values?.length || 0;
    const cleaned = Array.from(values || []);
    if (!n || !outlierIndexes?.length) return cleaned;
    const outlierSet = new Set(outlierIndexes);
    const valid = new Array(n);
    for (let i = 0; i < n; i++) valid[i] = !outlierSet.has(i) && Number.isFinite(Number(values[i]));
    const prevValid = new Array(n);
    let last = -1;
    for (let i = 0; i < n; i++) { if (valid[i]) last = i; prevValid[i] = last; }
    const nextValid = new Array(n);
    let next = -1;
    for (let i = n - 1; i >= 0; i--) { if (valid[i]) next = i; nextValid[i] = next; }
    for (const index of outlierIndexes) {
        const left = prevValid[index];
        const right = nextValid[index];
        if (left >= 0 && right >= 0) {
            const l = Number(values[left]);
            const r = Number(values[right]);
            cleaned[index] = l + ((index - left) / (right - left)) * (r - l);
        } else {
            cleaned[index] = NaN;
        }
    }
    return cleaned;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

// Small deterministic PRNG so the corpus is reproducible without a dependency.
function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

export function makeSignal(n, seed = 12345, options = {}) {
    const rng = makeRng(seed);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        values[i] = 40 * Math.sin(i * 0.01) + 8 * Math.sin(i * 0.13) + (rng() - 0.5) * 4;
    }
    if (options.spikes !== false) {
        const count = Math.max(1, Math.round(n * (options.spikeRate ?? 0.001)));
        for (let k = 0; k < count; k++) {
            const idx = Math.floor(rng() * n);
            values[idx] += (rng() < 0.5 ? -1 : 1) * (60 + rng() * 200);
        }
    }
    if (options.nans !== false) {
        const count = Math.max(1, Math.round(n * (options.nanRate ?? 0.0008)));
        for (let k = 0; k < count; k++) {
            const idx = Math.floor(rng() * n);
            const run = 1 + Math.floor(rng() * 4);
            for (let j = idx; j < Math.min(n, idx + run); j++) values[j] = NaN;
        }
    }
    if (options.plateaus) {
        // Constant stretches: MAD == 0, which drives the zeroMadTolerance branch.
        for (let k = 0; k < 5; k++) {
            const idx = Math.floor(rng() * Math.max(1, n - 80));
            const value = values[idx];
            for (let j = idx; j < Math.min(n, idx + 70); j++) values[j] = value;
        }
    }
    return values;
}

export function makeTime(n, kind = 'numeric', seed = 999) {
    const rng = makeRng(seed);
    const values = new Float64Array(n);
    let t = kind === 'datetime' ? 1767225600000 : 0;
    const step = kind === 'datetime' ? 10 : 0.01;
    for (let i = 0; i < n; i++) {
        values[i] = t;
        // Jitter, occasional duplicate timestamps (Δt = 0) and occasional gaps.
        const roll = rng();
        if (roll < 0.02) t += 0;
        else if (roll < 0.04) t += step * 40;
        else t += step;
    }
    return { values, kind };
}
