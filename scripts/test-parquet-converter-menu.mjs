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

// ─── It converts, and stops there ─────────────────────────────────────────

check(() => {
    // The converter used to end by offering to open the result, and that offer
    // was the source of every problem this feature had: opening the file was
    // the one step that worked whether or not it had been written, so it
    // papered over a save that had failed, been cancelled, or been handed to a
    // download nobody could vouch for. Somebody who wanted the file opens it
    // the normal way.
    for (const marker of ['proto._convertTextFileFromMenu', 'proto._convertSpreadsheetFromMenu']) {
        const menu = from(fileMethods, marker, 4000);
        assert.match(menu, /_reportConversionDone\(result\)/, `${marker} says what it produced`);
        assert.ok(!/loadFiles|loadFile\(/.test(menu), `${marker} does not open the result`);
    }
    const report = from(fileMethods, 'proto._reportConversionDone', 900);
    assert.ok(!/Modal\.choice/.test(report), 'and asks nothing');
    assert.match(report, /convertToParquetDownloadedBody/, 'a download is called a download');
});

check(() => {
    // Destination first. A save dialog only opens right after a click, so
    // asked here it works and asked after a conversion it is refused — which
    // is what produced a silent download and a file announced as saved when
    // nothing had been written.
    for (const marker of ['proto._runTextFileParquetConversion', 'proto._runSpreadsheetParquetConversion']) {
        const run = from(fileMethods, marker, 3400);
        const pick = run.indexOf('_pickBrowserParquetDestination');
        const convert = run.search(/_convertTextFileToParquetBytes|convertCsvBufferToParquet/);
        const write = run.indexOf('_writeToBrowserDestination');
        assert.ok(pick > 0, `${marker} chooses a destination`);
        assert.ok(pick < convert, `${marker} chooses it before converting`);
        assert.ok(convert < write, `${marker} writes after converting`);
    }
});

check(() => {
    const pick = from(fileMethods, 'proto._pickBrowserParquetDestination', 1200);
    assert.match(pick, /return 'download'/, 'a browser with no save dialog downloads instead');
    assert.match(pick, /if \(err\?\.name === 'AbortError'\) return null;/, 'and backing out is backing out');
    // Accepting the dialog creates the file, so a conversion cancelled after
    // that leaves an empty one under a name the user chose.
    const abandon = from(fileMethods, 'proto._abandonBrowserDestination', 500);
    assert.match(abandon, /destination\.remove\?\.\(\)/, 'a cancelled conversion tries to take its empty file with it');
});

// ─── Translations ─────────────────────────────────────────────────────────

check(() => {
    const keys = [
        'extraConvertToParquet', 'extraConvertToParquetTooltip', 'convertToParquetTitle',
        'convertToParquetPickTitle', 'convertToParquetBody', 'convertToParquetReviewedBody',
        'convertToParquetRun', 'convertToParquetUnsupported', 'convertToParquetDoneTitle',
        'convertToParquetDoneBody', 'convertToParquetDownloadedBody',
    ];
    for (const lang of LANGS) {
        for (const key of keys) {
            assert.ok(String(translations[lang][key] || '').trim(), `${lang}.${key} is written`);
        }
        assert.match(translations[lang].convertToParquetBody, /\{file\}[\s\S]*\{size\}/, `${lang} names the file and its size`);
        assert.match(translations[lang].convertToParquetDoneBody, /\{file\}[\s\S]*\{size\}/, `${lang} says where it went and how big it is`);
        // Short on purpose. The dialogs this replaced took a paragraph to
        // explain a distinction the user did not need to care about.
        assert.ok(translations[lang].convertToParquetDoneBody.length < 60, `${lang} keeps it to one line`);
    }
});

console.log(`parquet converter menu: ${checks} checks passed`);
