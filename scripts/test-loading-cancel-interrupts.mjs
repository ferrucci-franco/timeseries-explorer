// Cancel stops the file being read, not only the files after it.
//
// The loading overlay's Cancel set a flag that the loop looked at between
// files. The file being read was never told: DuckDB went on reading a large
// CSV to the end while the overlay said "Cancelling…" — 11 s for a 134 MB CSV
// in Chromium, 12.5 s in Firefox, and half a minute was reported. The token
// now carries an AbortSignal down to DuckDB, which sends the statements that
// scan the file instead of querying them, so the interrupt lands: the same
// file then took 0.3 s (Chromium) and 1.3 s (Firefox) to cancel, and loading
// it again right after worked.
//
// DuckDB-WASM needs a browser, so the plumbing is asserted against the source
// and the token itself is run here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Flattened on the way in, so the slices below hold on a CRLF checkout.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const files = read('src/app/methods/file-methods.js');
const duck = read('src/data/duckdb-source.js');

// ── The token: setting the flag aborts the signal ───────────────────────────
const tokenSource = files.match(/export function createLoadToken\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(tokenSource, 'createLoadToken exists');
const createLoadToken = new Function(`${tokenSource.replace('export ', '')}; return createLoadToken;`)();
const token = createLoadToken();
assert.equal(token.cancelled, false);
assert.equal(token.signal.aborted, false);
let heard = false;
token.signal.addEventListener('abort', () => { heard = true; });
// Every existing canceller (button, Escape) does exactly this.
token.cancelled = true;
assert.equal(token.cancelled, true);
assert.equal(token.signal.aborted, true, 'cancelling aborts the signal');
assert.equal(heard, true, 'and whoever listens to it hears it');
token.cancelled = false;
assert.equal(token.cancelled, true, 'a cancelled load stays cancelled');

// ── The signal reaches the reader ───────────────────────────────────────────
assert.match(files, /const loadToken = createLoadToken\(\);/, 'file loads use the token');
assert.match(files, /signal: options\.loadToken\?\.signal \|\| null,/, 'loadFile hands the signal to the parser');
assert.match(files, /source\.parseCsvFile\(file, filename, \{ lazy, csvProfile, signal: options\.signal \|\| null \}\)/,
    'the CSV path passes it to DuckDB');
assert.match(files, /source\.parseParquetFile\(file, filename, \{ lazy, signal \}\)/,
    'and so does the Parquet path');
// A cancelled DuckDB read must not fall back to reading the file again.
assert.match(files, /\} catch \(err\) \{\s*\/\/ Cancelled, not failed[\s\S]{0,120}?if \(options\.signal\?\.aborted\) throw err;/,
    'a cancelled read is not retried with the legacy parser');

// ── DuckDB sends the scans, so the interrupt lands ──────────────────────────
const load = duck.slice(duck.indexOf('    async _loadIntoLegacy('));
const loadBody = load.slice(0, load.indexOf('\n    }\n'));
assert.match(loadBody, /this\._interactiveQuery\(sql, \{ signal, keepSchema: true \}\)/,
    'with a signal, statements go through the interruptible path');
for (const [label, pattern] of [
    ['the lazy view', /await query\(`CREATE OR REPLACE VIEW \$\{tableName\} AS SELECT \* FROM \$\{sourceExpr\}`\);\s*viewMode = true;\s*\} else \{/],
    ['the table that reads the whole file', /await query\(`CREATE TABLE \$\{tableName\} AS SELECT \* FROM \$\{sourceExpr\}`\)/],
    ['the row count', /const countResult = await query\(/],
    ['the data itself', /const dataResult = await query\(dataSql\)/],
    ['the time range of a lazy file', /const aggResult = await query\(/],
]) {
    assert.match(loadBody, pattern, `${label} can be interrupted`);
}
assert.match(loadBody, /if \(err\?\.name === 'AbortError'\) throw err;\s*const msg/,
    'a cancelled CREATE TABLE is not reported as a read failure');
assert.match(duck, /keepSchema && reader\.schema\s*\? new arrow\.Table\(reader\.schema, batches\)/,
    'an empty result keeps its columns');

// ── The size line ───────────────────────────────────────────────────────────
// A file opened from a handle has no size yet; it used to read "(0 B)".
assert.match(files, /if \(size === null \|\| size === undefined \|\| size === ''\) return '';/,
    'an unknown size is left out, not shown as 0 B');

console.log('Loading cancel interrupt tests passed.');
