// Files that used to fail to open at all, from PLCs, data loggers and old
// Windows tools: the wrong encoding, invisible characters, stray quotes, a
// delimiter at the end of every row, rows missing a cell, numbers grouped in
// thousands, dates written with month names, weekdays and comma milliseconds.
// And the parsing dialog's options for them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import CsvParser from '../src/parsers/csv-parser.js';
import {
    customDatetimePatternInfo,
    describeDatetimeValues,
    describeTimeSourcePattern,
    detectCsvTimeAxis,
    parseCsvNumber,
    parseCsvTimeValue,
} from '../src/parsers/csv-time-detection.js';
import {
    csvNumberFormat,
    decodeCsvBytes,
    detectCsvNumberFormat,
    fitCsvRowToWidth,
    sanitizeCsvText,
} from '../src/parsers/csv-text-normalize.js';
import {
    csvNumericCastSql,
    csvReadRepairOptions,
    csvRepairProjectionSql,
} from '../src/data/csv-sql-normalize.js';
import CsvParsingPreviewDialog from '../src/ui/csv-parsing-preview-dialog.js';

const parser = new CsvParser();
const utf8 = text => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const utf16 = (text, { bigEndian = false, bom = true } = {}) => {
    const out = new Uint8Array((bom ? 2 : 0) + text.length * 2);
    let o = 0;
    if (bom) { out[o++] = bigEndian ? 0xFE : 0xFF; out[o++] = bigEndian ? 0xFF : 0xFE; }
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[o++] = bigEndian ? c >> 8 : c & 0xFF;
        out[o++] = bigEndian ? c & 0xFF : c >> 8;
    }
    return out.buffer;
};
const latin1 = text => Uint8Array.from(text, ch => ch.charCodeAt(0)).buffer;
const values = (data, name) => Array.from(data.variables[name].data);

// ─── Encodings ─────────────────────────────────────────────────────────────
{
    const text = 'Temps;Température\n0;20,5\n1;21,5\n2;22,5\n';
    for (const [label, buffer, encoding] of [
        ['UTF-16 LE with BOM', utf16(text), 'utf-16le'],
        ['UTF-16 BE with BOM', utf16(text, { bigEndian: true }), 'utf-16be'],
        ['UTF-16 LE without BOM', utf16(text, { bom: false }), 'utf-16le'],
        ['UTF-8 with BOM', utf8('\uFEFF' + text), 'utf-8'],
        ['Windows-1252', latin1(text), 'windows-1252'],
    ]) {
        const decoded = decodeCsvBytes(buffer);
        assert.equal(decoded.encoding, encoding, label);
        assert.equal(decoded.text, text, `${label}: decoded exactly`);
        const data = await parser.parse(buffer);
        assert.deepEqual(values(data, 'Température'), [20.5, 21.5, 22.5], `${label}: parsed`);
        assert.equal(data.metadata.encoding, encoding);
    }

    // A preview sample cut in the middle of a multi-byte character is still
    // UTF-8: it used to fall back to Windows-1252 and garble every accent.
    const full = new Uint8Array(utf8('Zeit,Wärme\n' + '1,ü\n'.repeat(10) + '2,é'));
    const cut = full.slice(0, full.length - 1).buffer;
    const decoded = decodeCsvBytes(cut);
    assert.equal(decoded.encoding, 'utf-8', 'a character cut by the sample end does not change the encoding');
    assert.match(decoded.text, /^Zeit,Wärme\r?\n1,ü/);

    // Mostly UTF-8 with one damaged byte: UTF-8, not Windows-1252.
    const damaged = new Uint8Array([...new Uint8Array(utf8('a,b\n' + '1,é\n'.repeat(20))), 0xFF, 0x0A]);
    assert.equal(decodeCsvBytes(damaged.buffer).encoding, 'utf-8');

    // A chosen encoding is used as is.
    assert.equal(decodeCsvBytes(latin1('a;b\n1;é\n'), 'windows-1252').text, 'a;b\n1;é\n');
}

// ─── Invisible characters ──────────────────────────────────────────────────
{
    const dirty = 'time,pressure,flow\n'
        + '0,\u200B1.5,\u00002.5\n'
        + '1,\uFEFF1.6,2.6\u0000\u0000\n'
        + '2,1.\u00AD7,\u20602.7\n';
    const cleaned = sanitizeCsvText(dirty);
    assert.equal(cleaned.removed, 7);
    assert.equal(cleaned.text, 'time,pressure,flow\n0,1.5,2.5\n1,1.6,2.6\n2,1.7,2.7\n');
    const data = await parser.parse(utf8(dirty));
    assert.deepEqual(values(data, 'pressure'), [1.5, 1.6, 1.7], 'zero-width space, BOM and soft hyphen do not make text');
    assert.deepEqual(values(data, 'flow'), [2.5, 2.6, 2.7], 'NUL padding does not make text');
    assert.equal(data.metadata.removedInvisibleChars, 7);
    const profile = parser.inspectSample(utf8(dirty));
    assert.equal(profile.removedInvisibleChars, 7, 'the profile says so, for the DuckDB path');
    assert.equal(sanitizeCsvText('a,b\n1,2\n').removed, 0);
}

// ─── Quotes ────────────────────────────────────────────────────────────────
{
    // A stray quote used to open a quoted field that never closed: the rest
    // of the file became one cell.
    const text = 'time,tag,value\n0,Pipe 5" main,1\n1,Pipe 6" main,2\n2,"Valve, north",3\n3,"He said ""ok""",4\n';
    const rows = parser._parseRows(text, ',');
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[1], ['0', 'Pipe 5" main', '1']);
    assert.deepEqual(rows[3], ['2', 'Valve, north', '3'], 'a real quoted field keeps its delimiter');
    assert.deepEqual(rows[4], ['3', 'He said "ok"', '4'], 'doubled quotes are one quote');
    const data = await parser.parse(utf8(text));
    assert.deepEqual(values(data, 'value'), [1, 2, 3, 4]);

    // An opening quote with no closing one is a character, not a field.
    assert.deepEqual(parser._parseRows('a,b\n"1,2\n3,4\n', ','), [['a', 'b'], ['"1', '2'], ['3', '4'], ['']]);
    // Multi-line quoted text still works.
    assert.deepEqual(parser._parseRows('a,b\n"x\ny",2\n', ',')[1], ['x\ny', '2']);
}

// ─── Rows with the wrong number of cells ───────────────────────────────────
{
    assert.deepEqual(fitCsvRowToWidth(['1', '2', '3', ''], 3), ['1', '2', '3']);
    assert.equal(fitCsvRowToWidth(['1', '2', '3', '4'], 3), null);
    assert.equal(fitCsvRowToWidth(['1', '2'], 3), null);
    assert.deepEqual(fitCsvRowToWidth(['1', '2'], 3, { policy: 'pad' }), ['1', '2', '']);
    assert.deepEqual(fitCsvRowToWidth(['1', '2'], 3, { minWidth: 2 }), ['1', '2', '']);

    // A trailing delimiter on every data row, none on the header: every row
    // used to be thrown away, and the header with them.
    const trailing = 'time;a;b\n0;1;2;\n1;3;4;\n2;5;6;\n';
    const data = await parser.parse(utf8(trailing));
    assert.equal(data.metadata.hasHeader, true);
    assert.deepEqual(values(data, 'b'), [2, 4, 6]);
    assert.equal(data.metadata.repairedColumnCountRows, 3);
    const profile = parser.inspectSample(utf8(trailing));
    assert.equal(profile.trailingEmptyCells, 1, 'the profile records the extra cell');

    // The header ends in a delimiter, the rows do not.
    const headerTrailing = await parser.parse(utf8('time,a,b,\n0,1,2\n1,3,4\n2,5,6\n'));
    assert.deepEqual(values(headerTrailing, 'b'), [2, 4, 6]);

    // A row missing a cell (a value the logger skipped) and a last line cut
    // off: left out by default, kept on request.
    const ragged = 'time,a,b\n0,1,2\n1,3\n2,5,6\n3,7';
    const dropped = await parser.parse(utf8(ragged));
    assert.deepEqual(values(dropped, 'time').length, 2);
    assert.equal(dropped.metadata.skippedColumnCountRows, 2);
    const auto = parser.inspectSample(utf8(ragged));
    const padded = await parser.parseWithProfile(utf8(ragged), { ...auto, profileSource: 'user', raggedRows: 'pad' });
    assert.deepEqual(Array.from(padded.variables.a.data), [1, 3, 5, 7]);
    assert.ok(Number.isNaN(padded.variables.b.data[1]) && Number.isNaN(padded.variables.b.data[3]), 'missing cells are missing values');
}

// ─── Numbers: decimal and thousands separators ─────────────────────────────
{
    assert.equal(parseCsvNumber('1.234,5', ';'), 1234.5, 'unambiguous on its own');
    assert.equal(parseCsvNumber('1,234.5', ','), 1234.5);
    assert.equal(parseCsvNumber("1'234.5"), 1234.5, 'Swiss grouping');
    assert.equal(parseCsvNumber('1\u202F234,5', ';'), 1234.5, 'French narrow no-break space');
    assert.equal(parseCsvNumber('\u22125.5'), -5.5, 'typographic minus');
    assert.equal(parseCsvNumber('1.234', ';', ',', '.'), 1234);
    assert.equal(parseCsvNumber('1.234.567', ';', 'auto', '.'), 1234567);
    assert.equal(parseCsvNumber('2·5', ';', '·'), 2.5, 'a custom decimal mark');
    assert.equal(parseCsvNumber('1,5', ','), parseCsvNumber('1,5', ','), 'still NaN with a comma delimiter');
    assert.ok(Number.isNaN(parseCsvNumber('1,5', ',')));
    assert.equal(parseCsvNumber('12.5'), 12.5);
    assert.equal(parseCsvNumber('1,5', ';'), 1.5);

    const eu = detectCsvNumberFormat([['1.234,5', '7,25'], ['12.345,6', '8,5']], { delimiter: ';' });
    assert.deepEqual([eu.decimalSeparator, eu.thousandsSeparator], [',', '.']);
    const us = detectCsvNumberFormat([['"1,234.5"', '7.25'], ['12,345.6', '8.5']].map(r => r.map(c => c.replace(/"/g, ''))), { delimiter: ';' });
    assert.deepEqual([us.decimalSeparator, us.thousandsSeparator], ['.', ',']);
    const grouped = detectCsvNumberFormat([['1.234.567'], ['2.345.678']], { delimiter: ';' });
    assert.deepEqual([grouped.decimalSeparator, grouped.thousandsSeparator], [',', '.'], 'grouped integers only');
    const conflict = detectCsvNumberFormat([['3.25', '1.234,5'], ['4.5', '2.345,5']], { delimiter: ';' });
    assert.equal(conflict.thousandsSeparator, 'auto', 'conflicting evidence: no character is stripped from every cell');
    const ambiguous = detectCsvNumberFormat([['1,234'], ['2,345']], { delimiter: ';' });
    assert.deepEqual([ambiguous.decimalSeparator, ambiguous.thousandsSeparator], ['auto', 'auto'], '"1,234" says nothing');

    // A whole file: the sample decides, and every cell is read the same way.
    const text = 'Zeit;Leistung;Energie\n0;1.234,5;12\n1;1.300,25;13\n2;999,5;14\n3;1.000,0;15\n';
    const data = await parser.parse(utf8(text));
    assert.deepEqual(values(data, 'Leistung'), [1234.5, 1300.25, 999.5, 1000]);
    assert.deepEqual(data.metadata.detectedNumberFormat, { decimalSeparator: ',', thousandsSeparator: '.' });
    const profile = parser.inspectSample(utf8(text));
    assert.deepEqual(csvNumberFormat(profile), { decimalSeparator: ',', thousandsSeparator: '.' });
    assert.deepEqual(csvNumberFormat({ ...profile, decimalSeparator: '.', thousandsSeparator: 'none' }),
        { decimalSeparator: '.', thousandsSeparator: 'none' }, 'the reader\'s choice wins over the sample');

    // Chosen in the profile: a custom decimal mark.
    const odd = 'time;v;w\n0;1·5;1\n1;2·5;2\n2;3·5;3\n';
    const oddProfile = { ...parser.inspectSample(utf8(odd)), profileSource: 'user', decimalSeparator: '·' };
    assert.equal(oddProfile.delimiter, ';');
    const oddData = await parser.parseWithProfile(utf8(odd), oddProfile);
    assert.deepEqual(values(oddData, 'v'), [1.5, 2.5, 3.5]);
}

// ─── Delimiters ────────────────────────────────────────────────────────────
{
    const data = await parser.parse(utf8('time|a|b\n0|1|2\n1|3|4\n2|5|6\n'));
    assert.equal(data.metadata.delimiter, '|');
    assert.deepEqual(values(data, 'b'), [2, 4, 6]);
}

// ─── Dates ─────────────────────────────────────────────────────────────────
{
    // Comma milliseconds, as European loggers write them.
    const dot = detectCsvTimeAxis(['Zeitstempel', 'v'], [['15.01.2024 13:05:22,123', '1'], ['15.01.2024 13:05:23,456', '2'], ['15.01.2024 13:05:24,789', '3']]);
    assert.equal(dot.strategy, 'dot-date');
    assert.equal(parseCsvTimeValue(dot, ['15.01.2024 13:05:23,456']), Date.UTC(2024, 0, 15, 13, 5, 23, 456));
    assert.equal(dot.format.fractionComma, true);
    const iso = detectCsvTimeAxis(['ts', 'v'], [['2024-01-15 13:05:22,5', '1'], ['2024-01-15 13:05:23,5', '2'], ['2024-01-15 13:05:24,5', '3']]);
    assert.equal(parseCsvTimeValue(iso, ['2024-01-15 13:05:23,5']), Date.UTC(2024, 0, 15, 13, 5, 23, 500));

    // Weekdays and zones: RFC 2822, as mail and some web exports write it.
    const rfc = detectCsvTimeAxis(['Date', 'v'], [['Mon, 15 Jan 2024 10:00:00 +0100', '1'], ['Tue, 16 Jan 2024 10:00:00 +0100', '2'], ['Wed, 17 Jan 2024 10:00:00 +0100', '3']]);
    assert.equal(rfc.strategy, 'month-name-date');
    assert.equal(parseCsvTimeValue(rfc, ['Tue, 16 Jan 2024 10:00:00 +0100']), Date.UTC(2024, 0, 16, 9));
    const fr = detectCsvTimeAxis(['Horodatage', 'v'], [['lundi 1 janvier 2024 13:05', '1'], ['mardi 2 janvier 2024 13:05', '2'], ['mercredi 3 janvier 2024 13:05', '3']]);
    assert.equal(parseCsvTimeValue(fr, ['mardi 2 janvier 2024 13:05']), Date.UTC(2024, 0, 2, 13, 5));
    const es = detectCsvTimeAxis(['fecha', 'v'], [['15 de enero de 2024', '1'], ['16 de enero de 2024', '2'], ['17 de enero de 2024', '3']]);
    assert.equal(parseCsvTimeValue(es, ['16 de enero de 2024']), Date.UTC(2024, 0, 16));
    const ctime = detectCsvTimeAxis(['when', 'v'], [['Jan 15 10:00:00 2024', '1'], ['Jan 15 10:00:01 2024', '2'], ['Jan 15 10:00:02 2024', '3']]);
    assert.equal(parseCsvTimeValue(ctime, ['Jan 15 10:00:01 2024']), Date.UTC(2024, 0, 15, 10, 0, 1));

    // What the dialog shows for Auto: the pattern the column is written in.
    const cases = [
        [['09-Janvier-2024 07:05:08', '10-Février-2024 07:05:08'], 'DMY', 'dd-MMMM-yyyy HH:mm:ss', 'fr'],
        [['1 janvier 2024 13:05:22', '15 février 2024 13:05:22'], 'DMY', 'd MMMM yyyy HH:mm:ss', 'fr'],
        [['lundi 1 janvier 2024 13:05', 'mardi 2 janvier 2024 13:05'], 'DMY', 'EEEE d MMMM yyyy HH:mm', 'fr'],
        [['Mon, 15 Jan 2024 10:00:00 +0100', 'Tue, 16 Jan 2024 10:00:00 +0100'], 'DMY', 'EEE, dd MMM yyyy HH:mm:ss XXX', 'en'],
        [['15 de enero de 2024', '16 de enero de 2024'], 'DMY', "dd 'de' MMMM 'de' yyyy", 'es'],
        [['2024-01-15T10:00:00.123Z', '2024-01-15T10:00:01.456Z'], 'YMD', 'yyyy-MM-ddTHH:mm:ss.SSSZ', null],
        [['15.01.2024 13:05:22,123', '15.01.2024 13:05:23,456'], 'DMY', 'dd.MM.yyyy HH:mm:ss,SSS', null],
        [['1/5/2024 1:05:22 PM', '12/15/2024 11:05:22 AM'], 'MDY', 'M/d/yyyy h:mm:ss AM/PM', null],
        [['2024/01/15 10:00', '2024/01/16 10:00'], 'YMD', 'yyyy/MM/dd HH:mm', null],
        [['Jan 15 10:00:00 2024', 'Jan 16 10:00:00 2024'], 'MDY', 'MMM dd HH:mm:ss yyyy', 'en'],
        [['09-Ene-2024 07:05:08', '10-Febrero-2024 07:05:08'], 'DMY', 'dd-MMMM-yyyy HH:mm:ss', 'es'],
    ];
    for (const [cells, dateOrder, pattern, language] of cases) {
        const described = describeDatetimeValues(cells, { dateOrder });
        assert.equal(described.pattern, pattern, cells[0]);
        assert.equal(described.language, language, `${cells[0]}: language`);
        // And the pattern, used as a Custom one, reads the same instants.
        const detected = detectCsvTimeAxis(['date', 'v'], cells.map((cell, i) => [cell, String(i)]), { preferredDateOrder: dateOrder });
        const custom = { ok: true, kind: 'datetime', strategy: 'custom-format', sourceIndexes: [0], format: { pattern } };
        for (const cell of cells) {
            const expected = parseCsvTimeValue(detected, [cell]);
            assert.ok(Number.isFinite(expected), cell);
            assert.equal(parseCsvTimeValue(custom, [cell]), expected, `${pattern} reads ${cell} as Auto does`);
        }
    }

    // The fixture with French month names.
    const frBytes = readFileSync('test-files/csv/date-parsing-options/05_french_month_names_semicolon.csv');
    const frProfile = parser.inspectSample(frBytes.buffer.slice(frBytes.byteOffset, frBytes.byteOffset + frBytes.byteLength));
    const frDescribed = describeTimeSourcePattern(frProfile.timeSource, frProfile.sampleRows);
    assert.deepEqual(frDescribed, { pattern: 'dd-MMMM-yyyy HH:mm:ss', language: 'fr' });

    // The SQL readers' translation of a pattern.
    assert.equal(customDatetimePatternInfo('MM/dd/yyyy hh:mm:ss AM/PM').format, '%m/%d/%Y %I:%M:%S %p');
    assert.equal(customDatetimePatternInfo("yyyy-MM-dd'T'HH:mm:ss.SSSSSS").format, '%Y-%m-%dT%H:%M:%S.%f');
    const weekday = customDatetimePatternInfo('EEEE d MMMM yyyy HH:mm');
    assert.equal(weekday.hasWeekday, true);
    assert.equal(weekday.format, '%d %b %Y %H:%M', 'the weekday is stripped, not matched');
}

// ─── DuckDB SQL ────────────────────────────────────────────────────────────
{
    assert.equal(csvNumericCastSql('"v"', { delimiter: ',' }), 'try_cast("v" AS DOUBLE)', 'an ordinary file pays nothing');
    const eu = csvNumericCastSql('"v"', { delimiter: ';', detectedNumberFormat: { decimalSeparator: ',', thousandsSeparator: '.' } });
    assert.equal(eu, `try_cast(replace(replace(CAST("v" AS VARCHAR), '.', ''), ',', '.') AS DOUBLE)`);
    assert.match(csvNumericCastSql('"v"', { delimiter: ';', decimalSeparator: '·' }), /replace\(CAST\("v" AS VARCHAR\), '·', '\.'\)/);
    assert.equal(csvRepairProjectionSql('read_csv(x)', { delimiter: ',' }, ['a', 'b']), null);
    const repaired = csvRepairProjectionSql('read_csv(x)', { removedInvisibleChars: 3 }, ['a', 'b']);
    assert.match(repaired, /^\(SELECT regexp_replace\("a", '\[.*\]', '', 'g'\) AS "a", .* FROM read_csv\(x\)\)$/);
    assert.deepEqual(csvReadRepairOptions({ raggedRows: 'pad' }), ['null_padding=true']);
    assert.deepEqual(csvReadRepairOptions({}), []);
}

// ─── The parsing dialog ────────────────────────────────────────────────────
function openDialog(buffer, profile = parser.inspectSample(buffer)) {
    const dialog = new CsvParsingPreviewDialog({ parser, sampleBuffer: buffer, csvProfile: profile, title: 'plc.csv' });
    // No DOM here: rendering is someone else's test.
    dialog._renderControls = () => {};
    dialog._renderGrid = () => {};
    dialog._renderValidation = () => {};
    dialog._refreshPreview();
    return dialog;
}
{
    const text = 'Horodatage;Puissance;Etat\n'
        + '1 janvier 2024 13:05:22;1.234,5;ok\n'
        + '2 janvier 2024 13:05:22;1.300,25;ok\n'
        + '3 janvier 2024 13:05:22;999,5;ok\n'
        + '4 janvier 2024 13:05:22;1.000,0;ok\n';
    const buffer = utf8(text);
    const dialog = openDialog(buffer);
    assert.equal(dialog.state.hideInvalidLines, false, 'invalid lines are shown unless the reader hides them');
    assert.equal(dialog.validation.ok, true, dialog.validation.messages.join('; '));
    assert.deepEqual(dialog.resultProfile.detectedNumberFormat, { decimalSeparator: ',', thousandsSeparator: '.' });
    assert.equal(dialog.resultProfile.decimalSeparator, 'auto', 'Auto stays Auto; what it found is stored beside it');
    assert.match(dialog._detectedTimePattern().pattern, /^d MMMM yyyy HH:mm:ss$/);
    assert.equal(dialog._detectedTimePattern().language, 'fr');

    // Line limits: 1000 and All.
    const limits = dialog._lineLimitOptions().map(option => option.value);
    assert.ok(limits.includes(1000) && limits.includes('all'));
    dialog.state.lineLimit = 'all';
    assert.equal(dialog._effectiveLineLimit(), 10000);
    assert.equal(dialog._allLinesTruncation(), null, 'a small file is shown whole');
    dialog.sampleSegments[0] = { ...dialog.sampleSegments[0], totalSize: buffer.byteLength * 1000 };
    const truncation = dialog._allLinesTruncation();
    assert.ok(truncation && truncation.total >= 4000, 'a file larger than the preview says how much is not shown');
    dialog._rebuildProfile();
    assert.match(dialog.validation.warnings[0], /\d+/);
    dialog.sampleSegments[0] = { ...dialog.sampleSegments[0], totalSize: buffer.byteLength };
    dialog.state.lineLimit = 10;

    // Change things, then the encoding: nothing set is lost.
    dialog.state.columnOverrides = { 1: { name: 'P' } };
    dialog.state.ignoredColumns = [2];
    dialog._rebuildProfile();
    const before = { headerIndex: dialog.state.headerIndex, timeColumn: dialog.state.timeColumn, dataStartIndex: dialog.state.dataStartIndex };
    dialog._setEncoding('windows-1252');
    assert.equal(dialog.state.encoding, 'windows-1252');
    assert.deepEqual({ headerIndex: dialog.state.headerIndex, timeColumn: dialog.state.timeColumn, dataStartIndex: dialog.state.dataStartIndex }, before);
    assert.deepEqual(dialog.state.columnOverrides, { 1: { name: 'P' } }, 'renames survive an encoding change');
    assert.deepEqual(dialog.state.ignoredColumns, [2], 'ignored columns survive an encoding change');
    assert.equal(dialog.resultProfile.encoding, 'windows-1252');
    dialog._setEncoding('auto');

    // Separators: a custom one, one that is the delimiter (refused), and thousands.
    assert.equal(dialog._setDecimalSeparator(';'), false, 'the delimiter cannot be the decimal mark');
    assert.equal(dialog._setDecimalSeparator('·'), true);
    assert.equal(dialog.resultProfile.decimalSeparator, '·');
    dialog._setDecimalSeparator('auto');
    dialog._setThousandsSeparator('none');
    assert.equal(dialog.resultProfile.thousandsSeparator, 'none');
    dialog._setThousandsSeparator('auto');

    // The profile the dialog hands back reads the file as the dialog showed.
    const data = await parser.parseWithProfile(buffer, dialog.resultProfile);
    assert.deepEqual(values(data, 'P'), [1234.5, 1300.25, 999.5, 1000], 'renamed, and read with the detected separators');
    assert.ok(!('Etat' in data.variables), 'the ignored column stays out');

    // Saved settings carry the new options.
    dialog.state.raggedRows = 'pad';
    const saved = dialog._settingsSnapshot();
    assert.equal(saved.settings.thousandsSeparator, 'auto');
    assert.equal(saved.settings.raggedRows, 'pad');
}
{
    // Rows with a different number of cells are a warning, not a refusal.
    const dialog = openDialog(utf8('time,a,b\n0,1,2\n1,3\n2,5,6\n3,7,8\n'));
    assert.equal(dialog.validation.ok, true, 'the file can still be applied');
    assert.ok(dialog.validation.warnings.some(text => /\b1\b/.test(text)), 'and the reader is told about the row');
    dialog.state.raggedRows = 'pad';
    dialog._rebuildProfile();
    assert.equal(dialog.validation.totalDataRows, 4, 'kept when asked');
}

console.log('CSV robust parsing tests passed.');

// "Mar" is March, and also a Spanish/French/Italian weekday abbreviation.
{
    const rows = [['Jan 1 2000', '1'], ['Feb 1 2000', '2'], ['Mar 1 2000', '3']];
    const source = detectCsvTimeAxis(['date', 'price'], rows);
    assert.equal(parseCsvTimeValue(source, ['Mar 1 2000']), Date.UTC(2000, 2, 1));
    assert.equal(describeDatetimeValues(['Mar 1 2000', 'Apr 1 2000'], { dateOrder: 'MDY' }).pattern, 'MMM d yyyy');
    const weekday = detectCsvTimeAxis(['fecha', 'v'], [['mar 2 ene 2024', '1'], ['mié 3 ene 2024', '2'], ['jue 4 ene 2024', '3']]);
    assert.equal(parseCsvTimeValue(weekday, ['mar 2 ene 2024']), Date.UTC(2024, 0, 2), 'a weekday when a month follows');
    console.log('Month/weekday ambiguity tests passed.');
}

// A building-management (GTB) export: a preamble with a HYPERLINK formula,
// mixed LF/CRLF line ends, thousands with a no-break space, a header ending
// in a delimiter, two empty cells after every row, and a note in brackets.
{
    const text = '\uFEFF"Nom du point - CPT03",,,\n'
        + 'Valeur min. - 8597  (kW.h),,,\n'
        + 'Valeur moyenne - 8763  (kW.h),,,\r\n'
        + '"zone - Etage RDC",,,\r\n'
        + 'URL de l\'équipement,=HYPERLINK("https://10.6.40.1/UI/#/space/x"),,\r\n'
        + 'Horodatage,Valeur des données (kW.h),Fiabilité (vierge si fiable),\r\n'
        + '"1 octobre 2026 00:00:00","8\u00A0597","",,\r\n'
        + '"1 octobre 2026 00:01:00","8\u00A0598","",,\r\n'
        + '"1 octobre 2026 00:02:00","8\u00A0601","",,\r\n';
    const profile = parser.inspectSample(utf8(text));
    assert.equal(profile.headerIndex, 5, 'the title row is found under the preamble');
    assert.deepEqual(profile.rawHeaders, ['Horodatage', 'Valeur des données (kW.h)', 'Fiabilité (vierge si fiable)'],
        'no unnamed empty column for the trailing delimiter');
    assert.equal(profile.lineEnding, 'crlf', 'the data lines end in CRLF, which DuckDB is told');
    const data = await parser.parse(utf8(text));
    assert.deepEqual(Object.keys(data.variables), ['Horodatage', 'Valeur des données', 'Fiabilité (vierge si fiable)']);
    assert.equal(data.variables['Valeur des données'].description, '[kW.h]');
    assert.deepEqual(values(data, 'Valeur des données'), [8597, 8598, 8601]);
    assert.equal(data.metadata.timeOriginMs, Date.UTC(2026, 9, 1));
    const dialog = openDialog(utf8(text), profile);
    assert.equal(dialog.resultProfile.rawHeaders.length, 3);
    assert.equal(dialog.validation.ok, true, dialog.validation.messages.join('; '));
    assert.deepEqual(csvReadRepairOptions(profile), ["new_line='\\r\\n'"]);
    console.log('GTB export tests passed.');
}
{
    const dialog = openDialog(utf8('Horodatage,Valeur des données (kW.h),Fiabilité (vierge si fiable)\n'
        + '2026-10-01 00:00,1,\n2026-10-01 00:01,2,\n2026-10-01 00:02,3,\n'));
    dialog.state.unitsMode = 'inline';
    dialog.state.inlineUnitFormat = 'auto';
    dialog._rebuildProfile();
    assert.deepEqual(dialog.resultProfile.headers.map(h => [h.name, h.description]),
        [['Horodatage', ''], ['Valeur des données', '[kW.h]'], ['Fiabilité (vierge si fiable)', '']]);
    dialog.state.inlineUnitFormat = 'paren';
    dialog._rebuildProfile();
    assert.equal(dialog.resultProfile.headers[2].description, '[vierge si fiable]', 'a format chosen by hand takes the brackets');
    console.log('Inline unit phrase tests passed.');
}

// Hovering a preview cell: raw text, parsed value with its unit, and type.
{
    const text = 'Horodatage;Puissance (kW);Etat;Note\n'
        + '1 janvier 2024 13:05:22;1.234,5;ok;x\n'
        + '2 janvier 2024 13:05:22;;ok;x\n'
        + '3 janvier 2024 13:05:22;erreur;ok;x\n'
        + '4 janvier 2024 13:05:22;1.000,0;ok;x\n'
        + '5 janvier 2024 13:05:22;2.000,0\n';
    const dialog = openDialog(utf8(text));
    dialog.state.ignoredColumns = [3];
    dialog._rebuildProfile();
    const entries = dialog._allPreviewRowEntries();
    const info = (row, column) => dialog._cellInfo(entries[row], column);
    assert.equal(info(0, 1).kind, 'header');
    assert.deepEqual(info(1, 1), { raw: '1.234,5', parsed: '1234.5', kind: 'number', unit: 'kW', notes: [] });
    assert.equal(info(1, 0).kind, 'time');
    assert.equal(info(1, 0).parsed, '2024-01-01 13:05:22');
    assert.equal(info(2, 1).kind, 'missing');
    assert.equal(info(3, 1).kind, 'invalid');
    assert.equal(info(1, 2).kind, 'text');
    assert.equal(info(1, 3).kind, 'skipped');
    assert.deepEqual(info(5, 1).notes, ['row-width'], 'the short row says why it is left out');
    const tooltip = dialog._cellTooltip(info(1, 1));
    assert.match(tooltip, /^Raw: «1\.234,5»\nParsed: 1234\.5 kW\nType: number$/); // crlf-ok: a tooltip string built in memory, not a file
    assert.match(dialog._cellTooltip(info(3, 1)), /not a number in a numeric column/);
    assert.match(dialog._parsedTimeTooltip(entries[1].row, Date.UTC(2024, 0, 1, 13, 5, 22)),
        /Parsed: 2024-01-01 13:05:22\nFrom: «1 janvier 2024 13:05:22»\nPattern: d MMMM yyyy HH:mm:ss \(French\)/); // crlf-ok: a tooltip string built in memory, not a file
    console.log('Cell tooltip tests passed.');
}

// Dialect detection on general CSV files, not only measurement tables
// (bench/dialect measures it on the CSV_Wrangling corpus).
{
    // Words only: no row of numbers, so the table reading finds nothing and
    // the data consistency decides. It used to fall back to a comma.
    assert.equal(parser._detectDelimiter('name;city;country\nAna;Lyon;France\nBo;Oslo;Norway\nCy;Lima;Peru\n'), ';');
    assert.equal(parser._detectDelimiter('name\tcity\nAna Maria\tSan José\nBo\tNew York\nCy\tLima\n'), '\t');
    // One column with spaces inside the values stays one column.
    const dates = 'birth_date\n1958-03-06 00:00:00\n1950-07-06 00:00:00\n1948-09-14 00:00:00\n';
    const one = parser._parseRows(dates, parser._detectDelimiter(dates)).filter(r => r.some(c => c));
    assert.ok(one.every(row => row.length === 1), 'a datetime is not split at its space');
    // Space-separated numbers are still columns.
    assert.equal(parser._detectDelimiter('t v w\n0 1.5 2\n1 1.6 3\n2 1.7 4\n'), 'whitespace');

    // Single quotes, without taking an apostrophe for one.
    const single = "id,year,state\n1,'09/10',ok\n2,'06/07',ok\n3,'07/08',ok\n4,l'eau,ok\n";
    assert.deepEqual(parser._detectQuoting(single, ','), { quoteChar: "'", escapeChar: '', quotedFields: 3 });
    const singleData = await parser.parse(utf8(single));
    assert.deepEqual(Array.from(singleData.variables.year.data), ['09/10', '06/07', '07/08', "l'eau"]);
    assert.equal(singleData.variables.year.data[0], '09/10', 'the quotes are not part of the value');
    // A backslash before quotes.
    const escaped = 'a,b,c\n1,"say \\"hi\\"",2\n3,"x \\"y\\"",4\n5,"z",6\n';
    assert.equal(parser._detectQuoting(escaped, ',').escapeChar, '\\');
    const escapedData = await parser.parse(utf8(escaped));
    assert.equal(escapedData.variables.b.data[0], 'say "hi"');
    assert.deepEqual(Array.from(escapedData.variables.c.data), [2, 4, 6]);
    // RFC 4180 doubled quotes are not a backslash escape.
    assert.equal(parser._detectQuoting('a,b\n"he said ""hi""",1\n"x",2\n', ',').escapeChar, '');
    // DuckDB is told.
    assert.deepEqual(csvReadRepairOptions({ quoteChar: "'", escapeChar: '\\' }), ["quote=''''", "escape='\\'"]);
    console.log('Dialect detection tests passed.');
}
