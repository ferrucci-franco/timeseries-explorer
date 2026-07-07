#!/usr/bin/env node
// Generates the spreadsheet fixtures used by scripts/test-excel-parser.mjs.
// Run once (or after changing the fixture definitions):
//   node scripts/make-excel-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

const OUT_DIR = 'test-files/excel';

function hourlyDates(count, startIso = '2024-01-01T00:00:00Z') {
    const start = new Date(startIso).getTime();
    return Array.from({ length: count }, (_, i) => new Date(start + i * 3600_000));
}

function sheetFromAoa(rows) {
    return XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
}

function basicRows() {
    const dates = hourlyDates(24);
    const rows = [['Time', 'Voltage (V)', 'Current (A)', 'Status']];
    dates.forEach((date, i) => {
        rows.push([date, 230 + Math.sin(i / 3) * 5, 1.5 + i * 0.01, i % 6 === 0 ? 'peak' : 'ok']);
    });
    return rows;
}

function writeBook(workbook, filename, bookType) {
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType, cellDates: true });
    writeFileSync(join(OUT_DIR, filename), bytes);
    console.log('wrote', join(OUT_DIR, filename));
}

export function makeExcelFixtures() {
    mkdirSync(OUT_DIR, { recursive: true });

    // basic single sheet with ISO-like datetime axis (.xlsx, .ods and .xls)
    for (const [filename, bookType] of [
        ['basic-datetime.xlsx', 'xlsx'],
        ['basic-datetime.ods', 'ods'],
        ['basic-datetime.xls', 'biff8'],
    ]) {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheetFromAoa(basicRows()), 'Data');
        writeBook(workbook, filename, bookType);
    }

    // multiple sheets: two with data, one empty, one hidden
    {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheetFromAoa(basicRows()), 'Measurements');
        const summaryRows = [['Metric', 'Value']];
        for (let i = 0; i < 5; i++) summaryRows.push([`metric_${i}`, i * 10.5]);
        XLSX.utils.book_append_sheet(workbook, sheetFromAoa(summaryRows), 'Summary');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Empty');
        XLSX.utils.book_append_sheet(workbook, sheetFromAoa([['x'], [1], [2]]), 'HiddenSheet');
        workbook.Workbook = { Sheets: [
            { name: 'Measurements', Hidden: 0 },
            { name: 'Summary', Hidden: 0 },
            { name: 'Empty', Hidden: 0 },
            { name: 'HiddenSheet', Hidden: 1 },
        ] };
        writeBook(workbook, 'multi-sheet.xlsx', 'xlsx');
    }

    // preamble + header + units row (the CSV pipeline must auto-detect these)
    {
        const rows = [
            ['Logger export'],
            ['Device: X-1000'],
            [],
            ['Time', 'Voltage', 'Current'],
            ['-', 'V', 'A'],
        ];
        hourlyDates(12).forEach((date, i) => rows.push([date, 230 + i, 1.5 - i * 0.02]));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheetFromAoa(rows), 'Log');
        writeBook(workbook, 'header-units-preamble.xlsx', 'xlsx');
    }

    // split date + time-of-day columns (time cells are serials < 1)
    {
        const rows = [['Date', 'Time', 'Power']];
        for (let i = 0; i < 18; i++) {
            const timeCell = { t: 'n', v: (8 * 3600 + i * 600) / 86400, z: 'hh:mm:ss' };
            rows.push([new Date(2024, 2, 1 + Math.floor(i / 6)), timeCell, 40 + i]);
        }
        const worksheet = sheetFromAoa(rows.map(row => row.map(cell => (cell?.t ? null : cell))));
        rows.forEach((row, r) => row.forEach((cell, c) => {
            if (cell?.t) worksheet[XLSX.utils.encode_cell({ r, c })] = cell;
        }));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Split');
        writeBook(workbook, 'split-date-time.xlsx', 'xlsx');
    }

    // strings with commas/quotes/newlines, booleans, cached formula, error cell
    {
        const worksheet = sheetFromAoa([
            ['Name', 'Note', 'Flag', 'Result'],
            ['Smith, John', 'He said "hi"', true, 1.5],
            ['Line\nbreak', 'café', false, 42],
            ['plain', 'ok', true, 3.25],
        ]);
        worksheet[XLSX.utils.encode_cell({ r: 2, c: 3 })] = { t: 'n', v: 42, f: '2*21' };
        worksheet[XLSX.utils.encode_cell({ r: 3, c: 3 })] = { t: 'e', v: 0x07, w: '#DIV/0!' };
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Mixed');
        writeBook(workbook, 'mixed-content.xlsx', 'xlsx');
    }

    // 1904 date system (classic Mac Excel)
    {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheetFromAoa(basicRows()), 'Data');
        workbook.Workbook = { WBProps: { date1904: true } };
        writeBook(workbook, 'dates-1904.xlsx', 'xlsx');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    makeExcelFixtures();
}
