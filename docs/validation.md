# How the numbers are verified

Time Series Explorer computes spectra, fits, integrals, statistics and filters
in its own JavaScript code. This page says how those results are checked.

## Against NumPy and SciPy

`npm run test:numerical-reference` compares the app's numerical kernels with
NumPy and SciPy on the same inputs.

- `scripts/validation/make-reference.py` draws the input signals with a seeded
  generator, computes each result with NumPy/SciPy and writes inputs and
  expected results to `test-files/validation/reference.json` (the NumPy and
  SciPy versions used are recorded in the file).
- `scripts/test-numerical-reference.mjs` runs the app's kernels on those inputs
  and fails when a result differs from the reference by more than the
  tolerance stated at each check. With `--report` it prints the largest error
  of every check.

The test runs with the rest of the suite (`npm test`) and on every pull
request. It needs no Python: the reference file is committed. Python, NumPy and
SciPy are needed only to regenerate it.

| Computation | Reference | Largest relative error |
| --- | --- | --- |
| FFT (complex, 256 points) | `numpy.fft.fft` | 2 × 10⁻¹⁵ |
| Window functions (Hann, Hamming, Blackman, flat top) | `scipy.signal.get_window` | 3 × 10⁻¹⁶ |
| Amplitude spectrum (zero-padded, three windows) | `numpy.fft.rfft` | 6 × 10⁻¹⁵ |
| Pearson correlation | `scipy.stats.pearsonr` | 3 × 10⁻¹⁶ |
| Linear fit (intercept, slope, r, R², SSE, RMSE) | `scipy.stats.linregress` | 5 × 10⁻¹⁵ |
| Quadratic fit | `numpy.polyfit` | 3 × 10⁻¹⁴ |
| Power-law fit | `numpy.polyfit` on logarithms | 1 × 10⁻¹⁵ |
| Exponential, exponential + offset and first-order fits (parameters) | `scipy.optimize.curve_fit` | 4 × 10⁻⁸ |
| The same fits (sum of squared residuals) | `scipy.optimize.curve_fit` | 8 × 10⁻¹³ |
| Minimum, maximum, mean, RMS, quartiles | NumPy | 6 × 10⁻¹⁶ |
| Histogram (edges and counts) | `numpy.histogram` | exact |
| Cumulative and definite integral, uneven steps | `scipy.integrate.cumulative_trapezoid`, `numpy.trapezoid` | 6 × 10⁻¹⁶ |
| Derivative (central differences) | `numpy.gradient` | 5 × 10⁻¹⁵ |
| Moving average | `numpy.convolve` | 5 × 10⁻¹⁶ |
| Detrend (mean, linear) | `scipy.signal.detrend` | 3 × 10⁻¹⁵ |
| IIR filter design: Butterworth, Chebyshev I and II, Bessel; low-pass, high-pass, band-pass, band-stop (magnitude response, in dB) | `scipy.signal.butter`, `cheby1`, `cheby2`, `bessel` | 3 × 10⁻¹¹ dB |
| Filtering, forward and zero-phase | `scipy.signal.lfilter`, `filtfilt` | exact |
| Cross-correlation (raw, biased, unbiased, coefficient) | `numpy.correlate` | 3 × 10⁻¹⁶ |

Measured with NumPy 2.5.3 and SciPy 1.18.1. The iterative fits stop at their
own tolerance on each side, which is why their parameters agree to 10⁻⁸ and
not to rounding; the minimum they reach is the same.

Conventions worth knowing when comparing with another tool:

- Windows are periodic (SciPy's `fftbins=True`), not symmetric.
- The amplitude spectrum is single-sided: `|FFT| / sum(window)`, doubled except
  at DC and at the Nyquist frequency, so a sinusoid of amplitude A reads A.
- A positive cross-correlation lag k pairs `x[n + k]` with `y[n]`.
- The Bessel filter is normalised to −3 dB at the cut-off (SciPy's
  `norm="mag"`).
- Zero-phase filtering pads each end by odd reflection over three times the
  filter order (SciPy's `filtfilt` with `padtype="odd"`, `padlen=3 * order`).
- The moving average is centred; near the two ends, where the window does not
  fit, the app's rule is its own and is not part of this comparison.

## Against closed forms

Each kernel also has a test of its own against values known in closed form
(the integral of a constant, a sinusoid centred on an FFT bin, a fit of exact
data) and of its edge cases: missing values, gaps, repeated timestamps,
calendar time. They are the `test:*` scripts of `package.json`, in `scripts/`.

## In memory and in memory-saving mode

A file can be held in memory or stay on disk in an embedded DuckDB database
(memory-saving mode). Every analysis must give the same numbers both ways. The
`test:lazy-*` scripts open the same file both ways and compare: bit for bit
where the same kernel runs on both paths, within a stated tolerance where one
side is computed in SQL. See [any-size-files.md](any-size-files.md).

## File readers

The readers are tested on files written by the tools themselves: MATLAB,
OpenModelica and Dymola results, pandas pickles, Excel workbooks, Parquet,
netCDF and GRIB (`test-files/`), and a corpus of delimited text files in the
formats of real instruments and loggers (`test-files/csv-real-world/`), on
which the app's two CSV readers must agree with each other.
