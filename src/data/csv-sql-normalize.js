/**
 * The text repairs of csv-text-normalize.js, said in DuckDB SQL, for the two
 * readers that hand a CSV to DuckDB instead of parsing it in JavaScript: the
 * browser's lazy/large-file path (duckdb-source.js) and the desktop
 * CSV-to-Parquet converter (csv-to-parquet-core.js).
 *
 * Both used to cast numbers with a bare try_cast, so a file the in-memory
 * parser read correctly — thousands separators, a zero-width space before
 * every value, comma milliseconds — came out as NaN once it was large enough
 * to take the DuckDB path. Every
 * function here returns plain SQL text and imports nothing Node-only, so both
 * readers share it.
 */
import { csvNumberFormat, INVISIBLE_CHARS_RE2 } from '../parsers/csv-text-normalize.js';
import { MISSING_NUMBER_CELL_RE2 } from '../parsers/csv-column-types.js';

export function escapeSqlLiteral(value) {
    return String(value ?? '').replace(/'/g, "''");
}

function quoteIdent(name) {
    return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

/**
 * Whether numbers in this file are written with a decimal comma: what the
 * reader chose, what the sample showed, or — for a profile from before
 * either was recorded — whether a sampled cell looks like "1,5".
 */
export function csvProfileUsesDecimalComma(profile) {
    const { decimalSeparator } = csvNumberFormat(profile);
    if (decimalSeparator === ',') return true;
    if (decimalSeparator !== 'auto') return false;
    if (!profile || profile.delimiter === ',') return false;
    for (const row of profile.sampleRows || []) {
        for (const cell of row || []) {
            const raw = String(cell ?? '').trim();
            if (/^[+-]?\d+,\d+(?:[eEdD][+-]?\d+)?$/.test(raw)) return true;
        }
    }
    return false;
}

/**
 * A cell's text when it holds a value: NULL for an empty cell and for a
 * missing-value marker (NaN, NULL, N/A, "-"), as isMissingNumberCell says
 * in the in-memory reader. A column of numbers with "-" for the hours a
 * meter did not report is a column of numbers.
 */
export function csvFilledCellSql(expr) {
    const text = `trim(CAST(${expr} AS VARCHAR))`;
    return `(CASE WHEN regexp_full_match(${text}, '${MISSING_NUMBER_CELL_RE2.replace(/'/g, "''")}') THEN NULL ELSE NULLIF(${text}, '') END)`;
}

/**
 * A text cell read as a DOUBLE, translating the profile's number format.
 * With nothing to translate it is the plain try_cast every file used to get,
 * so ordinary files pay nothing for the rest.
 */
export function csvNumericCastSql(expr, profile = null) {
    const { decimalSeparator, thousandsSeparator } = csvNumberFormat(profile);
    let value = `CAST(${expr} AS VARCHAR)`;
    let translated = false;
    if (thousandsSeparator === ' ') {
        value = `regexp_replace(${value}, '[\\s\\x{A0}\\x{202F}\\x{2009}\\x{2007}]', '', 'g')`;
        translated = true;
    } else if (thousandsSeparator === "'") {
        value = `regexp_replace(${value}, '[''\\x{2019}]', '', 'g')`;
        translated = true;
    } else if (thousandsSeparator && thousandsSeparator !== 'auto' && thousandsSeparator !== 'none'
        && thousandsSeparator !== decimalSeparator) {
        value = `replace(${value}, '${escapeSqlLiteral(thousandsSeparator)}', '')`;
        translated = true;
    }
    if (csvProfileUsesDecimalComma(profile)) {
        value = `replace(${value}, ',', '.')`;
        translated = true;
    } else if (decimalSeparator && decimalSeparator !== 'auto' && decimalSeparator !== '.' && decimalSeparator !== ',') {
        value = `replace(${value}, '${escapeSqlLiteral(decimalSeparator)}', '.')`;
        translated = true;
    }
    const cast = translated ? `try_cast(${value} AS DOUBLE)` : `try_cast(${expr} AS DOUBLE)`;
    // "0x1F", as logic analysers write a digital bus: the in-memory reader
    // reads it as 31 (Number does), DuckDB only through an integer cast.
    return csvProfileHasHexNumbers(profile)
        ? `coalesce(${cast}, try_cast(try_cast(trim(CAST(${expr} AS VARCHAR)) AS UBIGINT) AS DOUBLE))`
        : cast;
}

const HEX_CELL = /^0x[0-9a-f]+$/i;
const hexNumbersByProfile = new WeakMap();

/**
 * Whether the profile's sample writes numbers in hexadecimal ("0x00"). A
 * profile reduced to its number format (a lazy variable's) says it with
 * `hexNumbers`.
 */
export function csvProfileHasHexNumbers(profile) {
    if (!profile || typeof profile !== 'object') return false;
    if (typeof profile.hexNumbers === 'boolean') return profile.hexNumbers;
    if (hexNumbersByProfile.has(profile)) return hexNumbersByProfile.get(profile);
    let found = false;
    const rows = Array.isArray(profile.sampleRows) ? profile.sampleRows : [];
    for (const row of rows) {
        const cells = Array.isArray(row) ? row : (row && typeof row === 'object' ? Object.values(row) : []);
        if (cells.some(cell => HEX_CELL.test(String(cell ?? '').trim()))) { found = true; break; }
    }
    hexNumbersByProfile.set(profile, found);
    return found;
}

/**
 * read_csv options the profile's repairs need, besides the column list.
 *
 * Rows ending in empty cells past the header (a trailing delimiter) need
 * nothing: DuckDB's reader already reads them as the row, as the in-memory
 * parser does (fitCsvRowToWidth). Short rows are left out unless the reader
 * chose to keep them ('pad'), and then their missing cells are NULL.
 */
export function csvReadRepairOptions(profile) {
    const options = [];
    if (profile?.raggedRows === 'pad') options.push('null_padding=true');
    // Rows that run past the header: DuckDB accepts empty cells there, but a
    // single space ("1000000;-20,05; ", a Rohde & Schwarz sweep) made every
    // row an error, and ignore_errors then dropped the whole table. The
    // in-memory reader drops blank cells past the header (fitCsvRowToWidth).
    if (Number(profile?.trailingEmptyCells) > 0) options.push('strict_mode=false');
    // Data lines ending in CRLF: said explicitly. Left to itself, DuckDB
    // skipped the wrong number of lines (or failed) when the lines above the
    // table mixed LF and CRLF, and the preamble and header became data.
    if (profile?.lineEnding === 'crlf') options.push("new_line='\\r\\n'");
    // Fields quoted with ' (an apostrophe in SQL is written twice), and a
    // backslash before quotes, as the sample showed (CsvParser._detectQuoting).
    if (profile?.quoteChar === "'") options.push("quote=''''");
    if (profile?.escapeChar === '\\') options.push("escape='\\'");
    return options;
}

/**
 * The read_csv expression, as a subquery that applies the repairs read_csv
 * cannot: invisible characters removed from every column, and the time
 * column's decimal comma and weekday handled. Null when there is nothing to
 * repair — the caller then uses read_csv directly.
 *
 * @param {string} readSql the read_csv(...) call
 * @param {object} profile
 * @param {string[]} columnNames the table's columns
 */
export function csvRepairProjectionSql(readSql, profile, columnNames) {
    const sanitize = Number(profile?.removedInvisibleChars) > 0;
    const timeSource = profile?.timeSource || {};
    const timeIndexes = new Set(timeSource.kind === 'datetime' ? (timeSource.sourceIndexes || []) : []);
    const fractionComma = !!timeSource.format?.fractionComma && timeSource.strategy !== 'custom-format';
    const weekday = !!timeSource.format?.weekday && timeSource.strategy !== 'custom-format';
    if (!sanitize && !fractionComma && !weekday) return null;
    const exprs = columnNames.map((name, index) => {
        let expr = quoteIdent(name);
        let changed = false;
        if (sanitize) {
            expr = `regexp_replace(${expr}, '${INVISIBLE_CHARS_RE2}', '', 'g')`;
            changed = true;
        }
        if (timeIndexes.has(index)) {
            if (weekday) {
                expr = `regexp_replace(trim(${expr}), '^[\\p{L}-]{2,14}\\.?,?\\s+', '')`;
                changed = true;
            }
            if (fractionComma) {
                expr = `regexp_replace(${expr}, '(\\d:\\d{2}(?::\\d{2})?),(\\d)', '\\1.\\2')`;
                changed = true;
            }
        }
        return changed ? `${expr} AS ${quoteIdent(name)}` : quoteIdent(name);
    });
    return `(SELECT ${exprs.join(', ')} FROM ${readSql})`;
}
