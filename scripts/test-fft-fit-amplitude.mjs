// "Fit Y" on an FFT panel scales to what is on screen.
//
// It scaled to the whole spectrum. Zoomed into a decade whose amplitudes are a
// thousandth of the fundamental's, the button flattened everything visible
// against a peak nobody could see — which is the one thing the press was asking
// it not to do. The time pane's own fit has always read its visible window;
// this is the same question asked of the spectrum.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { amplitudeExtentInRange } from '../src/utils/fft.js';

const series = (x, y) => ({ x: Float64Array.from(x), y: Float64Array.from(y) });

// ─── The extent over a window ──────────────────────────────────────
{
    // A big fundamental at 1 Hz, small harmonics further out.
    const spectrum = series([0, 1, 2, 3, 4, 5], [0.01, 100, 0.4, 0.2, 0.05, 0.02]);

    assert.deepEqual(amplitudeExtentInRange([spectrum]), { min: 0.01, max: 100 },
        'with no window it still answers for the whole spectrum');
    assert.deepEqual(amplitudeExtentInRange([spectrum], 2, 5), { min: 0.02, max: 0.4 },
        'zoomed past the fundamental, the scale belongs to the harmonics');
    assert.deepEqual(amplitudeExtentInRange([spectrum], 0.5, 1.5), { min: 100, max: 100 },
        'a window holding one bin is that bin');
}

// Both ends are inclusive: a bin exactly on the edge is on screen.
{
    const spectrum = series([0, 1, 2], [5, 9, 7]);
    assert.deepEqual(amplitudeExtentInRange([spectrum], 1, 2), { min: 7, max: 9 });
}

// ─── Several traces, and the gaps in them ──────────────────────────
{
    const a = series([0, 1, 2], [1, 2, 3]);
    const b = series([0, 1, 2], [10, 0.5, 4]);
    assert.deepEqual(amplitudeExtentInRange([a, b], 1, 2), { min: 0.5, max: 4 },
        'the window spans every trace in it');
}
{
    // A line break (NaN) is not an amplitude.
    const holed = series([0, 1, 2], [1, NaN, 3]);
    assert.deepEqual(amplitudeExtentInRange([holed], 0, 2), { min: 1, max: 3 });
}

// ─── Nothing in the window ─────────────────────────────────────────
for (const [label, args] of [
    ['past the end', [[series([0, 1], [1, 2])], 10, 20]],
    ['no traces', [[], 0, 1]],
    ['null', [null, 0, 1]],
    ['an empty trace', [[series([], [])], 0, 1]],
    ['all NaN', [[series([0, 1], [NaN, NaN])], 0, 1]],
]) {
    assert.equal(amplitudeExtentInRange(...args), null, `${label}: no extent`);
}

// ─── How the panel asks ────────────────────────────────────────────
const fft = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');

assert.match(fft, /proto\._fftVisibleSpectrumYExtent = function\(plot\) \{[\s\S]{0,200}?this\._fftVisibleXRange\(plot\)/,
    'the window is the spectrum pane’s own x axis, in data units whichever reading is on (#108)');
assert.match(fft, /_fftSpectra \|\| \[\]\)\.filter\(trace => trace\?\.visible !== 'legendonly'\)/,
    'a trace hidden from the legend is not part of what the user is looking at');

// Only the fit button asks about the window. Home and every recompute must keep
// answering for the whole spectrum, or a zoom would survive in the amplitude
// axis after the frequency axis had gone back to everything.
assert.match(fft, /const ext = \(axis === 'y' && options\.visibleOnly && this\._fftVisibleSpectrumYExtent\(plot\)\)\s*\n\s*\|\| this\._fftSpectrumExtent\(plot, axis\);/,
    'with nothing in the window it falls back to the whole spectrum');
assert.match(fft, /_autoScaleFftAxis = function\(plot, axis\) \{[\s\S]{0,200}?_fftAxisLimitUpdate\(plot, axis, \{ visibleOnly: true \}\)/,
    'the fit button asks for the visible window');
assert.match(fft, /proto\._applyFftAxisLimits = function\(plot\) \{[\s\S]{0,320}?_fftAxisLimitUpdate\(plot, 'y'\),/,
    'restoring the panel does not');

// A manual amplitude limit still wins over either: it is a setting, not a view.
const limitUpdate = fft.slice(fft.indexOf('proto._fftAxisLimitUpdate'), fft.indexOf('proto._applyFftAxisLimits'));
assert.match(limitUpdate, /if \(manualRange\) \{[\s\S]{0,200}?return update;/,
    'manual yMin/yMax are applied before any extent is computed');

// The second half of the report — the button acting on the time pane as well as
// the spectrum — is already in place; keep it that way.
assert.match(fft, /_autoScaleFftAxis[\s\S]{0,900}?Plotly\.relayout\(plot\.div, this\._autoScaleAxisUpdate\(plot, 'y', \{ treatAsTimeseries: true \}\)\)/,
    'one press still fits the time pane too');

console.log('FFT fit-amplitude checks passed.');
