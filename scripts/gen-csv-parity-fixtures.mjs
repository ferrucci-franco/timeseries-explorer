// Writes test-files/csv-parity/: small CSVs built so that a reader which
// decides anything from the first rows alone reads them differently from one
// that reads the whole file. The in-memory parser reads the whole file; the
// DuckDB readers used to decide a column's type and a file's number format
// from the 100-row sample, and these files are where that showed:
//
//   node scripts/gen-csv-parity-fixtures.mjs
//
// scripts/test-csv-duckdb-parity.mjs reads every one of them through the three
// readers. Deterministic: running this again changes nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'test-files/csv-parity';
mkdirSync(dir, { recursive: true });

const stamp = (minutes) => {
    const d = new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minutes * 60000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
};
// A fixed-seed generator: the files must not change between runs.
let seed = 12345;
const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};
const write = (name, lines) => writeFileSync(path.join(dir, name), lines.join('\n') + '\n');

// A sensor that writes "OFF" until the plant starts (150 rows), then numbers:
// mostly numbers over the file, so a numeric column, with the first rows
// missing. The sample says text.
write('01_text_then_numbers.csv', [
    'time,sensor,counter',
    ...Array.from({ length: 600 }, (_, i) => `${stamp(i)},${i < 150 ? 'OFF' : (i * 0.5).toFixed(1)},${i}`),
]);

// The opposite: a reading that is numeric for 150 rows and a status word
// after, so a text column over the file. The sample says numbers.
write('02_numbers_then_text.csv', [
    'time,reading,counter',
    ...Array.from({ length: 600 }, (_, i) => `${stamp(i)},${i < 150 ? (i * 0.5).toFixed(1) : 'OFF'},${i}`),
]);

// A meter that passes 1000 after the sample and starts grouping thousands
// with a comma, quoted: "1,203.5". The first 200 rows show no grouping at
// all, so the number format stays on auto and each cell is read on its own.
write('03_thousands_after_sample.csv', [
    'time,energy,counter',
    ...Array.from({ length: 600 }, (_, i) => {
        const value = i < 200 ? (i * 0.5).toFixed(1) : `${Math.floor((1000 + i) / 1000)},${String((1000 + i) % 1000).padStart(3, '0')}.5`;
        return `${stamp(i)},"${value}",${i}`;
    }),
]);

// Three rows per minute, written out of order: rows at the same instant must
// keep the file's order once the file is sorted by time (a stable sort), and
// the ones out of order must land where their time says.
{
    const order = Array.from({ length: 300 }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    write('04_repeated_stamps_unsorted.csv', [
        'time,sequence',
        ...order.map((i, k) => `${stamp(Math.floor(i / 3))},${k}`),
    ]);
}

// Three rows per minute in the file's order: the lazy reader streams the
// file as written, so here every reader must give the same sequence.
write('05_repeated_stamps_sorted.csv', [
    'time,sequence',
    ...Array.from({ length: 300 }, (_, k) => `${stamp(Math.floor(k / 3))},${k}`),
]);

// A European logger: decimal comma everywhere, a space grouping thousands
// only once the values are large enough (after the sample), a Fortran "D"
// exponent from a Fortran post-processor, a typographic minus from a report,
// and a missing-value marker. The sample sees "12,5" and nothing else.
write('06_european_late_grouping.csv', [
    'Zeit;Leistung;Druck;Status',
    ...Array.from({ length: 500 }, (_, i) => {
        const power = i < 150 ? `${12 + (i % 7)},5` : `${1 + Math.floor(i / 100)} ${String((i * 37) % 1000).padStart(3, '0')},25`;
        const pressure = i % 50 === 10 ? '-' : i % 50 === 20 ? '1,5D2' : i % 50 === 30 ? '−2,5' : `0,${String(i % 100).padStart(2, '0')}`;
        const status = i % 100 < 50 ? 'RUN' : 'STOP';
        return `${stamp(i)};${power};${pressure};${status}`;
    }),
]);

// A status column with numbers in the first rows and a word in less than half
// of the rest, and a code column that is empty for the whole sample and then
// text: both must be typed from the whole file.
write('07_late_text_and_late_codes.csv', [
    'time,mode,code,value',
    ...Array.from({ length: 400 }, (_, i) => {
        const mode = i < 120 ? String(i % 3) : (i % 4 === 0 ? 'manual' : String(i % 3));
        const code = i < 250 ? '' : `E${String(i % 17).padStart(2, '0')}`;
        return `${stamp(i)},${mode},${code},${(Math.sin(i / 20) * 10).toFixed(3)}`;
    }),
]);

console.log(`wrote ${dir}/`);
