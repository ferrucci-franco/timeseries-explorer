// What the FFT panel writes when you ask it for data.
//
// It wrote the time series. The CSV branch read
// `mode === 'timeseries' || mode === 'fft'` and stopped there, so pressing
// Export → Data (CSV) on a spectrum handed back the samples underneath it —
// which the source file already holds, and a time-series panel already exports.
// The spectrum exists nowhere else.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildFftExportColumns } from '../src/utils/fft-export.js';

const entry = (name, frequencies, amplitudes, extra = {}) => ({
    name,
    varName: name,
    fileId: 'f1',
    frequencies: Float64Array.from(frequencies),
    amplitudes: Float64Array.from(amplitudes),
    ...extra,
});

const UNITS = { theta: 'rad', omega: 'rad/s' };
const options = (overrides = {}) => ({
    frequencyUnit: ' [Hz]',
    amplitudeScaleUnit: '',
    nameFor: (e) => e.varName,
    unitFor: (e) => UNITS[e.varName] || '',
    ...overrides,
});

// ─── One grid, one frequency column ────────────────────────────────
{
    const { headers, columns } = buildFftExportColumns([
        entry('theta', [0, 1, 2, 3], [4, 3, 2, 1]),
        entry('omega', [0, 1, 2, 3], [1, 2, 3, 4]),
    ], options());

    assert.deepEqual(headers, ['frequency [Hz]', 'theta amplitude [rad]', 'omega amplitude [rad/s]'],
        'frequency once, then one amplitude per signal, each with its own unit');
    assert.equal(columns.length, 3);
    assert.deepEqual([...columns[0]], [0, 1, 2, 3], 'the bins');
    assert.deepEqual([...columns[1]], [4, 3, 2, 1], 'the amplitudes as drawn');
    assert.deepEqual([...columns[2]], [1, 2, 3, 4]);
}

// ─── Different grids, a frequency column each ──────────────────────
// Two files at different sample rates, or one trace analysed over a shorter
// selection: the bins do not line up, and sharing a column would put one
// trace's amplitudes against the other's frequencies.
{
    const { headers, columns } = buildFftExportColumns([
        entry('theta', [0, 1, 2, 3], [4, 3, 2, 1]),
        entry('omega', [0, 2, 4, 6], [1, 2, 3, 4]),
    ], options());

    assert.deepEqual(headers, [
        'theta frequency [Hz]', 'theta amplitude [rad]',
        'omega frequency [Hz]', 'omega amplitude [rad/s]',
    ], 'each trace brings its own frequency column');
    assert.deepEqual([...columns[2]], [0, 2, 4, 6], 'and its own bins');
}

// A grid of the same length that ends elsewhere is still a different grid.
{
    const { headers } = buildFftExportColumns([
        entry('a', [0, 1, 2], [1, 1, 1]),
        entry('b', [0, 1, 9], [1, 1, 1]),
    ], options({ unitFor: () => '' }));
    assert.equal(headers.length, 4, 'not shared');
}

// ─── The amplitude unit follows the scale ──────────────────────────
{
    const { headers } = buildFftExportColumns(
        [entry('theta', [0, 1], [1, 2])],
        options({ amplitudeScaleUnit: ' [dB]' }),
    );
    assert.deepEqual(headers, ['frequency [Hz]', 'theta amplitude [dB]'],
        'on a dB scale the amplitude is in dB, not in the signal’s unit');
}
{
    const { headers } = buildFftExportColumns(
        [entry('nounit', [0, 1], [1, 2])],
        options({ unitFor: () => '' }),
    );
    assert.deepEqual(headers, ['frequency [Hz]', 'nounit amplitude'],
        'a signal with no unit says nothing rather than an empty bracket');
}

// ─── Nothing to write ──────────────────────────────────────────────
for (const [label, entries] of [
    ['no spectra', []],
    ['null', null],
    ['an entry with no bins', [entry('a', [], [])]],
]) {
    const { headers, columns } = buildFftExportColumns(entries, options());
    assert.equal(headers.length, 0, `${label}: no headers`);
    assert.equal(columns.length, 0, `${label}: no columns`);
}

// A refused trace beside a good one must not cost the good one its column.
{
    const { headers } = buildFftExportColumns([
        entry('refused', [], []),
        entry('theta', [0, 1], [1, 2]),
    ], options());
    assert.deepEqual(headers, ['frequency [Hz]', 'theta amplitude [rad]']);
}

// ─── Wired into the panel ──────────────────────────────────────────
const fft = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const exportMethods = readFileSync(new URL('../src/plots/methods/export-methods.js', import.meta.url), 'utf8');

assert.doesNotMatch(manager, /plot\.mode === 'timeseries' \|\| plot\.mode === 'fft'\) \{\s*\n\s*this\._appendTimeseriesExportColumns/,
    'the FFT panel no longer exports the time series');
assert.match(manager, /plot\.mode === 'fft'\) \{[\s\S]{0,160}?this\._appendFftExportColumns\(plot, headers, columns\)/,
    'it exports the spectrum');
assert.match(fft, /proto\._appendFftExportColumns = function\(plot, headers, columns\) \{[\s\S]*?buildFftExportColumns\(plot\?\._fftSpectraFull \|\| \[\]/,
    'from the full spectra it keeps for the zoom, not from the drawn downsample');
// The name and the unit have to come from the variable, so the header reads
// like the legend does.
assert.match(fft, /nameFor: \(entry\) => \(entry\.varName[\s\S]{0,120}?_traceName\(entry\.varName, entry\.fileId, \{ units: false \}\)/,
    'headed by the trace name');
assert.match(fft, /fileId: trace\.fileId,\n\s*varName: trace\.varName,/,
    'which means each spectrum remembers which signal it is');

// An empty spectrum used to be impossible (the time series was always there).
assert.match(exportMethods, /plot\.mode === 'fft' && !plot\._fftSpectraFull\?\.length\) return i18n\.t\('exportCsvUnavailableSpectrum'\)/,
    'and with no spectrum yet the dialog says so instead of writing an empty file');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
assert.equal([...translations.matchAll(/exportCsvUnavailableSpectrum:/g)].length, 4,
    'that message exists in all four languages');

console.log('FFT CSV export checks passed.');
