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

import translations from '../src/i18n/translations.js';

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
    const body = gate.slice(0, 700);
    assert.match(body, /_isExcelExtension\(entry\.extension\)/, 'only spreadsheets');
    // NOT gated on isDesktop. Writing Parquet never needed the desktop build,
    // and gating on it meant the runtime with the LOWER spreadsheet limit —
    // the browser — was also the one with no way out of it.
    assert.doesNotMatch(body, /capabilities\?\.isDesktop/, 'the offer is not restricted to the desktop build');
    assert.match(body, /omvDesktop\?\.convertToParquet[\s\S]{0,80}_canUseDuckDb\(\)/, 'native converter OR the in-browser engine');
});

check(() => {
    // The in-browser conversion: bytes in, bytes out, through the engine the
    // app already ships. Reusing _csvReadExpr is what keeps the two builds from
    // disagreeing about what the data meant.
    const duckdb = readFileSync(new URL('../src/data/duckdb-source.js', import.meta.url), 'utf8');
    assert.match(duckdb, /async convertCsvBufferToParquet/, 'the engine can convert a CSV buffer');
    assert.match(duckdb, /registerFileBuffer/, 'a buffer is registered as a virtual file');
    // Both entry points share one implementation, so a buffer and a File
    // cannot end up converted by subtly different SQL.
    const method = duckdb.slice(duckdb.indexOf('async _convertToParquet'));
    const body = method.slice(0, 2600);
    assert.match(body, /FORMAT PARQUET/, 'and copied out as Parquet');
    assert.match(body, /copyFileToBuffer/, 'then read back as bytes');
    assert.match(body, /this\._csvReadExpr\(/, 'using the same profile-aware reader as every other path');
    assert.match(body, /finally[\s\S]{0,200}dropFile/, 'both virtual files are dropped whatever happens');
});

check(() => {
    // Converting only in memory would make this open faster and every future
    // one exactly as slow as before, which is the opposite of the point.
    const convert = fileMethods.slice(fileMethods.indexOf('proto._runSpreadsheetParquetConversion'));
    assert.match(convert.slice(0, 2600), /_saveBytesToDisk/, 'the browser result is offered for keeping');
    const save = fileMethods.slice(fileMethods.indexOf('proto._saveBytesToDisk'));
    assert.match(save.slice(0, 1200), /showSaveFilePicker/, 'a real save dialog when the browser has one');
    assert.match(save.slice(0, 1200), /AbortError/, 'cancelling the save is not treated as a failure');
    assert.match(save.slice(0, 1200), /link\.download/, 'and a download where it does not');
});

check(() => {
    const convert = fileMethods.slice(fileMethods.indexOf('proto._runSpreadsheetParquetConversion'));
    const body = convert.slice(0, 6000);
    assert.match(body, /bytes: new Uint8Array\(csvBuffer\)/, 'the sheet is sent as bytes, not as a path');
    assert.match(body, /sourceName:/, 'a name is supplied so the staged file is recognisable');
    // Without a source path there is nowhere sensible to put the output "next
    // to", so one of these must always be decided before converting.
    assert.match(body, /outputPath/, 'an explicit destination is chosen');
    assert.match(body, /temporary/, 'or the file is marked temporary');
});

check(() => {
    // Spreadsheets get the same treatment as text files: see how the data was
    // interpreted BEFORE the conversion, not after. The sheet is already CSV by
    // this point, so the questions are identical — which row is the header,
    // which column is time, how numbers are written.
    const convert = fileMethods.slice(fileMethods.indexOf('proto._convertSpreadsheetEntryToParquet'));
    const body = convert.slice(0, 6000);
    const preview = body.indexOf('_openCsvParsingPreviewForFileObject');
    const picker = body.indexOf('selectParquetOutputPath');
    const converted = body.indexOf('await converter(');
    assert.ok(preview > 0, 'the spreadsheet route opens the parsing preview');
    assert.ok(preview < picker, 'the preview comes before choosing a destination');
    assert.ok(preview < converted, 'and before converting');
    assert.match(body.slice(preview, converted), /if \(!reviewed\) return null;/, 'backing out cancels the conversion');
    // The conversion itself lives in _runSpreadsheetParquetConversion, shared
    // with the converter in the menu, so the reviewed profile is what this
    // hands over and what that sends on.
    assert.match(body.slice(preview, converted), /csvProfile: reviewed/, 'the reviewed profile is what gets converted');
    const runner = fileMethods.slice(fileMethods.indexOf('proto._runSpreadsheetParquetConversion'));
    assert.match(runner.slice(0, 6000), /csvProfile: cloneCsvProfileForIpc\(csvProfile\)/, 'and it survives the trip to the main process');
});

check(() => {
    // The preview is fed a bounded sample cut at a line boundary, so a
    // million-row sheet does not push its whole CSV form through the dialog.
    assert.match(fileMethods, /function spreadsheetPreviewSample/, 'the sample is bounded');
    const sample = fileMethods.slice(fileMethods.indexOf('function spreadsheetPreviewSample'));
    assert.match(sample.slice(0, 500), /0x0a/, 'and cut at a newline, never mid-row');
});

check(() => {
    // Offering this on a small sheet costs more attention than it saves.
    assert.match(fileMethods, /SPREADSHEET_PARQUET_HINT_BYTES/, 'there is a size floor for the offer');
    const gate = fileMethods.slice(fileMethods.indexOf('proto._canConvertSpreadsheetToParquet'));
    assert.match(gate.slice(0, 500), /SPREADSHEET_PARQUET_HINT_BYTES/, 'and the gate applies it');
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

check(() => {
    // Both texts around the conversion threshold used to describe the feature
    // as CSV-only, so a reader had no way to learn spreadsheets are covered.
    const spreadsheet = { en: /spreadsheet/i, fr: /feuilles de calcul/i, es: /hojas de calculo/i, it: /fogli di calcolo/i };
    for (const lang of ['en', 'fr', 'es', 'it']) {
        assert.match(translations[lang].compactFormatHelpBody, spreadsheet[lang],
            `${lang}.compactFormatHelpBody says the conversion covers spreadsheets`);
        assert.match(translations[lang].csvCompactHintLimitHelp, spreadsheet[lang],
            `${lang}.csvCompactHintLimitHelp mentions spreadsheets`);
    }
});

check(() => {
    // And the asymmetry has to be stated, not glossed: this setting governs
    // text files. Spreadsheets are offered after loading, at a fixed floor,
    // with no setting of their own — SPREADSHEET_PARQUET_HINT_BYTES.
    const notThisSetting = {
        en: /do not use this setting/i,
        fr: /n utilisent pas ce reglage/i,
        es: /no usan este ajuste/i,
        it: /non usano questa impostazione/i,
    };
    for (const lang of ['en', 'fr', 'es', 'it']) {
        assert.match(translations[lang].csvCompactHintLimitHelp, notThisSetting[lang],
            `${lang} says the threshold does not apply to spreadsheets`);
    }
});

// ─── No route converts without showing the parsing first ──────────────────

check(() => {
    // The blocking dialog always led with "Review structure". The notice
    // button did not, and it is the easiest one to click — a conversion of a
    // misparsed file is worse than no conversion, because the result looks
    // authoritative and the mistake is baked into it.
    const notice = fileMethods.slice(fileMethods.indexOf('proto._convertLargeCsvNoticeToParquet'));
    const body = notice.slice(0, 3200);
    const preview = body.indexOf('_openCsvParsingPreviewForFileObject');
    // Whichever route runs — native converter or in-browser engine — the
    // preview has to come first.
    const inBrowser = body.indexOf('_convertTextFileToParquetBytes');
    const native = body.indexOf('await converter(');
    const convert = Math.min(...[inBrowser, native].filter(i => i > 0));
    assert.ok(preview > 0, 'the notice route opens the parsing preview');
    assert.ok(inBrowser > 0 && native > 0, 'both conversion routes are present');
    // The corner card must be gone before work starts: a close button beside a
    // running conversion asks a question the interface cannot answer.
    assert.match(body.slice(preview, convert), /notice\?\.remove\(\)/, 'the notice is dismissed before converting');
    assert.ok(preview < convert, 'the preview comes first');
    assert.match(body.slice(preview, convert), /if \(!reviewed\) return;/, 'backing out of the preview cancels the conversion');
});

check(() => {
    const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
    const labels = [...translations.matchAll(/convertToParquetAndLoad:\s*'([^']*)'/g)].map(m => m[1]);
    assert.equal(labels.length, 4, 'the notice button is labelled in all four languages');
    assert.ok(labels.every(l => l.length > 8), 'and the labels are real sentences');
});



// ─── Text files convert in the browser too ────────────────────────────────

check(() => {
    // The notice used to show only a command line in the browser, because the
    // button was gated on the native converter AND a real file path. Neither is
    // needed: DuckDB reads a File handle in slices and writes Parquet from it.
    const duckdb = readFileSync(new URL('../src/data/duckdb-source.js', import.meta.url), 'utf8');
    assert.match(duckdb, /async convertCsvFileToParquet/, 'a File can be converted without reading it into memory');
    const method = duckdb.slice(duckdb.indexOf('async convertCsvFileToParquet'));
    assert.match(method.slice(0, 500), /this\.registerFile\(name, file\)/, 'the File is registered as a handle, not buffered');
});

check(() => {
    const hint = fileMethods.slice(fileMethods.indexOf('proto._showLargeCsvParquetHint'));
    const body = hint.slice(0, 1600);
    assert.match(body, /canConvertNatively \|\| \(!!file && this\._canUseDuckDb\(\)\)/,
        'the button appears for the native converter OR the in-browser engine');
    // Showing a terminal command next to a button that does the same thing
    // reads as though the button were the lesser option.
    assert.match(hint, /if \(!canConvertInApp\)[\s\S]{0,260}dismissible-notice-code/,
        'the command line is only shown when the app cannot do it itself');
});

check(() => {
    const convert = fileMethods.slice(fileMethods.indexOf('proto._convertLargeCsvNoticeToParquet'));
    const body = convert.slice(0, 3000);
    assert.match(body, /_convertTextFileToParquetBytes/, 'the browser route converts through the engine');
    assert.match(body, /_saveBytesToDisk/, 'and offers the result for keeping');
    // A missing localPath used to throw before anything else could happen.
    assert.doesNotMatch(body.slice(0, 400), /if \(!file\?\.localPath\) throw/, 'a missing path is no longer fatal');
});

console.log(`spreadsheet to parquet: ${checks} checks passed`);
