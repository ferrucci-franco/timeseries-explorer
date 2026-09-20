// The FFT picks the longest stretch with nothing missing in it (#59).
//
// One NaN, or one hole in the timestamps, makes the whole selection
// untransformable: the panel showed a warning and NO spectrum, leaving the user
// to hunt for a clean stretch by dragging the green handles. The panel already
// limits the range automatically when the transform would be SLOW; this is the
// same courtesy for the case where time is not the problem but missing data is.
//
// Two halves, tested separately:
//   1. the arithmetic — largestClearInterval, a pure function;
//   2. the panel method that calls it, sliced out of fft-methods.js (which
//      imports Plotly and so cannot be imported here) and run against a mock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { largestClearInterval } from '../src/utils/largest-clear-interval.js';

// ── 1. The arithmetic ────────────────────────────────────────────────────────
const span = { min: 0, max: 10 };

// Nothing blocking is NOT the same answer as nothing surviving, and the caller
// has to tell them apart: one means "leave the user's selection alone".
assert.deepEqual(largestClearInterval(span, []), { range: null, blockedCount: 0, blockedSpan: 0 });
assert.deepEqual(largestClearInterval(span, [{ t0: 0, t1: 10 }]),
    { range: null, blockedCount: 1, blockedSpan: 10 }, 'fully blocked still reports the block');

// The hole is the OPEN interval: t0 and t1 are the good samples around it, so
// both survive into the stretches on either side.
assert.deepEqual(largestClearInterval(span, [{ t0: 2, t1: 3 }]).range, [3, 10],
    'the longer side wins, and keeps the good sample at its edge');
assert.deepEqual(largestClearInterval(span, [{ t0: 8, t1: 9 }]).range, [0, 8]);

// Longest, not first.
assert.deepEqual(largestClearInterval(span, [{ t0: 1, t1: 2 }, { t0: 3, t1: 4 }]).range, [4, 10]);
assert.deepEqual(largestClearInterval(span, [{ t0: 6, t1: 7 }, { t0: 8, t1: 9 }]).range, [0, 6]);

// Several traces at once: the holes pool, and the complement of the union is
// the intersection of what each trace has. This IS the multi-curve rule.
assert.deepEqual(
    largestClearInterval(span, [{ t0: 1, t1: 2 }, { t0: 7, t1: 8 }]).range, [2, 7],
    'two traces with holes at either end leave the middle');

// Overlapping and touching holes merge; a touch leaves no stretch worth having.
assert.deepEqual(largestClearInterval(span, [{ t0: 1, t1: 5 }, { t0: 3, t1: 6 }]),
    { range: [6, 10], blockedCount: 1, blockedSpan: 5 }, 'overlaps merge into one');
assert.deepEqual(largestClearInterval(span, [{ t0: 1, t1: 3 }, { t0: 3, t1: 5 }]).blockedCount, 1,
    'holes meeting at one sample are one hole');

// Clipping: a hole that only reaches into the span counts for the part inside;
// one entirely outside counts for nothing. Touching an edge blocks nothing,
// because that edge is itself a good sample.
assert.deepEqual(largestClearInterval(span, [{ t0: -5, t1: 2 }]),
    { range: [2, 10], blockedCount: 1, blockedSpan: 2 }, 'a hole is clipped to the span');
assert.deepEqual(largestClearInterval(span, [{ t0: -5, t1: -1 }, { t0: 11, t1: 14 }]).blockedCount, 0,
    'holes outside the span are not holes');
assert.deepEqual(largestClearInterval(span, [{ t0: -5, t1: 0 }]).blockedCount, 0,
    'a hole ending exactly at the first sample blocks nothing');
assert.deepEqual(largestClearInterval(span, [{ t0: 10, t1: 14 }]).blockedCount, 0,
    'nor one starting exactly at the last');

// Degenerate inputs answer rather than throw.
for (const bad of [null, undefined, { min: 5, max: 5 }, { min: 10, max: 0 }, { min: NaN, max: 1 }]) {
    assert.deepEqual(largestClearInterval(bad, [{ t0: 1, t1: 2 }]).range, null, `refuses ${JSON.stringify(bad)}`);
}
assert.deepEqual(largestClearInterval(span, [{ t0: 3, t1: 3 }, { t0: 5, t1: NaN }, null]).blockedCount, 0,
    'zero-width and unusable holes are skipped');

// ── 2. The panel method ──────────────────────────────────────────────────────
const source = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');
const startMarker = 'proto._selectLargestCleanFftRange = function(plot, state, span) {';
const start = source.indexOf(startMarker);
assert.ok(start >= 0, '_selectLargestCleanFftRange is present');
// To its own closing brace at column zero — never to the name of whatever
// method happens to follow it.
const endMarker = '\n};';
const end = source.indexOf(endMarker, start);
assert.ok(end > start, 'method end located');
const methodText = source.slice(start, end + endMarker.length)
    .replace(startMarker, 'proto.select = function(plot, state, span) {');

const proto = {};
vm.runInNewContext(methodText, {
    proto,
    console,
    largestClearInterval,
    i18n: { t: key => `${key}: {samples} of {total}` },
});

// Times 0, 1, 2, … 99 — one per index, so a time IS its index and the
// bounds below read as the sample numbers they are.
const times = Float64Array.from({ length: 100 }, (_, i) => i);
const makeSpan = (from = 0, to = 100) => ({
    times,
    selectionStart: from,
    selectionEnd: to,
    lowerBound: value => {
        let i = 0;
        while (i < times.length && times[i] < value) i++;
        return i;
    },
    upperBound: value => {
        let i = 0;
        while (i < times.length && times[i] <= value) i++;
        return i;
    },
});
const makeHost = (intervalsByTrace, { skipScan = false } = {}) => ({
    select: proto.select,
    synced: 0,
    _fftShouldSkipGlobalGapScan: () => skipScan,
    _missingDataInfo: () => ({ traceIntervals: new Map(intervalsByTrace.map((v, i) => [String(i), v])) }),
    _syncFftOptionsPanel() { this.synced++; },
});
const freshState = () => ({ rangeFull: true, x1: null, x2: null, autoRangeLimited: false, autoRangeWarning: null });

// One trace with one hole: the longer side is selected and explained.
{
    const host = makeHost([[{ t0: 20, t1: 30 }]]);
    const state = freshState();
    assert.equal(host.select({}, state, makeSpan()), true, 'it reports having changed the range');
    assert.deepEqual([state.x1, state.x2], [30, 99], 'the longer side of the hole');
    assert.equal(state.rangeFull, false, 'the panel switches off "Full"');
    assert.equal(state.autoRangeFocusPending, true, 'and focuses, or the handles are unreachable');
    assert.match(state.autoRangeWarning, /^fftMissingDataRangeWarning: 70 of 100$/,
        'the warning names what was kept and out of how much');
    assert.equal(host.synced, 1, 'the options panel is told');
}

// The speed limiter's flag must stay off: this shortening is about validity,
// and setting it would make the panel go on tightening the range.
{
    const host = makeHost([[{ t0: 20, t1: 30 }]]);
    const state = freshState();
    host.select({}, state, makeSpan());
    assert.equal(state.autoRangeLimited, false, 'not a speed limit');
}

// Two traces: the stretch has to be clear for both.
{
    const host = makeHost([[{ t0: 10, t1: 15 }], [{ t0: 80, t1: 85 }]]);
    const state = freshState();
    assert.equal(host.select({}, state, makeSpan()), true);
    assert.deepEqual([state.x1, state.x2], [15, 80], 'the intersection of what each trace has');
}

// Nothing missing: the user's selection is not touched, and nothing is said.
{
    const host = makeHost([[]]);
    const state = freshState();
    assert.equal(host.select({}, state, makeSpan()), false);
    assert.deepEqual([state.rangeFull, state.x1, state.autoRangeWarning], [true, null, null],
        'a clean selection is left exactly as it was');
    assert.equal(host.synced, 0, 'and costs no re-render');
}

// Nothing survives: silence here, so the transform's own NaN warning is what
// the user reads. A two-sample selection would not be an improvement on it.
{
    const host = makeHost([[{ t0: 0, t1: 99 }]]);
    const state = freshState();
    assert.equal(host.select({}, state, makeSpan()), false);
    assert.equal(state.autoRangeWarning, null, 'no second warning over the real one');
}

// A hole outside the selected sub-range is not this selection's problem.
{
    const host = makeHost([[{ t0: 5, t1: 8 }]]);
    const state = freshState();
    assert.equal(host.select({}, state, makeSpan(40, 100)), false, 'a hole before the selection changes nothing');
}

// Too large to scan: the same guard the missing-data bands use. The issue set
// this case aside, and an O(n) pass over a multi-GB signal is why.
{
    const host = makeHost([[{ t0: 20, t1: 30 }]], { skipScan: true });
    const state = freshState();
    assert.equal(host.select({}, state, makeSpan()), false, 'a huge signal is not scanned');
    assert.equal(state.autoRangeWarning, null);
}

// A selection of fewer than two samples has no spectrum to save.
{
    const host = makeHost([[{ t0: 20, t1: 30 }]]);
    assert.equal(host.select({}, freshState(), makeSpan(10, 11)), false);
}

// ── 3. Wiring ────────────────────────────────────────────────────────────────
// It runs in the branch where the transform is NOT slow — the one that used to
// return without looking at the data at all.
assert.match(source,
    /const needsTighterPriorLimit[\s\S]{0,900}?if \(!needsInitialLimit && !needsTighterPriorLimit\) \{[\s\S]{0,400}?_selectLargestCleanFftRange\(/,
    'the fast path now looks for a clean stretch instead of returning');
assert.match(source, /_selectLargestCleanFftRange = function[\s\S]*?_fftShouldSkipGlobalGapScan\(plot\)\) return false;/,
    'and respects the large-signal guard');
assert.match(source, /_selectLargestCleanFftRange = function[\s\S]*?_missingDataInfo\(plot\)\.traceIntervals/,
    'reading the intervals the time pane already computes');
assert.doesNotMatch(source.slice(start, end), /autoRangeLimited\s*=/,
    'and never claims to be the speed limiter');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
assert.equal((translations.match(/\bfftMissingDataRangeWarning:/g) || []).length, 4,
    'the warning is translated in all four languages');
for (const match of translations.matchAll(/fftMissingDataRangeWarning: '([^']*)'/g)) {
    assert.ok(match[1].includes('{samples}') && match[1].includes('{total}'),
        'every translation interpolates both counts');
}

console.log('FFT clean-range checks passed.');
