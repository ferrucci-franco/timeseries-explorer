// The A and B tabs of the measurement cursors on the phone layout.
import assert from 'node:assert/strict';

import { CURSOR_HANDLE_REACH, CURSOR_HANDLE_SIZE, cursorHandleAt, cursorHandleLayout } from '../src/utils/cursor-handles.js';

const area = { left: 50, right: 350, bottom: 300 };

// ── Each tab at the foot of its line ────────────────────────────────────────
{
    const tabs = cursorHandleLayout({ ...area, a: 100, b: 250 });
    assert.deepEqual(tabs.map(t => [t.which, t.x, t.side]), [['a', 100, null], ['b', 250, null]]);
    assert.equal(tabs[0].y, tabs[1].y, 'apart, the two tabs share a row');
    assert.ok(tabs[0].y + CURSOR_HANDLE_SIZE / 2 <= area.bottom, 'inside the plotting area, above the X axis');
}

// ── Close together, B goes one row up instead of covering A ──────────────────
{
    const tabs = cursorHandleLayout({ ...area, a: 200, b: 210 });
    const [a, b] = tabs;
    assert.ok(b.y < a.y, 'B is above A');
    assert.ok(a.y - b.y >= CURSOR_HANDLE_SIZE, 'and clear of it');
    // A finger on each tab finds that tab.
    assert.equal(cursorHandleAt(tabs, a.x, a.y)?.which, 'a');
    assert.equal(cursorHandleAt(tabs, b.x, b.y)?.which, 'b');
}

// ── A cursor off screen waits at the edge it went past ─────────────────────
{
    const tabs = cursorHandleLayout({ ...area, a: -400, b: 900 });
    const [a, b] = tabs;
    assert.equal(a.side, 'left');
    assert.equal(b.side, 'right');
    assert.ok(a.x > area.left && a.x < area.left + CURSOR_HANDLE_SIZE, 'A just inside the left edge');
    assert.ok(b.x < area.right && b.x > area.right - CURSOR_HANDLE_SIZE, 'B just inside the right edge');
    // Both past the same edge: stacked, not on top of each other.
    const same = cursorHandleLayout({ ...area, a: 10, b: 20 });
    assert.equal(same[0].side, 'left');
    assert.equal(same[1].side, 'left');
    assert.notEqual(same[0].y, same[1].y);
}

// ── A tab does not cover the dot that reads its curve ──────────────────────
{
    const [plain] = cursorHandleLayout({ ...area, a: 100, b: 250 });
    // The curve along the bottom, as a spectrum's floor is: the dot sits on the tab's row.
    const [a, b] = cursorHandleLayout({ ...area, top: 20, a: 100, b: 250, dotA: plain.y + 4, dotB: 120 });
    assert.ok(a.y + CURSOR_HANDLE_SIZE / 2 < plain.y + 4 - 8, 'A’s tab moves up, clear of its dot');
    assert.equal(b.y, plain.y, 'B, whose dot is high on the plot, stays at the foot');
    // Both dots low and close together: the tabs still do not cover each other.
    const close = cursorHandleLayout({ ...area, top: 20, a: 200, b: 210, dotA: plain.y, dotB: plain.y });
    assert.ok(Math.abs(close[0].y - close[1].y) >= CURSOR_HANDLE_SIZE, 'stacked, not on top of each other');
    // Never above the plotting area.
    const [high] = cursorHandleLayout({ left: 50, right: 350, top: 250, bottom: 300, a: 100, b: NaN, dotA: 282 });
    assert.ok(high.y >= 250 + CURSOR_HANDLE_SIZE / 2, 'kept inside the plot');
    // An edge tab has no dot to avoid.
    const [edge] = cursorHandleLayout({ ...area, a: -50, b: NaN, dotA: plain.y });
    assert.equal(edge.y, plain.y);
}

// ── A cursor without a position has no tab ──────────────────────────────────
assert.deepEqual(cursorHandleLayout({ ...area, a: NaN, b: 120 }).map(t => t.which), ['b']);
assert.deepEqual(cursorHandleLayout({ left: NaN, right: 10, bottom: 10, a: 1, b: 2 }), []);
assert.deepEqual(cursorHandleLayout({ left: 100, right: 100, bottom: 10, a: 1, b: 2 }), [], 'no plotting area, no tabs');

// ── The reach is a finger's, around the tab ─────────────────────────────────
{
    const tabs = cursorHandleLayout({ ...area, a: 100, b: 250 });
    const a = tabs[0];
    assert.equal(cursorHandleAt(tabs, a.x + CURSOR_HANDLE_REACH, a.y)?.which, 'a', 'the edge of a 44 px target');
    assert.equal(cursorHandleAt(tabs, a.x + CURSOR_HANDLE_REACH + 1, a.y), null, 'just past it, nothing');
    assert.equal(cursorHandleAt(tabs, a.x, a.y - CURSOR_HANDLE_REACH - 1), null, 'above the tab, the plot pans as usual');
    assert.equal(cursorHandleAt(tabs, NaN, 0), null);
    assert.equal(cursorHandleAt(null, 1, 1), null);
}

console.log('cursor handles: ok');
