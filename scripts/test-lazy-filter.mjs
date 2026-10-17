// The digital filter on a lazy file runs over every row of the file, in the
// chunked executor, and gives the doubles the in-memory filter gives.
//
//   node scripts/test-lazy-filter.mjs
//
// A CSV loaded lazily through the app's DuckDbSource on a real DuckDB-WASM
// engine (the Node build of the package the app ships), against applyFilter on
// the arrays the in-memory path holds. Bit for bit:
//
//   · the step of the time axis, measured over the whole file, is
//     detectSamplingGaps's: median, nominal step or not and why, gaps and
//     missing samples — on a regular axis with dropouts, an irregular one and
//     one that goes backwards;
//   · forward filters created the way the panel creates them — a first-order
//     and a resonant IIR, a designed cascade of sections, a sparse echo — with
//     holes in the rows and in time, restart gaps, the initial states, a lead
//     and a delay, and the counts the panel reports;
//   · zero phase, with stretches held in memory and — with a small limit, in
//     chunks — long ones done in two passes, the backward pass reading the
//     work table by ranges and replacing the sink's rows where they are; the
//     sink still lines up with the file afterwards, and no work table is left;
//   · a file whose profile filters rows out, with rows that have no time, and
//     one with a generated axis;
//   · the designer's sample rate is the whole file's, not the overview's.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { runChunkedJob } = await import(new URL('../src/data/chunk-executor.js', import.meta.url));
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const { installFilterMethods } = await import(new URL('../src/app/methods/filter-methods.js', import.meta.url));
const { applyFilter, createZeroPhaseFilter } = await import(new URL('../src/compute/kernels/iir.js', import.meta.url));
const { designFilter } = await import(new URL('../src/compute/kernels/filter-design.js', import.meta.url));
const { detectSamplingGaps } = await import(new URL('../src/utils/sampling-gaps.js', import.meta.url));

// ── An app with the Data Tools, filter and derived methods, and no DOM ──────
class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        this.dataToolVariablesByFile = new Map();
        this.derivedByFile = new Map();
        this.messages = [];
        this.plotManager = { files: this.files, updateFileData() {}, plots: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
    }
}
installDataToolsMethods(Harness);
installLazyDataToolsMethods(Harness);
installDerivedMethods(Harness);
installFilterMethods(Harness);
Object.assign(Harness.prototype, {
    _renderFilteredTree() {},
    _syncDataTools() {},
    _setOutlierMessage(message, type) { this.messages.push([typeof message === 'function' ? message() : message, type]); },
});

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 13;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 20011;
// A 10 ms grid with jitter and dropouts of the axis; `a` with holes (one long
// run of them in the middle) and a stretch of wild values; `b` with no hole.
const lines = ['t,a,b'];
{
    let time = 0;
    for (let i = 0; i < ROWS; i++) {
        time += (i % 997 === 500 ? 6 : 1) * 0.01 + (random() - 0.5) * 2e-5;
        const hole = i % 211 === 17 || (i > 9000 && i < 9040);
        const a = hole ? '' : String(Math.round((Math.sin(i / 37) * 4 + random()) * 1e5) / 1e5);
        const b = String(Math.round((Math.cos(i / 90) + random() * 0.2) * 1e5) / 1e5);
        lines.push(`${time.toFixed(6)},${a},${b}`);
    }
}
// An irregular axis, and one that goes backwards.
const irregularLines = ['t,v'];
for (let i = 0, t = 0; i < 400; i++) { t += 0.5 + random(); irregularLines.push(`${t},${i % 7}`); }
const backwardsLines = ['t,v', '0,1', '1,2', '2,3', '1.5,4', '3,5', '4,6', '5,7'];
// A file whose profile keeps the rows tagged `keep`, with rows that have no
// time, and the same file read with a generated axis.
const filteredLines = ['tag,t,v'];
for (let i = 0; i < 6007; i++) {
    const tag = i % 5 === 2 ? 'drop' : 'keep';
    const t = i % 41 === 7 ? '' : (i * 0.5).toFixed(1);
    const v = i % 113 === 4 ? '' : String(Math.round(Math.cos(i / 30) * 1e5) / 1e3);
    filteredLines.push(`${tag},${t},${v}`);
}
const filteredProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['tag', 't', 'v'],
    headers: [{ name: 'tag' }, { name: 't' }, { name: 'v' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2],
    sampleRows: [],
    timeSource: { ok: true, kind: 'numeric', strategy: 'numeric', sourceIndexes: [1], name: 't' },
    rowFilter: { enabled: true, columnIndex: 0, operator: '==', value: 'keep' },
};
const generatedProfile = { ...filteredProfile, numericColumnIndexes: [2], timeSource: { ok: true, strategy: 'generated-index', name: 'index' } };

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
db.registerFileText('sig.csv', lines.join('\n') + '\n');
db.registerFileText('irregular.csv', irregularLines.join('\n') + '\n');
db.registerFileText('backwards.csv', backwardsLines.join('\n') + '\n');
db.registerFileText('filtered.csv', filteredLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'sig.csv', csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_filter_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName);
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const concat = (pick) => {
        const out = new Float64Array(chunks.reduce((n, c) => n + c.x.length, 0));
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    const data = structuredClone({ metadata: lazy.metadata, variables: Object.fromEntries(
        Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])) });
    data.variables[lazy.metadata.timeName].data = concat(c => c.x);
    for (const name of names) data.variables[name].data = concat(c => c.yByVar.get(name));
    return data;
}
function app(data) {
    const h = new Harness();
    h.files.set('f', { data });
    return h;
}
async function create(h, sourceName, outputName, config) {
    const data = h.files.get('f').data;
    return h._applyLazyDataToolCreateMode({
        fileId: 'f', data, sourceName, sourceVariable: data.variables[sourceName], outputName,
        targetMode: 'create', tool: config.tool, lazy: true,
    }, config, { silent: true });
}
async function readAll(data, name) {
    const out = [];
    for await (const chunk of streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return Float64Array.from(out);
}
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, the kernel gives ${expected[i]}`);
    }
}
const tables = async (pattern) => duck._arrowRowsToObjects(await duck.query(
    `SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '${pattern}'`)).map(row => row.table_name);
const reportKeys = ['segments', 'restarts', 'carriedBreaks', 'filteredCount', 'skippedCount', 'irregular'];

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.equal(eager.variables.t.data.length, ROWS, 'the in-memory copy has every row');
const h = app(lazy);
const eh = app(eager);

// ── The time axis, measured over the whole file ────────────────────────────
{
    const check = async (data, reference, label) => {
        const steps = await app(data)._lazyAxisSteps(data);
        const kernel = detectSamplingGaps(reference.variables[reference.metadata.timeName].data);
        assert.equal(steps.timed, true, `${label}: a timed axis`);
        assert.ok(same(steps.medianDt, kernel.medianDt), `${label}: median step ${steps.medianDt} vs ${kernel.medianDt}`);
        for (const key of ['hasNominalStep', 'reason', 'count', 'totalMissing']) {
            assert.equal(steps[key], kernel[key], `${label}: ${key}`);
        }
    };
    await check(lazy, eager, 'regular axis with dropouts');
    const irregular = await loadLazy('irregular.csv');
    await check(irregular, await eagerFrom(irregular), 'irregular axis');
    const backwards = await loadLazy('backwards.csv');
    await check(backwards, await eagerFrom(backwards), 'an axis that goes backwards');
    assert.ok(detectSamplingGaps(eager.variables.t.data).count > 10, 'the fixture has gaps of the axis');
}
console.log('lazy filter: the step of the time axis over the whole file is detectSamplingGaps\'s (gaps, irregular, backwards)');

// ── Forward, from the panel ────────────────────────────────────────────────
const sos = designFilter({ family: 'butterworth', response: 'lowpass', order: 4, cutoff: [5], sampleRate: 100 }).sos;
const filters = {
    firstOrder: { source: 'manual', b: [0.2, 0.3], a: [1, -0.5] },
    resonant: { source: 'manual', b: [1], a: [1, -1.6, 0.8] },
    butterworth: { source: 'design', b: [1], a: [1], sos },
    echo: { source: 'manual', b: [1, ...new Array(149).fill(0), 0.5], a: [1] },
};
const settings = [
    { advance: 0, restartGap: 0, init: 'steady' },
    { advance: 3, restartGap: 2, init: 'zero' },
    { advance: -2, restartGap: 100000, init: 'level', initState: [2.5] },
];
let created = 0;
for (const [name, filter] of Object.entries(filters)) {
    for (const [s, setting] of settings.entries()) {
        for (const source of ['a', 'b']) {
            const params = { ...filter, mode: 'forward', initState: [], ...setting };
            const output = `f_${name}_${s}_${source}`;
            const result = await create(h, source, output, { tool: 'filter', params });
            const expected = eh._computeFilteredValues(eager.variables[source].data, eager, params);
            assertBitwise(await readAll(lazy, output), expected.values, output);
            const dataTool = lazy.variables[output].dataTool;
            for (const key of reportKeys) assert.equal(dataTool[key], expected[key], `${output}: ${key}`);
            assert.equal(result.count, expected.filteredCount, `${output}: the count the panel reports`);
            const note = eh._filterNote(expected);
            assert.equal(typeof result.warning === 'function' ? result.warning() : result.warning, note, `${output}: the note`);
            created++;
        }
    }
}
console.log(`lazy filter: forward matches the kernel bit for bit (${created} filters: IIR, sections, a sparse echo; holes in rows and time, restarts, initial states, lead and delay)`);

// ── Zero phase, from the panel ─────────────────────────────────────────────
for (const [name, filter] of Object.entries(filters)) {
    for (const source of ['a', 'b']) {
        const params = { ...filter, mode: 'zeroPhase', advance: 0, restartGap: 0, init: 'steady', initState: [] };
        const output = `z_${name}_${source}`;
        await create(h, source, output, { tool: 'filter', params });
        const expected = eh._computeFilteredValues(eager.variables[source].data, eager, params);
        assertBitwise(await readAll(lazy, output), expected.values, output);
        for (const key of reportKeys) assert.equal(lazy.variables[output].dataTool[key], expected[key], `${output}: ${key}`);
    }
}
console.log('lazy filter: zero phase matches the kernel bit for bit (each stretch held in memory)');

// ── Zero phase in two passes, through the executor ─────────────────────────
{
    const steps = await h._lazyAxisSteps(lazy);
    let longStretches = 0;
    for (const [name, filter] of Object.entries(filters)) {
        for (const source of ['a', 'b']) {
            for (const [memoryRows, chunkRows] of [[300, 1000], [2000, 777], [50, 5000]]) {
                const params = { ...filter, mode: 'zeroPhase' };
                const kernel = createZeroPhaseFilter(params, { axis: steps, memoryRows });
                const sink = await duck.createSink(lazy);
                const progress = [];
                await runChunkedJob({
                    data: lazy,
                    sourceNames: [source],
                    kernel: {
                        push: chunk => kernel.push(chunk.yByVar.get(source)),
                        flush: () => kernel.flush(),
                        backward: s => kernel.backward(s),
                        longStretches: kernel.longStretches,
                    },
                    sink,
                    chunkRows,
                    onProgress: p => progress.push(p),
                });
                longStretches += kernel.longStretches.length;
                const label = `two passes, ${name} on ${source}, memoryRows ${memoryRows}, chunks of ${chunkRows}`;
                // `b` has no hole: one stretch as long as the file, always long.
                if (source === 'b') {
                    assert.equal(kernel.longStretches.length, 1, `${label}: one long stretch`);
                    assert.ok(progress.some(p => p.pass === 2), `${label}: the backward pass reports progress`);
                }
                lazy.variables.zz = { ...lazy.variables.z_firstOrder_a, _duckdbExpr: `"${sink.columns[0].column}"`, _duckdbWindows: [sink.columns[0]] };
                assertBitwise(await readAll(lazy, 'zz'), applyFilter(eager.variables[source].data, params).values, label);
                // The rows were replaced where they were: the sink still lines
                // up with the file.
                const [check] = duck._arrowRowsToObjects(await duck.query(`
                    SELECT COUNT(*) FILTER (WHERE "${sink.rnColumn}" <> rr)::BIGINT AS misplaced
                    FROM (SELECT *, ROW_NUMBER() OVER () - 1 AS rr FROM ${duck._rawRelationSql(lazy._duckdb)} POSITIONAL JOIN ${sink.table})`));
                assert.equal(Number(check.misplaced), 0, `${label}: the sink lines up with the file`);
                delete lazy.variables.zz;
                await duck.dropSink(lazy, sink.table);
            }
        }
    }
    assert.ok(longStretches > 20, 'the two-pass path ran on stretches between holes too');
    assert.deepEqual(await tables('%\\_work\\_%'), [], 'no work table is left');
    console.log(`lazy filter: zero phase in two passes matches the kernel bit for bit (${longStretches} long stretches, the sink updated in place)`);

    // Cancelled in the backward pass: the sink and the work table go.
    const before = await tables('%\\_sink\\_%');
    const kernel = createZeroPhaseFilter({ ...filters.resonant, mode: 'zeroPhase' }, { axis: steps, memoryRows: 100 });
    const sink = await duck.createSink(lazy);
    const controller = new AbortController();
    await assert.rejects(runChunkedJob({
        data: lazy, sourceNames: ['b'], sink, chunkRows: 2000, signal: controller.signal,
        kernel: { push: c => kernel.push(c.yByVar.get('b')), flush: () => kernel.flush(), backward: s => kernel.backward(s), longStretches: kernel.longStretches },
        onProgress: p => { if (p.pass === 2) controller.abort(); },
    }), err => err.name === 'AbortError', 'a job cancelled in its backward pass stops');
    assert.deepEqual(await tables('%\\_sink\\_%'), before, 'and drops its sink');
    assert.deepEqual(await tables('%\\_work\\_%'), [], 'and its work table');
    console.log('lazy filter: a job cancelled in its backward pass leaves no table behind');
}

// ── Rows the lazy queries do not serve ──────────────────────────────────────
for (const [label, profile] of [['row filter and rows without time', filteredProfile], ['generated time axis', generatedProfile]]) {
    const data = await loadLazy('filtered.csv', profile);
    const reference = await eagerFrom(data);
    const fh = app(data);
    for (const [mode, setting] of [['forward', settings[1]], ['zeroPhase', settings[0]]]) {
        const params = { ...filters.resonant, mode, initState: [], ...setting };
        await create(fh, 'v', `f_${mode}`, { tool: 'filter', params });
        const expected = app(reference)._computeFilteredValues(reference.variables.v.data, reference, params);
        assertBitwise(await readAll(data, `f_${mode}`), expected.values, `${label}, ${mode}`);
    }
    await duck.release(data);
}
console.log('lazy filter: the sink lines up with the file through filtered rows, rows without time and a generated axis');

// ── The designer's sample rate is the whole file's ─────────────────────────
{
    const fresh = await loadLazy();
    const fh = app(fresh);
    assert.equal(fh._lazyAxisStepsNow(fresh), null, 'not measured yet: no rate, and the measurement starts');
    await Promise.all([...fh._lazyAxisStepRuns.values()]);
    const steps = fh._lazyAxisStepsNow(fresh);
    assert.ok(same(steps.medianDt, detectSamplingGaps(eager.variables.t.data).medianDt), 'then the whole file\'s step');
    // The overview's own spacing is a sample's: it would have been wrong.
    const overview = detectSamplingGaps(fresh.variables.t.data);
    assert.ok(!(Math.abs(overview.medianDt - steps.medianDt) < steps.medianDt), 'the overview alone gives another step');
}
console.log('lazy filter: the designer reads the sample rate of the whole file, not of its overview');

console.log('lazy filter: the digital filter runs over every row of a lazy file, exactly');
