/**
 * What a CSV profile says about the table, said in DuckDB SQL: which columns
 * the file has and what each one is read as, the read_csv call, the time
 * axis, the projection that casts every column, the row filter, and the scan
 * that asks the file itself what its columns hold.
 *
 * One module for the two readers that hand a CSV to DuckDB — the browser's
 * (duckdb-source.js) and the desktop CSV-to-Parquet converter's
 * (csv-to-parquet-core.js). Each used to carry its own copy of these
 * functions, and the copies had started to drift (one scan counted only the
 * rows with a time, the other every row). Nothing here is Node-only, so the
 * browser bundle takes it as it is.
 */
import { parseCsvTimeValue } from '../parsers/csv-time-detection.js';
import { csvNumberFormat } from '../parsers/csv-text-normalize.js';
import { columnIndexSet, columnSampleVerdict, forcedColumnTypes, isMostlyNumericColumn } from '../parsers/csv-column-types.js';
import { csvDatetimeSql } from './csv-sql-datetime.js';
import {
    csvFilledCellSql,
    csvNumericCastSql,
    csvProfileUsesDecimalComma,
    csvReadRepairOptions,
    csvRepairProjectionSql,
} from './csv-sql-normalize.js';

export function quoteIdent(name) {
    return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

export function escapeSqlString(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/** The sampled rows whose time reads: what the sample's column types are judged on. */
export function sampleRowsWithValidTime(sampleRows, profile) {
    const timeSource = profile?.timeSource;
    if (!timeSource?.ok || timeSource.strategy === 'generated-index') return sampleRows || [];
    const delimiter = profile?.delimiter || ',';
    const { decimalSeparator, thousandsSeparator } = csvNumberFormat(profile);
    return (sampleRows || []).filter((row, index) =>
        Number.isFinite(parseCsvTimeValue(timeSource, row, index, delimiter, { decimalSeparator, thousandsSeparator }))
    );
}

// Text only when the sample says so. A column the sample held no value for
// is read as numbers — the scan of the file corrects it if the file
// disagrees, and until it answers, numbers are the better guess for a
// column of a log (#311).
export function inferDuckDbCsvType(sampleRows, index, delimiter, decimalSeparator = 'auto', thousandsSeparator = 'auto') {
    return columnSampleVerdict(sampleRows, index, delimiter, decimalSeparator, thousandsSeparator) === 'text'
        ? { type: 'VARCHAR', readType: 'VARCHAR' }
        : { type: 'DOUBLE', readType: 'VARCHAR' };
}

/**
 * The file's columns as the profile describes them: name, description and
 * the type the projection casts to. Every column is READ as VARCHAR; `type`
 * is what the projection makes of it.
 *
 * `withVerdict` adds where each column's type comes from — 'time', 'chosen'
 * (by the reader, in the parsing options), 'scanned' (by a scan of every
 * row), or what the sample says: 'numeric', 'text' or 'unknown' (it held no
 * value). Only the scan asks for it, because saying it for every column means
 * parsing every sampled cell, and this runs on every lazy query.
 */
export function csvColumnSpecs(profile, { withVerdict = false } = {}) {
    const rawHeaders = profile?.rawHeaders || [];
    const headers = profile?.headers || [];
    const timeSource = profile?.timeSource || {};
    const timeIndexes = new Set(timeSource.sourceIndexes || []);
    const numericIndexes = Array.isArray(profile?.numericColumnIndexes)
        ? new Set(profile.numericColumnIndexes.map(index => Number(index)).filter(index => Number.isInteger(index) && index >= 0))
        : null;
    // Above everything the file says about itself: the type the reader chose
    // in the parsing options.
    const forced = forcedColumnTypes(profile);
    // What a scan of the whole file decided (csvColumnTypeScan). It outranks
    // the sample, whoever took it: it read every row.
    const scannedNumeric = columnIndexSet(profile?.scannedNumericColumns);
    const scannedText = columnIndexSet(profile?.scannedTextColumns);
    let validTimeRows = null;
    const sampleRowsOnce = () => {
        if (validTimeRows === null) validTimeRows = sampleRowsWithValidTime(profile?.sampleRows || [], profile);
        return validTimeRows;
    };
    const numberFormat = csvNumberFormat(profile);
    const verdictOf = (index) => columnSampleVerdict(
        sampleRowsOnce(), index, profile?.delimiter, numberFormat.decimalSeparator, numberFormat.thousandsSeparator,
    );
    return rawHeaders.map((raw, index) => {
        const header = headers[index] || {};
        const name = header.name || String(raw || `column_${index + 1}`);
        const forceVarchar = timeIndexes.has(index)
            && timeSource.kind === 'datetime'
            && !['excel-serial', 'matlab-datenum', 'decimal-year'].includes(timeSource.strategy);
        const chosen = forced.get(index) || null;
        const scanned = scannedNumeric.has(index) || scannedText.has(index);
        const inferred = forceVarchar
            ? { type: 'VARCHAR', readType: 'VARCHAR' }
            : chosen
                ? { type: chosen === 'text' ? 'VARCHAR' : 'DOUBLE', readType: 'VARCHAR' }
            : scannedNumeric.has(index)
                ? { type: 'DOUBLE', readType: 'VARCHAR' }
            : scannedText.has(index)
                ? { type: 'VARCHAR', readType: 'VARCHAR' }
            : numericIndexes
                ? (numericIndexes.has(index) ? { type: 'DOUBLE', readType: 'VARCHAR' } : { type: 'VARCHAR', readType: 'VARCHAR' })
            : inferDuckDbCsvType(
                sampleRowsOnce(),
                index,
                profile?.delimiter,
                numberFormat.decimalSeparator,
                numberFormat.thousandsSeparator,
            );
        const spec = {
            name,
            description: String(header.description || ''),
            ...inferred,
        };
        if (withVerdict) {
            // 'chosen' and 'scanned' both mean "settled, nothing left to ask
            // the file about".
            spec.sampleVerdict = forceVarchar
                ? 'time'
                : chosen
                    ? 'chosen'
                    : scanned ? 'scanned' : verdictOf(index);
        }
        return spec;
    });
}

export function duckDbColumnsStruct(specs) {
    const fields = specs.map(({ name, type, readType }) =>
        `'${escapeSqlString(name)}': '${escapeSqlString(readType || type || 'VARCHAR')}'`
    );
    return `{${fields.join(', ')}}`;
}

/**
 * The read_csv call for a profile, with every repair the profile asks for:
 * the columns read as text, the rows above the table skipped, and (as a
 * subquery, when needed) invisible characters and the time column's decimal
 * comma or weekday handled, so every query on the file reads the same clean
 * columns.
 *
 * @param {string} sqlInput the file as DuckDB names it, already escaped
 * @param {object} profile
 * @param {{ skip?: number }} [options] rows to skip instead of the profile's
 */
export function csvReadCsvSql(sqlInput, profile, options = {}) {
    if (!profile) throw new Error('csvReadCsvSql needs a CSV profile.');
    if (profile.delimiter === 'whitespace') {
        throw new Error('DuckDB CSV path does not yet support variable-width whitespace delimiters.');
    }
    const specs = csvColumnSpecs(profile);
    const skip = Number.isFinite(Number(options.skip))
        ? Number(options.skip)
        : Math.max(0, Number(profile.dataStartIndex) || 0);
    const readOptions = [
        'auto_detect=false',
        'header=false',
        `skip=${skip}`,
        `columns=${duckDbColumnsStruct(specs)}`,
        'ignore_errors=true',
        ...csvReadRepairOptions(profile),
    ];
    if (profile.delimiter) readOptions.push(`delim='${escapeSqlString(profile.delimiter)}'`);
    if (csvProfileUsesDecimalComma(profile)) readOptions.push(`decimal_separator=','`);
    const readSql = `read_csv('${sqlInput}', ${readOptions.join(', ')})`;
    // Columns kept as text are trimmed as the in-memory reader trims every
    // cell. Not the time source, whose SQL trims for itself, nor a column the
    // reader unticked, which no query reads.
    const timeIndexes = new Set(profile.timeSource?.sourceIndexes || []);
    const ignored = columnIndexSet(profile.ignoredColumns);
    const textColumns = specs
        .filter((spec, index) => spec.type === 'VARCHAR' && !timeIndexes.has(index) && !ignored.has(index))
        .map(spec => spec.name);
    return csvRepairProjectionSql(readSql, profile, specs.map(spec => spec.name), { textColumns }) || readSql;
}

/** The WHERE clause of the profile's row filter, or '' when there is none. */
export function csvRowFilterSql(profile) {
    const filter = profile?.rowFilter;
    if (!filter?.enabled) return '';
    const columnIndex = Number(filter.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0) return '';
    const column = csvColumnSpecs(profile)[columnIndex]?.name;
    if (!column) return '';
    if (filter.operator === 'is_numeric') return `${csvNumericCastSql(quoteIdent(column), profile)} IS NOT NULL`;
    const operator = filter.operator === '!=' ? '<>' : '=';
    return `trim(CAST(${quoteIdent(column)} AS VARCHAR)) ${operator} '${escapeSqlString(String(filter.value ?? '').trim())}'`;
}

/**
 * The time axis of a profile as SQL over the file's columns, in the units the
 * app plots (milliseconds since the epoch for a calendar axis), or null when
 * the profile has no usable time source.
 *
 * `columnNames` are the table's columns as DuckDB reports them, when the
 * caller has them; `columnTypes` their DuckDB types (a column DuckDB already
 * reads as a TIMESTAMP needs no parsing). `indexAsDouble` says whether a
 * generated index is cast to DOUBLE (the browser reads it as one) or left as
 * the integer DuckDB counts (what the converter writes).
 */
export function csvTimeInfoFromProfile(profile, { columnNames = null, columnTypes = [], indexAsDouble = true } = {}) {
    const timeSource = profile?.timeSource;
    if (!timeSource?.ok) return null;
    if (timeSource.strategy === 'generated-index') {
        return {
            name: timeSource.name || 'index',
            description: timeSource.description || '[index]',
            timeKind: 'index',
            strategy: timeSource.strategy || 'generated-index',
            sourceNames: [],
            sql: indexAsDouble ? '(ROW_NUMBER() OVER () - 1)::DOUBLE' : 'ROW_NUMBER() OVER () - 1',
            generated: true,
        };
    }
    const names = columnNames || csvColumnSpecs(profile).map(spec => spec.name);
    const sourceNames = (timeSource.sourceIndexes || [])
        .map(index => names[index])
        .filter(name => name != null);
    if (!sourceNames.length) return null;

    const first = quoteIdent(sourceNames[0]);
    const firstType = columnTypes[timeSource.sourceIndexes?.[0] ?? 0] || '';
    const numericCastSql = expr => csvNumericCastSql(expr, profile);
    let sql = null;
    if (timeSource.strategy === 'index-column' || timeSource.kind === 'numeric') {
        sql = numericCastSql(first);
    } else if (timeSource.kind === 'datetime') {
        sql = csvDatetimeSql(timeSource, sourceNames, { quoteIdent, numericCastSql, firstType });
    }
    if (!sql) return null;
    return {
        name: timeSource.name || sourceNames.join(' '),
        description: timeSource.description || (timeSource.kind === 'datetime' ? '[datetime]' : ''),
        timeKind: timeSource.strategy === 'index-column' ? 'index' : timeSource.kind,
        strategy: timeSource.strategy || timeSource.mode || null,
        sourceNames,
        sql,
        generated: false,
    };
}

/** The columns the projection keeps: everything but the time source and what the reader unticked. */
export function csvKeptColumns(profile, timeInfo, columnNames = null) {
    const names = columnNames || csvColumnSpecs(profile).map(spec => spec.name);
    const exclude = new Set(timeInfo?.sourceNames || []);
    for (const index of profile?.ignoredColumns || []) {
        const name = names[Number(index)];
        if (name != null) exclude.add(name);
    }
    return names.filter(name => !exclude.has(name));
}

/** One column of the projection: cast to a number when the file holds it as text. */
export function csvProjectionColumnSql(name, spec = null, profile = null) {
    const ident = quoteIdent(name);
    if (spec?.type === 'DOUBLE' && spec?.readType === 'VARCHAR') {
        return `${csvNumericCastSql(ident, profile)} AS ${ident}`;
    }
    return ident;
}

/**
 * The SELECT list that turns the file's text columns into the table the app
 * reads: the time axis as "__omv_time", then every kept column cast to its
 * type.
 */
export function csvProjectionSql(profile, timeInfo, { columnNames = null } = {}) {
    if (!timeInfo?.sql) throw new Error('No suitable time column detected by the CSV pre-scan.');
    const specsByName = new Map(csvColumnSpecs(profile).map(spec => [spec.name, spec]));
    const columns = csvKeptColumns(profile, timeInfo, columnNames)
        .map(name => csvProjectionColumnSql(name, specsByName.get(name), profile));
    return [`${timeInfo.sql} AS "__omv_time"`, ...columns].join(', ');
}

/**
 * The time column as it is written to a file the user keeps (a Parquet).
 *
 * The projection computes time as milliseconds since the epoch, which is
 * what the plot needs but not what the file should say: a Parquet holding a
 * plain number has forgotten that its time was a date, and reopening it gave
 * a numeric axis where the CSV had a calendar. Written back as a TIMESTAMP,
 * the file carries that fact itself, and it is a date again on the next open.
 */
export function csvTimeOutputSql(timeInfo, expression = '"__omv_time"') {
    return timeInfo?.timeKind === 'datetime'
        ? `epoch_ms(CAST(${expression} AS BIGINT))`
        : expression;
}

/**
 * What to call the time column in a file the user keeps: the name the
 * source used, unless a kept column already has it — two columns of the
 * same name would be a file nobody can query unambiguously — and then the
 * application's internal "__omv_time".
 */
export function csvTimeColumnName(profile, timeInfo, columnNames = null) {
    const candidate = String(timeInfo?.name ?? '').trim();
    if (!candidate) return '__omv_time';
    const taken = new Set(csvKeptColumns(profile, timeInfo, columnNames));
    return taken.has(candidate) ? '__omv_time' : candidate;
}

/**
 * The scan that asks the file what each column holds, as the in-memory
 * reader decides it over every row: how many cells hold a value and how many
 * of those read as a number (isMostlyNumericColumn).
 *
 * The sample is the first 100 data rows, and a sample lies two ways: a
 * channel the logger started recording at row 225 holds nothing in it (#311),
 * and a column that changes after it — a sensor writing "OFF" until the
 * plant starts, a status column that is numeric only during the test — reads
 * as the first rows say. So every column the reader left on auto is counted,
 * not only the ones the sample could not type; a column chosen by hand, the
 * time axis, an unticked column and one already scanned are not.
 *
 * Returns the SELECT list and the columns it counts, or null when there is
 * nothing to ask. The caller runs it where its other aggregates run (the
 * row count, the time range) and hands the counts to applyCsvColumnTypeScan.
 */
export function csvColumnTypeScan(profile, { columnNames = null } = {}) {
    if (!profile) return null;
    const available = columnNames ? new Set(columnNames) : null;
    const ignored = columnIndexSet(profile.ignoredColumns);
    // The time axis is read by its own SQL, whatever kind it is.
    const timeIndexes = columnIndexSet(profile.timeSource?.sourceIndexes);
    const columns = csvColumnSpecs(profile, { withVerdict: true })
        .map((spec, index) => ({ spec, index }))
        .filter(({ spec, index }) => !['time', 'chosen', 'scanned'].includes(spec.sampleVerdict)
            && !ignored.has(index)
            && !timeIndexes.has(index)
            && (!available || available.has(spec.name)))
        .map(({ spec, index }, slot) => ({ index, name: spec.name, slot }));
    if (!columns.length) return null;
    const selectList = columns.map(({ name, slot }) => {
        const ident = quoteIdent(name);
        return `COUNT(${csvFilledCellSql(ident)}) AS filled_${slot}`
            + `, COUNT(${csvNumericCastSql(ident, profile)}) AS numeric_${slot}`;
    }).join(', ');
    return { columns, selectList };
}

/**
 * Write the scan's verdict onto the profile (scannedNumericColumns,
 * scannedTextColumns), so the live-update appends, a later Parquet
 * conversion and a reload of the same profile all read the same types.
 *
 * @param {object} profile
 * @param {{ index: number, slot: number }[]} columns from csvColumnTypeScan
 * @param {(alias: string) => number} valueOf the count under an alias
 */
export function applyCsvColumnTypeScan(profile, columns, valueOf) {
    const numericColumns = columnIndexSet(profile.scannedNumericColumns);
    const textColumns = columnIndexSet(profile.scannedTextColumns);
    for (const { index, slot } of columns) {
        const filled = Number(valueOf(`filled_${slot}`) ?? 0);
        const numeric = Number(valueOf(`numeric_${slot}`) ?? 0);
        if (isMostlyNumericColumn({ nonEmptyCount: filled, finiteCount: numeric })) {
            numericColumns.add(index);
            textColumns.delete(index);
        } else {
            textColumns.add(index);
            numericColumns.delete(index);
        }
    }
    profile.scannedNumericColumns = [...numericColumns].sort((a, b) => a - b);
    profile.scannedTextColumns = [...textColumns].sort((a, b) => a - b);
}
