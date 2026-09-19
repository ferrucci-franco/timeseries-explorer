// How many significant digits a numeric hover readout needs, taken from the
// series' own resolution instead of a constant.
//
// The time readout was fixed at four significant digits. That is plenty for a
// signal sampled every 10 ms and useless for one sampled every 100 ns: the
// samples at 0.1234567 s and 0.1234568 s both print "0.1235", so the hover
// answers the same thing at every point the reader moves to — exactly where a
// hover is supposed to earn its keep. The sample index had the same problem
// from the other end: sample 12345 printed as "1.234e+4".
//
// The resolution is read as span / (samples - 1), which is the step itself on a
// regular axis and the mean step otherwise — enough to pick a digit count, and
// O(1), which matters because this runs on every trace build. The magnitude
// enters too, so an axis that starts at 1000 s and steps by 100 ns gets the
// eleven digits it needs rather than the four its span alone would suggest.
//
// Free of DOM, Plotly and app state: the format string is the caller's job.

// Four keeps today's reading of an ordinary axis unchanged. Fifteen is where a
// double stops carrying meaning, and asking for more prints the binary noise
// under the decimal rather than the number the file holds.
export const HOVER_MIN_SIGNIFICANT_DIGITS = 4;
export const HOVER_MAX_SIGNIFICANT_DIGITS = 15;

// A NaN or two at either end of the axis is ordinary; a whole leading block of
// them is not, so the search for a real value is bounded and gives up rather
// than walking a million samples on every redraw.
const EDGE_SCAN_LIMIT = 1000;

function firstFiniteFrom(values, start, step, limit) {
    for (let i = 0, index = start; i < limit && index >= 0 && index < values.length; i++, index += step) {
        const value = values[index];
        if (Number.isFinite(value)) return value;
    }
    return null;
}

/**
 * @param {ArrayLike<number>|null|undefined} values ascending axis values
 * @returns {number} significant digits, within [4, 15]
 */
export function hoverSignificantDigits(values) {
    const n = values?.length || 0;
    if (n < 2) return HOVER_MIN_SIGNIFICANT_DIGITS;

    const first = firstFiniteFrom(values, 0, 1, EDGE_SCAN_LIMIT);
    const last = firstFiniteFrom(values, n - 1, -1, EDGE_SCAN_LIMIT);
    if (first === null || last === null) return HOVER_MIN_SIGNIFICANT_DIGITS;

    const span = Math.abs(last - first);
    if (!(span > 0)) return HOVER_MIN_SIGNIFICANT_DIGITS;

    // How far the leftmost digit that matters sits from the rightmost one: the
    // biggest value on the axis over the smallest difference between two of its
    // samples. The +1 is the digit past the step, so two neighbours never print
    // the same string.
    const resolution = span / (n - 1);
    const magnitude = Math.max(Math.abs(first), Math.abs(last), span);
    const digits = Math.ceil(Math.log10(magnitude / resolution)) + 1;
    if (!Number.isFinite(digits)) return HOVER_MIN_SIGNIFICANT_DIGITS;
    return Math.min(HOVER_MAX_SIGNIFICANT_DIGITS, Math.max(HOVER_MIN_SIGNIFICANT_DIGITS, digits));
}

/** The same thing as a d3-format spec, which is what a hovertemplate takes. */
export function hoverNumberFormat(values) {
    return `.${hoverSignificantDigits(values)}g`;
}
