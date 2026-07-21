// Pearson correlation kernel for the Correlation analysis mode (TODO 9).
//
// Pure and dependency-free: callers pass already-transformed numeric arrays
// (gain/yOffset are applied upstream by the data layer, so eager and lazy paths
// share the same inputs and "negative gain flips the sign" falls out for free).
// The kernel never interpolates, resamples, sorts, or fills gaps — it just does
// pairwise-finite deletion over aligned rows and a numerically stable one-pass
// covariance.

// Pair-count guardrails shared with the pair UI/state (Phase 2+).
export const CORRELATION_MANY_PAIRS_WARNING = 12;
export const CORRELATION_MAX_PAIRS = 64;

const toFinite = (v) => {
    // Treat null/undefined/NaN/±Infinity uniformly as "missing". Guard null and
    // undefined explicitly: Number(null) === 0 would otherwise slip through.
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
};

// Numerically stable pairwise moments over the aligned rows of x and y.
//
// This is the shared kernel for Pearson correlation (TODO 9) and OLS linear
// fitting (TODO 10): both need the same streaming Welford/Chan means, the
// central second moments m2x/m2y and the co-moment cMoment, and both apply the
// exact same pairwise-finite deletion. Keeping one accumulator avoids the
// catastrophic cancellation of naive Σx·Σy / Σx² sums when values are large
// with a small spread (e.g. ~1e9 ± 1).
//
// Returns { n, nRowsSeen, nExcluded, meanX, meanY, m2x, m2y, cMoment,
// minX, maxX }. A row participates only when BOTH x[i] and y[i] are finite.
export function pairwiseMoments(x, y) {
    const len = Math.min(x?.length || 0, y?.length || 0);

    let n = 0;
    let meanX = 0;
    let meanY = 0;
    let m2x = 0;
    let m2y = 0;
    let cMoment = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    for (let i = 0; i < len; i++) {
        const xi = toFinite(x[i]);
        const yi = toFinite(y[i]);
        if (xi === null || yi === null) continue;

        n++;
        const dx = xi - meanX;
        meanX += dx / n;
        const dy = yi - meanY;
        meanY += dy / n;
        // C accumulates dx * (yi - meanY_new); M2 terms use the "new mean" form.
        cMoment += dx * (yi - meanY);
        m2x += dx * (xi - meanX);
        m2y += dy * (yi - meanY);
        if (xi < minX) minX = xi;
        if (xi > maxX) maxX = xi;
    }

    return {
        n,
        nRowsSeen: len,
        // nExcluded is only meaningful relative to the rows actually seen; rows
        // beyond the shorter array are a length mismatch, not an exclusion.
        nExcluded: len - n,
        meanX: n ? meanX : NaN,
        meanY: n ? meanY : NaN,
        m2x,
        m2y,
        cMoment,
        minX: n ? minX : NaN,
        maxX: n ? maxX : NaN,
    };
}

// Pearson r over the aligned rows of x and y.
//
// Returns { r, r2, n, nExcluded, meanX, meanY, stdX, stdY, status } where
// status is 'ok' or 'undefined'. A row participates only when BOTH x[i] and
// y[i] are finite; any non-finite value on either side excludes the row
// (pairwise deletion) and is counted in nExcluded. status is 'undefined' when
// fewer than two valid rows remain or when either variable has zero variance;
// undefined is never coerced to 0.
export function pearsonCorrelation(x, y) {
    const { n, nExcluded, meanX, meanY, m2x, m2y, cMoment } = pairwiseMoments(x, y);

    const base = {
        n,
        nExcluded,
        meanX,
        meanY,
        // Sample standard deviation for display; needs n >= 2. Irrelevant to r.
        stdX: n >= 2 ? Math.sqrt(m2x / (n - 1)) : NaN,
        stdY: n >= 2 ? Math.sqrt(m2y / (n - 1)) : NaN,
    };

    if (n < 2 || m2x === 0 || m2y === 0) {
        return { ...base, r: NaN, r2: NaN, status: 'undefined' };
    }

    let r = cMoment / Math.sqrt(m2x * m2y);
    // Absorb floating-point drift just outside the mathematical range.
    if (r > 1) r = 1;
    else if (r < -1) r = -1;

    return { ...base, r, r2: r * r, status: 'ok' };
}

// Multi-drop pairing: consume dropped variables two-by-two into (X, Y) pairs.
//
// [a,b,c,d] -> pairs (a,b),(c,d). An odd count leaves the final variable as the
// pending X. A pre-existing pendingX is completed first by the next drop.
// Returns { pairs: [[x, y], ...], pendingX } and never mutates its inputs.
export function groupDropIntoPairs(varNames, pendingX = null) {
    const queue = [];
    if (pendingX != null) queue.push(pendingX);
    for (const name of varNames || []) {
        if (name != null) queue.push(name);
    }

    const pairs = [];
    let i = 0;
    for (; i + 1 < queue.length; i += 2) {
        pairs.push([queue[i], queue[i + 1]]);
    }
    const leftover = i < queue.length ? queue[i] : null;
    return { pairs, pendingX: leftover };
}
