// A file that cannot be loaded has to SAY so (#143).
//
// loadFile() declared `currentFile` inside its outer try and the catch named
// it. A `let` in a try block is not in scope from the catch, so the error
// handler threw a ReferenceError over the top of the real failure: no dialog,
// no message, and the actual error only in the console underneath a stack
// trace about `currentFile`. Every unreadable file took that path — a corrupt
// CSV, an unsupported format, a file that vanished between picking and reading
// — so describeLoadError and its translated messages were unreachable.
//
// The module imports cleanly in Node (test-matlab-parser.mjs already does it),
// so this runs the real method against a small stub rather than reading source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import i18n from '../src/i18n/index.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';

class Harness {
    constructor() {
        this.files = new Map();
        this.shown = [];
        this.logged = [];
        this._nextFileId = 1;
        // Shadows the prototype: the dialog itself needs a DOM, and what is
        // being tested is that the handler reaches it at all, with a name.
        this._showLoadError = async (error, filename) => { this.shown.push({ error, filename }); };
        this._hideFileLoadingOverlay = () => {};
    }
}
installFileMethods(Harness);

// loadFile logs the failure before showing it; keep that out of the output.
const quiet = async (fn) => {
    const error = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = error; }
};

// ── Nothing to load at all ───────────────────────────────────────────────────
// The simplest failure: no file and no handle to get one from. Before the fix
// this rejected with "currentFile is not defined" instead of resolving.
{
    const app = new Harness();
    const result = await quiet(() => app.loadFile(null, {}));
    assert.equal(result, null, 'a failed load resolves to null rather than throwing');
    assert.equal(app.shown.length, 1, 'and the user is told');
    assert.equal(app.shown[0].error.message, i18n.t('invalidFile'), 'with the real error, not a ReferenceError');
    assert.doesNotMatch(String(app.shown[0].error), /currentFile/, 'the handler is not what failed');
    assert.equal(app.shown[0].filename, '', 'no file, so no name to give');
}

// ── The name in the dialog is the file that was actually being read ─────────
// The sharp case: the file comes from a handle, so `currentFile` is assigned
// INSIDE the try and differs from the `file` argument. A dialog that names
// it proves the catch sees the assignment — which is the whole fix. Passing
// `file` straight through would name nothing here.
{
    const app = new Harness();
    const handle = { getFile: async () => new File([new Uint8Array([1, 2, 3])], 'from-handle.csv') };
    app._fileExtension = () => { throw new Error('boom while reading'); };
    const result = await quiet(() => app.loadFile(null, { fileHandle: handle }));
    assert.equal(result, null);
    assert.equal(app.shown.length, 1);
    assert.equal(app.shown[0].filename, 'from-handle.csv',
        'the dialog names the file the loader had in hand when it failed');
    assert.equal(app.shown[0].error.message, 'boom while reading');
}

// And when there is no handle, the argument's own name is used.
{
    const app = new Harness();
    app._fileExtension = () => { throw new Error('boom'); };
    await quiet(() => app.loadFile(new File([new Uint8Array([1])], 'picked.csv'), {}));
    assert.equal(app.shown[0].filename, 'picked.csv');
}

// ── throwOnError still hands the caller the real error ──────────────────────
// loadFiles() relies on this to report per-file failures; a ReferenceError
// there would have been reported as the reason the file could not be read.
{
    const app = new Harness();
    app._fileExtension = () => { throw new Error('the real reason'); };
    await assert.rejects(
        quiet(() => app.loadFile(new File([new Uint8Array([1])], 'x.csv'), { throwOnError: true })),
        /the real reason/,
        'the caller gets the failure, not the handler’s own crash');
    assert.equal(app.shown.length, 0, 'and no dialog, because the caller is handling it');
}

// ── A cancelled load is not a failure ───────────────────────────────────────
{
    const app = new Harness();
    const loadToken = { cancelled: false };
    app._fileExtension = () => { loadToken.cancelled = true; throw new Error('abandoned'); };
    const result = await quiet(() => app.loadFile(new File([new Uint8Array([1])], 'x.csv'), { loadToken }));
    assert.equal(result, null);
    assert.equal(app.shown.length, 0, 'the user cancelled; there is nothing to report');
}

// ── The declaration that made it possible ───────────────────────────────────
// Stated as well as exercised: the tests above all pass again the moment the
// declaration moves back inside the try ONLY if the catch stops naming it, and
// this says which of the two arrangements is the intended one.
const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const start = source.indexOf('proto.loadFile = async function(file, options = {}) {');
assert.ok(start >= 0, 'loadFile is present');
const head = source.slice(start, source.indexOf('try {', start));
assert.match(head, /let currentFile = file;/,
    'currentFile is declared before the try, where the catch can see it');

console.log('Load-error dialog checks passed.');
