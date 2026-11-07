// The repairs of test-csv-robust-parsing.mjs, through DuckDB: a file large
// enough to take the DuckDB path (or converted to Parquet on the desktop)
// must read the same values the in-memory parser reads. The SQL is shared
// (src/data/csv-sql-normalize.js), so the converter checks it for both.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import duckdbPkg from 'duckdb';
import {
    closeDuckDbConnection,
    closeDuckDbDatabase,
    convertCsvToParquet,
    inspectCsvForParquet,
    runDuckDb,
} from '../src/data/csv-to-parquet-core.js';

const { Database } = duckdbPkg;
const dir = mkdtempSync(join(tmpdir(), 'omv-csv-robust-'));

async function convert(name, text, check, settings = {}) {
    const csvPath = join(dir, `${name}.csv`);
    const parquetPath = join(dir, `${name}.parquet`);
    writeFileSync(csvPath, text);
    const profile = { ...inspectCsvForParquet(csvPath), ...settings };
    await convertCsvToParquet({ inputPath: csvPath, outputPath: parquetPath, csvProfile: profile, overwrite: true });
    const db = new Database(':memory:');
    const conn = db.connect();
    try {
        const rows = await runDuckDb(conn, `SELECT * FROM read_parquet('${parquetPath.replace(/\\/g, '/').replace(/'/g, "''")}')`);
        check(rows, profile);
    } finally {
        await closeDuckDbConnection(conn);
        await closeDuckDbDatabase(db);
    }
}
const ms = value => (value instanceof Date ? value.getTime() : Number(value));

try {
    await convert('thousands', 'Zeit;Leistung;Energie\n0;1.234,5;1\n1;1.300,25;2\n2;999,5;3\n3;1.000,0;4\n', (rows, profile) => {
        assert.deepEqual(profile.detectedNumberFormat, { decimalSeparator: ',', thousandsSeparator: '.' });
        assert.deepEqual(rows.map(row => row.Leistung), [1234.5, 1300.25, 999.5, 1000]);
    });

    await convert('trailing', 'time;a;b\n0;1;2;\n1;3;4;\n2;5;6;\n3;7\n', (rows, profile) => {
        assert.equal(profile.trailingEmptyCells, 1);
        assert.equal(rows.length, 3, 'a trailing delimiter on every row: every row is read');
        assert.deepEqual(rows.map(row => row.b), [2, 4, 6]);
        assert.deepEqual(Object.keys(rows[0]), ['time', 'a', 'b'], 'the extra cell is not a column');
    });

    await convert('padded', 'time;a;b\n0;1;2\n1;3\n2;5;6\n', rows => {
        assert.equal(rows.length, 3, 'kept when the reader asked');
        assert.equal(rows[1].b, null, 'and its missing cell is missing');
    }, { raggedRows: 'pad' });

    await convert('invisible', 'time,pressure\n0,\u200B1.5\n1,\uFEFF2.5\n2,3.\u00AD5\n', (rows, profile) => {
        assert.equal(profile.removedInvisibleChars, 3);
        assert.deepEqual(rows.map(row => row.pressure), [1.5, 2.5, 3.5]);
    });

    await convert('comma-ms', 'Zeitstempel;v\n15.01.2024 13:05:22,123;1\n15.01.2024 13:05:23,456;2\n15.01.2024 13:05:24,789;3\n', rows => {
        assert.deepEqual(rows.map(row => ms(row.Zeitstempel)), [
            Date.UTC(2024, 0, 15, 13, 5, 22, 123),
            Date.UTC(2024, 0, 15, 13, 5, 23, 456),
            Date.UTC(2024, 0, 15, 13, 5, 24, 789),
        ]);
    });

    await convert('french-months', 'date;v\n1 janvier 2024 13:05:22;1\n15 février 2024 13:05:22;2\n3 août 2024 13:05:22;3\n', rows => {
        assert.deepEqual(rows.map(row => ms(row.date)), [
            Date.UTC(2024, 0, 1, 13, 5, 22),
            Date.UTC(2024, 1, 15, 13, 5, 22),
            Date.UTC(2024, 7, 3, 13, 5, 22),
        ], 'accented month names');
    });

    await convert('weekday', 'Date,v\n"Mon, 15 Jan 2024 10:00:00",1\n"Tue, 16 Jan 2024 10:00:00",2\n"Wed, 17 Jan 2024 10:00:00",3\n', rows => {
        assert.deepEqual(rows.map(row => ms(row.Date)), [
            Date.UTC(2024, 0, 15, 10),
            Date.UTC(2024, 0, 16, 10),
            Date.UTC(2024, 0, 17, 10),
        ]);
    });

    // A GTB export: the preamble mixes LF and CRLF, which made DuckDB skip
    // two lines too few and read the header as data.
    await convert('gtb', '"Nom du point - CPT03",,,\nValeur min. - 8597  (kW.h),,,\n'
        + '"zone - Etage RDC",,,\r\nURL,=HYPERLINK("https://10.6.40.1/x"),,\r\n'
        + 'Horodatage,Valeur des données (kW.h),Fiabilité (vierge si fiable),\r\n'
        + '"1 octobre 2026 00:00:00","8\u00A0597","",,\r\n'
        + '"1 octobre 2026 00:01:00","8\u00A0598","",,\r\n'
        + '"1 octobre 2026 00:02:00","8\u00A0601","",,\r\n', rows => {
        assert.equal(rows.length, 3);
        assert.deepEqual(Object.keys(rows[0]), ['Horodatage', 'Valeur des données', 'Fiabilité (vierge si fiable)']);
        assert.deepEqual(rows.map(row => row['Valeur des données']), [8597, 8598, 8601]);
        assert.equal(typeof rows[0]['Fiabilité (vierge si fiable)'] === 'string', false, 'an empty column is not text');
    });

    await convert('pipe', 'time|a|b\n0|1|2\n1|3|4\n2|5|6\n', (rows, profile) => {
        assert.equal(profile.delimiter, '|');
        assert.deepEqual(rows.map(row => row.b), [2, 4, 6]);
    });

    console.log('CSV robust parsing through DuckDB passed.');
} finally {
    rmSync(dir, { recursive: true, force: true });
}
