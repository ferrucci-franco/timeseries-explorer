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
    parquetCompression,
    runDuckDb,
} from '../src/data/csv-to-parquet-core.js';

const { Database } = duckdbPkg;

const dir = mkdtempSync(join(tmpdir(), 'omv-csv-parquet-'));
try {
    const csvPath = join(dir, 'dirty.csv');
    const parquetPath = join(dir, 'dirty.parquet');
    writeFileSync(csvPath, [
        'garbage produced by instrument',
        'another non-table line',
        'time;voltage;current',
        '0.0;220.0;1.0',
        '0.5;221.5;1.5',
        '1.0;222.0;2.0',
        '',
    ].join('\n'));

    const profile = inspectCsvForParquet(csvPath);
    assert.equal(profile.delimiter, ';');
    assert.equal(profile.dataStartIndex, 3);

    const result = await convertCsvToParquet({
        inputPath: csvPath,
        outputPath: parquetPath,
        csvProfile: profile,
        overwrite: true,
    });
    assert.equal(result.outputPath, parquetPath);
    assert.ok(result.outputBytes > 0);

    const db = new Database(':memory:');
    const conn = db.connect();
    try {
        const readParquet = `read_parquet('${parquetPath.replace(/\\/g, '/').replace(/'/g, "''")}')`;
        const rows = await runDuckDb(conn, `
            SELECT COUNT(*) AS n, MIN("time") AS t0, MAX("time") AS t1
            FROM ${readParquet}
        `);
        assert.equal(Number(rows[0].n), 3);
        assert.equal(Number(rows[0].t0), 0);
        assert.equal(Number(rows[0].t1), 1);

        // The time column keeps the name the CSV gave it. __omv_time is this
        // application's internal name for it, and it used to leak into every
        // converted file.
        const schema = await runDuckDb(conn, `DESCRIBE SELECT * FROM ${readParquet}`);
        assert.deepEqual(schema.map(row => row.column_name), ['time', 'voltage', 'current']);
        // A numeric time is a number. Elapsed seconds are not a calendar date.
        assert.match(String(schema[0].column_type), /DOUBLE|BIGINT|INT/);
    } finally {
        await closeDuckDbConnection(conn);
        await closeDuckDbDatabase(db);
    }

    // A CSV whose time is a date must come back as a date. Written as a plain
    // number, the file forgets it ever was one, and reopening it produced a
    // numeric axis where the CSV had a calendar.
    const datedCsv = join(dir, 'dated.csv');
    const datedParquet = join(dir, 'dated.parquet');
    writeFileSync(datedCsv, [
        'timestamp;voltage',
        '2024-01-01 00:00:00;220.0',
        '2024-01-01 01:00:00;221.5',
        '2024-01-01 02:00:00;222.0',
        '',
    ].join('\n'));

    await convertCsvToParquet({
        inputPath: datedCsv,
        outputPath: datedParquet,
        csvProfile: inspectCsvForParquet(datedCsv),
        overwrite: true,
    });

    const datedDb = new Database(':memory:');
    const datedConn = datedDb.connect();
    try {
        const read = `read_parquet('${datedParquet.replace(/\\/g, '/').replace(/'/g, "''")}')`;
        const schema = await runDuckDb(datedConn, `DESCRIBE SELECT * FROM ${read}`);
        assert.deepEqual(schema.map(row => row.column_name), ['timestamp', 'voltage']);
        assert.match(String(schema[0].column_type), /TIMESTAMP/, 'the date is still a date');

        const rows = await runDuckDb(datedConn, `SELECT CAST("timestamp" AS VARCHAR) AS t FROM ${read} ORDER BY 1`);
        assert.equal(rows.length, 3);
        assert.equal(String(rows[0].t), '2024-01-01 00:00:00', 'and it is the same instant it was');
        assert.equal(String(rows[2].t), '2024-01-01 02:00:00');
    } finally {
        await closeDuckDbConnection(datedConn);
        await closeDuckDbDatabase(datedDb);
    }

    // The compression name is spliced into the COPY statement, so it is the one
    // option that could carry SQL rather than choose a codec.
    assert.equal(parquetCompression(undefined), 'zstd', 'the default is unchanged');
    assert.equal(parquetCompression('ZSTD'), 'zstd', 'the name is case-folded as before');
    for (const name of ['snappy', 'gzip', 'lz4', 'none']) {
        assert.equal(parquetCompression(name), name, `${name} is a real DuckDB codec`);
    }
    assert.throws(
        () => parquetCompression("zstd) TO 'x.parquet' -- "),
        /Unsupported Parquet compression/,
        'anything outside the option list is refused rather than concatenated',
    );
    await assert.rejects(
        () => convertCsvToParquet({ inputPath: csvPath, outputPath: join(dir, 'x.parquet'), compression: 'evil' }),
        /Unsupported Parquet compression/,
        'the converter validates before it builds any SQL',
    );

    console.log('CSV-to-Parquet core checks passed.');
} finally {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch (err) {
        console.warn(`warning: could not remove temporary directory ${dir}: ${err?.message || err}`);
    }
}
