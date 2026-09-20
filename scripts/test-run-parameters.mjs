// Telling one simulation run from another in the hover (#51).
//
// Overlaying the same curve from a dozen runs, the hover names the file and
// nothing else — and a filename is rarely what the runs differ BY. Tuning a
// PID, what you want to read off the curve is Kp, Ki, Kd.
//
// The report ends "no estoy seguro cómo se podría configurar esto. Tiene que
// ser fácil e intuitivo", so nothing is configured: the parameters shown are
// the ones that DIFFER across the loaded files. One every run shares says
// nothing about which run this is; one only some files carry cannot be
// compared. What is left is the axes the batch was swept over.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { distinguishingParameterNames, runParameterLabel } from '../src/utils/run-parameters.js';

const file = (fileId, parameters) => ({ fileId, parameters });
const RUNS = [
    file('a', { Kp: 2.5, Ki: 0.1, Kd: 0.01, N: 100 }),
    file('b', { Kp: 3.5, Ki: 0.1, Kd: 0.02, N: 100 }),
    file('c', { Kp: 4.5, Ki: 0.2, Kd: 0.01, N: 100 }),
];

// ── Which parameters ────────────────────────────────────────────────────────
assert.deepEqual(distinguishingParameterNames(RUNS), ['Kd', 'Ki', 'Kp'],
    'the swept axes, and not N, which every run shares');
assert.deepEqual(distinguishingParameterNames([RUNS[0]]), [],
    'one run has nothing to be told apart from');
assert.deepEqual(distinguishingParameterNames([]), []);
assert.deepEqual(distinguishingParameterNames(null), [], 'no files, no answer');

// Present everywhere, or it names which files were loaded rather than which
// run this is.
assert.deepEqual(
    distinguishingParameterNames([file('a', { Kp: 1, extra: 9 }), file('b', { Kp: 2 })]),
    ['Kp'], 'a parameter only one run carries is not a comparison');

// Two runs recorded as 0.1 and "0.100" are one tuning written twice.
assert.deepEqual(distinguishingParameterNames([file('a', { K: '0.100' }), file('b', { K: 0.1 })]), [],
    'the same number written differently is not a difference');
assert.deepEqual(distinguishingParameterNames([file('a', { M: 'fast' }), file('b', { M: 'slow' })]), ['M'],
    'and a non-numeric parameter still compares');

// Alphabetical and capped, so a sweep over forty parameters does not produce a
// hover nobody can read — and so which ones survive does not shuffle as files
// are added.
const many = [
    file('a', Object.fromEntries('abcdefgh'.split('').map((k, i) => [k, i]))),
    file('b', Object.fromEntries('abcdefgh'.split('').map((k, i) => [k, i + 1]))),
];
assert.deepEqual(distinguishingParameterNames(many), ['a', 'b', 'c', 'd'], 'first four by name');
assert.deepEqual(distinguishingParameterNames(many, { limit: 2 }), ['a', 'b']);
assert.deepEqual(distinguishingParameterNames(many, { limit: 0 }), []);

// ── The label ───────────────────────────────────────────────────────────────
assert.equal(runParameterLabel(['Kd', 'Ki', 'Kp'], RUNS[0].parameters), 'Kd=0.01 · Ki=0.1 · Kp=2.5');
assert.equal(runParameterLabel([], RUNS[0].parameters), '', 'nothing to say, nothing said');
assert.equal(runParameterLabel(['Kp'], null), '');
assert.equal(runParameterLabel(['Kp', 'gone'], { Kp: 1 }), 'Kp=1',
    'a name the file does not carry is left out rather than printed empty');
assert.equal(runParameterLabel(['Kp'], { Kp: 2.5 }, v => `<${v}>`), 'Kp=<2.5>',
    'the caller formats the numbers');

// ── Wiring ──────────────────────────────────────────────────────────────────
// The readers live in the data-methods mixin, beside the `_buildTimeTrace`
// that calls them — a harness that installs the mixin onto a stub gets them
// too, which is the whole point of that file.
const data = readFileSync(new URL('../src/plots/methods/data-methods.js', import.meta.url), 'utf8');
const params = data.slice(data.indexOf('proto._fileParameters = function(fileId) {'));
const paramsBody = params.slice(0, params.indexOf('\n};'));
// Two shapes reach this: OpenModelica marks a parameter, a CSV cannot — so a
// column that never changes is one, and a sweep recorded as CSV columns reads
// the same as the .mat it came from.
assert.match(paramsBody, /variable\?\.kind !== 'parameter' && variable\?\.isConstant !== true/,
    'a declared parameter or a column that never changes');
assert.match(paramsBody, /variable\?\.kind === 'abscissa'\) continue;/, 'the time axis is not a parameter');

// Recomputed when the set of files changes, not per hover: the answer is about
// the files, and a template is built per trace.
assert.match(data, /_distinguishingParameterNames = function\(\) \{[\s\S]{0,700}?this\._runParameterCache\?\.signature === signature/,
    'the answer is cached against the loaded files');
assert.match(data, /_distinguishingParameterNames = function\(\) \{[\s\S]{0,500}?this\.files\.size < 2\) return \[\]/,
    'and costs nothing at all with a single file');

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
assert.match(manager, /setHoverRunParameters\(v\) \{[\s\S]{0,300}?this\._runParameterCache = null;/,
    'switching it off drops the cache with it');
assert.match(data, /const runParams = this\._runParameterLabel\(t\.fileId\);/, 'the hover asks per trace');
assert.match(data, /const runSuffix = runParams \? `<br><i>\$\{this\._escapeHTML\(runParams\)\}<\/i>` : '';/,
    'and escapes what it got — these are names out of a file');
assert.equal((data.match(/\$\{runSuffix\}<extra><\/extra>/g) || []).length, 3,
    'all three timeseries hover templates carry it');

const session = readFileSync(new URL('../src/app/methods/session-methods.js', import.meta.url), 'utf8');
assert.match(session, /hoverRunParameters: this\.plotManager\.hoverRunParameters !== false,/, 'saved with the view');
assert.match(session, /setHoverRunParameters\(settings\.hoverRunParameters !== false\)/,
    'and restored, defaulting on for a view saved before it existed');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
assert.equal((translations.match(/\bhoverRunParameters:/g) || []).length, 4, 'translated in all four languages');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /id="hover-run-parameters" checked/, 'the option is there, and on');

console.log('Run-parameter checks passed.');
