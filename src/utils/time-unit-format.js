// Writing a duration in seconds the way a person would say it.
//
// A sampling step reads as "20.8333 µs", never as "2.08333e-5 s". The ladder
// below is the whole of it, and it lives here rather than inside the time-axis
// inspector because two places now print the same number: the inspector's
// "Sampling of …" panel, and the Recording details an audio file carries in its
// variable tree. Those two must agree to the digit — a reader who sees
// "20.8333 µs" in one and "2.0833e-5 s" in the other has no way to know they
// are the same measurement.
//
// Free of DOM, i18n and app state on purpose: a parser has to be able to call
// it, and parsers run in Workers and in Node.

// Seconds ladder, largest first — `pickTimeUnit` walks it in order.
export const TIME_UNITS = Object.freeze([
    { factor: 86400, suffix: 'd' },
    { factor: 3600, suffix: 'h' },
    { factor: 60, suffix: 'min' },
    { factor: 1, suffix: 's' },
    { factor: 1e-3, suffix: 'ms' },
    { factor: 1e-6, suffix: 'µs' },
    { factor: 1e-9, suffix: 'ns' },
]);

/**
 * One unit for a whole group of values, picked from the largest of them.
 *
 * Choosing per value is what used to print "0 s / 1.000e-3 s / 0.001 s" — three
 * notations in one row for numbers that straddle a threshold.
 *
 * @param {number[]} values
 * @param {boolean} unitless a row-index axis counts rows; seconds are a lie there.
 */
export function pickTimeUnit(values, unitless = false) {
    if (unitless) return { factor: 1, suffix: '' };
    const magnitudes = values.filter(Number.isFinite).map(Math.abs).filter(value => value > 0);
    if (!magnitudes.length) return { factor: 1, suffix: 's' };
    const largest = Math.max(...magnitudes);
    return TIME_UNITS.find(unit => largest >= unit.factor) || TIME_UNITS[TIME_UNITS.length - 1];
}

/**
 * Six significant digits, trailing zeros trimmed: enough to tell 1 ms from
 * 0.99995 ms without rounding the difference away.
 */
export function formatTimeValue(value, unit) {
    if (!Number.isFinite(value)) return '—';
    const scaled = value / unit.factor;
    const text = scaled === 0 ? '0' : String(Number(scaled.toPrecision(6)));
    return unit.suffix ? `${text} ${unit.suffix}` : text;
}

/** One value, in whichever unit suits it. */
export function formatTimeMagnitude(value, unitless = false) {
    return formatTimeValue(value, pickTimeUnit([value], unitless));
}
