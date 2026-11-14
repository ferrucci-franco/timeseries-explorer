// The Web Share helpers behind the export dialog's Share (src/utils/file-share.js).
//
//   node scripts/test-file-share.mjs
//
// Checked with stand-in navigators: Share is offered only where the browser
// can share a file of the type; the share sheet's answers map to what the
// export does next (shared, closed, a tap too long ago, a failure); the file
// handed over carries a plain MIME type a share target recognises.
import assert from 'node:assert/strict';
import { canShareFiles, exportFile, exportMimeType, shareFile } from '../src/utils/file-share.js';

// ── Which files can be shared ───────────────────────────────────────────────
{
    const asked = [];
    const nav = {
        share: async () => {},
        canShare: (data) => { asked.push(data.files[0]); return data.files[0].type !== 'image/svg+xml'; },
    };
    assert.equal(canShareFiles('png', nav), true, 'a PNG where the browser can share images');
    assert.equal(canShareFiles('csv', nav), true, 'a CSV where it can share text files');
    assert.equal(canShareFiles('svg', nav), false, 'not an SVG where it cannot');
    assert.deepEqual(asked.map(file => [file.name, file.type]), [['export.png', 'image/png'], ['export.csv', 'text/csv'], ['export.svg', 'image/svg+xml']],
        'the browser is asked about a file of that very type');
    assert.equal(canShareFiles('xlsx', nav), false, 'a type the export never writes is not asked about');
    assert.equal(canShareFiles('png', { canShare: () => true }), false, 'no navigator.share: nothing to share with (Firefox, Chrome on Linux)');
    assert.equal(canShareFiles('png', { share: async () => {} }), false, 'no navigator.canShare: files cannot be checked, so they are not offered');
    assert.equal(canShareFiles('png', { share: async () => {}, canShare: () => { throw new TypeError('no'); } }), false, 'a browser that throws is one that cannot');
    assert.equal(canShareFiles('png', undefined), false, 'no navigator at all');
}

// ── The file handed over ────────────────────────────────────────────────────
{
    assert.equal(exportMimeType('data.CSV'), 'text/csv');
    assert.equal(exportMimeType('plot.png'), 'image/png');
    assert.equal(exportMimeType('plot.svg'), 'image/svg+xml');
    assert.equal(exportMimeType('notes.txt'), '');
    // The CSV writer's Blob says "text/csv;charset=utf-8;", which not every
    // share target reads as a CSV; the file says plain text/csv.
    const file = exportFile(new Blob(['a,b\n1,2\n'], { type: 'text/csv;charset=utf-8;' }), 'out.csv');
    assert.equal(file.name, 'out.csv');
    assert.equal(file.type, 'text/csv');
    assert.equal(await file.text(), 'a,b\n1,2\n', 'with the same bytes');
}

// ── What the share sheet answers ────────────────────────────────────────────
{
    const file = exportFile(new Blob(['x']), 'p.png');
    const handed = [];
    const ok = { share: async (data) => { handed.push(data); } };
    assert.equal(await shareFile(file, ok), 'shared');
    assert.equal(handed[0].files[0], file, 'the sheet is handed the file');
    assert.equal(handed[0].title, 'p.png', 'named');

    const rejecting = (name) => ({ share: async () => { throw new DOMException('x', name); } });
    assert.equal(await shareFile(file, rejecting('AbortError')), 'cancelled', 'the user closing the sheet is not an error');
    assert.equal(await shareFile(file, rejecting('NotAllowedError')), 'needs-gesture', 'refused for want of a fresh tap: ask for one');
    const failed = await shareFile(file, rejecting('DataError'));
    assert.equal(failed.error?.name, 'DataError', 'anything else is a failure, with its error');

    let called = false;
    const expired = { userActivation: { isActive: false }, share: async () => { called = true; } };
    assert.equal(await shareFile(file, expired), 'needs-gesture', 'where the browser says the tap has expired, it is not even tried');
    assert.equal(called, false);
    const active = { userActivation: { isActive: true }, share: async () => {} };
    assert.equal(await shareFile(file, active), 'shared', 'and with a fresh tap it is');
}

console.log('file share: ok');
