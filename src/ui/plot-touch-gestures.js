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
//   tap, then     window       where the plot asks for it: the second touch
//   touch again   zoom         draws a horizontal window and zooms to it (see
//                              utils/touch-plot-gestures.js for its timing)
//
// The arithmetic is in utils/pinch-zoom.js; what is here is the plumbing: who
// the touches belong to, which axes they are over, and how often the plot is
// asked to redraw.

import { panZoomRange, pinchScales } from '../utils/pinch-zoom.js';
import {
    QUICK_DOUBLE_TAP_MS,
    TAP_MAX_DURATION_MS,
    WINDOW_ZOOM_ARMED_MS,
    WINDOW_ZOOM_HOLD_MS,
    gestureCentre,
    isFollowUpTap,
    movedBeyondSlop,
    touchGestureOwnsDrag,
    windowZoomRange,
} from '../utils/touch-plot-gestures.js';
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

// How long after a touch a mouseout from the plot is the touch's own echo.
const TAP_MOUSEOUT_GRACE_MS = 700;

// The window a slow double tap draws, and the line that says it is waiting
// for one. Both are on <body> at fixed positions: nothing the plot redraws can
// take them away mid-gesture.
const WINDOW_BAND_CLASS = 'touch-window-zoom-band';
const WINDOW_HINT_CLASS = 'touch-window-zoom-hint';

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
 * Take a plot's hover label away, for good.
 *
 * Unhovering alone does not last: Plotly remembers which subplot the pointer
 * was over and draws the label again after every redraw, until a mouseout
 * says the pointer left — and a finger never sends one. So after a pan, a
 * window zoom or a fit, the label of a tap made long before came back, over a
 * point nobody was touching.
 *
 * @param {HTMLElement} div a Plotly graph div
 * @param {{Fx?: {unhover?: Function}}} plotly
 */
export function clearPlotHover(div, plotly) {
    if (div?._fullLayout) div._fullLayout._hoversubplot = null;
    plotly?.Fx?.unhover?.(div);
}

/**
 * An axis range as numbers the arithmetic can move, and back.
 *
 * Plotly keeps a date axis's range as date strings ('2024-03-01 12:00'), which
 * are not numbers: every pan and pinch of the time axis came out NaN and was
 * dropped, so on a file with calendar time a finger moved the amplitude and
 * nothing else. Its linearised form is ms (and log10 on a log axis, where the
 * range already is), and l2r writes a result back the way the axis keeps it.
 */
export function rangeToLinear(axis) {
    const range = axis?.range;
    if (!Array.isArray(range) || range.length < 2) return null;
    const toLinear = typeof axis.r2l === 'function' ? (value) => axis.r2l(value) : Number;
    const linear = [Number(toLinear(range[0])), Number(toLinear(range[1]))];
    return linear.every(Number.isFinite) ? linear : null;
}

export function rangeFromLinear(axis, linear) {
    return typeof axis?.l2r === 'function' ? linear.map(value => axis.l2r(value)) : linear;
}

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
    // p2l, deliberately: the anchor has to be in the same units as the range
    // it anchors, and those are Plotly's linearised ones — log10 on a log axis,
    // ms on a date axis (see rangeToLinear). It also knows that a y axis runs
    // the other way. p2c is not it: on a log axis it answers in data values.
    if (typeof axis.p2l === 'function') return Number(axis.p2l(local));
    const [lo, hi] = rangeToLinear(axis) || [NaN, NaN];
    const length = axis._length || (vertical ? rect.height : rect.width) || 1;
    const fraction = vertical ? 1 - (local / length) : local / length;
    return lo + fraction * (hi - lo);
}

/**
 * A plot that wants the window zoom says so with `div._touchWindowZoom`: a
 * function answering, at the moment of the touch, null (not now) or
 * `{ hint }`, the line shown while it waits for the drag.
 *
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

    // The window zoom. `lastTap` is the tap a second touch may follow;
    // `followUp` is that second touch while it is still deciding what it is;
    // `armedUntil` is set by a slow double tap, waiting for the drag.
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let lastTap = null;
    let touchStartedAt = 0;
    let fingersSeen = 0;
    let followUp = null;
    let holdTimer = 0;
    let armedUntil = 0;
    let armedTimer = 0;
    let hintEl = null;
    let windowSel = null;

    const windowZoomOptions = () => {
        const ask = div._touchWindowZoom;
        if (typeof ask !== 'function') return null;
        try { return ask() || null; } catch { return null; }
    };

    const clearHold = () => {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = 0;
    };

    const disarm = () => {
        armedUntil = 0;
        if (armedTimer) clearTimeout(armedTimer);
        armedTimer = 0;
        hintEl?.remove();
        hintEl = null;
    };

    // The plotting area, on screen.
    const plotArea = () => {
        const xa = div._fullLayout?.xaxis;
        const ya = div._fullLayout?.yaxis;
        if (!xa?._length || !ya?._length || typeof xa.p2l !== 'function') return null;
        const rect = div.getBoundingClientRect();
        const left = rect.left + (xa._offset || 0);
        return { xa, left, right: left + xa._length, top: rect.top + (ya._offset || 0), height: ya._length };
    };

    const arm = (options) => {
        disarm();
        // The first tap's label: what is wanted now is a window, not a value.
        clearPlotHover(div, plotly);
        const area = plotArea();
        if (!area) return;
        armedUntil = now() + WINDOW_ZOOM_ARMED_MS;
        armedTimer = setTimeout(disarm, WINDOW_ZOOM_ARMED_MS);
        if (!options?.hint || typeof document === 'undefined') return;
        hintEl = document.createElement('div');
        hintEl.className = WINDOW_HINT_CLASS;
        hintEl.textContent = options.hint;
        hintEl.style.left = `${(area.left + area.right) / 2}px`;
        // Low in the plot: the legend and the fit buttons are at the top.
        hintEl.style.top = `${area.top + Math.max(8, area.height - 64)}px`;
        document.body.appendChild(hintEl);
    };

    const startWindow = (clientX) => {
        clearHold();
        disarm();
        followUp = null;
        const area = plotArea();
        if (!area || typeof document === 'undefined') return false;
        const x = Math.min(area.right, Math.max(area.left, clientX));
        const band = document.createElement('div');
        band.className = WINDOW_BAND_CLASS;
        band.style.top = `${area.top}px`;
        band.style.height = `${area.height}px`;
        band.style.left = `${x}px`;
        band.style.width = '0px';
        document.body.appendChild(band);
        windowSel = { area, from: x, to: x, band };
        // Whatever pan had begun under this finger stops where it is.
        flush();
        clearPlotHover(div, plotly);
        gesture = null;
        div.classList.add(GESTURE_CLASS);
        return true;
    };

    const updateWindow = (clientX) => {
        if (!windowSel) return;
        const { area, from, band } = windowSel;
        const to = Math.min(area.right, Math.max(area.left, clientX));
        windowSel.to = to;
        band.style.left = `${Math.min(from, to)}px`;
        band.style.width = `${Math.abs(to - from)}px`;
    };

    const finishWindow = (commit) => {
        const selection = windowSel;
        windowSel = null;
        if (!selection) return;
        selection.band.remove();
        settle(true);
        if (!commit) return;
        const { area } = selection;
        const xa = area.xa;
        const range = windowZoomRange(selection.from - area.left, selection.to - area.left, pixel => xa.p2l(pixel));
        if (!range) return;
        plotly.relayout(div, {
            'xaxis.range': rangeFromLinear(xa, range),
            'xaxis.autorange': false,
        }).catch(() => {});
    };

    const forgetWindowZoom = () => {
        clearHold();
        followUp = null;
        lastTap = null;
        disarm();
        if (windowSel) finishWindow(false);
    };

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
            ranges: { x: rangeToLinear(x), y: rangeToLinear(y), y2: rangeToLinear(y2) },
            // What the hand came down on. Everything after this is about
            // keeping these values under it.
            anchors: {
                x: axisValueAt(x, centre.x, rect),
                y: axisValueAt(y, centre.y, rect, true),
                y2: axisValueAt(y2, centre.y, rect, true),
            },
        };
    };

    // A tap reads the value under it. The browser's compatibility mouse
    // events usually do this for Plotly, but only with a mousemove, and none
    // is sent when the finger lands where the last tap did: the second tap on
    // the same spot showed nothing. So the tap asks Plotly itself.
    const showTapValue = (event, point) => {
        const target = event.changedTouches?.[0]?.target;
        if (!target || !onPlotSurface(target) || typeof plotly.Fx?.hover !== 'function') return;
        if (div._fullLayout?.hovermode === false) return;
        try {
            plotly.Fx.hover(div, { clientX: point.x, clientY: point.y, target }, 'xy');
        } catch { /* a plot with no x–y subplot has nothing to read here */ }
    };

    const settle = (moved) => {
        div.classList.remove(GESTURE_CLASS);
        // A finger never leaves the plot, so nothing ever takes the hover
        // label away by itself. After a gesture it is about somewhere the
        // reader has not been for a while.
        if (moved) clearPlotHover(div, plotly);
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
        if (!gesture && !windowSel) {
            touchStartedAt = now();
            fingersSeen = 0;
        }
        fingersSeen = Math.max(fingersSeen, points.length);
        if (points.length > 1) {
            // A second finger is a pinch, whatever the first one was doing.
            forgetWindowZoom();
        } else if (!windowSel) {
            const options = windowZoomOptions();
            const [point] = points;
            const time = now();
            if (options && armedUntil && time < armedUntil) {
                // The drag a slow double tap was waiting for.
                event.preventDefault();
                if (startWindow(point.x)) return;
            } else if (options && isFollowUpTap(lastTap, { time, ...point })) {
                followUp = { x: point.x, gap: time - lastTap.time };
                clearHold();
                holdTimer = setTimeout(() => {
                    holdTimer = 0;
                    if (followUp && gesture && !gesture.moved) startWindow(followUp.x);
                }, WINDOW_ZOOM_HOLD_MS);
            }
            lastTap = null;
        }
        gesture = baseline(points, gesture?.moved ?? false);
    };

    const onTouchMove = (event) => {
        // Only stepping aside: the drag that claimed this touch follows it on
        // document listeners, and stopping the event here would starve them.
        if (claimed) return;
        if (windowSel) {
            const touches = gestureTouches(event);
            event.stopPropagation();
            event.preventDefault();
            if (touches.length === 1) updateWindow(touches[0].x);
            return;
        }
        if (!gesture) return;
        const points = gestureTouches(event);
        if (!points.length) { gesture = null; return; }
        event.stopPropagation();
        if (points.length !== gesture.points.length) { gesture = baseline(points, gesture.moved); return; }
        // Still within a tap's wobble: leave it alone, so it can still become a
        // click. Nothing scrolls in the meantime — the plot's touch-action says
        // the browser has no gesture of its own here.
        if (!gesture.moved && !movedBeyondSlop(gesture.points, points)) return;
        // A second touch that drags draws the window instead of panning.
        if (!gesture.moved && followUp && points.length === 1) {
            event.preventDefault();
            if (startWindow(followUp.x)) {
                updateWindow(points[0].x);
                return;
            }
        }
        clearHold();
        followUp = null;
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
            update[`${key}.range`] = rangeFromLinear(axis, next);
            update[`${key}.autorange`] = false;
        };
        put('xaxis', x, gesture.ranges.x, gesture.anchors.x, scales.x, false);
        put('yaxis', y, gesture.ranges.y, gesture.anchors.y, scales.y, true);
        // A trace on the right-hand axis is under the same fingers, and an
        // axis left behind would slide out from under its own curve.
        put('yaxis2', y2, gesture.ranges.y2, gesture.anchors.y2, scales.y, true);
        if (Object.keys(update).length) schedule(update);
    };

    // A tap's compatibility mouse events can end with a mouseout from the
    // plot (measured in Chromium's touch emulation, one tap in eight), and
    // Plotly answers a mouseout by taking the hover label away: the value the
    // tap just showed vanished. A finger has no pointer to leave with, so a
    // mouseout this soon after a touch is not passed on.
    let lastTouchEndAt = -Infinity;
    const onMouseOut = (event) => {
        if (now() - lastTouchEndAt < TAP_MOUSEOUT_GRACE_MS && onPlotSurface(event.target)) event.stopPropagation();
    };

    const onTouchEnd = (event) => {
        lastTouchEndAt = now();
        if (claimed) {
            if ((event.touches?.length || 0) === 0) claimed = false;
            return;
        }
        if (windowSel) {
            // No click after it: Plotly would read the lifted finger as a tap.
            event.preventDefault();
            if ((event.touches?.length || 0) === 0) finishWindow(true);
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
        const [landed] = gesture.points;
        gesture = null;
        flush();
        settle(moved);
        clearHold();
        const time = now();
        if (followUp) {
            // The second touch was a tap. Quick, it is Plotly's double tap and
            // its reset; slow, the plot waits for the drag that draws the window.
            const { gap } = followUp;
            followUp = null;
            const options = !moved && gap >= QUICK_DOUBLE_TAP_MS ? windowZoomOptions() : null;
            if (options) {
                event.preventDefault();
                arm(options);
            }
            lastTap = null;
        } else if (!moved && fingersSeen === 1 && landed && time - touchStartedAt <= TAP_MAX_DURATION_MS) {
            lastTap = { time, x: landed.x, y: landed.y };
            showTapValue(event, landed);
        } else {
            lastTap = null;
        }
    };

    // A cancelled touch is not the end of the gesture — a palm can be rejected,
    // or the browser can take one finger back — so what is left carries on.
    const onTouchCancel = (event) => {
        if ((event.touches?.length || 0) === 0) claimed = false;
        forgetWindowZoom();
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
    div.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    div.addEventListener('touchcancel', onTouchCancel, { capture: true });
    div.addEventListener('mouseout', onMouseOut, { capture: true });
    return true;
}
