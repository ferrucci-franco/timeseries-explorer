// An analysis that picks its own range must leave that range usable.
//
// The regression this pins: on a ten-minute 44.1 kHz signal the automatic
// 262,144-sample block spans 5.94 s of a 600 s axis. Drawn on a 596 px pane
// that selection is 5.9 px wide, while the edge-grab tolerance is 12 px
// (histogram-methods.js). Both green edges then fall inside one tolerance
// window: neither can be picked up, and a drag starts a fresh selection
// instead. The range control stops working at exactly the moment the app
// chooses the range on the user's behalf.
//
// The fix is that the view follows the range. These checks hold the geometry
// to a width that stays draggable, and hold every panel to applying it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const dataMethods = read('src/plots/methods/data-methods.js');
const interaction = read('src/plots/methods/interaction-methods.js');

// ── The constants the geometry depends on ──────────────────────────────────
const paddingMatch = dataMethods.match(/^const ANALYSIS_FOCUS_PADDING = (\d+);$/m);
const minPxMatch = dataMethods.match(/^const ANALYSIS_MIN_SELECTION_PX = (\d+);$/m);
assert.ok(paddingMatch, 'data-methods declares ANALYSIS_FOCUS_PADDING');
assert.ok(minPxMatch, 'data-methods declares ANALYSIS_MIN_SELECTION_PX');
const ANALYSIS_FOCUS_PADDING = Number(paddingMatch[1]);
const ANALYSIS_MIN_SELECTION_PX = Number(minPxMatch[1]);

// The grab tolerance lives with the hit test. If it grows, the minimum width
// has to grow with it or this file silently stops protecting anything.
const toleranceMatch = read('src/plots/methods/histogram-methods.js')
    .match(/const tolerance = Math\.max\(\((\d+) \/ \(xa\?\._length \|\| 1\)\) \* span/);
assert.ok(toleranceMatch, 'histogram edge-grab tolerance can be read');
const EDGE_TOLERANCE_PX = Number(toleranceMatch[1]);
assert.ok(
    ANALYSIS_MIN_SELECTION_PX >= 4 * EDGE_TOLERANCE_PX,
    `minimum selection width (${ANALYSIS_MIN_SELECTION_PX}px) must stay at least 4x the `
    + `${EDGE_TOLERANCE_PX}px edge tolerance so both edges are separately grabbable`,
);

// ── The pure geometry ──────────────────────────────────────────────────────
const start = dataMethods.indexOf('proto._analysisFocusViewRange = function');
const end = dataMethods.indexOf('\nproto.', start + 1);
assert.ok(start >= 0 && end > start, 'focus-range helper can be isolated');
const focusProto = {};
vm.runInNewContext(dataMethods.slice(start, end), {
    proto: focusProto,
    ANALYSIS_FOCUS_PADDING,
});
const focusRange = focusProto._analysisFocusViewRange.bind({});

const widthPx = (selection, view, axisPx) =>
    ((selection[1] - selection[0]) / (view[1] - view[0])) * axisPx;

// The exact case from the bug report: 262,144 of 26,460,000 samples at
// 44.1 kHz, drawn on the pane width measured in the browser.
{
    const AXIS_PX = 596;
    const selection = [0, 5.944285714285714];
    const view = focusRange(selection[0], selection[1], 0, 600);
    assert.ok(view, 'a tiny selection inside a large domain yields a view');
    const px = widthPx(selection, view, AXIS_PX);
    assert.ok(
        px >= ANALYSIS_MIN_SELECTION_PX,
        `the automatic block must be at least ${ANALYSIS_MIN_SELECTION_PX}px wide, got ${px.toFixed(1)}px`,
    );
    // Without the focus it was 5.9px: prove the check would have caught it.
    assert.ok(widthPx(selection, [0, 600], AXIS_PX) < EDGE_TOLERANCE_PX,
        'the unfocused view is what this test exists to reject');
}

// The guarantee has to survive a narrow pane too, not just a wide one.
for (const axisPx of [320, 480, 596, 1200, 2400]) {
    const selection = [100, 100.001];
    const view = focusRange(selection[0], selection[1], 0, 86400);
    const px = widthPx(selection, view, axisPx);
    assert.ok(
        px >= ANALYSIS_MIN_SELECTION_PX,
        `selection must stay grabbable at ${axisPx}px pane width, got ${px.toFixed(1)}px`,
    );
}

// Padding is honoured exactly when there is room on both sides.
{
    const view = focusRange(500, 510, 0, 1000);
    assert.equal(view[1] - view[0], 10 * ANALYSIS_FOCUS_PADDING, 'view is padding x the selection');
    assert.ok(Math.abs((view[0] + view[1]) / 2 - 505) < 1e-9, 'view is centred on the selection');
}

// Clamped at a domain edge the window keeps its full width by growing inward,
// rather than being truncated into a narrower — and less grabbable — view.
for (const [lo, hi] of [[0, 10], [990, 1000]]) {
    const view = focusRange(lo, hi, 0, 1000);
    assert.equal(view[1] - view[0], 10 * ANALYSIS_FOCUS_PADDING, `width preserved at edge ${lo}-${hi}`);
    assert.ok(view[0] >= 0 && view[1] <= 1000, 'view stays inside the domain');
    assert.ok(view[0] <= lo && view[1] >= hi, 'view still contains the selection');
}

// A selection already covering (or exceeding) the domain just shows everything.
// Compared element-wise: the helper runs in a vm realm, so its arrays do not
// share this one's Array.prototype and deepEqual would reject them.
for (const [lo, hi] of [[0, 1000], [-50, 1200], [200, 900]]) {
    const view = focusRange(lo, hi, 0, 1000);
    assert.equal(view[0], 0, `full-domain selection ${lo}-${hi} starts at the domain`);
    assert.equal(view[1], 1000, `full-domain selection ${lo}-${hi} ends at the domain`);
}

// Degenerate input must not produce a view rather than produce a broken one.
for (const args of [[5, 5, 0, 10], [NaN, 1, 0, 10], [0, 1, 5, 5], [0, 1, NaN, 10]]) {
    assert.equal(focusRange(...args), null, `refuses degenerate input ${JSON.stringify(args)}`);
}

// ── Every panel must apply it ──────────────────────────────────────────────
// A helper nothing calls protects nothing.
const PANELS = [
    // FFT bounds its range through its own preflight, not the shared helper, so
    // it was the one panel the first version of this fix missed. It is listed
    // first as a reminder that "the analyses" is not the same set as "the
    // callers of _autoLimitAnalysisRange".
    ['fft', 'src/plots/methods/fft-methods.js'],
    ['histogram', 'src/plots/methods/histogram-methods.js'],
    ['heatmap', 'src/plots/methods/heatmap-methods.js'],
    ['temporal profile', 'src/plots/methods/temporal-profile-methods.js'],
    ['integral', 'src/plots/methods/integral-methods.js'],
    ['correlation', 'src/plots/methods/correlation-methods.js'],
    ['curve fit', 'src/plots/methods/phase2d-fit-methods.js'],
];
for (const [label, path] of PANELS) {
    const source = read(path);
    assert.match(
        source,
        /this\._applyPendingAnalysisFocus\(plot(?:, '[a-z2-]+')?\)/,
        `${label} must move its time view onto the range it analysed`,
    );
    // Applying the focus is only half of it: the flag has to be raised when the
    // panel is BUILT, not only when a pass cuts the range. Curve Fit applied it
    // and never raised it, so re-entering a fit whose range had been cut drew
    // that range a few pixels wide with both edges inside one grab tolerance.
    assert.match(
        source,
        /autoRangeFocusPending = true/,
        `${label} must claim its own opening view on every build`,
    );
    // And every panel consumes the session marker, even one that restores no
    // view. It lives on the plot, so a panel that leaves it set hands it to
    // whichever mode the user switches to next, suppressing that mode's
    // opening view for a restore this one already declined to honour.
    assert.match(
        source,
        /_consumeSessionViewRestore\(plot\)/,
        `${label} must consume the session-restore marker rather than pass it on`,
    );
}

// Every panel that can bound its own range must also be reachable by the
// applier: a mode missing from either lookup silently never focuses.
for (const mode of ['fft', 'histogram', 'heatmap', 'temporal-profile', 'integral', 'correlation', 'phase2d']) {
    assert.ok(
        new RegExp(`case '${mode}':`).test(dataMethods),
        `_analysisStateForMode must resolve '${mode}'`,
    );
    assert.ok(
        new RegExp(`case '${mode}':`).test(interaction),
        `_analysisTimeDomainForMode must resolve '${mode}'`,
    );
}

// FFT raises the flag in its own preflight rather than the shared limiter.
assert.match(
    read('src/plots/methods/fft-methods.js'),
    /state\.autoRangeLimited = true;[\s\S]{0,400}state\.autoRangeFocusPending = true;/,
    'the FFT preflight marks its automatic block for focusing',
);

// The flag has to be raised where the range is decided, in both directions:
// when the range is cut down, and when the measurement widens it back.
assert.match(
    dataMethods,
    /state\.autoRangeLimited = true;[\s\S]{0,400}state\.autoRangeFocusPending = true;/,
    'cutting the range marks the view for focusing',
);
assert.match(
    dataMethods,
    /state\.autoRangeLimited = false;[\s\S]{0,300}state\.autoRangeFocusPending = true;/,
    'widening the range back marks the view for re-opening',
);

// The applier must clear the flag before doing anything that can throw or
// bail, or a failed focus would retry on every later recompute.
{
    const applyStart = interaction.indexOf('proto._applyPendingAnalysisFocus = function');
    const applyEnd = interaction.indexOf('\nproto.', applyStart + 1);
    assert.ok(applyStart >= 0 && applyEnd > applyStart, 'focus applier can be isolated');
    const body = interaction.slice(applyStart, applyEnd);
    const clearAt = body.indexOf('autoRangeFocusPending = false');
    const relayoutAt = body.indexOf('Plotly.relayout');
    assert.ok(clearAt >= 0 && relayoutAt > clearAt, 'the pending flag is cleared before the relayout');
    assert.match(body, /state\.rangeFull\s*\n?\s*\?/, 'a whole range focuses on the whole domain');
}

console.log('Analysis selection usability checks passed.');
