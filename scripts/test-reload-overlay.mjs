// The Reload button on a large file used to run its multi-second re-read and
// re-parse with no visual feedback at all (#56): nothing said the app was
// working, so nothing said when it was done. Both reload entry points must now
// show the same loading overlay the initial load uses, and must always drop it
// again — on success, on failure, and before any modal they open themselves.
//
//   node scripts/test-reload-overlay.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Modal from '../src/ui/modal.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';

const alerts = [];
Modal.alert = async (title) => { alerts.push(title); };

class Harness {
    constructor() {
        this.calls = [];
        this.files = new Map();
        this._nextFileId = 2;

        const record = (name) => (...args) => { this.calls.push(name); return this[`${name}Result`]?.(...args); };
        // Overlay + reload collaborators as own properties, so they win over
        // the real prototype methods that want a document.
        this._showFileLoadingOverlay = record('show');
        this._updateFileLoadingOverlay = record('update');
        this._hideFileLoadingOverlay = record('hide');
        this._waitForNextPaint = async () => {};
        this._refuseReloadOfInMemoryFile = async () => false;
        this._canParseFromFile = () => false;
        this._readLatestBuffer = record('read');
        this.readResult = async () => new TextEncoder().encode('t,x\n0,1\n').buffer;
        this._hashBuffer = async () => 'hash-after';
        this._parseResultBuffer = record('parse');
        this.parseResult = async () => ({ tree: {}, variables: {}, metadata: {} });
        this._fileDisplayName = (entry) => entry.name;
        this._reapplyDerivedVariables = () => {};
        this._adoptExcelCsvCache = () => {};
        this._updateTopBar = () => {};
        this._clearVariableSelection = () => {};
        this.renderVariablesTree = () => {};
        this._renderFilesList = () => {};
        this._updateActionButtons = () => {};
        this._nextVersionName = (name) => `${name} (2)`;
        this._copyDerivedDefinitions = () => {};
        this._normalizeFileTransform = (t) => t || {};
        this._notifyNewVersionLoaded = record('notify');
        this.notifyResult = async () => {};

        const entry = { file: { name: 'big.csv', size: 123 }, name: 'big.csv', extension: '.csv', buffer: null, contentHash: 'hash-before', transform: {} };
        this.files.set('f1', entry);
        this.plotManager = {
            activeFileId: 'f1',
            files: new Map([['f1', { data: { metadata: {} } }]]),
            updateFileData: () => {},
            addFile: () => {},
            setActiveFile: () => {},
        };
    }
}
installFileMethods(Harness);

const withDocumentStub = async (fn) => {
    const previous = globalThis.document;
    globalThis.document = { getElementById: () => ({ classList: { remove: () => {} } }) };
    try { return await fn(); } finally { globalThis.document = previous; }
};

let checks = 0;
const check = async (fn) => { await fn(); checks++; };

// ── Plain reload: overlay around the read + parse, hidden in finally ──────

await check(async () => {
    const h = new Harness();
    await h.reloadActiveFile();
    assert.deepEqual(h.calls, ['show', 'update', 'read', 'parse', 'hide'],
        'overlay shows before the slow work and hides after it');
});

await check(async () => {
    const h = new Harness();
    h.parseResult = async () => { throw new Error('boom'); };
    await assert.rejects(() => h.reloadActiveFile(), /boom/);
    assert.equal(h.calls.at(-1), 'hide', 'a failed reload still drops the overlay');
});

// ── New-version reload ────────────────────────────────────────────────────

await check(() => withDocumentStub(async () => {
    const h = new Harness();
    await h.reloadActiveFileAsNewVersion();
    assert.deepEqual(h.calls, ['show', 'update', 'read', 'parse', 'hide', 'notify'],
        'overlay is dropped BEFORE the new-version notice modal opens');
}));

await check(async () => {
    const h = new Harness();
    h._hashBuffer = async () => 'hash-before'; // latest read hashes identical
    alerts.length = 0;
    await h.reloadActiveFileAsNewVersion();
    assert.deepEqual(h.calls, ['show', 'update', 'read', 'hide'],
        'the unchanged-file path hides the overlay before its notice, without parsing');
    assert.equal(alerts.length, 1, 'the unchanged notice was shown');
});

await check(async () => {
    const h = new Harness();
    h.parseResult = async () => { throw new Error('boom'); };
    await assert.rejects(() => h.reloadActiveFileAsNewVersion(), /boom/);
    assert.equal(h.calls.at(-1), 'hide', 'a failed new-version reload still drops the overlay');
});

// ── Wiring: reuse, not reinvention ────────────────────────────────────────

await check(() => {
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const reload = source.slice(source.indexOf('proto.reloadActiveFile'), source.indexOf('proto._notifyNewVersionLoaded'));
    assert.match(reload, /_showFileLoadingOverlay\(1\)/, 'reload uses the shared file-loading overlay');
    assert.doesNotMatch(reload, /_showExampleLoadingOverlay/, 'and not the example overlay');
    const liveUpdate = readFileSync(new URL('../src/app/methods/live-update-methods.js', import.meta.url), 'utf8');
    assert.doesNotMatch(liveUpdate, /_showFileLoadingOverlay/,
        'live update must never flash the overlay on its periodic ticks');
});

console.log(`reload overlay: ${checks} checks passed`);
