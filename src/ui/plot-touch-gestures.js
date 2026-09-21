// A finger on a plot: pan with one, zoom with two, at any moment either.
//
// Installed on every chart the app creates (see vendor/plotly.js), on any
// device that has a touch screen — including one that also has a mouse, which
// keeps every gesture it had, because nothing here listens to a mouse.
//
// A touch that lands on the plot surface is this handler's from that moment:
// Plotly is not told about it, so it never starts a drag of its own and there
// is never a second handler moving the same axes. See
// utils/touch-plot-gestures.js for why it ended up this way.
//
// The shape of it:
//
//   one finger    pan          the value under the finger stays under it
//   two fingers   pinch        each axis scales by how far those fingers spread
//   a change      re-baseline  a finger arriving or leaving starts the gesture
//                              again from where the plot is now, so there is no
//                              moment at which the hand has to be exact
//   a tap         Plotly's     nothing is prevented, so it still becomes a
//                              click, and two of them its own reset
//
// The arithmetic is in utils/pinch-zoom.js; what is here is the plumbing: who
// the touches belong to, which axes they are over, and how often the plot is
// asked to redraw.

import { panZoomRange, pinchScales } from '../utils/pinch-zoom.js';
import { gestureCentre, movedBeyondSlop, touchGestureOwnsDrag } from '../utils/touch-plot-gestures.js';
import { isTouchCapable } from './touch-drag.js';

// Plotly's drag layer is the set of invisible rectangles it lays over the plot
// area and its axes to catch drags, and it sits above everything a reader might
// touch for another reason. So a touch inside it is a touch on the plot itself;
// a touch on the legend, on the modebar or on one of the app's own cursor
// handles belongs to what it landed on, and none of this applies to it.
const onPlotSurface = (target) => typeof target?.closest === 'function' && !!target.closest('.draglayer');

// While this class is on a plot, its hover label is hidden (see content.css).
// The label belongs to the last tap, and a redraw brings it back mid-gesture,
// at a point nobody is touching.
const GESTURE_CLASS = 'touch-gesture';

/**
 * Speak for a touch on this plot, before its own gestures act on it.
 *
 * A measurement cursor being grabbed, an analysis band being dragged: each is
 * a drag of its own on the same pixels, and each says so here. The gesture
 * handler asks every claim before it pans, and a claim that says yes keeps the
 * whole touch — Plotly included, since it would read a second finger arriving
 * mid-drag as a pinch.
 *
 * @param {HTMLElement} div a Plotly graph div
 * @param {(event: TouchEvent) => boolean} claim
 * @returns {() => void} withdraws it again
 */
export function claimTouchGestures(div, claim) {
    if (!div || typeof claim !== 'function') return () => {};
    const claims = div._touchGestureClaims || (div._touchGestureClaims = new Set());
    claims.add(claim);
    return () => claims.delete(claim);
}

const spokenFor = (div, event) => {
    for (const claim of div._touchGestureClaims || []) {
        if (claim(event)) return true;
    }
    return false;
};

/**
 * The data value under a pixel, in the units Plotly keeps the range in.
 *
 * `vertical` picks which edge of the plot the pixel is measured from — a y
 * pixel read against the left edge is how a purely horizontal gesture ends up
 * moving the amplitude axis as well.
 */
function axisValueAt(axis, clientPixel, rect, vertical = false) {
    if (!axis || !rect) return NaN;
    const offset = axis._offset || 0;
    const local = clientPixel - (vertical ? rect.top : rect.left) - offset;
    // p2c, deliberately: a log axis keeps its RANGE in log10, so the anchor has
    // to be in the same units as the range it anchors. It also knows that a y
    // axis runs the other way.
    if (typeof axis.p2c === 'function') return Number(axis.p2c(local));
    const lo = Number(axis.range?.[0]);
    const hi = Number(axis.range?.[1]);
    const length = axis._length || (vertical ? rect.height : rect.width) || 1;
    const fraction = vertical ? 1 - (local / length) : local / length;
    return lo + fraction * (hi - lo);
}

/**
 * @param {HTMLElement} div a Plotly graph div
 * @param {{relayout: Function}} plotly
 * @returns {boolean} whether it was installed
 */
export function installTouchPlotGestures(div, plotly) {
    if (!div || div._touchGesturesInstalled || !isTouchCapable()) return false;
    if (typeof div.addEventListener !== 'function' || !plotly?.relayout) return false;
    div._touchGesturesInstalled = true;

    let gesture = null;
    // Something else on this plot has the touch in hand — a measurement cursor
    // being dragged — and for as long as it does, nothing else may act on it.
    let claimed = false;
    let frame = 0;
    let frameIsAnimation = false;
    let pending = null;

    const axes = () => {
        const layout = div._fullLayout;
        return { x: layout?.xaxis, y: layout?.yaxis, y2: layout?.yaxis2 };
    };

    const apply = () => {
        frame = 0;
        const update = pending;
        pending = null;
        if (update) plotly.relayout(div, update).catch(() => {});
    };

    const schedule = (update) => {
        pending = { ...(pending || {}), ...update };
        if (frame) return;
        frameIsAnimation = typeof requestAnimationFrame === 'function';
        frame = frameIsAnimation ? requestAnimationFrame(apply) : setTimeout(apply, 16);
    };

    // A baseline is read from the plot's current ranges, so anything still
    // waiting for the next frame has to land first.
    const flush = () => {
        if (!frame) return;
        if (frameIsAnimation) cancelAnimationFrame(frame);
        else clearTimeout(frame);
        apply();
    };

    // The touches this plot's gesture is made of: a finger resting somewhere
    // else on the page is not part of it, and a third one — a palm on the
    // bezel, a hand steadying the tablet — is not either.
    const gestureTouches = (event) => Array.from(event.touches || [])
        .filter(touch => onPlotSurface(touch.target))
        .slice(0, 2)
        .map(touch => ({ x: touch.clientX, y: touch.clientY }));

    /** Start the gesture again from where the plot is now. */
    const baseline = (points, moved = false) => {
        flush();
        const rect = div.getBoundingClientRect();
        const { x, y, y2 } = axes();
        const centre = gestureCentre(points);
        if (!centre) return null;
        return {
            points,
            rect,
            moved,
            ranges: { x: x?.range?.slice?.(), y: y?.range?.slice?.(), y2: y2?.range?.slice?.() },
            // What the hand came down on. Everything after this is about
            // keeping these values under it.
            anchors: {
                x: axisValueAt(x, centre.x, rect),
                y: axisValueAt(y, centre.y, rect, true),
                y2: axisValueAt(y2, centre.y, rect, true),
            },
        };
    };

    const settle = (moved) => {
        div.classList.remove(GESTURE_CLASS);
        // A finger never leaves the plot, so nothing ever takes the hover
        // label away by itself. After a gesture it is about somewhere the
        // reader has not been for a while.
        if (moved) plotly.Fx?.unhover?.(div);
    };

    const onTouchStart = (event) => {
        if (!onPlotSurface(event.target)) return;
        if (!touchGestureOwnsDrag(div._fullLayout?.dragmode)) { gesture = null; return; }
        // Something on this plot may want this touch for itself: a finger that
        // landed on a measurement cursor is grabbing it, not panning the plot.
        // It is not Plotly's either — a second finger arriving mid-drag would
        // be read as a pinch and zoom the plot out from under the cursor.
        if (spokenFor(div, event)) {
            claimed = true;
            gesture = null;
            event.stopPropagation();
            return;
        }
        const points = gestureTouches(event);
        if (!points.length) return;
        // Plotly is not told: one gesture, one handler, whatever the hand does
        // from here.
        event.stopPropagation();
        gesture = baseline(points, gesture?.moved ?? false);
    };

    const onTouchMove = (event) => {
        // Only stepping aside: the drag that claimed this touch follows it on
        // document listeners, and stopping the event here would starve them.
        if (claimed) return;
        if (!gesture) return;
        const points = gestureTouches(event);
        if (!points.length) { gesture = null; return; }
        event.stopPropagation();
        if (points.length !== gesture.points.length) { gesture = baseline(points, gesture.moved); return; }
        // Still within a tap's wobble: leave it alone, so it can still become a
        // click. Nothing scrolls in the meantime — the plot's touch-action says
        // the browser has no gesture of its own here.
        if (!gesture.moved && !movedBeyondSlop(gesture.points, points)) return;
        if (!gesture.moved) {
            gesture.moved = true;
            div.classList.add(GESTURE_CLASS);
        }
        event.preventDefault();
        const centre = gestureCentre(points);
        if (!centre) return;
        // One finger is a pinch that does not spread: same arithmetic, scale 1.
        const scales = points.length === 2 ? pinchScales(gesture.points, points) : { x: 1, y: 1 };
        const { x, y, y2 } = axes();
        const update = {};
        const fractionOf = (axis, pixel, vertical) => {
            const length = axis?._length || (vertical ? gesture.rect.height : gesture.rect.width) || 1;
            const offset = axis?._offset || 0;
            const local = pixel - (vertical ? gesture.rect.top : gesture.rect.left) - offset;
            const fraction = local / length;
            // Plotly's y pixels grow downward and its ranges grow upward.
            return vertical ? 1 - fraction : fraction;
        };
        const put = (key, axis, range, anchor, scale, vertical) => {
            if (!range || !Number.isFinite(anchor)) return;
            const next = panZoomRange(range, anchor, fractionOf(axis, vertical ? centre.y : centre.x, vertical), scale || 1);
            if (!next) return;
            update[`${key}.range`] = next;
            update[`${key}.autorange`] = false;
        };
        put('xaxis', x, gesture.ranges.x, gesture.anchors.x, scales.x, false);
        put('yaxis', y, gesture.ranges.y, gesture.anchors.y, scales.y, true);
        // A trace on the right-hand axis is under the same fingers, and an
        // axis left behind would slide out from under its own curve.
        put('yaxis2', y2, gesture.ranges.y2, gesture.anchors.y2, scales.y, true);
        if (Object.keys(update).length) schedule(update);
    };

    const onTouchEnd = (event) => {
        if (claimed) {
            if ((event.touches?.length || 0) === 0) claimed = false;
            return;
        }
        if (!gesture) return;
        const points = gestureTouches(event);
        if (points.length) {
            // One finger left, another is still down: it goes on panning from
            // here rather than leaping back to where the pinch began.
            gesture = baseline(points, gesture.moved);
            return;
        }
        const { moved } = gesture;
        gesture = null;
        flush();
        settle(moved);
    };

    // A cancelled touch is not the end of the gesture — a palm can be rejected,
    // or the browser can take one finger back — so what is left carries on.
    const onTouchCancel = (event) => {
        if ((event.touches?.length || 0) === 0) claimed = false;
        if (!gesture) return;
        const points = gestureTouches(event);
        const { moved } = gesture;
        gesture = points.length ? baseline(points, moved) : null;
        flush();
        if (!gesture) settle(moved);
    };

    // Capture, so this is decided before Plotly's own handlers see anything.
    div.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    div.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    div.addEventListener('touchend', onTouchEnd, { capture: true });
    div.addEventListener('touchcancel', onTouchCancel, { capture: true });
    return true;
}
