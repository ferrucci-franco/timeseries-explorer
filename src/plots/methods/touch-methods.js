import Plotly from '../../vendor/plotly.js';
import { computeTouchGesture, pinchAxes, transformRange } from '../touch-gesture.js';
import { screenPointToStage } from '../../ui/viewport-transform.js';

export function installPlotTouchMethods(TargetClass) {
    const proto = TargetClass.prototype;

// Finger gestures on a 2D pane.
//
//   one finger        pan the axes
//   two fingers       pinch to zoom, and drag to pan at the same time
//   double tap        autoscale
//
// A pinch that is mostly horizontal zooms only X and one that is mostly
// vertical only Y, which is what a time series wants: stretching time without
// disturbing the amplitude, or the other way round. Which axes a pinch owns is
// settled from the opening finger separation and held for the rest of the
// gesture, so it cannot flicker while the fingers move.
//
// The handler sits on the CAPTURE phase and stops the event as soon as it takes
// a gesture, for two reasons: Plotly's own touch handling on the drag layer
// would otherwise draw a zoom box under the finger, and the page-level pinch in
// ../../ui/mobile-viewport.js listens on the bubble phase, so a claimed gesture
// never reaches it. Touches outside the drawn area — the modebar, the legend,
// the axis titles — are left alone and keep working as taps.
//
// Follows the same live/finalize contract as _installWheelPan and
// _installRightButtonPan: `options.finalize(xRange)` commits the new window.
proto._installTouchGestures = function(panelId, plot, div, options = {}) {
    if (!div || div._touchGesturesBound) return;
    div._touchGesturesBound = true;

    const DOUBLE_TAP_MS = 320;
    const TAP_MAX_MS = 400;
    const TAP_SLOP = 12;

    const state = {
        active: null,
        pending: null,
        raf: 0,
        moved: false,
        latestXRange: null,
        tapStartedAt: 0,
        lastTapAt: 0,
    };

    // The origin is read once per gesture and the fingers mapped against it, so
    // a move costs no layout reads. _divLayoutOrigin is what undoes the phone
    // stage's scale and quarter turn.
    const localPoints = (event, origin) => {
        const points = [];
        for (let i = 0; i < Math.min(2, event.touches.length); i++) {
            const p = screenPointToStage(event.touches[i].clientX, event.touches[i].clientY);
            points.push({ x: p.x - origin.x, y: p.y - origin.y });
        }
        return points;
    };

    // `invert` is about pixels only: a Y axis grows upwards while its pixels
    // grow downwards.
    const axisBase = (ax, invert) => {
        if (!ax?._length || !ax.range) return null;
        const range = ax.range.map(v => this._coerceAxisValue(v));
        if (!range.every(Number.isFinite)) return null;
        return {
            range,
            offset: ax._offset || 0,
            length: ax._length,
            invert,
            fixed: !!ax.fixedrange,
            isDate: ax.type === 'date',
        };
    };

    const captureBase = () => {
        const fl = div._fullLayout;
        const x = axisBase(fl?.xaxis, false);
        const y = axisBase(fl?.yaxis, true);
        if (!x || !y) return null;
        // The secondary Y only exists on the timeseries chart, and zooms by the
        // same pixel gesture as the primary — matching the wheel and
        // right-button pans.
        const y2 = (plot.timeseriesY2Enabled && plot.mode === 'timeseries')
            ? axisBase(fl?.yaxis2, true)
            : null;
        return { x, y, y2 };
    };

    // Re-read the fingers and the current ranges. Called whenever the finger
    // count changes, so that adding or lifting one finger mid-gesture continues
    // smoothly from where the view already is instead of snapping back to where
    // the first finger landed.
    const rebase = (event) => {
        const origin = this._divLayoutOrigin(div);
        const points = localPoints(event, origin);
        const base = captureBase();
        if (!points.length || !base) {
            state.active = null;
            return false;
        }
        state.active = { origin, startPoints: points, base, axes: pinchAxes(points) };
        return true;
    };

    const flush = () => {
        state.raf = 0;
        const gesture = state.pending;
        const active = state.active;
        state.pending = null;
        if (!gesture || !active) return;

        const { x, y, y2 } = active.base;
        const update = {};
        if (!x.fixed) {
            const range = transformRange({
                range: x.range, offset: x.offset, length: x.length,
                anchorPx: gesture.anchorX, scale: gesture.scaleX, panPx: gesture.dx, invert: false,
            });
            if (range) {
                state.latestXRange = x.isDate ? range.map(v => new Date(v).toISOString()) : range;
                update['xaxis.range'] = state.latestXRange;
            }
        }
        for (const [name, axis] of [['yaxis', y], ['yaxis2', y2]]) {
            if (!axis || axis.fixed) continue;
            const range = transformRange({
                range: axis.range, offset: axis.offset, length: axis.length,
                anchorPx: gesture.anchorY, scale: gesture.scaleY, panPx: gesture.dy, invert: true,
            });
            if (range) update[`${name}.range`] = range;
        }
        if (!Object.keys(update).length) return;

        plot._relayoutLiveOnly = true;
        // Only the TIME pane may live re-fit; a results pane (spectrum,
        // histogram) carries a range in another unit that would empty the time
        // traces. Same rule as the wheel and right-button pans.
        if (div === plot.div && (this.relayoutRefreshMode || 'auto') === 'responsive' && state.latestXRange) {
            this._scheduleLivePanRefresh(panelId, plot, state.latestXRange);
        }
        Plotly.relayout(div, update).finally(() => {
            if (plot._relayoutLiveOnly) this._renderCursorOverlay(plot, { range: state.latestXRange, lightweight: true });
        });
    };

    const autoScale = () => {
        if (div === plot.div) {
            this._autoScalePlot(panelId, plot);
            return;
        }
        Plotly.relayout(div, { 'xaxis.autorange': true, 'yaxis.autorange': true });
    };

    const endGesture = () => {
        if (state.raf) {
            cancelAnimationFrame(state.raf);
            state.raf = 0;
            flush();
        }
        this._clearLivePanRefresh(plot);
        plot._relayoutLiveOnly = false;
        // Only a gesture that actually moved something commits; a tap leaves
        // the window exactly where it was.
        if (state.moved && state.latestXRange && typeof options.finalize === 'function') {
            options.finalize(state.latestXRange);
        }
        state.active = null;
        state.pending = null;
        state.moved = false;
        state.latestXRange = null;
    };

    div.addEventListener('touchstart', (event) => {
        if (!event.touches.length) return;
        // A gesture is claimed only if it opens over the drawn area, so the
        // modebar and the legend stay tappable.
        if (!state.active && !this._eventInsidePlotArea(div, event.touches[0])) return;
        if (!state.active) {
            state.tapStartedAt = Date.now();
            state.moved = false;
        }
        if (!rebase(event)) return;
        event.preventDefault();
        event.stopPropagation();
    }, { capture: true, passive: false });

    div.addEventListener('touchmove', (event) => {
        if (!state.active) return;
        event.preventDefault();
        event.stopPropagation();
        const points = localPoints(event, state.active.origin);
        if (!points.length) return;
        if (points.length !== state.active.startPoints.length) {
            rebase(event);
            return;
        }
        const gesture = computeTouchGesture(state.active.startPoints, points, { axes: state.active.axes });
        if (!gesture) return;
        if (Math.hypot(gesture.dx, gesture.dy) > TAP_SLOP
            || gesture.scaleX !== 1 || gesture.scaleY !== 1) {
            state.moved = true;
        }
        // Nothing is applied until the gesture clears the tap slop, so a tap
        // leaves the window exactly where it was and the double tap below is
        // free to autoscale.
        if (!state.moved) return;
        state.pending = gesture;
        if (!state.raf) state.raf = requestAnimationFrame(flush);
    }, { capture: true, passive: false });

    const onTouchEnd = (event) => {
        if (!state.active) return;
        event.stopPropagation();
        if (event.touches.length) {
            rebase(event);
            return;
        }
        const now = Date.now();
        const wasTap = !state.moved && (now - state.tapStartedAt) < TAP_MAX_MS;
        endGesture();
        if (!wasTap) return;
        if (now - state.lastTapAt < DOUBLE_TAP_MS) {
            state.lastTapAt = 0;
            autoScale();
        } else {
            state.lastTapAt = now;
        }
    };

    div.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    div.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });
};

}
