// Files the app builds rather than reads have nothing on disk behind them, and
// nothing in the files list used to say so: a resampled file looked exactly like
// a loaded one and vanished when the tab closed. These tests cover the two
// halves of the answer — the row states it, and the row can resolve it.
import assert from 'node:assert/strict';
import i18n from '../src/i18n/index.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';
import { installSessionMethods } from '../src/app/methods/session-methods.js';

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
    assert.equal(await h.saveInMemoryFile('f2'), false, 'nothing to serialize, nothing to save');
    assert.equal(await h.saveInMemoryFile('nope'), false, 'an unknown file id is not an error');
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

console.log('In-memory file tests passed.');
