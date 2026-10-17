// Opening a netCDF or a GRIB shows the loading overlay from the start.
//
// A gridded file was opened (its structure read in the worker) before the
// batch loop that puts the overlay up, and on the desktop it was first copied
// whole from the local file server, also before. On a long GRIB, a slow disk
// or a large file the app then sat with nothing on screen for as long as that
// took, and the map appeared out of nowhere — read as "nothing happens".
//
// The overlay needs a document, so the order is asserted against the source
// and was checked in a browser (overlay shown while the worker opens the file,
// reused by the batch, gone with the map shown, and gone when the only file
// picked turns out not to be data).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

// ── One helper puts it up, and waits for it to be painted ───────────────────
const opening = body(gridded, 'proto._griddedShowOpening = async function(name, size) {');
assert.match(opening, /this\._showFileLoadingOverlay\?\.\(1\);/, 'it shows the overlay');
assert.match(opening, /this\._updateFileLoadingOverlay\?\.\(1, 1, name, size\);/, 'naming the file');
assert.match(opening, /await this\._waitForNextPaint\?\.\(\);/,
    'and lets it paint before the worker is asked anything');

// ── Before every read of a gridded file ─────────────────────────────────────
const expand = body(gridded, 'proto._expandNetcdfEntries = async function(entries) {');
const shown = expand.indexOf('await this._griddedShowOpening(file.name, file.size);');
assert.ok(shown > 0, 'opening a candidate file shows the overlay');
assert.ok(shown < expand.indexOf('await this._sniffFileHead(file)'), 'before its head is read');
assert.ok(shown < expand.indexOf('await this._griddedProbe([file], {})'), 'and before it is opened');
// The ZIP picker takes its own overlay down; the entries read as one
// dataset are then opened under it again.
assert.match(expand, /members\.together\) \{\s*await this\._griddedShowOpening\(file\.name, file\.size\);\s*const options = \{ mode: 'merge-variables'/,
    'a CDS ZIP read as one dataset is opened under the overlay');
const join = body(gridded, 'proto._griddedOfferJoin = async function(opened) {');
assert.ok(join.indexOf('await this._griddedShowOpening(') > join.indexOf('await Modal.confirm('),
    'files joined along time: the overlay after the question, before the join is opened');
assert.ok(join.indexOf('await this._griddedShowOpening(') < join.indexOf("await this._griddedProbe(files, options)"),
    'and before the joined dataset is opened');

// The questions asked meanwhile stay usable: modals are drawn above it.
const zIndex = selector => Number(css.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{[^}]*?z-index: (\\d+);`))?.[1]);
assert.ok(zIndex('.modal-overlay') > zIndex('.example-loading-overlay'),
    'a modal opened while the overlay is up is drawn above it');

// ── The batch takes it over, or takes it down ───────────────────────────────
const loadFiles = body(files, 'proto.loadFiles = async function(items = []) {');
assert.match(loadFiles, /catch \(err\) \{\s*this\._hideFileLoadingOverlay\(\);\s*throw err;\s*\}\s*if \(!entries\.length\) \{\s*this\._hideFileLoadingOverlay\(\);\s*return \[\];\s*\}/,
    'nothing left to load (not data, a cancelled ZIP picker): the overlay comes down');
assert.ok(loadFiles.indexOf('this._showFileLoadingOverlay(entries.length, loadToken);') > loadFiles.indexOf('_expandNetcdfEntries('),
    'the batch shows it after, which reuses the one already up');
assert.match(body(files, 'proto._showFileLoadingOverlay = function(total = 1, loadToken = null) {'),
    /if \(existing\?\.classList\.contains\('show'\)\) \{/, 'a visible overlay is reused, not faded out and in');

// ── Desktop: the copy from the local server is covered too ──────────────────
const picker = body(files, 'proto._openResultFilesFromUser = async function() {');
const guard = picker.indexOf('if (this._isDesktopFetchedByPartsExtension(this._fileExtension(localPath))) {');
assert.ok(guard > 0, 'a netCDF, GRIB or ZIP path picked on the desktop');
assert.ok(guard < picker.indexOf('this._showFileLoadingOverlay(paths.length);'), 'puts the overlay up');
assert.ok(picker.indexOf('await this._waitForNextPaint();') < picker.indexOf('await this._readLocalResultPath(localPath);'),
    'painted before the file is copied');
assert.match(picker, /\} catch \(err\) \{\s*this\._hideFileLoadingOverlay\(\);\s*console\.warn\('Desktop file picker failed/,
    'and a failure takes it down before the browser picker is offered');

console.log('Gridded loading overlay tests passed.');
