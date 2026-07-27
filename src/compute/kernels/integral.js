import { asFloat64, INTEGRAL_METHODS, normalizeTimeContext, timeDelta } from './shared.js';

// Cumulative integral. Same accumulation order as the original
// `_computeIntegralValues` — the running sum is float-order-sensitive, so the
// loop must stay strictly sequential for results to match bit-for-bit.
export function computeIntegral(sourceValues, time, params = {}) {
    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = new Float64Array(n);
    if (!n) return { values: out, negativeDtCount: 0 };

    const ctx = normalizeTimeContext(time);
    const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
    const rectangular = method === 'rectangular';
    let acc = 0;
    let negativeDtCount = 0;

    for (let i = 1; i < n; i++) {
        const dt = timeDelta(ctx, i - 1, i);
        if (Number.isFinite(dt)) {
            if (dt < 0) negativeDtCount++;
            const y0 = values[i - 1];
            const y1 = values[i];
            if (rectangular) {
                if (Number.isFinite(y0)) acc += y0 * dt;
            } else if (Number.isFinite(y0) && Number.isFinite(y1)) {
                acc += 0.5 * (y0 + y1) * dt;
            }
        }
        out[i] = acc;
    }
    return { values: out, negativeDtCount };
}
