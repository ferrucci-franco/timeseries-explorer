// Every CSV in test-files reads the same through the three readers the app
// has: the in-memory parser (CsvParser.parseWithProfile), DuckDB loading the
// whole file, and DuckDB lazily, every row streamed back as zoom and the Data
// tools read it.
//
//   node scripts/test-csv-duckdb-parity.mjs [file ...]
//
// In the browser DuckDB reads every UTF-8 CSV first, and the in-memory parser
// only when DuckDB fails; a large file has no fallback at all. The reading
// rules (dates, AM/PM, two-digit years, 24:00, offsets, month names, number
// formats, missing values) exist once in JS and once in SQL, and this test is
// what keeps them equal. Before it existed, a Davis station's dates read as
// year 22, an hourly meter lost its 24:00 rows, and a lazy file's thousands
// separators read NaN after the first view, all in DuckDB only.
//
// Rows are compared as sets (DuckDB orders by time, the parser keeps the
// file's order), variable by variable, after the time axis.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const CsvParser = (await import(new URL('../src/parsers/csv-parser.js', import.meta.url))).default;

const require = createRequire(import.meta.url);
// One Arrow for the whole process — see test-column-stream.mjs.
const esmArrow = await import('apache-arrow');
const arrowPath = require.resolve('apache-arrow');
require.cache[arrowPath] = { id: arrowPath, filename: arrowPath, loaded: true, exports: esmArrow };
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

// Files that are not one table, read differently by design or not yet by
// DuckDB. Each is a known limitation (bench/real-world/README.md); a file
// that starts to agree is reported, so it can leave the list.
const KNOWN = {
    'test-files/csv-real-world/industrial-energy/sel-751_relay_event-report_cev_10028.CEV':
        'sections of different widths; a checksum column the parser reads as text',
    'test-files/csv-real-world/lab-instruments/ni-labview_lvm_es_multi-segment_one-sample-each_no-x-column.lvm':
        'several segments, each with its own header',
    'test-files/csv-real-world/mech-chem-bio/anton-paar_rheocompass_tab_multi-result-blocks_ampm-time-of-day.csv':
        'several result blocks of different widths',
    'test-files/csv-real-world/mech-chem-bio/princeton_powersuite_eis_cr-cr-lf.txt':
        'CR CR LF line endings, which DuckDB counts as one line and the parser as two',
};

const EXTENSIONS = /\.(csv|txt|dat|asc|tsv|mpt|lvm|par|cev|tra|cfg)$/i;
function filesUnder(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith('_') || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) out.push(...filesUnder(full));
        else if (EXTENSIONS.test(name) && statSync(full).size < 20 * 1024 * 1024) out.push(full);
    }
    return out;
}
const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [...filesUnder('test-files/csv'), ...filesUnder('test-files/csv-real-world')].sort();

const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b
    || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function compare(label, ref, other, out) {
    const refNames = Object.keys(ref.variables).filter(k => ref.variables[k].kind !== 'abscissa');
    const otherNames = Object.keys(other.variables).filter(k => other.variables[k].kind !== 'abscissa');
    const missing = refNames.filter(k => !otherNames.includes(k));
    const extra = otherNames.filter(k => !refNames.includes(k));
    if (missing.length || extra.length) {
        out.push(`${label}: variables differ, missing ${JSON.stringify(missing.slice(0, 4))} extra ${JSON.stringify(extra.slice(0, 4))}`);
    }
    const numeric = [];
    for (const k of refNames.filter(name => otherNames.includes(name))) {
        const a = ref.variables[k];
        const b = other.variables[k];
        if ((a.dataType === 'string') !== (b.dataType === 'string')) {
            out.push(`${label}: ${k} is ${a.dataType} in one and ${b.dataType} in the other`);
            continue;
        }
        if (a.dataType !== 'string') numeric.push(k);
    }
    if (ref.metadata.timeKind !== other.metadata.timeKind) {
        out.push(`${label}: time axis ${ref.metadata.timeKind} vs ${other.metadata.timeKind}`);
    }
    const key = v => (Number.isNaN(v) ? -Infinity : v);
    const rows = (d) => {
        const t = d.variables[d.metadata.timeName]?.data || [];
        const list = [];
        for (let i = 0; i < t.length; i++) list.push([Number(t[i]), ...numeric.map(k => Number(d.variables[k].data[i]))]);
        list.sort((x, y) => {
            for (let j = 0; j < x.length; j++) {
                const diff = key(x[j]) - key(y[j]);
                if (diff) return diff < 0 ? -1 : 1;
            }
            return 0;
        });
        return list;
    };
    const ra = rows(ref);
    const rb = rows(other);
    if (ra.length !== rb.length) out.push(`${label}: ${ra.length} rows vs ${rb.length}`);
    const len = Math.min(ra.length, rb.length);
    ['time', ...numeric].forEach((name, j) => {
        let bad = 0;
        let first = null;
        for (let i = 0; i < len; i++) {
            if (!same(ra[i][j], rb[i][j])) {
                bad++;
                first ||= [ra[i][j], rb[i][j]];
            }
        }
        if (bad) out.push(`${label}: ${name} differs on ${bad}/${len} rows (${first[0]} vs ${first[1]})`);
    });
}

let handleId = 0;
let compared = 0;
let skipped = 0;
const failures = [];
const nowAgreeing = [];
for (const file of files) {
    const issues = [];
    const bytes = readFileSync(file);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const parser = new CsvParser();
    let profile;
    let js;
    try {
        profile = parser.inspectSample(buffer.slice(0, 2 * 1024 * 1024));
        // The app reads other encodings and whitespace-separated files in
        // memory only: nothing for DuckDB to agree with.
        if ((profile.encoding && profile.encoding !== 'utf-8') || profile.delimiter === 'whitespace') { skipped++; continue; }
        js = await parser.parseWithProfile(buffer, profile);
    } catch (_) {
        skipped++;
        continue;
    }
    const handle = `parity_${handleId++}.csv`;
    db.registerFileBuffer(handle, new Uint8Array(bytes));
    let whole = null;
    try {
        whole = await duck._loadIntoLegacy(handle, `omv_parity_w${handleId}`, { lazy: false, format: 'csv', csvProfile: profile });
    } catch (err) {
        issues.push(`DuckDB cannot read it: ${String(err.message).slice(0, 160)}`);
    }
    let lazy = null;
    try {
        const data = await duck._loadIntoLegacy(handle, `omv_parity_l${handleId}`, { lazy: true, overviewPoints: 50, format: 'csv', csvProfile: profile });
        const names = Object.keys(data.variables).filter(k => data.variables[k].kind !== 'abscissa');
        const numeric = names.filter(k => data.variables[k].dataType !== 'string');
        if (numeric.length) {
            const t = [];
            const cols = Object.fromEntries(numeric.map(k => [k, []]));
            for await (const chunk of streamColumns(data, numeric)) {
                t.push(...chunk.x);
                for (const k of numeric) cols[k].push(...chunk.yByVar.get(k));
            }
            lazy = {
                metadata: data.metadata,
                variables: {
                    [data.metadata.timeName]: { kind: 'abscissa', data: t },
                    ...Object.fromEntries(names.map(k => [k, { ...data.variables[k], data: cols[k] || [] }])),
                },
            };
        }
    } catch (err) {
        issues.push(`DuckDB cannot read it lazily: ${String(err.message).slice(0, 160)}`);
    }
    if (whole) compare('in memory vs DuckDB', js, whole, issues);
    if (lazy) compare('in memory vs DuckDB lazy', js, lazy, issues);
    compared++;
    if (KNOWN[file]) {
        if (!issues.length) nowAgreeing.push(file);
    } else if (issues.length) {
        failures.push({ file, issues });
    }
}

for (const file of nowAgreeing) console.log(`now reads the same, remove from KNOWN: ${file}`);
if (failures.length) {
    for (const { file, issues } of failures) {
        console.error(`\n${file}`);
        for (const issue of issues.slice(0, 6)) console.error(`  ${issue}`);
    }
}
assert.equal(failures.length, 0, `${failures.length} of ${compared} files read differently in DuckDB`);
console.log(`CSV DuckDB parity: ${compared} files read the same in memory, in DuckDB and lazily `
    + `(${Object.keys(KNOWN).length} known exceptions, ${skipped} read in memory only).`);
