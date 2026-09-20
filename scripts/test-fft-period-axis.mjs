// Reading the spectrum by period instead of by frequency (#108).
//
// Same bins, same amplitudes, the other end of T = 1/f. What has to hold: the
// order reverses (the lowest frequency is the longest period), DC drops out
// (it has no period), a zoom means the same window either way, and the panel's
// arithmetic keeps working in data units on an axis Plotly reports in log10.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    FFT_X_AXIS_DEFAULT,
    FFT_X_AXIS_MODES,
    convertFftAxisLimits,
    invertAxisValue,
    invertAxisWindow,
    normalizeFftXAxisMode,
    periodSeriesFromSpectrum,
} from '../src/utils/fft-period-axis.js';
import { buildFftExportColumns } from '../src/utils/fft-export.js';

// ── The two readings ────────────────────────────────────────────────────────
assert.deepEqual(FFT_X_AXIS_MODES, ['frequency', 'period']);
assert.equal(FFT_X_AXIS_DEFAULT, 'frequency', 'a panel that says nothing is a frequency panel');
assert.equal(normalizeFftXAxisMode('period'), 'period');
assert.equal(normalizeFftXAxisMode('wavelength'), 'frequency', 'an unknown reading falls back');
assert.equal(normalizeFftXAxisMode(undefined), 'frequency', 'and so does a session saved before this existed');

assert.equal(invertAxisValue(2), 0.5, '2 Hz is half a second');
assert.equal(invertAxisValue(0.25), 4);
assert.equal(invertAxisValue(0), null, 'DC has no period');
assert.equal(invertAxisValue(NaN), null);
assert.equal(invertAxisValue(null), null);

// A window on one axis is the inverted window on the other, ends swapped.
assert.deepEqual(invertAxisWindow(0.25, 2), { lo: 0.5, hi: 4 },
    '0.25–2 Hz is exactly 0.5–4 s');
assert.deepEqual(invertAxisWindow(2, 0.25), { lo: 4, hi: 0.5 }, 'no sorting: the caller knows its axis');
assert.deepEqual(invertAxisWindow(null, 2), { lo: 0.5, hi: null }, 'an open end stays open');
assert.deepEqual(invertAxisWindow(0, 2), { lo: 0.5, hi: null }, 'and so does a window that starts at DC');

// The stored limits follow the switch, so a zoom is not lost.
assert.deepEqual(convertFftAxisLimits(0.25, 2), { min: 0.5, max: 4 });
assert.deepEqual(convertFftAxisLimits(null, null), { min: null, max: null }, 'unset stays unset');
assert.deepEqual(convertFftAxisLimits(0.25, null), { min: null, max: 4 },
    'a lower frequency bound is an upper period bound');
assert.deepEqual(convertFftAxisLimits('', 2), { min: 0.5, max: null });

// ── The series ──────────────────────────────────────────────────────────────
const frequencies = Float64Array.from([0, 0.25, 0.5, 2]);
const amplitudes = Float64Array.from([9, 1, 2, 3]);
const period = periodSeriesFromSpectrum(frequencies, amplitudes);
assert.deepEqual(Array.from(period.periods), [0.5, 2, 4], 'ascending in period');
assert.deepEqual(Array.from(period.amplitudes), [3, 2, 1], 'each amplitude travels with its own bin');
assert.deepEqual(Array.from(period.frequencies), [2, 0.5, 0.25],
    'and so does its frequency, which the hover and the CSV still read');
assert.equal(period.periods.length, 3, 'the DC bin is left out rather than drawn at infinity');
assert.ok(period.periods instanceof Float64Array, 'typed, like the frequency series');

const empty = periodSeriesFromSpectrum(new Float64Array(0), new Float64Array(0));
assert.equal(empty.periods.length, 0);
assert.equal(periodSeriesFromSpectrum(Float64Array.from([0]), Float64Array.from([1])).periods.length, 0,
    'a spectrum that is only DC has nothing to say about periods');
// A round trip changes nothing but the order.
const back = periodSeriesFromSpectrum(frequencies, amplitudes).frequencies;
assert.deepEqual(Array.from(back).sort((a, b) => a - b), [0.25, 0.5, 2]);

// ── The CSV says what the screen says ───────────────────────────────────────
const entries = [{ name: 'signal', frequencies: Float64Array.from([0, 0.5, 2]), amplitudes: Float64Array.from([0, 2, 3]) }];
const plain = buildFftExportColumns(entries, { frequencyUnit: ' [Hz]' });
assert.deepEqual(plain.headers, ['frequency [Hz]', 'signal amplitude'], 'a frequency panel exports what it always did');
const withPeriod = buildFftExportColumns(entries, { frequencyUnit: ' [Hz]', periodUnit: ' [s]' });
assert.deepEqual(withPeriod.headers, ['frequency [Hz]', 'period [s]', 'signal amplitude']);
assert.deepEqual(withPeriod.columns[1], ['', 2, 0.5], 'DC has no period, and an empty cell says so');

// ── Wired into the panel ────────────────────────────────────────────────────
const fft = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');
assert.match(fft, /xAxisMode: normalizeFftXAxisMode\(raw\.xAxisMode\)/, 'the reading is part of the panel state');
assert.match(fft, /proto\._setFftXAxisMode = function\(panelId, mode\) \{/, 'and switching it is one place');
assert.match(fft, /const limits = convertFftAxisLimits\(state\.fMin, state\.fMax\);/,
    'which carries the x limits across');
assert.match(fft, /plot\.cursorsSpectrum\[key\] = invertAxisValue\(value\)/,
    'and the cursors, which mark bins rather than numbers');
// Plotly takes and reports a log axis in log10; nothing else in the panel does.
assert.match(fft, /\.\.\.\(this\._fftXAxisIsPeriod\(plot\) \? \{ type: 'log' \} : \{ type: 'linear' \}\)/,
    'the period axis is logarithmic — the bins crowd into its short end otherwise');
assert.match(fft, /return this\._fftXAxisIsPeriod\(plot\) \? \[10 \*\* lo, 10 \*\* hi\] : \[lo, hi\];/,
    'a range read back from the layout comes home in data units');
assert.match(fft, /return \[Math\.log10\(lo\), Math\.log10\(hi\)\];/, 'and a range written out goes in log10');
// The spectrum pane's own range is read in exactly one place — the reader that
// undoes the log — so no caller can pick it up raw. (The TIME pane's x range is
// a different axis and stays linear.)
assert.equal((fft.match(/fftDiv\?\._fullLayout\?\.xaxis\?\.range/g) || []).length, 1,
    'one reader of the spectrum x range, and it converts');
assert.match(fft, /proto\._fftVisibleXRange = function\(plot\) \{\s*\n\s*return this\._fftAxisDataRange\(plot, plot\?\.fftDiv\?\._fullLayout\?\.xaxis\?\.range\);/,
    'and that reader is the one');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['fftXAxis', 'fftXAxisFrequency', 'fftXAxisPeriod', 'fftXAxisTooltip',
    'fftTMin', 'fftTMax', 'fftTMinTooltip', 'fftTMaxTooltip',
    'fftAutoXRangePeriod', 'fftAutoXRangePeriodTooltip']) {
    assert.equal([...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

console.log('FFT period-axis checks passed.');
