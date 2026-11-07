// Time Series Explorer's CSV reader on every file of test-files/csv-real-world:
// what it detects (encoding, delimiter, quoting, number format, header row,
// first data row, time axis) and what a full read produces. One JSON line per
// file, scored by score.py against the hand-checked labels in labels.jsonl.
//
//   node bench/real-world/run-ours.mjs > bench/real-world/results/ours.jsonl
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import CsvParser from '../../src/parsers/csv-parser.js';

const corpus = join(dirname(fileURLToPath(import.meta.url)), '../../test-files/csv-real-world');
const entries = readFileSync(join(corpus, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

for (const entry of entries) {
    const path = join(corpus, entry.path);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const sample = buffer.slice(0, 2 * 1024 * 1024);
    const parser = new CsvParser();
    const out = { path: entry.path };
    const started = performance.now();
    try {
        const p = parser.inspectSample(sample);
        // The whitespace reader skips blank lines, so its row numbers are not
        // line numbers; the labels count lines.
        let lineOf = index => index;
        if (p.delimiter === 'whitespace') {
            const { text } = parser._decodeTextWithEncoding(sample, p.encoding || 'auto');
            const written = [];
            text.split(/\r?\n|\r/).forEach((line, i) => { if (line.trim()) written.push(i); });
            lineOf = index => (Number.isInteger(index) && index < written.length ? written[index] : index);
        }
        out.profile = {
            encoding: p.encoding,
            delimiter: p.delimiter,
            quoteChar: p.quoteChar,
            escapeChar: p.escapeChar || '',
            decimal: p.detectedNumberFormat?.decimalSeparator,
            thousands: p.detectedNumberFormat?.thousandsSeparator,
            hasHeader: p.hasHeader,
            headerIndex: lineOf(p.headerIndex),
            dataStartIndex: lineOf(p.dataStartIndex),
            unitRowIndex: p.unitRowIndex == null ? null : lineOf(p.unitRowIndex),
            columns: p.rawHeaders.length,
            headers: p.rawHeaders.slice(0, 12),
            time: { kind: p.timeSource?.kind, strategy: p.timeSource?.strategy, columns: p.timeSource?.sourceIndexes },
        };
    } catch (err) {
        out.profileError = String(err?.message || err).slice(0, 200);
        try {
            const { text, encoding } = parser._decodeTextWithEncoding(sample, 'auto');
            out.profile = { encoding, delimiter: parser._detectDelimiter(text) };
        } catch (_) { /* nothing more to say */ }
    }
    try {
        const data = await parser.parse(buffer);
        const variables = Object.values(data.variables).filter(v => v.kind !== 'abscissa');
        const numeric = variables.filter(v => v.dataType !== 'string');
        const finite = numeric.map(v => {
            let n = 0;
            for (let i = 0; i < v.data.length; i++) if (Number.isFinite(v.data[i])) n++;
            return v.data.length ? n / v.data.length : 0;
        });
        out.parse = {
            ok: true,
            rows: data.metadata.numTimesteps,
            timeKind: data.metadata.timeKind,
            variables: variables.length,
            numericVariables: numeric.length,
            // Share of numeric variables that are at least half numbers: a
            // column of NaN is a column the reader failed on.
            usefulNumeric: finite.filter(r => r >= 0.5).length,
            skippedColumnCountRows: data.metadata.skippedColumnCountRows,
        };
    } catch (err) {
        out.parse = { ok: false, error: String(err?.message || err).slice(0, 200) };
    }
    out.ms = Math.round(performance.now() - started);
    process.stdout.write(JSON.stringify(out) + '\n');
}
