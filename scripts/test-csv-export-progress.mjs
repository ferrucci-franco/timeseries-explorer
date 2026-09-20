// Building a large CSV must not look like a hang (#132).
//
// _exportCSV built the whole table in one synchronous pass — a string per row,
// then one join over all of them, then a Blob. Nothing repainted while that
// ran, so a 400 MB table simply froze the window until the save dialog
// appeared a minute later. Measured in a browser on 12 columns x 300k rows,
// three runs each: the old path produced 0 frames every time; the chunked one
// produces 15, at a comparable wall clock (1.9-3.6 s against 2.0-2.9 s — this
// machine is noisy, and the frames are the robust difference).
//
// plot-manager.js imports Plotly, so the writer is sliced out and run against
// doubles, the technique test-fft-clean-range.mjs uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');

const startMarker = '    async _writeCsvFile(headers, columns, fileName) {';
const start = source.indexOf(startMarker);
assert.ok(start >= 0, '_writeCsvFile is present');
const endMarker = '\n    }';
const end = source.indexOf(endMarker, start);
assert.ok(end > start, 'its end is findable');
const method = source.slice(start, end + endMarker.length)
    .replace(startMarker, 'proto.write = async function(headers, columns, fileName) {');

const proto = {};
let written = null;
let downloaded = null;
vm.runInNewContext(method, {
    proto,
    console,
    i18n: { t: key => key, formatNumber: value => String(value) },
    // The real Blob is handed an ARRAY of chunks; recording the parts is what
    // lets the test see that it was never joined into one giant string first.
    Blob: class { constructor(parts, opts) { written = { parts: Array.from(parts), type: opts?.type }; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() { downloaded = this.download; } }) },
});

const makeHost = ({ overlay = null } = {}) => ({
    write: proto.write,
    yields: 0,
    onBusyOverlay: overlay ? (options) => overlay(options) : null,
    _yieldToPaint() { this.yields++; return Promise.resolve(); },
});
const column = (n, prefix = 'x') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const reset = () => { written = null; downloaded = null; };

// ── The file that comes out ─────────────────────────────────────────────────
{
    reset();
    const host = makeHost();
    const name = await host.write(['a', 'b'], [column(3, 'a'), column(3, 'b')], 'out.csv');
    assert.equal(name, 'out.csv');
    assert.equal(downloaded, 'out.csv', 'the browser is handed the file');
    assert.equal(written.type, 'text/csv;charset=utf-8;');
    assert.equal(written.parts.join(''), 'a,b\na0,b0\na1,b1\na2,b2',
        'header first, then one line per row, newline-separated');
}

// A short column is padded, not truncated: the rows have to line up.
{
    reset();
    const host = makeHost();
    await host.write(['a', 'b'], [column(3, 'a'), column(1, 'b')], 'out.csv');
    assert.equal(written.parts.join(''), 'a,b\na0,b0\na1,\na2,',
        'the longest column sets the row count and the rest are left empty');
}

// ── Chunked, and never joined into one string ───────────────────────────────
// That intermediate string is a second full copy of the file, at exactly the
// size where a second copy is what there is no room for.
{
    reset();
    const host = makeHost();
    await host.write(['a'], [column(50000)], 'big.csv');
    assert.ok(written.parts.length > 2,
        `the Blob is given the chunks, not one string (got ${written.parts.length} parts)`);
    assert.equal(host.yields, 2, 'one yield per completed chunk of 20000 rows');
    const text = written.parts.join('');
    assert.equal(text.split('\n').length, 50001, 'every row survives the chunking');
    // `text` is the CSV this writer just built in memory, where the newlines
    // are the ones it emitted itself — not a file read off disk.
    assert.match(text, /^a\nx0\nx1\n/, 'in order, starting at the header'); // crlf-ok: built in memory
    assert.match(text, /\nx49999$/, 'and ending at the last row');
}

// A table that fits in one chunk yields not at all.
{
    reset();
    const host = makeHost();
    await host.write(['a'], [column(500)], 'small.csv');
    assert.equal(host.yields, 0, 'a small export runs straight through');
}

// ── When it says anything at all ────────────────────────────────────────────
// An overlay for a table that takes milliseconds would be a flash with nothing
// readable in it.
{
    reset();
    let opened = 0;
    const host = makeHost({ overlay: () => { opened++; return { progress() {}, close() {} }; } });
    await host.write(['a', 'b'], [column(1000, 'a'), column(1000, 'b')], 'small.csv');
    assert.equal(opened, 0, 'a small export shows nothing');
    assert.equal(downloaded, 'small.csv', 'and still produces the file');
}
{
    reset();
    const progress = [];
    let closed = 0;
    let title = null;
    const host = makeHost({
        overlay: (options) => {
            title = options.title;
            return { progress: text => progress.push(text), close: () => { closed++; } };
        },
    });
    await host.write(['a', 'b', 'c', 'd'], Array.from({ length: 4 }, () => column(120000)), 'big.csv');
    assert.equal(title, 'csvExportBuilding', 'the overlay says what it is doing');
    assert.equal(progress.length, 6, 'and counts, once per chunk');
    assert.equal(progress[0], 'csvExportProgress', 'through a translated string');
    assert.equal(closed, 1, 'and is taken down exactly once');
    assert.equal(downloaded, 'big.csv');
}

// ── Cancelling ──────────────────────────────────────────────────────────────
// Nothing has been written anywhere yet, so there is nothing to undo: the file
// simply never appears.
{
    reset();
    let closed = 0;
    let token = null;
    const host = makeHost({
        overlay: (options) => {
            token = options.token;
            return { progress: () => { token.cancelled = true; }, close: () => { closed++; } };
        },
    });
    // Past the threshold, so the overlay — and therefore the token — exists.
    const name = await host.write(['a'], [column(500000)], 'never.csv');
    assert.equal(name, null, 'a cancelled export produces nothing');
    assert.equal(downloaded, null, 'no download is triggered');
    assert.equal(written, null, 'and no Blob is even built');
    assert.equal(closed, 1, 'the overlay comes down');
    assert.equal(host.yields, 1, 'and the loop stops at the first chance it gets');
}

// The token belongs to the writer, not the caller: an overlay that never sets
// it must not leave the export hanging.
{
    reset();
    const host = makeHost({ overlay: () => ({ progress() {}, close() {} }) });
    assert.equal(await host.write(['a'], [column(500000)], 'ok.csv'), 'ok.csv',
        'an overlay that never cancels does not interfere');
}

// ── Wiring ──────────────────────────────────────────────────────────────────
assert.match(source, /_exportCSV\(panelId, options = \{\}\)[\s\S]*?return this\._writeCsvFile\(headers, columns,/,
    '_exportCSV hands off to the writer');
// A real frame, not a microtask: setTimeout(0) alone lets the loop continue
// without the browser having drawn anything.
assert.match(source, /_yieldToPaint\(\) \{[\s\S]{0,200}?requestAnimationFrame\(\(\) => setTimeout\(resolve, 0\)\)/,
    'the yield waits for a frame, not just for the microtask queue');
// PlotManager owns no UI; the overlay is the app's, reached through a hook.
assert.match(source, /this\.onBusyOverlay = null;/, 'the overlay is an optional app hook');
assert.match(source, /this\.onBusyOverlay\?\.\(/, 'and its absence is not an error');

const app = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
assert.match(app, /this\.plotManager\.onBusyOverlay = \(options\) => this\._showBusyOverlay\(options\);/,
    'the app fills the hook in');

const files = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const busy = files.slice(files.indexOf('proto._showBusyOverlay'));
const busyBody = busy.slice(0, busy.indexOf('\n};'));
assert.match(busyBody, /this\._buildOverlayCancelButton\(/,
    'it reuses the cancel button the loading overlay got in #47');
assert.match(busyBody, /if \(token\?\.cancelled\) return;/,
    'a progress line does not go on counting under a "Cancelling…" title');
assert.match(busyBody, /if \(event\.key !== 'Escape'\) return;[\s\S]{0,180}?cancel\.click\(\)/,
    'Escape goes through the button, so one press cannot cancel silently');

const exportMethods = readFileSync(new URL('../src/plots/methods/export-methods.js', import.meta.url), 'utf8');
assert.match(exportMethods, /await this\._exportCSV\(panelId,/,
    'the dialog waits for the export rather than racing its own teardown');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['csvExportBuilding', 'csvExportProgress']) {
    assert.equal((translations.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 4,
        `${key} is translated in all four languages`);
}
for (const match of translations.matchAll(/csvExportProgress: '([^']*)'/g)) {
    assert.ok(match[1].includes('{done}') && match[1].includes('{total}'),
        'every translation interpolates both counts');
}

console.log('CSV export progress checks passed.');
