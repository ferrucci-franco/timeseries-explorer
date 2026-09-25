// When a time-series trace may draw its samples as dots (the "Samples" toggle).
//
// A dot claims "there is a sample here". Two things must hold for that to be
// true and useful (docs/sample-markers-design.md):
//
//  1. Exact data. What reaches Plotly is the visible window copied verbatim,
//     not the min/max envelope of it. This is the same branch that makes a
//     stepped trace exact, and the caller reports it from that branch rather
//     than re-deriving it here, so dots and stairs cannot disagree.
//  2. Legibility. Samples sit far enough apart on screen to be told apart —
//     judged by distinct x positions, since rows at one instant share a column.
//     Stairs can do without this — a squeezed staircase just reads as the
//     line — but dots do not degrade: they pile up into a smear over the curve.
//
// Condition 2 has hysteresis, so a zoom that hovers around the threshold does
// not make the dots blink on and off.

/**
 * Dots appear at this many pixels per position, or more. Measured centre to
 * centre, so it has to clear the dot itself (SAMPLE_MARKER_SIZE, 5 px) with a
 * visible gap: at 4 px, the first value tried, 5 px dots touched and a trace
 * read as a thick bead necklace rather than as samples.
 */
export const SAMPLE_MARKERS_MIN_PX_ON = 8;
/** Once shown, dots stay until the spacing drops below this. */
export const SAMPLE_MARKERS_MIN_PX_OFF = 6;

/**
 * Past this many samples in the window, positions are not counted and the
 * sample count stands in for them. Only reached with downsampling turned off;
 * no display is wide enough to give that many positions room for a dot.
 */
export const SAMPLE_POSITION_SCAN_LIMIT = 20000;

/**
 * Distinct x positions in sorted `xs[start..end)`.
 *
 * Space on screen is taken by positions, not rows: rows that share one instant
 * sit in one column. A logger stamping to the second under a 10 Hz loop puts
 * ten rows at every position, and judging legibility by rows kept its dots off
 * until the view was zoomed ten times further than any other file needed.
 * Non-finite x takes no position.
 */
export function countDistinctPositions(xs, start, end) {
    let count = 0;
    let previous = NaN;
    for (let i = start; i < end; i++) {
        const x = Number(xs[i]);
        if (!Number.isFinite(x)) continue;
        if (x !== previous) count++;
        previous = x;
    }
    return count;
}

/**
 * @param {object} args
 * @param {boolean} args.exact         the drawn data is the raw visible window
 * @param {number}  args.visiblePositions  distinct x positions inside the visible
 *   range (rows at one instant share one column, so they count once)
 * @param {number}  args.plotWidthPx   width of the plot area, in pixels
 * @param {boolean} [args.wasShown]    whether this trace had dots last time
 * @param {number}  [args.minPxOn]
 * @param {number}  [args.minPxOff]
 * @returns {boolean}
 */
export function sampleMarkersVisible({
    exact,
    visiblePositions,
    plotWidthPx,
    wasShown = false,
    minPxOn = SAMPLE_MARKERS_MIN_PX_ON,
    minPxOff = SAMPLE_MARKERS_MIN_PX_OFF,
}) {
    if (!exact) return false;
    const count = Number(visiblePositions);
    const width = Number(plotWidthPx);
    // Width unknown means the axis has not laid out yet: no claim to make.
    if (!(width > 0) || !Number.isFinite(count)) return false;
    // A window with nothing in it has nothing to mark, and one lone sample has
    // all the room there is.
    if (count <= 0) return false;
    const pxPerPosition = width / count;
    return pxPerPosition >= (wasShown ? minPxOff : minPxOn);
}
