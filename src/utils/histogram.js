// Pure histogram kernel: no DOM, no Plotly, no DuckDB.
//
// This module is the single source of truth for histogram binning, counting
// and normalization. The eager path calls these functions directly; the lazy
// DuckDB path must reproduce the SAME edge/index convention in SQL so that,
// given the same data, temporal range and edges, both produce identical
// counts, underflow and overflow (see TODO 7 "Regla de paridad").
//
// Bin convention (right-open except the last bin):
//   bins 0..K-2 : [edge[i], edge[i+1])
//   last bin     : [edge[K-1], edge[K]]   (right-inclusive)
//   value === last edge  -> last bin
//   value < edge[0]      -> underflow (never clamped)
//   value > edge[K]      -> overflow  (never clamped)

export const HISTOGRAM_AUTO_MAX_BINS = 200;
export const HISTOGRAM_MANUAL_MAX_BINS = 500;
export const HISTOGRAM_DEFAULT_MANUAL_BINS = 30;
export const HISTOGRAM_DEFAULT_OPACITY = 0.55;
export const HISTOGRAM_RECOMPUTE_DEBOUNCE_MS = 150;

// Above this many finite samples the eager quartiles switch from exact to a
// deterministic bounded sample. Quartiles only pick the automatic bin width,
// so an approximate q1/q3 never affects the exact final counts.
export const HISTOGRAM_EXACT_QUANTILE_MAX_N = 2_000_000;

export const HISTOGRAM_NORMALIZATIONS = new Set(['count', 'percent', 'density']);
export const HISTOGRAM_BAR_MODES = new Set(['overlay', 'grouped', 'stacked']);
export const HISTOGRAM_Y_SCALES = new Set(['linear', 'log']);
export const HISTOGRAM_BIN_MODES = new Set(['auto', 'count', 'width']);
export const HISTOGRAM_VALUE_RANGE_MODES = new Set(['auto', 'manual']);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const clampInt = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(value)));

// Type-7 linear-interpolation quantile over an ascending-sorted array, matching
// numpy's default and DuckDB quantile_cont so eager/lazy Auto bin choices agree.
function quantileSorted(sorted, p) {
    const n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    const pos = p * (n - 1);
    const lo = Math.floor(pos);
    const frac = pos - lo;
    if (lo + 1 >= n) return sorted[n - 1];
    return sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]);
}

// First/second-pass statistics over one already time-scoped value series.
// `values` may be any array-like of numbers; non-finite entries (null coerces
// to a number, NaN, +/-Infinity) count as invalid and are excluded from stats.
export function histogramFiniteStats(values, options = {}) {
    const {
        computeQuartiles = true,
        maxExactQuantileN = HISTOGRAM_EXACT_QUANTILE_MAX_N,
    } = options;

    const nScope = values ? values.length : 0;
    let nFinite = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < nScope; i++) {
        const v = values[i];
        if (!isFiniteNumber(v)) continue;
        nFinite++;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const nInvalid = nScope - nFinite;
    if (nFinite === 0) {
        return { nScope, nFinite, nInvalid, min: NaN, max: NaN, q1: NaN, q3: NaN, quartilesApprox: false };
    }

    let q1 = NaN;
    let q3 = NaN;
    let quartilesApprox = false;
    if (computeQuartiles && nFinite >= 2) {
        const exact = nFinite <= maxExactQuantileN;
        // Deterministic stride sample keeps memory and sort cost bounded on
        // huge arrays while staying reproducible across runs.
        const stride = exact ? 1 : Math.ceil(nFinite / maxExactQuantileN);
        quartilesApprox = !exact;
        const sample = [];
        let seen = 0;
        for (let i = 0; i < nScope; i++) {
            const v = values[i];
            if (!isFiniteNumber(v)) continue;
            if (seen % stride === 0) sample.push(v);
            seen++;
        }
        sample.sort((a, b) => a - b);
        q1 = quantileSorted(sample, 0.25);
        q3 = quantileSorted(sample, 0.75);
    }
    return { nScope, nFinite, nInvalid, min, max, q1, q3, quartilesApprox };
}

// Freedman-Diaconis bin-count suggestion for one trace, with a Sturges fallback
// whenever the IQR is unusable. Uses the trace's own span, as specified.
export function suggestBinsFreedmanDiaconis(stat) {
    const n = stat?.nFinite || 0;
    const span = (stat?.max ?? NaN) - (stat?.min ?? NaN);
    const iqr = (stat?.q3 ?? NaN) - (stat?.q1 ?? NaN);
    if (n >= 2 && isFiniteNumber(iqr) && iqr > 0 && isFiniteNumber(span) && span > 0) {
        const h = 2 * iqr / Math.cbrt(n);
        if (isFiniteNumber(h) && h > 0) {
            const k = Math.ceil(span / h);
            if (isFiniteNumber(k) && k >= 1) return { k, method: 'fd' };
        }
    }
    const k = Math.max(1, Math.ceil(Math.log2(Math.max(1, n)) + 1));
    return { k, method: 'sturges' };
}

function uniformEdges(lo, hi, k) {
    const edges = new Float64Array(k + 1);
    const width = (hi - lo) / k;
    for (let i = 0; i <= k; i++) edges[i] = lo + i * width;
    // Pin the last edge exactly so a value equal to `hi` never drifts outside.
    edges[k] = hi;
    return { edges, width };
}

// Resolve the SINGLE common edge array shared by every trace in a panel.
// `traceStats` is an array of histogramFiniteStats() results (one per trace).
// Returns { ok, ... } with lo/hi/width/k/edges/method on success, or
// { ok:false, reason } when it cannot build a valid histogram.
export function resolveHistogramEdges(traceStats, options = {}) {
    const binMode = HISTOGRAM_BIN_MODES.has(options.binMode) ? options.binMode : 'auto';
    const valueRangeMode = options.valueRangeMode === 'manual' ? 'manual' : 'auto';
    const autoMaxBins = clampInt(options.autoMaxBins ?? HISTOGRAM_AUTO_MAX_BINS, 1, HISTOGRAM_MANUAL_MAX_BINS);
    const manualMaxBins = clampInt(options.manualMaxBins ?? HISTOGRAM_MANUAL_MAX_BINS, 1, 100_000);

    const stats = (traceStats || []).filter(s => s && s.nFinite > 0);
    if (!stats.length) return { ok: false, reason: 'noData' };

    let lo;
    let hi;
    if (valueRangeMode === 'manual') {
        lo = Number(options.valueMin);
        hi = Number(options.valueMax);
        if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || lo >= hi) {
            return { ok: false, reason: 'invalidValueRange' };
        }
    } else {
        lo = Infinity;
        hi = -Infinity;
        for (const s of stats) {
            if (s.min < lo) lo = s.min;
            if (s.max > hi) hi = s.max;
        }
    }
    if (!isFiniteNumber(lo) || !isFiniteNumber(hi)) return { ok: false, reason: 'noData' };

    // Constant signal (all finite values equal): one finite-width bin centered
    // on the value. Manual ranges with lo<hi never hit this branch.
    if (lo === hi) {
        const half = 0.5;
        const edges = Float64Array.from([lo - half, hi + half]);
        return { ok: true, edges, lo: lo - half, hi: hi + half, width: 2 * half, k: 1, method: 'constant', quartilesApprox: false };
    }

    const quartilesApprox = stats.some(s => s.quartilesApprox);

    if (binMode === 'count') {
        const k = Number(options.binCount);
        if (!Number.isInteger(k) || k < 1 || k > manualMaxBins) {
            return { ok: false, reason: 'invalidBinCount' };
        }
        const { edges, width } = uniformEdges(lo, hi, k);
        return { ok: true, edges, lo, hi, width, k, method: 'manualCount', quartilesApprox };
    }

    if (binMode === 'width') {
        const width = Number(options.binWidth);
        if (!isFiniteNumber(width) || width <= 0) return { ok: false, reason: 'invalidBinWidth' };
        const k = Math.ceil((hi - lo) / width);
        if (!isFiniteNumber(k) || k < 1) return { ok: false, reason: 'invalidBinWidth' };
        if (k > manualMaxBins) return { ok: false, reason: 'tooManyBins', k };
        const edges = new Float64Array(k + 1);
        for (let i = 0; i <= k; i++) edges[i] = lo + i * width;
        edges[k] = hi; // last edge pinned exactly to valueMax
        return { ok: true, edges, lo, hi, width, k, method: 'manualWidth', quartilesApprox };
    }

    // Auto: max suggested k across traces, applied over the global [lo, hi].
    let bestK = 1;
    let method = 'sturges';
    for (const s of stats) {
        const suggestion = suggestBinsFreedmanDiaconis(s);
        if (suggestion.k > bestK) {
            bestK = suggestion.k;
            method = suggestion.method;
        }
    }
    const k = clampInt(bestK, 1, autoMaxBins);
    const { edges, width } = uniformEdges(lo, hi, k);
    return { ok: true, edges, lo, hi, width, k, method, quartilesApprox };
}

// Exact counting over the uniform edge spec from resolveHistogramEdges().
// Mirrors the DuckDB FLOOR((v - lo) / width) + CASE(v = hi -> K-1) convention.
export function countHistogramBins(values, edgeSpec) {
    const { lo, hi, width, k } = edgeSpec;
    const counts = new Float64Array(k);
    let underflow = 0;
    let overflow = 0;
    let nBinned = 0;
    const n = values ? values.length : 0;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        if (!isFiniteNumber(v)) continue;
        if (v < lo) { underflow++; continue; }
        if (v > hi) { overflow++; continue; }
        let idx = Math.floor((v - lo) / width);
        if (idx >= k) idx = k - 1; // v === hi lands in the last, right-inclusive bin
        else if (idx < 0) idx = 0;
        counts[idx]++;
        nBinned++;
    }
    return { counts, underflow, overflow, nBinned };
}

// Project raw counts into count / percent / density / cumulative arrays.
// Never re-reads data: every normalization is a pure function of `counts`.
//
// `denominator` defaults to this trace's own nBinned (per-trace normalization).
// Pass the COMBINED nBinned across every stacked trace to normalize a stacked
// view against the combined population, so the stack tops are coherent.
export function normalizeHistogramCounts(counts, edges, nBinned, denominator = nBinned) {
    const k = counts.length;
    const count = counts;
    const percent = new Float64Array(k);
    const density = new Float64Array(k);
    const cumulativeCount = new Float64Array(k);
    const cumulativePercent = new Float64Array(k);
    const total = denominator > 0 ? denominator : 0;
    let runningCount = 0;
    for (let i = 0; i < k; i++) {
        const c = counts[i];
        const binWidth = edges[i + 1] - edges[i];
        percent[i] = total > 0 ? (100 * c) / total : 0;
        density[i] = total > 0 && binWidth > 0 ? c / (total * binWidth) : 0;
        runningCount += c;
        cumulativeCount[i] = runningCount;
        cumulativePercent[i] = total > 0 ? (100 * runningCount) / total : 0;
    }
    return { count, percent, density, cumulativeCount, cumulativePercent };
}

// Bin centers and widths for Plotly bar rendering.
export function histogramBinGeometry(edges) {
    const k = edges.length - 1;
    const centers = new Float64Array(k);
    const widths = new Float64Array(k);
    for (let i = 0; i < k; i++) {
        centers[i] = (edges[i] + edges[i + 1]) / 2;
        widths[i] = edges[i + 1] - edges[i];
    }
    return { centers, widths };
}

// Validate/normalize the numeric binning + value-range inputs. Returns the
// coerced values plus an `errors` array of stable reason codes; callers keep
// the previous valid result while `errors` is non-empty.
export function normalizeHistogramOptions(raw = {}) {
    const errors = [];
    const binMode = HISTOGRAM_BIN_MODES.has(raw.binMode) ? raw.binMode : 'auto';
    const valueRangeMode = raw.valueRangeMode === 'manual' ? 'manual' : 'auto';
    const normalization = HISTOGRAM_NORMALIZATIONS.has(raw.normalization) ? raw.normalization : 'count';
    const barMode = HISTOGRAM_BAR_MODES.has(raw.barMode) ? raw.barMode : 'overlay';
    const yScale = HISTOGRAM_Y_SCALES.has(raw.yScale) ? raw.yScale : 'linear';
    const cumulative = raw.cumulative === true;

    let binCount = Number(raw.binCount);
    if (!Number.isInteger(binCount)) binCount = HISTOGRAM_DEFAULT_MANUAL_BINS;
    if (binMode === 'count' && (binCount < 1 || binCount > HISTOGRAM_MANUAL_MAX_BINS)) {
        errors.push('invalidBinCount');
    }

    let binWidth = raw.binWidth == null || raw.binWidth === '' ? null : Number(raw.binWidth);
    if (binWidth != null && (!isFiniteNumber(binWidth) || binWidth <= 0)) {
        if (binMode === 'width') errors.push('invalidBinWidth');
        binWidth = null;
    }
    if (binMode === 'width' && binWidth == null) errors.push('invalidBinWidth');

    const finiteOrNull = (value) => {
        if (value == null || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };
    const valueMin = finiteOrNull(raw.valueMin);
    const valueMax = finiteOrNull(raw.valueMax);
    if (valueRangeMode === 'manual' && (valueMin == null || valueMax == null || valueMin >= valueMax)) {
        errors.push('invalidValueRange');
    }

    return {
        binMode, binCount, binWidth,
        valueRangeMode, valueMin, valueMax,
        normalization, barMode, yScale, cumulative,
        errors,
    };
}
