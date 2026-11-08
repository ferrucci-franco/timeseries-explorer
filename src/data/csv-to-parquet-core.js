import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import CsvParser from '../parsers/csv-parser.js';
import MatParser from '../parsers/mat-parser.js';
import {
    applyCsvColumnTypeRescan,
    applyCsvColumnTypeScan,
    csvColumnSpecs,
    csvColumnTypeRescan,
    csvColumnTypeScan,
    csvProjectionSql,
    csvReadCsvSql,
    csvRowFilterSql,
    csvTimeColumnName,
    csvTimeInfoFromProfile,
    csvTimeOutputSql,
    duckDbColumnsStruct,
    escapeSqlString,
    inferDuckDbCsvType,
    quoteIdent,
    sampleRowsWithValidTime,
} from './csv-sql-schema.js';
import { csvNumericCastSql, csvProfileUsesDecimalComma } from './csv-sql-normalize.js';
import { csvDatetimeSql } from './csv-sql-datetime.js';

// The SQL a profile turns into lives in csv-sql-schema.js, shared with the
// browser's DuckDB reader so that a file converted here reads as it does
// there. Re-exported under the names this module's callers and tests use.
export {
    csvColumnSpecs,
    duckDbColumnsStruct,
    escapeSqlString,
    inferDuckDbCsvType,
    quoteIdent,
    sampleRowsWithValidTime,
};

export function rowFilterSql(profile) {
    return csvRowFilterSql(profile);
}

export function timeOutputSql(timeInfo, expression = '"__omv_time"') {
    return csvTimeOutputSql(timeInfo, expression);
}

const require = createRequire(import.meta.url);
const duckDbModulePath = (() => {
    const currentPath = fileURLToPath(import.meta.url);
    const unpackedMarker = `${sep}app.asar.unpacked${sep}`;
    const index = currentPath.indexOf(unpackedMarker);
    if (index < 0) return 'duckdb';
    return join(currentPath.slice(0, index), 'app.asar', 'node_modules', 'duckdb');
})();
const duckdbPkg = require(duckDbModulePath);
const { Database } = duckdbPkg;

export function formatMB(bytes) {
    return (Number(bytes || 0) / (1024 * 1024)).toFixed(1);
}

export function formatSeconds(ms) {
    return (Number(ms || 0) / 1000).toFixed(2);
}

export function defaultParquetOutputPath(inputPath) {
    const baseName = basename(inputPath, extname(inputPath));
    return resolve(dirname(inputPath), `${baseName}.parquet`);
}

export function inspectCsvForParquet(inputPath) {
    const sample = readFileSync(inputPath, { encoding: null, flag: 'r' }).subarray(0, 1024 * 1024);
    const parser = new CsvParser(new MatParser());
    return parser.inspectSample(sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength), { maxRows: 700 });
}

export function csvReadExpr(sqlInput, profile) {
    if (!profile) return `read_csv_auto('${sqlInput}', sample_size=200000, ignore_errors=true)`;
    if (profile.delimiter === 'whitespace') {
        throw new Error('CSV-to-Parquet conversion does not yet support variable-width whitespace delimiters.');
    }
    return csvReadCsvSql(sqlInput, profile);
}

/**
 * Ask the CSV what each of its columns holds, before writing them.
 *
 * Same scan the app's DuckDB path runs on load (csvColumnTypeScan), for the
 * same reason: the sample is the first 100 data rows of the first megabyte,
 * and a channel that starts recording later — or never — would otherwise be
 * typed from no evidence at all (#311), and a column that changes after the
 * sample (a sensor writing "OFF" until the plant starts) from the wrong
 * evidence, and written to Parquet as the wrong thing for good.
 *
 * One aggregate query over the rows with a time, so one extra pass over the
 * CSV, against a conversion that already reads and sorts the whole file.
 * Nothing is written if it fails: the sample's answer is good enough to
 * convert with.
 */
export async function resolveUnknownCsvColumnTypes(conn, readExpr, profile, timeInfo = null) {
    if (!profile) return;
    const scan = csvColumnTypeScan(profile);
    if (!scan) return;
    const where = [rowFilterSql(profile), timeInfo?.sql && !timeInfo.generated ? `${timeInfo.sql} IS NOT NULL` : '']
        .filter(Boolean).join(' AND ');
    const sql = `SELECT ${scan.selectList} FROM ${readExpr}${where ? ` WHERE ${where}` : ''}`;

    let rows = null;
    try {
        rows = await runDuckDb(conn, sql);
    } catch (err) {
        console.warn(`[csv-to-parquet] could not scan the file for its column types; keeping the sample's types: ${err?.message || err}`);
        return;
    }
    const row = rows?.[0];
    if (!row) return;
    const suspects = applyCsvColumnTypeScan(profile, scan.columns, alias => Number(row[alias] ?? 0));
    // The columns with cells the cast refused but which hold a digit, counted
    // again cell by cell. A file of plain numbers has none.
    const rescan = csvColumnTypeRescan(profile, suspects);
    if (!rescan) return;
    let again = null;
    try {
        again = await runDuckDb(conn, `SELECT ${rescan.selectList} FROM ${readExpr}${where ? ` WHERE ${where}` : ''}`);
    } catch (err) {
        console.warn(`[csv-to-parquet] could not re-count the columns with unusual numbers; keeping the sample's types: ${err?.message || err}`);
        return;
    }
    if (again?.[0]) applyCsvColumnTypeRescan(profile, rescan.columns, alias => Number(again[0][alias] ?? 0));
}

export function csvUsesDecimalComma(profile) {
    return csvProfileUsesDecimalComma(profile);
}

// The generated index stays the integer DuckDB counts: that is what the
// converter has always written, and what a Parquet reader expects of one.
export function timeInfoFromProfile(profile) {
    return csvTimeInfoFromProfile(profile, { indexAsDouble: false });
}

export function datetimeSqlFromProfile(timeSource, sourceNames, profile = null) {
    return csvDatetimeSql(timeSource, sourceNames, {
        quoteIdent,
        numericCastSql: expr => csvNumericCastSql(expr, profile),
    });
}

export function projectionSql(profile, timeInfo) {
    return csvProjectionSql(profile, timeInfo);
}

/** What to call the time column in the file the user keeps (csvTimeColumnName). */
export function timeColumnName(profile, timeInfo) {
    return csvTimeColumnName(profile, timeInfo);
}

// Every other value in this module reaches SQL through quoteIdent, sqlPath,
// escapeSqlString or numericLiteral. The compression name was the one that went
// in by concatenation, so it is the one place a caller could have written SQL
// into the COPY statement instead of choosing an option. An allowlist is the
// whole fix: these are the codecs DuckDB writes.
export const PARQUET_COMPRESSIONS = new Set(['zstd', 'snappy', 'gzip', 'lz4', 'none']);

export function parquetCompression(value) {
    const name = String(value ?? 'zstd').trim().toLowerCase() || 'zstd';
    if (!PARQUET_COMPRESSIONS.has(name)) {
        throw new Error(`Unsupported Parquet compression: ${name}. Use one of ${[...PARQUET_COMPRESSIONS].join(', ')}.`);
    }
    return name;
}

export function sqlPath(filePath) {
    return String(filePath || '').replace(/\\/g, '/').replace(/'/g, "''");
}

export function runDuckDb(conn, sql) {
    return new Promise((res, rej) => {
        conn.all(sql, (err, rows) => err ? rej(err) : res(rows));
    });
}

export function closeDuckDbConnection(conn) {
    return new Promise(resolve => {
        if (!conn?.close) {
            resolve();
            return;
        }
        try { conn.close(() => resolve()); } catch (_) { resolve(); }
    });
}

export function closeDuckDbDatabase(db) {
    return new Promise(resolve => {
        if (!db?.close) {
            resolve();
            return;
        }
        try { db.close(() => resolve()); } catch (_) { resolve(); }
    });
}

export async function convertCsvToParquet(options = {}) {
    const inputPath = resolve(process.cwd(), options.inputPath || '');
    if (!inputPath || !existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
    const outputPath = resolve(process.cwd(), options.outputPath || defaultParquetOutputPath(inputPath));
    if (existsSync(outputPath) && !options.overwrite) {
        throw new Error(`Output already exists: ${outputPath}`);
    }

    const inputStat = statSync(inputPath);
    const compression = parquetCompression(options.compression);
    const profile = options.csvProfile || inspectCsvForParquet(inputPath);
    const timeInfo = timeInfoFromProfile(profile);
    if (!timeInfo?.sql) {
        throw new Error('CSV pre-scan did not find a usable time column for Parquet conversion.');
    }

    const db = new Database(':memory:');
    const conn = db.connect();
    const t0 = performance.now();
    try {
        try { await runDuckDb(conn, `PRAGMA threads=4`); } catch (_) { /* best effort */ }
        try { await runDuckDb(conn, `PRAGMA enable_progress_bar`); } catch (_) { /* best effort */ }

        const compress = compression === 'none' ? '' : `, COMPRESSION ${compression.toUpperCase()}`;
        const readExpr = csvReadExpr(sqlPath(inputPath), profile);
        // Before the projection, which is where a column's type becomes a cast.
        await resolveUnknownCsvColumnTypes(conn, readExpr, profile, timeInfo);
        const projection = projectionSql(profile, timeInfo);
        const filterWhere = rowFilterSql(profile);
        await runDuckDb(conn, `
            COPY (
                WITH raw AS (
                    SELECT * FROM ${readExpr}
                    ${filterWhere ? `WHERE ${filterWhere}` : ''}
                ),
                projected AS (
                    SELECT ${projection}
                    FROM raw
                )
                SELECT ${timeOutputSql(timeInfo)} AS ${quoteIdent(timeColumnName(profile, timeInfo))}, * EXCLUDE ("__omv_time")
                FROM projected
                WHERE "__omv_time" IS NOT NULL
                ORDER BY 1
            )
            TO '${sqlPath(outputPath)}' (FORMAT PARQUET${compress})
        `);
    } finally {
        await closeDuckDbConnection(conn);
        await closeDuckDbDatabase(db);
    }

    const elapsedMs = performance.now() - t0;
    const outputStat = statSync(outputPath);
    return {
        inputPath,
        outputPath,
        inputBytes: inputStat.size,
        outputBytes: outputStat.size,
        elapsedMs,
        compression,
        ratio: outputStat.size > 0 ? inputStat.size / outputStat.size : null,
    };
}

