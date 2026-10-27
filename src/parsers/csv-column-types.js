// Is a delimited-text column numbers or text? The one rule both load paths use.
//
// The app reads the same file through two readers — the in-memory CsvParser and
// DuckDB (src/data/duckdb-source.js) — and each one decided this question for
// itself. They disagreed on the case that matters most to a measurement log: a
// column the sample holds NO value for, because the logger wrote the channel's
// header and never recorded it (REC_*.txt SCADA exports). The in-memory parser
// called it numeric; the DuckDB path called it text, which is how a `BATT_I` of
// 30 000 empty cells arrived as a string series that cannot be plotted or used
// in a formula.
//
// Empty says nothing about a column's type, so neither reader may take it as
// evidence of text. 'unknown' is that answer said out loud: the DuckDB path
// asks the file itself (_resolveUnknownCsvColumnTypes) instead of guessing, and
// a caller with no file to scan — the in-memory parser, the Parquet
// converter — reads it as numeric, which is what a log of numbers almost always
// means and what costs nothing when it is wrong (an empty column holds no text
// to lose).

import { parseCsvNumber } from './csv-time-detection.js';

export const NUMERIC_COLUMN_MIN_RATIO = 0.5;

// "NaN" (any case, optionally signed, as C/Python/LabVIEW print it) is a missing
// number, not text: a logger that writes NaN for an absent sensor must not turn
// its first data row into a header, nor a column of mostly-missing values into a
// string column.
const MISSING_NUMBER_CELL = /^[+-]?nan$/i;
export function isMissingNumberCell(cell) {
    return MISSING_NUMBER_CELL.test(String(cell ?? '').trim());
}

// Numbers unless the non-empty cells say otherwise. A column with nothing in it
// returns true — see the note on 'unknown' above.
export function isMostlyNumericColumn(column) {
    if (!column || column.nonEmptyCount <= 0) return true;
    return (column.finiteCount / column.nonEmptyCount) > NUMERIC_COLUMN_MIN_RATIO;
}

// What one column of a sample holds. Empty cells and NaN are missing values and
// count as neither.
export function columnSampleCounts(rows, index, delimiter, decimalSeparator = 'auto') {
    let nonEmptyCount = 0;
    let finiteCount = 0;
    for (const row of rows || []) {
        const raw = String(row?.[index] ?? '').trim();
        if (!raw || isMissingNumberCell(raw)) continue;
        nonEmptyCount++;
        if (Number.isFinite(parseCsvNumber(raw, delimiter, decimalSeparator))) finiteCount++;
    }
    return { nonEmptyCount, finiteCount };
}

/**
 * 'numeric' | 'text' | 'unknown' for one column of a sample.
 *
 * 'unknown' means the sample held no value for it: the sample cannot answer,
 * and whoever asked has to decide what to do about that.
 */
export function columnSampleVerdict(rows, index, delimiter, decimalSeparator = 'auto') {
    const counts = columnSampleCounts(rows, index, delimiter, decimalSeparator);
    if (counts.nonEmptyCount <= 0) return 'unknown';
    return isMostlyNumericColumn(counts) ? 'numeric' : 'text';
}

// Which columns of a sample to read as numbers — every one the sample does not
// call text.
export function inferNumericColumnIndexes(rows, columnCount, delimiter, decimalSeparator = 'auto') {
    const numericIndexes = [];
    for (let index = 0; index < columnCount; index++) {
        if (columnSampleVerdict(rows, index, delimiter, decimalSeparator) !== 'text') numericIndexes.push(index);
    }
    return numericIndexes;
}
