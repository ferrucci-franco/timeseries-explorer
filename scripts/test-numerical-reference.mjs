// The numerical kernels against NumPy and SciPy.
//
// The other tests check the kernels against closed forms and against each
// other (in memory against memory-saving mode, a worker against the page).
// This one is the independent check: test-files/validation/reference.json
// holds input signals and the results NumPy/SciPy give for them, written by
// scripts/validation/make-reference.py, and the app's kernels must give the
// same numbers on the same inputs, within the tolerance stated at each check.
//
// Covered: FFT, window functions, amplitude spectrum, Pearson correlation,
// linear / quadratic / power-law / exponential / first-order fits, statistics,
// histogram, cumulative and definite integral, derivative, moving average,
// detrend, IIR filter design (Butterworth, Chebyshev I and II, Bessel), filter
// application (forward and zero-phase) and cross-correlation.
//
// `--report` prints the largest error of every check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeAmplitudeSpectrum, fftRadix2, fftWindowCoefficients } from '../src/utils/fft.js';
import { pearsonCorrelation } from '../src/utils/correlation.js';
import { expFamilyFit, linearFit, powerFit, quadraticFitCentered } from '../src/utils/regression.js';
import { seriesStats } from '../src/utils/series-stats.js';
import { countHistogramBins, histogramFiniteStats, resolveHistogramEdges } from '../src/utils/histogram.js';
import {
    applyFilter,
    computeCrossCorrelation,
    computeDerivative,
    computeDetrend,
    computeIntegral,
    computeMovingAverage,
    designFilter,
} from '../src/compute/kernels/index.js';
import { computeDefiniteIntegral } from '../src/compute/kernels/definite-integral.js';
import { sosMagnitudeDb } from '../src/compute/kernels/filter-design.js';

const reference = JSON.parse(readFileSync(new URL('../test-files/validation/reference.json', import.meta.url), 'utf8'));
const { cases } = reference;
const report = process.argv.includes('--report');
const checked = new Set();
let checks = 0;

// |actual − expected| ≤ tolerance × max(scale, |expected|): relative for large
// values, absolute (in units of `scale`) near zero.
function near(label, actual, expected, tolerance, scale = 1) {
    const a = ArrayBuffer.isView(actual) || Array.isArray(actual) ? Array.from(actual) : [actual];
    const e = Array.isArray(expected) ? expected : [expected];
    assert.equal(a.length, e.length, `${label}: ${a.length} values, expected ${e.length}`);
    let worst = 0;
    let worstIndex = -1;
    for (let i = 0; i < e.length; i++) {
        assert.ok(Number.isFinite(a[i]), `${label}[${i}] is ${a[i]}`);
        const error = Math.abs(a[i] - e[i]) / Math.max(scale, Math.abs(e[i]));
        if (error > worst) { worst = error; worstIndex = i; }
    }
    if (report) console.log(`${label.padEnd(46)} max error ${worst.toExponential(2)}  (tolerance ${tolerance.toExponential(0)})`);
    assert.ok(worst <= tolerance, `${label}: error ${worst.toExponential(3)} at [${worstIndex}] (${a[worstIndex]} vs ${e[worstIndex]}), tolerance ${tolerance}`);
    checks++;
}
const take = name => {
    assert.ok(cases[name], `reference.json has no "${name}" case`);
    checked.add(name);
    return cases[name];
};
const maxAbs = values => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// ─── FFT ──────────────────────────────────────────────────────────────────
{
    const { input, expected } = take('fft_complex');
    const out = fftRadix2(Float64Array.from(input.real), Float64Array.from(input.imag));
    const scale = maxAbs(expected.real.concat(expected.imag));
    near('FFT, real part', out.real, expected.real, 1e-13, scale);
    near('FFT, imaginary part', out.imag, expected.imag, 1e-13, scale);
}
{
    const { input, expected } = take('fft_windows');
    for (const [name, values] of Object.entries(expected)) {
        // The flat-top coefficients are published to 9 digits; SciPy's and the app's agree to that.
        near(`window: ${name}`, fftWindowCoefficients(name, input.length), values, name === 'flattop' ? 1e-8 : 1e-14);
    }
}
{
    const { input, expected } = take('amplitude_spectrum');
    for (const [windowType, amplitudes] of Object.entries(expected.amplitudes)) {
        const spectrum = computeAmplitudeSpectrum({ times: input.times, values: input.values, windowType, removeMean: true });
        assert.equal(spectrum.ok, true, `spectrum (${windowType}) is computed`);
        assert.equal(spectrum.nfft, input.nfft);
        near(`spectrum (${windowType}): frequencies`, spectrum.frequencies, expected.frequencies, 1e-9);
        near(`spectrum (${windowType}): amplitudes`, spectrum.rawAmplitudes, amplitudes, windowType === 'flattop' ? 1e-7 : 1e-12, maxAbs(amplitudes));
    }
}

// ─── Correlation and fits ─────────────────────────────────────────────────
{
    const { input, expected } = take('pearson');
    near('Pearson r', pearsonCorrelation(input.x, input.y).r, expected.r, 1e-12);
}
{
    const { input, expected } = take('linear_fit');
    const fit = linearFit(input.x, input.y);
    near('linear fit: intercept', fit.b0, expected.intercept, 1e-11);
    near('linear fit: slope', fit.b1, expected.slope, 1e-11);
    near('linear fit: r', fit.r, expected.r, 1e-12);
    near('linear fit: R²', fit.r2, expected.r2, 1e-12);
    near('linear fit: SSE', fit.sse, expected.sse, 1e-10);
    near('linear fit: RMSE', fit.rmse, expected.rmse, 1e-10);
}
{
    const { input, expected } = take('quadratic_fit');
    const fit = quadraticFitCentered(input.x, input.y);
    near('quadratic fit: a', fit.a, expected.a, 1e-10);
    near('quadratic fit: b', fit.b, expected.b, 1e-10);
    near('quadratic fit: c', fit.c, expected.c, 1e-10);
    near('quadratic fit: R²', fit.r2, expected.r2, 1e-11);
    near('quadratic fit: SSE', fit.sse, expected.sse, 1e-10);
}
{
    const { input, expected } = take('power_fit');
    const fit = powerFit(input.x, input.y);
    near('power-law fit: a', fit.a, expected.a, 1e-11);
    near('power-law fit: b', fit.b, expected.b, 1e-11);
}
{
    // Iterative least squares on both sides: each stops at its own tolerance,
    // so the parameters agree to about 1e-6 and the minimum itself (SSE) closer.
    const { input, expected } = take('exponential_fits');
    const exponential = expFamilyFit('exponential', input.x, input.exponential);
    near('exponential fit: a', exponential.a, expected.exponential.a, 1e-6);
    near('exponential fit: b', exponential.b, expected.exponential.b, 1e-6);
    near('exponential fit: SSE', exponential.sse, expected.exponential.sse, 1e-8);
    const offset = expFamilyFit('exponential-offset', input.x, input.exponentialOffset);
    near('exponential + offset fit: a', offset.a, expected.exponentialOffset.a, 1e-6);
    near('exponential + offset fit: b', offset.b, expected.exponentialOffset.b, 1e-6);
    near('exponential + offset fit: c', offset.c, expected.exponentialOffset.c, 1e-6);
    near('exponential + offset fit: SSE', offset.sse, expected.exponentialOffset.sse, 1e-8);
    const firstOrder = expFamilyFit('first-order', input.x, input.firstOrder);
    near('first-order fit: K', firstOrder.K, expected.firstOrder.K, 1e-6);
    near('first-order fit: time constant', firstOrder.timeConstant, expected.firstOrder.timeConstant, 1e-6);
    near('first-order fit: SSE', firstOrder.sse, expected.firstOrder.sse, 1e-8);
}

// ─── Statistics and histogram ─────────────────────────────────────────────
{
    const { input, expected } = take('statistics');
    const stat = seriesStats(input.values);
    near('statistics: min', stat.min, expected.min, 0);
    near('statistics: max', stat.max, expected.max, 0);
    near('statistics: mean', stat.mean, expected.mean, 1e-13);
    near('statistics: RMS', stat.rms, expected.rms, 1e-13);
    const quartiles = histogramFiniteStats(input.values);
    near('statistics: first quartile', quartiles.q1, expected.q1, 1e-13);
    near('statistics: third quartile', quartiles.q3, expected.q3, 1e-13);
}
{
    const { input, expected } = take('histogram');
    const edges = resolveHistogramEdges([histogramFiniteStats(input.values)], { binMode: 'count', binCount: input.bins });
    assert.equal(edges.ok, true);
    near('histogram: bin edges', edges.edges, expected.edges, 1e-13);
    const counted = countHistogramBins(input.values, edges);
    near('histogram: counts', counted.counts, expected.counts, 0);
    assert.equal(counted.underflow + counted.overflow, 0, 'every value falls in a bin');
}

// ─── Calculus ─────────────────────────────────────────────────────────────
{
    const { input, expected } = take('integral');
    const time = { values: input.times, kind: 'numeric' };
    near('cumulative integral (uneven steps)', computeIntegral(input.values, time, {}).values, expected.cumulative, 1e-12, maxAbs(expected.cumulative));
    const definite = computeDefiniteIntegral(input.values, time, {});
    assert.equal(definite.ok, true);
    near('definite integral (uneven steps)', definite.value, expected.definite, 1e-12);
}
{
    const { input, expected } = take('derivative');
    const out = computeDerivative(input.values, { values: input.times, kind: 'numeric' }, { method: 'centered' });
    near('derivative (central differences)', out.values, expected.values, 1e-10, maxAbs(expected.values));
}

// ─── Smoothing and detrending ─────────────────────────────────────────────
{
    const { input, expected } = take('moving_average');
    const out = Array.from(computeMovingAverage(input.values, { window: input.window }));
    const interior = out.slice(expected.offset, expected.offset + expected.interior.length);
    near('moving average (interior)', interior, expected.interior, 1e-12, maxAbs(expected.interior));
}
{
    const { input, expected } = take('detrend');
    near('detrend: linear', computeDetrend(input.values, null, { method: 'linear' }).values, expected.linear, 1e-11, maxAbs(expected.linear));
    near('detrend: mean', computeDetrend(input.values, null, { method: 'mean' }).values, expected.mean, 1e-12, maxAbs(expected.mean));
}

// ─── Digital filters ──────────────────────────────────────────────────────
{
    const { input, expected } = take('filter_design');
    for (const design of expected.designs) {
        const { magnitudeDb, ...params } = design;
        const { sos } = designFilter({ ...params, sampleRate: input.sampleRate });
        const actual = [];
        const wanted = [];
        input.frequencies.forEach((frequency, i) => {
            // Below −200 dB both responses are rounding noise around a zero.
            if (magnitudeDb[i] < -200) return;
            actual.push(sosMagnitudeDb(sos, 2 * Math.PI * frequency / input.sampleRate));
            wanted.push(magnitudeDb[i]);
        });
        // In dB, absolute: 1e-6 dB is a relative gain error of about 1e-7.
        near(`filter design: ${design.family} ${design.response} (order ${design.order})`, actual.map((v, i) => v - wanted[i]), wanted.map(() => 0), 1e-6);
    }
}
{
    const { input, expected } = take('filter_apply');
    const designed = designFilter({ family: 'butterworth', response: 'lowpass', order: 4, cutoff: [80], sampleRate: 1000 });
    near('Butterworth coefficients: b', designed.b, expected.b, 1e-10, maxAbs(expected.b));
    near('Butterworth coefficients: a', designed.a, expected.a, 1e-10);
    const run = (mode, init) => applyFilter(input.values, { b: input.b, a: input.a, mode, init }).values;
    near('filter, forward, zero initial state', run('forward', 'zero'), expected.forwardZero, 1e-10);
    near('filter, forward, steady initial state', run('forward', 'steady'), expected.forwardSteady, 1e-10);
    near('filter, zero phase', run('zeroPhase', 'steady'), expected.zeroPhase, 1e-9);
}

// ─── Cross-correlation ────────────────────────────────────────────────────
{
    const { input, expected } = take('cross_correlation');
    for (const normalization of ['none', 'biased', 'unbiased', 'coeff']) {
        const out = computeCrossCorrelation(input.x, input.y, { normalization, maxLag: input.maxLag, removeMean: true });
        near(`cross-correlation (${normalization}): lags`, out.lags, expected.lags, 0);
        near(`cross-correlation (${normalization})`, out.values, expected[normalization], 1e-11, maxAbs(expected[normalization]));
    }
}

assert.deepEqual([...checked].sort(), Object.keys(cases).sort(), 'every case of reference.json is checked');
console.log(`Numerical reference checks passed: ${checks} comparisons against NumPy ${reference.generator.numpy} / SciPy ${reference.generator.scipy}.`);
