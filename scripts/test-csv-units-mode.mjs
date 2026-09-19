// What "Units" is set to in the CSV preview decides one thing only: where the
// unit comes from. It must not also decide how much of the title survives.
//
// "Units: in a row of their own" used to fall through to the inline parser,
// which cuts a trailing "(V)" or "[kW]" off the header and calls it the unit.
// So a file with "Voltage (RMS)" and "Voltage (peak)" in the title row and a
// units row underneath arrived as two columns both named "Voltage", with the
// distinguishing part deleted — the user having just told the app the units
// were somewhere else entirely.
import assert from 'node:assert/strict';

import CsvParser from '../src/parsers/csv-parser.js';
import CsvParsingPreviewDialog from '../src/ui/csv-parsing-preview-dialog.js';

const parser = new CsvParser();
const RAW = ['Time (s)', 'Voltage (RMS)', 'Voltage (peak)', 'Power [kW]'];

// ─── The parser's own header fallback ──────────────────────────────
const names = mode => parser._normalizeProfileHeaders(null, RAW, { unitsMode: mode })
    .map(header => header.name);
const units = mode => parser._normalizeProfileHeaders(null, RAW, { unitsMode: mode })
    .map(header => header.description);

assert.deepEqual(names('row'), RAW, 'a units row leaves every title exactly as written');
assert.deepEqual(units('row'), ['', '', '', ''], 'the title supplies no unit when the units live in a row');
assert.deepEqual(names('none'), RAW, 'no units means no title is cut either');
assert.deepEqual(units('none'), ['', '', '', '']);

// Inline is the one mode that asks for a unit to be taken out of the title.
assert.deepEqual(names('inline'), ['Time', 'Voltage', 'Voltage_2', 'Power']);
assert.deepEqual(units('inline'), ['[s]', '[RMS]', '[peak]', '[kW]']);

// An absent unitsMode is a profile saved before the setting existed; it keeps
// the old behaviour rather than silently renaming that user's columns.
assert.deepEqual(names(undefined), ['Time', 'Voltage', 'Voltage_2', 'Power']);
assert.deepEqual(units(undefined), ['[s]', '[RMS]', '[peak]', '[kW]']);

// ─── The same thing through the preview dialog ─────────────────────
const CSV = [
    RAW.join(','),
    's,V,V,kW',
    '0,1.0,1.4,2.0',
    '1,1.1,1.5,2.1',
    '2,1.2,1.6,2.2',
].join('\n');

function previewProfile(unitsMode, { unitRowIndex = 1 } = {}) {
    const bytes = new TextEncoder().encode(CSV);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const autoProfile = parser.inspectSample(buffer, { maxRows: 50 });
    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: buffer,
        csvProfile: autoProfile,
        title: 'units-mode.csv',
    });
    dialog.preview = parser.inspectPreview(buffer, {
        maxRows: 10,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog.state.hasHeader = true;
    dialog.state.headerIndex = 0;
    dialog.state.dataStartIndex = 2;
    dialog.state.unitsMode = unitsMode;
    dialog.state.unitRowIndex = unitsMode === 'row' ? unitRowIndex : null;
    dialog.state.columnOverrides = {};
    dialog._rebuildProfile();
    return dialog.resultProfile;
}

const fromRow = previewProfile('row');
assert.deepEqual(fromRow.headers.map(h => h.name), RAW,
    'the preview must keep the full title when the units come from a row');
assert.deepEqual(fromRow.headers.map(h => h.description), ['[s]', '[V]', '[V]', '[kW]'],
    'the units come from the units row, not from the title');

const noUnits = previewProfile('none');
assert.deepEqual(noUnits.headers.map(h => h.name), RAW, 'No units keeps the title whole');
assert.deepEqual(noUnits.headers.map(h => h.description), ['', '', '', ''], 'No units means no unit');

const inline = previewProfile('inline');
assert.deepEqual(inline.headers.map(h => h.name), ['Time', 'Voltage', 'Voltage_2', 'Power'],
    'inline is still the mode that takes the unit out of the title');
assert.deepEqual(inline.headers.map(h => h.description), ['[s]', '[RMS]', '[peak]', '[kW]']);

// ─── Nothing in the sources reads a units row as inline any more ───
const sources = [
    ['src/parsers/csv-parser.js', "unitsMode === 'none' || profile?.unitsMode === 'row'"],
    ['src/ui/csv-parsing-preview-dialog.js', "unitsMode === 'none' || this.state.unitsMode === 'row'"],
];
for (const [path, needle] of sources) {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(text.includes(needle), `${path} must treat a units row like "no units" when naming columns`);
}

console.log('CSV units-mode header checks passed.');
