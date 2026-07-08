import assert from 'node:assert/strict';
import {
    analyzeSampling,
    computeAmplitudeSpectrum,
    fftRadix2,
    fftWindowCoefficients,
    nextPowerOfTwo,
    spectrumCursorMeasurements,
} from '../src/utils/fft.js';
import translations from '../src/i18n/translations.js';

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

console.log('FFT tests passed');
