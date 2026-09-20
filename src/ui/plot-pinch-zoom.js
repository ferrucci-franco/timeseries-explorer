// Two fingers on a plot, zooming it.
//
// Installed on every chart the app creates (see vendor/plotly.js), and only on
// a device whose primary pointer is a finger. One finger stays Plotly's — it
// pans, which is the gesture that has no alternative — and the second finger
// is where this takes over: Plotly's pan handler is told nothing more about
// the gesture, and the axes are relaid out from the pinch instead.
//
// The arithmetic is in utils/pinch-zoom.js; what is here is the plumbing: who
// gets the events, which axes the fingers are over, and how often the plot is
// asked to redraw.

import { panZoomRange, pinchScales } from '../utils/pinch-zoom.js';
import { prefersTouchGestures } from '../utils/touch-plot-gestures.js';

const touchPoint = (touch) => ({ x: touch.clientX, y: touch.clientY });
const pairFrom = (touches) => [touchPoint(touches[0]), touchPoint(touches[1])];

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
export function installPinchZoom(div, plotly) {
    if (!div || div._pinchZoomInstalled || !prefersTouchGestures()) return false;
    if (typeof div.addEventListener !== 'function' || !plotly?.relayout) return false;
    div._pinchZoomInstalled = true;

    let start = null;   // the finger pair the gesture began with
    let frame = 0;
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
        frame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(apply)
            : setTimeout(apply, 16);
    };

    const onTouchStart = (event) => {
        if (event.touches.length !== 2) { start = null; return; }
        const pair = pairFrom(event.touches);
        const rect = div.getBoundingClientRect();
        const { x, y, y2 } = axes();
        const centreX = (pair[0].x + pair[1].x) / 2;
        const centreY = (pair[0].y + pair[1].y) / 2;
        start = {
            pair,
            rect,
            ranges: { x: x?.range?.slice?.(), y: y?.range?.slice?.(), y2: y2?.range?.slice?.() },
            // What the fingers came down on. Everything after this is about
            // keeping these values under them.
            anchors: {
                x: axisValueAt(x, centreX, rect),
                y: axisValueAt(y, centreY, rect, true),
                y2: axisValueAt(y2, centreY, rect, true),
            },
        };
        // Plotly began a one-finger pan when the first touch landed; from here
        // the gesture is this one, and it must not also be panned.
        event.stopPropagation();
    };

    const onTouchMove = (event) => {
        if (!start) return;
        if (event.touches.length !== 2) { start = null; return; }
        event.stopPropagation();
        event.preventDefault();
        const pair = pairFrom(event.touches);
        const scales = pinchScales(start.pair, pair);
        const { x, y, y2 } = axes();
        const centreX = (pair[0].x + pair[1].x) / 2;
        const centreY = (pair[0].y + pair[1].y) / 2;
        const update = {};
        // A scale of 1 is not "nothing to do": two fingers moving together,
        // without spreading, is how every map on the device is panned, and the
        // anchor below carries that just as well as it carries a pinch.
        const fractionOf = (axis, pixel, vertical) => {
            const length = axis?._length || (vertical ? start.rect.height : start.rect.width) || 1;
            const offset = axis?._offset || 0;
            const local = pixel - (vertical ? start.rect.top : start.rect.left) - offset;
            const fraction = local / length;
            // Plotly's y pixels grow downward and its ranges grow upward.
            return vertical ? 1 - fraction : fraction;
        };
        const put = (key, axis, range, anchor, scale, vertical) => {
            if (!range || !Number.isFinite(anchor)) return;
            const next = panZoomRange(range, anchor, fractionOf(axis, vertical ? centreY : centreX, vertical), scale || 1);
            if (!next) return;
            update[`${key}.range`] = next;
            update[`${key}.autorange`] = false;
        };
        put('xaxis', x, start.ranges.x, start.anchors.x, scales.x, false);
        put('yaxis', y, start.ranges.y, start.anchors.y, scales.y, true);
        // A trace on the right-hand axis is under the same fingers, and an
        // axis left behind would slide out from under its own curve.
        put('yaxis2', y2, start.ranges.y2, start.anchors.y2, scales.y, true);
        if (Object.keys(update).length) schedule(update);
    };

    const onTouchEnd = (event) => {
        if (!start) return;
        // Still two fingers down means this was a third arriving and leaving.
        if (event.touches.length >= 2) return;
        start = null;
        event.stopPropagation();
    };

    // Capture, so the pinch is recognised before Plotly's own handlers see it.
    div.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    div.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    div.addEventListener('touchend', onTouchEnd, { capture: true });
    div.addEventListener('touchcancel', () => { start = null; }, { capture: true });
    return true;
}
