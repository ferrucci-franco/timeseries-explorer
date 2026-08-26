// Turning wheel motion into slider steps (#58).
//
// The wheel only grabs a slider after the pointer has rested on it for a
// moment — otherwise scrolling the sidebar would snag on every slider it
// crosses. The dwell is a constant, not a setting: the on/off switch is the
// user's knob, the timing is ours.
//
// Step sizing is the part that earned a rework. One native step per notch
// reads as obviously right and is obviously wrong twice over: the FFT-family
// range sliders declare step="any" over the data's own domain (microseconds,
// or calendar milliseconds), where any fixed default is either a jump to the
// end stop or no visible motion at all — and the animation scrubber's step of
// one frame makes a thousand-frame recording a thousand notches. So a notch
// moves a fixed fraction of the slider's span (a full sweep in about
// SLIDER_WHEEL_SWEEP_NOTCHES notches), never less than the native step and
// always snapped to its grid; Shift asks for the fine version — the native
// step itself, or 1/SLIDER_WHEEL_FINE_NOTCHES of the span on continuous
// sliders.
//
// Kept DOM-free so the arithmetic is testable in Node: the document-level
// listener in ui-methods.js feeds events in and applies the returned values.

export const SLIDER_WHEEL_DWELL_MS = 150;
// 'input' fires on every tick; the expensive 'change' listeners (FFT and
// friends recompute on it) fire once the ticking pauses, matching how a drag
// fires it on release.
export const SLIDER_WHEEL_CHANGE_DELAY_MS = 250;
// A full sweep of any slider in ~100 notches; Shift refines to the native
// step, or to 1/1000 of the span when the slider is continuous (step="any").
export const SLIDER_WHEEL_SWEEP_NOTCHES = 100;
export const SLIDER_WHEEL_FINE_NOTCHES = 1000;

// One slider step per wheel notch. Mice report ~100px per notch; lines and
// pages (deltaMode 1/2) are normalized to pixels first.
const WHEEL_NOTCH_PX = 100;
const LINE_HEIGHT_PX = 33;
const PAGE_HEIGHT_PX = 300;

/** Dominant-axis wheel delta in pixels (positive = down/right). */
export function wheelDeltaPixels(event) {
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return 0;
    if (event.deltaMode === 1) return delta * LINE_HEIGHT_PX;
    if (event.deltaMode === 2) return delta * PAGE_HEIGHT_PX;
    return delta;
}

/**
 * Consume whole notches from an accumulated pixel delta. Scrolling up
 * (negative pixels) yields positive steps — up means increase. (With Shift
 * held most systems report the same motion on deltaX; the dominant-axis rule
 * above keeps the direction.)
 */
export function takeWheelSteps(accumulatedPx) {
    const notches = Math.trunc(accumulatedPx / WHEEL_NOTCH_PX);
    return { steps: -notches, rest: accumulatedPx - notches * WHEEL_NOTCH_PX };
}

/**
 * The value a range input should take after moving `steps` wheel notches.
 *
 * Uses the spec's range-input defaults (min 0, max 100, step 1 — an absent
 * step attribute means 1, only the literal "any" means continuous). A coarse
 * notch is span/SLIDER_WHEEL_SWEEP_NOTCHES, never less than the native step
 * and rounded to a whole number of native steps so grids (odd-only windows,
 * whole frames) are respected; `fine: true` uses the native step itself, or
 * span/SLIDER_WHEEL_FINE_NOTCHES on continuous sliders. Returns null when
 * the slider cannot move.
 */
export function steppedSliderValue({ value, min, max, step }, steps, options = {}) {
    if (!steps) return null;
    const lo = numberOr(min, 0);
    const hi = numberOr(max, 100);
    if (!(hi > lo)) return null;
    const span = hi - lo;
    const stepText = String(step ?? '').trim().toLowerCase();
    const grid = Number(step) > 0 ? Number(step) : (stepText === 'any' ? null : 1);

    let stepBy;
    if (options.fine) {
        stepBy = grid ?? span / SLIDER_WHEEL_FINE_NOTCHES;
    } else if (grid) {
        const coarse = span / SLIDER_WHEEL_SWEEP_NOTCHES;
        stepBy = Math.max(grid, Math.round(coarse / grid) * grid);
    } else {
        stepBy = span / SLIDER_WHEEL_SWEEP_NOTCHES;
    }

    const current = clamp(numberOr(value, lo), lo, hi);
    let next = current + steps * stepBy;
    if (grid) next = lo + Math.round((next - lo) / grid) * grid;
    // 15 significant digits: enough to keep calendar-epoch milliseconds
    // exact, few enough to shed float dust like 0.30000000000000004.
    next = clamp(Number(next.toPrecision(15)), lo, hi);
    return next === current ? null : next;
}

const numberOr = (value, fallback) => {
    const n = Number(value);
    return value !== '' && value !== null && value !== undefined && Number.isFinite(n) ? n : fallback;
};

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
