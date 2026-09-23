// Document-level listeners a chart installs must go when the chart does.
//
//   node scripts/test-document-listener-cleanup.mjs
//
// Creating, editing or removing a variable rebuilds the panels that draw it,
// and every rebuild is a new chart. Handlers bound to `document` close over
// their chart, so one left behind keeps that discarded chart (its div, its
// state) alive for the rest of the session — one more per rebuild. Two did:
// the cursors' touch listeners, which _destroyChart swept only for the mouse,
// and the selection-band touch drag (_alsoDragWithTouch), which was never
// swept at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const interaction = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');

const slice = (source, marker, endMarker = '\n};') => {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `${marker.trim()} is present`);
    return source.slice(start, source.indexOf(endMarker, start) + endMarker.length);
};

// ── _alsoDragWithTouch replaces, never adds to, its document listeners ─────
{
    const listeners = new Map();
    const document = {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    };
    const sandbox = { document, proto: {}, claimTouchGestures() {}, pointerPoint: e => e };
    vm.runInNewContext([
        slice(interaction, 'proto._alsoDragWithTouch = function('),
        slice(interaction, 'proto._removeTouchDragDocListeners = function('),
    ].join('\n'), sandbox);
    const self = Object.assign(Object.create(null), sandbox.proto);
    const div = () => ({ addEventListener() {} });
    const handlers = { hitTest: () => false, onDown() {}, onMove() {}, onUp() {} };
    const count = () => ['touchmove', 'touchend', 'touchcancel']
        .reduce((n, type) => n + (listeners.get(type)?.size || 0), 0);

    const plot = {};
    self._alsoDragWithTouch(div(), plot, '_fftSelectionTouchDiv', handlers);
    assert.equal(count(), 3, 'one chart: its three touch listeners');
    for (let i = 0; i < 10; i++) self._alsoDragWithTouch(div(), plot, '_fftSelectionTouchDiv', handlers);
    assert.equal(count(), 3, 'ten rebuilds later: still only the current chart\'s three');

    const sameDiv = div();
    self._alsoDragWithTouch(sameDiv, plot, '_histSelectionTouchDiv', handlers);
    self._alsoDragWithTouch(sameDiv, plot, '_histSelectionTouchDiv', handlers);
    assert.equal(count(), 6, 'a second band on the same plot has its own; binding the same div twice adds nothing');

    self._removeTouchDragDocListeners(plot._touchDragDocListeners_fftSelectionTouchDiv);
    self._removeTouchDragDocListeners(plot._touchDragDocListeners_histSelectionTouchDiv);
    assert.equal(count(), 0, 'and what is recorded is exactly what can be taken off');
}

// ── _destroyChart sweeps all of them ───────────────────────────────────────
const destroy = slice(manager, '    _destroyChart(panelId) {', '\n    }\n');
for (const type of ['mousemove', 'mouseup', 'touchmove', 'touchend', 'touchcancel']) {
    assert.match(destroy, new RegExp(`document\\.removeEventListener\\('${type}',`),
        `a closed or rebuilt chart's cursor ${type} listener is removed`);
}
assert.match(destroy, /key\.startsWith\('_touchDragDocListeners'\)[\s\S]*?this\._removeTouchDragDocListeners\?\.\(plot\[key\]\)/,
    'and so are the selection-band touch listeners');

// Every document listener the cursor handlers add is one _destroyChart removes.
const cursorInstall = slice(interaction, 'proto._installCursorViewHandlers = function(');
const added = [...cursorInstall.matchAll(/document\.addEventListener\('(\w+)'/g)].map(m => m[1]);
const removed = new Set([...destroy.matchAll(/document\.removeEventListener\('(\w+)'/g)].map(m => m[1]));
for (const type of added) assert.ok(removed.has(type), `cursor '${type}' listener is removed on destroy`);

console.log('Document listener cleanup checks passed.');
