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
        const rows = await runDuckDb(conn, `
            SELECT COUNT(*) AS n, MIN("__omv_time") AS t0, MAX("__omv_time") AS t1
            FROM read_parquet('${parquetPath.replace(/\\/g, '/').replace(/'/g, "''")}')
        `);
        assert.equal(Number(rows[0].n), 3);
        assert.equal(Number(rows[0].t0), 0);
        assert.equal(Number(rows[0].t1), 1);
    } finally {
        await closeDuckDbConnection(conn);
        await closeDuckDbDatabase(db);
    }

    console.log('CSV-to-Parquet core checks passed.');
} finally {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch (err) {
        console.warn(`warning: could not remove temporary directory ${dir}: ${err?.message || err}`);
    }
}
