// The A|B cursors, grabbed with a finger (#110).
//
// Everything about the measurement cursors was written for a mouse: a
// mousedown within five pixels of a line starts a drag, and document-level
// mousemove/mouseup carry it. On a touch screen none of that fires, so once
// the cursors were on there was no way to move them — and with the plot's own
// touch gestures in place, a finger that reached for one panned the plot
// instead.
//
// So the cursors take a touch as well, they ask for a wider reach because a
// finger hides the line it is reaching for, and they tell the plot's gesture
// handler that this particular touch is theirs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');

// ── The one thing a mouse and a finger disagree about: where they are ───────
const start = source.indexOf('const pointerPoint = (event) => {');
assert.ok(start >= 0, 'the helper is there');
const end = source.indexOf('};', start) + 2;
const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}; this.pointerPoint = pointerPoint;`, sandbox);
const { pointerPoint } = sandbox;

const mouse = { clientX: 12, clientY: 34, button: 0 };
// Spread before comparing: what comes back was made in the sandbox, and its
// prototype is that context's, not this one's.
const point = (event) => ({ ...pointerPoint(event) });
assert.equal(pointerPoint(mouse), mouse, 'a mouse event is already the point');
assert.deepEqual(point({ touches: [{ clientX: 5, clientY: 6 }] }), { clientX: 5, clientY: 6 },
    'a finger on the glass');
assert.deepEqual(point({ touches: [], changedTouches: [{ clientX: 7, clientY: 8 }] }), { clientX: 7, clientY: 8 },
    'and one that has just left it, which is all a touchend carries');
assert.deepEqual(point({ touches: [{ clientX: 1, clientY: 2 }, { clientX: 9, clientY: 9 }] }), { clientX: 1, clientY: 2 },
    'the first finger is the one dragging');

// ── A finger needs a wider reach than a mouse ───────────────────────────────
const grab = (name) => Number(source.match(new RegExp(`const ${name} = (\\d+);`))?.[1]);
assert.equal(grab('CURSOR_GRAB_PX'), 5, 'the mouse reach is what it always was');
assert.ok(grab('CURSOR_TOUCH_GRAB_PX') > grab('CURSOR_GRAB_PX') * 3,
    'a finger covers about forty pixels and hides the line it is reaching for');
assert.match(source, /const tolerance = \(reachPx \/ xLen\) \* span;/, 'and the hit test takes the reach it is given');

// ── The touch path ──────────────────────────────────────────────────────────
assert.match(source, /const hit = cursorNearPointer\(event, CURSOR_TOUCH_GRAB_PX\);/,
    'a touch is tested against the wider reach');
assert.match(source, /div\.addEventListener\('touchstart', \(event\) => \{/, 'a finger can start a cursor drag');
assert.match(source, /document\.addEventListener\('touchmove', onDocTouchMove, \{ passive: false \}\);/,
    'and carry it, without the page scrolling under it');
assert.match(source, /document\.addEventListener\('touchend',  onDocUp\);/, 'and end it');
assert.match(source, /document\.addEventListener\('touchcancel', onDocUp\);/,
    'including when the browser takes the finger back');
assert.match(source, /const x = this\._eventToXValue\(div, pointerPoint\(event\)\);/,
    'the x value comes from whichever kind of pointer it was');

// The claim: the plot's gesture handler asks before it pans (see
// ui/plot-touch-gestures.js).
assert.match(source, /div\._touchGestureClaim = \(event\) => !!dragging/,
    'a drag already under way keeps the touch, whatever else lands');
assert.match(source, /\|\| \(event\.touches\?\.length === 1 && !!cursorNearPointer\(event, CURSOR_TOUCH_GRAB_PX\)\);/,
    'and a first finger on a cursor claims it');

// Listeners are taken down with the ones that were always there.
assert.match(source, /document\.removeEventListener\('touchmove', plot\[docKey\]\.touchMove\);/,
    'a re-installed view leaves nothing behind');
assert.match(source, /document\.removeEventListener\('touchcancel', plot\[docKey\]\.up\);/);

// ── The readout box moves too ───────────────────────────────────────────────
assert.match(source, /box\.addEventListener\('touchstart', \(event\) => \{/, 'the box is dragged by its header');
assert.match(source, /const startBoxDrag = \(event, point\) => \{/, 'from either kind of pointer');
assert.match(source, /moveBox\(pointerPoint\(event\)\);/);

console.log('Cursor touch checks passed.');
