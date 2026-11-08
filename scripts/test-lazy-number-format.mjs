// A lazy CSV whose numbers are written with a thousands separator or a
// decimal comma reads the same numbers on every query, not only in the
// overview.
//
//   node scripts/test-lazy-number-format.mjs
//
// The lazy file keeps the CSV's columns as text; the overview's projection
// translated "8 597" and "1,5" (csvNumericCastSql), but zoom, refresh, Data
// tools and formulas read the column again with a plain try_cast and got NaN.
// Each read path is checked here against the numbers the in-memory parser
// reads from the same text, on a real DuckDB-WASM engine.
import assert from 'node:assert/strict';
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
const parser = new CsvParser();

const ROWS = 3000;
const grouped = (n, sep) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
// Each file: how it writes a value, and the value.
const files = {
    // French: a space groups thousands, a comma is the decimal mark.
    'space-comma.csv': {
        header: 'temps;Puissance;Taux',
        row: i => `${i};${grouped(8000 + i * 3, ' ')},${i % 10};${i % 7},5`,
        expect: i => [8000 + i * 3 + (i % 10) / 10, (i % 7) + 0.5],
        format: { decimalSeparator: ',', thousandsSeparator: ' ' },
    },
    // German: a dot groups thousands.
    'dot-comma.csv': {
        header: 'Zeit;Leistung;Faktor',
        row: i => `${i};${grouped(1000 + i * 11, '.')},${String(i % 100).padStart(2, '0')};0,${(i % 9) + 1}`,
        expect: i => [1000 + i * 11 + (i % 100) / 100, ((i % 9) + 1) / 10],
        format: { decimalSeparator: ',', thousandsSeparator: '.' },
    },
    // A comma delimiter with quoted decimal commas.
    'quoted-comma.csv': {
        header: 'Zeit,Strom,Moment',
        row: i => `${i},"${String(2 + (i % 50) / 100).replace('.', ',')}","-0,${String(87 + (i % 10)).padStart(3, '0')}"`,
        expect: i => [2 + (i % 50) / 100, -(87 + (i % 10)) / 1000],
        format: { decimalSeparator: ',' },
    },
};

const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
let tableId = 0;
for (const [name, spec] of Object.entries(files)) {
    const text = [spec.header, ...Array.from({ length: ROWS }, (_, i) => spec.row(i))].join('\n') + '\n';
    db.registerFileText(name, text);
    const profile = parser.inspectSample(new TextEncoder().encode(text).buffer);
    for (const [key, value] of Object.entries(spec.format)) {
        assert.equal(profile.detectedNumberFormat[key], value, `${name}: the sample's ${key}`);
    }
    const data = await duck._loadIntoLegacy(name, `omv_numfmt_${tableId++}`, {
        lazy: true, overviewPoints: 400, format: 'csv', csvProfile: profile,
    });
    const [, a, b] = spec.header.split(/[;,]/);
    const expected = Array.from({ length: ROWS }, (_, i) => spec.expect(i));

    // The overview: always right, it goes through the projection.
    const overviewTime = data.variables[data.metadata.timeName].data;
    assert.ok(overviewTime.length > 0, `${name}: an overview`);
    overviewTime.forEach((t, k) => {
        if (!close(data.variables[a].data[k], expected[t][0])) assert.fail(`${name}: overview at ${t} reads ${data.variables[a].data[k]}`);
    });

    // Every row, as Data tools and exports stream them.
    const all = { [a]: [], [b]: [] };
    for await (const chunk of streamColumns(data, [a, b])) {
        all[a].push(...chunk.yByVar.get(a));
        all[b].push(...chunk.yByVar.get(b));
    }
    assert.equal(all[a].length, ROWS, `${name}: every row`);
    for (let i = 0; i < ROWS; i++) {
        if (!close(all[a][i], expected[i][0]) || !close(all[b][i], expected[i][1])) {
            assert.fail(`${name}: row ${i} streams ${all[a][i]}, ${all[b][i]}; the file says ${expected[i]}`);
        }
    }

    // A zoom: a range of the time axis, read again from the file.
    const zoom = await duck.getColumnsRange(data, [a, b], 1000, 1010, 4000);
    assert.ok(zoom.x.length >= 11, `${name}: the zoomed rows`);
    zoom.x.forEach((t, k) => {
        assert.ok(close(zoom.yByVar.get(a)[k], expected[t][0]), `${name}: zoom at ${t} reads ${zoom.yByVar.get(a)[k]}`);
        assert.ok(close(zoom.yByVar.get(b)[k], expected[t][1]), `${name}: zoom at ${t}, second column`);
    });

    // Data tools' own queries.
    const values = expected.map(e => e[0]);
    const low = values[100];
    const high = values[2000];
    const outside = values.filter(v => v < low || v > high).length;
    assert.equal(await duck.countOutsideRange(data, a, low, high), outside, `${name}: count outside a range`);
    assert.equal(await duck.countOutOfBounds(data, a, { lower: low, upper: high }), outside, `${name}: outliers by bounds`);
    assert.ok(close(await duck.firstFiniteValue(data, a), values[0]), `${name}: first value (first-sample detrend)`);

    // A formula over the column: the SQL a lazy formula is built from.
    const formula = duck._valueExpressionSql(data.variables[a], a, { castDouble: true });
    const [row] = duck._arrowRowsToObjects(await duck.query(`SELECT SUM(${formula} * 2) AS s FROM ${data._duckdb.tableName}`));
    assert.ok(close(Number(row.s), 2 * values.reduce((s, v) => s + v, 0)), `${name}: a formula reads numbers`);

    // An outlier variable made from it keeps reading the column the same way.
    const tool = { ...data.variables[a], _duckdbDataTool: { tool: 'removeOutliers', method: 'bounds', params: { lower: low, upper: high } } };
    const kept = duck._valueExpressionSql(tool, a, { castDouble: true });
    const [count] = duck._arrowRowsToObjects(await duck.query(`SELECT COUNT(${kept}) AS n FROM ${data._duckdb.tableName}`));
    assert.equal(Number(count.n), ROWS - outside, `${name}: removed outliers`);
}

// A file DuckDB reads as it is pays nothing: no translation in its SQL, and
// no per-cell reading either, because the scan of the file found no cell the
// cast refused with a digit in it (scannedPerCellColumns is empty).
{
    const text = 't,v\n' + Array.from({ length: 50 }, (_, i) => `${i},${i / 4}`).join('\n') + '\n';
    db.registerFileText('plain.csv', text);
    const profile = parser.inspectSample(new TextEncoder().encode(text).buffer);
    const data = await duck._loadIntoLegacy('plain.csv', `omv_numfmt_${tableId++}`, { lazy: true, overviewPoints: 400, format: 'csv', csvProfile: profile });
    assert.deepEqual(profile.scannedPerCellColumns, []);
    assert.equal(data.variables.v._duckdbNumberFormat, undefined, 'a plain file carries no number format');
    assert.equal(duck._valueExpressionSql(data.variables.v, 'v', { castDouble: true }), 'try_cast(("v") AS DOUBLE)');
    // And the format is plain data: a variable is cloned with structuredClone.
    assert.doesNotThrow(() => structuredClone(data.variables));
}

// A thousands separator that first appears after the sample: the scan finds
// the refused cells, the column is read cell by cell on every query, and the
// format rides on the variable so that a zoom reads what the overview read.
{
    const text = 't,v\n' + Array.from({ length: 400 }, (_, i) => `${i},"${i < 200 ? (i / 4).toFixed(2) : `1,${String(i).padStart(3, '0')}.5`}"`).join('\n') + '\n';
    db.registerFileText('late.csv', text);
    const profile = parser.inspectSample(new TextEncoder().encode(text).buffer);
    const data = await duck._loadIntoLegacy('late.csv', `omv_numfmt_${tableId++}`, { lazy: true, overviewPoints: 400, format: 'csv', csvProfile: profile });
    assert.deepEqual(profile.scannedPerCellColumns, [1], 'the column with "1,203.5" is read cell by cell');
    assert.equal(data.variables.v._duckdbNumberFormat?.perCell, true);
    const zoomed = [];
    for await (const chunk of streamColumns(data, ['v'], { t0: 300, t1: 310 })) zoomed.push(...chunk.yByVar.get('v'));
    assert.deepEqual(zoomed.slice(0, 3), [1300.5, 1301.5, 1302.5], 'a zoom reads the grouped numbers');
}

console.log('Lazy CSV number format tests passed.');
