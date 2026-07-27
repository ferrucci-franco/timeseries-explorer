import { asFloat64, DERIVATIVE_METHODS, normalizeTimeContext, timeDelta } from './shared.js';

// Numerical derivative. Semantics are unchanged from the original
// `_computeDerivativeValues`; the difference is that source and destination are
// Float64Arrays and the two per-element closures (`delta` / `diff`) are inlined,
// so the hot loop has no call overhead and no boxing.
export function computeDerivative(sourceValues, time, params = {}) {
    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = new Float64Array(n).fill(NaN);
    if (n < 2) return { values: out };

    const ctx = normalizeTimeContext(time);
    const method = DERIVATIVE_METHODS.has(params.method) ? params.method : 'centered';

    // Pure difference: y[i]-y[i-1] with NO division by Δt, so duplicate
    // timestamps (Δt=0) don't blow up. First sample uses the forward difference
    // to keep the length and the uniform baseline.
    if (method === 'difference') {
        const y0 = values[0];
        const y1 = values[1];
        out[0] = (Number.isFinite(y0) && Number.isFinite(y1)) ? y1 - y0 : NaN;
        for (let i = 1; i < n; i++) {
            const a = values[i - 1];
            const b = values[i];
            out[i] = (Number.isFinite(a) && Number.isFinite(b)) ? b - a : NaN;
        }
        return { values: out };
    }

    const diff = (a, b) => {
        const y0 = values[a];
        const y1 = values[b];
        const dt = timeDelta(ctx, a, b);
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(dt) || dt === 0) return NaN;
        return (y1 - y0) / dt;
    };

    if (method === 'forward') {
        for (let i = 0; i < n - 1; i++) out[i] = diff(i, i + 1);
        out[n - 1] = diff(n - 2, n - 1);
    } else if (method === 'backward') {
        out[0] = diff(0, 1);
        for (let i = 1; i < n; i++) out[i] = diff(i - 1, i);
    } else {
        out[0] = diff(0, 1);
        for (let i = 1; i < n - 1; i++) out[i] = diff(i - 1, i + 1);
        out[n - 1] = diff(n - 2, n - 1);
    }
    return { values: out };
}
