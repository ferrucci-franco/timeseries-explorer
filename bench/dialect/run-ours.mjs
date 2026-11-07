// The dialect Time Series Explorer's CSV reader detects for every file of the
// benchmark, written as JSON lines in the format of the CSV_Wrangling results
// (delimiter, quotechar, escapechar), so score.py compares them directly.
//
//   node bench/dialect/run-ours.mjs bench/data/dialect/github > out_ours_github.jsonl
//
// The reader reads what the app reads: the first 2 MiB, decoded and cleaned
// as the app does, and the delimiter chosen by CsvParser._detectDelimiter.
// The dialect is derived from that choice:
//   - delimiter '' when it splits no line (a one-column file);
//   - quotechar and escapechar from CsvParser._detectQuoting: '"' or "'"
//     when the reader opens quoted fields with it, else ''; '\\' when a
//     backslash escapes quotes, else '' (RFC 4180 doubled quotes).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import CsvParser from '../../src/parsers/csv-parser.js';

const dir = process.argv[2];
const SAMPLE_BYTES = 2 * 1024 * 1024;
const parser = new CsvParser();

for (const name of readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
    const started = performance.now();
    const record = { detector: 'ours', filename: `./data/${dir.split('/').filter(Boolean).pop()}/${name}`, status: 'OK' };
    try {
        const bytes = readFileSync(join(dir, name)).subarray(0, SAMPLE_BYTES);
        const { text } = parser._decodeTextWithEncoding(bytes, 'auto');
        const detected = parser._detectDelimiter(text);
        const rows = parser._parseRows(text.slice(0, 262144), detected, { maxRows: 500 })
            .filter(row => row.some(cell => cell.trim() !== ''));
        const splits = rows.some(row => row.length > 1);
        const delimiter = !splits ? '' : detected === 'whitespace' ? ' ' : detected;
        const quoting = parser._detectQuoting(text, detected);
        record.dialect = {
            delimiter,
            quotechar: quoting.quoteChar,
            escapechar: quoting.escapeChar,
        };
    } catch (err) {
        record.status = 'FAIL';
        record.status_msg = String(err?.message || err).slice(0, 120);
    }
    record.runtime = (performance.now() - started) / 1000;
    process.stdout.write(JSON.stringify(record) + '\n');
}
