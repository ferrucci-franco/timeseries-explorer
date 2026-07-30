// Files the app builds rather than reads have nothing on disk behind them, and
// nothing in the files list used to say so: a resampled file looked exactly like
// a loaded one and vanished when the tab closed. These tests cover the two
// halves of the answer — the row states it, and the row can resolve it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index.js';
import Modal from '../src/ui/modal.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';
import { installSessionMethods } from '../src/app/methods/session-methods.js';

// The dialogs are what the user actually reads, so they are captured and read
// back rather than merely allowed to happen.
const alerts = [];
Modal.alert = async (title, body, options) => { alerts.push({ title, body, options }); };

class Harness {
    constructor() {
        this.files = new Map();
        this.rendered = 0;
        // An own property, so it wins over the real renderer the install puts on
        // the prototype — that one wants a document.
        this._renderFilesList = () => { this.rendered++; };
    }
}
installFileMethods(Harness);
installSessionMethods(Harness);

const csv = () => new TextEncoder().encode('time,x\n0,1\n');

const builtEntry = (over = {}) => ({
    file: null,
    fileHandle: null,
    localPath: '',
    buffer: null,
    name: 'pendulum resampled.csv',
    extension: '.csv',
    resampledFrom: 'f1',
    syntheticBytes: csv,
    ...over,
});

// ── What counts as in-memory ──────────────────────────────────────────────

{
    const h = new Harness();
    assert.equal(h._isInMemoryFile(builtEntry()), true, 'a built file has no bytes on disk behind it');
    assert.equal(h._isInMemoryFile(null), false);
    assert.equal(h._isInMemoryFile({ name: 'a.csv', file: new Blob(['x']) }), false, 'a loaded file is not in memory only');
    assert.equal(
        h._isInMemoryFile(builtEntry({ file: { size: 10 } })),
        false,
        'bytes on disk win over the on-demand hook',
    );
    assert.equal(
        h._isInMemoryFile(builtEntry({ localPath: 'C:/data/x.csv' })),
        false,
        'a native path is a file on disk',
    );
    assert.equal(
        h._isInMemoryFile({ ...builtEntry(), syntheticBytes: undefined }),
        false,
        'without the hook there are no bytes to write, so the badge would offer nothing',
    );
}

// ── Saving: the picker branch ─────────────────────────────────────────────

{
    const h = new Harness();
    h.files.set('f2', builtEntry());
    const written = [];
    let suggested = '';
    globalThis.showSaveFilePicker = async (options) => {
        suggested = options.suggestedName;
        return {
            name: 'chosen.csv',
            createWritable: async () => ({
                write: async blob => written.push(blob),
                close: async () => {},
            }),
        };
    };
    try {
        const ok = await h.saveInMemoryFile('f2');
        assert.equal(ok, true);
        assert.equal(suggested, 'pendulum_resampled.csv', 'spaces are not left in a suggested filename');
        assert.equal(written.length, 1, 'the bytes are written once');
        assert.equal(await written[0].text(), 'time,x\n0,1\n');
        assert.equal(h.files.get('f2').savedCopyName, 'chosen.csv', 'the row records where the copy went');
        assert.ok(h.rendered > 0, 'the row is redrawn so the tooltip picks the copy up');
        // The file is still not backed by anything here: a copy on disk is not the
        // same as this entry being readable from disk, so the badge must stay.
        assert.equal(h._isInMemoryFile(h.files.get('f2')), true, 'saving a copy does not make the entry a disk file');
    } finally {
        delete globalThis.showSaveFilePicker;
    }
}

// Backing out of the dialog is a decision, not a failure: nothing is written and
// nothing is claimed.
{
    const h = new Harness();
    h.files.set('f2', builtEntry());
    globalThis.showSaveFilePicker = async () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
    };
    try {
        assert.equal(await h.saveInMemoryFile('f2'), false);
        assert.ok(!h.files.get('f2').savedCopyName, 'a cancelled save records nothing');
    } finally {
        delete globalThis.showSaveFilePicker;
    }
}

// ── Saving: the download branch (Firefox, Safari) ─────────────────────────

{
    const h = new Harness();
    h.files.set('f2', builtEntry());
    const downloads = [];
    h._downloadBlob = (blob, filename) => downloads.push(filename);
    delete globalThis.showSaveFilePicker;
    const ok = await h.saveInMemoryFile('f2');
    assert.equal(ok, true);
    assert.deepEqual(downloads, ['pendulum_resampled.csv'], 'no save dialog means a download');
    assert.equal(h.files.get('f2').savedCopyName, 'pendulum_resampled.csv');
}

// ── A file with nothing to write is not offered a button ──────────────────

{
    const h = new Harness();
    h.files.set('f2', { ...builtEntry(), syntheticBytes: undefined });
    alerts.length = 0;
    assert.equal(await h.saveInMemoryFile('f2'), false, 'nothing to serialize, nothing to save');
    assert.equal(await h.saveInMemoryFile('nope'), false, 'an unknown file id is not an error');
    assert.equal(alerts.length, 0, 'neither is worth a dialog: there was no button to press');
}

// A serializer that throws — a grid too large to render as text — is reported,
// not swallowed.
{
    const h = new Harness();
    h.files.set('f2', builtEntry({
        syntheticBytes: () => { throw new Error('Resampled dataset is too large to serialize'); },
    }));
    alerts.length = 0;
    assert.equal(await h.saveInMemoryFile('f2'), false);
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].body.includes('too large to serialize'), 'the reason reaches the user');
    assert.ok(!h.files.get('f2').savedCopyName, 'and nothing claims a copy exists');
}

// ── The tooltip says what the row cannot show ────────────────────────────

{
    const h = new Harness();
    const lines = h._fileEntryTooltip(builtEntry()).split('\n');
    assert.equal(lines.length, 2, 'a built file gains a line where a loaded one shows its size');
    assert.equal(lines[1], i18n.t('fileInMemoryTooltip'), 'and that line is about where the file lives');

    h._formatBytes = bytes => `${bytes} B`;
    const loaded = h._fileEntryTooltip({ name: 'a.csv', file: { size: 12 } });
    assert.equal(loaded.split('\n').length, 1, 'a loaded file gains nothing');
}

// ── Reload is refused with a reason, not with "No buffer available" ────────
//
// The native alert the old path produced named an internal field and was raised
// deep inside a parse; the reader learned nothing. This is the guard that stops
// the reload before it gets there.

{
    const h = new Harness();
    h._fileDisplayName = entry => entry.name;
    h._updateTopBar = () => {};

    alerts.length = 0;
    const refused = await h._refuseReloadOfInMemoryFile(builtEntry());
    assert.equal(refused, true, 'a built file cannot be reloaded');
    assert.equal(alerts.length, 1, 'and it says so once');
    assert.equal(alerts[0].title, i18n.t('fileInMemoryReloadTitle'));
    assert.ok(alerts[0].body.includes('pendulum resampled.csv'), 'the file is named');
    assert.ok(alerts[0].body.includes(i18n.t('fileInMemoryReloadUnsaved')), 'unsaved: it says to write it out first');
    assert.ok(!alerts[0].body.includes('{saved}'), 'no placeholder survives');

    // With a copy on disk the advice changes: open that file, close this one.
    alerts.length = 0;
    await h._refuseReloadOfInMemoryFile(builtEntry({ savedCopyName: 'out.csv' }));
    assert.ok(alerts[0].body.includes('out.csv'), 'the copy is named');
    assert.ok(
        !alerts[0].body.includes(i18n.t('fileInMemoryReloadUnsaved')),
        'and it does not also tell the user to write out a copy that exists',
    );

    // A loaded file is not intercepted: its reload has a source to read.
    alerts.length = 0;
    assert.equal(await h._refuseReloadOfInMemoryFile({ name: 'a.csv', file: { size: 5 } }), false);
    assert.equal(alerts.length, 0, 'and nothing is said about it');
}

// Both reload entry points go through the guard — the "as new version" one reads
// the same absent bytes.
{
    for (const method of ['reloadActiveFile', 'reloadActiveFileAsNewVersion']) {
        const h = new Harness();
        h._fileDisplayName = entry => entry.name;
        h._updateTopBar = () => {};
        h.files.set('f2', builtEntry());
        h.plotManager = { activeFileId: 'f2', files: new Map() };
        alerts.length = 0;
        // Would throw on any of the parse helpers this harness does not have, so
        // returning quietly is itself the assertion that the guard fired first.
        await h[method]();
        assert.equal(alerts.length, 1, `${method} explains instead of failing`);
    }
}

// ── The row puts it where it can be seen ──────────────────────────────────

{
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const names = ['saveBtn', 'csvParsingBtn', 'matArraysBtn', 'transformBtn', 'closeBtn'];
    const at = names.map((name) => {
        const index = source.indexOf(`entry.appendChild(${name})`);
        assert.ok(index > 0, `${name} must be appended to the row`);
        return index;
    });
    assert.deepEqual(
        [...at].sort((a, b) => a - b),
        at,
        'the save button comes first: it is about whether the file exists, not how it is read',
    );

    // Drawn, not typed — the glyph came out hairline thin at this size.
    assert.match(source, /saveBtn\.innerHTML = '<svg/, 'the icon is an svg, not a text glyph');

    const css = readFileSync(new URL('../src/styles/content.css', import.meta.url), 'utf8');
    const rule = css.match(/\.file-entry-save \{([^}]*)\}/s)?.[1] || '';
    assert.match(rule, /border-radius:/, 'a framed control, like the gear beside it');
    assert.match(rule, /border: 1px solid/, 'with a visible edge');
    assert.match(rule, /--warning-color/, 'in the orange that draws the eye');
    assert.match(css, /\.file-entry-save svg \{[^}]*fill: currentColor/s, 'so the icon follows that colour');
}

console.log('In-memory file tests passed.');
