// Touch gesture arithmetic for the 2D panes: one finger pans, two fingers
// pinch to zoom and drag to pan at the same time.
//
// The coordinates handed in are LAYOUT pixels — the caller has already undone
// the phone stage's scale and rotation (see ../ui/viewport-transform.js), so
// this file can pretend the plot is on a plain desktop screen.

// Below this the two fingers are too close together along an axis for their
// separation to mean anything, and the ratio would be pure jitter.
export const MIN_PINCH_SPAN = 40;

// One gesture never zooms by more than this in a single frame; a finger
// leaving and re-entering the digitiser can otherwise produce a wild ratio.
const MAX_STEP_SCALE = 20;

const clampScale = (value) => {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(MAX_STEP_SCALE, Math.max(1 / MAX_STEP_SCALE, value));
};

// Whether the pinch is horizontal, vertical or both is decided from the
// STARTING finger separation and then held for the whole gesture. Deciding it
// per frame would let an axis flicker in and out as the fingers move, and the
// range would jitter with it.
export function pinchAxes(start, { minSpan = MIN_PINCH_SPAN } = {}) {
    if (!start || start.length < 2) return { x: false, y: false };
    return {
        x: Math.abs(start[1].x - start[0].x) >= minSpan,
        y: Math.abs(start[1].y - start[0].y) >= minSpan,
    };
}

// `start` and `current` are arrays of {x, y} in layout pixels. Returns the pan
// in pixels, a per-axis zoom factor, and the anchor the zoom happens about —
// the point that stays under the fingers.
export function computeTouchGesture(start, current, options = {}) {
    if (!start?.length || !current?.length) return null;

    if (start.length < 2 || current.length < 2) {
        return {
            kind: 'pan',
            dx: current[0].x - start[0].x,
            dy: current[0].y - start[0].y,
            scaleX: 1,
            scaleY: 1,
            anchorX: start[0].x,
            anchorY: start[0].y,
        };
    }

    const axes = options.axes || pinchAxes(start, options);
    const startSpanX = Math.abs(start[1].x - start[0].x);
    const startSpanY = Math.abs(start[1].y - start[0].y);
    const curSpanX = Math.abs(current[1].x - current[0].x);
    const curSpanY = Math.abs(current[1].y - current[0].y);

    let scaleX = 1;
    let scaleY = 1;
    if (axes.x || axes.y) {
        if (axes.x) scaleX = clampScale(curSpanX / startSpanX);
        if (axes.y) scaleY = clampScale(curSpanY / startSpanY);
    } else {
        // Fingers placed almost on top of each other: neither axis separation
        // is meaningful on its own, so fall back to a uniform pinch.
        const startDist = Math.hypot(startSpanX, startSpanY);
        const curDist = Math.hypot(curSpanX, curSpanY);
        const uniform = startDist > 0 ? clampScale(curDist / startDist) : 1;
        scaleX = uniform;
        scaleY = uniform;
    }

    const startMidX = (start[0].x + start[1].x) / 2;
    const startMidY = (start[0].y + start[1].y) / 2;
    const curMidX = (current[0].x + current[1].x) / 2;
    const curMidY = (current[0].y + current[1].y) / 2;

    return {
        kind: 'pinch',
        dx: curMidX - startMidX,
        dy: curMidY - startMidY,
        scaleX,
        scaleY,
        anchorX: startMidX,
        anchorY: startMidY,
    };
}

// Zoom an axis range about `anchorPx` and then slide it by `panPx`, all in the
// pane's own pixel coordinates. `invert` is true for a Y axis, whose pixels
// grow downwards while its values grow upwards.
export function transformRange({ range, offset, length, anchorPx, scale, panPx = 0, invert = false }) {
    const r0 = Number(range?.[0]);
    const r1 = Number(range?.[1]);
    if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null;
    if (!Number.isFinite(length) || length <= 0) return null;

    const span = r1 - r0;
    const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const newSpan = span / factor;
    const frac = (anchorPx - (offset || 0)) / length;

    let n0;
    let n1;
    if (invert) {
        const anchorValue = r1 - frac * span;
        n1 = anchorValue + frac * newSpan;
        n0 = n1 - newSpan;
    } else {
        const anchorValue = r0 + frac * span;
        n0 = anchorValue - frac * newSpan;
        n1 = n0 + newSpan;
    }

    // The view follows the fingers: dragging right reveals earlier data,
    // dragging down reveals higher values.
    const shift = (invert ? 1 : -1) * (panPx / length) * newSpan;
    return [n0 + shift, n1 + shift];
}
