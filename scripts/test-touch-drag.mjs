// Using the app with a finger (#110).
//
// Two things were wrong, and the first one is the serious one: a left-to-right
// drag — exactly the shape of dragging a variable from the tree towards a
// panel — is the browser's "back" gesture on a touch screen. Measured before
// the fix: beforeunload, then about:blank, with every loaded file and panel
// gone. A single-page app with nothing to go back to has nothing to gain from
// that gesture and everything to lose.
//
// The second: `dragstart` is a mouse event and never fires for a touch, so the
// variable tree could put nothing on a panel at all. The gesture below is the
// one every touch list uses — hold to pick up, move to scroll.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    TOUCH_DRAG_HOLD_MS,
    TOUCH_DRAG_TOLERANCE_PX,
    createTouchDragGesture,
} from '../src/utils/touch-drag-gesture.js';

// ── Hold to pick up, move to scroll ─────────────────────────────────────────
{
    const g = createTouchDragGesture();
    assert.equal(g.state(), 'idle');
    assert.equal(g.start(100, 100), 'pressing');
    assert.equal(g.moved(104, 103), 'pressing', 'a finger never holds perfectly still');
    assert.equal(g.hold(), 'dragging', 'and after the hold it is a drag');
    assert.equal(g.moved(400, 300), 'dragging', 'which the rest of the gesture stays');
    assert.equal(g.end(), 'drop');
    assert.equal(g.state(), 'idle', 'and it is over');
}
{
    const g = createTouchDragGesture();
    g.start(100, 100);
    assert.equal(g.moved(100, 140), 'idle', 'a finger that leaves first was scrolling');
    assert.equal(g.hold(), 'idle', 'and the hold timer that fires late finds nothing');
    assert.equal(g.end(), 'none');
}
{
    const g = createTouchDragGesture();
    g.start(10, 10);
    assert.equal(g.end(), 'tap', 'let go before the hold: that was a tap, and the click handler owns it');
}
{
    const g = createTouchDragGesture();
    g.start(10, 10);
    g.hold();
    assert.equal(g.cancel(), 'idle', 'a second finger, a phone call: the drag lets go');
    assert.equal(g.end(), 'none');
}
{
    // The threshold is a distance, not a direction: a horizontal escape is a
    // scroll attempt too (and, before the CSS fix, a page navigation).
    const g = createTouchDragGesture();
    g.start(0, 0);
    assert.equal(g.moved(TOUCH_DRAG_TOLERANCE_PX - 1, 0), 'pressing');
    assert.equal(g.moved(TOUCH_DRAG_TOLERANCE_PX + 1, 0), 'idle');
}
{
    const g = createTouchDragGesture({ holdMs: 900, tolerancePx: 2 });
    assert.equal(g.holdMs, 900, 'the caller owns the timer, so it is told how long');
    g.start(0, 0);
    assert.equal(g.moved(3, 0), 'idle', 'and the tolerance');
}
assert.ok(TOUCH_DRAG_HOLD_MS >= 250 && TOUCH_DRAG_HOLD_MS <= 600,
    'long enough not to fire on a flick, short enough not to feel stuck');

// ── The page no longer walks away ───────────────────────────────────────────
const base = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
assert.match(base, /html, body \{\s*\n\s*overscroll-behavior: none;/,
    'the swipe-to-go-back gesture is refused, or a drag towards a panel takes the app with it');
const overlays = readFileSync(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
assert.match(overlays, /\.tree-item \{\s*\n\s*touch-action: pan-y;/,
    'the tree scrolls vertically and does nothing horizontally');
assert.match(overlays, /\.touch-drag-chip \{/, 'the finger carries something it can see');
assert.match(overlays, /transform: translate\(-50%, calc\(-100% - 14px\)\);/,
    'shown above the touch point, not under the finger holding it');

// ── Wired into the tree and the panels ──────────────────────────────────────
const tree = readFileSync(new URL('../src/app/methods/tree-methods.js', import.meta.url), 'utf8');
assert.match(tree, /if \(isTouchCapable\(\)\) \{\s*\n\s*installTouchDragSource\(itemDiv, \{/,
    'every tree item is draggable by touch as well as by mouse');
assert.match(tree, /payload: \(\) => \{[\s\S]{0,400}?this\._selectedVariableNamesForDrag\(variable\.name\)/,
    'and a finger drags the whole selection, exactly as the mouse does');

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
assert.match(manager, /panelEl\._dropHint = \{ show: showDragHint, hide: hideDragHint \};/,
    'the touch drag shows the panel the same hint a mouse drag does');
assert.match(manager, /dropVariablesAtPoint\(payload, point\) \{/, 'and drops through the same path');
assert.match(manager, /this\._handleVariableDrop\(over\.panelId, names, over\.panelEl, \{ axis, fileId \}\);/,
    'which is the mouse path, from the hit test on');
assert.match(manager, /_panelAtPoint\(point\) \{[\s\S]{0,400}?closest\?\.\('\.layout-panel'\)/,
    'a finger knows only where it is, so the panel is found from the point');

const touchDrag = readFileSync(new URL('../src/ui/touch-drag.js', import.meta.url), 'utf8');
assert.match(touchDrag, /element\.addEventListener\('touchmove', onTouchMove, \{ passive: false \}\);/,
    'the move listener can preventDefault, or the page scrolls under the drag');
assert.match(touchDrag, /if \(event\.touches\.length !== 1\) \{ stop\(\); return; \}/,
    'a second finger means the user is doing something else');
assert.match(touchDrag, /if \(chip\) chip\.style\.visibility = 'hidden';/,
    'the chip steps out of its own hit test');

// ── Said once, to the devices it is for ─────────────────────────────────────
const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
assert.match(ui, /proto\._showTouchHintIfNeeded = function\(\) \{/);
assert.match(ui, /matchMedia\?\.\('\(pointer: coarse\)'\)\?\.matches\) return;/,
    'a laptop with a touch screen has a mouse too, and knows all of this');
assert.match(ui, /getItem\(TOUCH_HINT_KEY\) === '1'/, 'and it is said once');
const app = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
assert.match(app, /this\._showTouchHintIfNeeded\?\.\(\)/, 'on startup');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['touchHintTitle', 'touchHintDrag', 'touchHintZoom', 'touchHintReset']) {
    assert.equal([...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

console.log('Touch-drag checks passed.');
