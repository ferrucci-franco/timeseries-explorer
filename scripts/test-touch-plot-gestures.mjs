// Pan, zoom and reset, with fingers (#110).
//
// Plotly gives a plot one drag gesture or the other, never both. Measured on a
// touch context, before any of this:
//
//   dragmode 'zoom' (Plotly's default)   dragmode 'pan'
//     one finger   zooms a box             one finger   pans
//     pinch        zooms                   pinch        does nothing at all
//     two fingers  zoom (read as a pinch)  two fingers  pan by one of them
//
// Borrowing `pan` for the length of a touch (#160) got one finger panning and
// two fingers pinching — but only when the two landed together. A second
// finger arriving late found Plotly already panning from the first, and the
// two handlers fought over the same axes: no pinch, and a pan full of jumps.
//
// So the plot now owns the whole gesture and Plotly is never told a touch
// happened. What this pins is the arithmetic and the wiring; the hand-shaped
// cases — a late second finger, a lifted one, a cancelled one — were measured
// in a browser and are listed in the pull request.
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
    TOUCH_GESTURE_SLOP_PX,
    gestureCentre,
    movedBeyondSlop,
    touchGestureOwnsDrag,
} from '../src/utils/touch-plot-gestures.js';

// ── Whose gesture is it ─────────────────────────────────────────────────────
assert.equal(touchGestureOwnsDrag('zoom'), true, 'the box zoom is the default nobody chose');
assert.equal(touchGestureOwnsDrag(undefined), true, 'and a plot that says nothing is in it');
assert.equal(touchGestureOwnsDrag(''), true);
assert.equal(touchGestureOwnsDrag('pan'), true, 'panning is what a finger was going to do anyway');
assert.equal(touchGestureOwnsDrag('select'), false, 'a mode someone chose is not a gesture to overrule');
assert.equal(touchGestureOwnsDrag('lasso'), false);
assert.equal(touchGestureOwnsDrag('drawrect'), false);

// ── Where the hand is ───────────────────────────────────────────────────────
assert.deepEqual(gestureCentre([{ x: 10, y: 20 }]), { x: 10, y: 20 }, 'one finger is its own centre');
assert.deepEqual(gestureCentre([{ x: 0, y: 0 }, { x: 10, y: 20 }]), { x: 5, y: 10 }, 'two is the midpoint');
assert.equal(gestureCentre([]), null, 'no fingers, no gesture');
assert.equal(gestureCentre(null), null);
assert.equal(gestureCentre([{ x: NaN, y: 1 }]), null, 'and nothing useful comes of a bad point');

// ── A tap is not a drag ─────────────────────────────────────────────────────
assert.equal(TOUCH_GESTURE_SLOP_PX, 6);
assert.equal(movedBeyondSlop([{ x: 0, y: 0 }], [{ x: 3, y: 3 }]), false,
    'a tap is never perfectly still, and this one still becomes a click');
assert.equal(movedBeyondSlop([{ x: 0, y: 0 }], [{ x: 10, y: 0 }]), true);
assert.equal(movedBeyondSlop([{ x: 0, y: 0 }], [{ x: 0, y: -10 }]), true, 'either way, either axis');
assert.equal(movedBeyondSlop([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 130, y: 0 }]), true,
    'one finger spreading is the hand moving');
assert.equal(movedBeyondSlop([{ x: 0, y: 0 }], [{ x: 20, y: 0 }], 50), false, 'the slop is a parameter');
assert.equal(movedBeyondSlop(null, null), false);

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

// One finger is a pinch that does not spread: scale 1, same formula.
assert.deepEqual(panZoomRange([0, 10], 5, 0.5, 1), [0, 10], 'not moved, not scaled');
assert.deepEqual(panZoomRange([0, 10], 5, 0.25, 1), [2.5, 12.5],
    'the value the finger holds moved a quarter of the way in, so the view moved with it');
assert.deepEqual(panZoomRange([0, 10], 5, 0.5, 2), [2.5, 7.5], 'pinch about a still centre');
assert.deepEqual(panZoomRange([0, 10], 2, 0, 2), [2, 7], 'and a pinch that also slides');
assert.equal(panZoomRange([0, 10], 5, 0.5, 0), null, 'a scale of nothing is not a scale');

// ── Wired in once, for every plot the app makes ─────────────────────────────
const vendor = readFileSync(new URL('../src/vendor/plotly.js', import.meta.url), 'utf8');
assert.match(vendor, /Plotly\.newPlot = \(div, \.\.\.rest\) => nativeNewPlot\(div, \.\.\.rest\)\.then\(drawn => withTouchGestures\(drawn, div\)\);/,
    'a plot created with newPlot gets the gestures');
assert.match(vendor, /Plotly\.react = \(div, \.\.\.rest\) => nativeReact\(div, \.\.\.rest\)\.then\(drawn => withTouchGestures\(drawn, div\)\);/,
    'and so does a pane that only ever exists through react, which is how the analysis panes redraw');
assert.doesNotMatch(vendor, /dragmode/, 'nothing about the drag mode is written into a layout any more');

const installer = readFileSync(new URL('../src/ui/plot-touch-gestures.js', import.meta.url), 'utf8');
assert.match(installer, /if \(!div \|\| div\._touchGesturesInstalled \|\| !isTouchCapable\(\)\) return false;/,
    'installed once per plot, on any device that has a finger — a touch screen with a mouse has both');
assert.doesNotMatch(installer, /pointer: coarse/, 'which is the question the first attempt got wrong');
assert.doesNotMatch(installer, /dragmode = /,
    'and the second one borrowed a drag mode from Plotly, which is what the two handlers then fought over');
assert.match(installer, /const onPlotSurface = \(target\) => typeof target\?\.closest === 'function' && !!target\.closest\('\.draglayer'\);/,
    'only touches on the plot itself: the legend and the modebar keep their taps');
assert.match(installer, /\.filter\(touch => onPlotSurface\(touch\.target\)\)/,
    'a finger resting elsewhere on the page is not part of this gesture');
assert.match(installer, /\.slice\(0, 2\)/, 'and a third one — a palm on the bezel — is not either');
assert.match(installer, /gesture = baseline\(points, gesture\?\.moved \?\? false\);/,
    'a finger arriving starts the gesture again from where the plot is now, however late it is');
assert.match(installer, /if \(points\.length !== gesture\.points\.length\) \{ gesture = baseline\(points, gesture\.moved\); return; \}/,
    'and so does one leaving');
assert.match(installer, /gesture = points\.length \? baseline\(points, moved\) : null;/,
    'a cancelled touch leaves the rest of the hand on the glass');
assert.match(installer, /if \(!gesture\.moved && !movedBeyondSlop\(gesture\.points, points\)\) return;/,
    'a tap is left alone, so it still reaches Plotly as a click');
assert.match(installer, /const scales = points\.length === 2 \? pinchScales\(gesture\.points, points\) : \{ x: 1, y: 1 \};/,
    'one finger is the same arithmetic with nothing to scale');
assert.match(installer, /div\.addEventListener\('touchstart', onTouchStart, \{ capture: true, passive: false \}\);/,
    'in the capture phase, before Plotly sees any of it');
assert.match(installer, /put\('yaxis2', y2, gesture\.ranges\.y2, gesture\.anchors\.y2, scales\.y, true\);/,
    'the right-hand axis is under the same fingers as the left one');
assert.match(installer, /requestAnimationFrame\(apply\)/, 'and the plot is asked to redraw once a frame, not once an event');

// Something else on the plot can want the touch: a finger that landed on a
// measurement cursor is grabbing it (see methods/interaction-methods.js).
assert.match(installer, /if \(spokenFor\(div, event\)\) \{/, 'the plot asks before it pans');
assert.match(installer, /export function claimTouchGestures\(div, claim\) \{/,
    'and more than one thing can answer: the cursors and the analysis band are both drags of their own');
assert.match(installer, /const claims = div\._touchGestureClaims \|\| \(div\._touchGestureClaims = new Set\(\)\);/);
assert.match(installer, /claimed = true;/, 'and stands aside for the whole touch, not just its first event');
assert.match(installer, /if \(claimed\) return;/,
    'without stopping it: the drag that claimed it follows the finger on document listeners');
assert.match(installer, /if \(\(event\.touches\?\.length \|\| 0\) === 0\) claimed = false;/,
    'and takes it back when the last finger lifts');

// The hover label a tap leaves behind, which nothing on a touch screen ever
// clears, and which a redraw brings back in the middle of a gesture.
assert.match(installer, /div\.classList\.add\(GESTURE_CLASS\);/, 'a moving gesture hides the hover label');
assert.match(installer, /if \(moved\) plotly\.Fx\?\.unhover\?\.\(div\);/, 'and clears it when it is over');
assert.doesNotMatch(installer, /if \(!moved\) plotly/, 'a tap is left to put one there, which is how a finger reads a value');

// The browser must not be able to claim the gesture first: that is what made a
// late second finger arrive as a touchcancel instead of a pinch.
const content = readFileSync(new URL('../src/styles/content.css', import.meta.url), 'utf8');
assert.match(content, /\.js-plotly-plot \{\s+touch-action: none;/,
    'every plot tells the browser it has no gesture of its own here');
assert.match(content, /\.js-plotly-plot\.touch-gesture \.hoverlayer \{\s+display: none;/,
    'and hides the label left over from the last tap while it is being moved');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const line of translations.split('\n')) {
    if (!line.trim().startsWith('touchHintZoom:')) continue;
    assert.doesNotMatch(line, /zoom into a range|zoomer sur une plage|acercarte a un rango|zoomare su un intervallo/,
        'the hint no longer describes the gesture one finger used to have');
}

console.log('Touch plot-gesture checks passed.');
