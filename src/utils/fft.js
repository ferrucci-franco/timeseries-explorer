export const FFT_UNIFORM_REL_TOLERANCE = 1e-3;
export const FFT_DB_FLOOR = -200;
export const FFT_LIVE_MAX_POINTS = 2 ** 22;
export const FFT_MAX_POINTS_WEB = 2 ** 24;
export const FFT_MAX_POINTS_DESKTOP = 2 ** 26;
// Above this NFFT, compute off the main thread (Web Worker) so a heavy
// zero-padded transform never freezes the tab. Below it, the synchronous cost
// (~<100ms) is cheaper than spawning + messaging a worker. This is only a
// "where to run it" switch; the hard/live caps above still bound the size.
export const FFT_WORKER_THRESHOLD_POINTS = 2 ** 18;

// A zero-padded spectrum can hold hundreds of thousands of bins (NFFT/2), but a
// pane is only ~1000px wide. Rendering, hover, and the per-bin period-label pass
// all scale with the point count and freeze the tab at high padding. Collapse to
// min/max buckets: each bucket keeps its lowest AND highest amplitude sample at
// their true frequencies, so peaks (and troughs) survive exactly — a cursor
// still snaps to the real peak — while the drawn point count stays bounded.
// Frequencies are ascending, so the output stays sorted.
export const FFT_SPECTRUM_MAX_DISPLAY = 12000;
export function downsampleSpectrumForDisplay(frequencies, amplitudes, maxPoints = FFT_SPECTRUM_MAX_DISPLAY) {
    const n = Math.min(frequencies?.length || 0, amplitudes?.length || 0);
    if (n <= maxPoints) return { frequencies, amplitudes };
    const buckets = Math.max(1, Math.floor(maxPoints / 2));
    const outF = new Float64Array(buckets * 2);
    const outA = new Float64Array(buckets * 2);
    let out = 0;
    for (let b = 0; b < buckets; b++) {
        const start = Math.floor((b * n) / buckets);
        const end = Math.min(n, Math.floor(((b + 1) * n) / buckets));
        if (end <= start) continue;
        let minI = start;
        let maxI = start;
        for (let i = start + 1; i < end; i++) {
            if (amplitudes[i] < amplitudes[minI]) minI = i;
            if (amplitudes[i] > amplitudes[maxI]) maxI = i;
        }
        const lo = Math.min(minI, maxI);
        const hi = Math.max(minI, maxI);
        outF[out] = frequencies[lo]; outA[out] = amplitudes[lo]; out++;
        if (hi !== lo) { outF[out] = frequencies[hi]; outA[out] = amplitudes[hi]; out++; }
    }
    return { frequencies: outF.subarray(0, out), amplitudes: outA.subarray(0, out) };
}

// Downsample only the [lo, hi] frequency slice of a spectrum. Zooming shrinks
// the window, so fewer bins fall inside it and they are shown at full (or near
// full) resolution — that is how the fine detail zero-padding buys becomes
// visible without ever drawing the whole padded spectrum at once. Frequencies
// must be ascending (they are, straight from the FFT). Pass lo/hi = null to get
// the whole spectrum downsampled (the zoomed-all-the-way-out view).
export function windowSpectrumForDisplay(frequencies, amplitudes, lo, hi, maxPoints = FFT_SPECTRUM_MAX_DISPLAY) {
    const n = Math.min(frequencies?.length || 0, amplitudes?.length || 0);
    if (!n) return { frequencies: new Float64Array(0), amplitudes: new Float64Array(0) };
    let start = 0;
    let end = n;
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
        let a = 0;
        let b = n;
        while (a < b) { const m = (a + b) >> 1; if (frequencies[m] < lo) a = m + 1; else b = m; }
        start = a;
        a = start; b = n;
        while (a < b) { const m = (a + b) >> 1; if (frequencies[m] <= hi) a = m + 1; else b = m; }
        end = a;
        // One extra sample each side so the drawn line reaches the pane edges.
        if (start > 0) start -= 1;
        if (end < n) end += 1;
    }
    return downsampleSpectrumForDisplay(frequencies.subarray(start, end), amplitudes.subarray(start, end), maxPoints);
}

const TWO_PI = Math.PI * 2;

const FFT_PERIOD_SIGNIFICANT_DIGITS = 6;

function formatFftReadoutNumber(value) {
    if (Number.isNaN(value)) return '\u2014';
    if (value === Infinity) return '\u221e';
    if (value === -Infinity) return '-\u221e';
    if (!Number.isFinite(value)) return '\u2014';
    if (Object.is(value, -0) || value === 0) return '0';
    return Number(value.toPrecision(FFT_PERIOD_SIGNIFICANT_DIGITS)).toString();
}

// A compact, deterministic duration for spectrum readouts. The two largest
// non-zero components are enough to make long periods immediately legible
// without turning Plotly hovers or the cursor box into a paragraph.
export function formatNaturalDuration(seconds, maxParts = 2) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return formatFftReadoutNumber(value);

    const sign = value < 0 ? '-' : '';
    const magnitude = Math.abs(value);
    if (magnitude < 60) return `${formatFftReadoutNumber(value)} s`;

    let remaining = Math.floor(magnitude);
    const parts = [];
    const limit = Math.max(1, Math.floor(Number(maxParts) || 2));
    const units = [
        [86400, 'd'],
        [3600, 'h'],
        [60, 'min'],
        [1, 's'],
    ];
    for (const [size, label] of units) {
        const amount = Math.floor(remaining / size);
        remaining %= size;
        if (!amount) continue;
        parts.push(`${amount} ${label}`);
        if (parts.length >= limit) break;
    }
    return `${sign}${parts.join(' ')}`;
}

// The raw value and its physical unit are always retained. Only second-based
// periods receive the additional natural form; sample or generic x-axis units
// must never be presented as clock time.
export function formatSpectrumPeriod(period, unit = 's') {
    const value = Number(period);
    const numberText = formatFftReadoutNumber(value);
    if (numberText === '\u2014') return numberText;
    const normalizedUnit = String(unit || '').trim();
    const raw = normalizedUnit ? `${numberText} ${normalizedUnit}` : numberText;
    if (normalizedUnit !== 's' || !Number.isFinite(value) || Math.abs(value) < 60) return raw;
    const natural = formatNaturalDuration(value, 2);
    return natural && natural !== raw ? `${raw} (${natural})` : raw;
}

export function frequencyPeriod(frequency) {
    if (!Number.isFinite(frequency)) return NaN;
    if (frequency === 0) return Infinity;
    return 1 / Math.abs(frequency);
}

// Readout values for the spectrum measurement cursors. Periods use the
// magnitude of the exact frequencies (two-sided spectra can be negative);
// f = 0 and deltaF = 0 map to Infinity instead of dividing blindly, and the
// callers render Infinity as an infinity symbol.
export function spectrumCursorMeasurements(freqA, freqB) {
    const deltaF = Number.isFinite(freqA) && Number.isFinite(freqB)
        ? Math.abs(freqB - freqA)
        : NaN;
    const inverseDeltaF = !Number.isFinite(deltaF)
        ? NaN
        : (deltaF === 0 ? Infinity : 1 / deltaF);
    return {
        periodA: frequencyPeriod(freqA),
        periodB: frequencyPeriod(freqB),
        deltaF,
        inverseDeltaF,
    };
}

export function nextPowerOfTwo(value) {
    const n = Math.ceil(Number(value));
    if (!Number.isFinite(n) || n <= 1) return 1;
    return 2 ** Math.ceil(Math.log2(n));
}

export function fftRadix2(real, imag = null) {
    const n = real?.length || 0;
    if (!n || (n & (n - 1)) !== 0) {
        throw new Error('FFT length must be a power of two.');
    }
    const re = real instanceof Float64Array ? real : Float64Array.from(real || []);
    const im = imag
        ? (imag instanceof Float64Array ? imag : Float64Array.from(imag))
        : new Float64Array(n);
    if (im.length !== n) throw new Error('FFT real and imaginary arrays must have the same length.');

    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const angle = -TWO_PI / len;
        const wLenRe = Math.cos(angle);
        const wLenIm = Math.sin(angle);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let wRe = 1;
            let wIm = 0;
            for (let j = 0; j < half; j++) {
                const even = i + j;
                const odd = even + half;
                const uRe = re[even];
                const uIm = im[even];
                const vRe = re[odd] * wRe - im[odd] * wIm;
                const vIm = re[odd] * wIm + im[odd] * wRe;
                re[even] = uRe + vRe;
                im[even] = uIm + vIm;
                re[odd] = uRe - vRe;
                im[odd] = uIm - vIm;

                const nextRe = wRe * wLenRe - wIm * wLenIm;
                wIm = wRe * wLenIm + wIm * wLenRe;
                wRe = nextRe;
            }
        }
    }

    return { real: re, imag: im };
}

export function fftWindowCoefficients(type = 'none', length = 0) {
    const n = Math.max(0, Math.trunc(Number(length) || 0));
    const key = normalizeFftWindow(type);
    const out = new Float64Array(n);
    if (!n) return out;
    if (key === 'none') {
        out.fill(1);
        return out;
    }
    for (let i = 0; i < n; i++) {
        const a = TWO_PI * i / n;
        if (key === 'hann') {
            out[i] = 0.5 - 0.5 * Math.cos(a);
        } else if (key === 'hamming') {
            out[i] = 0.54 - 0.46 * Math.cos(a);
        } else if (key === 'blackman') {
            out[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
        } else if (key === 'flattop') {
            out[i] = 0.21557895
                - 0.41663158 * Math.cos(a)
                + 0.277263158 * Math.cos(2 * a)
                - 0.083578947 * Math.cos(3 * a)
                + 0.006947368 * Math.cos(4 * a);
        }
    }
    return out;
}

export function normalizeFftWindow(type) {
    const key = String(type || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (key === 'hann' || key === 'hanning') return 'hann';
    if (key === 'hamming') return 'hamming';
    if (key === 'blackman') return 'blackman';
    if (key === 'flattop' || key === 'flat') return 'flattop';
    return 'none';
}

export function normalizeFftScale(scale) {
    const key = String(scale || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (key === 'db' || key === 'decibel') return 'db';
    if (key === 'dbrelative' || key === 'relative') return 'dbRelative';
    return 'normal';
}

export function analyzeSampling(times, options = {}) {
    const timeKind = options.timeKind || 'numeric';
    const tolerance = Number.isFinite(Number(options.tolerance))
        ? Number(options.tolerance)
        : FFT_UNIFORM_REL_TOLERANCE;
    const values = Array.from(times || [], Number);
    if (values.length < 2) {
        return { ok: false, reason: 'tooFewSamples', dt: NaN, sampleRate: NaN, maxRelativeError: NaN };
    }
    if (timeKind === 'index') {
        return {
            ok: true,
            dt: 1,
            sampleRate: 1,
            maxRelativeError: 0,
            frequencyUnit: 'cycles/sample',
        };
    }

    const scale = timeKind === 'datetime' ? 1000 : 1;
    const deltas = new Array(values.length - 1);
    for (let i = 1; i < values.length; i++) {
        const dt = (values[i] - values[i - 1]) / scale;
        if (!Number.isFinite(dt) || dt <= 0) {
            return { ok: false, reason: 'nonMonotonic', dt: NaN, sampleRate: NaN, maxRelativeError: Infinity };
        }
        deltas[i - 1] = dt;
    }
    const dt = median(deltas);
    if (!Number.isFinite(dt) || dt <= 0) {
        return { ok: false, reason: 'nonUniform', dt, sampleRate: NaN, maxRelativeError: Infinity };
    }
    let maxRelativeError = 0;
    for (const value of deltas) {
        maxRelativeError = Math.max(maxRelativeError, Math.abs(value - dt) / dt);
    }
    if (maxRelativeError >= tolerance) {
        return { ok: false, reason: 'nonUniform', dt, sampleRate: 1 / dt, maxRelativeError };
    }
    return {
        ok: true,
        dt,
        sampleRate: 1 / dt,
        maxRelativeError,
        frequencyUnit: timeKind === 'datetime' ? 'Hz' : '1/x-unit',
    };
}

// Default multiple of the median step above which an interval counts as a
// gap (missing samples). 1.5x flags a single dropped sample while staying
// clear of ordinary jitter.
export const FFT_GAP_THRESHOLD_FACTOR = 1.5;

// Locate gaps (runs of missing samples) in a time vector. Pure and unit-
// agnostic: `times` are the raw values (ms for datetime series, x-units
// otherwise), and every returned dt/t0/t1 is in those same units so callers
// can draw them or intersect them with a selection range directly. Used to
// highlight gaps in the FFT time pane; it does not itself relax the FFT
// uniformity gate.
export function detectSamplingGaps(times, options = {}) {
    const factor = Number.isFinite(Number(options.thresholdFactor))
        ? Number(options.thresholdFactor)
        : FFT_GAP_THRESHOLD_FACTOR;
    const values = times instanceof Float64Array ? times : Float64Array.from(times || [], Number);
    const n = values.length;
    const empty = { medianDt: NaN, gaps: [], count: 0, totalMissing: 0, largest: null };
    if (n < 3) return empty;

    const deltas = [];
    for (let i = 1; i < n; i++) {
        const d = values[i] - values[i - 1];
        if (Number.isFinite(d) && d > 0) deltas.push(d);
    }
    if (deltas.length < 2) return empty;
    deltas.sort((a, b) => a - b);
    const mid = deltas.length >> 1;
    const medianDt = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
    if (!Number.isFinite(medianDt) || medianDt <= 0) return { ...empty, medianDt };

    const threshold = medianDt * factor;
    const gaps = [];
    let totalMissing = 0;
    let largest = null;
    for (let i = 1; i < n; i++) {
        const dt = values[i] - values[i - 1];
        if (!(dt > threshold)) continue;
        const missing = Math.max(1, Math.round(dt / medianDt) - 1);
        const gap = { index: i - 1, t0: values[i - 1], t1: values[i], dt, missing };
        gaps.push(gap);
        totalMissing += missing;
        if (!largest || dt > largest.dt) largest = gap;
    }
    return { medianDt, gaps, count: gaps.length, totalMissing, largest };
}

// Runs of non-finite (NaN/Inf) values, returned as the time interval each
// hole spans — from the last good sample before the run to the first good
// sample after — so a band drawn over [t0, t1] covers the actual break in the
// line. `times`/`values` share an index; the interval is in `times` units.
export function detectNaNRuns(times, values) {
    const t = times instanceof Float64Array ? times : Float64Array.from(times || [], Number);
    const n = Math.min(t.length, values?.length || 0);
    const runs = [];
    let start = -1;
    for (let i = 0; i < n; i++) {
        const bad = !Number.isFinite(Number(values[i]));
        if (bad && start < 0) start = i;
        if (start >= 0 && (!bad || i === n - 1)) {
            const end = bad ? i : i - 1;
            const t0 = start > 0 ? t[start - 1] : t[start];
            const t1 = end < n - 1 ? t[end + 1] : t[end];
            if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
                runs.push({ t0, t1, count: end - start + 1 });
            }
            start = -1;
        }
    }
    return runs;
}

export function computeAmplitudeSpectrum(input = {}) {
    const rawTimes = input.times || [];
    const rawValues = input.values || [];
    const rawN = Math.min(rawTimes.length || 0, rawValues.length || 0);
    if (rawN < 2) return invalidSpectrum('tooFewSamples');

    const timeKind = input.timeKind || 'numeric';
    const parsedTimes = new Float64Array(rawN);
    const parsedValues = new Float64Array(rawN);
    for (let i = 0; i < rawN; i++) {
        const t = Number(rawTimes[i]);
        const v = Number(rawValues[i]);
        if (!Number.isFinite(t)) return invalidSpectrum('invalidTime');
        if (!Number.isFinite(v)) return invalidSpectrum('nan');
        parsedTimes[i] = t;
        parsedValues[i] = v;
    }

    const normalized = collapseAdjacentDuplicateTimes(parsedTimes, parsedValues, timeKind);
    const { times, values } = normalized;
    const n = times.length;
    if (n < 2) return invalidSpectrum('tooFewSamples', {
        originalN: rawN,
        duplicateTimeCount: normalized.duplicateCount,
    });

    const sampling = analyzeSampling(times, {
        timeKind,
        tolerance: input.uniformTolerance,
    });
    if (!sampling.ok) return invalidSpectrum(sampling.reason || 'nonUniform', { sampling });

    const zeroPaddingFactor = normalizeZeroPaddingFactor(input.zeroPaddingFactor);
    const baseNfft = nextPowerOfTwo(n);
    const nfft = baseNfft * zeroPaddingFactor;
    const maxNfft = Number.isFinite(Number(input.maxNfft)) ? Number(input.maxNfft) : Infinity;
    if (nfft > maxNfft) return invalidSpectrum('tooManyPoints', { n, nfft, maxNfft, sampling });

    const removeMean = input.removeMean !== false;
    let mean = 0;
    if (removeMean) {
        for (const value of values) mean += value;
        mean /= n;
    }

    const windowType = normalizeFftWindow(input.windowType || input.window || 'none');
    const window = fftWindowCoefficients(windowType, n);
    let windowSum = 0;
    const real = new Float64Array(nfft);
    for (let i = 0; i < n; i++) {
        const w = window[i];
        windowSum += w;
        real[i] = (values[i] - (removeMean ? mean : 0)) * w;
    }
    if (!Number.isFinite(windowSum) || Math.abs(windowSum) <= Number.EPSILON) {
        return invalidSpectrum('invalidWindow', { n, nfft, sampling });
    }

    const { real: re, imag: im } = fftRadix2(real);
    const bins = (nfft >> 1) + 1;
    const frequencies = new Float64Array(bins);
    const amplitudes = new Float64Array(bins);
    const rawAmplitudes = new Float64Array(bins);
    const scale = normalizeFftScale(input.amplitudeScale || input.scale || 'normal');
    const dbFloor = Number.isFinite(Number(input.dbFloor)) ? Number(input.dbFloor) : FFT_DB_FLOOR;
    const epsilon = 10 ** (dbFloor / 20);
    const sampleRate = sampling.sampleRate;

    for (let k = 0; k < bins; k++) {
        let amplitude = Math.hypot(re[k], im[k]) / windowSum;
        if (k > 0 && k < nfft / 2) amplitude *= 2;
        frequencies[k] = k * sampleRate / nfft;
        rawAmplitudes[k] = amplitude;
    }

    let relativePeak = -Infinity;
    if (scale === 'dbRelative') {
        for (let k = 1; k < rawAmplitudes.length; k++) {
            const value = rawAmplitudes[k];
            if (Number.isFinite(value) && value > relativePeak) relativePeak = value;
        }
    }
    const relativePeakValid = Number.isFinite(relativePeak) && relativePeak > epsilon;
    for (let k = 0; k < bins; k++) {
        const amplitude = rawAmplitudes[k];
        if (scale === 'db') {
            amplitudes[k] = Math.max(dbFloor, 20 * Math.log10(Math.max(amplitude, epsilon)));
        } else if (scale === 'dbRelative') {
            amplitudes[k] = relativePeakValid
                ? Math.max(dbFloor, 20 * Math.log10(Math.max(amplitude / relativePeak, epsilon)))
                : dbFloor;
        } else {
            amplitudes[k] = amplitude;
        }
    }

    const warnings = [];
    if (normalized.duplicateCount > 0) warnings.push('duplicateTimes');
    if (scale === 'dbRelative' && !relativePeakValid) warnings.push('noSpectralContent');
    return {
        ok: true,
        frequencies,
        amplitudes,
        rawAmplitudes,
        n,
        nfft,
        sampleRate,
        sampleInterval: sampling.dt,
        frequencyUnit: sampling.frequencyUnit,
        windowType,
        windowSum,
        meanRemoved: removeMean ? mean : 0,
        warnings,
        sampling,
        originalN: rawN,
        duplicateTimeCount: normalized.duplicateCount,
    };
}

export function selectFftRange(times, values, range) {
    const n = Math.min(times?.length || 0, values?.length || 0);
    if (!Array.isArray(range) || range.length < 2) {
        return {
            times: sliceLike(times, 0, n),
            values: sliceLike(values, 0, n),
        };
    }
    let [lo, hi] = range.map(Number);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        return { times: sliceLike(times, 0, n), values: sliceLike(values, 0, n) };
    }
    if (lo > hi) [lo, hi] = [hi, lo];
    const outTimes = [];
    const outValues = [];
    for (let i = 0; i < n; i++) {
        const t = Number(times[i]);
        if (Number.isFinite(t) && t >= lo && t <= hi) {
            outTimes.push(t);
            outValues.push(Number(values[i]));
        }
    }
    return {
        times: Float64Array.from(outTimes),
        values: Float64Array.from(outValues),
    };
}

export function normalizeZeroPaddingFactor(value) {
    const n = Math.round(Number(value));
    return [1, 2, 4, 8, 16].includes(n) ? n : 1;
}

function invalidSpectrum(reason, extra = {}) {
    return {
        ok: false,
        reason,
        frequencies: new Float64Array(0),
        amplitudes: new Float64Array(0),
        rawAmplitudes: new Float64Array(0),
        ...extra,
    };
}

function collapseAdjacentDuplicateTimes(times, values, timeKind) {
    if (timeKind === 'index') return { times, values, duplicateCount: 0 };
    let hasDuplicate = false;
    for (let i = 1; i < times.length; i++) {
        if (times[i] === times[i - 1]) {
            hasDuplicate = true;
            break;
        }
    }
    if (!hasDuplicate) return { times, values, duplicateCount: 0 };

    const outTimes = new Float64Array(times.length);
    const outValues = new Float64Array(values.length);
    let write = 0;
    let duplicateCount = 0;
    for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (write > 0 && t === outTimes[write - 1]) {
            outTimes[write - 1] = t;
            outValues[write - 1] = values[i];
            duplicateCount++;
        } else {
            outTimes[write] = t;
            outValues[write] = values[i];
            write++;
        }
    }
    return {
        times: outTimes.slice(0, write),
        values: outValues.slice(0, write),
        duplicateCount,
    };
}

function median(values) {
    const sorted = Array.from(values || [], Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sliceLike(values, start, end) {
    if (!values) return [];
    if (typeof values.slice === 'function') return values.slice(start, end);
    return Array.from(values).slice(start, end);
}
