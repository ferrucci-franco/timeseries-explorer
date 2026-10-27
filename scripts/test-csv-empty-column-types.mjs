// A column the sample holds no value for is numbers, not text.
//
// RECIF SCADA logs (REC_*.txt) write a header for every channel of the plant and
// leave the ones that were not recording empty: 25 of the 167 columns of
// REC_23102026_0902.txt are empty from first row to last, and `Calo_Config*`
// starts at data row 225. The sample the DuckDB path types columns from is the
// first 100 data rows, so all 26 were typed VARCHAR and arrived as string series
// — unplottable, outside every formula and statistic.
//
// Covered here: the shared sample rule, the DuckDB column specs built from a
// profile, and the full-file scan that settles what the sample could not.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
    columnSampleCounts,
    columnSampleVerdict,
    inferNumericColumnIndexes,
    isMostlyNumericColumn,
} from '../src/parsers/csv-column-types.js';
import CsvParser from '../src/parsers/csv-parser.js';
import MatParser from '../src/parsers/mat-parser.js';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;

// ---------------------------------------------------------------- sample rule

const rows = [
    ['21/10/2026', '09:02:51', '1.021', '', 'off', 'NaN'],
    ['21/10/2026', '09:02:52', '1.044', '', 'off', 'NaN'],
];
assert.equal(columnSampleVerdict(rows, 2, '\t'), 'numeric');
assert.equal(columnSampleVerdict(rows, 3, '\t'), 'unknown', 'an empty column cannot be typed from the sample');
assert.equal(columnSampleVerdict(rows, 4, '\t'), 'text');
assert.equal(columnSampleVerdict(rows, 5, '\t'), 'unknown', 'NaN is a missing number, not a value');
assert.deepEqual(columnSampleCounts(rows, 2, '\t'), { nonEmptyCount: 2, finiteCount: 2 });
assert.ok(isMostlyNumericColumn({ nonEmptyCount: 0, finiteCount: 0 }), 'nothing read is nothing against numbers');
// The preview dialog reads a handful of rows, and no path may call empty text.
assert.deepEqual(inferNumericColumnIndexes(rows, 6, '\t'), [2, 3, 5]);

// ------------------------------------------------------- DuckDB column specs

const header = ['Date', 'Time(s)', 'ELY_V', 'BATT_I', 'Calo_Config*', 'ELY_Status'];
const dataRows = [];
for (let i = 0; i < 120; i++) {
    const stamp = `09:${String(2 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    dataRows.push([
        '23/10/2026',
        stamp,
        (0.6 + i / 100).toFixed(3),
        '',                              // never recorded: empty in every row
        i < 100 ? '' : '9.000',          // starts after the sample ends
        'running',
    ]);
}
const text = [header, ...dataRows].map(row => row.join('\t')).join('\r\n') + '\r\n';
const buffer = new TextEncoder().encode(text).buffer;

const parser = new CsvParser(new MatParser());
const profile = parser.inspectSample(buffer, { maxRows: 700 });
assert.equal(profile.delimiter, '\t');
assert.equal(profile.sampleRows.length, 100, 'the sample is what makes this case hard');

const source = Object.create(DuckDbSource.prototype);
const specsByName = () => new Map(source._csvColumnSpecs(profile, { withVerdict: true })
    .map(spec => [spec.name, spec]));

let specs = specsByName();
assert.equal(specs.get('ELY_V').type, 'DOUBLE');
assert.equal(specs.get('ELY_Status').type, 'VARCHAR', 'a column of words is still text');
assert.equal(specs.get('Date').sampleVerdict, 'time');
// Both untyped columns are read as numbers rather than text, and both are
// marked for the scan.
for (const name of ['BATT_I', 'Calo_Config*']) {
    assert.equal(specs.get(name).type, 'DOUBLE', `${name} must not be a string column`);
    assert.equal(specs.get(name).sampleVerdict, 'unknown', `${name} is what the scan is for`);
}

// ------------------------------------------------------------ full-file scan

// What _resolveUnknownCsvColumnTypes would read back from DuckDB, with the
// counts of the whole file: BATT_I holds nothing, Calo_Config* holds 20 numbers,
// and a third column that only looks empty early turns out to be text.
const scanned = {
    'BATT_I': { filled: 0, numeric: 0 },
    'Calo_Config*': { filled: 20, numeric: 20 },
};
const unknownOrder = source._csvColumnSpecs(profile, { withVerdict: true })
    .filter(spec => spec.sampleVerdict === 'unknown')
    .map(spec => spec.name);
assert.deepEqual(unknownOrder, ['BATT_I', 'Calo_Config*']);

const fakeResult = {
    getChild(name) {
        const match = /^(filled|numeric)_(\d+)$/.exec(name);
        if (!match) return null;
        const column = unknownOrder[Number(match[2])];
        return { get: () => BigInt(scanned[column][match[1]]) };
    },
};
let scannedSql = '';

await source._resolveUnknownCsvColumnTypes(
    'omv_t_1',
    profile,
    header,
    '"Date" IS NOT NULL',
    async (sql) => { scannedSql = sql; return fakeResult; },
);
assert.ok(/COUNT\(NULLIF\(trim\(CAST\("BATT_I" AS VARCHAR\)\), ''\)\) AS filled_0/.test(scannedSql), scannedSql);
assert.ok(/try_cast\("Calo_Config\*" AS DOUBLE\)\) AS numeric_1/.test(scannedSql), scannedSql);
assert.ok(scannedSql.includes('FROM omv_t_1 WHERE "Date" IS NOT NULL'), scannedSql);
assert.ok(!scannedSql.includes('"ELY_V"'), 'a column the sample typed is not worth a scan');

// The verdict is written back onto the profile, so the live-update appends and a
// later Parquet conversion read the same types.
assert.deepEqual(profile.scannedNumericColumns, [3, 4]);
assert.deepEqual(profile.scannedTextColumns, []);
specs = specsByName();
assert.equal(specs.get('BATT_I').type, 'DOUBLE', 'an empty column stays numeric');
assert.equal(specs.get('Calo_Config*').type, 'DOUBLE', 'a column that starts late is numeric');
assert.equal(specs.get('Calo_Config*').sampleVerdict, 'scanned');

// A scan that says text is obeyed too, and over the numericColumnIndexes a
// confirmed profile carries.
const textProfile = { ...profile, numericColumnIndexes: [2, 3, 4], scannedNumericColumns: [3], scannedTextColumns: [4] };
const textSpecs = new Map(source._csvColumnSpecs(textProfile).map(spec => [spec.name, spec]));
assert.equal(textSpecs.get('BATT_I').type, 'DOUBLE');
assert.equal(textSpecs.get('Calo_Config*').type, 'VARCHAR', 'the scan outranks the sample, both ways');

// A failed scan must not fail the load: the sample's types stand.
const beforeFailure = { ...profile };
await source._resolveUnknownCsvColumnTypes(
    'omv_t_1',
    { ...profile, scannedNumericColumns: [], scannedTextColumns: [] },
    header,
    'TRUE',
    async () => { throw new Error('connection closed'); },
);
assert.deepEqual(profile.scannedNumericColumns, beforeFailure.scannedNumericColumns);

// -------------------------------------------------- the in-memory path agrees

const eager = await new CsvParser().parse(buffer);
assert.equal(eager.variables.BATT_I.dataType, 'real', 'both readers must answer the same');
assert.equal(eager.variables['Calo_Config*'].dataType, 'real');
assert.equal(eager.variables.ELY_Status.dataType, 'string');

console.log('CSV empty / late-starting column types OK');
