// What a finger means on a plot, and when the plot stops asking Plotly.
//
// Plotly answers "what does a drag do" for a whole plot at once, with one
// layout attribute: `zoom` draws a rectangle, `pan` moves the view. With a
// mouse the box is the better default, because panning is a modebar click
// away. With a finger there is no second button, and a plot left in `zoom`
// cannot be panned at all.
//
// Two attempts at borrowing Plotly's `pan` for the length of a touch got this
// far and no further:
//
//   * #110 asked the DEVICE — `(pointer: coarse)` — which left out every touch
//     screen with a mouse beside it, and was undone by the next Plotly.react.
//   * #160 asked the GESTURE and borrowed the mode as the finger landed. One
//     finger panned, and two fingers pinched — but only when they landed
//     together. A second finger arriving even slightly late found Plotly
//     already panning from the first one, and the two handlers fought: the
//     pinch was not recognised and the pan glitched.
//
// So the plot no longer hands the gesture to Plotly at all. A touch that lands
// on the plot surface is the app's, start to finish: one finger pans, two
// pinch, and the arithmetic is the same either way (utils/pinch-zoom.js). The
// hand can change mid-gesture — a second finger arriving a second later, one
// of them lifting — and the gesture simply starts again from where the plot is
// now, so there is no moment at which the fingers have to agree.
//
// What is still Plotly's: a tap, which becomes a click, and two taps, which
// become its own reset. Those are not drags and nothing here touches them.

/** How far a finger may wander before the touch is a drag and not a tap. */
export const TOUCH_GESTURE_SLOP_PX = 6;

/**
 * Is this plot's drag mode ours to take over?
 *
 * `zoom` is the default nobody chose, and `pan` is what a finger wants anyway.
 * `select`, `lasso` and the drawing modes are deliberate answers to the same
 * question, and a gesture is not the place to overrule them.
 *
 * @param {string|undefined} dragmode
 * @returns {boolean}
 */
export function touchGestureOwnsDrag(dragmode) {
    if (!dragmode) return true;
    return dragmode === 'zoom' || dragmode === 'pan';
}

/**
 * The point a gesture is about: one finger, or the midpoint of two.
 *
 * @param {Array<{x: number, y: number}>} points
 * @returns {{x: number, y: number}|null}
 */
export function gestureCentre(points) {
    if (!Array.isArray(points) || points.length === 0) return null;
    let sumX = 0;
    let sumY = 0;
    for (const point of points) {
        sumX += Number(point?.x);
        sumY += Number(point?.y);
    }
    const centre = { x: sumX / points.length, y: sumY / points.length };
    return Number.isFinite(centre.x) && Number.isFinite(centre.y) ? centre : null;
}

/**
 * Has the hand moved far enough to mean it?
 *
 * A tap is never perfectly still, and a touch that has not travelled this far
 * is left alone so it can still become a click — which is how a cursor is
 * placed and how Plotly's own double-tap reset is recognised.
 *
 * @param {Array<{x: number, y: number}>} from where the fingers landed
 * @param {Array<{x: number, y: number}>} to where they are now
 * @param {number} [slop]
 * @returns {boolean}
 */
export function movedBeyondSlop(from, to, slop = TOUCH_GESTURE_SLOP_PX) {
    if (!Array.isArray(from) || !Array.isArray(to)) return false;
    const count = Math.min(from.length, to.length);
    for (let i = 0; i < count; i += 1) {
        const dx = Number(to[i]?.x) - Number(from[i]?.x);
        const dy = Number(to[i]?.y) - Number(from[i]?.y);
        if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) > slop) return true;
    }
    return false;
}
