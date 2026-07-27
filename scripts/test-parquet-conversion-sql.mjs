// The SQL that writes a Parquet file in the browser.
//
//   node scripts/test-parquet-conversion-sql.mjs
//
// This exists because the browser converter shipped writing `COPY (SELECT *
// FROM read_csv(...))`, and that is wrong in two ways at once. The CSV reader
// is deliberately told to read EVERY column as VARCHAR — the profile carries
// the real type separately, because "1,5" only becomes a number after the
// decimal mark is fixed — so `SELECT *` wrote a Parquet whose every series was
// typed String and could not be plotted. And the parsing preview expresses a
// column selection as `ignoredColumns`, which only the projection applies, so
// picking two columns still produced a file with all of them.
//
// The tests that existed read source text, so they could not see any of this.
// These build the real SQL from the real class.

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;

let checks = 0;
const check = async (name, fn) => {
    await fn();
    checks++;
};

// ─── Doubles ──────────────────────────────────────────────────────────────

// A DESCRIBE result, in the shape _arrowRowsToObjects reads.
function describeTable(columns) {
    const cells = { column_name: columns.map(c => c[0]), column_type: columns.map(c => c[1]) };
    return {
        numRows: columns.length,
        schema: { fields: [{ name: 'column_name' }, { name: 'column_type' }] },
        getChild: (name) => (cells[name] ? { get: (i) => cells[name][i] } : null),
    };
}

// The class never gets constructed: the constructor is for a browser, and
// nothing here needs a database. Only the calls the conversion makes are
// stubbed, so every line of SQL under test is the real one.
function makeSource({ describeColumns }) {
    const source = Object.create(DuckDbSource.prototype);
    const statements = [];
    source._nextTableId = 0;
    source.init = async () => {};
    source._conn = { cancelSent: () => {} };
    source._db = {
        registerFileBuffer: () => {},
        copyFileToBuffer: async () => new Uint8Array([80, 65, 82, 49]),
        dropFile: async () => {},
    };
    source.query = async (sql) => {
        statements.push(sql);
        return /^\s*DESCRIBE/i.test(sql) ? describeTable(describeColumns) : null;
    };
    source.statements = statements;
    source.copySql = () => statements.find(sql => /^\s*COPY/i.test(sql)) || '';
    return source;
}

const VARCHAR_COLUMNS = [['time', 'VARCHAR'], ['v1', 'VARCHAR'], ['v2', 'VARCHAR'], ['label', 'VARCHAR']];

// What the parsing preview hands over for a four-column CSV whose first column
// is the time, third is unticked, and fourth is text.
function profile(overrides = {}) {
    return {
        delimiter: ',',
        decimalSeparator: '.',
        hasHeader: true,
        headerIndex: 0,
        dataStartIndex: 1,
        rawHeaders: ['time', 'v1', 'v2', 'label'],
        headers: [{ name: 'time' }, { name: 'v1' }, { name: 'v2' }, { name: 'label' }],
        sampleRows: ['0,1.5,2.5,ok', '1,1.6,2.6,ok'],
        numericColumnIndexes: [0, 1, 2],
        timeSource: { ok: true, kind: 'numeric', strategy: 'index-column', sourceIndexes: [0], name: 'time' },
        ignoredColumns: [],
        profileSource: 'user',
        ...overrides,
    };
}

const convert = async (source, csvProfile) =>
    source.convertCsvBufferToParquet(new Uint8Array([1, 2, 3]), { csvProfile });

// ─── Bug 1: every series came out typed String ────────────────────────────

await check('numeric columns are cast, not copied as text', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile());
    const sql = source.copySql();

    assert.ok(sql, 'a COPY statement was issued');
    // The exact shape that was missing. Without it DuckDB writes the VARCHAR it
    // read, and the app opens a file where nothing is plottable.
    assert.match(sql, /try_cast\("v1" AS DOUBLE\) AS "v1"/, 'v1 is cast to DOUBLE');
    assert.match(sql, /try_cast\("v2" AS DOUBLE\) AS "v2"/, 'v2 is cast to DOUBLE');
    // The regression itself: a bare SELECT * as the whole COPY body.
    assert.ok(!/^\s*COPY\s*\(\s*SELECT\s+\*\s+FROM\s+read_csv/i.test(sql),
        'the COPY body is a projection, not a bare SELECT * over the reader');
});

await check('a time column is built and empty times are dropped', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile());
    const sql = source.copySql();

    assert.match(sql, /AS "__omv_time"/, 'the projection names a time column');
    assert.match(sql, /WHERE "__omv_time" IS NOT NULL/, 'rows without a time are not written');
});

await check('the time column keeps the name the CSV gave it', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile());
    const sql = source.copySql();
    // __omv_time is the internal name the projection works with. It was
    // reaching the file, so a CSV column called "time" became "__omv_time".
    assert.match(sql, /SELECT "__omv_time" AS "time", \* EXCLUDE \("__omv_time"\)/,
        'the internal name is renamed on the way out');
});

await check('a time built from several columns is named too', async () => {
    const source = makeSource({
        describeColumns: [['date', 'VARCHAR'], ['hour', 'VARCHAR'], ['v1', 'VARCHAR']],
    });
    await convert(source, profile({
        rawHeaders: ['date', 'hour', 'v1'],
        headers: [{ name: 'date' }, { name: 'hour' }, { name: 'v1' }],
        numericColumnIndexes: [2],
        timeSource: {
            ok: true, kind: 'datetime', mode: 'split', strategy: 'slash-date',
            sourceIndexes: [0, 1], name: 'date hour', format: { dateOrder: 'DMY' },
        },
    }));
    assert.match(source.copySql(), /AS "date hour"/, 'the name the app shows is the name written');
});

await check('a name already taken falls back to the internal one', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    // The time is built from column 0, but the profile calls it "v1" — which
    // is also a column that survives. Two columns of one name would be a file
    // nobody can query unambiguously.
    await convert(source, profile({
        timeSource: { ok: true, kind: 'numeric', strategy: 'index-column', sourceIndexes: [0], name: 'v1' },
    }));
    assert.match(source.copySql(), /"__omv_time" AS "__omv_time"/, 'the unambiguous name wins over the pretty one');
});

await check('a text column stays text', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile());
    // Casting a label column to DOUBLE would turn every value into NULL.
    assert.ok(!/try_cast\("label" AS DOUBLE\)/.test(source.copySql()), 'label is not cast to a number');
});

await check('a datetime time source becomes epoch milliseconds', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile({
        timeSource: {
            ok: true, kind: 'datetime', strategy: 'iso-datetime', sourceIndexes: [0], name: 'time',
        },
    }));
    assert.match(source.copySql(), /epoch_ms\(/, 'the datetime is converted to a number the app can plot');
});

await check('a decimal comma is repaired before the cast', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile({ decimalSeparator: ',', delimiter: ';' }));
    const sql = source.copySql();
    assert.match(sql, /replace\(CAST\("v1" AS VARCHAR\), ',', '\.'\)/, 'the decimal mark is fixed');
    assert.match(sql, /decimal_separator=','/, 'and the reader is told about it too');
});

// ─── Bug 2: the column selection was ignored ──────────────────────────────

await check('unticked columns are left out of the file', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile({ ignoredColumns: [2, 3] }));
    const sql = source.copySql();

    assert.match(sql, /"v1"/, 'a column that was kept is written');
    assert.ok(!/AS "v2"/.test(sql), 'a column that was unticked is not projected');
    assert.ok(!/"label"/.test(sql), 'nor is the other one');
});

await check('the time column survives even when everything else is dropped', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile({ ignoredColumns: [1, 2, 3] }));
    assert.match(source.copySql(), /AS "__omv_time"/, 'a file with no time column would be useless');
});

// ─── The rest of the profile has to reach the file too ────────────────────

await check('the reader skips the header rows the profile found', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile({ dataStartIndex: 4 }));
    // skip=0 was hard-coded here, which fed the header line in as data.
    assert.match(source.copySql(), /skip=4/, 'the preamble is skipped');
});

await check('a row filter is applied while reading', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile({
        rowFilter: { enabled: true, columnIndex: 3, operator: '=', value: 'ok' },
    }));
    assert.match(source.copySql(), /trim\(CAST\("label" AS VARCHAR\)\) = 'ok'/, 'the filter reaches the SQL');
});

await check('with no profile, DuckDB detects the types itself', async () => {
    const source = makeSource({
        describeColumns: [['time', 'DOUBLE'], ['v1', 'DOUBLE'], ['v2', 'VARCHAR']],
    });
    await convert(source, null);
    const sql = source.copySql();
    assert.match(sql, /read_csv_auto/, 'the auto reader is used');
    assert.match(sql, /AS "__omv_time"/, 'and a time column is still built');
    // Already DOUBLE from the reader: casting again would be noise.
    assert.ok(!/try_cast\("v1" AS DOUBLE\)/.test(sql), 'a column already typed is not re-cast');
});

// ─── Deliberate difference from the desktop converter ─────────────────────

await check('the rows are not sorted', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    await convert(source, profile());
    // The desktop converter sorts by time. In the browser that is a blocking
    // in-memory sort inside a 4 GB heap, on exactly the files that are too big
    // for it. The app sorts by time when it reads, so the file need not arrive
    // sorted — and an out-of-memory crash here would cost the user the whole
    // conversion.
    assert.ok(!/ORDER BY/i.test(source.copySql()), 'no global sort inside the WASM heap');
});

// ─── The caller keeps its bytes ───────────────────────────────────────────

await check('converting does not detach the buffer it was given', async () => {
    // DuckDB's registerFileBuffer transfers, and a spreadsheet's CSV text is
    // cached on the entry so the sheet can be re-opened or converted again.
    // Handing that cache straight to the worker left it detached.
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    let registered = null;
    source._db.registerFileBuffer = (_name, payload) => { registered = payload; };

    const bytes = new TextEncoder().encode('time,v1\n0,1\n');
    const before = bytes.byteLength;
    await source.convertCsvBufferToParquet(bytes, { csvProfile: profile() });

    assert.equal(bytes.byteLength, before, 'the caller can still read its own bytes');
    assert.notEqual(registered.buffer, bytes.buffer, 'what was handed over is a copy');
});

// ─── Cancelling still cancels ─────────────────────────────────────────────

await check('an already-aborted signal produces no file', async () => {
    const source = makeSource({ describeColumns: VARCHAR_COLUMNS });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => source.convertCsvBufferToParquet(new Uint8Array([1]), {
            csvProfile: profile(), signal: controller.signal,
        }),
        (err) => err?.cancelled === true,
    );
});

console.log(`parquet conversion SQL: ${checks} checks passed`);
