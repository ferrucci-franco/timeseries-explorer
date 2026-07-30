// Phone stage geometry and finger-gesture arithmetic.
//
// The two properties worth pinning down are that the fit really fits — the
// stage covers the screen exactly, in either orientation — and that a pinch
// leaves whatever is between the fingers where it was, on the page and on an
// axis alike. Everything else here guards the directions, which are easy to
// get backwards and impossible to notice without a phone in hand.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    DESIGN_WIDTH,
    MAX_ZOOM,
    clampStageView,
    composeStageMatrix,
    fitStageGeometry,
    invertPoint,
    isPhoneViewport,
    panStageView,
    screenDeltaToStage,
    screenPointToStage,
    setStageMatrix,
    resetStageMatrix,
    zoomStageView,
} from '../src/ui/viewport-transform.js';
import { computeTouchGesture, pinchAxes, transformRange } from '../src/plots/touch-gesture.js';

const close = (actual, expected, message, tolerance = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${message} (expected ${expected}, got ${actual})`);

const applyMatrix = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

// ─── Who gets the phone layout ───────────────────────────────────────────────

assert.equal(isPhoneViewport({ width: 844, height: 390, coarsePointer: true }), true,
    'a phone held sideways gets the stage');
assert.equal(isPhoneViewport({ width: 390, height: 844, coarsePointer: true }), true,
    'the same phone held upright gets the stage');
assert.equal(isPhoneViewport({ width: 1024, height: 744, coarsePointer: true }), false,
    'a tablet is wide enough for the desktop layout');
assert.equal(isPhoneViewport({ width: 390, height: 844, coarsePointer: false, maxTouchPoints: 0 }), false,
    'a narrow desktop window is not a phone');
assert.equal(isPhoneViewport({ width: 390, height: 844, coarsePointer: false, maxTouchPoints: 5 }), true,
    'a touchscreen that does not report a coarse pointer still counts');

// ─── Zoom to fit, in both orientations ───────────────────────────────────────

for (const [vw, vh, label] of [[844, 390, 'landscape'], [390, 844, 'portrait']]) {
    const geometry = fitStageGeometry(vw, vh);
    assert.equal(geometry.stageWidth, DESIGN_WIDTH, `${label}: the stage is laid out at the design width`);
    assert.equal(geometry.rotation, vh > vw ? 90 : 0,
        `${label}: the stage turns a quarter turn only when the phone is upright`);
    // The stage is always landscape-shaped: its long edge is the screen's long edge.
    close(geometry.stageWidth / geometry.stageHeight, Math.max(vw, vh) / Math.min(vw, vh),
        `${label}: the stage has the screen's aspect ratio`, 1e-12);

    const m = composeStageMatrix(geometry, { zoom: 1, panX: 0, panY: 0 });
    const corners = [[0, 0], [geometry.stageWidth, 0], [geometry.stageWidth, geometry.stageHeight], [0, geometry.stageHeight]]
        .map(([x, y]) => applyMatrix(m, x, y));
    const xs = corners.map(p => p.x);
    const ys = corners.map(p => p.y);
    // Fit means fit: no letterbox on either side, nothing off screen.
    close(Math.min(...xs), 0, `${label}: the stage starts at the left edge`, 1e-9);
    close(Math.max(...xs), vw, `${label}: the stage ends at the right edge`, 1e-9);
    close(Math.min(...ys), 0, `${label}: the stage starts at the top edge`, 1e-9);
    close(Math.max(...ys), vh, `${label}: the stage ends at the bottom edge`, 1e-9);

    // And the inverse really is the inverse, which is what the plot gestures
    // lean on to turn a finger position back into layout pixels.
    const back = invertPoint(m, vw / 3, vh / 4);
    const forth = applyMatrix(m, back.x, back.y);
    close(forth.x, vw / 3, `${label}: inverse round trip x`, 1e-9);
    close(forth.y, vh / 4, `${label}: inverse round trip y`, 1e-9);
}

// An on-screen keyboard can leave a visible strip that is wider than it is tall
// on a phone that is still upright. Orientation therefore comes from the caller,
// not from the box, or the app would un-rotate mid-keystroke.
{
    const keyboard = fitStageGeometry(402, 300, { portrait: true });
    assert.equal(keyboard.rotation, 90, 'an upright phone stays rotated while the keyboard is up');
    const m = composeStageMatrix(keyboard, { zoom: 1, panX: 0, panY: 0 });
    const corners = [[0, 0], [keyboard.stageWidth, 0], [keyboard.stageWidth, keyboard.stageHeight], [0, keyboard.stageHeight]]
        .map(([x, y]) => applyMatrix(m, x, y));
    close(Math.max(...corners.map(p => p.x)), 402, 'the squeezed stage still spans the visible width', 1e-9);
    close(Math.max(...corners.map(p => p.y)), 300, 'the squeezed stage still spans the visible height', 1e-9);
}

// A quarter turn has to swap the axes, or a pinch on a plot would zoom the
// wrong one the moment the phone is held upright.
{
    const portrait = fitStageGeometry(390, 844);
    setStageMatrix(composeStageMatrix(portrait, { zoom: 1, panX: 0, panY: 0 }));
    const moved = screenDeltaToStage(0, 100); // a finger sliding DOWN the upright phone
    close(moved.y, 0, 'a downward swipe does not move along the stage Y axis', 1e-9);
    assert.ok(moved.x > 0, 'a downward swipe moves along the stage X axis, left to right');
    resetStageMatrix();
    const identity = screenPointToStage(37, 11);
    close(identity.x, 37, 'off the phone stage the transform is the identity');
    close(identity.y, 11, 'off the phone stage the transform is the identity');
}

// ─── Pinching the page ───────────────────────────────────────────────────────

{
    const geometry = fitStageGeometry(844, 390);
    const fit = { zoom: 1, panX: 0, panY: 0 };

    // The point between the fingers stays under the fingers.
    const anchorX = 600;
    const anchorY = 200;
    const before = invertPoint(composeStageMatrix(geometry, fit), anchorX, anchorY);
    const zoomed = zoomStageView(fit, 2.5, anchorX, anchorY, geometry);
    const after = invertPoint(composeStageMatrix(geometry, zoomed), anchorX, anchorY);
    close(after.x, before.x, 'the pinch anchor does not slide horizontally', 1e-6);
    close(after.y, before.y, 'the pinch anchor does not slide vertically', 1e-6);

    assert.equal(clampStageView({ zoom: 0.4, panX: 0, panY: 0 }, geometry).zoom, 1,
        'zooming out past the fit is not allowed — the fit is the whole app');
    assert.equal(clampStageView({ zoom: 99, panX: 0, panY: 0 }, geometry).zoom, MAX_ZOOM,
        'the zoom is capped');

    // However hard the app is flicked, it cannot be dragged off the screen.
    const flung = panStageView({ zoom: 2, panX: 0, panY: 0 }, 5000, -5000, geometry);
    assert.equal(flung.panX, 0, 'panning right stops at the left edge of the app');
    assert.equal(flung.panY, -geometry.viewportHeight, 'panning up stops at the bottom edge of the app');
    const fitPan = panStageView({ zoom: 1, panX: 0, panY: 0 }, 120, 80, geometry);
    assert.deepEqual([fitPan.panX, fitPan.panY], [0, 0],
        'at the fit there is nothing off screen to pan to');
}

// ─── Fingers on a chart ──────────────────────────────────────────────────────

{
    const pan = computeTouchGesture([{ x: 100, y: 100 }], [{ x: 130, y: 80 }]);
    assert.equal(pan.kind, 'pan', 'one finger pans');
    assert.deepEqual([pan.dx, pan.dy, pan.scaleX, pan.scaleY], [30, -20, 1, 1],
        'one finger never zooms');

    // A horizontal pinch stretches time and leaves the amplitude alone.
    const horizontal = computeTouchGesture(
        [{ x: 100, y: 200 }, { x: 300, y: 205 }],
        [{ x: 50, y: 200 }, { x: 350, y: 205 }],
    );
    assert.equal(horizontal.kind, 'pinch', 'two fingers pinch');
    close(horizontal.scaleX, 1.5, 'the horizontal pinch zooms X');
    assert.equal(horizontal.scaleY, 1, 'the horizontal pinch leaves Y alone');
    close(horizontal.anchorX, 200, 'the pinch is anchored between the fingers');

    const vertical = computeTouchGesture(
        [{ x: 200, y: 100 }, { x: 203, y: 300 }],
        [{ x: 200, y: 150 }, { x: 203, y: 250 }],
    );
    assert.equal(vertical.scaleX, 1, 'the vertical pinch leaves X alone');
    close(vertical.scaleY, 0.5, 'the vertical pinch zooms Y out');

    // Fingers close together carry no per-axis meaning, so the pinch is uniform.
    const start = [{ x: 200, y: 200 }, { x: 210, y: 210 }];
    assert.deepEqual(pinchAxes(start), { x: false, y: false },
        'neither axis is separated enough to own the pinch');
    const uniform = computeTouchGesture(start, [{ x: 190, y: 190 }, { x: 220, y: 220 }]);
    close(uniform.scaleX, 3, 'the uniform fallback zooms X');
    close(uniform.scaleY, 3, 'the uniform fallback zooms Y by the same amount');

    // A pinch that also slides pans by the movement of its midpoint.
    const slid = computeTouchGesture(
        [{ x: 100, y: 200 }, { x: 300, y: 205 }],
        [{ x: 150, y: 210 }, { x: 350, y: 215 }],
    );
    close(slid.scaleX, 1, 'sliding both fingers together does not zoom');
    close(slid.dx, 50, 'the pan follows the midpoint');
    close(slid.dy, 10, 'the pan follows the midpoint');
}

// ─── Fingers to axis ranges ──────────────────────────────────────────────────

{
    const axis = { range: [0, 100], offset: 50, length: 200 };

    // Zooming in about a point keeps the value at that point put.
    const anchorPx = 150; // half way along the axis
    const zoomed = transformRange({ ...axis, anchorPx, scale: 2 });
    close(zoomed[1] - zoomed[0], 50, 'a 2x pinch halves the visible span');
    const valueAt = (range) => range[0] + ((anchorPx - axis.offset) / axis.length) * (range[1] - range[0]);
    close(valueAt(zoomed), valueAt(axis.range), 'the value under the fingers does not move');

    // Dragging right reveals earlier data, the way dragging a map does.
    const draggedRight = transformRange({ ...axis, anchorPx, scale: 1, panPx: 20 });
    close(draggedRight[0], -10, 'dragging right walks the window back in time');
    close(draggedRight[1], 90, 'dragging right walks the window back in time');

    // Y pixels grow downwards while Y values grow upwards.
    const draggedDown = transformRange({ ...axis, anchorPx: 150, scale: 1, panPx: 20, invert: true });
    close(draggedDown[0], 10, 'dragging down reveals higher values');
    const yZoom = transformRange({ range: [0, 100], offset: 0, length: 200, anchorPx: 0, scale: 2, invert: true });
    assert.deepEqual(yZoom, [50, 100], 'a Y pinch anchored at the top pins the top of the range');

    assert.equal(transformRange({ ...axis, length: 0, anchorPx, scale: 2 }), null,
        'an axis with no pixels is refused rather than producing infinities');
    assert.equal(transformRange({ range: [NaN, 1], offset: 0, length: 100, anchorPx: 0, scale: 2 }), null,
        'a non-numeric range is refused');
}

// ─── The wiring the arithmetic cannot check ──────────────────────────────────

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /<div id="app-stage">/, 'the stage wrapper exists');
assert.match(html, /<\/div><!-- \/#app-stage -->/, 'the stage wrapper is closed');
assert.ok(html.indexOf('<div id="app-stage">') < html.indexOf('<div class="top-bar">'),
    'the top bar is inside the stage');
assert.ok(html.indexOf('id="mobile-view-controls"') > html.indexOf('/#app-stage'),
    'the floating controls sit outside the stage so they keep their real size');
const viewportMeta = html.match(/<meta name="viewport"[^>]*>/)?.[0] ?? '';
assert.match(viewportMeta, /id="viewport-meta"/,
    'the viewport meta is addressable, so the phone stage can claim the zoom at runtime');
assert.doesNotMatch(viewportMeta, /user-scalable=no/,
    'the markup leaves the native pinch alone, so tablets and touch laptops keep it');

const css = await readFile(new URL('../src/styles/mobile.css', import.meta.url), 'utf8');
assert.match(css, /#app-stage\s*\{\s*display:\s*contents;/,
    'off the phone the stage is dissolved and the desktop layout is untouched');
assert.match(css, /html\.phone-stage \.js-plotly-plot\s*\{\s*touch-action:\s*none;/,
    'charts take their own touches instead of scrolling the page');

const index = await readFile(new URL('../src/styles/index.css', import.meta.url), 'utf8');
assert.match(index, /@import '\.\/mobile\.css';/, 'the phone stylesheet is imported');

// ─── The stage is the ruler, not the window ──────────────────────────────────
//
// Two whole classes of bug came from the same mistake: the stage lays the app
// out at 1152px, but `vw` and `@media (max-width: …)` both measure the PHONE.
// Under Safari's per-site page zoom the two differ by a factor of two.

const content = await readFile(new URL('../src/styles/content.css', import.meta.url), 'utf8');
const dropZoneRule = content.match(/\.drop-zone-content \{[^}]*\}/)?.[0] ?? '';
const noticeRule = content.match(/\n\.light-version-notice \{[^}]*\}/)?.[0] ?? '';
for (const [name, rule] of [['.drop-zone-content', dropZoneRule], ['.light-version-notice', noticeRule]]) {
    assert.ok(rule, `${name} rule found`);
    // These sit BESIDE the sidebar, so the window never subtracts its 320px and
    // they slid underneath it — on the phone stage and on any desktop window
    // below about 1240px alike.
    assert.doesNotMatch(rule, /100vw/,
        `${name} is sized against its container, not the window it does not fill`);
    assert.match(rule, /min\([^)]*100%\)|calc\(100% -/,
        `${name} measures the box it is actually in`);
}

const overlays = await readFile(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
const narrowBlock = overlays.match(/@media \(max-width: 768px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(narrowBlock, 'the narrow-window block is present');
assert.match(narrowBlock, /html:not\(\.phone-stage\) \.sidebar \{/,
    'the sidebar only becomes an overlay drawer off the phone stage — inside it there '
    + 'is a full 1152px of room, and the drawer covered the left third of the content');
// Still a drawer on a genuinely narrow desktop window, which is what it is for.
assert.match(narrowBlock, /position: absolute/, 'the drawer behaviour itself is untouched');

const touch = await readFile(new URL('../src/plots/methods/touch-methods.js', import.meta.url), 'utf8');
const touchListeners = touch.match(/addEventListener\('touch\w+'/g) || [];
assert.deepEqual(
    touchListeners.map(m => m.slice("addEventListener('".length, -1)).sort(),
    ['touchcancel', 'touchend', 'touchmove', 'touchstart'],
    'the whole touch lifecycle is handled, so a lifted or cancelled finger cannot strand a gesture');
// Capture, so the handler runs before Plotly's drag layer; non-passive, so it
// can preventDefault and stop the page scrolling under the finger.
assert.equal((touch.match(/\{ capture: true, passive: false \}/g) || []).length, touchListeners.length,
    'every touch listener is registered as capture + non-passive');
assert.match(touch, /_eventInsidePlotArea/,
    'touches outside the drawn area are left alone, so the modebar and legend still work');

const interaction = await readFile(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
assert.doesNotMatch(interaction, /const pixel = event\.clientX - rect\.left/,
    'screen positions go through the stage inverse, not a raw bounding rect');

const viewport = await readFile(new URL('../src/ui/mobile-viewport.js', import.meta.url), 'utf8');
assert.match(viewport, /document\.addEventListener\('touchmove'[\s\S]{0,80}passive: false/,
    'the page pinch listens on the bubble phase so plots can claim their touches first');
assert.match(viewport, /user-scalable=no/,
    'the native pinch is given up only once the phone stage is running');
assert.match(viewport, /visualViewport/,
    "the fit follows what is visible, not iOS's innerHeight behind an overlaying toolbar");
assert.match(viewport, /fullscreenAvailable\(\)/,
    'the fullscreen button is removed where the browser has no element fullscreen (iPhone)');
assert.match(viewport, /setProperty\('--app-vw'/,
    'the stage publishes its own width for in-stage layout to measure against');

assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/,
    'added to the home screen, iOS drops the toolbar that eats a landscape phone');

console.log('Mobile stage and touch gesture tests passed.');
