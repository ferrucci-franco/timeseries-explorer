import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import CsvParser from '../parsers/csv-parser.js';
import MatParser from '../parsers/mat-parser.js';
import { customDatetimePatternToDuckDbFormat, parseCsvNumber } from '../parsers/csv-time-detection.js';

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
const MS_PER_DAY = 86400000;

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
    const options = [
        `auto_detect=false`,
        `header=false`,
        `skip=${Math.max(0, Number(profile.dataStartIndex) || 0)}`,
        `columns=${duckDbColumnsStruct(csvColumnSpecs(profile))}`,
        `ignore_errors=true`,
    ];
    if (profile.delimiter) options.push(`delim='${escapeSqlString(profile.delimiter)}'`);
    if (csvUsesDecimalComma(profile)) options.push(`decimal_separator=','`);
    return `read_csv('${sqlInput}', ${options.join(', ')})`;
}

export function csvColumnSpecs(profile) {
    const rawHeaders = profile?.rawHeaders || [];
    const headers = profile?.headers || [];
    const sampleRows = profile?.sampleRows || [];
    const timeSource = profile?.timeSource || {};
    const timeIndexes = new Set(timeSource.sourceIndexes || []);
    return rawHeaders.map((raw, index) => {
        const header = headers[index] || {};
        const name = header.name || String(raw || `column_${index + 1}`);
        const forceVarchar = timeIndexes.has(index)
            && timeSource.kind === 'datetime'
            && !['excel-serial', 'matlab-datenum', 'decimal-year'].includes(timeSource.strategy);
        return {
            name,
            type: forceVarchar ? 'VARCHAR' : inferDuckDbCsvType(sampleRows, index, profile.delimiter, profile.decimalSeparator),
        };
    });
}

export function inferDuckDbCsvType(sampleRows, index, delimiter, decimalSeparator = 'auto') {
    let nonEmpty = 0;
    let numeric = 0;
    for (const row of sampleRows || []) {
        const raw = String(row?.[index] ?? '').trim();
        if (!raw) continue;
        nonEmpty++;
        if (Number.isFinite(parseCsvNumber(raw, delimiter, decimalSeparator))) numeric++;
    }
    return nonEmpty > 0 && (numeric / nonEmpty) >= 0.95 ? 'DOUBLE' : 'VARCHAR';
}

export function duckDbColumnsStruct(specs) {
    const fields = specs.map(({ name, type }) =>
        `'${escapeSqlString(name)}': '${escapeSqlString(type || 'VARCHAR')}'`
    );
    return `{${fields.join(', ')}}`;
}

export function csvUsesDecimalComma(profile) {
    if (profile?.decimalSeparator === ',') return true;
    if (profile?.decimalSeparator === '.') return false;
    if (!profile || profile.delimiter === ',') return false;
    for (const row of profile.sampleRows || []) {
        for (const cell of row || []) {
            const raw = String(cell ?? '').trim();
            if (/^[+-]?\d+,\d+(?:[eEdD][+-]?\d+)?$/.test(raw)) return true;
        }
    }
    return false;
}

export function timeInfoFromProfile(profile) {
    const timeSource = profile?.timeSource;
    if (!timeSource?.ok) return null;
    const specs = csvColumnSpecs(profile);
    const sourceNames = (timeSource.sourceIndexes || [])
        .map(index => specs[index]?.name)
        .filter(name => name != null);

    if (timeSource.kind === 'index' || timeSource.strategy === 'generated-index') {
        return {
            name: timeSource.name || 'index',
            sourceNames: [],
            sql: 'ROW_NUMBER() OVER () - 1',
            generated: true,
        };
    }

    if (!sourceNames.length) return null;
    if (timeSource.kind === 'numeric') {
        return {
            name: timeSource.name || sourceNames[0],
            sourceNames,
            sql: `${quoteIdent(sourceNames[0])}::DOUBLE`,
            generated: false,
        };
    }

    if (timeSource.kind !== 'datetime') return null;
    return {
        name: timeSource.name || sourceNames.join(' '),
        sourceNames,
        sql: datetimeSqlFromProfile(timeSource, sourceNames),
        generated: false,
    };
}

export function datetimeSqlFromProfile(timeSource, sourceNames) {
    const first = quoteIdent(sourceNames[0]);
    const strategy = timeSource.strategy;
    if (strategy === 'excel-serial') return `((${first}::DOUBLE - 25569) * ${MS_PER_DAY})`;
    if (strategy === 'matlab-datenum') return `((${first}::DOUBLE - 719529) * ${MS_PER_DAY})`;
    if (strategy === 'decimal-year') return decimalYearSql(first);
    if (strategy === 'yearless-date-time') return yearlessDateTimeSql(first, timeSource.format);
    if (strategy === 'month-name-date') return monthNameDateSql(first);
    if (strategy === 'iso-datetime') return `epoch_ms(CAST(${first} AS TIMESTAMP))::DOUBLE`;
    if (strategy === 'custom-format') {
        const format = customDatetimePatternToDuckDbFormat(timeSource.format?.pattern || '');
        return format ? tryStrptimeSql(`CAST(${first} AS VARCHAR)`, [format]) : null;
    }

    const order = timeSource.format?.dateOrder || 'YMD';
    if (strategy === 'slash-date' || strategy === 'dash-date') {
        const formats = dateTimeFormats(order, strategy === 'dash-date' ? '-' : '/');
        return tryStrptimeSql(`CAST(${first} AS VARCHAR)`, formats);
    }

    if (timeSource.mode === 'split' && sourceNames.length >= 2) {
        const dateCol = quoteIdent(sourceNames[0]);
        const timeCol = quoteIdent(sourceNames[1]);
        const sep = timeSource.format?.dashSeparator ? '-' : '/';
        const formats = timeSource.format?.monthName
            ? monthNameFormats()
            : dateTimeFormats(order, sep);
        const expr = `CAST(${dateCol} AS VARCHAR) || ' ' || CAST(${timeCol} AS VARCHAR)`;
        return timeSource.format?.monthName
            ? tryStrptimeSql(normalizedMonthNameSql(expr), formats)
            : tryStrptimeSql(expr, formats);
    }

    if (timeSource.mode === 'parts' || strategy === 'parts') {
        return partsDateTimeSql(timeSource, sourceNames);
    }

    return null;
}

function partsDateTimeSql(timeSource, sourceNames) {
    const sourceIndexes = timeSource.sourceIndexes || [];
    const parts = timeSource.format?.parts || {};
    const partExpr = (name, fallback = '0') => {
        const profileIndex = parts[name];
        const sourceOffset = sourceIndexes.indexOf(profileIndex);
        if (sourceOffset < 0 || !sourceNames[sourceOffset]) return fallback;
        return `CAST(${quoteIdent(sourceNames[sourceOffset])} AS DOUBLE)`;
    };
    const year = partExpr('year', 'NULL');
    const month = partExpr('month', 'NULL');
    const day = partExpr('day', 'NULL');
    const hour = partExpr('hour', '0');
    const minute = partExpr('minute', '0');
    const second = partExpr('second', '0');
    const secondInt = `FLOOR(${second})`;
    const microsecond = `ROUND((${second} - FLOOR(${second})) * 1000000)`;
    const expr = `make_timestamp(CAST(${year} AS BIGINT), CAST(${month} AS BIGINT), CAST(${day} AS BIGINT), CAST(${hour} AS BIGINT), CAST(${minute} AS BIGINT), CAST(${secondInt} AS BIGINT)) + CAST(${microsecond} AS BIGINT) * INTERVAL 1 MICROSECOND`;
    return `epoch_ms(${expr})::DOUBLE`;
}

export function projectionSql(profile, timeInfo) {
    if (!timeInfo?.sql) throw new Error('No suitable time column detected by the CSV pre-scan.');
    const specs = csvColumnSpecs(profile);
    const exclude = new Set(timeInfo.sourceNames || []);
    for (const index of profile?.ignoredColumns || []) {
        const name = specs[Number(index)]?.name;
        if (name) exclude.add(name);
    }
    const columns = specs
        .filter(({ name }) => !exclude.has(name))
        .map(({ name }) => quoteIdent(name));
    return [
        `${timeInfo.sql} AS "__omv_time"`,
        ...columns,
    ].join(', ');
}

export function quoteIdent(name) {
    return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

export function escapeSqlString(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''");
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
    const compression = String(options.compression || 'zstd').toLowerCase();
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
        const projection = projectionSql(profile, timeInfo);
        await runDuckDb(conn, `
            COPY (
                WITH raw AS (
                    SELECT * FROM ${readExpr}
                ),
                projected AS (
                    SELECT ${projection}
                    FROM raw
                )
                SELECT *
                FROM projected
                WHERE "__omv_time" IS NOT NULL
                ORDER BY "__omv_time"
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

function dateTimeFormats(order, sep) {
    const date = order === 'DMY'
        ? `%d${sep}%m${sep}%Y`
        : order === 'MDY'
          ? `%m${sep}%d${sep}%Y`
          : `%Y${sep}%m${sep}%d`;
    const shortYear = order === 'DMY'
        ? `%d${sep}%m${sep}%y`
        : order === 'MDY'
          ? `%m${sep}%d${sep}%y`
          : `%y${sep}%m${sep}%d`;
    return [
        `${date} %H:%M:%S.%f`, `${date} %H:%M:%S`, `${date} %H:%M`, date,
        `${shortYear} %H:%M:%S.%f`, `${shortYear} %H:%M:%S`, `${shortYear} %H:%M`, shortYear,
    ];
}

function decimalYearSql(expr) {
    const value = `${expr}::DOUBLE`;
    const year = `FLOOR(${value})`;
    const leap = `((${year} % 4 = 0 AND ${year} % 100 <> 0) OR ${year} % 400 = 0)`;
    return `(
        epoch_ms(CAST(CAST(CAST(${year} AS BIGINT) AS VARCHAR) || '-01-01' AS TIMESTAMP))::DOUBLE
        + (${value} - ${year}) * CASE WHEN ${leap} THEN 366 ELSE 365 END * ${MS_PER_DAY}
    )`;
}

function yearlessDateTimeSql(expr, format = {}) {
    const order = format?.dateOrder || 'MDY';
    const sep = format?.dashSeparator ? '-' : '/';
    const date = order === 'DMY' ? `%Y${sep}%d${sep}%m` : `%Y${sep}%m${sep}%d`;
    return tryStrptimeSql(`'2001${sep}' || CAST(${expr} AS VARCHAR)`, [
        `${date} %H:%M:%S.%f`,
        `${date} %H:%M:%S`,
        `${date} %H:%M`,
    ]);
}

function monthNameDateSql(expr) {
    return tryStrptimeSql(normalizedMonthNameSql(expr), monthNameFormats());
}

function monthNameFormats() {
    return [
        '%d-%b-%Y %H:%M:%S.%f', '%d-%b-%Y %H:%M:%S', '%d-%b-%Y %H:%M', '%d-%b-%Y',
        '%d %b %Y %H:%M:%S.%f', '%d %b %Y %H:%M:%S', '%d %b %Y %H:%M', '%d %b %Y',
        '%b %d %Y %H:%M:%S.%f', '%b %d %Y %H:%M:%S', '%b %d %Y %H:%M', '%b %d %Y',
        '%B %d %Y %H:%M:%S.%f', '%B %d %Y %H:%M:%S', '%B %d %Y %H:%M', '%B %d %Y',
    ];
}

function normalizedMonthNameSql(expr) {
    let sql = `lower(regexp_replace(CAST(${expr} AS VARCHAR), '\\.', '', 'g'))`;
    const replacements = [
        ['january', 'jan'], ['janvier', 'jan'], ['enero', 'jan'],
        ['february', 'feb'], ['fevrier', 'feb'], ['fevr', 'feb'], ['febrero', 'feb'],
        ['march', 'mar'], ['mars', 'mar'], ['marzo', 'mar'],
        ['april', 'apr'], ['avril', 'apr'], ['abril', 'apr'],
        ['mayo', 'may'], ['mai', 'may'],
        ['june', 'jun'], ['juin', 'jun'], ['junio', 'jun'],
        ['july', 'jul'], ['juillet', 'jul'], ['juil', 'jul'], ['julio', 'jul'],
        ['august', 'aug'], ['aout', 'aug'], ['agosto', 'aug'],
        ['september', 'sep'], ['septembre', 'sep'], ['septiembre', 'sep'], ['sept', 'sep'],
        ['october', 'oct'], ['octobre', 'oct'], ['octubre', 'oct'],
        ['november', 'nov'], ['novembre', 'nov'], ['noviembre', 'nov'],
        ['december', 'dec'], ['decembre', 'dec'], ['diciembre', 'dec'],
    ];
    for (const [from, to] of replacements) {
        sql = `replace(${sql}, '${escapeSqlString(from)}', '${to}')`;
    }
    return sql;
}

function tryStrptimeSql(expr, formats) {
    const list = formats.map(format => `'${escapeSqlString(format)}'`).join(', ');
    return `epoch_ms(try_strptime(${expr}, [${list}]))::DOUBLE`;
}
