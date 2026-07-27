// Converting a spreadsheet to Parquet.
//
//   node scripts/test-spreadsheet-parquet.mjs
//
// A spreadsheet is decoded from scratch on every open, and that decode is the
// slowest thing the app does — a 126 MB .xlsx measures about 68 seconds, every
// time. The app already turns the chosen sheet into CSV text while loading, so
// the expensive half of a conversion is paid for by the time the file is on
// screen. This checks the plumbing that turns that into a Parquet file.
//
// The awkward part is that the desktop converter reads a PATH, while a sheet
// only exists as bytes in memory. The bytes are staged into a temp file in the
// main process, and that stage must not survive the call.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let checks = 0;
const check = (fn) => { fn(); checks++; };

const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const fileMethods = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

// ─── Main process: staging and cleanup ────────────────────────────────────

check(() => {
    assert.match(mainSource, /function stageBytesForConversion/, 'bytes can be staged for conversion');
    assert.match(mainSource, /options\.bytes/, 'the convert handler accepts bytes as well as a path');
});

check(() => {
    const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('omv:convert-to-parquet'"));
    const body = handler.slice(0, handler.indexOf('app.on('));
    assert.match(body, /finally\s*{/, 'the handler has a finally block');
    assert.match(body, /if \(stagedInput\)[\s\S]{0,120}fsp\.rm\(stagedInput/, 'the staged file is removed whatever happens');
});

check(() => {
    // Missing input must still be rejected — accepting bytes must not turn the
    // path check into "anything goes".
    const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('omv:convert-to-parquet'"));
    assert.match(handler.slice(0, 700), /!rawPath\.trim\(\) && !options\.bytes/, 'one of path or bytes is required');
});

check(() => {
    // The staged name is attacker-influenced (it comes from a sheet name), so
    // it must not be able to escape the staging directory.
    const staging = mainSource.slice(mainSource.indexOf('function stageBytesForConversion'));
    assert.match(staging.slice(0, 600), /replace\(\/\[\^A-Za-z0-9\._-\]\/g, '_'\)/, 'the staged filename is sanitised');
});

// ─── Renderer: when it is offered, and what it sends ──────────────────────

check(() => {
    assert.match(fileMethods, /_canConvertSpreadsheetToParquet/, 'there is a single gate for the offer');
    const gate = fileMethods.slice(fileMethods.indexOf('proto._canConvertSpreadsheetToParquet'));
    assert.match(gate.slice(0, 400), /_isExcelExtension\(entry\.extension\)/, 'only spreadsheets');
    assert.match(gate.slice(0, 400), /capabilities\?\.isDesktop/, 'desktop only: the browser has no converter');
    assert.match(gate.slice(0, 400), /omvDesktop\?\.convertToParquet/, 'and only when the bridge is present');
});

check(() => {
    const convert = fileMethods.slice(fileMethods.indexOf('proto._convertSpreadsheetEntryToParquet'));
    const body = convert.slice(0, 2200);
    assert.match(body, /bytes: new Uint8Array\(csvBuffer\)/, 'the sheet is sent as bytes, not as a path');
    assert.match(body, /sourceName:/, 'a name is supplied so the staged file is recognisable');
    // Without a source path there is nowhere sensible to put the output "next
    // to", so one of these must always be decided before converting.
    assert.match(body, /outputPath/, 'an explicit destination is chosen');
    assert.match(body, /temporary/, 'or the file is marked temporary');
});

check(() => {
    const hint = fileMethods.slice(fileMethods.indexOf('proto._showSpreadsheetParquetHint'));
    const body = hint.slice(0, 1200);
    assert.match(body, /_spreadsheetHintsShown/, 'the offer is made once per file per session');
    assert.match(body, /dismissible-notice/, 'it is a dismissible notice, not a blocking dialog');
});

check(() => {
    // Reuse the cached CSV when it is valid; the whole point is not paying the
    // decode twice.
    const bytes = fileMethods.slice(fileMethods.indexOf('proto._spreadsheetCsvBytes'));
    assert.match(bytes.slice(0, 400), /_hasExcelCsvCache\(entry\)/, 'the load-time CSV cache is reused');
});

check(() => {
    assert.match(preload, /convertToParquet: options =>/, 'the bridge forwards the whole options object');
});

// ─── Wording ──────────────────────────────────────────────────────────────

check(() => {
    const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
    for (const key of ['spreadsheetParquetHintTitle', 'spreadsheetParquetHintBody', 'spreadsheetParquetHintConvert']) {
        const count = [...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length;
        assert.equal(count, 4, `${key} is translated in all four languages`);
    }
});

// ─── No route converts without showing the parsing first ──────────────────

check(() => {
    // The blocking dialog always led with "Review structure". The notice
    // button did not, and it is the easiest one to click — a conversion of a
    // misparsed file is worse than no conversion, because the result looks
    // authoritative and the mistake is baked into it.
    const notice = fileMethods.slice(fileMethods.indexOf('proto._convertLargeCsvNoticeToParquet'));
    const body = notice.slice(0, 1800);
    const preview = body.indexOf('_openCsvParsingPreviewForFileObject');
    const convert = body.indexOf('await converter(');
    assert.ok(preview > 0, 'the notice route opens the parsing preview');
    assert.ok(convert > 0, 'and then converts');
    assert.ok(preview < convert, 'the preview comes first');
    assert.match(body.slice(preview, convert), /if \(!reviewed\) return;/, 'backing out of the preview cancels the conversion');
});

check(() => {
    const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
    const labels = [...translations.matchAll(/convertToParquetAndLoad:\s*'([^']*)'/g)].map(m => m[1]);
    assert.equal(labels.length, 4, 'the notice button is labelled in all four languages');
    assert.ok(labels.every(l => l.length > 8), 'and the labels are real sentences');
});

console.log(`spreadsheet to parquet: ${checks} checks passed`);
