#!/usr/bin/env python3
"""Reference values for the numerical kernels, computed with NumPy and SciPy.

The app's own tests check its kernels against closed forms and against each
other. This script is the independent check: it draws the input signals,
computes each result with NumPy/SciPy, and writes inputs and expected results
to test-files/validation/reference.json. scripts/test-numerical-reference.mjs
runs the app's kernels on those same inputs and compares.

Run it again only to add a case or after a deliberate change of convention:

    python3 scripts/validation/make-reference.py

The random generator is seeded, so the same NumPy/SciPy versions write the
same file. The versions used are recorded in the file.
"""
import json
import os

import numpy as np
import scipy
from scipy import integrate, optimize, signal, stats

rng = np.random.default_rng(20261128)
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'test-files', 'validation', 'reference.json')


def arr(values):
    return [float(v) for v in np.asarray(values, dtype=float).ravel()]


cases = {}

# --- FFT -------------------------------------------------------------------
n = 256
re = rng.standard_normal(n)
im = rng.standard_normal(n)
spec = np.fft.fft(re + 1j * im)
cases['fft_complex'] = {
    'reference': 'numpy.fft.fft',
    'input': {'real': arr(re), 'imag': arr(im)},
    'expected': {'real': arr(spec.real), 'imag': arr(spec.imag)},
}

# Window functions, periodic form (scipy's fftbins=True), which is what an FFT uses.
cases['fft_windows'] = {
    'reference': 'scipy.signal.get_window(name, 64, fftbins=True)',
    'input': {'length': 64},
    'expected': {name: arr(signal.get_window(name, 64, fftbins=True))
                 for name in ('hann', 'hamming', 'blackman', 'flattop')},
}

# Single-sided amplitude spectrum of a real signal whose length is not a power
# of two (zero-padded to 1024), mean removed, for three windows.
fs = 500.0
n = 1000
t = np.arange(n) / fs
x = 0.7 + 1.5 * np.sin(2 * np.pi * 37.3 * t + 0.4) + 0.4 * np.cos(2 * np.pi * 121.0 * t) + 0.2 * rng.standard_normal(n)
nfft = 1024
expected = {}
for name in ('none', 'hann', 'flattop'):
    w = np.ones(n) if name == 'none' else signal.get_window(name, n, fftbins=True)
    amplitude = np.abs(np.fft.rfft((x - x.mean()) * w, nfft)) / w.sum()
    amplitude[1:-1] *= 2
    expected[name] = arr(amplitude)
cases['amplitude_spectrum'] = {
    'reference': '|numpy.fft.rfft((x - mean) * w, 1024)| / sum(w), doubled except DC and Nyquist',
    'input': {'times': arr(t), 'values': arr(x), 'sampleRate': fs, 'nfft': nfft},
    'expected': {'frequencies': arr(np.fft.rfftfreq(nfft, 1 / fs)), 'amplitudes': expected},
}

# --- Correlation and least-squares fits --------------------------------------
n = 400
x = np.sort(rng.uniform(0.5, 12.0, n))
y = 3.2 - 0.85 * x + 0.9 * rng.standard_normal(n)
r, _ = stats.pearsonr(x, y)
cases['pearson'] = {
    'reference': 'scipy.stats.pearsonr',
    'input': {'x': arr(x), 'y': arr(y)},
    'expected': {'r': float(r)},
}

lin = stats.linregress(x, y)
residual = y - (lin.intercept + lin.slope * x)
cases['linear_fit'] = {
    'reference': 'scipy.stats.linregress',
    'input': {'x': arr(x), 'y': arr(y)},
    'expected': {
        'intercept': float(lin.intercept), 'slope': float(lin.slope), 'r': float(lin.rvalue),
        'r2': float(lin.rvalue ** 2), 'sse': float(np.sum(residual ** 2)),
        'rmse': float(np.sqrt(np.mean(residual ** 2))),
    },
}

yq = 0.35 * x ** 2 - 2.1 * x + 4.0 + 0.8 * rng.standard_normal(n)
a, b, c = np.polyfit(x, yq, 2)
residual = yq - np.polyval([a, b, c], x)
cases['quadratic_fit'] = {
    'reference': 'numpy.polyfit(x, y, 2)',
    'input': {'x': arr(x), 'y': arr(yq)},
    'expected': {'a': float(a), 'b': float(b), 'c': float(c),
                 'r2': float(1 - np.sum(residual ** 2) / np.sum((yq - yq.mean()) ** 2)),
                 'sse': float(np.sum(residual ** 2))},
}

# Power law y = a x^b, fitted as a straight line in log-log.
yp = 2.4 * x ** 1.7 * np.exp(0.05 * rng.standard_normal(n))
slope, intercept = np.polyfit(np.log(x), np.log(yp), 1)
cases['power_fit'] = {
    'reference': 'numpy.polyfit(log x, log y, 1)',
    'input': {'x': arr(x), 'y': arr(yp)},
    'expected': {'a': float(np.exp(intercept)), 'b': float(slope)},
}

# Non-linear least squares: exponential, exponential with offset, first-order response.
tx = np.linspace(0.0, 8.0, 300)
ye = 5.0 * np.exp(-0.6 * tx) + 0.03 * rng.standard_normal(tx.size)
pe, _ = optimize.curve_fit(lambda t, a, b: a * np.exp(b * t), tx, ye, p0=(4.0, -0.5), xtol=1e-14, ftol=1e-14, gtol=1e-14)
yo = 5.0 * np.exp(-0.6 * tx) + 1.5 + 0.03 * rng.standard_normal(tx.size)
po, _ = optimize.curve_fit(lambda t, a, b, c: a * np.exp(b * t) + c, tx, yo, p0=(4.0, -0.5, 1.0), xtol=1e-14, ftol=1e-14, gtol=1e-14)
yf = 2.5 * (1 - np.exp(-tx / 1.3)) + 0.02 * rng.standard_normal(tx.size)
pf, _ = optimize.curve_fit(lambda t, k, tau: k * (1 - np.exp(-t / tau)), tx, yf, p0=(2.0, 1.0), xtol=1e-14, ftol=1e-14, gtol=1e-14)
cases['exponential_fits'] = {
    'reference': 'scipy.optimize.curve_fit (least squares on y)',
    'input': {'x': arr(tx), 'exponential': arr(ye), 'exponentialOffset': arr(yo), 'firstOrder': arr(yf)},
    'expected': {
        'exponential': {'a': float(pe[0]), 'b': float(pe[1]),
                        'sse': float(np.sum((ye - pe[0] * np.exp(pe[1] * tx)) ** 2))},
        'exponentialOffset': {'a': float(po[0]), 'b': float(po[1]), 'c': float(po[2]),
                              'sse': float(np.sum((yo - po[0] * np.exp(po[1] * tx) - po[2]) ** 2))},
        'firstOrder': {'K': float(pf[0]), 'timeConstant': float(pf[1]),
                       'sse': float(np.sum((yf - pf[0] * (1 - np.exp(-tx / pf[1]))) ** 2))},
    },
}

# --- Statistics and histogram ---------------------------------------------------
v = rng.gamma(2.0, 1.5, 1000) - 1.0
counts, edges = np.histogram(v, bins=12, range=(v.min(), v.max()))
cases['statistics'] = {
    'reference': 'numpy (min, max, mean, sqrt(mean(v**2)), percentile)',
    'input': {'values': arr(v)},
    'expected': {'min': float(v.min()), 'max': float(v.max()), 'mean': float(v.mean()),
                 'rms': float(np.sqrt(np.mean(v ** 2))),
                 'q1': float(np.percentile(v, 25)), 'q3': float(np.percentile(v, 75))},
}
cases['histogram'] = {
    'reference': 'numpy.histogram(v, bins=12, range=(min, max))',
    'input': {'values': arr(v), 'bins': 12},
    'expected': {'edges': arr(edges), 'counts': arr(counts)},
}

# --- Calculus on an uneven time axis ------------------------------------------
t = np.cumsum(rng.uniform(0.01, 0.05, 500))
y = np.sin(2 * np.pi * 0.8 * t) + 0.3 * t
cases['integral'] = {
    'reference': 'scipy.integrate.cumulative_trapezoid(y, t, initial=0); numpy.trapezoid(y, t)',
    'input': {'times': arr(t), 'values': arr(y)},
    'expected': {'cumulative': arr(integrate.cumulative_trapezoid(y, t, initial=0)),
                 'definite': float(np.trapezoid(y, t))},
}
tu = np.arange(400) * 0.02
yu = np.sin(2 * np.pi * 1.5 * tu) * np.exp(-0.3 * tu)
cases['derivative'] = {
    'reference': 'numpy.gradient(y, dt) (central differences, one-sided at the ends)',
    'input': {'times': arr(tu), 'values': arr(yu)},
    'expected': {'values': arr(np.gradient(yu, 0.02))},
}

# --- Smoothing and detrending ---------------------------------------------------
s = np.cumsum(rng.standard_normal(300)) + 0.05 * np.arange(300)
window = 9
cases['moving_average'] = {
    'reference': 'numpy.convolve(s, ones(9) / 9, "valid") (interior samples only)',
    'input': {'values': arr(s), 'window': window},
    'expected': {'interior': arr(np.convolve(s, np.ones(window) / window, 'valid')), 'offset': window // 2},
}
cases['detrend'] = {
    'reference': 'scipy.signal.detrend(s, type="linear" | "constant")',
    'input': {'values': arr(s)},
    'expected': {'linear': arr(signal.detrend(s, type='linear')), 'mean': arr(signal.detrend(s, type='constant'))},
}

# --- Digital filters ------------------------------------------------------------
fs = 1000.0
freqs = np.linspace(1.0, 499.0, 96)
designs = []
for family, response, order, cutoff, extra in [
    ('butterworth', 'lowpass', 4, [80.0], {}),
    ('butterworth', 'highpass', 5, [120.0], {}),
    ('butterworth', 'bandpass', 3, [60.0, 180.0], {}),
    ('butterworth', 'bandstop', 2, [45.0, 55.0], {}),
    ('chebyshev1', 'lowpass', 5, [100.0], {'rippleDb': 1.0}),
    ('chebyshev1', 'bandpass', 3, [90.0, 210.0], {'rippleDb': 0.5}),
    ('chebyshev2', 'lowpass', 6, [150.0], {'attenuationDb': 40.0}),
    ('chebyshev2', 'highpass', 4, [200.0], {'attenuationDb': 50.0}),
    ('bessel', 'lowpass', 4, [70.0], {}),
    ('bessel', 'highpass', 3, [140.0], {}),
]:
    wn = cutoff[0] if len(cutoff) == 1 else cutoff
    if family == 'butterworth':
        sos = signal.butter(order, wn, btype=response, fs=fs, output='sos')
    elif family == 'chebyshev1':
        sos = signal.cheby1(order, extra['rippleDb'], wn, btype=response, fs=fs, output='sos')
    elif family == 'chebyshev2':
        sos = signal.cheby2(order, extra['attenuationDb'], wn, btype=response, fs=fs, output='sos')
    else:
        sos = signal.bessel(order, wn, btype=response, fs=fs, output='sos', norm='mag')
    _, h = signal.sosfreqz(sos, worN=freqs, fs=fs)
    designs.append({'family': family, 'response': response, 'order': order, 'cutoff': cutoff, **extra,
                    'magnitudeDb': arr(20 * np.log10(np.abs(h)))})
cases['filter_design'] = {
    'reference': 'scipy.signal.butter / cheby1 / cheby2 / bessel(norm="mag"), response by scipy.signal.sosfreqz',
    'input': {'sampleRate': fs, 'frequencies': arr(freqs)},
    'expected': {'designs': designs},
}

b, a = signal.butter(4, 80.0, btype='lowpass', fs=fs)
xs = np.sin(2 * np.pi * 20 * np.arange(600) / fs) + 0.5 * rng.standard_normal(600) + 2.0
zi = signal.lfilter_zi(b, a)
cases['filter_apply'] = {
    'reference': 'scipy.signal.butter(4, 80, fs=1000); lfilter (zero state, and lfilter_zi * x[0]); filtfilt(padtype="odd", padlen=12)',
    'input': {'values': arr(xs), 'b': arr(b), 'a': arr(a)},
    'expected': {
        'b': arr(b), 'a': arr(a),
        'forwardZero': arr(signal.lfilter(b, a, xs)),
        'forwardSteady': arr(signal.lfilter(b, a, xs, zi=zi * xs[0])[0]),
        'zeroPhase': arr(signal.filtfilt(b, a, xs, padtype='odd', padlen=12)),
    },
}

# --- Cross-correlation ------------------------------------------------------------
n = 200
xa = rng.standard_normal(n).cumsum() * 0.1 + rng.standard_normal(n)
xb = np.roll(xa, 7) + 0.3 * rng.standard_normal(n)
max_lag = 25
lags = np.arange(-max_lag, max_lag + 1)
xa0 = xa - xa.mean()
xb0 = xb - xb.mean()
full = np.correlate(xa0, xb0, 'full')            # c[k] = sum_n xa0[n + k] * xb0[n], k = -(n-1) .. n-1
raw = full[(n - 1) + lags]
overlap = n - np.abs(lags)
cases['cross_correlation'] = {
    'reference': 'numpy.correlate(x - mean, y - mean, "full"), lags -25..25',
    'input': {'x': arr(xa), 'y': arr(xb), 'maxLag': max_lag},
    'expected': {
        'lags': arr(lags),
        'none': arr(raw),
        'biased': arr(raw / n),
        'unbiased': arr(raw / overlap),
        'coeff': arr(raw / np.sqrt(np.sum(xa0 ** 2) * np.sum(xb0 ** 2))),
    },
}

document = {
    'about': 'Reference values for scripts/test-numerical-reference.mjs. Written by scripts/validation/make-reference.py; do not edit by hand.',
    'generator': {'numpy': np.__version__, 'scipy': scipy.__version__, 'seed': 20261128},
    'cases': cases,
}
with open(OUT, 'w', encoding='utf-8') as handle:
    json.dump(document, handle, separators=(',', ':'))
    handle.write('\n')
print(f'{len(cases)} cases written to {os.path.normpath(OUT)} ({os.path.getsize(OUT) / 1024:.0f} KB)')
