// Copying an analysis' text results: the curve fits (2D and time series), the
// integral table, the histogram and profile summaries, the Σ statistics. The
// cursors' readout has its own test (test-cursor-copy.mjs); these pin down the
// shared helpers and where the buttons are.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockText, tableText } from '../src/utils/clipboard.js';

// Enough of a table: rows of cells, each with a text and a span.
const cell = (textContent, colSpan = 1) => ({ textContent, colSpan });
const table = (...rows) => ({ rows: rows.map(cells => ({ cells })) });

// ── Tables: tab-separated, a span followed by empty cells ───────────────────
assert.equal(
    tableText(table(
        [cell('Signal'), cell('Value', 2), cell('Mean', 2), cell('Coverage')],
        [cell('  P_load '), cell('2,988'), cell('MW·h'), cell('124.5'), cell('MW'), cell('7/7 days')],
    )),
    'Signal\tValue\t\tMean\t\tCoverage\nP_load\t2,988\tMW·h\t124.5\tMW\t7/7 days',
    'a number and its unit stay in two cells, under a heading that spans both',
);
assert.equal(
    tableText(table([cell('P_load', 8)], [cell('Jan'), cell('1')])),
    'P_load\nJan\t1',
    'a group heading is just its name: trailing empties dropped',
);
assert.equal(tableText(table([cell(' '), cell('')])), '', 'an empty row is not a line');
assert.equal(tableText(null), '');

// ── Blocks: the lines the reader sees ───────────────────────────────────────
assert.equal(
    blockText({ innerText: '\n  v_out\n Finite: 10 · Invalid: 0\n\n  i_in \n Finite: 9' }),
    'v_out\nFinite: 10 · Invalid: 0\ni_in\nFinite: 9',
);
assert.equal(blockText({ textContent: 'no layout here' }), 'no layout here', 'textContent without a laid-out page');
assert.equal(blockText(null), '');

// ── Where the buttons are ───────────────────────────────────────────────────
const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
assert.match(src('plots/methods/phase2d-fit-methods.js'), /resultsHead\.append\(title, metricsHelpBtn, copyBtn\)/,
    'curve fit: in the results heading, beside its help');
assert.match(src('plots/methods/curve-fit-methods.js'), /head\.append\(title, helpButton\('phase2dFitMetricsHelpTitle'[^\n]*\), copyBtn\)/,
    'time-series curve fit: in the results heading, beside its help');
assert.match(src('plots/methods/integral-methods.js'), /appendCopyButton\(options\.lastElementChild, \(\) => tableText\(summary\.querySelector\('table'\)\)\)/,
    'integral: the summary table, tab-separated');
assert.match(src('plots/methods/histogram-methods.js'), /appendCopyButton\(options\.lastElementChild, \(\) => blockText\(summaryBox\)\)/);
assert.match(src('plots/methods/temporal-profile-methods.js'), /appendCopyButton\(options\.lastElementChild, \(\) => blockText\(summary\)\)/);
for (const path of ['plots/plot-manager.js', 'plots/methods/correlation-methods.js']) {
    assert.match(src(path), /copyText: dialog => tableText\(dialog\.querySelector\('\.stats-table'\)\)/, `${path}: Σ statistics`);
}

const translations = src('i18n/translations.js');
assert.equal(translations.match(/\bcopyResults:/g)?.length, 5, 'copyResults in all five languages');

console.log('results copy: ok');
