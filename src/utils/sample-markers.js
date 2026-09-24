// When a time-series trace may draw its samples as dots (the "Samples" toggle).
//
// A dot claims "there is a sample here". Two things must hold for that to be
// true and useful (docs/sample-markers-design.md):
//
//  1. Exact data. What reaches Plotly is the visible window copied verbatim,
//     not the min/max envelope of it. This is the same branch that makes a
//     stepped trace exact, and the caller reports it from that branch rather
//     than re-deriving it here, so dots and stairs cannot disagree.
//  2. Legibility. Samples sit far enough apart on screen to be told apart.
//     Stairs can do without this — a squeezed staircase just reads as the
//     line — but dots do not degrade: they pile up into a smear over the curve.
//
// Condition 2 has hysteresis, so a zoom that hovers around the threshold does
// not make the dots blink on and off.

/** Dots appear at this many pixels per sample, or more. */
export const SAMPLE_MARKERS_MIN_PX_ON = 4;
/** Once shown, dots stay until the spacing drops below this. */
export const SAMPLE_MARKERS_MIN_PX_OFF = 3;

/**
 * @param {object} args
 * @param {boolean} args.exact         the drawn data is the raw visible window
 * @param {number}  args.visibleCount  samples inside the visible x range
 * @param {number}  args.plotWidthPx   width of the plot area, in pixels
 * @param {boolean} [args.wasShown]    whether this trace had dots last time
 * @param {number}  [args.minPxOn]
 * @param {number}  [args.minPxOff]
 * @returns {boolean}
 */
export function sampleMarkersVisible({
    exact,
    visibleCount,
    plotWidthPx,
    wasShown = false,
    minPxOn = SAMPLE_MARKERS_MIN_PX_ON,
    minPxOff = SAMPLE_MARKERS_MIN_PX_OFF,
}) {
    if (!exact) return false;
    const count = Number(visibleCount);
    const width = Number(plotWidthPx);
    // Width unknown means the axis has not laid out yet: no claim to make.
    if (!(width > 0) || !Number.isFinite(count)) return false;
    // A window with nothing in it has nothing to mark, and one lone sample has
    // all the room there is.
    if (count <= 0) return false;
    const pxPerSample = width / count;
    return pxPerSample >= (wasShown ? minPxOff : minPxOn);
}
