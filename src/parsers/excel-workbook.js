// Excel/LibreOffice workbook support (.xlsx, .xlsm, .xls, .ods).
//
// The app does not parse spreadsheets directly: each selected sheet is
// serialized to deterministic CSV text (UTF-8, comma-delimited, dot decimals,
// ISO dates) and fed to the existing CSV pipeline, so header detection, time
// detection, the >50% numeric rule and the parsing-preview dialog all apply
// unchanged. This module is app-free on purpose so Node test scripts can
// import it directly.

let xlsxModulePromise = null;

export async function loadXlsxModule() {
    if (!xlsxModulePromise) {
        xlsxModulePromise = import('xlsx');
    }
    return xlsxModulePromise;
}

export function readWorkbook(XLSX, buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // cellDates resolves both the 1900 and 1904 date systems to JS Dates.
    // Formatted text, formula strings and HTML are skipped: the serializer
    // only reads raw values, and generating them roughly doubles the decode
    // time on large workbooks.
    return XLSX.read(bytes, {
        type: 'array',
        cellDates: true,
        dense: true,
        cellText: false,
        cellFormula: false,
        cellHTML: false,
    });
}

const COLUMN_BASE = 26;
const A_CODE = 'A'.charCodeAt(0);

function decodeColumn(label) {
    let column = 0;
    for (let i = 0; i < label.length; i++) {
        column = column * COLUMN_BASE + (label.charCodeAt(i) - A_CODE + 1);
    }
    return column - 1;
}

function decodeCellAddress(address) {
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    if (!match) return null;
    return { r: parseInt(match[2], 10) - 1, c: decodeColumn(match[1]) };
}

function decodeRange(ref) {
    const [startRef, endRef] = String(ref || '').split(':');
    const start = decodeCellAddress(startRef || '');
    if (!start) return null;
    const end = endRef ? decodeCellAddress(endRef) : start;
    return end ? { s: start, e: end } : null;
}

function encodeColumn(column) {
    let label = '';
    let value = column + 1;
    while (value > 0) {
        const digit = (value - 1) % COLUMN_BASE;
        label = String.fromCharCode(A_CODE + digit) + label;
        value = Math.floor((value - 1) / COLUMN_BASE);
    }
    return label;
}

function makeCellGetter(worksheet) {
    const dense = worksheet['!data'];
    if (dense) return (r, c) => dense[r]?.[c];
    return (r, c) => worksheet[`${encodeColumn(c)}${r + 1}`];
}

function sheetVisibility(workbook, sheetName) {
    const sheetInfo = (workbook.Workbook?.Sheets || []).find(s => s?.name === sheetName);
    return Number(sheetInfo?.Hidden || 0) !== 0;
}

export function listSheets(workbook) {
    return (workbook?.SheetNames || []).map(name => {
        const worksheet = workbook.Sheets?.[name];
        const isChartOrMacro = !!worksheet?.['!type'];
        const range = isChartOrMacro ? null : decodeRange(worksheet?.['!ref']);
        return {
            name,
            rowCount: range ? range.e.r - range.s.r + 1 : 0,
            colCount: range ? range.e.c - range.s.c + 1 : 0,
            hidden: sheetVisibility(workbook, name),
            empty: !range,
        };
    });
}

export function nonEmptySheetNames(workbook) {
    return listSheets(workbook).filter(sheet => !sheet.empty).map(sheet => sheet.name);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatDateCell(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    // UTC getters without a Z suffix: SheetJS maps the workbook's wall-clock
    // date/time onto UTC, and the CSV time detection treats naive ISO strings
    // as local wall-clock too, so the user sees the same instants as in Excel.
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dayOfMonth = date.getUTCDate();
    const h = date.getUTCHours();
    const m = date.getUTCMinutes();
    const s = date.getUTCSeconds();
    const ms = date.getUTCMilliseconds();
    const time = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    const timeWithMs = ms ? `${time}.${String(ms).padStart(3, '0')}` : time;
    // Time-only cells (serial < 1) land on the Excel zero date — 1899-12-30
    // or 1899-12-31 depending on the 1900 leap-bug correction SheetJS applies
    // to serials < 60. Emit just the time so split date+time detection works.
    if (year === 1899 && month === 12 && (dayOfMonth === 30 || dayOfMonth === 31)) return timeWithMs;
    const day = `${year}-${pad2(month)}-${pad2(dayOfMonth)}`;
    if (!h && !m && !s && !ms) return day;
    return `${day} ${timeWithMs}`;
}

function quoteCsvField(text) {
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function cellToCsvField(cell) {
    if (!cell) return '';
    switch (cell.t) {
        case 'n': return Number.isFinite(cell.v) ? String(cell.v) : '';
        case 'd': return formatDateCell(cell.v);
        case 'b': return cell.v ? '1' : '0';
        case 's':
        case 'str': return quoteCsvField(String(cell.v ?? ''));
        default: return '';
    }
}

export function sheetToCsvText(workbook, sheetName) {
    const worksheet = workbook?.Sheets?.[sheetName];
    if (!worksheet) throw new Error(`Sheet not found: ${sheetName}`);
    const range = decodeRange(worksheet['!ref']);
    if (!range) return '';
    const getCell = makeCellGetter(worksheet);

    // The declared range often includes stale trailing rows/columns; trim to
    // the last cell with content so header/data detection sees a clean table.
    let lastRow = -1;
    let lastCol = -1;
    for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
            const cell = getCell(r, c);
            if (cell && cell.t !== 'z' && cell.v !== undefined && cell.v !== null && cell.v !== '') {
                if (r > lastRow) lastRow = r;
                if (c > lastCol) lastCol = c;
            }
        }
    }
    if (lastRow < 0) return '';

    const lines = [];
    for (let r = range.s.r; r <= lastRow; r++) {
        const fields = [];
        for (let c = range.s.c; c <= lastCol; c++) {
            fields.push(cellToCsvField(getCell(r, c)));
        }
        lines.push(fields.join(','));
    }
    return lines.join('\n');
}

export function csvTextToBuffer(text) {
    return new TextEncoder().encode(text).buffer;
}
