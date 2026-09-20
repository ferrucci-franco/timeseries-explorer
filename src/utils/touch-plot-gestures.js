// What one finger means on a plot.
//
// Plotly's default drag mode is `zoom`: a drag draws a rectangle and the plot
// zooms into it. With a mouse that is right — panning is there too, on the
// modebar, a click away. With a finger it leaves the reader with no way to pan
// at all: every drag zooms, and the only way out is a double tap back to
// everything. Measured on a touch screen before this: a horizontal drag zoomed
// X, a vertical drag zoomed Y, and moving two fingers together — the gesture
// every map and photo on the device pans with — zoomed as well, because Plotly
// read the pair as a pinch.
//
// So on a coarse-pointer device the app asks for `pan` instead, which is the
// mapping a finger already knows:
//
//     one finger   pan            two fingers   pinch to zoom
//     double tap   back to all    modebar       zoom box, if you want it
//
// Nothing changes for a mouse, and nothing changes for a laptop whose screen
// happens to be touch-capable: those have a pointer that can hover, and the
// zoom box is worth more to them than a pan they already have.

export const TOUCH_DRAG_MODE = 'pan';

/**
 * Is the primary pointer a finger?
 *
 * `(pointer: coarse)` is the primary input, so a tablet says yes and a laptop
 * with a touch screen says no — which is the distinction that matters here.
 */
export function prefersTouchGestures(win = (typeof window !== 'undefined' ? window : null)) {
    if (!win) return false;
    const touchPoints = Number(win.navigator?.maxTouchPoints) || 0;
    if (touchPoints <= 0 && !('ontouchstart' in win)) return false;
    return win.matchMedia?.('(pointer: coarse)')?.matches === true;
}

/**
 * The layout a plot should be created with.
 *
 * A layout that already names a drag mode has been asked for deliberately and
 * is left alone; so is every layout on a device with a pointer.
 */
export function withTouchDragMode(layout, touch = prefersTouchGestures()) {
    if (!touch || !layout || typeof layout !== 'object') return layout;
    if (layout.dragmode) return layout;
    return { ...layout, dragmode: TOUCH_DRAG_MODE };
}
