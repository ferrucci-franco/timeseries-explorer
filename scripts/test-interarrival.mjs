// The Data tool "Time between edges" (tool id `interarrival`).
//
//   node scripts/test-interarrival.mjs
//
//   · the kernel: rising, falling or both; a dead band measured from the last
//     edge (a slow drift counts, noise around a level does not); NaN samples
//     and times skipped; seconds on a date/time axis, the axis's unit on a
//     numeric one, samples on an index; the same output however it is cut;
//   · the panel's in-memory path: the variable, its unit, its counts, and a
//     source that is itself an interarrival output;
//   · a lazy file on a real DuckDB-WASM engine: the chunked executor writes the
//     kernel's own doubles to a sink, on a numeric axis, a date/time axis and
//     a generated one, and a session runs it again.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const {
    computeInterarrival, createInterarrival, normalizeInterarrivalParams,
} = await import(new URL('../src/compute/kernels/interarrival.js', import.meta.url));
const { runDataToolPipeline } = await import(new URL('../src/compute/kernels/index.js', import.meta.url));

const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
}
const run = (y, params, time = null) => computeInterarrival(Float64Array.from(y), time, params);
const finite = (values) => [...values].map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));

// ── The kernel ──────────────────────────────────────────────────────────────
{
    // Every change is an edge with no dead band; the output sits on the edge
    // and the first edge of the chosen kind has no interval.
    const y = [0, 0, 1, 1, 1, 0, 0, 2, 2, 1];
    const t = { values: Float64Array.from(y, (_, i) => i * 10), kind: 'numeric' };
    const both = run(y, { edge: 'both' }, t);
    assert.deepEqual(finite(both.values), [[5, 30], [7, 20], [9, 20]], 'both: time since the previous edge, at the edge');
    assert.equal(both.risingCount, 2);
    assert.equal(both.fallingCount, 2);
    assert.equal(both.edgeCount, 4);
    assert.equal(both.intervalCount, 3);
    assert.equal(both.meanDt, 70 / 3);
    assert.equal(both.minDt, 20);
    assert.equal(both.maxDt, 30);
    assert.ok(Number.isNaN(both.values[2]), 'the first edge has no interval');
    const rising = run(y, { edge: 'rising' }, t);
    assert.deepEqual(finite(rising.values), [[7, 50]], 'rising: from rise to rise, falls in between ignored');
    assert.equal(rising.edgeCount, 2);
    const falling = run(y, { edge: 'falling' }, t);
    assert.deepEqual(finite(falling.values), [[9, 40]], 'falling: from fall to fall');
    assert.equal(falling.values.length, y.length, 'as long as the input');
}
{
    // A dead band measured from the last edge: a drift of 0.3 a sample makes
    // an edge every 4 samples (1.2 ≥ 1), where sample-to-sample it never would.
    const drift = Array.from({ length: 13 }, (_, i) => i * 0.3);
    const out = run(drift, { edge: 'rising', deadband: 1 });
    assert.equal(out.risingCount, 3, 'a slow drift still makes edges');
    assert.deepEqual(finite(out.values).map(([i]) => i), [8, 12], 'every 4 samples');
    assert.deepEqual(finite(out.values).map(([, v]) => v), [4, 4], 'intervals in samples on an index');
    // Noise around a level makes none, then a real step makes one each way.
    const noisy = [5, 5.2, 4.9, 5.1, 4.8, 5.3, 5, 8, 8.2, 7.9, 8.1, 5, 5.1];
    const band = run(noisy, { edge: 'both', deadband: 1 });
    assert.equal(band.risingCount, 1, 'noise is not an edge');
    assert.equal(band.fallingCount, 1);
    assert.deepEqual(finite(band.values), [[11, 4]], 'step up at 7, down at 11');
    const raw = run(noisy, { edge: 'both', deadband: 0 });
    assert.ok(raw.edgeCount > 8, 'without a band every wiggle is an edge');
    // The band is inclusive: an integer counter with |ΔY| = 1 counts each step.
    const counter = run([10, 10, 11, 11, 12, 13], { edge: 'rising', deadband: 1 });
    assert.equal(counter.risingCount, 3, '|ΔY| = 1 on a counter of 1-unit steps');
    // A fall moves the reference too: the rise after it is measured from
    // where it fell to.
    const after = run([0, 3, 0.5, 2], { edge: 'rising', deadband: 1 });
    assert.equal(after.risingCount, 2, 'measured from the fall');
}
{
    // NaN values and times are skipped and leave the reference alone.
    const y = [0, NaN, 1, Infinity, 1, 0];
    const tv = Float64Array.from([0, 1, 2, 3, NaN, 5]);
    const out = run(y, { edge: 'both' }, { values: tv, kind: 'numeric' });
    assert.deepEqual(finite(out.values), [[5, 3]], 'NaN skipped');
    // A date/time axis is in milliseconds; intervals come out in seconds.
    const dt = run([0, 1, 1, 2], { edge: 'rising' }, { values: Float64Array.from([0, 60000, 120000, 300000]), kind: 'datetime' });
    assert.deepEqual(finite(dt.values), [[3, 240]], 'seconds on a date/time axis');
    assert.equal(dt.timeKind, 'datetime');
    // A time axis that does not match the series counts samples.
    const mismatch = run([0, 1, 2], { edge: 'rising' }, { values: Float64Array.from([0, 5]), kind: 'numeric' });
    assert.deepEqual(finite(mismatch.values), [[2, 1]], 'samples when the axis does not fit');
    // Time going backwards gives a negative interval, counted.
    const back = run([0, 1, 2], { edge: 'rising' }, { values: Float64Array.from([0, 10, 4]), kind: 'numeric' });
    assert.equal(back.negativeDtCount, 1, 'a negative interval is counted');
}
{
    assert.deepEqual(normalizeInterarrivalParams({}), { edge: 'both', deadband: 0 });
    assert.deepEqual(normalizeInterarrivalParams({ edge: 'up', deadband: -3 }), { edge: 'both', deadband: 0 });
    assert.deepEqual(normalizeInterarrivalParams({ edge: 'falling', deadband: '0.5' }), { edge: 'falling', deadband: 0.5 });
}
{
    // The same doubles whatever the chunking.
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const n = 5003;
    const y = Float64Array.from({ length: n }, (_, i) => (i % 97 === 0 ? NaN : Math.round(Math.sin(i / 40) * 20 + random() * 3)));
    const tv = Float64Array.from({ length: n }, (_, i) => i * 1000 + (i % 7) * 13);
    for (const params of [{ edge: 'both' }, { edge: 'rising', deadband: 2.5 }, { edge: 'falling', deadband: 1 }]) {
        const whole = computeInterarrival(y, { values: tv, kind: 'datetime' }, params).values;
        for (const size of [1, 17, 1000]) {
            const kernel = createInterarrival(params, { kind: 'datetime' });
            const parts = [];
            for (let at = 0; at < n; at += size) parts.push(...kernel.push(y.subarray(at, at + size), tv.subarray(at, at + size)));
            parts.push(...kernel.flush());
            assertBitwise(Float64Array.from(parts), whole, `${params.edge} in chunks of ${size}`);
        }
        // And the worker's dispatch gives the same thing.
        const piped = runDataToolPipeline(y, { values: tv, kind: 'datetime' }, [{ tool: 'interarrival', params }]);
        assertBitwise(piped.values, whole, `${params.edge} through the pipeline`);
        assert.equal(piped.stepMeta[0].intervalCount, computeInterarrival(y, { values: tv, kind: 'datetime' }, params).intervalCount);
    }
}
console.log('interarrival: the kernel times rising, falling and both edges through a dead band that remembers the last edge');

// ── The panel's in-memory path ──────────────────────────────────────────────
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));

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
Object.assign(Harness.prototype, {
    _renderFilteredTree() {},
    _syncDataTools() {},
    _setOutlierMessage(message, type) { this.messages.push([typeof message === 'function' ? message() : message, type]); },
});
{
    const h = new Harness();
    const minutes = Float64Array.from({ length: 600 }, (_, i) => Date.UTC(2026, 9, 1) + i * 60000);
    const meter = Float64Array.from(minutes, (_, i) => 8597 + Math.floor(i / 90));
    const data = {
        metadata: { timeName: 'Time', timeKind: 'datetime' },
        variables: {
            Time: { name: 'Time', kind: 'abscissa', data: minutes, timeKind: 'datetime' },
            meter: { name: 'meter', kind: 'variable', data: meter, description: 'Energy [kWh]' },
        },
    };
    h.files.set('f', { data });
    const config = { tool: 'interarrival', params: { edge: 'rising', deadband: 1 } };
    const result = h._buildDataToolResult(meter, data.variables.meter, { ...config, sourceName: 'meter', targetName: 'meter dt_up', targetMode: 'create' }, data);
    const variable = result.variable;
    assert.equal(result.tool, 'interarrival');
    assert.equal(result.count, 5, 'six rises, five intervals');
    assert.deepEqual(finite(variable.data).map(([, v]) => v), [5400, 5400, 5400, 5400, 5400], 'every 90 minutes, in seconds');
    assert.equal(variable.eventSamples, true, 'drawn as dots');
    assert.match(variable.description, /interarrival time of meter; rising edges; deadband 1 \[s\]$/, 'its unit is the second');
    assert.equal(variable.dataTool.edge, 'rising');
    assert.equal(variable.dataTool.intervalCount, 5);
    assert.equal(variable.dataTool.meanDt, 5400);
    assert.equal(variable.displayName, 'meter dt_up');
    assert.equal(result.warning, '', 'intervals were found: no warning');
    assert.match(result.note(), /^6 edges; mean interval 1 h 30 min \(min 1 h 30 min, max 1 h 30 min\)\.$/, 'the summary');
    // None of the kind asked for: the result says so.
    const none = h._buildDataToolResult(meter, data.variables.meter, { tool: 'interarrival', params: { edge: 'falling', deadband: 0 }, sourceName: 'meter', targetName: 'x', targetMode: 'create' }, data);
    assert.equal(none.count, 0);
    assert.match(none.warning(), /^No interval: 0 falling edges found/, 'the warning names the edges');
    // A tool run on the output is a curve again, not a series of events.
    data.variables['meter dt_up'] = variable;
    const smoothed = h._buildDataToolResult(variable.data, variable, { tool: 'movingAverage', params: { window: 3 }, sourceName: 'meter dt_up', targetName: 'avg', targetMode: 'create' }, data);
    assert.equal(smoothed.variable.eventSamples, undefined, 'a moving average of it is not drawn as events');
    // Its definition survives a session.
    assert.deepEqual(h._normalizeDataToolParams('interarrival', { edge: 'rising', deadband: 1 }), { edge: 'rising', deadband: 1 });
    assert.equal(h._normalizeDataToolDefinition({ tool: 'interarrival', params: { edge: 'x' } }).params.edge, 'both');
    // The unit on other axes.
    assert.equal(h._interarrivalUnit({ metadata: { timeName: 't', timeKind: 'numeric' }, variables: { t: { kind: 'abscissa', description: 'Time [ms]' } } }), 'ms');
    assert.equal(h._interarrivalUnit({ metadata: { timeName: 't', timeKind: 'numeric' }, variables: { t: { kind: 'abscissa', description: 'Time' } } }), 's');
    assert.equal(h._interarrivalUnit({ metadata: { timeName: 't', timeKind: 'index' }, variables: { t: { kind: 'abscissa' } } }), '');
    assert.equal(h._interarrivalNameSuffix('rising'), 'dt_up');
    assert.equal(h._interarrivalNameSuffix('falling'), 'dt_down');
    assert.equal(h._interarrivalNameSuffix('both'), 'dt_edges');
}
console.log('interarrival: the in-memory tool writes the intervals in seconds, drawn as events, with its counts');

// ── A lazy file ─────────────────────────────────────────────────────────────
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { runChunkedJob } = await import(new URL('../src/data/chunk-executor.js', import.meta.url));

const ROWS = 20011;
const numericLines = ['t,meter,noisy'];
const datetimeLines = ['time,meter'];
const start = Date.UTC(2026, 9, 1);
for (let i = 0; i < ROWS; i++) {
    const meter = i % 211 === 5 ? '' : String(8597 + Math.floor(i / 73) + (i % 1000 === 999 ? -3 : 0));
    const noisy = String(Math.round((Math.sin(i / 50) * 10 + ((i * 7919) % 13) / 13) * 1000) / 1000);
    numericLines.push(`${(i * 60).toFixed(0)},${meter},${noisy}`);
    const stamp = new Date(start + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
    datetimeLines.push(`${stamp},${meter}`);
}
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['t', 'meter', 'noisy'],
    headers: [{ name: 't' }, { name: 'meter' }, { name: 'noisy' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2],
    sampleRows: [],
    timeSource: { ok: true, strategy: 'generated-index', name: 'index' },
};

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
db.registerFileText('numeric.csv', numericLines.join('\n') + '\n');
db.registerFileText('datetime.csv', datetimeLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle, csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_interarrival_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
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
const app = (data) => { const h = new Harness(); h.files.set('f', { data }); return h; };
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
const pending = (h) => Promise.all([...(h._lazyToolStatsPending || [])]);

for (const [label, handle, profile, expectKind] of [
    ['numeric axis', 'numeric.csv', null, 'numeric'],
    ['date/time axis', 'datetime.csv', null, 'datetime'],
    ['generated axis', 'numeric.csv', generatedProfile, 'index'],
]) {
    const lazy = await loadLazy(handle, profile);
    const eager = await eagerFrom(lazy);
    const h = app(lazy);
    const eh = app(eager);
    assert.equal(h._lazyToolTimeAxis(lazy).kind, expectKind, `${label}: the axis the lazy kernel reads`);
    assert.equal(eh._getDataToolTimeContext(eager, ROWS).kind, expectKind, `${label}: the axis the in-memory kernel reads`);
    const sources = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName);
    for (const source of sources) {
        for (const params of [{ edge: 'both', deadband: 0 }, { edge: 'rising', deadband: 2 }, { edge: 'falling', deadband: 0.5 }]) {
            const name = `${source} ${params.edge} ${params.deadband}`;
            const result = await create(h, source, name, { tool: 'interarrival', params });
            assert.equal(result?.name, name, `${label} ${name}: created`);
            const variable = lazy.variables[name];
            assert.ok(variable._duckdbExpr && variable._duckdbWindows?.[0]?.sink, `${label} ${name}: reads a sink`);
            assert.equal(variable.eventSamples, true, `${label} ${name}: drawn as events`);
            const expected = eh._computeInterarrivalValues(eager.variables[source].data, eager, params);
            assertBitwise(await readAll(lazy, name), expected.values, `${label} ${name}`);
            assert.equal(result.count, expected.intervalCount, `${label} ${name}: the interval count`);
            assert.equal(variable.dataTool.edgeCount, expected.edgeCount, `${label} ${name}: the edge count`);
            assert.equal(variable.dataTool.meanDt, expected.meanDt, `${label} ${name}: the mean interval`);
            assert.equal(h._interarrivalUnit(lazy), eh._interarrivalUnit(eager), `${label}: the same unit`);
        }
    }
    // Through the executor in small chunks.
    {
        const params = { edge: 'rising', deadband: 1 };
        const expected = eh._computeInterarrivalValues(eager.variables.meter.data, eager, params).values;
        for (const chunkRows of [1, 777]) {
            const sink = await duck.createSink(lazy);
            const kernel = h._lazySinkKernel(lazy, { tool: 'interarrival', sourceName: 'meter', params });
            await runChunkedJob({ data: lazy, sourceNames: ['meter'], kernel, sink, withTime: !!kernel.withTime, chunkRows });
            lazy.variables.cut = { ...lazy.variables.meter, _duckdbExpr: `"${sink.columns[0].column}"`, _duckdbWindows: [sink.columns[0]] };
            delete lazy.variables.cut._duckdbCol;
            assertBitwise(await readAll(lazy, 'cut'), expected, `${label}: chunks of ${chunkRows}`);
            delete lazy.variables.cut;
            await duck.dropSink(lazy, sink.table);
        }
    }
    if (label === 'numeric axis') {
        // A session restores the definition and runs the job again.
        const params = { edge: 'rising', deadband: 1 };
        await create(h, 'meter', 'restored', { tool: 'interarrival', params });
        const saved = h._serializeDataToolDefinitions('f').find(item => item.name === 'restored');
        assert.deepEqual(saved.params, params, 'the session keeps the parameters');
        const again = await loadLazy(handle, profile);
        const rh = app(again);
        rh.dataToolVariablesByFile.set('f', new Map([['restored', { ...saved, variable: null }]]));
        rh._reapplyDataToolVariables('f', again);
        await pending(rh);
        assert.ok(again.variables.restored._duckdbWindows?.[0]?.sink, 'the job ran again');
        assertBitwise(await readAll(again, 'restored'), eh._computeInterarrivalValues(eager.variables.meter.data, eager, params).values, 'restored');
        await duck.release(again);
    }
    await duck.release(lazy);
}
console.log('interarrival: a lazy file gets the kernel\'s own intervals on numeric, date/time and generated axes, and again from a session');
