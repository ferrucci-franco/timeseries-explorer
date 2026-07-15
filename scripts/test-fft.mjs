import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    analyzeSampling,
    computeAmplitudeSpectrum,
    detectSamplingGaps,
    fftRadix2,
    fftWindowCoefficients,
    formatNaturalDuration,
    formatSpectrumPeriod,
    nextPowerOfTwo,
    spectrumCursorMeasurements,
} from '../src/utils/fft.js';
import translations from '../src/i18n/translations.js';

const fftMethodsSource = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');
const interactionMethodsSource = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');

const close = (actual, expected, tolerance, label) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`,
    );
};

const peak = (spectrum, startBin = 1) => {
    let index = startBin;
    let value = -Infinity;
    for (let i = startBin; i < spectrum.rawAmplitudes.length; i++) {
        const candidate = spectrum.rawAmplitudes[i];
        if (candidate > value) {
            value = candidate;
            index = i;
        }
    }
    return { index, frequency: spectrum.frequencies[index], amplitude: value };
};

const sine = ({ n, fs, frequency, amplitude = 1, offset = 0 }) => {
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        times[i] = i / fs;
        values[i] = offset + amplitude * Math.sin(2 * Math.PI * frequency * times[i]);
    }
    return { times, values };
};

const cosine = ({ n, fs, frequency, amplitude = 1, offset = 0 }) => {
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        times[i] = i / fs;
        values[i] = offset + amplitude * Math.cos(2 * Math.PI * frequency * times[i]);
    }
    return { times, values };
};

assert.equal(nextPowerOfTwo(1), 1);
assert.equal(nextPowerOfTwo(513), 1024);

{
    const real = Float64Array.from([1, 0, 0, 0]);
    const { real: re, imag: im } = fftRadix2(real);
    close(re[0], 1, 1e-12, 'impulse re0');
    close(re[1], 1, 1e-12, 'impulse re1');
    close(re[2], 1, 1e-12, 'impulse re2');
    close(re[3], 1, 1e-12, 'impulse re3');
    close(im[0], 0, 1e-12, 'impulse im0');
}

{
    const n = 1024;
    const fs = 1024;
    const frequency = 64;
    const amplitude = 2.5;
    const signal = sine({ n, fs, frequency, amplitude });
    const spectrum = computeAmplitudeSpectrum(signal);
    assert.equal(spectrum.ok, true, 'bin-centered sine spectrum succeeds');
    const p = peak(spectrum);
    close(p.frequency, frequency, 1e-12, 'bin-centered sine frequency');
    close(p.amplitude, amplitude, amplitude * 0.01, 'bin-centered sine amplitude');
}

{
    const n = 1024;
    const fs = 1024;
    const frequency = 64;
    const amplitude = 2.5;
    const signal = sine({ n, fs, frequency, amplitude });
    const times = Float64Array.from([...signal.times, signal.times[signal.times.length - 1]]);
    const values = Float64Array.from([...signal.values, signal.values[signal.values.length - 1]]);
    const spectrum = computeAmplitudeSpectrum({ times, values });
    assert.equal(spectrum.ok, true, 'adjacent duplicate timestamp spectrum succeeds');
    assert.equal(spectrum.n, n, 'duplicate timestamp is collapsed before FFT');
    assert.equal(spectrum.duplicateTimeCount, 1, 'duplicate timestamp count is reported');
    assert.ok(spectrum.warnings.includes('duplicateTimes'), 'duplicate timestamp warning is reported');
    const p = peak(spectrum);
    close(p.frequency, frequency, 1e-12, 'duplicate timestamp sine frequency');
    close(p.amplitude, amplitude, amplitude * 0.01, 'duplicate timestamp sine amplitude');
}

{
    // detectSamplingGaps: uniform 10-min series (in ms) with two dropped runs.
    const step = 600_000; // 10 min in ms, mimicking datetime timeKind
    const times = [];
    let t = 0;
    for (let i = 0; i < 20; i++) { times.push(t); t += step; }
    t += step * 3;                       // 3 missing samples (single gap)
    for (let i = 0; i < 20; i++) { times.push(t); t += step; }
    t += step;                           // 1 missing sample
    for (let i = 0; i < 20; i++) { times.push(t); t += step; }
    const info = detectSamplingGaps(times);
    assert.equal(info.medianDt, step, 'gap detector uses the median step');
    assert.equal(info.count, 2, 'both gaps are detected');
    assert.equal(info.totalMissing, 4, 'missing-sample count sums across gaps');
    assert.equal(info.largest.missing, 3, 'largest gap reports its missing run');
    assert.ok(info.gaps[0].t1 > info.gaps[0].t0, 'gap interval is ordered');

    const perfect = detectSamplingGaps(Float64Array.from({ length: 50 }, (_, i) => i * step));
    assert.equal(perfect.count, 0, 'a perfectly uniform series has no gaps');
}

for (const windowType of ['hann', 'hamming', 'blackman']) {
    const n = 1024;
    const fs = 1024;
    const frequency = 64;
    const amplitude = 1.75;
    const signal = sine({ n, fs, frequency, amplitude });
    const spectrum = computeAmplitudeSpectrum({ ...signal, windowType });
    assert.equal(spectrum.ok, true, `${windowType} spectrum succeeds`);
    const p = peak(spectrum);
    close(p.frequency, frequency, 1e-12, `${windowType} frequency`);
    close(p.amplitude, amplitude, amplitude * 0.01, `${windowType} coherent-gain amplitude`);
    const sum = fftWindowCoefficients(windowType, n).reduce((a, b) => a + b, 0);
    close(spectrum.windowSum, sum, 1e-9, `${windowType} window sum`);
}

{
    const n = 256;
    const times = Float64Array.from({ length: n }, (_, i) => i);
    const values = Float64Array.from({ length: n }, () => 3);
    const spectrum = computeAmplitudeSpectrum({ times, values, timeKind: 'index', removeMean: false });
    assert.equal(spectrum.ok, true, 'constant spectrum succeeds');
    close(spectrum.rawAmplitudes[0], 3, 1e-12, 'constant DC bin is not doubled');
    const nonDcPeak = peak(spectrum, 1);
    close(nonDcPeak.amplitude, 0, 1e-12, 'constant non-DC bins are zero');
}

{
    const n = 256;
    const fs = 256;
    const amplitude = 4;
    const signal = cosine({ n, fs, frequency: fs / 2, amplitude });
    const spectrum = computeAmplitudeSpectrum(signal);
    assert.equal(spectrum.ok, true, 'Nyquist spectrum succeeds');
    const nyquist = spectrum.rawAmplitudes[spectrum.rawAmplitudes.length - 1];
    close(nyquist, amplitude, amplitude * 0.01, 'Nyquist bin is not doubled');
}

{
    const n = 600;
    const fs = 1000;
    const frequency = 125;
    const amplitude = 2;
    const signal = sine({ n, fs, frequency, amplitude });
    const spectrum = computeAmplitudeSpectrum(signal);
    assert.equal(spectrum.ok, true, 'non-power-of-two zero-padded spectrum succeeds');
    assert.equal(spectrum.nfft, 1024, 'non-power-of-two uses next power of two');
    const p = peak(spectrum);
    close(p.frequency, frequency, 1e-12, 'zero-padded peak frequency');
    close(p.amplitude, amplitude, amplitude * 0.01, 'zero-padded peak amplitude');
}

{
    const signal = sine({ n: 513, fs: 1024, frequency: 128, amplitude: 1 });
    const accepted = computeAmplitudeSpectrum({ ...signal, maxNfft: 1024 });
    assert.equal(accepted.ok, true, 'NFFT equal to max is accepted');
    assert.equal(accepted.nfft, 1024, 'NFFT reaches the configured cap');

    const rejected = computeAmplitudeSpectrum({ ...signal, maxNfft: 512 });
    assert.equal(rejected.ok, false, 'NFFT above max is rejected');
    assert.equal(rejected.reason, 'tooManyPoints');
    assert.equal(rejected.nfft, 1024, 'rejection reports requested NFFT');
    assert.equal(rejected.maxNfft, 512, 'rejection reports configured cap');
}

{
    const n = 256;
    const fs = 256;
    const frequency = 23.4;
    const amplitude = 1;
    const signal = sine({ n, fs, frequency, amplitude });
    const x1 = computeAmplitudeSpectrum({ ...signal, zeroPaddingFactor: 1 });
    const x8 = computeAmplitudeSpectrum({ ...signal, zeroPaddingFactor: 8 });
    const p1 = peak(x1);
    const p8 = peak(x8);
    assert.ok(Math.abs(p8.frequency - frequency) < Math.abs(p1.frequency - frequency), 'x8 padding improves peak frequency readout');
    assert.ok(Math.abs(p8.amplitude - amplitude) < Math.abs(p1.amplitude - amplitude), 'x8 padding reduces scalloping readout error');
    close(x8.frequencies[1] - x8.frequencies[0], fs / x8.nfft, 1e-12, 'frequency step is fs / NFFT');
}

{
    const n = 1024;
    const fs = 1024;
    const signal = sine({ n, fs, frequency: 32, amplitude: 1, offset: 10 });
    const spectrum = computeAmplitudeSpectrum({ ...signal, removeMean: true });
    assert.equal(spectrum.ok, true, 'remove-mean spectrum succeeds');
    close(spectrum.rawAmplitudes[0], 0, 1e-12, 'remove mean suppresses DC');
}

{
    const n = 1024;
    const fs = 1024;
    const signal = sine({ n, fs, frequency: 64, amplitude: 2, offset: 20 });
    const spectrum = computeAmplitudeSpectrum({ ...signal, removeMean: false, amplitudeScale: 'dbRelative' });
    assert.equal(spectrum.ok, true, 'dB relative spectrum succeeds');
    const p = peak(spectrum);
    close(spectrum.amplitudes[p.index], 0, 1e-9, 'dB relative peak excludes DC and is 0 dB');
    assert.ok(spectrum.amplitudes[0] > 0, 'DC may be above 0 dB when remove mean is off, but it is not the relative reference');
}

{
    const n = 1000;
    const fs = 100;
    const frequency = 12.5;
    const amplitude = 1.3;
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        times[i] = i * 10;
        values[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / fs);
    }
    const spectrum = computeAmplitudeSpectrum({ times, values, timeKind: 'datetime' });
    assert.equal(spectrum.ok, true, 'datetime ms spectrum succeeds');
    const p = peak(spectrum);
    close(p.frequency, frequency, 0.1, 'datetime axis produces Hz');
    close(p.amplitude, amplitude, amplitude * 0.03, 'datetime amplitude');
}

{
    const dt = 0.01;
    const jittered = Float64Array.from({ length: 1000 }, (_, i) => i * dt + (i % 2 ? dt * 5e-5 : 0));
    const pass = analyzeSampling(jittered);
    assert.equal(pass.ok, true, 'small relative jitter passes uniformity check');
    assert.ok(pass.maxRelativeError < 1e-3, 'small jitter remains under tolerance');

    const gap = Float64Array.from({ length: 1000 }, (_, i) => i < 500 ? i * dt : (i + 1) * dt);
    const fail = analyzeSampling(gap);
    assert.equal(fail.ok, false, '2x gap fails uniformity check');
    assert.equal(fail.reason, 'nonUniform');
}

{
    // Spectrum measurement-cursor readout math.
    const basic = spectrumCursorMeasurements(0.5, 2);
    close(basic.periodA, 2, 1e-12, 'fA=0.5 Hz gives TA=2 s');
    close(basic.periodB, 0.5, 1e-12, 'fB=2 Hz gives TB=0.5 s');
    close(basic.deltaF, 1.5, 1e-12, 'deltaF is |fB - fA|');

    const spaced = spectrumCursorMeasurements(10, 12);
    close(spaced.deltaF, 2, 1e-12, 'fA=10, fB=12 gives deltaF=2 Hz');
    close(spaced.inverseDeltaF, 0.5, 1e-12, 'fA=10, fB=12 gives 1/deltaF=0.5 s');

    const reversed = spectrumCursorMeasurements(12, 10);
    close(reversed.deltaF, 2, 1e-12, 'deltaF uses the absolute separation');

    const same = spectrumCursorMeasurements(3, 3);
    assert.equal(same.deltaF, 0, 'fA=fB gives deltaF=0');
    assert.equal(same.inverseDeltaF, Infinity, 'fA=fB maps 1/deltaF to Infinity, not NaN');
    assert.ok(!Number.isNaN(same.inverseDeltaF), 'no NaN when cursors coincide');

    const zero = spectrumCursorMeasurements(0, 2);
    assert.equal(zero.periodA, Infinity, 'f=0 maps the period to Infinity without errors');
    close(zero.deltaF, 2, 1e-12, 'deltaF still finite with f=0');

    const negative = spectrumCursorMeasurements(-2, 4);
    close(negative.periodA, 0.5, 1e-12, 'negative frequency uses T=1/|f|');
    close(negative.deltaF, 6, 1e-12, 'deltaF spans across zero');

    const undefinedCursor = spectrumCursorMeasurements(NaN, 2);
    assert.ok(Number.isNaN(undefinedCursor.periodA), 'undefined cursor gives NaN period');
    assert.ok(Number.isNaN(undefinedCursor.deltaF), 'undefined cursor gives NaN deltaF');
    assert.ok(Number.isNaN(undefinedCursor.inverseDeltaF), 'undefined cursor gives NaN 1/deltaF');

    // The inverse-spacing helper exists in every language and explains the
    // beat-period interpretation.
    for (const lang of ['en', 'fr', 'es', 'it']) {
        const strings = translations[lang];
        assert.ok(strings?.fftCursorInverseSpacing, `${lang}: inverse-spacing label present`);
        const help = strings?.fftCursorInverseSpacingHelp || '';
        assert.ok(help.length > 120, `${lang}: inverse-spacing help present`);
        assert.ok(/batt|beat|batido/i.test(help), `${lang}: help mentions the beat interpretation`);
        assert.ok(help.includes('1/|f2 - f1|'), `${lang}: help states the 1/|f2 - f1| relation`);
    }
}

{
    // Human-readable spectrum periods: preserve the exact value in seconds,
    // then add at most two non-zero natural components. Components below the
    // limit are intentionally truncated rather than rounded.
    assert.equal(formatNaturalDuration(0), '0 s', 'zero duration stays in seconds');
    assert.equal(formatNaturalDuration(0.25), '0.25 s', 'subsecond duration stays in seconds');
    assert.equal(formatNaturalDuration(45.125), '45.125 s', 'fractional seconds are preserved');
    assert.equal(formatNaturalDuration(90), '1 min 30 s', 'seconds decompose into minutes and seconds');
    assert.equal(formatNaturalDuration(5400), '1 h 30 min', '90 minutes decompose into hours and minutes');
    assert.equal(formatNaturalDuration(86400), '1 d', '24 hours become one day');
    assert.equal(formatNaturalDuration(86461), '1 d 1 min', 'zero intermediate components do not consume the two-part limit');
    assert.equal(formatNaturalDuration(90061), '1 d 1 h', 'components below the two-part limit are truncated');
    assert.equal(formatNaturalDuration(2592000), '30 d', '30 days remain an exact day count');
    assert.equal(formatNaturalDuration(289855.072), '3 d 8 h', 'the motivating low-frequency period uses two natural components');
    assert.equal(formatNaturalDuration(5400, 1), '1 h', 'the maxParts argument limits the decomposition');
    assert.equal(formatNaturalDuration(Infinity), '∞', 'infinite duration uses the infinity symbol');
    assert.equal(formatNaturalDuration(NaN), '—', 'invalid duration uses an unavailable marker');

    assert.equal(formatSpectrumPeriod(0.25), '0.25 s', 'no redundant natural suffix is added for subsecond periods');
    assert.equal(formatSpectrumPeriod(90), '90 s (1 min 30 s)', 'natural decomposition supplements exact seconds');
    assert.equal(formatSpectrumPeriod(5400), '5400 s (1 h 30 min)', '90-minute period keeps seconds and natural units');
    assert.equal(formatSpectrumPeriod(86400), '86400 s (1 d)', 'daily period keeps seconds and natural units');
    assert.equal(formatSpectrumPeriod(2592000), '2592000 s (30 d)', 'monthly-scale period keeps seconds and natural units');
    assert.equal(formatSpectrumPeriod(2, 'samples'), '2 samples', 'sample periods are not presented as clock time');
    assert.equal(formatSpectrumPeriod(2, 'x-unit'), '2 x-unit', 'generic inverse-frequency units are preserved');
    assert.equal(formatSpectrumPeriod(Infinity), '∞ s', 'infinite Hz period retains the seconds unit');
    assert.equal(formatSpectrumPeriod(Infinity, ''), '∞', 'infinite unitless period has no dangling space');
    assert.equal(formatSpectrumPeriod(NaN), '—', 'invalid period is presented consistently');

    for (const lang of ['en', 'fr', 'es', 'it']) {
        assert.ok(translations[lang]?.fftPeriod, `${lang}: spectrum period label present`);
        assert.ok(translations[lang]?.fftSampleUnit, `${lang}: sample-period unit present`);
    }

    // Lightweight integration guards: the Plotly trace must carry the
    // preformatted period readout, and measurement cursors must render each
    // frequency and period on separate semantic rows. These intentionally
    // avoid asserting the surrounding HTML whitespace or localized labels.
    assert.match(fftMethodsSource, /\bfrequencyPeriod\b/, 'spectrum builds a period value for every frequency');
    assert.match(fftMethodsSource, /\bformatNaturalDuration\b/, 'spectrum hover builds compact natural suffixes');
    assert.match(
        fftMethodsSource,
        /const periodValues = new Float64Array\(spectrum\.frequencies\.length\)/,
        'spectrum keeps numeric periods in a compact typed array',
    );
    assert.match(fftMethodsSource, /customdata:\s*periodValues/, 'spectrum carries numeric period values through customdata');
    assert.match(fftMethodsSource, /text:\s*naturalPeriodSuffixes/, 'spectrum carries only natural-unit suffixes through text');
    assert.match(
        fftMethodsSource,
        /hovertemplate:[^\n]*fftPeriod[^\n]*%\{customdata:\.6g\}[^\n]*%\{text\}/,
        'spectrum hover combines numeric customdata with the optional natural suffix',
    );
    assert.match(interactionMethodsSource, /\bformatSpectrumPeriod\b/, 'measurement cursors use the shared period formatter');
    assert.match(
        interactionMethodsSource,
        /const inverseDxText = view\.isSpectrum\s*\?\s*formatPeriod\(inverseDxValue\)/,
        'spectrum 1/delta-f readout uses the same natural period formatter',
    );
    assert.match(interactionMethodsSource, /fftSampleUnit/, 'index spectra use a sample period instead of clock time');
    assert.match(interactionMethodsSource, /cursor-spectrum-frequency-row/, 'measurement cursors have a semantic frequency row');
    assert.match(interactionMethodsSource, /cursor-spectrum-period-row/, 'measurement cursors have a separate semantic period row');

    // Cursor-drag regression: Plotly can briefly leave the box-zoom guard set
    // while a cursor drag is already active. The readout still refreshes in
    // that state, but an unforced overlay render leaves the vertical line at
    // its old position until mouseup. Keep the complete mousemove -> forced
    // sync -> overlay-render path covered without requiring a browser DOM.
    const cursorMoveStart = interactionMethodsSource.indexOf('const onDocMove = (event) => {');
    const cursorUpStart = interactionMethodsSource.indexOf('const onDocUp = () => {', cursorMoveStart);
    assert.ok(cursorMoveStart >= 0 && cursorUpStart > cursorMoveStart, 'cursor mousemove and mouseup handlers are present');
    const cursorMoveSource = interactionMethodsSource.slice(cursorMoveStart, cursorUpStart);
    assert.match(
        cursorMoveSource,
        /this\._syncCursorDisplay\(panelId, plot, \{ force: true \}\)/,
        'cursor mousemove forces the visual overlay refresh before mouseup',
    );

    const cursorSyncStart = interactionMethodsSource.indexOf('proto._syncCursorDisplay = function');
    const cursorGeometryStart = interactionMethodsSource.indexOf('proto._cursorOverlayGeometry = function', cursorSyncStart);
    assert.ok(cursorSyncStart >= 0 && cursorGeometryStart > cursorSyncStart, 'cursor display synchronizer is present');
    const cursorSyncSource = interactionMethodsSource.slice(cursorSyncStart, cursorGeometryStart);
    assert.match(
        cursorSyncSource,
        /this\._renderCursorViewOverlay\(view, options\)/,
        'cursor display synchronization forwards force to the visual renderer',
    );

    const cursorRenderStart = interactionMethodsSource.indexOf('proto._renderCursorViewOverlay = function');
    const cursorHideStart = interactionMethodsSource.indexOf('proto._hideCursorOverlay = function', cursorRenderStart);
    assert.ok(cursorRenderStart >= 0 && cursorHideStart > cursorRenderStart, 'cursor overlay renderer is present');
    const cursorRenderSource = interactionMethodsSource.slice(cursorRenderStart, cursorHideStart);
    assert.match(
        cursorRenderSource,
        /plot\._cursorBoxZoomActive\s*&&\s*!options\.force/,
        'forced cursor renders bypass the transient box-zoom guard',
    );
}

console.log('FFT tests passed');
