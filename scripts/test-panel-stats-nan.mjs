// Panel statistics report how many samples are missing.
//
// The table used to answer Min/Max/Mean/RMS and say nothing about the holes
// behind them, so a signal whose mean came from a third of its samples looked
// exactly like one computed from all of them — and a variable that was missing
// end to end produced no row at all, because the old kernel returned null when
// nothing was finite. Both are covered here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { formatMissingCount, seriesStats } from '../src/utils/series-stats.js';
import translations from '../src/i18n/translations.js';

// ─── Nothing to describe ───────────────────────────────────────────
assert.equal(seriesStats(null), null, 'no series, no statistics');
assert.equal(seriesStats(undefined), null, 'no series, no statistics');
assert.equal(seriesStats([]), null, 'an empty series has nothing to report');

// ─── A clean series is unchanged by the new counting ───────────────
const clean = seriesStats([1, 2, 3]);
assert.equal(clean.min, 1);
assert.equal(clean.max, 3);
assert.equal(clean.mean, 2);
assert.ok(Math.abs(clean.rms - Math.sqrt(14 / 3)) < 1e-12, 'RMS is unchanged');
assert.equal(clean.missing, 0, 'nothing missing');
assert.equal(clean.total, 3);

// ─── Holes are counted, and still excluded from the statistics ─────
const holed = seriesStats([1, NaN, 3, NaN]);
assert.equal(holed.missing, 2, 'both NaN samples counted');
assert.equal(holed.total, 4, 'the count is over the whole record');
assert.equal(holed.min, 1, 'NaN does not become the minimum');
assert.equal(holed.max, 3, 'NaN does not become the maximum');
assert.equal(holed.mean, 2, 'the mean divides by the finite samples only');

// An out-of-range index reads back as undefined; that is a hole too.
assert.equal(seriesStats([1, undefined, 3]).missing, 1, 'undefined is a missing sample');

// Float64Array is what the readers actually hand over.
const typed = seriesStats(Float64Array.from([NaN, 4, 6]));
assert.equal(typed.missing, 1);
assert.equal(typed.mean, 5);

// ─── An all-NaN variable is a row, not a silence ───────────────────
const empty = seriesStats([NaN, NaN, NaN]);
assert.notEqual(empty, null, 'a fully missing variable must still produce a row');
assert.equal(empty.missing, 3);
assert.equal(empty.total, 3);
for (const field of ['min', 'max', 'mean', 'rms']) {
    assert.ok(Number.isNaN(empty[field]), `${field} is a gap, not a number invented from no samples`);
}

// ─── Infinity is a value the file contains, not a missing sample ───
const infinite = seriesStats([1, Infinity, -Infinity, 2]);
assert.equal(infinite.missing, 0, 'an infinity is not called NaN');
assert.equal(infinite.min, 1, 'an infinity never becomes the minimum');
assert.equal(infinite.max, 2, 'an infinity never becomes the maximum');
assert.equal(infinite.mean, 1.5, 'an infinity would swallow the mean, so it stays out');

// ─── How the count reads in the table ──────────────────────────────
assert.equal(formatMissingCount(0, 1000), '0', 'no holes reads as a bare zero');
assert.equal(formatMissingCount(12, 1000), '12 (1.2%)');
assert.equal(formatMissingCount(250, 1000), '250 (25%)');
assert.equal(formatMissingCount(1000, 1000), '1000 (100%)');
assert.equal(formatMissingCount(1, 1000), '1 (0.1%)');
// Rounding must never turn a real hole into "0%".
assert.equal(formatMissingCount(1, 100000), '1 (<0.1%)');
assert.equal(formatMissingCount(7, 0), '7', 'a share needs a total to be a share');

// ─── The dialog shows it ───────────────────────────────────────────
const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const start = manager.indexOf('_showPanelStats(panelId) {');
assert.ok(start >= 0, 'panel statistics should still be built here');
const dialog = manager.slice(start, manager.indexOf('\n    _', start + 10));

assert.match(dialog, /seriesStats\(this\._getTransformedVariableData\(fileId, varName\)\)/,
    'the panel must use the shared kernel, not its own copy');
assert.match(dialog, /formatMissingCount\(e\.missing, e\.total\)/, 'each row prints its missing count');
assert.match(dialog, /i18n\.t\('statsNaN'\)/, 'the column is headed by a translated key');
assert.match(dialog, /title="\$\{this\._escapeHTML\(i18n\.t\('statsNaNHint'\)\)\}"/,
    'the header explains what the count means');

// The header and the rows must keep the same number of columns.
// `<th ...>` only — `<thead>` is not a column.
const headers = dialog.match(/<th(?:\s[^>]*)?>/g) || [];
const cells = dialog.match(/<td>/g) || [];
assert.equal(headers.length, 7, 'Variable, Unit, Min, Max, Mean, RMS, NaN');
assert.equal(cells.length, headers.length, 'every header has a cell under it');

for (const lang of Object.keys(translations)) {
    for (const key of ['statsNaN', 'statsNaNHint']) {
        assert.ok(translations[lang][key]?.trim(), `${lang}.${key} must be present`);
    }
}

console.log('Panel statistics NaN-count checks passed.');
