// Opening a netCDF or a GRIB: the loading overlay from the start, and a
// cancel that stops the opening itself.
//
// A gridded file was opened (its structure read in the worker) before the
// batch loop that puts the overlay up, and on the desktop it was first copied
// whole from the local file server, also before. On a long GRIB, a slow disk
// or a large file the app then sat with nothing on screen for as long as that
// took, and the map appeared out of nowhere — read as "nothing happens". Then
// the overlay came up there, but without the batch's token: no Cancel button,
// Escape ignored, and the worker, walking the GRIB in one synchronous loop,
// would not have heard a cancel anyway.
//
// The overlay needs a document, so its part is asserted against the source
// and was checked in a browser (overlay with Cancel while the worker opens the
// file, Cancel stopping the walk within a turn, the batch reusing the
// overlay, nothing loaded after a cancel). The worker's part runs here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GriddedDataset } from '../src/gridded/dataset.js';
import { GriddedClient } from '../src/gridded/gridded-client.js';
import { scanGrib, scanGribAsync } from '../src/gridded/grib-reader.js';
import { BufferByteSource } from '../src/gridded/byte-source.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const gridded = read('src/app/methods/gridded-methods.js');
const files = read('src/app/methods/file-methods.js');
const css = read('src/styles/overlays.css');

const body = (source, head) => {
    const start = source.indexOf(head);
    assert.ok(start >= 0, `${head} exists`);
    const rest = source.slice(start);
    return rest.slice(0, rest.search(/\n {0,4}\};\r?\n/));
};

// ── One helper puts it up, with the batch's token ──────────────────────────
const opening = body(gridded, 'proto._griddedShowOpening = async function(name, size, loadToken = null) {');
assert.match(opening, /this\._showFileLoadingOverlay\?\.\(1, loadToken\);/,
    'it shows the overlay with the token: a Cancel button and Escape');
assert.match(opening, /this\._updateFileLoadingOverlay\?\.\(1, 1, name, size\);/, 'naming the file');
assert.match(opening, /await this\._waitForNextPaint\?\.\(\);/,
    'and lets it paint before the worker is asked anything');

// ── Before every read of a gridded file ─────────────────────────────────────
const expand = body(gridded, 'proto._expandNetcdfEntries = async function(entries, loadToken = null) {');
const shown = expand.indexOf('await this._griddedShowOpening(file.name, file.size, loadToken);');
assert.ok(shown > 0, 'opening a candidate file shows the overlay');
assert.ok(shown < expand.indexOf('await this._sniffFileHead(file)'), 'before its head is read');
assert.ok(shown < expand.indexOf('await this._griddedProbe([file], {}, loadToken)'), 'and before it is opened, cancellably');
assert.match(expand, /members\.together\) \{\s*await this\._griddedShowOpening\(file\.name, file\.size, loadToken\);\s*const options = \{ mode: 'merge-variables'[^\n]*\n\s*const result = await this\._griddedProbe\(members\.files, options, loadToken\);/,
    'a CDS ZIP read as one dataset is opened under the overlay, cancellably');
const zip = body(gridded, 'proto._griddedPickZipEntries = async function(file, entries, loadToken = null) {');
assert.match(zip, /await this\._griddedShowOpening\(file\.name, file\.size, loadToken\);/, 'extracting ZIP entries too');
assert.match(zip, /for \(const entry of chosen\) \{\s*if \(loadToken\?\.cancelled\) return null;/, 'and a cancel stops between entries');
const join = body(gridded, 'proto._griddedOfferJoin = async function(opened, loadToken = null) {');
assert.ok(join.indexOf('await this._griddedShowOpening(') > join.indexOf('Modal.confirm('),
    'files joined along time: the overlay after the question');
assert.match(join, /const result = await this\._griddedProbe\(files, options, loadToken\);/, 'the join opened cancellably');
assert.match(join, /catch \(error\) \{\s*\/\/[^\n]*\n\s*if \(loadToken\?\.cancelled\) return opened;/, 'a cancelled join is not reported as an error');

// ── Questions take the overlay down first ───────────────────────────────────
// The overlay's Escape handler listens on the document in the capture phase:
// Escape pressed to close a dialog over it would cancel the whole batch.
assert.match(body(gridded, 'proto._griddedAsk = function(ask) {'), /this\._hideFileLoadingOverlay\?\.\(\);\s*return ask\(\);/,
    'a question asked while opening hides the overlay before it is shown');
for (const source of [expand, zip, join]) {
    for (const call of source.matchAll(/(.{0,40})Modal\.(alert|confirm|checklist)\(/g)) {
        assert.match(call[1], /_griddedAsk\(\(\) => $/, `Modal.${call[2]} goes through _griddedAsk`);
    }
}
const zIndex = selector => Number(css.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{[^}]*?z-index: (\\d+);`))?.[1]);
assert.ok(zIndex('.modal-overlay') > zIndex('.example-loading-overlay'),
    'and a modal is drawn above the overlay in any case');

// ── A cancel stops the batch, and nothing opened is kept ────────────────────
assert.match(expand, /for \(const item of entries \|\| \[\]\) \{\s*if \(cancelled\(\)\) break;/, 'no further file is opened');
assert.match(expand, /\} catch \(error\) \{\s*if \(cancelled\(\)\) break;/, 'a cancelled open is not reported as an error');
assert.match(expand, /if \(cancelled\(\)\) \{\s*for \(const group of joined\) griddedClient\(\)\.close\(group\.result\.datasetId\);\s*return \[\];\s*\}/,
    'datasets already opened are closed and nothing is loaded');
assert.match(body(gridded, 'proto._griddedProbe = async function(files, options, loadToken = null) {'),
    /griddedClient\(\)\.open\(datasetId, files, options, \{ signal: loadToken\?\.signal \|\| null \}\)/,
    'the token reaches the worker as an abort signal');

// ── The batch makes the token first, then takes the overlay over or down ────
const loadFiles = body(files, 'proto.loadFiles = async function(items = []) {');
assert.ok(loadFiles.indexOf('const loadToken = createLoadToken();') < loadFiles.indexOf('this._expandNetcdfEntries(matEntries, loadToken)'),
    'the token exists before the opening');
assert.match(loadFiles, /catch \(err\) \{\s*this\._hideFileLoadingOverlay\(\);\s*throw err;\s*\}\s*if \(loadToken\.cancelled \|\| !entries\.length\) \{\s*this\._hideFileLoadingOverlay\(\);\s*return \[\];\s*\}/,
    'cancelled, or nothing left to load: the overlay comes down');
assert.ok(loadFiles.indexOf('this._showFileLoadingOverlay(entries.length, loadToken);') > loadFiles.indexOf('_expandNetcdfEntries('),
    'the batch shows it after, which reuses the one already up');
assert.match(body(files, 'proto._showFileLoadingOverlay = function(total = 1, loadToken = null) {'),
    /if \(existing\?\.classList\.contains\('show'\)\) \{/, 'a visible overlay is reused, not faded out and in');

// ── Desktop: the copy from the local server, covered and cancellable ───────
const picker = body(files, 'proto._openResultFilesFromUser = async function() {');
assert.ok(picker.indexOf('const copyToken = createLoadToken();') < picker.indexOf('this._showFileLoadingOverlay(paths.length, copyToken);'),
    'the copy has its own token, shown with the overlay');
assert.ok(picker.indexOf('if (this._isDesktopFetchedByPartsExtension(this._fileExtension(localPath))) {') < picker.indexOf('this._showFileLoadingOverlay(paths.length, copyToken);'),
    'for a netCDF, GRIB or ZIP path');
assert.ok(picker.indexOf('await this._waitForNextPaint();') < picker.indexOf('await this._readLocalResultPath(localPath, { signal: copyToken.signal });'),
    'painted before the file is copied, and the copy aborts with the token');
assert.match(picker, /\} catch \(err\) \{\s*if \(copyToken\.cancelled\) return;\s*throw err;\s*\} finally \{[\s\S]{0,200}?this\._hideFileLoadingOverlay\(\);\s*\}/,
    'a cancelled copy ends the open quietly, not with the browser picker; the overlay comes down either way');
assert.match(picker, /\} catch \(err\) \{\s*this\._hideFileLoadingOverlay\(\);\s*console\.warn\('Desktop file picker failed/,
    'and a failure takes it down before the browser picker is offered');
const desktopRead = body(files, 'proto._readLocalResultPath = async function(filePath, { signal = null } = {}) {');
assert.match(desktopRead, /fetch\(`\$\{origin\}\$\{LOCAL_API_BASE\}\/file\?path=\$\{encodeURIComponent\(filePath\)\}`, \{ cache: 'no-store', signal \}\)/,
    'the signal reaches the fetch');
assert.match(desktopRead, /catch \(err\) \{\s*\/\/[^\n]*\n\s*if \(signal\?\.aborted\) throw err;\s*console\.warn\('\[netcdf\] local fetch failed/,
    'an aborted copy is not retried through IPC');

// ── The worker: a long GRIB walked in turns, and a cancel heard ─────────────
// Many copies of a fixture one after another: tens of thousands of messages,
// like a month of hourly fields on a small box.
const fixture = new Uint8Array(readFileSync(new URL('../test-files/grib/era5-grib1-sfc.grib', import.meta.url)));
const copies = 12000;
const long = new Uint8Array(fixture.length * copies);
for (let copy = 0; copy < copies; copy++) long.set(fixture, copy * fixture.length);
const longBuffer = () => long.slice().buffer;

{
    let pauses = 0;
    const walked = await scanGribAsync(new BufferByteSource(long), async () => { pauses += 1; }, 0);
    assert.deepEqual(walked, scanGrib(new BufferByteSource(long)), 'walking in turns reads the same fields');
    assert.ok(pauses >= walked.fields.length / 4 - 1, `it stops between messages (${pauses} pauses)`);
    await assert.rejects(
        () => scanGribAsync(new BufferByteSource(long), async () => { throw new Error('stop'); }, 0),
        /stop/, 'a pause that throws ends the walk');
}

{
    const started = Date.now();
    const whole = await GriddedDataset.open([{ buffer: longBuffer(), filename: 'long.grib' }]);
    const wholeMs = Date.now() - started;
    assert.equal(whole.gridded, true);
    whole.close();

    await assert.rejects(() => GriddedDataset.open([{ buffer: longBuffer(), filename: 'long.grib' }], {}, { cancelled: true }),
        error => error.cancelled === true, 'cancelled before it starts: nothing is read');

    // Cancelled while walking: the walk stops at its next turn (~50 ms).
    const job = { cancelled: false };
    const cancelledAt = Date.now();
    setTimeout(() => { job.cancelled = true; }, 10);
    await assert.rejects(() => GriddedDataset.open([{ buffer: longBuffer(), filename: 'long.grib' }], {}, job),
        error => error.cancelled === true && error.name === 'AbortError', 'cancelled while walking');
    const stoppedMs = Date.now() - cancelledAt;
    if (wholeMs > 300) assert.ok(stoppedMs < wholeMs / 2, `it stops soon (${stoppedMs} ms, the whole walk ${wholeMs} ms)`);
}

// Through the client: the signal a load token carries.
{
    const client = new GriddedClient();
    const file = new File([long], 'long.grib');
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => client.open('cancel-1', [file], {}, { signal: aborted.signal }),
        error => error.cancelled === true, 'an aborted signal: the open does not start');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => client.open('cancel-2', [file], {}, { signal: controller.signal }),
        error => error.cancelled === true, 'aborting the signal stops the open');
    assert.equal(client.datasets.size, 0, 'and nothing is kept open');
    const opened = await client.open('cancel-3', [file], {}, { signal: new AbortController().signal });
    assert.equal(opened.gridded, true, 'a signal never aborted changes nothing');
    await client.close('cancel-3');
}

console.log('Gridded loading overlay tests passed: shown from the start, cancellable, the walk stopped in turns.');
