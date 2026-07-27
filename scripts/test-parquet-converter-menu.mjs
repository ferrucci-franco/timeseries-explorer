// Converting to Parquet from the menu.
//
//   node scripts/test-parquet-converter-menu.mjs
//
// The conversion used to exist only as an offer that appears when a large file
// is about to be opened, so nobody could find it, try it on something small, or
// use it on a file they were not about to open. This is the same work reached
// deliberately — and the thing most worth pinning is that it IS the same work:
// a second copy of the conversion would drift, which already happened once when
// the "temporary" button's runtime check survived in one dialog and was lost
// from the other.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import translations from '../src/i18n/translations.js';

const LANGS = ['en', 'fr', 'es', 'it'];
let checks = 0;
const check = (fn) => { fn(); checks++; };

const fileMethods = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const uiMethods = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const sheetPicker = readFileSync(new URL('../src/ui/excel-sheet-picker-dialog.js', import.meta.url), 'utf8');
const electronMain = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

const from = (source, marker, length = 6000) => {
    const at = source.indexOf(marker);
    assert.ok(at > 0, `located ${marker}`);
    return source.slice(at, at + length);
};

// ─── It is reachable ──────────────────────────────────────────────────────

check(() => {
    const menu = from(uiMethods, 'proto._renderExtraMenu', 9000);
    assert.match(menu, /'extraConvertToParquet'/, 'the menu has an entry for it');
    assert.match(menu, /this\.convertFileToParquet\(\)/, 'which calls the converter');
    // Grouped with the other file operations rather than lost at the bottom.
    const items = menu.slice(menu.indexOf('const items = ['));
    assert.match(items.slice(0, 200), /loadSessionItem, convertParquetItem/, 'it sits with the other file actions');
});

check(() => {
    assert.match(fileMethods, /proto\.convertFileToParquet = /, 'the entry point exists');
});

// ─── One copy of the conversion, not one per caller ───────────────────────

check(() => {
    const offer = from(fileMethods, 'proto._offerLargeTextConversion', 4600);
    const menu = from(fileMethods, 'proto._convertTextFileFromMenu', 3000);
    assert.match(offer, /_runTextFileParquetConversion\(/, 'the load-time offer runs the shared conversion');
    assert.match(menu, /_runTextFileParquetConversion\(/, 'and so does the menu');
    // Neither may reach past it to the engine on its own.
    for (const [name, body] of [['offer', offer], ['menu', menu]]) {
        assert.ok(!/_convertTextFileToParquetBytes\(/.test(body), `${name} does not convert on its own`);
        assert.ok(!/_convertCsvFileToParquetFile\(/.test(body), `${name} does not call the native converter directly`);
    }
});

check(() => {
    const entry = from(fileMethods, 'proto._convertSpreadsheetEntryToParquet', 2500);
    const menu = from(fileMethods, 'proto._convertSpreadsheetFromMenu', 4000);
    assert.match(entry, /_runSpreadsheetParquetConversion\(/, 'the sheet route from an open file shares its conversion');
    assert.match(menu, /_runSpreadsheetParquetConversion\(/, 'and so does the menu');
});

// ─── What the menu offers, and what it does not ───────────────────────────

check(() => {
    const ask = from(fileMethods, 'proto._askHowToConvert', 2000);
    assert.match(ask, /value: 'review'/, 'the parsing can be reviewed first');
    assert.match(ask, /value: 'convert'/, 'or converted as detected');
    assert.match(ask, /value: 'cancel'/, 'or nothing at all');
    // "Open it as it is" answers a question nobody asked here, and a temporary
    // Parquet exists to make one open faster and is deleted on exit — the
    // opposite of what somebody who came to convert is asking for.
    assert.ok(!/'raw'/.test(ask), 'there is no open-as-text way out');
    assert.ok(!/temporary/.test(ask), 'and no temporary file');
});

check(() => {
    const menu = from(fileMethods, 'proto._convertTextFileFromMenu', 3000);
    const run = menu.indexOf('_runTextFileParquetConversion');
    const offerOpen = menu.indexOf('_offerToOpenConverted');
    assert.ok(run > 0 && offerOpen > run, 'opening is offered after converting, not before');
});

check(() => {
    // Asked at the end so the answer is informed: by then the conversion has
    // succeeded and the parsing has proven itself.
    const offer = from(fileMethods, 'proto._offerToOpenConverted', 1800);
    assert.match(offer, /convertToParquetOpenNow/, 'one button opens it');
    assert.match(offer, /convertToParquetClose/, 'the other just closes');
    assert.match(offer, /this\.loadFiles\(/, 'opening goes through the normal load');
    // In the browser nothing has been written yet, and that question comes
    // first — this dialog would otherwise announce a save that never happened.
    assert.match(offer, /if \(result\.needsSaving\) return this\._deliverConvertedFromMenu\(result\)/,
        'a file still in memory goes to the dialog that saves it');
});

// ─── Saving happens on a click, and says what really happened ─────────────

check(() => {
    // showSaveFilePicker only opens right after a click. The conversion takes
    // tens of seconds, so saving straight after it was refused by the browser,
    // silently fell back to a download, and the "open it now?" question then
    // arrived BEFORE the download's own dialog claiming the file was saved.
    for (const marker of ['proto._runTextFileParquetConversion', 'proto._runSpreadsheetParquetConversion']) {
        const run = from(fileMethods, marker, 3200);
        const browserBranch = run.slice(0, run.indexOf('let outputPath'));
        assert.ok(!/_saveBytesToDisk/.test(browserBranch), `${marker} does not save behind the user's back`);
        assert.match(browserBranch, /needsSaving: true/, `${marker} says the file is still only in memory`);
    }
});

check(() => {
    const deliver = from(fileMethods, 'proto._deliverConvertedParquet', 4200);
    assert.match(deliver, /convertToParquetSaveAndOpen/, 'save and open');
    assert.match(deliver, /convertToParquetSaveOnly/, 'or just save');
    assert.match(deliver, /convertToParquetDiscard/, 'or keep nothing');
    // The save runs on the answer, so the picker still has its activation.
    const ask = deliver.indexOf('Modal.choice');
    const save = deliver.indexOf('_saveBytesToDisk');
    assert.ok(ask > 0 && ask < save, 'the save is started by the answer to the dialog');
    assert.match(deliver, /if \(outcome === 'cancelled'\) continue;/, 'cancelling the save returns to the choices');
    // Only a confirmed write may lead to opening the file.
    assert.match(deliver, /return choice === 'saveOpen';/, 'and opening follows a save that succeeded');
    const menu = from(fileMethods, 'proto._deliverConvertedFromMenu', 400);
    assert.match(menu, /if \(await this\._deliverConvertedParquet\(result, 'menu'\)\)[\s\S]{0,120}loadFiles/,
        'the menu opens the file only when the dialog says so');
});

check(() => {
    // Firefox and Safari give pages no save dialog at all, so the only way to
    // hand a file over is a download — whose outcome this page is never told.
    // Offering "Save and open" there kept half a promise: the download was
    // cancelled and the file opened anyway, from memory, never written.
    const deliver = from(fileMethods, 'proto._deliverConvertedParquet', 4200);
    assert.match(deliver, /const canSave = this\._canUseSaveFilePicker\(\)/, 'what the browser can do is checked first');
    assert.match(deliver, /convertToParquetDownloadReadyBody/, 'and said plainly when it cannot save');
    assert.match(deliver, /value: 'download'/, 'downloading is its own button');
    // Nothing may be chained onto a download.
    const download = deliver.slice(deliver.indexOf("if (choice === 'download')"));
    assert.ok(!/loadFiles|return true/.test(download.slice(0, 400)), 'a download never leads to opening the file');
    assert.match(download.slice(0, 400), /note = /, 'the dialog stays up and says what was done');
});

check(() => {
    // The conversion on the way to opening a file has the same problem, and
    // there opening is not in doubt — only whether the file is kept.
    const deliver = from(fileMethods, 'proto._deliverConvertedParquet', 4200);
    assert.match(deliver, /convertToParquetOpenWithoutSaving/, 'it can be opened without keeping it');
    const offer = from(fileMethods, 'proto._offerLargeTextConversion', 5400);
    assert.match(offer, /result\.needsSaving && !\(await this\._deliverConvertedBeforeLoad\(result\)\)/,
        'the load-time route asks too');
    const sheet = from(fileMethods, 'proto._convertSpreadsheetEntryToParquet', 2500);
    assert.match(sheet, /_deliverConvertedBeforeLoad\(result\)/, 'and so does the sheet route');
    const notice = from(fileMethods, 'proto._convertLargeCsvNoticeToParquet', 3000);
    assert.match(notice, /_deliverConvertedBeforeLoad\(/, 'and so does the one offered from the notice');
});

check(() => {
    // Bounded at the next function on purpose: the point is that THIS one has
    // no download in it.
    const save = from(fileMethods, 'proto._saveBytesToDisk =', 1280);
    assert.match(save, /return 'saved'/, 'a real write is a save');
    assert.match(save, /return 'cancelled'/, 'a cancelled dialog is a cancellation');
    assert.match(save, /return 'failed'/, 'and a refusal is a failure');
    // Silently downloading instead is what hid two bugs in a row.
    assert.ok(!/link\.download/.test(save), 'it does not quietly turn into a download');
    assert.ok(!/return true/.test(save), 'no outcome is claimed that cannot be known');
    const download = from(fileMethods, 'proto._downloadBytes', 800);
    assert.match(download, /return 'downloaded'/, 'a download reports only that it was handed over');
    for (const lang of LANGS) {
        assert.match(translations[lang].convertToParquetDownloadedNote, /\{file\}/, `${lang} names the file`);
        assert.match(translations[lang].parquetSaveFailedBody, /\{file\}/, `${lang} names it when the save fails`);
    }
});

// ─── One file, and only the ones it can actually convert ──────────────────

check(() => {
    const pick = from(fileMethods, 'proto._pickFileToConvert', 2500);
    assert.match(pick, /multiple: false/, 'the browser picker takes one file');
    assert.match(pick, /selectFilePath\b/, 'and the desktop one is the single-file dialog');
    // Opening files for reading stays multi-select; this is a different
    // question, so it must not borrow that input.
    assert.ok(!/file-input/.test(pick), 'it does not reuse the multi-select input');
    assert.match(pick, /CONVERTIBLE_EXTENSIONS/, 'and only offers formats it can convert');
});

check(() => {
    assert.match(fileMethods, /const CONVERTIBLE_EXTENSIONS = [\s\S]{0,120}TEXT_TABLE_EXTENSIONS[\s\S]{0,80}SPREADSHEET_EXTENSIONS/,
        'text tables and spreadsheets, which are the two the app can convert');
    const convert = from(fileMethods, 'proto.convertFileToParquet', 2500);
    assert.match(convert, /convertToParquetUnsupported/, 'anything else is told why it cannot be converted');
    for (const lang of LANGS) {
        // MAT, pickle and netCDF have no converter yet, and the message has to
        // say so rather than leave the user guessing what went wrong.
        assert.match(translations[lang].convertToParquetUnsupported, /MAT/, `${lang} names the formats that have no converter`);
    }
});

check(() => {
    const filters = from(electronMain, 'async function selectResultFilePaths', 900);
    assert.match(filters, /Array\.isArray\(options\.filters\)/, 'a caller can narrow the desktop dialog');
});

// ─── Spreadsheets ─────────────────────────────────────────────────────────

check(() => {
    const menu = from(fileMethods, 'proto._convertSpreadsheetFromMenu', 4000);
    assert.match(menu, /single: true/, 'one sheet, because the converter writes one file');
    assert.match(menu, /confirmLabel: 'convertToParquetRun'/, '"Load" is the wrong verb when nothing is loaded');
    const picker = menu.indexOf('ExcelSheetPickerDialog');
    const preview = menu.indexOf('_openCsvParsingPreviewForFileObject');
    const run = menu.indexOf('_runSpreadsheetParquetConversion');
    assert.ok(picker > 0 && picker < preview, 'the sheet is chosen before its parsing is reviewed');
    assert.ok(preview < run, 'and the parsing before converting');
});

check(() => {
    assert.match(sheetPicker, /single \? 'radio' : 'checkbox'/, 'the picker can be limited to one sheet');
    assert.match(sheetPicker, /i18n\.t\(confirmLabel\)/, 'and can name its own confirm button');
    // A caller that only knows the sheet names must not print "undefined ×
    // undefined" where the row and column counts would be.
    assert.match(sheetPicker, /Number\.isFinite\(sheet\.rowCount\)/, 'missing counts are omitted, not printed');
});

// ─── Cancelling ───────────────────────────────────────────────────────────

check(() => {
    // Cancelling the conversion undoes the conversion, not the decision to
    // convert: both menu routes loop back to the choices.
    const cancelled = from(fileMethods, 'proto._conversionWasCancelled', 900);
    assert.match(cancelled, /parquetConversionCancelledBody/, 'work still running in the background is said out loud');
    for (const marker of ['proto._convertTextFileFromMenu', 'proto._convertSpreadsheetFromMenu']) {
        const body = from(fileMethods, marker, 4000);
        assert.match(body, /if \(await this\._conversionWasCancelled\(result\)\) continue;/, `${marker} returns to the choices`);
    }
});

check(() => {
    // The sheet route had no way out at all; a sheet of the same size takes the
    // same tens of seconds as a text file.
    const run = from(fileMethods, 'proto._runSpreadsheetParquetConversion', 3000);
    assert.match(run, /onCancel: \(\) => controller\.abort\(\)/, 'the in-browser sheet conversion can be cancelled');
    assert.match(run, /signal: controller\.signal/, 'and the engine is told');
});

// ─── Translations ─────────────────────────────────────────────────────────

check(() => {
    const keys = [
        'extraConvertToParquet', 'extraConvertToParquetTooltip', 'convertToParquetTitle',
        'convertToParquetPickTitle', 'convertToParquetBody', 'convertToParquetReviewedBody',
        'convertToParquetRun', 'convertToParquetUnsupported', 'convertToParquetDoneTitle',
        'convertToParquetDoneBody', 'convertToParquetOpenNow', 'convertToParquetClose',
        'convertToParquetReadyBody', 'convertToParquetSaveAndOpen', 'convertToParquetSaveOnly',
        'convertToParquetOpenWithoutSaving', 'convertToParquetDiscard',
        'convertToParquetDownloadReadyBody', 'convertToParquetDownload',
        'convertToParquetDownloadedNote', 'parquetSaveFailedTitle', 'parquetSaveFailedBody',
    ];
    for (const lang of LANGS) {
        for (const key of keys) {
            assert.ok(String(translations[lang][key] || '').trim(), `${lang}.${key} is written`);
        }
        // The size belongs in the question: whether to open a converted file is
        // a different decision at 20 MB and at 2 GB.
        assert.match(translations[lang].convertToParquetBody, /\{file\}[\s\S]*\{size\}/, `${lang} names the file and its size`);
        assert.match(translations[lang].convertToParquetDoneBody, /\{file\}[\s\S]*\{size\}/, `${lang} says where it went and how big it is`);
    }
});

console.log(`parquet converter menu: ${checks} checks passed`);
