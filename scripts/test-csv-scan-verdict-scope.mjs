// What the FILE said about its columns must not outlive the read that produced
// it (#312).
//
// Loading a CSV scans every row for the columns its sample could not type, and
// writes the verdict onto the profile (scannedNumericColumns /
// scannedTextColumns) so the rest of that load agrees with it. The profile is
// then handed back for a SECOND read in three places, and in all three the
// bytes or the layout may have moved under it:
//
//   * Reload — the file changed; that is what Reload is for.
//   * A project reopened later, against a file that has since grown.
//   * The parsing dialog, where changing the delimiter or the header row
//     renumbers the columns the verdict was about.
//
// Carried along, a stale verdict reads a column that now holds text as numbers,
// or the other way round — the bug the scan was added to fix, coming back
// through the door. The scan is one query; running it again is cheaper.
//
// What the reader chose by hand survives all of it: a choice is about meaning,
// not about bytes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import CsvParser from '../src/parsers/csv-parser.js';
import MatParser from '../src/parsers/mat-parser.js';
import CsvParsingPreviewDialog from '../src/ui/csv-parsing-preview-dialog.js';
import { csvProfileWithoutScan } from '../src/parsers/csv-column-types.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';
import { installSessionMethods } from '../src/app/methods/session-methods.js';

// ── The helper itself ───────────────────────────────────────────────────────

const full = {
    profileSource: 'user',
    delimiter: ',',
    forcedNumericColumns: [3],
    forcedTextColumns: [2],
    numericColumnIndexes: [0, 1, 3],
    scannedNumericColumns: [3],
    scannedTextColumns: [4],
    previewEmptyColumns: [3, 4],
};
const stripped = csvProfileWithoutScan(full);
assert.deepEqual(Object.keys(stripped).sort(), [
    'delimiter', 'forcedNumericColumns', 'forcedTextColumns', 'numericColumnIndexes', 'profileSource',
], 'the file\'s own verdict goes, everything else stays');
assert.deepEqual(stripped.forcedTextColumns, [2], 'a choice is not a verdict');
assert.deepEqual(full.scannedNumericColumns, [3], 'and the profile handed in is not modified');
assert.equal(csvProfileWithoutScan(null), null);
assert.equal(csvProfileWithoutScan(undefined), undefined);

// ── The parsing dialog does not inherit it ──────────────────────────────────

const CSV = ['time,ELY_V,ID,BATT_I', ...Array.from({ length: 10 }, (_, i) =>
    `${i},${(220 + i / 10).toFixed(3)},00${i + 1},`)].join('\n') + '\n';
const bytes = new TextEncoder().encode(CSV);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parser = new CsvParser(new MatParser());

// The profile of a previous load: the reader chose text for the codes, and the
// scan settled the channel that was empty everywhere.
const loaded = {
    ...parser.inspectSample(buffer, { maxRows: 50 }),
    profileSource: 'user',
    columnOverrides: { 2: { type: 'text' } },
    scannedNumericColumns: [3],
    scannedTextColumns: [],
    previewEmptyColumns: [3],
};
const dialog = new CsvParsingPreviewDialog({
    parser, sampleBuffer: buffer, csvProfile: loaded, title: 'scope.csv',
});
dialog.preview = parser.inspectPreview(buffer, {
    maxRows: 20, delimiter: dialog.state.delimiter, encoding: dialog.state.encoding,
});
dialog._rebuildProfile();

assert.equal(dialog.resultProfile.scannedNumericColumns, undefined,
    'the dialog hands on no verdict of its own: the next load asks the file again');
assert.equal(dialog.resultProfile.scannedTextColumns, undefined);
assert.deepEqual(dialog.resultProfile.forcedTextColumns, [2], 'the choice it was opened with survives');
assert.deepEqual(dialog.resultProfile.previewEmptyColumns, [3],
    'and the preview says again, for itself, which columns it could not type');

// ── A saved project carries the choice, not the verdict ─────────────────────

class SessionHarness {
    constructor(csvProfile) {
        this.files = new Map([['f1', {
            name: 'scope', extension: '.csv', buffer: null,
            file: new File([CSV], 'scope.csv'), contentHash: 'fingerprint', transform: {},
        }]]);
        this.plotManager = {
            files: new Map([['f1', { data: { variables: { x: {} }, metadata: { csvProfile } }, invertedVariables: new Set() }]]),
            plots: new Map(),
            activeFileId: 'f1',
            syncAxes: true, syncHover: false, hoverInfoCorner: 'bl', hoverProximity: true,
            legendPosition: 'overlay', legendOverlayCorner: 'tl', mouseWheelZoom: true,
            timeseriesVisualMaxPoints: 2000, phaseVisualMaxPoints: 4000,
        };
        this.layoutManager = { root: { type: 'panel', id: 'panel-1' } };
        this.derivedByFile = new Map();
        this.theme = 'light';
        this.language = 'en';
        this.showDescriptions = false;
        this.sortAlphabetical = true;
        this.scrollablePlotArea = false;
        this.mouseWheelZoom = true;
        this.reloadAsNewVersionMode = false;
        this.activeFileId = 'f1';
        this.download = null;
    }

    _fileDisplayName(entry) { return `${entry.name}${entry.extension}`; }
    _fileExtension(name) { return String(name).match(/\.[^.]+$/)?.[0]?.toLowerCase() || ''; }
    _fileBaseName(name) { return String(name).replace(/\.[^.]+$/, ''); }
    _normalizeFileTransform(value) { return value || {}; }
    _readLatestBuffer() { throw new Error('No fallback buffer'); }
}
installSessionMethods(SessionHarness);
SessionHarness.prototype._downloadBlob = function(blob, name) { this.download = { blob, name }; };

const harness = new SessionHarness({
    ...loaded,
    forcedNumericColumns: [],
    forcedTextColumns: [2],
    numericColumnIndexes: [0, 1, 3],
});
assert.equal(await harness.saveProjectSession(), true);
const zip = unzipSync(new Uint8Array(await harness.download.blob.arrayBuffer()));
const saved = JSON.parse(strFromU8(zip['session.json'])).files[0].csvProfile;
assert.deepEqual(saved.forcedTextColumns, [2], 'the project remembers what the reader asked for');
assert.equal(saved.scannedNumericColumns, undefined,
    'but not what a scan of that morning\'s bytes found');
assert.equal(saved.scannedTextColumns, undefined);
assert.equal(saved.previewEmptyColumns, undefined);
assert.deepEqual(saved.columnOverrides, { 2: { type: 'text' } }, 'the choice travels as the override too');

// ── And neither Reload path carries it ──────────────────────────────────────
// Both reloads re-read a file that has just changed, through the profile of the
// previous read. They ask one accessor for it, so there is one place to get the
// rule right.

class ReloadHarness {
    constructor(csvProfile) {
        this.plotManager = {
            files: new Map([['f1', { data: { variables: {}, metadata: { csvProfile } } }]]),
        };
    }
}
installFileMethods(ReloadHarness);

const forReparse = new ReloadHarness({
    ...loaded,
    forcedNumericColumns: [],
    forcedTextColumns: [2],
})._storedCsvProfileForReparse('f1');
assert.deepEqual(forReparse.forcedTextColumns, [2], 'the reload keeps what the reader chose');
assert.equal(forReparse.scannedNumericColumns, undefined, 'and asks the new bytes again');
assert.equal(forReparse.scannedTextColumns, undefined);
assert.equal(forReparse.previewEmptyColumns, undefined);
assert.equal(forReparse.delimiter, loaded.delimiter, 'everything else about how to read it is still there');

assert.equal(new ReloadHarness({ ...loaded, profileSource: 'auto' })._storedCsvProfileForReparse('f1'), null,
    'a profile nobody confirmed is re-detected from scratch, as before');
assert.equal(new ReloadHarness(null)._storedCsvProfileForReparse('f1'), null);
assert.equal(new ReloadHarness({})._storedCsvProfileForReparse('nope'), null, 'and an unknown file is no profile');

// Nothing else in file-methods may take the stored profile and hand it to a
// parse. Reading it is fine for a question about it, and the parsing dialog is
// given the whole thing on purpose — it needs the row filter and the overrides,
// and strips the verdict itself. A new reader of it, though, is a new way for a
// stale verdict to reach a re-read, so each one is named here.
const fileMethods = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const storedReads = fileMethods.split('\n')
    .map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter(({ text }) => /metadata\??\.csvProfile/.test(text));
const known = [
    { text: "const stored = this.plotManager.files.get(fileId)?.data?.metadata?.csvProfile || null;", why: 'the accessor itself' },
    { text: "const currentProfile = this.plotManager.files.get(sourceId)?.data?.metadata?.csvProfile || null;", why: 'asks whether a row filter is set' },
    { text: "csvProfile: entry.data?.metadata?.csvProfile || null,", why: 'opens the dialog on a spreadsheet sheet' },
    { text: "const currentProfile = plotEntry?.data?.metadata?.csvProfile || null;", why: 'opens the dialog on a text file' },
    { text: "if (data?.metadata && csvProfile) data.metadata.csvProfile = csvProfile;", why: 'writes it after a load' },
];
for (const read of storedReads) {
    assert.ok(known.some(entry => entry.text === read.text),
        `file-methods.js:${read.number} takes the stored parsing profile: ${read.text}\n`
        + '    If it re-reads the file, take it from _storedCsvProfileForReparse instead, so the\n'
        + "    previous scan's verdict cannot ride along; then name it here.");
}
assert.equal(storedReads.length, known.length, 'one of the known readers is gone; check the rule still holds');

console.log('CSV scan verdict scope OK');
