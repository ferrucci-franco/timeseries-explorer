// A reload that cannot finish its work must not stop and ask (#50).
//
// Reload a file whose source has lost a signal and a derived dataset built on
// that signal — a cross-correlation, a resample — can no longer be computed.
// The recompute happens INSIDE the reload, with the full-screen loading
// overlay up and no way to cancel it, and it used to `await Modal.alert` right
// there: the reload stopped dead, the overlay kept saying "Loading run.csv",
// and with two such datasets the user had two dialogs to find before the app
// would move again. That is the freeze the report describes.
//
// What is left here is the rule: collect, finish, then say it once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { datasetFailureText, reloadNoticeSections } from '../src/utils/reload-report.js';

// ── The reason, in words ────────────────────────────────────────────────────
// The tools throw a DataToolError carrying a translation KEY, so the old
// dialog read "could not be recomputed from its source: dataToolChooseVariable".
const t = (key) => ({ dataToolChooseVariable: 'Choose a variable' }[key] || key);
const toolError = (code) => Object.assign(new Error(code), { code });

assert.equal(datasetFailureText(toolError('dataToolChooseVariable'), t), 'Choose a variable',
    'the code is translated, not printed');
assert.equal(datasetFailureText(toolError('dataToolSomethingNewer'), t), '',
    'a key with no translation yet is left out rather than shown raw');
assert.equal(datasetFailureText(new Error('Unknown derived-dataset tool: xcorr2'), t),
    'Unknown derived-dataset tool: xcorr2', 'a real message is a real message');
assert.equal(datasetFailureText(new Error('dataToolChooseVariable'), t), 'Choose a variable',
    'and a key that arrived as a bare message is still translated');
assert.equal(datasetFailureText(undefined, t), '', 'nothing known, nothing claimed');

// ── What the one notice contains ────────────────────────────────────────────
assert.deepEqual(reloadNoticeSections({}), [], 'a reload that changed nothing says nothing');
assert.deepEqual(reloadNoticeSections({ dropped: [], failures: [] }), []);

const both = reloadNoticeSections({
    dropped: ['b'],
    failures: [{ name: 'a xcorr.csv', reason: 'Choose a variable' }, { name: 'b resampled.csv' }],
});
assert.deepEqual(both.map(s => s.kind), ['dropped', 'datasets'],
    'what changed the panels is read first; what is merely stale after it');
assert.deepEqual(both[0].items, ['b']);
assert.deepEqual(both[1].items, [
    { name: 'a xcorr.csv', reason: 'Choose a variable' },
    { name: 'b resampled.csv', reason: '' },
]);
assert.deepEqual(reloadNoticeSections({ failures: [{ name: 'x' }] }).map(s => s.kind), ['datasets'],
    'datasets alone are still worth a notice');
assert.deepEqual(reloadNoticeSections({ dropped: [null, '', 'ok'] })[0].items, ['ok'], 'no blank rows');

// ── Wired into the reload ───────────────────────────────────────────────────
const files = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const reload = files.slice(files.indexOf('proto.reloadActiveFile = async function() {'));
const body = reload.slice(0, reload.indexOf('\nproto._reportReloadOutcome'));

assert.match(body, /_recomputeDerivedDatasetsOf\?\.\(id, \{ deferUi: true, silent: true, failures: datasetFailures \}\)/,
    'the reload asks for no dialogs while it is running');
assert.match(body, /_recomputeDerivedDataset\(id, \{ silent: true, failures \}\)/,
    'and neither does reloading a derived dataset itself');
// The order is the whole fix: hide, then speak.
const hide = body.lastIndexOf('this._hideFileLoadingOverlay();');
const report = body.indexOf('this._reportReloadOutcome(droppedTraces, datasetFailures);');
assert.ok(hide > 0 && report > hide, 'the notice comes after the overlay is down, never under it');

const dataset = readFileSync(new URL('../src/app/methods/derived-dataset-methods.js', import.meta.url), 'utf8');
assert.match(dataset, /options\.failures\?\.push\(\{ name, reason \}\);/, 'the failure is collected either way');
assert.match(dataset, /const reason = datasetFailureText\(err, key => i18n\.t\(key\)\);/,
    'and the reason is translated where it is built');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['reloadDatasetsStaleBody', 'derivedDatasetRecomputeFailedNoReason']) {
    assert.equal([...translations.matchAll(new RegExp(`${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

console.log('Reload report checks passed.');
