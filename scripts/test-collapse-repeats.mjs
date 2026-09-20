// "Collapse repeated timestamps": one row per instant, the reader choosing
// which one (#154).
//
// The app keeps a file's time axis however often its stamps repeat, which
// leaves several rows at one instant drawn as a vertical segment. This is how
// a reader turns that into one row — and nothing here decides for them which.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    COLLAPSE_AGGREGATES,
    COLLAPSE_DEFAULT_AGGREGATE,
    normalizeCollapseAggregate,
    runCollapseRepeats,
    timestampRuns,
} from '../src/compute/kernels/collapse-repeats.js';

// ── Where the runs are ──────────────────────────────────────────────────────
const runs = timestampRuns([0, 1, 1, 1, 1, 2]);
assert.equal(runs.groups, 3, 'three instants');
assert.equal(runs.collapsed, 3, 'and three rows the file would lose');
assert.deepEqual(Array.from(runs.lengths), [1, 4, 1]);
assert.equal(timestampRuns([]).groups, 0);
assert.equal(timestampRuns([5, 5, 5]).collapsed, 2, 'a file that is one instant throughout');

// A row whose time could not be read is at no instant, so it joins nothing —
// not even another unreadable one.
const withGaps = timestampRuns([1, NaN, NaN, 1]);
assert.equal(withGaps.groups, 4, 'NaT rows stand alone');
assert.equal(withGaps.collapsed, 0);

// ── What the rows become ────────────────────────────────────────────────────
const burst = { time: [0, 1, 1, 1, 1, 2], columns: [[1, 10, 20, 30, 40, 2]] };
const of = (aggregate) => Array.from(runCollapseRepeats({ ...burst, params: { aggregate } }).columns[0]);
assert.deepEqual(of('mean'), [1, 25, 2]);
assert.deepEqual(of('max'), [1, 40, 2]);
assert.deepEqual(of('min'), [1, 10, 2]);
assert.deepEqual(of('first'), [1, 10, 2], 'the row that arrived first, not the smallest');
assert.deepEqual(of('last'), [1, 40, 2]);
assert.deepEqual(Array.from(runCollapseRepeats({ ...burst, params: { aggregate: 'mean' } }).time), [0, 1, 2],
    'the instant is kept, once');

// Every column of the file goes through the same grouping, so the rows stay rows.
const two = runCollapseRepeats({ time: [1, 1, 2], columns: [[4, 6, 9], [10, 20, 30]], params: { aggregate: 'mean' } });
assert.deepEqual(two.columns.map(c => Array.from(c)), [[5, 9], [15, 30]]);

// A hole in one row of a burst is a missing reading, not a reason to throw the
// burst away — but a burst with nothing in it has nothing to average.
assert.deepEqual(Array.from(runCollapseRepeats({
    time: [1, 1, 1], columns: [[2, NaN, 4]], params: { aggregate: 'mean' },
}).columns[0]), [3], 'the finite values are what there is to average');
assert.ok(Number.isNaN(runCollapseRepeats({
    time: [1, 1], columns: [[NaN, NaN]], params: { aggregate: 'max' },
}).columns[0][0]), 'and no finite value says so');
// first/last mean the first and last ROW, whatever it holds.
assert.ok(Number.isNaN(runCollapseRepeats({
    time: [1, 1], columns: [[NaN, 5]], params: { aggregate: 'first' },
}).columns[0][0]), 'the first row of the burst is the first row of the burst');

// A file with nothing repeated comes through unchanged.
const untouched = runCollapseRepeats({ time: [1, 2, 3], columns: [[7, 8, 9]], params: {} });
assert.equal(untouched.collapsed, 0);
assert.deepEqual(Array.from(untouched.columns[0]), [7, 8, 9]);
assert.equal(untouched.aggregate, COLLAPSE_DEFAULT_AGGREGATE);

assert.deepEqual(COLLAPSE_AGGREGATES, ['mean', 'max', 'min', 'first', 'last']);
assert.equal(normalizeCollapseAggregate('median'), 'mean', 'an aggregate this kernel does not know falls back');
assert.equal(normalizeCollapseAggregate(undefined), 'mean');

// ── Wired in as a derived-dataset tool ──────────────────────────────────────
const methods = readFileSync(new URL('../src/app/methods/collapse-methods.js', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/app/methods/data-tools-methods.js', import.meta.url), 'utf8');
const datasets = readFileSync(new URL('../src/app/methods/derived-dataset-methods.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');

assert.match(tools, /const FILE_DATA_TOOLS = new Set\(\['resample', 'xcorr', 'collapse'\]\);/,
    'it makes a file, not a variable: the row count changes');
assert.match(tools, /const wholeFileTool = tool === 'resample' \|\| tool === 'collapse';/,
    'and it takes every variable, like the resampler');
assert.match(tools, /if \(fileTool === 'collapse'\) return this\.commitCollapseTool\(options\);/, 'Create reaches it');
assert.match(datasets, /if \(recipe\.tool === 'collapse'\) return this\._computeCollapseDataset\(/,
    'so a reload of the source recomputes it from its recipe');
assert.match(datasets, /if \(recipe\.tool === 'collapse'\) this\._writeCollapseForm\?\.\(recipe, entry\.name\);/,
    'and the pencil reopens the tool with that recipe');
assert.match(app, /installCollapseMethods\(OpenModelicaViewer\);/);
assert.match(html, /<option value="collapse" data-i18n="dataToolCollapse">/, 'it is in the tool picker');
assert.match(html, /<select id="collapse-aggregate"/, 'with the choice the report asked for');
for (const aggregate of COLLAPSE_AGGREGATES) {
    assert.ok(html.includes(`<option value="${aggregate}"`), `${aggregate} is offered`);
}

// A row index counts rows and cannot repeat; collapsing it would merge rows
// that were never said to be at one instant.
assert.match(methods, /if \(time\.kind === 'index' \|\| !time\.values\?\.length\) return \{ \.\.\.blank, code: 'dataToolCollapseNoTimeAxis' \};/);
assert.match(methods, /if \(!runs\.collapsed\) return \{ \.\.\.blank, code: 'dataToolCollapseNothing'/,
    'and a file with nothing repeated is not worth a copy of itself');
assert.match(methods, /datetimeRepeats: \{ samples: grid\.length, repeated: 0, longestRun: grid\.length \? 1 : 0 \}/,
    'the result has one row per instant, so the notice must not fire on it');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['dataToolCollapse', 'dataToolCollapseAggregate', 'dataToolCollapseSummary',
    'dataToolCollapseCreated', 'dataToolCollapseNothing', 'dataToolCollapseNoTimeAxis',
    'dataToolCollapseFileSuffix', ...COLLAPSE_AGGREGATES.map(a => `dataToolCollapse${a[0].toUpperCase()}${a.slice(1)}`)]) {
    assert.equal([...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

console.log('Collapse-repeats checks passed.');
