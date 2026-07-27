// Shared primitives for the Data Tools kernels.
//
// Everything in src/compute/ is pure: no DOM, no i18n, no `this`. That is what
// lets the same code run on the main thread and inside compute-worker.js.
// Errors carry a stable `code` instead of a translated string; the UI layer
// (data-tools-methods.js) maps the code back to i18n.t(). Adding a message here
// would drag the whole translation table into the worker bundle.

export class DataToolError extends Error {
    constructor(code, message = code) {
        super(message);
        this.name = 'DataToolError';
        this.code = code;
    }
}

// Read-only view as Float64Array. An existing Float64Array is returned as-is
// (no copy) because every kernel below only reads its source. Anything else is
// converted; the Float64Array constructor applies ToNumber per element, which
// matches the `Array.from(values, Number)` the kernels used to open with.
//
// The win is not mainly memory — V8 already stores an all-numeric JSArray as
// unboxed doubles — it is the per-element cost: the conversion pass itself, the
// map check and hole check on every JSArray load, and the full extra copy that
// was allocated on entry even when the caller already held a Float64Array.
export function asFloat64(values) {
    if (values instanceof Float64Array) return values;
    if (!values) return new Float64Array(0);
    return new Float64Array(values);
}

// Writable copy, always a distinct buffer.
export function copyFloat64(values) {
    const src = asFloat64(values);
    const out = new Float64Array(src.length);
    out.set(src);
    return out;
}

// Linearly interpolated quantile over an ascending array. Kept expression-level
// identical to the original `_quantileSorted` (including the `undefined` branch
// and the `+ rest * (next - base)` form) so results stay bit-for-bit equal.
export function quantileSorted(sorted, p, length = sorted.length) {
    if (!length) return NaN;
    const pos = (length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = base + 1 < length ? sorted[base + 1] : undefined;
    return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

export function zeroMadTolerance(median) {
    return Math.max(Number.EPSILON * 32 * Math.max(1, Math.abs(Number(median) || 0)), 1e-12);
}

export function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function normalizeSensitivity(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 6;
}

export function normalizeMovingAverageWindow(value, maxLength = Infinity) {
    let n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = 21;
    const max = Number.isFinite(maxLength) ? Math.max(2, Math.round(maxLength)) : Number.MAX_SAFE_INTEGER;
    return Math.max(2, Math.min(max, n));
}

export function spikeParamsFromSensitivity(sensitivity) {
    const level = normalizeSensitivity(sensitivity);
    const maxRuns = [1, 2, 3, 4, 5, 6, 8, 10, 13, 16];
    return {
        window: 51,
        threshold: Math.max(4, 12 - level),
        maxRun: maxRuns[level - 1],
    };
}

export const DERIVATIVE_METHODS = new Set(['centered', 'forward', 'backward', 'difference']);
export const INTEGRAL_METHODS = new Set(['trapezoidal', 'rectangular']);

// Time context as the kernels want it: a Float64Array (or null) plus the kind
// flag that decides whether a delta is seconds, milliseconds or a step count.
export function normalizeTimeContext(time) {
    if (!time) return { values: null, kind: 'index' };
    return {
        values: time.values ? asFloat64(time.values) : null,
        kind: time.kind === 'datetime' ? 'datetime' : (time.kind === 'index' ? 'index' : 'numeric'),
    };
}

export function timeDelta(time, a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return NaN;
    if (time.kind === 'index' || !time.values) return b - a;
    const t0 = time.values[a];
    const t1 = time.values[b];
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return NaN;
    const delta = t1 - t0;
    return time.kind === 'datetime' ? delta / 1000 : delta;
}
