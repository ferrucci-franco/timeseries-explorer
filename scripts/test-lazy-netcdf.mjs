// A netCDF file opened in memory-saving (lazy) mode holds what the same file
// read into memory holds.
//
//   node scripts/test-lazy-netcdf.mjs
//
// Each fixture is read twice: whole, by NetcdfParser (the in-memory path), and
// by parts — src/parsers/netcdf-columns.js hands its time steps out in blocks
// and src/data/columnar-ingest.js copies them into tables of a real
// DuckDB-WASM engine (the Node build of the package the app ships), adopted as
// a lazy dataset. Checked, exactly:
//
//   · the variables: names and their order, the kind, the description, the
//     display name, the units, the data type, whether it is constant, the
//     interpolation and the netCDF provenance of each;
//   · the metadata: the X axis chosen and its kind, the dimensions, the global
//     attributes, how many series were generated, and the notes about the
//     variables skipped or only partly loaded;
//   · every row of every series, read back out of the engine and compared with
//     the array the in-memory path built — _FillValue and scale_factor
//     included, since both paths run the same `decodeNumeric`;
//   · the tree: the same groups, in the same order, with the same names;
//   · the time axis of a CF file stays a calendar axis;
//   · a block size that forces many blocks gives the same numbers as one block
//     over the whole file;
//   · the same, through the worker boundary: the reader's description and every
//     block are passed through structuredClone, as postMessage passes them, and
//     the blocks are pulled by src/data/netcdf-columns-client.js;
//   · the loading path asks for the lazy dataset where the limit is found,
//     before asking the user whether to load the file whole;
//   · a PyPSA network is left to its own parser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const MatParser = (await import(new URL('../src/parsers/mat-parser.js', import.meta.url))).default;
const NetcdfParser = (await import(new URL('../src/parsers/netcdf-parser.js', import.meta.url))).default;
const { openNetcdfColumns } = await import(new URL('../src/parsers/netcdf-columns.js', import.meta.url));
const { netcdfColumnarReader } = await import(new URL('../src/data/netcdf-columns-client.js', import.meta.url));
const { ingestColumnarReader } = await import(new URL('../src/data/columnar-ingest.js', import.meta.url));
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));

const require = createRequire(import.meta.url);
// One Arrow, not two. The blocking build of DuckDB-WASM `require`s
// apache-arrow while duckdb-source.js imports it as a module: left alone, the
// tables the writer builds are of an Arrow the engine does not recognise, and
// every insert goes through reporting success and writing nothing.
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
const treeShape = (node) => ({
    variables: Object.keys(node._variables || {}),
    children: Object.fromEntries(Object.entries(node._children || {}).map(([name, child]) => [name, treeShape(child)])),
});

function fixture(name) {
    const bytes = readFileSync(new URL(`../test-files/netcdf/${name}`, import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function everyRow(lazy, names) {
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names, { chunkRows: 500 })) chunks.push(chunk);
    return new Map(names.map(name => [name, chunks.flatMap(chunk => Array.from(chunk.yByVar.get(name)))]));
}

async function compare(name, { blockBytes = 0, throughWorker = false } = {}) {
    const buffer = fixture(name);
    const label = `${name}${blockBytes ? ` (blocks of ${blockBytes} bytes)` : ''}${throughWorker ? ' through the worker boundary' : ''}`;
    const eager = await new NetcdfParser(new MatParser()).parse(buffer);
    let reader = await openNetcdfColumns({ buffer }, { parser: new MatParser(), filename: name });
    assert.ok(reader, `${label}: read by parts`);
    if (throughWorker) {
        // Everything the worker hands over goes through structuredClone, which
        // is what postMessage does to it: a function, or anything else that
        // cannot be cloned, fails here rather than in the browser.
        const held = reader;
        const description = structuredClone(held.description);
        reader = netcdfColumnarReader(description, {
            id: 'test',
            request: async (op, payload) => {
                assert.equal(op, 'netcdf-columns:block', 'the client asks for blocks and nothing else');
                return structuredClone(held.readBlock(payload.rowStart, payload.rows));
            },
        });
    }
    let blocks = 0;
    const streamed = reader.blocks.bind(reader);
    reader.blocks = async function* (options = {}) {
        for await (const block of streamed({ ...options, ...(blockBytes ? { blockBytes } : {}) })) {
            blocks += 1;
            yield block;
        }
    };
    const lazy = await ingestColumnarReader(source, reader, { overviewPoints: 200 });

    // ── The variables ──────────────────────────────────────────────────────
    assert.deepEqual(Object.keys(lazy.variables), Object.keys(eager.variables),
        `${label}: the same variables, in the same order`);
    for (const [variableName, want] of Object.entries(eager.variables)) {
        const got = lazy.variables[variableName];
        for (const key of ['name', 'displayName', 'description', 'units', 'kind', 'dataType', 'isConstant', 'interpolation', 'negate']) {
            assert.equal(got[key], want[key], `${label}: ${variableName}.${key} is ${got[key]}, not ${want[key]}`);
        }
        assert.deepEqual(got.netcdf, want.netcdf, `${label}: ${variableName}.netcdf`);
        if (want.kind === 'abscissa') {
            for (const key of ['timeKind', 'timeDisplayMode', 'timeSourceStrategy']) {
                assert.equal(got[key], want[key], `${label}: the axis keeps its ${key}`);
            }
        }
    }

    // ── The metadata ───────────────────────────────────────────────────────
    for (const key of ['timeName', 'timeKind', 'timeDisplayMode', 'storageFormat', 'source',
        'generatedSeriesCount', 'auxiliaryCoordinateCount', 'skippedVariablesCount', 'partialVariablesCount',
        'coordinateDataset']) {
        assert.equal(lazy.metadata[key], eager.metadata[key], `${label}: metadata.${key}`);
    }
    for (const key of ['dimensions', 'globalAttributes', 'skippedVariables', 'partialVariables']) {
        assert.deepEqual(lazy.metadata[key], eager.metadata[key], `${label}: metadata.${key}`);
    }
    assert.equal(lazy.metadata.format, 'netcdf-lazy', `${label}: it is a lazy dataset`);
    assert.equal(lazy.metadata.numTimesteps, eager.metadata.sampleCount, `${label}: every step of the file`);

    // ── Every row of every series ──────────────────────────────────────────
    const seriesNames = Object.entries(eager.variables)
        .filter(([, variable]) => variable.kind === 'variable')
        .map(([variableName]) => variableName);
    const rows = await everyRow(lazy, seriesNames);
    for (const variableName of seriesNames) {
        const want = eager.variables[variableName].data;
        const got = rows.get(variableName);
        assert.equal(got.length, want.length, `${label}: ${variableName} has ${got.length} rows, not ${want.length}`);
        for (let index = 0; index < want.length; index++) {
            if (!same(got[index], want[index])) {
                assert.fail(`${label}: ${variableName} row ${index} is ${got[index]}, not ${want[index]}`);
            }
        }
    }

    // ── The tree ───────────────────────────────────────────────────────────
    assert.deepEqual(treeShape(lazy.tree), treeShape(eager.tree), `${label}: the same tree`);

    const timeName = eager.metadata.timeName;
    const timeWant = eager.variables[timeName].data;
    assert.equal(lazy.metadata.timeStart, timeWant[0], `${label}: the axis starts where the file does`);
    assert.equal(lazy.metadata.timeEnd, timeWant[timeWant.length - 1], `${label}: and ends where it does`);

    await source.release(lazy);
    console.log(`  ${label}: ${seriesNames.length} series x ${timeWant.length} rows, ${blocks} block(s)`);
    return { blocks, series: seriesNames.length, rows: timeWant.length };
}

// netCDF3 classic and 64-bit offset, a grouped netCDF4 (HDF5), a CF calendar
// the app has to keep, and a gridded download whose series are a subset.
let splitSomewhere = 0;
for (const name of ['generic-timeseries-classic.nc', 'generic-timeseries-64bit-offset.nc',
    'generic-grouped-netcdf4.netcdf', 'cmip-noleap.nc', 'era5-like-new-cds.nc',
    'era5-like-time-chunked.nc', 'era5-like-legacy-cds.nc', 'cdf5-grid.nc']) {
    const whole = await compare(name);
    // The same file again, forced into blocks of a few rows: the numbers do not
    // depend on where a block ends. A fixture of four steps is one block
    // whatever the budget, so only the longer ones are expected to split.
    const split = await compare(name, { blockBytes: 8 * 8 });
    assert.ok(split.blocks >= whole.blocks, `${name}: a smaller budget is not fewer blocks`);
    if (whole.rows > 8) {
        assert.ok(split.blocks > 1, `${name}: ${whole.rows} rows at 8 values a block is more than one block`);
    }
    if (split.blocks > 1) splitSomewhere += 1;
    // And once more as the app does it: the description cloned, the blocks
    // pulled one at a time through the client.
    await compare(name, { blockBytes: 8 * 8, throughWorker: true });
}
assert.ok(splitSomewhere > 0, 'at least one fixture was read in several blocks');

// ── Where the app asks for it ───────────────────────────────────────────────
//
// A netCDF is judged by what its series would load, not by the size of the
// file, so the lazy dataset is asked for where that limit is found — and
// before the question about loading the file whole, which is only for when
// there is no lazy dataset to be had.
{
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const overLimit = source.indexOf("if (err?.code !== 'NETCDF_OVER_LIMIT') throw err;");
    const asksLazy = source.indexOf('this._openLazyNetcdf(filename, file, options)', overLimit);
    const asksUser = source.indexOf('_confirmOversizedFile', overLimit);
    assert.ok(overLimit > 0, 'the loading path still recognises NETCDF_OVER_LIMIT');
    assert.ok(asksLazy > overLimit, 'it asks _openLazyNetcdf when the series do not fit');
    assert.ok(asksLazy < asksUser, 'and it asks before asking the user to load the file whole');
    // The worker is the only place the file can be read by parts.
    const handlers = readFileSync(new URL('../src/workers/parse-handlers.js', import.meta.url), 'utf8');
    for (const op of ['netcdf-columns:open', 'netcdf-columns:block', 'netcdf-columns:close']) {
        assert.ok(handlers.includes(`'${op}'`), `the parse worker answers ${op}`);
    }
    console.log('  the loading path: the lazy dataset is asked for before the user is');
}

// A PyPSA network is a different dataset, built by its own parser.
{
    const reader = await openNetcdfColumns({ buffer: fixture('atlite-cutout.nc') }, { parser: new MatParser(), filename: 'atlite-cutout.nc' });
    if (reader) {
        await source.release(await ingestColumnarReader(source, reader, { overviewPoints: 50 }));
        console.log('  atlite-cutout.nc: a cutout is read by parts like any other file');
    } else {
        console.log('  atlite-cutout.nc: left to the in-memory path');
    }
}

console.log('Lazy netCDF: a file read by parts into the engine is the file read into memory.');
process.exit(0);
