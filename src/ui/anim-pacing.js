// How an animation shares the page with the hand using it.
//
// A state animation redraws its plot on every animation frame. On a phone a
// 3D frame (a full Plotly redraw of the scene) costs about 100 ms, measured
// with the CPU slowed to a phone's: frame after frame, the main thread never
// came free, and the page stopped answering.
//
// It was worse on iOS, where Safari drops a tap's click when the page changes
// while it is delivering that tap — its guard against a hover menu appearing
// under the finger. A frame changes the page about sixty times a second, so a
// tap on Plot, on pause or on the speed went nowhere, and had to be repeated
// until one happened to land between two frames. The desktop has neither
// problem: a mouse click is not a tap, and its frames are cheap.
//
// Two rules, then:
//   * while a finger is on the screen, and for a moment after it lifts (the
//     time Safari takes to turn the tap into a click), the animation stands
//     still;
//   * a frame is drawn only after the page has had as long to itself as the
//     last frame took, so playback never holds more than half the thread.

/** After the last finger lifts, how long playback keeps still for its click. */
export const TOUCH_RELEASE_HOLD_MS = 450;

let holdUntil = 0;
let installed = false;

/** Listen, once per page, for fingers coming down and lifting. */
export function installAnimTouchHold(target = typeof document !== 'undefined' ? document : null) {
    if (installed || !target?.addEventListener) return;
    installed = true;
    const options = { capture: true, passive: true };
    target.addEventListener('touchstart', () => { holdUntil = Infinity; }, options);
    const release = (event) => {
        if ((event.touches?.length || 0) > 0) return;
        holdUntil = nowMs() + TOUCH_RELEASE_HOLD_MS;
    };
    target.addEventListener('touchend', release, options);
    target.addEventListener('touchcancel', release, options);
}

/** Is a finger on the screen, or has one just lifted? */
export function animHeldByTouch(now = nowMs()) {
    return now < holdUntil;
}

/**
 * When the next frame may be drawn: as long after this one as it took.
 *
 * @param {number} renderedAt when the frame's work ended (ms)
 * @param {number} cost how long it took (ms)
 * @returns {number}
 */
export function nextFrameAt(renderedAt, cost) {
    const spent = Number.isFinite(cost) && cost > 0 ? cost : 0;
    return renderedAt + spent;
}

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** For tests: forget any hold. */
export function resetAnimTouchHold() {
    holdUntil = 0;
}
