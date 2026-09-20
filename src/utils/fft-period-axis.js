// Reading a spectrum by period instead of by frequency (#108).
//
// Same spectrum, same bins, read from the other end: a 0.5 Hz component is a
// two-second one. Which reading is natural depends on the signal — a motor is
// spoken of in hertz, a tide or a duty cycle in seconds — so this is a view of
// the computed spectrum, not a second computation.
//
// Two facts shape everything here:
//
//   · T = 1/f, so the order reverses. The lowest frequency is the longest
//     period: a spectrum ascending in f is descending in T, and the arrays are
//     flipped so the axis still runs left to right.
//   · f = 0 has no period. The DC bin is dropped rather than drawn at
//     infinity — it is the signal's mean, which the panel can remove anyway.
//
// A period axis spans decades where the frequency axis spans a range (the
// bins are evenly spaced in f, so they crowd at the short-period end), which
// is why the panel draws it logarithmically.

export const FFT_X_AXIS_MODES = ['frequency', 'period'];
export const FFT_X_AXIS_DEFAULT = 'frequency';

export function normalizeFftXAxisMode(value) {
    return FFT_X_AXIS_MODES.includes(value) ? value : FFT_X_AXIS_DEFAULT;
}

/** T = 1/f, and f = 1/T: the same map either way, on positive values. */
export function invertAxisValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return null;
    return 1 / Math.abs(n);
}

/**
 * A window on one axis, read on the other. [f₁, f₂] covers exactly the periods
 * [1/f₂, 1/f₁] — the ends swap, and an end that was open stays open.
 *
 * @returns {{lo: number|null, hi: number|null}}
 */
export function invertAxisWindow(lo, hi) {
    const a = invertAxisValue(hi);
    const b = invertAxisValue(lo);
    return { lo: a, hi: b };
}

/**
 * The period reading of a frequency-ordered spectrum slice.
 *
 * The bins are unchanged — only their x values and their order. DC is left
 * out, and so is any bin whose frequency is not finite.
 *
 * @param {ArrayLike<number>} frequencies ascending
 * @param {ArrayLike<number>} amplitudes  same length
 * @returns {{periods: Float64Array, amplitudes: Float64Array, frequencies: Float64Array}}
 *   all three ascending in period, so `frequencies[i]` is still the frequency
 *   of `periods[i]` — the hover reads it, and so does the CSV export.
 */
export function periodSeriesFromSpectrum(frequencies, amplitudes) {
    const n = Math.min(frequencies?.length || 0, amplitudes?.length || 0);
    let kept = 0;
    for (let i = 0; i < n; i++) {
        const f = Number(frequencies[i]);
        if (Number.isFinite(f) && f !== 0) kept++;
    }
    const periods = new Float64Array(kept);
    const amps = new Float64Array(kept);
    const freqs = new Float64Array(kept);
    // Backwards: ascending frequency is descending period.
    let out = 0;
    for (let i = n - 1; i >= 0; i--) {
        const f = Number(frequencies[i]);
        if (!Number.isFinite(f) || f === 0) continue;
        periods[out] = 1 / Math.abs(f);
        amps[out] = Number(amplitudes[i]);
        freqs[out] = f;
        out++;
    }
    return { periods, amplitudes: amps, frequencies: freqs };
}

/**
 * The stored x-axis limits, re-read for the other mode, so a zoom survives the
 * switch instead of snapping back to everything. An unset limit stays unset.
 */
export function convertFftAxisLimits(min, max) {
    const inverted = invertAxisWindow(
        min === null || min === undefined || min === '' ? null : Number(min),
        max === null || max === undefined || max === '' ? null : Number(max),
    );
    return { min: inverted.lo, max: inverted.hi };
}
