// Exhaustive-search experiment (search-experiment.md): for every file, every
// candidate delimiter (the reader's five, plus 13 extra punctuation marks), its
// table score, data consistency, quoting, and how well it reads the middle and
// end of the file (validation segments). Rules are then compared offline by
// search-rules.py, without parsing again.
//
//   node bench/dialect/search-features.mjs bench/data/dialect/github A > features_A.jsonl
//   (A: MD5 starting 0-7, B: 8-f, nothing: all files)
import { readdirSync, readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import CsvParser from '../../src/parsers/csv-parser.js';
import { decodeCsvBytes, fitCsvRowToWidth, minimumRowWidth } from '../../src/parsers/csv-text-normalize.js';
const [dir, filter] = process.argv.slice(2);
const p = new CsvParser();
const EXTRA = [':', '=', '#', '^', '~', '!', '&', '%', '*', '+', '/', '-', '_'];
let files = readdirSync(dir).filter(f => /\.(csv|txt)$/i.test(f)).sort();
if (filter === 'A') files = files.filter(f => /^[0-7]/.test(f));
if (filter === 'B') files = files.filter(f => /^[89a-f]/.test(f));
const SEG = 65536;
function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = readSync(fd, b, 0, len, pos); return b.subarray(0, n); }
function validationText(path, encoding, size) {
  if (size <= 262144 + 2 * SEG) return null; // the scoring window already covers the file
  const fd = openSync(path, 'r');
  try {
    const parts = [readAt(fd, Math.floor(size / 2), SEG), readAt(fd, Math.max(0, size - SEG), SEG)];
    return parts.map(b => { const t = p._decodeTextWithEncoding(b, encoding).text; const i = t.search(/\r?\n|\r/); let s = i >= 0 ? t.slice(i + 1) : t; const j = s.search(/(\r?\n|\r)[^\r\n]*$/); return j > 0 ? s.slice(0, j) : s; }).join('\n');
  } finally { closeSync(fd); }
}
function measure(text, d, width, minWidth, quoting) {
  const rows = p._parseRows(text.slice(0, 262144), d, { maxRows: 600, ...p._quoteOptions(quoting) }).filter(r => r.some(c => c.trim() !== ''));
  if (!rows.length) return { fit: null, q: null, typed: null, n: 0 };
  let fit = 0, known = 0, cells = 0;
  for (const r of rows) { if (fitCsvRowToWidth(r, width, { minWidth })) fit++; for (const c of r) { cells++; if (p._isKnownTypeCell(c, d)) known++; } }
  return { fit: fit / rows.length, q: p._dialectConsistency(rows, d), typed: known / cells, n: rows.length };
}
for (const f of files) {
  const path = join(dir, f);
  const size = fstatSync(openSync(path, 'r')).size;
  const b = readFileSync(path).subarray(0, 2 * 1024 * 1024);
  const dec = p._decodeTextWithEncoding(b, 'auto');
  const text = dec.text; const head = text.slice(0, 262144);
  const base = p._scoreDelimiterCandidates(text);
  const cands = base.map(c => ({ d: c.delimiter, s: Number.isFinite(c.score) ? c.score : null, q: c.consistency, w: c.width }));
  for (const d of EXTRA) {
    if (!head.includes(d)) continue;
    const rows = p._parseRows(head, d, { maxRows: 700 }).filter(r => r.some(c => c.trim() !== '')).slice(0, 500);
    if (!rows.length) continue;
    const t = p._detectTableRows(rows, d);
    cands.push({ d, s: null, q: p._dialectConsistency(rows, d), w: (rows[t.headerIndex] || []).length, extra: true });
  }
  const valText = validationText(path, dec.encoding, size);
  for (const c of cands) {
    const quoting = p._detectQuoting(text, c.d);
    c.quote = quoting.quoteChar; c.esc = quoting.escapeChar;
    const rows = p._parseRows(head, c.d, { maxRows: 700, ...p._quoteOptions(quoting) }).filter(r => r.some(x => x.trim() !== '')).slice(0, 500);
    const t = p._detectTableRows(rows, c.d);
    const header = rows[t.headerIndex] || [];
    const hm = measure(text.slice(0, 262144), c.d, header.length, minimumRowWidth(header), quoting);
    c.fitHead = hm.fit; c.typedHead = hm.typed;
    if (valText) { const vm = measure(valText, c.d, header.length, minimumRowWidth(header), quoting); c.fitVal = vm.fit; c.qVal = vm.q; c.typedVal = vm.typed; }
  }
  process.stdout.write(JSON.stringify({ f, size, cands }) + '\n');
}
