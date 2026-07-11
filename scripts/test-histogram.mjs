import assert from 'node:assert/strict';
import {
    HISTOGRAM_AUTO_MAX_BINS,
    HISTOGRAM_MANUAL_MAX_BINS,
    histogramFiniteStats,
    suggestBinsFreedmanDiaconis,
    resolveHistogramEdges,
    countHistogramBins,
    normalizeHistogramCounts,
    histogramBinGeometry,
    normalizeHistogramOptions,
} from '../src/utils/histogram.js';

const close = (actual, expected, tolerance, label) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`,
    );
};

// Convenience: full eager pipeline for a single series with given options.
const runSingle = (values, options = {}) => {
    const stat = histogramFiniteStats(values, options);
    const spec = resolveHistogramEdges([stat], options);
    if (!spec.ok) return { stat, spec, counted: null };
    const counted = countHistogramBins(values, spec);
    const norm = normalizeHistogramCounts(counted.counts, spec.edges, counted.nBinned);
    return { stat, spec, counted, norm };
};

// ---------------------------------------------------------------------------
// Finite stats: invalid handling
// ---------------------------------------------------------------------------
{
    const values = [1, 2, NaN, Infinity, -Infinity, null, 3, 4];
    const stat = histogramFiniteStats(values);
    assert.equal(stat.nScope, 8, 'nScope counts every row');
    assert.equal(stat.nFinite, 4, 'nFinite excludes NaN/Inf/null');
    assert.equal(stat.nInvalid, 4, 'nInvalid = scope - finite');
    assert.equal(stat.min, 1, 'min over finite');
    assert.equal(stat.max, 4, 'max over finite');
    assert.equal(stat.quartilesApprox, false, 'small data uses exact quartiles');
}

// ---------------------------------------------------------------------------
// Bin convention: right-open bins, right-inclusive last bin, edge membership
// ---------------------------------------------------------------------------
{
    // [0,10] into 10 unit bins.
    const spec = resolveHistogramEdges([{ nFinite: 100, min: 0, max: 10, q1: 2.5, q3: 7.5, quartilesApprox: false }], {
        binMode: 'count', binCount: 10,
    });
    assert.ok(spec.ok, 'count spec ok');
    assert.equal(spec.k, 10, 'k = requested bins');
    close(spec.width, 1, 1e-12, 'unit width');

    // Interior edge belongs to the RIGHT bin: 5 -> bin 5, not bin 4.
    let r = countHistogramBins([5], spec);
    assert.equal(r.counts[5], 1, 'value on interior edge lands in right bin');
    assert.equal(r.counts[4], 0, 'not the left bin');

    // Exact max lands in the last (right-inclusive) bin.
    r = countHistogramBins([10], spec);
    assert.equal(r.counts[9], 1, 'max lands in last bin');
    assert.equal(r.overflow, 0, 'max is not overflow');

    // Left edge is inclusive.
    r = countHistogramBins([0], spec);
    assert.equal(r.counts[0], 1, 'min lands in first bin');
}

// ---------------------------------------------------------------------------
// Underflow / overflow are never clamped (manual value range)
// ---------------------------------------------------------------------------
{
    const values = [-5, 0.5, 1.5, 2.5, 15];
    const stat = histogramFiniteStats(values);
    const spec = resolveHistogramEdges([stat], {
        binMode: 'count', binCount: 3, valueRangeMode: 'manual', valueMin: 0, valueMax: 3,
    });
    assert.ok(spec.ok, 'manual range spec ok');
    const r = countHistogramBins(values, spec);
    assert.equal(r.underflow, 1, 'one value below range');
    assert.equal(r.overflow, 1, 'one value above range');
    assert.equal(r.nBinned, 3, 'three values inside range');
    assert.equal(r.counts[0] + r.counts[1] + r.counts[2], 3, 'binned sum matches nBinned');
}

// ---------------------------------------------------------------------------
// Constant signal -> single centered bin
// ---------------------------------------------------------------------------
{
    const values = [7, 7, 7, 7];
    const { spec, counted } = runSingle(values);
    assert.ok(spec.ok, 'constant spec ok');
    assert.equal(spec.method, 'constant', 'constant method');
    assert.equal(spec.k, 1, 'single bin');
    assert.ok(spec.lo < 7 && spec.hi > 7, 'bin centered on the value');
    assert.equal(counted.counts[0], 4, 'all samples in the one bin');
    assert.equal(counted.underflow + counted.overflow, 0, 'no outliers for constant');
}

// ---------------------------------------------------------------------------
// N = 1 and N = 2 (Sturges fallback path)
// ---------------------------------------------------------------------------
{
    const one = histogramFiniteStats([42]);
    assert.equal(one.q1, NaN === NaN ? one.q1 : one.q1, 'n=1 quartiles NaN placeholder');
    assert.ok(Number.isNaN(one.q1), 'n=1 has no quartiles');
    const specOne = resolveHistogramEdges([one], { binMode: 'auto' });
    assert.equal(specOne.method, 'constant', 'single value is constant');

    const two = histogramFiniteStats([1, 5]);
    const fd = suggestBinsFreedmanDiaconis(two);
    assert.equal(fd.method, 'fd', 'n=2 with a valid IQR still uses FD');
    assert.ok(fd.k >= 1, 'fd gives >=1 bin');

    // Degenerate IQR (q1 === q3) forces the Sturges fallback.
    const degenerate = suggestBinsFreedmanDiaconis({ nFinite: 50, min: 0, max: 10, q1: 5, q3: 5, quartilesApprox: false });
    assert.equal(degenerate.method, 'sturges', 'iqr<=0 falls back to sturges');
    assert.ok(degenerate.k >= 1, 'sturges gives >=1 bin');
}

// ---------------------------------------------------------------------------
// Normalization: percent sums to 100, density integrates to 1, cumulative
// ---------------------------------------------------------------------------
{
    const values = [];
    for (let i = 0; i < 100; i++) values.push(i / 10); // 0..9.9
    const stat = histogramFiniteStats(values);
    const spec = resolveHistogramEdges([stat], { binMode: 'count', binCount: 10, valueRangeMode: 'manual', valueMin: 0, valueMax: 10 });
    const counted = countHistogramBins(values, spec);
    const norm = normalizeHistogramCounts(counted.counts, spec.edges, counted.nBinned);

    const percentSum = norm.percent.reduce((a, b) => a + b, 0);
    close(percentSum, 100, 1e-9, 'percent sums to 100');

    let area = 0;
    for (let i = 0; i < spec.k; i++) area += norm.density[i] * (spec.edges[i + 1] - spec.edges[i]);
    close(area, 1, 1e-9, 'density integrates to 1');

    close(norm.cumulativePercent[spec.k - 1], 100, 1e-9, 'cumulative percent ends at 100');
    assert.equal(norm.cumulativeCount[spec.k - 1], counted.nBinned, 'cumulative count ends at nBinned');
    // Monotonic non-decreasing cumulative.
    for (let i = 1; i < spec.k; i++) {
        assert.ok(norm.cumulativeCount[i] >= norm.cumulativeCount[i - 1], 'cumulative non-decreasing');
    }
}

// ---------------------------------------------------------------------------
// Common edges across traces: max K, global min/max
// ---------------------------------------------------------------------------
{
    const narrow = histogramFiniteStats(Array.from({ length: 1000 }, (_, i) => 4 + (i % 3) * 0.01));
    const wide = histogramFiniteStats(Array.from({ length: 1000 }, (_, i) => (i / 999) * 100));
    const spec = resolveHistogramEdges([narrow, wide], { binMode: 'auto' });
    assert.ok(spec.ok, 'multi-trace auto ok');
    close(spec.edges[0], Math.min(narrow.min, wide.min), 1e-9, 'global lo');
    close(spec.edges[spec.k], Math.max(narrow.max, wide.max), 1e-9, 'global hi');
    assert.ok(spec.k <= HISTOGRAM_AUTO_MAX_BINS, 'auto clamps to auto max');

    // Both traces share the exact same edges (blocking requirement).
    const cNarrow = countHistogramBins([4, 4.01, 4.02], spec);
    const cWide = countHistogramBins([0, 50, 100], spec);
    assert.equal(cNarrow.nBinned, 3, 'narrow binned');
    assert.equal(cWide.nBinned, 3, 'wide binned against same edges');
}

// ---------------------------------------------------------------------------
// Manual width: too many bins is blocked, not silently truncated
// ---------------------------------------------------------------------------
{
    const stat = { nFinite: 10, min: 0, max: 1000, q1: 250, q3: 750, quartilesApprox: false };
    const bad = resolveHistogramEdges([stat], { binMode: 'width', binWidth: 0.1 });
    assert.equal(bad.ok, false, 'width producing >500 bins rejected');
    assert.equal(bad.reason, 'tooManyBins', 'reason is tooManyBins');
    assert.ok(bad.k > HISTOGRAM_MANUAL_MAX_BINS, 'reports the offending k');

    const good = resolveHistogramEdges([stat], { binMode: 'width', binWidth: 100 });
    assert.ok(good.ok, 'reasonable width ok');
    assert.equal(good.k, 10, 'k = ceil(span/width)');
    close(good.edges[good.k], 1000, 1e-9, 'last edge pinned to valueMax');
}

// ---------------------------------------------------------------------------
// Float64 precision: huge magnitudes and exact-max membership
// ---------------------------------------------------------------------------
{
    const big = [0, 1e300, 5e299];
    const stat = histogramFiniteStats(big);
    const spec = resolveHistogramEdges([stat], { binMode: 'count', binCount: 4 });
    const r = countHistogramBins(big, spec);
    assert.equal(r.underflow + r.overflow, 0, 'no spurious outliers at 1e300');
    assert.equal(r.nBinned, 3, 'all three binned');
    assert.equal(r.counts[3], 1, '1e300 (the max) in last bin');
}

// ---------------------------------------------------------------------------
// Negative gain semantics: min/max do not assume raw order (caller applies
// gain before the kernel; here we just confirm crossing-zero ranges work)
// ---------------------------------------------------------------------------
{
    const values = [-3, -1, 0, 1, 2];
    const { spec, counted } = runSingle(values, { binMode: 'count', binCount: 5 });
    assert.ok(spec.lo < 0 && spec.hi > 0, 'range crosses zero');
    assert.equal(counted.nBinned, 5, 'all finite negatives/positives binned');
}

// ---------------------------------------------------------------------------
// Options normalization: invalid inputs surface as errors, valid ones coerce
// ---------------------------------------------------------------------------
{
    const bad = normalizeHistogramOptions({ binMode: 'count', binCount: 0 });
    assert.ok(bad.errors.includes('invalidBinCount'), 'binCount 0 invalid');

    const badRange = normalizeHistogramOptions({ valueRangeMode: 'manual', valueMin: 5, valueMax: 5 });
    assert.ok(badRange.errors.includes('invalidValueRange'), 'equal manual range invalid');

    const badWidth = normalizeHistogramOptions({ binMode: 'width', binWidth: -1 });
    assert.ok(badWidth.errors.includes('invalidBinWidth'), 'negative width invalid');

    const okOpts = normalizeHistogramOptions({ binMode: 'auto', normalization: 'density', yScale: 'log', cumulative: true });
    assert.equal(okOpts.errors.length, 0, 'valid options have no errors');
    assert.equal(okOpts.normalization, 'density', 'normalization passthrough');
    assert.equal(okOpts.yScale, 'log', 'yScale passthrough');
    assert.equal(okOpts.cumulative, true, 'cumulative passthrough');

    const unknown = normalizeHistogramOptions({ normalization: 'bogus', barMode: 'nope', yScale: 'weird' });
    assert.equal(unknown.normalization, 'count', 'unknown normalization -> count');
    assert.equal(unknown.barMode, 'overlay', 'unknown barMode -> overlay');
    assert.equal(normalizeHistogramOptions({ barMode: 'stacked' }).barMode, 'stacked', 'stacked is a valid barMode');
    assert.equal(unknown.yScale, 'linear', 'unknown yScale -> linear');
}

// ---------------------------------------------------------------------------
// Bin geometry helper
// ---------------------------------------------------------------------------
{
    const edges = Float64Array.from([0, 2, 4, 6]);
    const { centers, widths } = histogramBinGeometry(edges);
    assert.deepEqual(Array.from(centers), [1, 3, 5], 'centers');
    assert.deepEqual(Array.from(widths), [2, 2, 2], 'widths');
}

// ---------------------------------------------------------------------------
// All-invalid series -> no data
// ---------------------------------------------------------------------------
{
    const stat = histogramFiniteStats([NaN, null, Infinity]);
    assert.equal(stat.nFinite, 0, 'no finite values');
    const spec = resolveHistogramEdges([stat], { binMode: 'auto' });
    assert.equal(spec.ok, false, 'no edges without finite data');
    assert.equal(spec.reason, 'noData', 'reason noData');
}

// ---------------------------------------------------------------------------
// Stacked normalization: a combined denominator makes two traces' percentages
// sum to 100% across the whole stack (not 100% each).
// ---------------------------------------------------------------------------
{
    const edges = Float64Array.from([0, 1, 2]);
    const a = Float64Array.from([3, 1]); // nBinned 4
    const b = Float64Array.from([1, 3]); // nBinned 4
    const combined = 8;
    const na = normalizeHistogramCounts(a, edges, 4, combined);
    const nb = normalizeHistogramCounts(b, edges, 4, combined);
    const stackPercentSum = na.percent.reduce((s, v) => s + v, 0) + nb.percent.reduce((s, v) => s + v, 0);
    close(stackPercentSum, 100, 1e-9, 'stacked percent sums to 100 over the combined population');
    // Per-trace (default denominator) still sums to 100 each.
    const solo = normalizeHistogramCounts(a, edges, 4);
    close(solo.percent.reduce((s, v) => s + v, 0), 100, 1e-9, 'per-trace percent unchanged by default');
}

console.log('histogram kernel tests passed');
