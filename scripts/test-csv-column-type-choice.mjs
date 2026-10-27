// "How to read this column", chosen by hand in the parsing options (#311).
//
// The file decides types on its own — the sample, and a scan of every row for
// what the sample cannot see — but it cannot know what the numbers in it are
// for. A column of codes with leading zeros is not a quantity; a channel the
// reader knows is numeric must be readable as numbers even where nothing in the
// file says so, and in the one path that cannot be scanned at all (a table so
// irregular that the automatic inspection gives up, read through the dialog).
//
// So the dialog offers auto / number / text per column, and the choice outranks
// everything the file says. Checked here: the dialog turns the choice into the
// positions the readers understand, the time axis is never one of them, and all
// three readers obey it.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import CsvParser from '../src/parsers/csv-parser.js';
import MatParser from '../src/parsers/mat-parser.js';
import CsvParsingPreviewDialog from '../src/ui/csv-parsing-preview-dialog.js';
import { forcedColumnTypes } from '../src/parsers/csv-column-types.js';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;

// time | ELY_V numbers | ID codes with leading zeros | BATT_I never recorded
const HEADER = ['time', 'ELY_V', 'ID', 'BATT_I'];
const ROWS = [];
for (let i = 0; i < 12; i++) ROWS.push([String(i), (220 + i / 10).toFixed(3), `00${i + 1}`, '']);
const CSV = [HEADER.join(','), ...ROWS.map(row => row.join(','))].join('\n') + '\n';
const buffer = (() => {
    const bytes = new TextEncoder().encode(CSV);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
})();

const parser = new CsvParser(new MatParser());

function profileWithChoices(types = {}) {
    const autoProfile = parser.inspectSample(buffer, { maxRows: 50 });
    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: buffer,
        csvProfile: autoProfile,
        title: 'choice.csv',
    });
    dialog.preview = parser.inspectPreview(buffer, {
        maxRows: 20,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog.state.columnOverrides = Object.fromEntries(
        Object.entries(types).map(([index, type]) => [index, { type }]),
    );
    dialog._rebuildProfile();
    return dialog.resultProfile;
}

// ── The dialog turns choices into positions ─────────────────────────────────

const auto = profileWithChoices();
assert.deepEqual(auto.forcedNumericColumns, [], 'nothing is forced until the reader says so');
assert.deepEqual(auto.forcedTextColumns, []);
// `ID` reads as text on its own (001, 002 … parse as numbers, so it does NOT:
// this is exactly why the choice has to exist).
assert.ok(auto.numericColumnIndexes.includes(2), 'left alone, codes that parse as numbers are numbers');
assert.deepEqual(auto.previewEmptyColumns, [3], 'the preview says which column it could not type');

const chosen = profileWithChoices({ 2: 'text', 3: 'number' });
assert.deepEqual(chosen.forcedTextColumns, [2], 'text is a real choice, not only an absence of numbers');
assert.deepEqual(chosen.forcedNumericColumns, [3]);
assert.ok(!chosen.numericColumnIndexes.includes(2), 'a column chosen as text leaves the numeric set');
assert.ok(chosen.numericColumnIndexes.includes(3), 'and one chosen as a number joins it');
assert.equal(chosen.columnOverrides[2].type, 'text', 'the choice rides along with the names and units');

// The time axis is not a choice. A stale one — a settings file from another
// table — must not follow the column that has since become the time axis.
const onTime = profileWithChoices({ 0: 'text' });
assert.deepEqual(onTime.timeSource.sourceIndexes, [0], 'column 0 is the time axis here');
assert.deepEqual(onTime.forcedTextColumns, [], 'a choice on the time axis is ignored');
assert.deepEqual(onTime.forcedNumericColumns, []);

// ── The DuckDB reader obeys it, over the sample and over the scan ───────────

const source = Object.create(DuckDbSource.prototype);
const specs = (profile) => new Map(source._csvColumnSpecs(profile, { withVerdict: true })
    .map(spec => [spec.name, spec]));

let byName = specs(chosen);
assert.equal(byName.get('ID').type, 'VARCHAR', 'chosen text is read as text');
assert.equal(byName.get('BATT_I').type, 'DOUBLE', 'chosen number is read as a number');
assert.equal(byName.get('ELY_V').type, 'DOUBLE', 'and the rest is still the file\'s own answer');
assert.equal(byName.get('ID').sampleVerdict, 'chosen');
assert.equal(byName.get('BATT_I').sampleVerdict, 'chosen');

// Against a scan that disagrees: the reader asked for text, text it is.
byName = specs({ ...chosen, scannedNumericColumns: [2, 3], scannedTextColumns: [] });
assert.equal(byName.get('ID').type, 'VARCHAR', 'the choice outranks a scan of every row');
assert.equal(byName.get('BATT_I').type, 'DOUBLE');

// And a chosen column is never scanned: there is nothing left to ask.
let scannedSql = '';
await source._resolveUnknownCsvColumnTypes(
    'omv_t_1',
    { ...chosen },
    HEADER,
    'TRUE',
    async (sql) => { scannedSql = sql; return { getChild: () => null }; },
);
assert.equal(scannedSql, '', 'with every unknown column chosen by hand, no scan is sent');

const half = profileWithChoices({ 2: 'text' });
await source._resolveUnknownCsvColumnTypes(
    'omv_t_1',
    half,
    HEADER,
    'TRUE',
    async (sql) => { scannedSql = sql; return { getChild: () => ({ get: () => 0n }) }; },
);
assert.ok(scannedSql.includes('"BATT_I"'), 'the column still on auto is scanned');
assert.ok(!scannedSql.includes('"ID"'), 'the chosen one is not');

// ── The in-memory reader gives the same answer ──────────────────────────────

const eager = await parser.parseWithProfile(buffer, chosen);
assert.equal(eager.variables.ID.dataType, 'string', 'chosen text arrives as text');
assert.deepEqual(eager.variables.ID.data.slice(0, 3), ['001', '002', '003'], 'with the leading zeros intact');
assert.equal(eager.variables.BATT_I.dataType, 'real', 'chosen number arrives as a number');
assert.equal(eager.variables.ELY_V.dataType, 'real');

const eagerAuto = await parser.parseWithProfile(buffer, auto);
assert.equal(eagerAuto.variables.ID.dataType, 'real', 'left alone those codes are numbers — the bug the choice fixes');
assert.deepEqual([...eagerAuto.variables.ID.data.slice(0, 3)], [1, 2, 3]);

// ── A live update appends rows the same way ─────────────────────────────────

const appended = parser._numericColumnIndexSet(chosen, { expectedColumns: HEADER.length });
assert.ok(!appended.has(2), 'the rows a live update appends respect the choice too');
assert.ok(appended.has(3));

// ── The lookup itself ───────────────────────────────────────────────────────

const forced = forcedColumnTypes({ forcedNumericColumns: [1], forcedTextColumns: [2, 'x', -1] });
assert.deepEqual([...forced.entries()], [[2, 'text'], [1, 'numeric']], 'positions only, and nothing else');
assert.equal(forcedColumnTypes(null).size, 0, 'no profile, no choices');
assert.equal(forcedColumnTypes({ forcedNumericColumns: [4], forcedTextColumns: [4] }).get(4), 'numeric',
    'a profile that says both is read the way that keeps the column usable');

console.log('CSV column type choice OK');
