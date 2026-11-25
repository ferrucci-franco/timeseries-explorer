// An OpenModelica result file (.mat, MAT v4 trajectory) opened in
// memory-saving (lazy) mode holds what the same file holds read into memory.
//
//   node scripts/test-lazy-mat.mjs
//
// The same file is read twice: whole, by MatParser (the in-memory path), and
// by parts — src/parsers/mat-v4-stream.js hands its time steps out in blocks
// and src/data/columnar-ingest.js copies them into tables of a real DuckDB-WASM
// engine (the Node build of the package the app ships), adopted as a lazy
// dataset. Checked, exactly:
//
//   · the variables: names and their order, kinds, descriptions, data types,
//     constants, interpolation, sign, and the tree built from them;
//   · the parameters (data_1), with their sign, and as a constant of the rows;
//   · every row of every variable, read back from the engine — aliases,
//     negated aliases, a second name for the time, NaN and ±∞ included;
//   · a file wide enough to be spread over several tables, read by blocks of
//     a few steps, in double and in single precision, little and big endian;
//   · the overview in memory is rows of the file: every stride-th and the last;
//   · a lazy query over series of different tables, and a time window;
//   · cancelling the copy leaves no table behind; closing the dataset drops
//     them all;
//   · what is not a trajectory written binTrans is left to the in-memory path:
//     a general MAT v4 file, a Level 5 file, a file cut short.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const MatParser = (await import(new URL('../src/parsers/mat-parser.js', import.meta.url))).default;
const { openMatV4Trajectory, scanMatV4 } = await import(new URL('../src/parsers/mat-v4-stream.js', import.meta.url));
const { ingestColumnarReader, ingestOverviewPoints, INGEST_GROUP_COLUMNS } = await import(new URL('../src/data/columnar-ingest.js', import.meta.url));
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));

const { trajectory } = await import(new URL('./support/mat-v4-fixture.mjs', import.meta.url));

// 620 series: three tables at 250 columns each. Row 0 is the time.
const SERIES = 620;
const STEPS = 2311;
const value = (row, step) => {
    if (row === 0) return step < 1200 ? step * 0.01 : (step - 1) * 0.01;   // an event: one instant twice
    if (row === 1) return step % 2;                                         // boolean
    if (row === 2) return 3.5;                                              // constant
    if (row === 3) return step % 97 === 5 ? NaN : (step % 211 === 7 ? Infinity : Math.sin(step / 40));
    if (row === 4) return step % 3 === 0 ? 0 : -1;                          // its negation is boolean
    return Math.fround(Math.sin(step / (10 + row)) * row + (step % 13) / 8);
};
const names = ['time'];
const descriptions = ['Simulation time [s]'];
const info = [[0, 1, 0, -1]];
for (let row = 1; row < SERIES; row++) {
    names.push(row % 50 === 0 ? `der(body${row % 7}.x[${row}])` : `body${row % 7}.part${row % 3}.s${row}`);
    descriptions.push(row % 4 === 0 ? `Signal ${row} [m/s|km/h]` : '');
    info.push([2, row + 1, row % 5 === 0 ? 0 : 1, -1]);
}
// Aliases: the same series under another name, some with the sign changed.
for (const [alias, row, negate] of [['alias.plain', 7, false], ['alias.negated', 7, true], ['alias.far', 601, true],
    ['alias.flag', 4, true], ['alias.const', 2, true], ['alias.time', 0, false], ['alias.hole', 3, true]]) {
    names.push(alias);
    descriptions.push(`alias of ${row}`);
    info.push([2, (row + 1) * (negate ? -1 : 1), 1, -1]);
}
// Parameters, one negated; and a name given twice (the later one stays).
const params = [9.81, 2, 0, 1e-9, 42];
['g', 'body0.n', 'zero', 'body1.eps', 'answer'].forEach((name, i) => {
    names.push(name);
    descriptions.push(i === 0 ? 'gravity [m/s2]' : '');
    info.push([1, (i + 1) * (i === 4 ? -1 : 1), 0, 0]);
});
names.push('body1.part1.s1');
descriptions.push('twice');
info.push([2, 12, 1, -1]);
// Entries that read nothing: past the last series, and a matrix that is not there.
names.push('ghost.row', 'ghost.matrix');
descriptions.push('', '');
info.push([2, SERIES + 5, 1, -1], [3, 1, 1, -1]);

const spec = { names, descriptions, info, params, series: SERIES, steps: STEPS, value };

// ── The engine ────────────────────────────────────────────────�
const require = createRequire(import.meta.url);
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
const source = new DuckDbSource();
source._db = db;
source._conn = db.connect();

const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
function sameArray(got, want, label) {
    assert.equal(got.length, want.length, `${label}: as many values (${got.length} vs ${want.length})`);
    for (let i = 0; i < want.length; i++) {
        if (!same(got[i], want[i])) assert.fail(`${label}: value ${i} is ${got[i]}, not ${want[i]}`);
    }
}
async function everyRow(lazy, varNames) {
    const chunks = [];
    for await (const chunk of streamColumns(lazy, varNames, { chunkRows: 700 })) chunks.push(chunk);
    const join = pick => chunks.flatMap(chunk => Array.from(pick(chunk)));
    return { x: join(c => c.x), y: new Map(varNames.map(name => [name, join(c => c.yByVar.get(name))])) };
}
const treeShape = (node) => ({
    variables: Object.keys(node._variables || {}),
    children: Object.fromEntries(Object.entries(node._children || {}).map(([name, child]) => [name, treeShape(child)])),
});

async function compare(buffer, label, { blockBytes, groupColumns, overviewPoints = 500 } = {}) {
    const bytes = new Uint8Array(buffer);
    const eager = await new MatParser().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const reader = await openMatV4Trajectory(new Blob([bytes]));
    assert.ok(reader, `${label}: read by parts`);
    const blocks = reader.blocks.bind(reader);
    let blockCount = 0;
    if (blockBytes) reader.blocks = (options = {}) => blocks({ ...options, blockBytes });
    const progress = [];
    const counted = reader.blocks.bind(reader);
    reader.blocks = async function* (options) { for await (const block of counted(options)) { blockCount += 1; yield block; } };
    const lazy = await ingestColumnarReader(source, reader, { overviewPoints, groupColumns, onProgress: (done, total) => progress.push([done, total]) });

    // The variables.
    assert.deepEqual(Object.keys(lazy.variables), Object.keys(eager.variables), `${label}: the same variables, in the same order`);
    for (const [name, want] of Object.entries(eager.variables)) {
        const got = lazy.variables[name];
        for (const key of ['name', 'description', 'kind', 'dataType', 'isConstant', 'interpolation', 'negate']) {
            assert.equal(got[key], want[key], `${label}: ${name}.${key}`);
        }
        if (want.kind === 'parameter') sameArray(got.data, want.data, `${label}: parameter ${name}`);
    }
    assert.deepEqual(treeShape(lazy.tree), treeShape(eager.tree), `${label}: the same tree`);
    for (const key of ['numVariables', 'numParams', 'numTimevarying', 'numTimesteps', 'timeStart', 'timeEnd', 'binTrans', 'timeName']) {
        assert.equal(lazy.metadata[key], eager.metadata[key], `${label}: metadata.${key}`);
    }
    assert.ok(lazy._duckdb, `${label}: in memory-saving mode`);
    assert.equal(lazy._duckdb.totalRows, eager.metadata.numTimesteps);

    // Every row of every series, from the engine.
    const timeName = eager.metadata.timeName;
    const seriesNames = Object.keys(eager.variables).filter(name => eager.variables[name].kind !== 'parameter' && name !== timeName);
    for (const name of seriesNames) assert.equal(source.hasSqlValue(lazy.variables[name]), true, `${label}: ${name} is read from the engine`);
    for (let i = 0; i < seriesNames.length; i += 97) {
        const batch = seriesNames.slice(i, i + 97);
        const rows = await everyRow(lazy, batch);
        sameArray(rows.x, eager.variables[timeName].data, `${label}: the time`);
        for (const name of batch) sameArray(rows.y.get(name), eager.variables[name].data, `${label}: ${name}`);
    }

    // The overview: every stride-th row, and the last.
    const total = eager.metadata.numTimesteps;
    const points = ingestOverviewPoints(reader.columns, overviewPoints);
    const stride = Math.max(1, Math.ceil(total / points));
    const picked = [];
    for (let row = 0; row < total; row++) if (row % stride === 0 || row === total - 1) picked.push(row);
    for (const name of [timeName, ...seriesNames]) {
        sameArray(lazy.variables[name].data, picked.map(row => eager.variables[name].data[row]), `${label}: overview of ${name}`);
    }
    assert.deepEqual(progress.at(-1), [total, total], `${label}: progress reaches the last row`);
    return { eager, lazy, reader, blockCount };
}

// ── The wide file, by small blocks ────────────────────────────�
const wide = await compare(trajectory(spec), 'wide', { blockBytes: 64 * 1024 });
assert.ok(wide.blockCount > 100, `the file went by in many blocks (${wide.blockCount})`);
assert.equal(wide.lazy.metadata.ingest.tables, Math.ceil(SERIES / INGEST_GROUP_COLUMNS), 'spread over three tables');
assert.equal(wide.lazy.variables['alias.flag'].dataType, 'boolean', 'a negated 0/-1 series is boolean, as in memory');
assert.equal(wide.lazy.variables['body1.part1.s1'].description, 'twice', 'of two entries with one name the later stays');
assert.equal(wide.lazy.variables['ghost.row'], undefined);
assert.equal(wide.lazy.variables['ghost.matrix'], undefined);
assert.ok(wide.lazy.variables['body0.part1.s7']._duckdbCol, 'a series of the first table is a plain column');
assert.ok(wide.lazy.variables['alias.far']._duckdbWindows?.[0]?.sink, 'a series of another table is joined to it');

// A lazy query across tables, in a window: what the in-memory arrays hold there.
{
    const { eager, lazy } = wide;
    const picks = ['body0.part1.s7', 'alias.negated', 'alias.far', 'body0.part1.s301', 'der(body6.x[300])', 'alias.hole'];
    const result = await source.getRawColumnsRange(lazy, picks, 3, 9, 100000);
    const time = eager.variables.time.data;
    const inside = [];
    time.forEach((t, row) => { if (t >= 3 && t <= 9) inside.push(row); });
    sameArray(Array.from(result.x), inside.map(row => time[row]), 'window: the time');
    for (const name of picks) {
        sameArray(Array.from(result.yByVar.get(name)), inside.map(row => eager.variables[name].data[row]), `window: ${name}`);
    }
    // A parameter, read by an analysis: its value at every row, as in memory.
    const constants = await source.getRawColumnsRange(lazy, ['g', 'answer'], 3, 9, 100000);
    assert.equal(constants.x.length, inside.length);
    assert.ok(Array.from(constants.yByVar.get('g')).every(v => v === 9.81), 'a parameter is its value at every row');
    assert.ok(Array.from(constants.yByVar.get('answer')).every(v => v === -42), 'with its sign');
    const buckets = await source.getColumnsRange(lazy, picks, 0, 23, 300);
    assert.ok(buckets.x.length > 100 && buckets.x.length <= 700, `a zoomed-out read is bucketed (${buckets.x.length} points)`);
    // Closing the dataset drops its tables.
    const tables = [...lazy._duckdb.sinks.keys()];
    assert.equal(tables.length, 3);
    await source.release(lazy);
    for (const table of tables) assert.equal(source.hasSink(table), false, `${table} is dropped`);
}

// ── Single precision, big endian, one table, one block ────────────────────
{
    const narrow = { ...spec, series: 12, steps: 501 };
    const keep = info.map((entry, index) => [entry, index]).filter(([entry]) => entry[0] !== 2 || Math.abs(entry[1]) <= 12 || Math.abs(entry[1]) > SERIES);
    narrow.names = keep.map(([, index]) => names[index]);
    narrow.descriptions = keep.map(([, index]) => descriptions[index]);
    narrow.info = keep.map(([entry]) => entry);
    for (const [P, littleEndian] of [[1, true], [0, false], [1, false]]) {
        const { lazy, blockCount } = await compare(trajectory({ ...narrow, P, littleEndian }), `P=${P} ${littleEndian ? 'LE' : 'BE'}`);
        assert.equal(blockCount, 1);
        assert.equal(lazy.metadata.ingest.tables, 1);
        await source.release(lazy);
    }
    // Fewer rows than overview points: the overview is the file.
    const { lazy } = await compare(trajectory({ ...narrow, steps: 40 }), 'short');
    assert.equal(lazy.variables.time.data.length, 40);
    await source.release(lazy);
}

// ── A result OpenModelica wrote ───────────────────────────────�
{
    const file = readFileSync(new URL('../test-files/matlab/clocked-openmodelica.mat', import.meta.url));
    const { lazy } = await compare(file, 'clocked-openmodelica.mat', { blockBytes: 4096, groupColumns: 3 });
    assert.ok(lazy.metadata.ingest.tables > 1, 'spread over tables of three columns');
    await source.release(lazy);
}

// ── Cancel ───────────────────────────────────────────────────�
{
    const reader = await openMatV4Trajectory(new Blob([trajectory(spec)]));
    const controller = new AbortController();
    const blocks = reader.blocks.bind(reader);
    reader.blocks = (options = {}) => blocks({ ...options, blockBytes: 64 * 1024 });
    const before = source._liveSinks.size;
    await assert.rejects(
        ingestColumnarReader(source, reader, { signal: controller.signal, onProgress: (done) => { if (done > 500) controller.abort(); } }),
        error => error.name === 'AbortError',
        'a cancelled copy rejects with an AbortError',
    );
    assert.equal(source._liveSinks.size, before, 'and leaves no table behind');
    const left = await source._conn.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE 'omv_ingest_%'");
    assert.equal(Number(left.toArray()[0].n), 0, 'none in the engine either');
}

// ── What is left to the in-memory path ────────────────────────────────────
{
    const general = readFileSync(new URL('../test-files/matlab/general-v4.mat', import.meta.url));
    assert.equal(await openMatV4Trajectory(new Blob([general])), null, 'a general MAT v4 file is not a trajectory');
    const v5 = readFileSync(new URL('../test-files/matlab/general-v5.mat', import.meta.url));
    assert.equal(await scanMatV4(new Blob([v5])), null, 'a Level 5 file is not MAT v4');
    assert.equal(await openMatV4Trajectory(new Blob([v5])), null);
    const whole = trajectory({ ...spec, series: 12, steps: 50, names: ['time'], descriptions: [''], info: [[0, 1, 0, -1]] });
    await assert.rejects(openMatV4Trajectory(new Blob([whole.subarray(0, whole.length - 100)])), error => error.code === 'MAT_TRUNCATED',
        'a file cut short says so');
    // binNormal: not this reader's.
    const normal = Buffer.from(whole);
    const at = normal.indexOf('binTrans');
    normal.write('binNorml', at, 'latin1');
    assert.equal(await openMatV4Trajectory(new Blob([normal])), null, 'a file not written binTrans is left alone');
}

console.log('Lazy MAT: a trajectory read by parts into the engine is the file read into memory.');
process.exit(0);
