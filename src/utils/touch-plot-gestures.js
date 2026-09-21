// What a finger means on a plot.
//
// Plotly answers that for a whole plot at once, with one layout attribute. In
// `zoom`, its default, every drag draws a rectangle and the plot zooms into it;
// in `pan`, every drag moves the view. With a mouse the box is the better
// default, because panning is one modebar click away. With a finger there is no
// second button and no modebar worth hitting, so a plot left in `zoom` cannot be
// panned at all — every drag is a zoom, and the only way back is a double tap.
//
// The first attempt at this (#110) asked the DEVICE, and wrote `pan` into the
// layout of a device whose primary pointer was coarse. That was wrong twice:
//
//   * a laptop or a Surface with a touch screen has a FINE primary pointer, so
//     it was never given the mode, and a finger on it went on drawing boxes;
//   * a layout attribute lasts until the next Plotly.react, which is how every
//     analysis pane in this app redraws — the mode went quietly back to `zoom`.
//
// So the question is asked of the GESTURE instead. A touch landing on a plot
// borrows `pan` for as long as that touch lasts, and a mouse on the same screen
// keeps the box it always had. Measured on this Plotly build: the drag mode is
// read from `_fullLayout` when a drag begins, so a switch made as the finger
// lands governs the very gesture that finger is starting.

export const TOUCH_DRAG_MODE = 'pan';

/**
 * The drag mode a finger needs, or null to leave the plot as it is.
 *
 * Only the box zoom is overruled. `select`, `lasso`, a drawing mode and a `pan`
 * already in place are deliberate answers to this same question, and a gesture
 * is not the place to overrule them.
 *
 * @param {string|undefined} dragmode what the plot is in now
 * @returns {string|null}
 */
export function touchDragModeFor(dragmode) {
    if (dragmode && dragmode !== 'zoom') return null;
    return TOUCH_DRAG_MODE;
}
