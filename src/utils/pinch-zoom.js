// The arithmetic of a two-finger zoom.
//
// Plotly gives a touch screen one gesture or the other, never both: in `zoom`
// mode a pinch zooms but no drag can pan, and in `pan` mode a drag pans but a
// pinch does nothing at all (measured: 39.9 s of x stayed 39.9 s however far
// the fingers spread). The app asks for `pan`, because panning is the gesture
// with no alternative, and brings its own pinch — which is this.
//
// Per axis, independently, because these are not a map: a plot's x and y mean
// different things, and a reader pinching horizontally is asking about time,
// not about amplitude. An axis whose fingers barely separate is left alone
// rather than scaled by a ratio of two small numbers.

export const PINCH_MIN_SEPARATION_PX = 24;
// Every frame of a pinch is measured against where the fingers STARTED, not
// against the frame before it, so the zoom cannot drift and this bound is only
// a guard against nonsense input: two fingers cannot honestly separate by more
// than the width of a screen, which from the minimum above is about fortyfold.
export const PINCH_MAX_GESTURE_SCALE = 50;

const clampScale = (scale) => Math.min(Math.max(scale, 1 / PINCH_MAX_GESTURE_SCALE), PINCH_MAX_GESTURE_SCALE);

/**
 * How much each axis grew or shrank between two finger positions.
 *
 * A scale above 1 means the fingers spread — the reader is asking for a closer
 * look, so the axis range shrinks by that factor.
 *
 * @param {[{x: number, y: number}, {x: number, y: number}]} start
 * @param {[{x: number, y: number}, {x: number, y: number}]} end
 * @returns {{x: number|null, y: number|null}} null where the pinch says nothing
 */
export function pinchScales(start, end, { minSeparationPx = PINCH_MIN_SEPARATION_PX } = {}) {
    const axis = (key) => {
        const from = Math.abs(Number(start?.[0]?.[key]) - Number(start?.[1]?.[key]));
        const to = Math.abs(Number(end?.[0]?.[key]) - Number(end?.[1]?.[key]));
        if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
        // Two fingers side by side say nothing about the other axis.
        if (from < minSeparationPx || to < minSeparationPx) return null;
        return clampScale(to / from);
    };
    return { x: axis('x'), y: axis('y') };
}

/**
 * The range that keeps one value under the fingers while they move and spread.
 *
 * This is the whole feel of a touch gesture: whatever the two fingers came
 * down on stays under them, so the plot follows the hand rather than sliding
 * about beneath it. Zoom and pan are the same formula — the span divides by
 * the scale, and the anchor lands wherever the fingers are now.
 *
 * @param {[number, number]} range   where the gesture started, in data units
 *   (log10 for a log axis, as Plotly keeps them: the arithmetic is the same)
 * @param {number} anchorValue       the value the fingers came down on
 * @param {number} anchorFraction    where they are now, 0 (left/bottom) to 1
 * @param {number} scale             >1 zooms in
 * @returns {[number, number]|null}
 */
export function panZoomRange(range, anchorValue, anchorFraction, scale) {
    const lo = Number(range?.[0]);
    const hi = Number(range?.[1]);
    const anchor = Number(anchorValue);
    const fraction = Number(anchorFraction);
    const s = Number(scale);
    if (![lo, hi, anchor, fraction, s].every(Number.isFinite) || s <= 0 || lo === hi) return null;
    const span = (hi - lo) / s;
    const start = anchor - fraction * span;
    return [start, start + span];
}

/**
 * A range zoomed about a centre that does not move: the pure-pinch case, and
 * the one worth reading as its own sentence.
 */
export function zoomRangeAbout(range, centre, scale) {
    const lo = Number(range?.[0]);
    const hi = Number(range?.[1]);
    const c = Number(centre);
    if (![lo, hi, c].every(Number.isFinite) || lo === hi) return null;
    return panZoomRange(range, c, (c - lo) / (hi - lo), scale);
}
