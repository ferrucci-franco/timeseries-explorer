// The SQL time axis (src/data/csv-sql-datetime.js) gives, cell by cell, the
// instant the in-memory reader gives (parseCsvTimeValue), on DuckDB-WASM:
// two-digit years, "3:00 a" and "1:45 PM", 24:00, UTC offsets, commas before
// the fraction, month names in seven languages, and cells that are no date.
//
//   node scripts/test-csv-sql-datetime.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { csvDatetimeSql } from '../src/data/csv-sql-datetime.js';
import { parseCsvTimeValue } from '../src/parsers/csv-time-detection.js';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
const connection = db.connect();
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const sqlValue = (expr, cells) => {
    const columns = cells.map((cell, i) => `${literal(cell)} AS c${i}`).join(', ');
    const v = connection.query(`SELECT ${expr} AS v FROM (SELECT ${columns})`).getChildAt(0).get(0);
    return v == null ? NaN : Number(v);
};
const show = v => (Number.isNaN(v) ? 'NaN' : new Date(v).toISOString());

const cases = [
  [{ strategy: 'iso-datetime', kind: 'datetime' }, ['2020-08-02T00:00:00+02:00', '2024-01-05 07:05:22,123', '2024-1-5 7:05', '2024-01-05T10:00:00Z', '2024-01-05 10:00:00.5-0330', '2021-02-30 00:00', '% RSD', '', '2024-01-05', '2024-01-05 24:00']],
  [{ strategy: 'slash-date', kind: 'datetime', format: { dateOrder: 'DMY' } }, ['06/09/22 3:00 a', '31/01/2024 13:45:22.25', '31/01/24 1:45 PM', '1/2/85', '30/02/2024', '12/01/2024 12:00 AM', '12/01/2024 13:00 PM', '01/01/2024 24:00', 'x']],
  [{ strategy: 'slash-date', kind: 'datetime', format: { dateOrder: 'MDY' } }, ['01/31/2024 01:45 PM', '02/01/2024 12:00 AM', '10/13/23 01:45:00 PM', '2024/01/31 10:00']],
  [{ strategy: 'dot-date', kind: 'datetime', format: { dateOrder: 'DMY' } }, ['05.11.2023 08:30', '05.11.23', '2023.11.05 08:30:00,5']],
  [{ strategy: 'month-name-date', kind: 'datetime' }, ['09-Janvier-2024 07:05:08', '10-Fev-2024 07:05:08', '11-Março-2024 07:05:08', 'Mon, 15 Jan 2024 10:00:00 +0100', '15 de enero de 2024', 'Jan 15 10:00:00 2024', 'jan 15 2024', 'lundi 1 janvier 2024 13:05', '15-Jan-24', '3 settembre 2024', '1 Dezember 2023 08:00']],
  [{ strategy: 'yearless-date-time', kind: 'datetime', format: { dateOrder: 'MDY' } }, ['01/31 13:45', '1/31 1:45 PM', '02/30 10:00']],
  [{ strategy: 'partial-year-month', kind: 'datetime' }, ['2024-01', '2024/13']],
];

let checked = 0;
for (const [strategy, cells] of cases) {
    const source = { ok: true, sourceIndexes: [0], ...strategy };
    const expr = csvDatetimeSql(source, ['c0']);
    assert.ok(expr, `${strategy.strategy} has a SQL form`);
    for (const cell of cells) {
        const js = parseCsvTimeValue(source, [cell], 0, ',');
        const sql = sqlValue(expr, [cell]);
        assert.ok(Object.is(js, sql) || js === sql, `${strategy.strategy} ${JSON.stringify(cell)}: JS ${show(js)}, SQL ${show(sql)}`);
        checked++;
    }
}

// A date column and a time-of-day column.
for (const [date, time] of [['06/09/22', '3:00 a'], ['2023/04/20', '24:00'], ['2023/04/20', '01:00'], ['20/04/2023', '13:05:22,5'],
    ['20/04/2023', ''], ['20/04/2023', 'xx'], ['04/2023', '10:00'], ['2024-01', '10:00'], ['15 janvier 2024', '10:00'],
    ['01/31/2024', '01:45 PM']]) {
    const order = /^\d{4}/.test(date) ? 'YMD' : date === '01/31/2024' ? 'MDY' : 'DMY';
    const source = { ok: true, mode: 'split', kind: 'datetime', sourceIndexes: [0, 1], format: { dateOrder: order } };
    const js = parseCsvTimeValue(source, [date, time], 0, ',');
    const sql = sqlValue(csvDatetimeSql(source, ['c0', 'c1']), [date, time]);
    assert.ok(Object.is(js, sql) || js === sql, `split ${JSON.stringify([date, time])}: JS ${show(js)}, SQL ${show(sql)}`);
    checked++;
}

// The cases that read differently before.
const at = (expr, cell) => show(sqlValue(expr, [cell]));
const dmy = csvDatetimeSql({ strategy: 'slash-date', kind: 'datetime', format: { dateOrder: 'DMY' } }, ['c0']);
assert.equal(at(dmy, '06/09/22 3:00 a'), '2022-09-06T03:00:00.000Z', 'a two-digit year is this century, not year 22');
const iso = csvDatetimeSql({ strategy: 'iso-datetime', kind: 'datetime' }, ['c0']);
assert.equal(at(iso, '2020-08-02T00:00:00+02:00'), '2020-08-01T22:00:00.000Z', 'an offset is applied');
assert.equal(at(iso, '2023-11-15T15:38:31.999973780+00:00'), '2023-11-15T15:38:32.000Z', 'a fraction that rounds up carries');
assert.equal(at(iso, '% RSD'), 'NaN', 'a cell that is no date is no instant, not an error');
const month = csvDatetimeSql({ strategy: 'month-name-date', kind: 'datetime' }, ['c0']);
assert.equal(at(month, '05-Jan-2013 14:32:13.526'), '2013-01-05T14:32:13.526Z', 'the fraction keeps its dot');
assert.equal(at(month, '10-Fev-2024 07:05:08'), '2024-02-10T07:05:08.000Z', 'Portuguese abbreviations');
console.log(`CSV SQL datetime tests passed (${checked} cells equal to the JS reader).`);
