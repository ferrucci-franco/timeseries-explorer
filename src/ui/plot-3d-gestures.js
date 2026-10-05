// Fingers on a 3D plot: orbit, zoom, and pan after a slow double tap.
//
// Plotly's gl3d camera reads a touch as a mouse with one button: every
// touchmove rotates by how far `changedTouches[0]` moved since the last event.
// With two fingers down, `changedTouches[0]` is whichever finger happened to
// move, so consecutive events alternate between two points that can be
// centimetres apart — and the scene spins wildly back and forth. There is no
// pinch zoom in it at all.
//
// Its wheel zoom has the same problem on a trackpad: in orthographic
// projection (the app's default) every wheel event scales the scene by a fixed
// 10 %, whatever its delta, and a trackpad pinch sends dozens of them.
//
// So on a 3D scene this module takes:
//
//   two fingers   pinch zoom   the scene scales by how far the fingers spread;
//                              Plotly sees nothing until the last finger lifts,
//                              so a finger left behind never turns into a jump
//   tap, then     pan          where the plot asks for it (div._touchScenePan):
//   touch again                a tap and a second touch soon after slide the
//                              scene with one finger instead of orbiting it; a
//                              slow second tap waits for the drag. Two fingers
//                              moving together were tried first, and did not
//                              work on an iPhone.
//   the wheel     zoom         proportional to the delta, so a trackpad pinch
//                              and a mouse notch both feel continuous
//
// One finger is still Plotly's orbit: that part works.
//
// A zoom is written the way Plotly writes its own: orthographic scenes scale
// their aspect ratio, perspective ones move the camera closer. Both go straight
// to the scene (no relayout per frame, which would redraw every trace), and the
// layout is brought in step once the gesture ends.

const MIN_SEPARATION_PX = 24;
const MAX_GESTURE_SCALE = 50;
// Wheel delta (in pixels) → zoom exponent. A trackpad pinch arrives as small
// ctrl-wheel deltas, so it gets the steeper slope.
const WHEEL_ZOOM_PER_PX = 0.002;
const PINCH_WHEEL_ZOOM_PER_PX = 0.01;
const LINE_HEIGHT_PX = 16;
const WHEEL_SETTLE_MS = 180;

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

/** The 3D scene (Plotly's internal Scene object) whose container holds `target`. */
function sceneAt(div, target) {
    const layout = div?._fullLayout;
    if (!layout || !target) return null;
    for (const key of Object.keys(layout)) {
        if (!key.startsWith('scene')) continue;
        const scene = layout[key]?._scene;
        if (scene?.container?.contains?.(target) && scene.glplot && scene.camera) return scene;
    }
    return null;
}

import {
    QUICK_DOUBLE_TAP_MS,
    TAP_MAX_DURATION_MS,
    TOUCH_GESTURE_SLOP_PX,
    WINDOW_ZOOM_ARMED_MS,
    WINDOW_ZOOM_HOLD_MS,
    isFollowUpTap,
} from '../utils/touch-plot-gestures.js';

const HINT_CLASS = 'touch-window-zoom-hint';

/**
 * Scene units per screen pixel, at the depth of what the camera looks at:
 * how far the camera moves for the view to slide by one pixel. Read off the
 * projection, so it holds in both projections and at any zoom.
 */
export function panUnitsPerPixel({ ortho, projectionYScale, distance, heightPx }) {
    if (!(projectionYScale > 0) || !(heightPx > 0)) return 0;
    // Perspective: the visible half-height at depth d is d / P[5]; ortho: 1 / P[5].
    const halfHeight = ortho ? 1 / projectionYScale : distance / projectionYScale;
    return Number.isFinite(halfHeight) ? (2 * halfHeight) / heightPx : 0;
}

function panScale(scene) {
    const projection = scene.glplot?.cameraParams?.projection;
    const canvas = scene.glplot?.canvas || scene.container;
    return panUnitsPerPixel({
        ortho: !!scene.camera._ortho,
        projectionYScale: Number(projection?.[5]),
        distance: Number(scene.camera.distance),
        heightPx: canvas?.clientHeight || 0,
    });
}

const separation = (touches) => {
    if (!touches || touches.length < 2) return 0;
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
};

/** Where the zoom starts from, so every frame is measured against it. */
function zoomBase(scene) {
    if (scene.camera._ortho) {
        const ar = scene.glplot.getAspectratio();
        return { ortho: true, aspect: { x: ar.x, y: ar.y, z: ar.z } };
    }
    const distance = Number(scene.camera.distance);
    return Number.isFinite(distance) && distance > 0 ? { ortho: false, distance } : null;
}

// A new aspect ratio is only drawn at the scene's next redraw, and nothing
// asks for one until the camera moves or the layout is saved — so without
// this an orthographic zoom stayed invisible until the fingers lifted. One
// redraw per frame, however many touch or wheel events arrive in it.
const pendingRedraw = new WeakSet();
function requestRedraw(scene) {
    if (pendingRedraw.has(scene)) return;
    pendingRedraw.add(scene);
    const run = () => {
        pendingRedraw.delete(scene);
        try { scene.glplot?.redraw?.(); } catch (_) { /* scene disposed mid-gesture */ }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

/** Apply `scale` (>1 zooms in) relative to `base`. */
function applyZoom(scene, base, scale) {
    if (!base || !Number.isFinite(scale) || scale <= 0) return;
    if (base.ortho) {
        scene.glplot.setAspectratio({ x: base.aspect.x * scale, y: base.aspect.y * scale, z: base.aspect.z * scale });
        requestRedraw(scene);
    } else {
        // A camera move is picked up by the scene's own render loop.
        scene.camera.distance = base.distance / scale;
    }
}

/**
 * Bring the layout in step with a zoom made directly on the scene — the same
 * thing Plotly does after its own wheel zoom — so a later relayout, a saved
 * session or the Home button all see the view the reader is looking at.
 */
function commit(div, scene) {
    try {
        const layout = div.layout;
        const id = scene.id || 'scene';
        const update = { [`${id}.camera`]: scene.getCamera() };
        if (scene.camera._ortho) {
            update[`${id}.aspectratio`] = scene.glplot.getAspectratio();
            update[`${id}.aspectmode`] = 'manual';
            if (layout?.[id]) layout[id].aspectmode = 'manual';
            if (scene.fullSceneLayout) scene.fullSceneLayout.aspectmode = 'manual';
        }
        scene.saveLayout(layout);
        div.emit?.('plotly_relayout', update);
    } catch (_) { /* the scene was replaced mid-gesture: nothing to sync */ }
}

// Every full redraw of a scene re-applies its turntable drag mode, and Plotly's
// camera answers that by scheduling a 500 ms transition to "z up" — even when
// z is already up. Until that keyframe's time has passed, whatever the mouse
// does to the camera is overridden by it. A plot redrawn every frame (the 3D
// state animation) keeps it permanently 500 ms ahead, so a drag started while
// it plays did nothing for half a second. This drops the pending keyframes and
// lands the camera, now, on the state they were heading to.
function settleFilteredVector(fv, now) {
    const time = fv?._time;
    if (!Array.isArray(time) || !(time[time.length - 1] > now)) return;
    // The keyframes keep their states; they are only moved to the present,
    // so the camera is already where the transition was heading.
    for (let i = time.length - 1; i >= 0 && time[i] > now; i--) time[i] = now;
}

export function settleSceneCamera(div) {
    const layout = div?._fullLayout;
    if (!layout) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const key of Object.keys(layout)) {
        if (!key.startsWith('scene')) continue;
        const view = layout[key]?._scene?.camera?.view;
        if (!view?._controllerList) continue;
        try {
            for (const controller of view._controllerList) {
                for (const value of Object.values(controller)) settleFilteredVector(value, now);
            }
        } catch (_) { /* a camera shaped differently: leave it be */ }
    }
}

// Fired on the graph div when a hand starts or stops working a scene (any
// touch on it, or a burst of wheel events), so a view that redraws itself
// every frame — the 3D state animation — can stand still meanwhile instead
// of fighting the gesture. Every start is followed by exactly one end.
export const SCENE_GESTURE_START = 'scene-gesture-start';
export const SCENE_GESTURE_END = 'scene-gesture-end';

const announce = (div, type) => {
    try { div.dispatchEvent(new CustomEvent(type)); } catch (_) { /* no CustomEvent: nothing listens */ }
};

/**
 * @param {HTMLElement} div a Plotly graph div
 * @returns {boolean} whether it was installed
 */
export function install3DSceneGestures(div) {
    if (!div || div._sceneGesturesInstalled || typeof div.addEventListener !== 'function') return false;
    div._sceneGesturesInstalled = true;

    // The scene a touch sequence is working on, from its first finger to its
    // last. One finger orbits (Plotly), two zoom (below).
    let touchScene = null;
    const onTouchSessionStart = (event) => {
        if (touchScene) return;
        const scene = sceneAt(div, event.target);
        if (!scene) return;
        touchScene = scene;
        announce(div, SCENE_GESTURE_START);
    };
    const onTouchSessionEnd = (event) => {
        if (!touchScene || (event.touches?.length || 0) > 0) return;
        const scene = touchScene;
        touchScene = null;
        // A one-finger orbit is Plotly's, and it only writes the camera back to
        // the layout on a mouseup: without this, the next full redraw (the
        // animation resuming) would put the old camera back. A tap moved
        // nothing, and says nothing.
        let changed = true;
        try { changed = scene.isCameraChanged(div.layout) || scene.isAspectChanged(div.layout); } catch (_) { /* keep true */ }
        if (changed) commit(div, scene);
        announce(div, SCENE_GESTURE_END);
    };

    // Two fingers are down (or were, and not all have lifted yet).
    let pinch = null;

    const onTouchStart = (event) => {
        if (!pinch) {
            if ((event.touches?.length || 0) < 2) return;
            const scene = sceneAt(div, event.target);
            if (!scene) return;
            pinch = { scene, base: null, start: 0 };
        }
        // Plotly must not hear about the second finger: it would take it for
        // the first one jumping across the plot.
        event.stopPropagation();
        if ((event.touches?.length || 0) >= 2) {
            pinch.start = separation(event.touches);
            pinch.base = zoomBase(pinch.scene);
        }
    };

    const onTouchMove = (event) => {
        if (!pinch) return;
        event.stopPropagation();
        event.preventDefault();
        if ((event.touches?.length || 0) < 2 || !pinch.base) return;
        const now = separation(event.touches);
        if (pinch.start < MIN_SEPARATION_PX || now < MIN_SEPARATION_PX) return;
        const scale = clamp(now / pinch.start, 1 / MAX_GESTURE_SCALE, MAX_GESTURE_SCALE);
        applyZoom(pinch.scene, pinch.base, scale);
        pinch.moved = true;
    };

    const onTouchEnd = (event) => {
        if (!pinch) return;
        const left = event.touches?.length || 0;
        if (left === 0) {
            // The last finger lets Plotly close the drag its first finger
            // opened; it releases at the point it last saw, so nothing moves.
            const { scene, moved } = pinch;
            pinch = null;
            if (moved) commit(div, scene);
            return;
        }
        event.stopPropagation();
        if (left >= 2) {
            // A third finger lifted: carry on from here.
            pinch.start = separation(event.touches);
            pinch.base = zoomBase(pinch.scene);
        } else {
            // Down to one finger: hold still until it lifts or a second one
            // lands, rather than handing a stale drag back to the orbit.
            pinch.base = null;
        }
    };

    // ── Pan: a slow double tap, then one finger ──────────────────────────
    // The first tap is an ordinary one (Plotly's, a tap does not orbit). A
    // second touch soon after, close by, is ours: dragged (or held), it pans;
    // lifted after a slow gap, the scene waits for the drag that will.
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const panOptions = () => {
        try { return typeof div._touchScenePan === 'function' ? div._touchScenePan() : null; } catch (_) { return null; }
    };
    let lastTap = null;     // { time, x, y } of the last one-finger tap
    let oneFinger = null;   // { time, x, y, moved } of the touch in progress
    let pan = null;         // { scene, x, y, panning, followUpGap, holdTimer }
    let armedUntil = 0;
    let armedTimer = 0;
    let hintEl = null;

    const disarm = () => {
        armedUntil = 0;
        clearTimeout(armedTimer);
        armedTimer = 0;
        hintEl?.remove();
        hintEl = null;
    };
    const arm = (scene, options) => {
        disarm();
        armedUntil = nowMs() + WINDOW_ZOOM_ARMED_MS;
        armedTimer = setTimeout(disarm, WINDOW_ZOOM_ARMED_MS);
        if (!options?.hint || typeof document === 'undefined') return;
        const rect = scene.container?.getBoundingClientRect?.();
        if (!rect) return;
        hintEl = document.createElement('div');
        hintEl.className = HINT_CLASS;
        hintEl.textContent = options.hint;
        hintEl.style.left = `${rect.left + rect.width / 2}px`;
        hintEl.style.top = `${rect.top + Math.max(8, rect.height - 64)}px`;
        document.body.appendChild(hintEl);
    };
    const panBy = (dx, dy) => {
        const perPx = panScale(pan.scene);
        const view = pan.scene.camera?.view;
        if (!(perPx > 0) || (!dx && !dy) || typeof view?.pan !== 'function') return;
        // camera.pan() replays at the camera's last keyframe time, which the
        // turntable ignores outside a Plotly drag; stamp it now instead.
        try { view.pan(performance.now(), -dx * perPx, dy * perPx, 0); } catch (_) { /* scene disposed */ }
        pan.moved = true;
    };

    const onPanTouchStart = (event) => {
        const count = event.touches?.length || 0;
        if (count !== 1) {
            // A second finger: a pinch, whatever the first was doing.
            if (pan) { clearTimeout(pan.holdTimer); pan = null; }
            oneFinger = null;
            disarm();
            return;
        }
        const touch = event.touches[0];
        const time = nowMs();
        oneFinger = { time, x: touch.clientX, y: touch.clientY, moved: false };
        const scene = sceneAt(div, event.target);
        const options = scene ? panOptions() : null;
        const armed = armedUntil > 0 && time < armedUntil;
        const followUp = !armed && isFollowUpTap(lastTap, { time, x: touch.clientX, y: touch.clientY });
        const gap = followUp ? time - lastTap.time : 0;
        lastTap = null;
        if (!options || !(armed || followUp)) return;
        // Ours from here: Plotly would orbit under this finger.
        event.stopPropagation();
        event.preventDefault();
        disarm();
        pan = {
            scene, options, x: touch.clientX, y: touch.clientY, moved: false,
            // Armed, the drag pans at once; a follow-up touch pans once it
            // moves, or once it has been held.
            panning: armed,
            followUp,
            slow: gap >= QUICK_DOUBLE_TAP_MS,
            holdTimer: 0,
        };
        if (followUp) pan.holdTimer = setTimeout(() => { if (pan) pan.panning = true; }, WINDOW_ZOOM_HOLD_MS);
    };

    const onPanTouchMove = (event) => {
        const touch = event.touches?.[0];
        if (oneFinger && touch && Math.hypot(touch.clientX - oneFinger.x, touch.clientY - oneFinger.y) > TOUCH_GESTURE_SLOP_PX) {
            oneFinger.moved = true;
        }
        if (!pan || !touch || (event.touches?.length || 0) !== 1) return;
        event.stopPropagation();
        event.preventDefault();
        if (!pan.panning) {
            if (Math.hypot(touch.clientX - pan.x, touch.clientY - pan.y) <= TOUCH_GESTURE_SLOP_PX) return;
            pan.panning = true;
            clearTimeout(pan.holdTimer);
        }
        panBy(touch.clientX - pan.x, touch.clientY - pan.y);
        pan.x = touch.clientX;
        pan.y = touch.clientY;
    };

    const onPanTouchEnd = (event) => {
        if ((event.touches?.length || 0) > 0) return;
        const time = nowMs();
        if (pan) {
            const finished = pan;
            pan = null;
            clearTimeout(finished.holdTimer);
            event.stopPropagation();
            // A pan is written to the layout with the touch session's end
            // (onTouchSessionEnd, which sees the camera changed). A second
            // touch that was a tap: slow, the scene waits for the drag;
            // quick, it was a double tap, and nothing pans.
            if (!finished.moved && finished.followUp && !finished.panning && finished.slow) arm(finished.scene, finished.options);
            oneFinger = null;
            return;
        }
        if (oneFinger && !oneFinger.moved && time - oneFinger.time <= TAP_MAX_DURATION_MS) {
            lastTap = { time, x: oneFinger.x, y: oneFinger.y };
        } else {
            lastTap = null;
        }
        oneFinger = null;
    };

    let wheelTimer = 0;
    let wheelScene = null;
    const onWheel = (event) => {
        // The app's own "mouse wheel zoom" setting still decides.
        if (!div._context?._scrollZoom?.gl3d) return;
        const scene = sceneAt(div, event.target);
        if (!scene) return;
        const delta = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX
            : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
        if (!Number.isFinite(delta) || delta === 0) return;
        event.stopPropagation();
        event.preventDefault();
        const perPx = event.ctrlKey ? PINCH_WHEEL_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX;
        const scale = clamp(Math.exp(-delta * perPx), 0.5, 2);
        if (!wheelScene) announce(div, SCENE_GESTURE_START);
        applyZoom(scene, zoomBase(scene), scale);
        wheelScene = scene;
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
            wheelTimer = 0;
            const settled = wheelScene;
            wheelScene = null;
            if (settled) commit(div, settled);
            announce(div, SCENE_GESTURE_END);
        }, WHEEL_SETTLE_MS);
    };

    // Capture, so this is decided before Plotly's camera listeners (on the
    // scene container, below this div) see anything.
    div.addEventListener('touchstart', onTouchSessionStart, { capture: true });
    div.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    div.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    div.addEventListener('touchend', onTouchEnd, { capture: true });
    div.addEventListener('touchcancel', onTouchEnd, { capture: true });
    div.addEventListener('touchend', onTouchSessionEnd, { capture: true });
    div.addEventListener('touchcancel', onTouchSessionEnd, { capture: true });
    div.addEventListener('wheel', onWheel, { capture: true, passive: false });
    div.addEventListener('touchstart', onPanTouchStart, { capture: true, passive: false });
    div.addEventListener('touchmove', onPanTouchMove, { capture: true, passive: false });
    div.addEventListener('touchend', onPanTouchEnd, { capture: true, passive: false });
    div.addEventListener('touchcancel', onPanTouchEnd, { capture: true, passive: false });
    return true;
}
