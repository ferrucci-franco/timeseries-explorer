// The A|B cursors on the spectrum pane, on both readings of its x axis (#108).
//
// The period axis is logarithmic, and three readers in the cursor code took
// what the layout reports for what the data is:
//
//   * the hit test worked its tolerance out from the range SPAN — on a period
//     axis, the span of its logarithms. 0.0221 "seconds" against a cursor at
//     927000 s, where one pixel was worth 6010 s: the cursor could not be
//     grabbed at all;
//   * the travel limits came from the DRAWN series, which is windowed to what
//     is on screen and rebuilt a frame late. Right after a switch of reading
//     it still held the other axis's numbers, and clamping 12.5 Hz and 37.5 Hz
//     to it put both cursors on 1.07 Hz;
//   * the view bounds overlapped data in seconds with a range in log10.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const interaction = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
const fft = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');

const sliceProto = (source, marker) => {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `${marker} is present`);
    const end = source.indexOf('\nproto.', start + marker.length);
    return source.slice(start, end >= 0 ? end : source.length);
};

// ── A range in the units the data is in ─────────────────────────────────────
const context = { proto: {} };
vm.runInNewContext(sliceProto(interaction, 'proto._axisDataRange = function'), context);
const host = {
    _axisDataRange: context.proto._axisDataRange,
    _coerceAxisValue: (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : NaN;
    },
};
// Spread before comparing: what comes back was made in the sandbox, and its
// prototype is that context's, not this one's.
const dataRange = (axis) => {
    const range = host._axisDataRange(axis);
    return range ? [...range] : range;
};
assert.deepEqual(dataRange({ range: [0, 50] }), [0, 50], 'a linear axis says what it means');
assert.deepEqual(dataRange({ type: 'linear', range: [1, 2] }), [1, 2]);
{
    const [lo, hi] = dataRange({ type: 'log', range: [Math.log10(40000), Math.log10(200000)] });
    assert.ok(Math.abs(lo - 40000) < 1e-6 && Math.abs(hi - 200000) < 1e-6,
        'and a log axis reports 4.6 to 5.3 for a window of 40 ks to 200 ks');
}
assert.equal(dataRange({ range: ['x', 2] }), null);
assert.equal(dataRange(null), null);

// ── How far a spectrum cursor may travel ────────────────────────────────────
const bounds = { proto: {} };
const periodExtentStart = fft.indexOf('function periodExtentOf(frequencies) {');
assert.ok(periodExtentStart >= 0);
const periodExtentEnd = fft.indexOf('\n}', periodExtentStart) + 2;
vm.runInNewContext(fft.slice(periodExtentStart, periodExtentEnd), bounds);
vm.runInNewContext(sliceProto(fft, 'proto._fftSpectrumCursorBounds = function'), bounds);

const frequencies = Float64Array.from([0, 0.5, 1, 2, 4]);
const plot = { _fftSpectraFull: [{ name: 'signal', frequencies }] };
const trace = { varName: 'signal', fileId: 'f1' };
const stub = (period) => ({
    _fftSpectrumCursorBounds: bounds.proto._fftSpectrumCursorBounds,
    _traceName: () => 'signal',
    _fftXAxisIsPeriod: () => period,
});
{
    const frequency = bounds.proto._fftSpectrumCursorBounds.call(stub(false), plot, trace);
    assert.deepEqual({ ...frequency }, { start: 0, end: 4 }, 'every bin, DC included, on a frequency axis');
}
{
    const period = bounds.proto._fftSpectrumCursorBounds.call(stub(true), plot, trace);
    assert.deepEqual({ ...period }, { start: 0.25, end: 2 },
        'and from the fastest bin to the slowest one above DC, on a period axis');
}
assert.equal(bounds.proto._fftSpectrumCursorBounds.call(stub(true), { _fftSpectraFull: [] }, trace), null,
    'nothing computed yet, nothing to clamp to — the caller keeps its own fallback');
assert.equal(bounds.proto._fftSpectrumCursorBounds.call(stub(true), plot, null), null);

// ── Wired in ────────────────────────────────────────────────────────────────
assert.match(interaction, /const full = this\._fftSpectrumCursorBounds\?\.\(view\.plot, trace\);/,
    'the whole spectrum, not the windowed slice that happens to be drawn');
assert.match(interaction, /const range = this\._axisDataRange\(this\._viewDiv\(view\)\?\._fullLayout\?\.xaxis\);/,
    'and a view range that has been brought back into data units');
assert.match(interaction, /const pointer = Number\(point\.clientX\) - div\.getBoundingClientRect\(\)\.left;/,
    'the hit test measures in pixels');
assert.match(interaction, /if \(Math\.min\(da, db\) > reachPx\) return null;/,
    'against the reach it was given, which was a number of pixels all along');
assert.doesNotMatch(interaction, /const tolerance = \(reachPx \/ xLen\) \* span;/,
    'and no longer scales it by a span whose units it cannot know');

console.log('Spectrum cursor checks passed.');
