// Which files count as delimited text, and therefore get the Parquet
// conversion offer.
//
//   node scripts/test-text-file-formats.mjs
//
// The offer used to require the literal extension `.csv`, even though the
// reader itself never checked and happily parsed anything that sniffed as text.
// A 900 MB `.txt` measurement log was left with no way to convert it. What
// matters most here is the other direction: a binary container must never be
// classified as text, because that is how a `.mat` would end up being fed to a
// CSV parser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    AUDIO_EXTENSIONS,
    BINARY_EXTENSIONS,
    classifyExtension,
    isAudioExtension,
    isTextTableExtension,
    mayBeTextTable,
    TEXT_TABLE_EXTENSIONS,
} from '../src/app/text-file-formats.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

check(() => {
    for (const extension of TEXT_TABLE_EXTENSIONS) {
        assert.equal(classifyExtension(extension), 'text', extension);
        assert.equal(isTextTableExtension(extension), true, extension);
        assert.equal(mayBeTextTable(extension), true, extension);
    }
});

check(() => {
    // The important direction: these must never reach the text path.
    for (const extension of BINARY_EXTENSIONS) {
        assert.equal(classifyExtension(extension), 'binary', extension);
        assert.equal(mayBeTextTable(extension), false, extension);
    }
});

check(() => {
    // Every format with its own reader must be classified binary, or the
    // conversion offer would appear over a file it cannot convert.
    for (const extension of ['.mat', '.pkl', '.pickle', '.nc', '.netcdf', '.xlsx', '.xlsm', '.xls', '.ods', '.parquet']) {
        assert.equal(mayBeTextTable(extension), false, `${extension} has a dedicated reader`);
    }
});

check(() => {
    // Audio has its own reader, so it must never be offered the Parquet
    // conversion and must never be sniffed as text. Before it was on the binary
    // list, an .mp3 was an unrecognised extension: mayBeTextTable let it
    // through and a 6 MB recording was offered as a table to convert.
    for (const extension of AUDIO_EXTENSIONS) {
        assert.equal(isAudioExtension(extension), true, extension);
        assert.equal(classifyExtension(extension), 'binary', extension);
        assert.equal(mayBeTextTable(extension), false, extension);
        assert.ok(BINARY_EXTENSIONS.includes(extension), `${extension} is on the binary list`);
    }
    assert.equal(isAudioExtension('.MP3'), true, 'extensions are matched case-insensitively');
    assert.equal(isAudioExtension('.csv'), false);
    assert.equal(isAudioExtension(''), false);
});

check(() => {
    // The formats people actually arrive with. Phone voice memos are the case
    // this list exists for.
    for (const extension of ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.3gp', '.amr', '.webm']) {
        assert.ok(AUDIO_EXTENSIONS.includes(extension), `${extension} is accepted`);
    }
});

check(() => {
    // Unknown is not binary. Refusing unrecognised extensions is what forced
    // people to rename files to get the app to look at them.
    for (const extension of ['.foo', '.measurement', '.000', '']) {
        assert.equal(classifyExtension(extension), 'unknown', extension || '(none)');
        assert.equal(mayBeTextTable(extension), true, extension || '(none)');
        assert.equal(isTextTableExtension(extension), false, `${extension || '(none)'} is not a KNOWN text extension`);
    }
});

check(() => {
    for (const extension of ['.CSV', '.TXT', '.MAT', '.XLSX']) {
        assert.equal(classifyExtension(extension), classifyExtension(extension.toLowerCase()), extension);
    }
});

check(() => {
    assert.equal(classifyExtension(null), 'unknown');
    assert.equal(classifyExtension(undefined), 'unknown');
    assert.equal(mayBeTextTable(undefined), true);
});

check(() => {
    // The two lists must not overlap, or classification would depend on
    // lookup order.
    const overlap = TEXT_TABLE_EXTENSIONS.filter(e => BINARY_EXTENSIONS.includes(e));
    assert.deepEqual(overlap, [], 'no extension is both text and binary');
});

// ─── Wiring ───────────────────────────────────────────────────────────────

check(() => {
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const gate = source.slice(source.indexOf('_shouldOfferLargeCsvPreflight'));
    assert.match(gate.slice(0, 900), /mayBeTextTable\(extension\)/, 'the conversion offer gates on text-ness, not on ".csv"');
    assert.doesNotMatch(gate.slice(0, 900), /extension !== '\.csv'/, 'the literal .csv requirement is gone');
});

check(() => {
    // The user-facing wording should no longer claim the feature is CSV-only.
    const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
    const titles = [...translations.matchAll(/largeCsvPreflightTitle:\s*'([^']*)'/g)].map(m => m[1]);
    assert.equal(titles.length, 4, 'all locales define the preflight title');
    assert.ok(titles.every(t => !/\bCSV\b/.test(t)), `titles still say CSV: ${titles.join(' | ')}`);
});

check(() => {
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const canParse = source.slice(source.indexOf('proto._canParseFromFile'));
    // KNOWN text only for streaming. An unknown extension has to be read so
    // _parseResultBuffer can sniff it; skipping the read leaves nothing to
    // sniff, and the file would be reported as unrecognised.
    assert.match(canParse.slice(0, 500), /isTextTableExtension\(extension\)/, 'streaming covers known text extensions');
    assert.doesNotMatch(canParse.slice(0, 500), /mayBeTextTable/, 'unknown extensions are NOT streamed');
});

check(() => {
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const dispatch = source.slice(source.indexOf('proto._parseResultBuffer'), source.indexOf('proto._matlabEagerLimitBytes'));
    // Known text is routed by extension. It may have been left unread on
    // purpose, so a sniff-first dispatch would see a null buffer and fail.
    const byExtension = dispatch.indexOf('isTextTableExtension(extension)');
    const bySniff = dispatch.indexOf('_looksLikeTextBuffer(buffer)');
    assert.ok(byExtension > 0 && bySniff > 0, 'both dispatch paths exist');
    assert.ok(byExtension < bySniff, 'extension routing comes before byte sniffing');
});

console.log(`text file formats: ${checks} checks passed`);
