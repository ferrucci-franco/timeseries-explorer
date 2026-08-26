// Mouse-wheel adjustment for sliders (#58): after the pointer rests on a
// range input for a moment, wheel up increases its value one step per notch.
// The dwell is a JS constant; the on/off switch is a sidebar option, default
// ON, saved with the session.
//
//   node scripts/test-slider-wheel.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    SLIDER_WHEEL_CHANGE_DELAY_MS,
    SLIDER_WHEEL_DWELL_MS,
    steppedSliderValue,
    takeWheelSteps,
    wheelDeltaPixels,
} from '../src/utils/slider-wheel.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ─── Wheel deltas → pixels ────────────────────────────────────────────────

check(() => {
    assert.equal(wheelDeltaPixels({ deltaY: 100, deltaX: 0, deltaMode: 0 }), 100, 'pixel mode passes through');
    assert.equal(wheelDeltaPixels({ deltaY: 3, deltaX: 0, deltaMode: 1 }), 99, 'line mode is normalized');
    assert.equal(wheelDeltaPixels({ deltaY: 1, deltaX: 0, deltaMode: 2 }), 300, 'page mode is normalized');
    assert.equal(wheelDeltaPixels({ deltaY: 5, deltaX: -120, deltaMode: 0 }), -120, 'dominant axis wins');
    assert.equal(wheelDeltaPixels({ deltaY: 0, deltaX: 0, deltaMode: 0 }), 0);
});

// ─── Pixels → notches, with carry ─────────────────────────────────────────

check(() => {
    assert.deepEqual(takeWheelSteps(-100), { steps: 1, rest: 0 }, 'one notch up = +1 step');
    assert.deepEqual(takeWheelSteps(120), { steps: -1, rest: 20 }, 'one notch down = -1 step, remainder kept');
    assert.deepEqual(takeWheelSteps(-40), { steps: 0, rest: -40 }, 'below a notch, nothing moves yet');
    assert.deepEqual(takeWheelSteps(-250), { steps: 2, rest: -50 }, 'fast scrolls take several steps');
});

// ─── Steps → slider value ─────────────────────────────────────────────────

check(() => {
    // Range-input defaults: min 0, max 100, step 1.
    assert.equal(steppedSliderValue({ value: '50', min: '', max: '', step: '' }, 1), 51);
    assert.equal(steppedSliderValue({ value: '50', min: '', max: '', step: '' }, -2), 48);
    assert.equal(steppedSliderValue({ value: '99', min: '', max: '', step: '' }, 5), 100, 'clamped at max');
    assert.equal(steppedSliderValue({ value: '100', min: '', max: '', step: '' }, 1), null, 'no move at the end stop');
    assert.equal(steppedSliderValue({ value: '50', min: '', max: '', step: '' }, 0), null);
});

check(() => {
    // The detrend-window shape: odd values only (min 3, step 2).
    assert.equal(steppedSliderValue({ value: '5', min: '3', max: '501', step: '2' }, 1), 7);
    assert.equal(steppedSliderValue({ value: '3', min: '3', max: '501', step: '2' }, -1), null);
    assert.equal(steppedSliderValue({ value: '6', min: '3', max: '501', step: '2' }, 1), 9, 'off-grid values snap to the grid');
    // Fractional steps must not accumulate float dust.
    assert.equal(steppedSliderValue({ value: '0.3', min: '0', max: '1', step: '0.1' }, 1), 0.4);
    assert.equal(steppedSliderValue({ value: '0.7', min: '0', max: '1', step: '0.1' }, -3), 0.4);
    assert.equal(steppedSliderValue({ value: '1', min: '2', max: '2', step: '1' }, 1), null, 'degenerate range moves nothing');
});

check(() => {
    assert.ok(Number.isFinite(SLIDER_WHEEL_DWELL_MS) && SLIDER_WHEEL_DWELL_MS > 0, 'dwell is a positive constant');
    assert.ok(Number.isFinite(SLIDER_WHEEL_CHANGE_DELAY_MS) && SLIDER_WHEEL_CHANGE_DELAY_MS > 0);
});

// ─── Wiring ───────────────────────────────────────────────────────────────

check(() => {
    const html = read('index.html');
    assert.match(html, /id="slider-wheel" checked/, 'the sidebar toggle exists and defaults ON');
    const options = html.slice(html.indexOf('id="mouse-wheel-zoom"'));
    assert.ok(options.indexOf('id="slider-wheel"') >= 0, 'it sits with the other wheel option');
});

check(() => {
    const ui = read('src/app/methods/ui-methods.js');
    assert.match(ui, /proto\._installSliderWheel = function/, 'the delegated handler is installed');
    assert.match(ui, /\{ passive: false, capture: true \}/, 'wheel listens capture-phase and can preventDefault');
    assert.match(ui, /if \(!this\.sliderWheel\) return;/, 'the setting gates the behavior');
    assert.match(ui, /SLIDER_WHEEL_DWELL_MS/, 'the dwell constant gates the grab');
    assert.match(ui, /new Event\('input', \{ bubbles: true \}\)/, "each tick fires 'input'");
    assert.match(ui, /new Event\('change', \{ bubbles: true \}\)/, "a pause fires 'change' for the expensive listeners");
});

check(() => {
    assert.match(read('src/app/viewer-app.js'), /this\.sliderWheel = true;/, 'default is ON');
    const session = read('src/app/methods/session-methods.js');
    assert.match(session, /sliderWheel: !!this\.sliderWheel,/, 'saved with the session');
    assert.match(session, /this\.sliderWheel = settings\.sliderWheel !== false;/, 'restored with default-ON semantics');
    assert.match(session, /checked\('#slider-wheel', this\.sliderWheel\);/, 'checkbox re-synced after restore');
});

check(() => {
    const translations = read('src/i18n/translations.js');
    assert.equal([...translations.matchAll(/sliderWheel:/g)].length, 4, 'label in all locales');
    assert.equal([...translations.matchAll(/sliderWheelTooltip:/g)].length, 4, 'tooltip in all locales');
});

console.log(`slider wheel: ${checks} checks passed`);
