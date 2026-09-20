// Pan, zoom and reset, with fingers (#110 follow-up).
//
// Plotly gives a touch screen one gesture or the other, never both. Measured
// on a touch context, before any of this:
//
//   dragmode 'zoom' (Plotly's default)   dragmode 'pan'
//     one finger   zooms a box             one finger   pans
//     pinch        zooms                   pinch        does nothing at all
//     two fingers  zoom (read as a pinch)  two fingers  pan by one of them
//
// So the app asks for `pan`, which is the gesture with no alternative, and
// brings the pinch itself. The arithmetic of that pinch is what this pins.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    PINCH_MAX_GESTURE_SCALE,
    PINCH_MIN_SEPARATION_PX,
    panZoomRange,
    pinchScales,
    zoomRangeAbout,
} from '../src/utils/pinch-zoom.js';
import {
    TOUCH_DRAG_MODE,
    prefersTouchGestures,
    withTouchDragMode,
} from '../src/utils/touch-plot-gestures.js';

// ── Who gets the touch drag mode ────────────────────────────────────────────
const win = (maxTouchPoints, coarse) => ({
    navigator: { maxTouchPoints },
    matchMedia: (query) => ({ matches: query === '(pointer: coarse)' ? coarse : false }),
});
assert.equal(prefersTouchGestures(win(5, true)), true, 'a tablet');
assert.equal(prefersTouchGestures(win(5, false)), false,
    'a laptop with a touch screen has a pointer too, and the zoom box is worth more to it');
assert.equal(prefersTouchGestures(win(0, true)), false, 'no touch, no touch gestures');
assert.equal(prefersTouchGestures(null), false, 'and no window, no answer');

assert.deepEqual(withTouchDragMode({ title: 'x' }, true), { title: 'x', dragmode: TOUCH_DRAG_MODE });
assert.equal(TOUCH_DRAG_MODE, 'pan', 'because panning is the gesture with no alternative');
assert.deepEqual(withTouchDragMode({ title: 'x' }, false), { title: 'x' }, 'a mouse keeps the zoom box');
assert.deepEqual(withTouchDragMode({ dragmode: 'select' }, true), { dragmode: 'select' },
    'a layout that asked for something keeps it');
assert.equal(withTouchDragMode(null, true), null);

// ── How far the fingers spread ──────────────────────────────────────────────
const pair = (ax, ay, bx, by) => [{ x: ax, y: ay }, { x: bx, y: by }];
{
    // Horizontal spread: x zooms, y says nothing (the fingers are level).
    const scales = pinchScales(pair(100, 300, 200, 300), pair(50, 300, 250, 300));
    assert.equal(scales.x, 2, '100 px apart to 200 is twice as close a look');
    assert.equal(scales.y, null, 'and the amplitude axis was never part of the gesture');
}
{
    const scales = pinchScales(pair(100, 200, 100, 400), pair(100, 100, 100, 500));
    assert.equal(scales.y, 2, 'the same, the other way round');
    assert.equal(scales.x, null);
}
{
    const scales = pinchScales(pair(100, 100, 200, 200), pair(50, 50, 250, 250));
    assert.equal(scales.x, 2, 'a diagonal pinch is both');
    assert.equal(scales.y, 2);
}
{
    // Two fingers moving together, not spreading: no zoom — but the caller
    // still pans by the anchor, which is the gesture every map has.
    const scales = pinchScales(pair(100, 300, 200, 300), pair(200, 300, 300, 300));
    assert.equal(scales.x, 1, 'the separation did not change');
}
assert.equal(pinchScales(pair(0, 0, PINCH_MIN_SEPARATION_PX - 1, 0), pair(0, 0, 200, 0)).x, null,
    'two fingers side by side say nothing about that axis, whatever they do next');
assert.equal(pinchScales(pair(0, 0, 200, 0), pair(0, 0, PINCH_MIN_SEPARATION_PX - 1, 0)).x, null,
    'and neither does a pinch that closes to nothing');
assert.equal(pinchScales(pair(0, 0, 30, 0), pair(0, 0, 30000, 0)).x, PINCH_MAX_GESTURE_SCALE,
    'nonsense input is bounded');
assert.deepEqual(pinchScales(null, null), { x: null, y: null });

// ── Where the range ends up ─────────────────────────────────────────────────
assert.deepEqual(zoomRangeAbout([0, 10], 5, 2), [2.5, 7.5], 'zoom in about the middle');
assert.deepEqual(zoomRangeAbout([0, 10], 0, 2), [0, 5], 'about the left edge, which stays put');
assert.deepEqual(zoomRangeAbout([0, 10], 5, 0.5), [-5, 15], 'and out again');
assert.equal(zoomRangeAbout([5, 5], 5, 2), null, 'a range of no width has nothing to scale');
assert.equal(zoomRangeAbout([0, 10], NaN, 2), null);

// The anchor is the whole feel of it: what the fingers came down on stays
// under them as they move.
assert.deepEqual(panZoomRange([0, 10], 5, 0.5, 1), [0, 10], 'not moved, not scaled');
assert.deepEqual(panZoomRange([0, 10], 5, 0.25, 1), [2.5, 12.5],
    'the value the fingers hold moved a quarter of the way in, so the view moved with it');
assert.deepEqual(panZoomRange([0, 10], 5, 0.5, 2), [2.5, 7.5], 'pinch about a still centre');
assert.deepEqual(panZoomRange([0, 10], 2, 0, 2), [2, 7], 'and a pinch that also slides');
assert.equal(panZoomRange([0, 10], 5, 0.5, 0), null, 'a scale of nothing is not a scale');

// ── Wired in once, for every plot the app makes ─────────────────────────────
const vendor = readFileSync(new URL('../src/vendor/plotly.js', import.meta.url), 'utf8');
assert.match(vendor, /nativeNewPlot\(div, traces, withTouchDragMode\(layout\), config\)/,
    'every plot is created with the drag mode its device needs');
assert.match(vendor, /installPinchZoom\(graphDiv \|\| div, Plotly\);/, 'and with the pinch Plotly does not have');

const installer = readFileSync(new URL('../src/ui/plot-pinch-zoom.js', import.meta.url), 'utf8');
assert.match(installer, /if \(!div \|\| div\._pinchZoomInstalled \|\| !prefersTouchGestures\(\)\) return false;/,
    'installed once per plot, and only where a finger is the pointer');
assert.match(installer, /div\.addEventListener\('touchstart', onTouchStart, \{ capture: true, passive: false \}\);/,
    'in the capture phase, before Plotly sees the second finger');
assert.match(installer, /event\.stopPropagation\(\);/, 'so the pan it started does not continue underneath');
assert.match(installer, /put\('yaxis2', y2, start\.ranges\.y2, start\.anchors\.y2, scales\.y, true\);/,
    'the right-hand axis is under the same fingers as the left one');
assert.match(installer, /axisValueAt\(y, centreY, rect, true\)/,
    'a y pixel is measured from the top of the plot, not its left edge');
assert.match(installer, /requestAnimationFrame\(apply\)/, 'and the plot is asked to redraw once a frame, not once an event');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const line of translations.split('\n')) {
    if (!line.trim().startsWith('touchHintZoom:')) continue;
    assert.doesNotMatch(line, /zoom into a range|zoomer sur une plage|acercarte a un rango|zoomare su un intervallo/,
        'the hint no longer describes the gesture one finger used to have');
}

console.log('Touch plot-gesture checks passed.');
