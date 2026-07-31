// The same recording must analyse the same way whatever format its time axis
// is DISPLAYED in. Seconds, Duration and Calendar are three ways of writing the
// same instants; none of them changes the signal, so none may change whether an
// FFT runs or what unit its frequency axis carries.
//
// Two defects this pins, both found on a ten-minute 44.1 kHz recording:
//
//   1. Promoting the numeric axis to an absolute calendar was refused with
//      "Sampling is not uniform enough", while the identical data passed as
//      seconds. Nothing about the sampling changed — only the offset.
//
//   2. Showing the same numeric seconds as a duration lost the hertz: the
//      frequency axis fell back to the generic 1/x-unit.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeSampling } from '../src/utils/fft.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const SAMPLE_RATE = 44100;
const STEP_SECONDS = 1 / SAMPLE_RATE;
const ORIGIN_MS = 1767225600000; // 2026-01-01T00:00:00Z
const COUNT = 20000;

// Exactly how the app stores each format: seconds as elapsed numbers, calendar
// as absolute epoch milliseconds in the same Float64Array.
const secondsAxis = new Float64Array(COUNT);
const calendarAxis = new Float64Array(COUNT);
for (let i = 0; i < COUNT; i++) {
    secondsAxis[i] = i * STEP_SECONDS;
    calendarAxis[i] = ORIGIN_MS + i * STEP_SECONDS * 1000;
}

// The premise: at epoch magnitude the step is only a few dozen ulp wide, so the
// deltas cannot come out uniform however clean the signal is.
{
    const ulp = 2 ** (Math.floor(Math.log2(ORIGIN_MS)) - 52);
    const stepMs = STEP_SECONDS * 1000;
    assert.ok(ulp > 0 && stepMs / ulp < 200,
        `the fixture must sit near the float64 floor to exercise this: ${(stepMs / ulp).toFixed(0)} ulp per step`);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < COUNT; i++) {
        const d = calendarAxis[i] - calendarAxis[i - 1];
        if (d < min) min = d;
        if (d > max) max = d;
    }
    assert.ok((max - min) / stepMs > 0.005,
        'the calendar axis must really show quantisation spread, or this test proves nothing');
}

// Seconds: clean, and that is the reference answer.
const fromSeconds = analyzeSampling(secondsAxis, { timeKind: 'numeric' });
assert.equal(fromSeconds.ok, true, 'seconds must analyse');
assert.ok(Math.abs(fromSeconds.sampleRate - SAMPLE_RATE) / SAMPLE_RATE < 1e-6,
    'seconds recovers the sample rate exactly');

// Calendar: same signal, same verdict. This is the regression.
const fromCalendar = analyzeSampling(calendarAxis, { timeKind: 'datetime' });
assert.equal(fromCalendar.ok, true,
    `the same recording must not be refused once promoted to a calendar (got ${fromCalendar.reason})`);
assert.equal(fromCalendar.frequencyUnit, 'Hz', 'an absolute calendar axis is in hertz');
// The rate comes from quantised deltas, so it is close rather than exact.
assert.ok(Math.abs(fromCalendar.sampleRate - SAMPLE_RATE) / SAMPLE_RATE < 0.01,
    `the recovered rate must stay within 1% of ${SAMPLE_RATE}, got ${fromCalendar.sampleRate}`);
// And it is accepted BECAUSE of the representation floor, not because the
// tolerance is loose: the raw error is far above the configured one.
assert.ok(fromCalendar.maxRelativeError > 1e-3,
    'the calendar deltas really are outside the ordinary tolerance');

// The floor must not become a blanket amnesty: genuine jitter well above the
// representation limit is still refused at the same magnitude.
{
    const jittered = new Float64Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
        // Every tenth step is half again as long — far beyond a few ulp.
        jittered[i] = ORIGIN_MS + (i + (i % 10 === 0 ? 0.5 : 0)) * STEP_SECONDS * 1000;
    }
    const result = analyzeSampling(jittered, { timeKind: 'datetime' });
    assert.equal(result.ok, false, 'real non-uniformity is still refused at epoch magnitude');
    assert.equal(result.reason, 'nonUniform', 'and refused for the right reason');
}

// On an axis whose step is nowhere near the float64 floor, the floor term is
// negligible and the ordinary tolerance still decides.
{
    const coarse = new Float64Array(COUNT);
    for (let i = 0; i < COUNT; i++) coarse[i] = i + (i % 10 === 0 ? 0.5 : 0);
    const result = analyzeSampling(coarse, { timeKind: 'numeric' });
    assert.equal(result.ok, false, 'a jittered ordinary axis is unaffected by the floor');
}

// Monotonicity is still non-negotiable.
{
    const backwards = Float64Array.from(calendarAxis);
    backwards[500] = backwards[499] - 1;
    assert.equal(analyzeSampling(backwards, { timeKind: 'datetime' }).reason, 'nonMonotonic',
        'a step backwards is refused regardless of magnitude');
}

// ── The frequency axis keeps its hertz in every format ─────────────────────
// Duration is a way of WRITING numeric seconds, so the spectrum is still in
// hertz; the unit label reads 'duration' there, which is what dropped it.
{
    const fft = read('src/plots/methods/fft-methods.js');
    const start = fft.indexOf('proto._fftFrequencyAxisTitle = function');
    const end = fft.indexOf('\n};', start);
    assert.ok(start >= 0 && end > start, 'the frequency-axis title builder can be isolated');
    const body = fft.slice(start, end);
    assert.match(body, /_isNumericDurationAxis\(/,
        'a numeric axis shown as a duration must still be recognised as seconds');
    // The branches that already meant "this axis is in seconds" must stay.
    for (const branch of ["kind === 'datetime'", "mode === 'elapsedSeconds'", "unit === 's'"]) {
        assert.ok(body.includes(branch), `the ${branch} branch must survive`);
    }
}

console.log('FFT time-format invariance checks passed.');
