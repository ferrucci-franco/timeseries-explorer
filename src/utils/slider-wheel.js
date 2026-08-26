// Turning wheel motion into slider steps (#58).
//
// The wheel only grabs a slider after the pointer has rested on it for a
// moment — otherwise scrolling the sidebar would snag on every slider it
// crosses. The dwell is a constant, not a setting: the on/off switch is the
// user's knob, the timing is ours.
//
// Kept DOM-free so the arithmetic is testable in Node: the document-level
// listener in ui-methods.js feeds events in and applies the returned values.

export const SLIDER_WHEEL_DWELL_MS = 350;
// 'input' fires on every tick; the expensive 'change' listeners (FFT and
// friends recompute on it) fire once the ticking pauses, matching how a drag
// fires it on release.
export const SLIDER_WHEEL_CHANGE_DELAY_MS = 250;

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
 * (negative pixels) yields positive steps — up means increase.
 */
export function takeWheelSteps(accumulatedPx) {
    const notches = Math.trunc(accumulatedPx / WHEEL_NOTCH_PX);
    return { steps: -notches, rest: accumulatedPx - notches * WHEEL_NOTCH_PX };
}

/**
 * The value a range input should take after moving `steps` steps, honouring
 * its min/max/step with the spec's range-input defaults (0/100/1) and staying
 * on the step grid. Returns null when the slider cannot move.
 */
export function steppedSliderValue({ value, min, max, step }, steps) {
    if (!steps) return null;
    const lo = numberOr(min, 0);
    const hi = numberOr(max, 100);
    if (!(hi > lo)) return null;
    const stepBy = Number(step) > 0 ? Number(step) : 1;
    const current = clamp(numberOr(value, lo), lo, hi);
    const moved = current + steps * stepBy;
    const snapped = lo + Math.round((moved - lo) / stepBy) * stepBy;
    // Steps like 0.1 accumulate float dust; keep a couple of guard digits
    // beyond the step's own precision.
    const decimals = (String(stepBy).split('.')[1] || '').length;
    const next = clamp(Number(snapped.toFixed(Math.min(decimals + 2, 10))), lo, hi);
    return next === current ? null : next;
}

const numberOr = (value, fallback) => {
    const n = Number(value);
    return value !== '' && value !== null && value !== undefined && Number.isFinite(n) ? n : fallback;
};

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
