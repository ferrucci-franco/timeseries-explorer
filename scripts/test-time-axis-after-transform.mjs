// The time-axis inspector after a file transform (#107).
//
// The dialog measured the file's stored time column and nothing else, so a
// reindex — which throws that column away and steps the axis by row — left the
// verdict unchanged: "irregular" over data no plot was drawing. The fix adds a
// second diagnostic for the axis the plots actually draw, shown only when the
// two disagree. Those two halves are what this covers:
//
//   1. the decision itself (timeAxisViewsDiffer), as pure data;
//   2. that the app is wired to it — the dialog, the panel, and the button that
//      opens them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeTimeAxisDiagnostics } from '../src/data/time-axis-diagnostics.js';
import {
    TIME_AXIS_VIEW_TOLERANCE,
    timeAxisViewsDiffer,
} from '../src/utils/time-axis-transform-view.js';

const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const SECONDS = { secondsPerUnit: 1, unitless: false };
const COUNTS = { secondsPerUnit: 1, unitless: true };

// ── 1. The shape the issue was reported on ───────────────────────────────────
// An irregular recording — a nominal 0.1 s step with two samples missing — and
// the same file reindexed to a clean 10-minute row step.
const irregular = [0, 0.1, 0.2, 0.5, 0.6, 0.7, 1.2, 1.3];
const stored = computeTimeAxisDiagnostics(irregular, SECONDS);
assert.equal(stored.verdict, 'irregular', 'setup: the stored column is irregular');

const reindexed = irregular.map((_, row) => row * 600);
const plotted = computeTimeAxisDiagnostics(reindexed, SECONDS);
assert.equal(plotted.verdict, 'equidistant', 'setup: a row-stepped axis is equidistant');
assert.equal(plotted.dtMean, 600, 'setup: the reindexed step is the one that was asked for');

assert.equal(timeAxisViewsDiffer(stored, plotted), true,
    'a reindex that turns an irregular column into a clean step must be shown');

// ── 2. Transforms that change nothing a reader would notice ──────────────────
// A time offset moves every sample by the same amount: same count, same step,
// same span. Printing that twice is noise, so the second block stays closed.
const shifted = computeTimeAxisDiagnostics(irregular.map(t => t + 12345), SECONDS);
assert.equal(timeAxisViewsDiffer(stored, shifted), false,
    'a pure time offset must not open a second block');

// Numeric seconds promoted to a calendar: stored as epoch-ms, measured with a
// secondsPerUnit of 1e-3, so every figure comes back in the same seconds. The
// arithmetic differs ((t - origin) / 1000 against t * 1e-3), which is exactly
// why the comparison is relative rather than exact.
const originMs = Date.UTC(2026, 0, 1);
const asCalendar = computeTimeAxisDiagnostics(
    irregular.map(t => originMs + t * 1000), { secondsPerUnit: 1e-3, unitless: false });
assert.equal(timeAxisViewsDiffer(stored, asCalendar), false,
    'promoting numeric seconds to a calendar preserves every figure');

// And the tolerance is a tolerance, not a licence: a step that is a part per
// thousand off is a different axis.
const nudged = { ...stored, dtMedian: stored.dtMedian * 1.001 };
assert.equal(timeAxisViewsDiffer(stored, nudged), true,
    'a difference far above the tolerance must be reported');
const noise = { ...stored, dtMedian: stored.dtMedian * (1 + TIME_AXIS_VIEW_TOLERANCE / 100) };
assert.equal(timeAxisViewsDiffer(stored, noise), false,
    'float noise below the tolerance must not be reported');

// ── 3. The other things that make an axis a different axis ───────────────────
// A crop keeps the step and loses samples.
const cropped = computeTimeAxisDiagnostics(irregular.slice(0, 5), SECONDS);
assert.equal(timeAxisViewsDiffer(stored, cropped), true, 'a crop changes the sample count');

// A pure row index (0,1,2…) over a file whose seconds happened to be 0,1,2…
// reports the same numbers with a different meaning: counts, not seconds.
const oneSecond = [0, 1, 2, 3, 4];
const asSeconds = computeTimeAxisDiagnostics(oneSecond, SECONDS);
const asRows = computeTimeAxisDiagnostics(oneSecond, COUNTS);
assert.deepEqual(
    [asRows.dtMean, asRows.span], [asSeconds.dtMean, asSeconds.span],
    'setup: the figures really do coincide');
assert.equal(timeAxisViewsDiffer(asSeconds, asRows), true,
    'a count axis is not a seconds axis, whatever the figures say');

// "Not checked" is not zero: a null gap count against a counted zero is a
// difference worth showing, and must not throw on the null.
assert.equal(timeAxisViewsDiffer({ ...stored, gaps: null }, stored), true,
    'an unanswered check differs from an answered one');

// ── 4. Degenerate inputs ─────────────────────────────────────────────────────
assert.equal(timeAxisViewsDiffer(stored, null), false, 'no transformed axis, no second block');
assert.equal(timeAxisViewsDiffer(null, plotted), true, 'a transformed axis alone is worth showing');
const empty = computeTimeAxisDiagnostics([], SECONDS);
assert.equal(empty.verdict, null, 'setup: an empty axis has no verdict');
assert.equal(timeAxisViewsDiffer(empty, computeTimeAxisDiagnostics([], SECONDS)), false,
    'two empty axes agree — both NaN is not a disagreement');

// ── 5. The app is wired to all of it ─────────────────────────────────────────
const inspector = read('app/methods/time-axis-inspector-methods.js');

// The transformed block is measured off the axis the plots are handed, not off
// the stored column the rest of the file reads.
assert.match(inspector,
    /_transformedTimeAxisDiagnostics = function\(fileId\)[\s\S]*?_getTransformedTimeData\(fileId\)/,
    'the transformed diagnostics must read the transformed time data');
// Lazy files are excluded on purpose: an exact full-column verdict next to an
// overview-derived one invites a comparison that does not hold.
assert.match(inspector,
    /_transformedTimeAxisDiagnostics = function\(fileId\)[\s\S]*?data\._duckdb\) return null;/,
    'lazy files must not get a transformed block');
// A transform that cannot touch the axis must not cost a pass over it.
assert.match(inspector,
    /_transformedTimeAxisDiagnostics = function\(fileId\)[\s\S]*?_isFileTransformActive\(transform\)\) return null;/,
    'an untransformed file must not be measured twice');
// The cache key has to carry the fields the stored-column key leaves out, or a
// changed calendar origin would be served a stale block.
for (const field of ['timeStepOriginMode', 'timeStepOriginDate', 'numericTimeDisplay']) {
    assert.match(inspector,
        new RegExp(`_transformedTimeAxisKey = function\\(fileId\\)[\\s\\S]*?transform\\.${field}`),
        `the transformed cache key must include ${field}`);
}
// The dialog renders the second block, and says why it is there.
assert.match(inspector, /timeAxisViewsDiffer\(value, transformed\)/,
    'the dialog must ask whether the two axes differ');
assert.match(inspector, /timeAxisDiagHeadingPlotted/, 'the second block needs its own heading');
assert.match(inspector, /timeAxisDiagPlottedNote/, 'the second block needs its explanation');

// The panel prints one line normally and two once they diverge, each labelled.
assert.match(inspector,
    /_timeAxisPanelSummaryLines = function\(fileId\)[\s\S]*?timeAxisSummaryStoredPrefix[\s\S]*?timeAxisSummaryPlottedPrefix/,
    'the panel must label both summary lines');

const files = read('app/methods/file-methods.js');
assert.match(files, /_timeAxisPanelSummaryLines\?\.\(fileId\)/,
    'the file panel must render the summary lines through the pair');
assert.doesNotMatch(files, /_timeAxisSummaryLine\?\.\(this\._timeAxisDiagnosticsForPanel/,
    'the single-line summary must be gone');
// A transform change does not rebuild the sidebar, so without this the panel
// kept the pre-reindex verdict on screen — the bug as reported.
assert.match(files, /_updateFileTransform = function[\s\S]*?_refreshTimeAxisSummary\(fileId\)/,
    'a transform change must refresh the verdict lines');
assert.match(files, /_refreshTimeAxisSummary = function[\s\S]{0,600}?_appendTimeAxisSummaryLines\(fileId, panel, button\)/,
    'the refresh must re-insert the lines under the button');
assert.match(files, /panel\.dataset\.fileId = fileId;/,
    'the panel must be findable by file id for that refresh');

// ── 6. The button looks like a button ────────────────────────────────────────
const css = read('styles/content.css');
const rule = css.slice(css.indexOf('.file-transform-wide-action {'));
const body = rule.slice(0, rule.indexOf('}'));
assert.match(body, /text-align:\s*center;/, 'the label must be centred, not left-aligned like a caption');
assert.match(body, /font-weight:\s*600;/, 'the label must carry a button weight');
assert.match(css, /\.file-transform-wide-action:active/, 'a button presses');
assert.match(css, /\.file-transform-wide-action:focus-visible/, 'a button takes focus visibly');

// Every language answers for the new strings; the parity guard owns the rest.
const translations = read('i18n/translations.js');
for (const key of ['timeAxisDiagHeadingStored', 'timeAxisDiagHeadingPlotted', 'timeAxisDiagPlottedNote',
    'timeAxisSummaryStoredPrefix', 'timeAxisSummaryPlottedPrefix']) {
    assert.equal((translations.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 4,
        `${key} must exist in all four languages`);
}
assert.match(translations, /timeAxisSummaryStoredPrefix: '[^']*\{summary\}/,
    'the stored prefix must interpolate the summary');
assert.match(translations, /timeAxisSummaryPlottedPrefix: '[^']*\{summary\}/,
    'the plotted prefix must interpolate the summary');

console.log('Time-axis after-transform checks passed.');
