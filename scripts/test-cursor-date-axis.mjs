// Regression tests for the A|B cursors on a date axis (#176).
//
// 1. _axisPixelForValue asked Plotly's d2p for the pixel. On a date axis d2p
//    reads a number of ms as a JS Date in the browser's local zone, while the
//    app's times are floating (wall clock read as UTC): outside UTC the cursor
//    line landed hours away from its sample, and off-screen once zoomed in.
// 2. Turning cursors on picked the first traces in the legend. With one
//    variable continued across several files, those are files not on screen,
//    so the cursors were clamped off-screen. A and B must come from traces
//    with data in the current view.
//
// The methods are prototype functions in interaction-methods.js; we slice them
// out and run them against a mock `this`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../src/plots/methods/interaction-methods.js', import.meta.url),
    'utf8',
);
const sliceMethod = (marker) => {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `${marker} is present`);
    const end = source.indexOf('\nproto.', start + marker.length);
    return source.slice(start, end >= 0 ? end : source.length);
};

const proto = {};
for (const name of [
    '_axisPixelForValue', '_axisDataRange', '_coerceAxisValue',
    '_pickCursorTracesInView', '_sameCursorTrace',
]) {
    vm.runInNewContext(sliceMethod(`proto.${name} = function`), { proto });
}

// ── 1. Date axis: the pixel comes from the floating range, not local-zone d2p ─
{
    const t0 = Date.UTC(2026, 8, 1, 10, 0);
    const t1 = Date.UTC(2026, 8, 1, 11, 0);
    const threeHours = 3 * 3600 * 1000;
    const axis = {
        type: 'date',
        range: ['2026-09-01 10:00:00', '2026-09-01 11:00:00'],
        _offset: 50,
        _length: 440,
        // What Plotly does in UTC-3: the value is read three hours off.
        d2p: v => ((v - threeHours - t0) / (t1 - t0)) * 440,
    };
    const x = Date.UTC(2026, 8, 1, 10, 30);
    assert.equal(proto._axisPixelForValue.call(proto, axis, x), 50 + 220,
        'date axis: mid-range value is mid-axis, whatever the browser zone');
}

// ── Log axis still goes through d2p (#108) ──────────────────────────────────
{
    const axis = { type: 'log', range: [0, 2], _offset: 10, _length: 100, d2p: v => Math.log10(v) * 50 };
    assert.equal(proto._axisPixelForValue.call(proto, axis, 10), 10 + 50, 'log axis uses d2p');
}

// ── 2. Traces for A and B come from what is in view ─────────────────────────
function harness(traces, bounds, range) {
    const cursors = { enabled: true, a: null, b: null, traceA: null, traceB: null };
    const self = {
        ...proto,
        _viewDiv: () => ({ _fullLayout: { xaxis: { type: 'linear', range } } }),
        _viewCursors: () => cursors,
        _cursorTraceBounds: (_view, t) => bounds[t.fileId],
    };
    const view = { isSpectrum: false, plot: { traces } };
    return { self, view, cursors };
}
// The objects are built inside the vm context, with its own Object prototype.
const plain = o => (o ? { ...o } : o);
const files = { f1: { start: 0, end: 99 }, f2: { start: 100, end: 199 }, f3: { start: 200, end: 299 } };
const temp = ['f1', 'f2', 'f3'].map(fileId => ({ fileId, varName: 'temp' }));
const press = ['f1', 'f2', 'f3'].map(fileId => ({ fileId, varName: 'press' }));

{
    const { self, view, cursors } = harness(temp, files, [220, 280]);
    self._pickCursorTracesInView(view);
    assert.deepEqual(plain(cursors.traceA), { fileId: 'f3', varName: 'temp' }, 'A: the file on screen');
    assert.deepEqual(plain(cursors.traceB), { fileId: 'f3', varName: 'temp' }, 'B: the only trace on screen');
}
{
    const { self, view, cursors } = harness([...temp, ...press], files, [220, 280]);
    self._pickCursorTracesInView(view);
    assert.deepEqual(plain(cursors.traceA), { fileId: 'f3', varName: 'temp' });
    assert.deepEqual(plain(cursors.traceB), { fileId: 'f3', varName: 'press' }, 'B: another trace on screen');
}
{
    // A choice that is still on screen is kept; one that is not is replaced.
    const { self, view, cursors } = harness([...temp, ...press], files, [220, 280]);
    cursors.traceA = { fileId: 'f3', varName: 'press' };
    cursors.traceB = { fileId: 'f1', varName: 'temp' };
    self._pickCursorTracesInView(view);
    assert.deepEqual(plain(cursors.traceA), { fileId: 'f3', varName: 'press' }, 'kept');
    assert.deepEqual(plain(cursors.traceB), { fileId: 'f3', varName: 'temp' }, 'replaced by one in view');
}
{
    // A view straddling two files; hidden traces are never picked.
    const traces = temp.map(t => ({ ...t }));
    traces[0].visible = 'legendonly';
    const { self, view, cursors } = harness(traces, files, [50, 150]);
    self._pickCursorTracesInView(view);
    assert.deepEqual(plain(cursors.traceA), { fileId: 'f2', varName: 'temp' }, 'hidden f1 skipped');
}
{
    // Nothing in view: the choice is left alone.
    const { self, view, cursors } = harness(temp, files, [500, 600]);
    cursors.traceA = { fileId: 'f2', varName: 'temp' };
    self._pickCursorTracesInView(view);
    assert.deepEqual(plain(cursors.traceA), { fileId: 'f2', varName: 'temp' });
    assert.equal(cursors.traceB, null);
}

console.log('Cursor date-axis / in-view trace tests passed.');
