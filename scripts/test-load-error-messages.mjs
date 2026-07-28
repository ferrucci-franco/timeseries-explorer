// Which load failures get an explanation, and which are passed through.
//
//   node scripts/test-load-error-messages.mjs
//
// The strings on the left are real messages seen from V8, the pickle reader and
// DuckDB-WASM while loading the multi-hundred-megabyte fixtures. They are the
// point of the whole module: without it they reached the user verbatim, inside
// an app dialog but reading like a browser crash.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeLoadError, formatLoadErrorMessage } from '../src/app/load-error-messages.js';
import translations from '../src/i18n/translations.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// ─── Recognised failures ──────────────────────────────────────────────────

const RECOGNISED = [
    ['Cannot create a string longer than 0x1fffffe8 characters', 'loadErrorTextTooLarge'],
    ['Cannot create a string longer than 536870888 characters', 'loadErrorTextTooLarge'],
    ['Unsupported ndarray size 67500000.', 'loadErrorPickleArrayTooLarge'],
    ['Worker crashed', 'loadErrorReaderCrashed'],
    ['worker terminated unexpectedly', 'loadErrorReaderCrashed'],
    ['Array buffer allocation failed', 'loadErrorOutOfMemory'],
    ['Invalid typed array length: 900000000', 'loadErrorOutOfMemory'],
    ['RangeError: Invalid array buffer length', 'loadErrorOutOfMemory'],
    ['allocation size overflow', 'loadErrorOutOfMemory'],
    ['OutOfMemoryException: failed to allocate data of size 2.1GB', 'loadErrorQueryEngineMemory'],
    ['Out of Memory Error: could not allocate block', 'loadErrorQueryEngineMemory'],
];

for (const [message, expectedKey] of RECOGNISED) {
    check(() => {
        const described = describeLoadError(new Error(message));
        assert.equal(described.key, expectedKey, `"${message}" -> ${expectedKey}`);
        assert.equal(described.cancelled, false);
        assert.equal(described.raw, message, 'the original text is always preserved');
    });
}

check(() => {
    // The specific pickle rule must win over the general out-of-memory one.
    const described = describeLoadError(new Error('Unsupported ndarray size 67500000.'));
    assert.equal(described.params.count, (67500000).toLocaleString(), 'the array size is extracted for the message');
});

check(() => {
    // A worker death is identified by shape as well as by wording, because the
    // wording comes from the browser and is not ours to rely on.
    assert.equal(describeLoadError(Object.assign(new Error(''), { name: 'WorkerDiedError' })).key, 'loadErrorReaderCrashed');
    assert.equal(describeLoadError(Object.assign(new Error('boom'), { workerCrashed: true })).key, 'loadErrorReaderCrashed');
});

// ─── Cancellation is not a failure ────────────────────────────────────────

check(() => {
    for (const err of [
        Object.assign(new Error('File selection cancelled'), { name: 'AbortError' }),
        Object.assign(new Error('Task superseded'), { cancelled: true }),
    ]) {
        const described = describeLoadError(err);
        assert.equal(described.cancelled, true, 'the user aborting gets no dialog');
        assert.equal(described.key, null);
    }
});

// ─── Anything else passes through unchanged ───────────────────────────────

check(() => {
    // Inventing an explanation for an error we do not recognise would be worse
    // than showing what it actually said.
    for (const message of [
        'Invalid file',
        'No time column detected in "results.csv"',
        'Sheet "Data" is empty',
        '',
    ]) {
        const described = describeLoadError(new Error(message));
        assert.equal(described.key, null, `"${message}" is passed through`);
        assert.equal(described.raw, message || 'Error');
    }
});

check(() => {
    // Non-Error throws must not crash the error handler.
    assert.equal(describeLoadError('a string').key, null);
    assert.equal(describeLoadError(undefined).cancelled, false);
    assert.equal(describeLoadError(null).key, null);
});

// ─── Template substitution ────────────────────────────────────────────────

check(() => {
    assert.equal(
        formatLoadErrorMessage('{count} values in {file}', { count: '1,000', file: 'a.pkl' }),
        '1,000 values in a.pkl',
    );
    assert.equal(formatLoadErrorMessage('no placeholders', { count: 1 }), 'no placeholders');
    assert.equal(formatLoadErrorMessage(undefined, {}), '');
});

// ─── Every key the mapper can emit must be translated ─────────────────────

check(() => {
    const emitted = new Set(RECOGNISED.map(([, key]) => key));
    emitted.add('errorDetailsLabel');
    for (const key of emitted) {
        for (const lang of ['en', 'fr', 'es', 'it']) {
            const value = translations[lang][key];
            assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key} is translated`);
        }
    }
});

check(() => {
    // {count} is the only placeholder any of these messages may use; a stray
    // one would reach the user as literal braces.
    for (const lang of ['en', 'fr', 'es', 'it']) {
        for (const [, key] of RECOGNISED) {
            const placeholders = [...String(translations[lang][key]).matchAll(/\{(\w+)\}/g)].map(m => m[1]);
            for (const name of placeholders) {
                assert.ok(['count', 'file'].includes(name), `${lang}.${key} uses unknown placeholder {${name}}`);
            }
        }
    }
});

// ─── The dialog has to be able to show the detail ─────────────────────────

check(() => {
    const modalSource = readFileSync(new URL('../src/ui/modal.js', import.meta.url), 'utf8');
    assert.match(modalSource, /options\.details/, 'Modal.alert accepts a details pane');
    assert.match(modalSource, /pre\.textContent = String\(options\.details\)/, 'details are inserted as text, never as HTML');
});

console.log(`load error messages: ${checks} checks passed`);
