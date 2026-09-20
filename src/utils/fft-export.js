// The spectrum as a table: pure, no DOM, no Plotly.
//
// It lives here rather than in fft-methods.js for the same reason
// buildIntegralExportTable does: the analysis modules import Plotly, and a
// table of numbers should be checkable without a browser.

import { csvTextCell } from './csv-cell.js';

/**
 * Do these spectra share one frequency grid?
 *
 * Same length and same ends is enough: a bin is (k/N)·fs, so two grids that
 * agree at both ends agree at every bin between them.
 */
function sharesGrid(entries) {
    const first = entries[0]?.frequencies;
    const length = first?.length || 0;
    if (!length) return false;
    return entries.every(entry => entry.frequencies?.length === length
        && entry.frequencies[0] === first[0]
        && entry.frequencies[length - 1] === first[length - 1]);
}

/**
 * Columns for the FFT panel's CSV: frequency, then one amplitude per trace.
 *
 * One frequency column when every trace shares a grid, one per trace when they
 * do not — the rule the time-series export already follows for time, and for
 * the same reason: rows that line up with the wrong values are worse than an
 * extra column.
 *
 * @param {Array<{frequencies: ArrayLike<number>, amplitudes: ArrayLike<number>}>} entries
 * @param {object} options
 * @param {string} [options.frequencyUnit] ' [Hz]' — already bracketed, or ''
 * @param {string} [options.periodUnit] ' [s]' when the panel is reading the
 *   spectrum by period (#108): a period column is written beside the frequency
 *   one, so the CSV says what the screen says. '' leaves it out.
 * @param {string} [options.amplitudeScaleUnit] ' [dB]' on a dB scale, '' on a linear one
 * @param {(entry: object) => string} [options.nameFor]
 * @param {(entry: object) => string} [options.unitFor] the signal's own unit, unbracketed
 * @returns {{headers: string[], columns: Array<Array<number>>}}
 */
export function buildFftExportColumns(entries, options = {}) {
    const headers = [];
    const columns = [];
    const list = (entries || []).filter(entry => entry?.frequencies?.length && entry?.amplitudes?.length);
    if (!list.length) return { headers, columns };

    const frequencyUnit = options.frequencyUnit || '';
    const periodUnit = options.periodUnit || '';
    const scaleUnit = options.amplitudeScaleUnit || '';
    // T = 1/f. DC has no period, and an empty cell is how a table says so.
    const periodsOf = (frequencies) => Array.from(frequencies, (f) => {
        const value = Number(f);
        return Number.isFinite(value) && value !== 0 ? 1 / Math.abs(value) : '';
    });
    const nameFor = options.nameFor || (entry => entry.name || 'signal');
    const unitFor = options.unitFor || (() => '');
    const shared = sharesGrid(list);

    if (shared) {
        headers.push(csvTextCell(`frequency${frequencyUnit}`));
        columns.push(Array.from(list[0].frequencies));
        if (periodUnit) {
            headers.push(csvTextCell(`period${periodUnit}`));
            columns.push(periodsOf(list[0].frequencies));
        }
    }
    for (const entry of list) {
        const name = nameFor(entry);
        if (!shared) {
            headers.push(csvTextCell(`${name} frequency${frequencyUnit}`));
            columns.push(Array.from(entry.frequencies));
            if (periodUnit) {
                headers.push(csvTextCell(`${name} period${periodUnit}`));
                columns.push(periodsOf(entry.frequencies));
            }
        }
        // On a dB scale the amplitude's unit is the scale's. On a linear one it
        // is the signal's own, which is the only place it can come from.
        const signalUnit = unitFor(entry);
        const amplitudeUnit = scaleUnit || (signalUnit ? ` [${signalUnit}]` : '');
        headers.push(csvTextCell(`${name} amplitude${amplitudeUnit}`));
        columns.push(Array.from(entry.amplitudes));
    }
    return { headers, columns };
}
