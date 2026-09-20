// Telling a drag from a scroll, with one finger.
//
// HTML5 drag and drop is a mouse protocol: `dragstart` never fires for a touch,
// so on a tablet the variable tree could not put anything on a panel at all
// (#110). Rebuilding the gesture out of touch events runs into the question the
// mouse never has to answer — the same finger, on the same list, means "scroll
// me" and "pick this up", and nothing but time and distance tells them apart.
//
// The rule here is the one every touch list uses: a finger that stays put for a
// moment is picking something up; a finger that moves first is scrolling. So a
// press that survives `holdMs` without straying further than `tolerancePx`
// becomes a drag, and any earlier movement hands the gesture back to the page.
//
// No DOM, no timers: the caller owns both, and calls `hold()` when its timer
// fires. That keeps this a decision table, which is the part worth testing.

export const TOUCH_DRAG_HOLD_MS = 350;
export const TOUCH_DRAG_TOLERANCE_PX = 10;

/**
 * @param {{holdMs?: number, tolerancePx?: number}} [options]
 * @returns {{
 *   state: () => 'idle'|'pressing'|'dragging',
 *   start: (x: number, y: number) => string,
 *   moved: (x: number, y: number) => string,
 *   hold: () => string,
 *   end: () => 'drop'|'tap'|'none',
 *   cancel: () => 'idle',
 *   origin: () => {x: number, y: number}|null,
 *   holdMs: number,
 * }}
 */
export function createTouchDragGesture({ holdMs = TOUCH_DRAG_HOLD_MS, tolerancePx = TOUCH_DRAG_TOLERANCE_PX } = {}) {
    let state = 'idle';
    let origin = null;

    const reset = () => {
        state = 'idle';
        origin = null;
        return state;
    };

    return {
        holdMs,
        state: () => state,
        origin: () => (origin ? { ...origin } : null),

        start(x, y) {
            origin = { x: Number(x), y: Number(y) };
            state = 'pressing';
            return state;
        },

        /** A finger that strays before the hold is over was always scrolling. */
        moved(x, y) {
            if (state === 'idle' || !origin) return state;
            if (state === 'dragging') return state;
            const dx = Number(x) - origin.x;
            const dy = Number(y) - origin.y;
            if (Math.hypot(dx, dy) > tolerancePx) return reset();
            return state;
        },

        /** The caller's hold timer fired. */
        hold() {
            if (state !== 'pressing') return state;
            state = 'dragging';
            return state;
        },

        end() {
            const wasDragging = state === 'dragging';
            const wasPressing = state === 'pressing';
            reset();
            if (wasDragging) return 'drop';
            return wasPressing ? 'tap' : 'none';
        },

        cancel: reset,
    };
}
