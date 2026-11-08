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
import { MISSING_NUMBER_CELLS } from '../parsers/csv-column-types.js';

export function escapeSqlLiteral(value) {
    return String(value ?? '').replace(/'/g, "''");
}

function quoteIdent(name) {
    return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

/**
 * A value computed once and named, for an expression that reads it many
 * times: a lambda over a one-element list. Written out instead, the text and
 * the regular expression ran once per mention, dozens of times per cell, and
 * the time axis of a lazy file took five times as long to read.
 */
let bindCount = 0;
export function sqlBind(value, body) {
    const name = `__omv_${(bindCount++).toString(36)}`;
    return `list_transform([${value}], lambda ${name}: ${body(name)})[1]`;
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
 *
 * The markers are a short list, so they are compared as one: this runs on
 * every cell of every column when a file's column types are scanned.
 */
export function csvFilledCellSql(expr) {
    const text = `trim(CAST(${expr} AS VARCHAR))`;
    const markers = MISSING_NUMBER_CELLS.map(marker => `'${escapeSqlLiteral(marker)}'`).join(', ');
    return `(CASE WHEN lower(${text}) IN (${markers}) THEN NULL ELSE NULLIF(${text}, '') END)`;
}

/**
 * The separators a profile reads numbers with, resolved as parseCsvNumber
 * resolves them: 'auto' where nothing was chosen or detected, and a grouping
 * character that implies the other one is the decimal mark.
 *
 * @returns {{ decimalMode: string, thousandsMode: string, delimiter: string }}
 */
export function csvNumberModes(profile) {
    const { decimalSeparator, thousandsSeparator } = csvNumberFormat(profile);
    let decimalMode = !decimalSeparator || decimalSeparator === 'auto' ? 'auto' : String(decimalSeparator);
    let thousandsMode = !thousandsSeparator || thousandsSeparator === 'auto'
        ? 'auto'
        : thousandsSeparator === 'none' ? 'none' : String(thousandsSeparator);
    if (decimalMode === 'auto' && thousandsMode === '.') decimalMode = ',';
    if (decimalMode === 'auto' && thousandsMode === ',') decimalMode = '.';
    if (thousandsMode !== 'auto' && thousandsMode === decimalMode) thousandsMode = 'none';
    return { decimalMode, thousandsMode, delimiter: profile?.delimiter || ',' };
}

// The whitespace JavaScript's \s matches and a number may be grouped with:
// the ASCII spaces, the no-break spaces (French exports), thin and figure
// spaces, and the wide ones.
const WS = '[\\s\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]';

function stripWhitespaceSql(text) {
    return `regexp_replace(${text}, '${WS}', '', 'g')`;
}

// The decimal step of parseCsvNumber for a value whose thousands groups are
// already gone: the decimal mark becomes a dot.
function decimalToDotSql(value, decimalMode, delimiter) {
    if (decimalMode === ',') return `replace(${value}, ',', '.')`;
    if (decimalMode === 'auto') {
        // With a comma delimiter a comma inside a cell was quoted, so "2,0825"
        // is a decimal comma. Only "1,234", a thousand in a US file, stays
        // unread until the file's number format says which it is.
        const grouped = delimiter === ','
            ? ` AND NOT regexp_full_match(${value}, '[+-]?[1-9]\\d{0,2}(?:,\\d{3})+')`
            : '';
        return `(CASE WHEN contains(${value}, ',') AND NOT contains(${value}, '.')${grouped}`
            + ` THEN replace(${value}, ',', '.') ELSE ${value} END)`;
    }
    if (decimalMode === '.') return value;
    return `replace(${value}, '${escapeSqlLiteral(decimalMode)}', '.')`;
}

/**
 * A cell read as parseCsvNumber reads it, step by step, for the cells
 * DuckDB's own cast refuses: a typographic minus, thousands grouped by a
 * space, an apostrophe, a dot or a comma, a space after the sign, a Fortran
 * "D" exponent, and a decimal comma where the cell can only mean one. A cell
 * with digits separated by spaces ("0        299", a fixed-width row) is no
 * number, as in JS.
 *
 * It is the slow path behind csvNumericCastSql's coalesce, so a file of
 * plain numbers never evaluates it; a text column does, once per cell, on
 * the scan that types the column.
 */
export function csvNumberFallbackSql(expr, modes) {
    const { decimalMode, thousandsMode, delimiter } = modes;
    return sqlBind(`trim(CAST(${expr} AS VARCHAR))`, raw => {
        // Nothing without a digit is a number: a word is refused here, before
        // the regular expressions below look at it.
        const minus = `regexp_replace(${raw}, '^[\\x{2212}\\x{2010}\\x{2013}]', '-')`;
        return `(CASE WHEN regexp_matches(${raw}, '[0-9]') THEN ${sqlBind(minus, t => {
            // Spaces inside a number are thousands groups ("1 234,5") or
            // follow a sign ("- 5"); anywhere else they separate two values.
            const grouped = `regexp_full_match(${t}, '[+-]?\\d{1,3}(?:${WS}\\d{3})+(?:[.,]\\d+)?(?:[eEdD][+-]?\\d+)?')`;
            const signed = `regexp_full_match(${t}, '[+-]${WS}+\\S+')`;
            const split = `regexp_matches(${t}, '\\d${WS}+\\d')`;
            const compact = `(CASE WHEN NOT regexp_matches(${t}, '${WS}') THEN ${t}`
                + ` WHEN ${grouped} OR ${signed} OR NOT ${split} THEN ${stripWhitespaceSql(t)} END)`;
            return sqlBind(compact, c => {
                // "1.5D3" is 1500; "0xD0" keeps its D (the hex coalesce reads it).
                const normalized = `(CASE WHEN regexp_matches(${c}, '^[+-]?0[xX]') THEN ${c}`
                    + ` ELSE regexp_replace(${c}, '[dD]([+-]?\\d+)$', 'e\\1') END)`;
                return sqlBind(normalized, n => {
                    let value;
                    if (thousandsMode === 'auto') {
                        // Only groupings that cannot be read another way.
                        const apostrophes = `regexp_full_match(${n}, '[+-]?\\d{1,3}(?:[''\\x{2019}]\\d{3})+(?:[.,]\\d+)?')`;
                        const dotGroups = `regexp_full_match(${n}, '[+-]?\\d{1,3}(?:\\.\\d{3})+,\\d+')`;
                        const commaGroups = `regexp_full_match(${n}, '[+-]?\\d{1,3}(?:,\\d{3})+\\.\\d+')`;
                        const decimal = (v) => sqlBind(v, s => decimalToDotSql(s, decimalMode, delimiter));
                        const branches = [
                            `WHEN ${apostrophes} THEN ${decimal(`regexp_replace(${n}, '[''\\x{2019}]', '', 'g')`)}`,
                        ];
                        if (decimalMode !== '.') {
                            // The dots group, so the comma is the decimal mark.
                            branches.push(`WHEN ${dotGroups} THEN replace(replace(${n}, '.', ''), ',', '.')`);
                        }
                        if (decimalMode !== ',') {
                            branches.push(`WHEN ${commaGroups} THEN ${decimal(`replace(${n}, ',', '')`)}`);
                        }
                        value = `(CASE ${branches.join(' ')} ELSE ${decimalToDotSql(n, decimalMode, delimiter)} END)`;
                    } else {
                        let stripped = n;
                        if (thousandsMode === "'") stripped = `regexp_replace(${n}, '[''\\x{2019}]', '', 'g')`;
                        else if (thousandsMode !== 'none' && thousandsMode !== ' ') stripped = `replace(${n}, '${escapeSqlLiteral(thousandsMode)}', '')`;
                        value = decimalToDotSql(stripped, decimalMode, delimiter);
                    }
                    return `try_cast(${value} AS DOUBLE)`;
                });
            });
        })} END)`;
    });
}

/**
 * A text cell read as a DOUBLE, as parseCsvNumber reads it in memory.
 *
 * DuckDB's own cast reads the usual cell, translated first when the profile
 * names a decimal mark or a grouping character; the cells it refuses go to
 * csvNumberFallbackSql, which reads each one on its own as the in-memory
 * reader does. A file of plain numbers evaluates the cast and nothing else,
 * so it costs what the bare try_cast every file used to get cost; the
 * difference is that "1,203.5" at row 300 of a file whose sample held only
 * "0.5" reads as 1203.5 in both readers, where DuckDB used to read NaN.
 */
export function csvNumericCastSql(expr, profile = null) {
    const modes = csvNumberModes(profile);
    const { decimalMode, thousandsMode } = modes;
    let value = `CAST(${expr} AS VARCHAR)`;
    let translated = false;
    if (thousandsMode === "'") {
        value = `regexp_replace(${value}, '[''\\x{2019}]', '', 'g')`;
        translated = true;
    } else if (thousandsMode !== 'auto' && thousandsMode !== 'none' && thousandsMode !== ' ') {
        value = `replace(${value}, '${escapeSqlLiteral(thousandsMode)}', '')`;
        translated = true;
    }
    if (decimalMode === ',') {
        value = `replace(${value}, ',', '.')`;
        translated = true;
    } else if (decimalMode !== 'auto' && decimalMode !== '.') {
        value = `replace(${value}, '${escapeSqlLiteral(decimalMode)}', '.')`;
        translated = true;
    }
    const parts = [
        translated ? `try_cast(${value} AS DOUBLE)` : `try_cast(${expr} AS DOUBLE)`,
        csvNumberFallbackSql(expr, modes),
    ];
    // "0x1F", as logic analysers write a digital bus: the in-memory reader
    // reads it as 31 (Number does), DuckDB only through an integer cast.
    if (csvProfileHasHexNumbers(profile)) {
        parts.push(`try_cast(try_cast(trim(CAST(${expr} AS VARCHAR)) AS UBIGINT) AS DOUBLE)`);
    }
    return `coalesce(${parts.join(', ')})`;
}

/**
 * The number format a lazy variable carries, reduced to what
 * csvNumericCastSql reads: plain data, so it survives the structuredClone
 * of a variable, and complete, so a read of the column on any later query
 * (zoom, Data tools, a formula) translates it as the overview did.
 */
export function csvNumberCastFormat(profile) {
    const { decimalMode, thousandsMode, delimiter } = csvNumberModes(profile);
    return {
        decimalSeparator: decimalMode,
        thousandsSeparator: thousandsMode,
        delimiter,
        hexNumbers: csvProfileHasHexNumbers(profile),
    };
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
    // Short rows padded when the reader chose to keep them, and when the
    // table's last columns are optional (optionalTrailingColumns: a notes
    // column few rows fill), which the in-memory reader pads for itself.
    if (profile?.raggedRows === 'pad' || Number(profile?.optionalTrailingColumns) > 0) options.push('null_padding=true');
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
 * cannot: invisible characters removed from every column, text columns
 * trimmed, and the time column's decimal comma and weekday handled. Null when
 * there is nothing to repair — the caller then uses read_csv directly.
 *
 * Text columns are trimmed because the in-memory reader trims every cell: a
 * space-padded flag (" IDLE", Betaflight logs) or a note after "; " must be
 * the same text through both readers, in the overview and in every lazy
 * read. Numbers and dates need nothing: their casts trim on their own.
 *
 * @param {string} readSql the read_csv(...) call
 * @param {object} profile
 * @param {string[]} columnNames the table's columns
 * @param {{ textColumns?: Iterable<string> }} [options] the columns read as text
 */
export function csvRepairProjectionSql(readSql, profile, columnNames, options = {}) {
    const sanitize = Number(profile?.removedInvisibleChars) > 0;
    const textColumns = new Set(options.textColumns || []);
    const timeSource = profile?.timeSource || {};
    const timeIndexes = new Set(timeSource.kind === 'datetime' ? (timeSource.sourceIndexes || []) : []);
    const fractionComma = !!timeSource.format?.fractionComma && timeSource.strategy !== 'custom-format';
    const weekday = !!timeSource.format?.weekday && timeSource.strategy !== 'custom-format';
    if (!sanitize && !fractionComma && !weekday && !textColumns.size) return null;
    const exprs = columnNames.map((name, index) => {
        let expr = quoteIdent(name);
        let changed = false;
        if (sanitize) {
            expr = `regexp_replace(${expr}, '${INVISIBLE_CHARS_RE2}', '', 'g')`;
            changed = true;
        }
        if (textColumns.has(name) && !timeIndexes.has(index)) {
            expr = `trim(${expr})`;
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
