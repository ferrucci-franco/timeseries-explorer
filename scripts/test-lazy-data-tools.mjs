// Data Tools on a lazy file compute over every row of the file, and give the
// numbers the in-memory tools give.
//
//   node scripts/test-lazy-data-tools.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. Each tool is created on the lazy file the way
// the panel creates it, read back over the whole file, and compared with the
// kernel run on the arrays:
//
//   · derivative (4 methods × numeric, calendar and index axes): bit for bit —
//     the SQL does the kernel's arithmetic, operation for operation;
//   · IQR outliers: bit for bit — the quartiles are exact order statistics;
//   · detrend by a polynomial: to rounding — the fit's sums are added in an
//     order no SQL aggregate promises; with the kernel's own coefficients the
//     subtraction is bit for bit;
//   · first-sample detrend: bit for bit.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const lazySql = await import(new URL('../src/data/lazy-tool-sql.js', import.meta.url));
const { computeDetrend } = await import(new URL('../src/compute/kernels/detrend.js', import.meta.url));
const { detectSamplingGaps } = await import(new URL('../src/utils/sampling-gaps.js', import.meta.url));

// ── An app with the Data Tools and derived-variable methods, and no DOM ─────
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
// The panel's DOM is not here.
Object.assign(Harness.prototype, {
    _renderFilteredTree() {},
    _syncDataTools() {},
    _setOutlierMessage(message, type) { this.messages.push([typeof message === 'function' ? message() : message, type]); },
});

// ── The fixture ─────────────────────────────────────────────────────────────
// A time column with repeated instants (Δt = 0) and irregular steps; `a` with
// holes and a few wild values (IQR bait); `b` near the double range, so a
// difference overflows to ±∞; `c` with many repeated values (quartiles that
// fall on ties).
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 40003;
const cols = { t: [], a: [], b: [], c: [] };
const lines = ['t,a,b,c'];
let time = 1000;
for (let i = 0; i < ROWS; i++) {
    if (i % 97 !== 5) time += Math.round((0.5 + random()) * 1000) / 1000;
    const a = i % 13 === 0 ? NaN : Math.round((Math.sin(i / 300) * 10 + random() + (i % 1777 === 3 ? 400 : 0) + i / 5000) * 1e4) / 1e4;
    const b = i % 29 === 0 ? (i % 58 === 0 ? 1.5e308 : -1.6e308) : Math.round(random() * 1e6) / 7;
    const c = i % 17 === 0 ? NaN : Math.floor(random() * 6);
    cols.t.push(time); cols.a.push(a); cols.b.push(b); cols.c.push(c);
    lines.push([time, a, b, c].map(v => (Number.isNaN(v) ? '' : String(v))).join(','));
}
// The same instants as calendar time.
const dtLines = ['stamp,a'];
for (let i = 0; i < ROWS; i++) {
    const iso = new Date(Date.UTC(2024, 0, 1) + Math.round(cols.t[i] * 1000)).toISOString().replace('T', ' ').replace('Z', '');
    dtLines.push(`${iso},${Number.isNaN(cols.a[i]) ? '' : cols.a[i]}`);
}

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
db.registerFileText('stamps.csv', dtLines.join('\n') + '\n');
// A regular grid — 10 ms, ±0.4 % jitter — with dropouts (gaps of the time
// axis) and empty cells: what the integral's gap detection and policies are
// about. The same instants on a calendar axis, in whole milliseconds.
const gridLines = ['t,g,h'];
const gridStampLines = ['stamp,g,h'];
{
    let at = 0;
    for (let i = 0; i < 30011; i++) {
        // Mostly 10 ms, some 9 ms (9 · 0.001 is not 9 / 1000 in doubles).
        at += i % 3001 === 1500 ? 80 : (i % 7 === 3 ? 9 : 10);
        const t = (at + (i % 5) * 0.04) / 1000;
        const g = i % 997 === 13 ? '' : String(Math.round((Math.sin(i / 400) * 3 + (i % 11) / 10) * 1e4) / 1e4);
        const hv = String(Math.round(Math.cos(i / 90) * 1e4) / 1e4);
        gridLines.push(`${t},${g},${hv}`);
        const iso = new Date(Date.UTC(2024, 2, 1) + at).toISOString().replace('T', ' ').replace('Z', '');
        gridStampLines.push(`${iso},${g},${hv}`);
    }
}
db.registerFileText('grid.csv', gridLines.join('\n') + '\n');
db.registerFileText('gridstamps.csv', gridStampLines.join('\n') + '\n');
// Six steps whose two middle ones differ (1.04, 1.06): the median is their
// mean, and one step (3.2) is past 1.5 × it.
db.registerFileText('evensteps.csv', 't,v\n0,1\n1,2\n2.02,4\n3.06,3\n4.12,5\n5.2,6\n8.4,2\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
async function loadLazy(handle = 'sig.csv') {
    const data = await duck._loadIntoLegacy(handle, `omv_tools_${tableId++}`, { lazy: true, overviewPoints: 400, format: 'csv' });
    return data;
}
// The same file as the in-memory path holds it.
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
// Every row of a lazy variable, read from the file.
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
function assertClose(actual, expected, tolerance, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (Number.isNaN(expected[i])) { assert.ok(Number.isNaN(actual[i]), `${label}: row ${i} should be NaN`); continue; }
        if (Math.abs(actual[i] - expected[i]) > tolerance) assert.fail(`${label}: row ${i} is ${actual[i]}, the kernel gives ${expected[i]}`);
    }
}

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.ok(lazy._duckdb.viewMode, 'the fixture loads as a view, the way a large file does');
assert.equal(eager.variables.t.data.length, ROWS, 'the in-memory copy has every row');
const h = app(lazy);
const eh = app(eager);

// ── Derivative ──────────────────────────────────────────────────────────────
for (const axis of ['numeric', 'index']) {
    // An index axis: the kernel counts samples, and so must the SQL.
    for (const data of [lazy, eager]) data.variables.t.timeStepMode = axis === 'index' ? 'index' : undefined;
    for (const method of ['centered', 'forward', 'backward', 'difference']) {
        for (const source of ['a', 'b']) {
            const name = `d_${source}_${method}_${axis}`;
            await create(h, source, name, { tool: 'derivative', params: { method } });
            const variable = lazy.variables[name];
            assert.ok(variable._duckdbExpr && variable._duckdbWindows?.length, `${name}: a window column over the file`);
            const expected = eh._computeDerivativeValues(eager.variables[source].data, eager, { method }).values;
            assertBitwise(await readAll(lazy, name), expected, name);
        }
    }
}
for (const data of [lazy, eager]) delete data.variables.t.timeStepMode;
console.log('lazy data tools: derivative matches the kernel bit for bit (4 methods, numeric and index axes, Δt = 0, overflow)');

{
    const stamped = await loadLazy('stamps.csv');
    const stampedEager = await eagerFrom(stamped);
    assert.equal(stamped.metadata.timeKind, 'datetime', 'the second fixture has a calendar axis');
    const sh = app(stamped);
    for (const method of ['centered', 'backward']) {
        await create(sh, 'a', `d_${method}`, { tool: 'derivative', params: { method } });
        const expected = app(stampedEager)._computeDerivativeValues(stampedEager.variables.a.data, stampedEager, { method }).values;
        assertBitwise(await readAll(stamped, `d_${method}`), expected, `calendar axis, ${method}`);
    }
    console.log('lazy data tools: on a calendar axis the derivative is per second, as in memory');
}

// A zoom reads the derivative from the file, and the window sees the rows
// around it: the first zoomed row is a centred difference, not a one-sided one.
{
    const expected = eh._computeDerivativeValues(eager.variables.a.data, eager, { method: 'centered' }).values;
    const t0 = cols.t[20000];
    const t1 = cols.t[20100];
    const raw = await duck.getRawColumnsRange(lazy, ['d_a_centered_numeric'], t0, t1, 1e6);
    const from = cols.t.findIndex(v => v >= t0);
    assert.ok(raw.x.length > 50, 'every row of the window');
    for (let i = 0; i < raw.x.length; i++) {
        assert.ok(same(raw.yByVar.get('d_a_centered_numeric')[i], expected[from + i]), `zoomed row ${from + i}`);
    }
    // The file is never sorted or held: the window streams.
    const plan = duck._arrowRowsToObjects(await duck.query(`EXPLAIN SELECT * FROM ${duck._fromSql(lazy, [lazy.variables.d_a_centered_numeric])}`))
        .map(row => Object.values(row).join('\n')).join('\n');
    assert.match(plan, /STREAMING_WINDOW/, 'the derivative is a streaming window');
    assert.doesNotMatch(plan.replace(/STREAMING_WINDOW/g, ''), /WINDOW|ORDER_BY/, 'with no materializing window and no sort');
    // A query that does not read it keeps the plain file, and its filter pushdown.
    assert.equal(duck._fromSql(lazy, [lazy.variables.a]), lazy._duckdb.tableName, 'queries without a window read the file as before');
    console.log('lazy data tools: a zoom into a derivative is exact, and the window streams');
}

// Chains: a derivative of a derivative, a derivative of a formula, a formula of
// a derivative. Each window sits one level above what it reads.
{
    const derive = (hh, data, name, formula) => {
        const result = hh._evaluateDerivedFormula(formula, data);
        data.variables[name] = hh._formulaDerivedVariable(name, formula, result);
        return data.variables[name];
    };
    await create(h, 'd_a_centered_numeric', 'dd', { tool: 'derivative', params: { method: 'centered' } });
    const first = eh._computeDerivativeValues(eager.variables.a.data, eager, { method: 'centered' }).values;
    const second = eh._computeDerivativeValues(first, eager, { method: 'centered' }).values;
    assert.ok(lazy.variables.dd._duckdbWindows.some(w => w.level >= 3), 'the second derivative is a window over the first');
    assertBitwise(await readAll(lazy, 'dd'), second, 'second derivative');

    const lazyMix = derive(h, lazy, 'mix', 'a * 2 - c');
    derive(eh, eager, 'mix', 'a * 2 - c');
    assert.ok(lazyMix._duckdbExpr, 'the formula is SQL');
    await create(h, 'mix', 'dmix', { tool: 'derivative', params: { method: 'forward' } });
    assertBitwise(await readAll(lazy, 'dmix'),
        eh._computeDerivativeValues(eager.variables.mix.data, eager, { method: 'forward' }).values, 'derivative of a formula');

    eager.variables.d_a_centered_numeric = { name: 'd_a_centered_numeric', kind: 'variable', data: first };
    const onTop = derive(h, lazy, 'scaled', 'd_a_centered_numeric * 3 + 1');
    derive(eh, eager, 'scaled', 'd_a_centered_numeric * 3 + 1');
    assert.ok(onTop._duckdbExpr && onTop._duckdbWindows?.length, 'a formula over a derivative carries its window');
    const expectedScaled = Float64Array.from(first, v => v * 3 + 1);
    assertBitwise(await readAll(lazy, 'scaled'), expectedScaled, 'formula over a derivative');
    console.log('lazy data tools: chains of derivatives and formulas are exact');
}

// ── IQR outliers ────────────────────────────────────────────────────────────
// `c` is 0…5: quartiles 1 and 4, so a factor of 1/3 puts the upper fence on 5
// exactly, where the kernel keeps the sample (strict comparison).
for (const [source, factor] of [['a', 1.5], ['c', 1.5], ['c', 1 / 3], ['b', 0.5], ['a', 3]]) {
    const name = `iqr_${source}_${Number(factor.toFixed(3))}`;
    const result = await create(h, source, name, { tool: 'removeOutliers', method: 'iqr', params: { factor }, replacement: 'nan' });
    const values = eager.variables[source].data;
    const indexes = eh._detectOutlierIndexes(values, 'iqr', { factor });
    assertBitwise(await readAll(lazy, name), eh._replaceOutliersWithNaN(values, indexes), name);
    assert.equal(result.count, indexes.length, `${name}: the count the panel reports`);
}
{
    // The order statistics themselves, with a bucket small enough that the
    // file is cut several times before any value is fetched.
    for (const source of ['a', 'b', 'c']) {
        const sorted = Float64Array.from(eager.variables[source].data.filter(Number.isFinite)).sort();
        const ranks = [0, 1, 17, Math.floor(sorted.length / 4), Math.floor(sorted.length / 2), sorted.length - 2, sorted.length - 1];
        const { n, values } = await duck.exactOrderStatistics(lazy, source, ranks, { bins: 8, fetchLimit: 50 });
        assert.equal(n, sorted.length, `${source}: the count of finite values`);
        for (const r of ranks) assert.ok(same(values.get(r), sorted[r]), `${source}: rank ${r}`);
    }
}
console.log('lazy data tools: IQR outliers match the kernel bit for bit (exact quartiles, ties, ±1e308)');

// ── Detrend ─────────────────────────────────────────────────────────────────
for (const axis of ['numeric', 'index']) {
    for (const data of [lazy, eager]) data.variables.t.timeStepMode = axis === 'index' ? 'index' : undefined;
    for (const params of [{ method: 'mean' }, { method: 'linear' }, { method: 'polynomial', order: 3 }]) {
        const name = `dt_${params.method}_${axis}`;
        const full = { ...params, order: params.order ?? 2, window: 101 };
        const result = await create(h, 'a', name, { tool: 'detrend', params: full });
        const expected = eh._computeDetrendValues(eager.variables.a.data, eager, full);
        const actual = await readAll(lazy, name);
        const scale = Math.max(...expected.values.filter(Number.isFinite).map(Math.abs));
        assertClose(actual, expected.values, scale * 1e-9, name);
        const stats = h.dataToolVariablesByFile.get('f').get(name).lazyStats;
        assert.equal(stats.order, expected.order, `${name}: the order fitted`);
        assert.equal(stats.fitPoints, expected.fitPoints, `${name}: the points fitted`);
        if (params.method === 'linear') {
            assert.ok(Math.abs(stats.slope - expected.slope) <= Math.abs(expected.slope) * 1e-9, `${name}: the slope the panel quotes`);
            assert.ok(result.warning, `${name}: and quotes it`);
        }
        // With the kernel's own fit, the subtraction is the kernel's to the bit.
        const report = computeDetrend(eager.variables.a.data, axis === 'index' ? null : { values: eager.variables.t.data, kind: 'numeric' }, full);
        const x = axis === 'index' ? '(ROW_NUMBER() OVER () - 1)::DOUBLE' : '"t"::DOUBLE';
        // The kernel scales over the samples it fits: finite value, finite abscissa.
        const fitted = [...eager.variables.a.data.keys()].filter(i => Number.isFinite(eager.variables.a.data[i]))
            .map(i => (axis === 'index' ? i : eager.variables.t.data[i]));
        const min = Math.min(...fitted);
        const max = Math.max(...fitted);
        const sql = lazySql.detrendPolynomialSql('try_cast("a" AS DOUBLE)', 'x',
            { mid: (min + max) / 2, half: (max - min) / 2 || 1, coefficients: report.coefficients });
        const exact = duck._extractColumnAsFloat64(await duck.query(
            `SELECT ${sql} AS v FROM (SELECT *, ${x} AS x FROM ${lazy._duckdb.tableName})`), 0, 'DOUBLE');
        assertBitwise(exact, report.values, `${name} with the kernel's coefficients`);
    }
}
for (const data of [lazy, eager]) delete data.variables.t.timeStepMode;
{
    await create(h, 'a', 'dt_first', { tool: 'detrend', params: { method: 'firstSample', order: 2, window: 101 } });
    const expected = eh._computeDetrendValues(eager.variables.a.data, eager, { method: 'firstSample', order: 2, window: 101 });
    assertBitwise(await readAll(lazy, 'dt_first'), expected.values, 'first-sample detrend');
}
console.log('lazy data tools: detrend matches the kernel (to rounding in the fit, bit for bit in the subtraction)');

// ── Restored from a session, and edited upstream ───────────────────────────
{
    // A session stores the definition, not the statistics: the tool comes back
    // at once and its statistics are recomputed in the background.
    const restored = await loadLazy();
    const rh = app(restored);
    const definitions = new Map([
        ['d1', { name: 'd1', tool: 'derivative', targetMode: 'create', sourceName: 'a', method: 'centered', params: { method: 'centered' }, replacement: '' }],
        ['q1', { name: 'q1', tool: 'removeOutliers', targetMode: 'create', sourceName: 'a', method: 'iqr', params: { factor: 1.5 }, replacement: 'nan' }],
        ['lin', { name: 'lin', tool: 'detrend', targetMode: 'create', sourceName: 'd1', method: 'linear', params: { method: 'linear', order: 2, window: 101 }, replacement: '' }],
    ]);
    rh.dataToolVariablesByFile.set('f', definitions);
    rh._reapplyDataToolVariables('f', restored);
    assert.ok(restored.variables.d1._duckdbExpr, 'a derivative needs no statistics and is back at once');
    await Promise.all([...(rh._lazyToolStatsPending || [])]);
    assertBitwise(await readAll(restored, 'q1'), await readAll(lazy, 'iqr_a_1.5'), 'an IQR filter restored from a session');
    const firstDerivative = eh._computeDerivativeValues(eager.variables.a.data, eager, { method: 'centered' }).values;
    const expectedLin = eh._computeDetrendValues(firstDerivative, eager, { method: 'linear', order: 2, window: 101 }).values;
    const scale = Math.max(...expectedLin.filter(Number.isFinite).map(Math.abs));
    assertClose(await readAll(restored, 'lin'), expectedLin, scale * 1e-9, 'a detrend of a derivative, restored');

    // Editing the derivative upstream refits the detrend built on it.
    await create(rh, 'a', 'd1', { tool: 'derivative', params: { method: 'backward' } });
    await Promise.all([...(rh._lazyToolStatsPending || [])]);
    const backward = eh._computeDerivativeValues(eager.variables.a.data, eager, { method: 'backward' }).values;
    const refit = eh._computeDetrendValues(backward, eager, { method: 'linear', order: 2, window: 101 }).values;
    assertClose(await readAll(restored, 'lin'), refit, scale * 1e-9, 'the detrend follows its edited source');
    console.log('lazy data tools: restored from a session and refreshed after an upstream edit');
}

// ── Cumulative integral ─────────────────────────────────────────────────────
// Bit for bit: the running sum adds the kernel's increments in row order. The
// counts the panel reports (negative steps, gaps, holes) must match too, and
// the gap threshold is the kernel's own (an exact median).
{
    const checkIntegral = async (label, lazyData, eagerData, source, params) => {
        const lh = app(lazyData);
        const name = `int_${source}_${Object.values(params).join('_')}`.replace(/\W/g, '_');
        delete lazyData.variables[name];  // the same settings again, on another axis
        const result = await create(lh, source, name, { tool: 'integrate', params });
        const expected = app(eagerData)._computeIntegralValues(eagerData.variables[source].data, eagerData, params);
        assertBitwise(await readAll(lazyData, name), expected.values, `${label} ${name}`);
        const stats = lh.dataToolVariablesByFile.get('f').get(name).lazyStats;
        for (const key of ['negativeDtCount', 'gapCount', 'nanSegmentCount', 'hasNominalStep', 'timeKind']) {
            assert.equal(stats[key], expected[key], `${label} ${name}: ${key}`);
        }
        assert.ok(Math.abs(stats.uncoveredTime - expected.uncoveredTime) <= Math.abs(expected.uncoveredTime) * 1e-9,
            `${label} ${name}: uncovered time ${stats.uncoveredTime} vs ${expected.uncoveredTime}`);
        const warning = app(eagerData)._integralWarning(expected, params);
        assert.equal(typeof result.warning === 'function' ? result.warning() : result.warning, warning, `${label} ${name}: the warning the panel shows`);
        return stats;
    };
    for (const handle of ['grid.csv', 'gridstamps.csv']) {
        const gridLazy = await loadLazy(handle);
        const gridEager = await eagerFrom(gridLazy);
        const kind = gridLazy.metadata.timeKind;
        for (const method of ['trapezoidal', 'rectangular', 'sum']) {
            for (const gapPolicy of ['zero', 'propagate']) {
                for (const initial of [0, 2.5]) {
                    await checkIntegral(`${kind} axis`, gridLazy, gridEager, 'g', { method, gapPolicy, initial });
                }
            }
            await checkIntegral(`${kind} axis`, gridLazy, gridEager, 'h', { method, gapPolicy: 'propagate', initial: 0 });
        }
        // The gap threshold is the kernel's: 1.5 × the exact median step.
        const stats = await checkIntegral(`${kind} axis`, gridLazy, gridEager, 'h', { method: 'trapezoidal', gapPolicy: 'zero', initial: -1 });
        const kernelGaps = detectSamplingGaps(gridEager.variables[gridEager.metadata.timeName].data);
        assert.ok(kernelGaps.hasNominalStep && kernelGaps.count > 0, `${kind} axis: the fixture has a nominal step and gaps`);
        assert.equal(stats.gapThreshold, kernelGaps.medianDt * 1.5, `${kind} axis: the gap threshold`);
        assert.equal(stats.gapCount, kernelGaps.count, `${kind} axis: every gap found`);
        // An index axis counts samples: every step is 1, no gap can be seen.
        for (const data of [gridLazy, gridEager]) data.variables[data.metadata.timeName].timeStepMode = 'index';
        await checkIntegral('index axis', gridLazy, gridEager, 'g', { method: 'trapezoidal', gapPolicy: 'zero', initial: 0 });
    }
    {
        const even = await loadLazy('evensteps.csv');
        const evenEager = await eagerFrom(even);
        const stats = await checkIntegral('even step count', even, evenEager, 'v', { method: 'trapezoidal', gapPolicy: 'zero', initial: 0 });
        const kernelGaps = detectSamplingGaps(evenEager.variables.t.data);
        assert.equal(stats.gapThreshold, kernelGaps.medianDt * 1.5, 'the median of an even count is the mean of the middle two');
        assert.equal(stats.gapCount, 1, 'and the long step is the one gap');
    }
    // An irregular axis (the first fixture) has no nominal step: nothing is a gap.
    const irregular = await checkIntegral('irregular axis', lazy, eager, 'a', { method: 'trapezoidal', gapPolicy: 'zero', initial: 0 });
    assert.equal(irregular.hasNominalStep, false, 'an irregular axis has no nominal step');
    assert.equal(h._isLazySqlToolConfig({ tool: 'integrate', params: { gapPolicy: 'interpolate' } }), false,
        'bridging a hole needs the next finite sample: not on a lazy file yet');
    console.log('lazy data tools: the integral matches the kernel bit for bit (3 methods, zero and propagate, gaps, holes, 3 axes)');
}

// ── Time-axis index and step ────────────────────────────────────────────────
// SQL over the file, not the overview's samples; the overview itself is read
// back from the file once they exist.
{
    for (const handle of ['grid.csv', 'gridstamps.csv']) {
        const gridLazy = await loadLazy(handle);
        const gridEager = await eagerFrom(gridLazy);
        const gh = app(gridLazy);
        const eagerTime = gridEager.variables[gridEager.metadata.timeName];
        for (const kind of ['index', 'delta']) {
            const variable = gh._createOrUpdateTimeAxisVariable('f', kind);
            assert.ok(variable._duckdbExpr && variable._duckdbWindows?.length, `${handle} ${kind}: SQL over the file`);
            assertBitwise(await readAll(gridLazy, variable.name), app(gridEager)._timeAxisVariableValues(kind, eagerTime), `${handle} ${kind}`);
            await gh._lazyOverviewRefreshes?.get('f')?.promise;
            // The overview holds the file's values (a min/max per bucket), not a
            // computation over the overview's own samples — which for a step
            // would difference samples hundreds of rows apart.
            const expected = app(gridEager)._timeAxisVariableValues(kind, eagerTime);
            const exact = new Set(expected);
            const shown = gridLazy.variables[variable.name].data;
            assert.ok(shown.length > 100, `${handle} ${kind}: an overview`);
            for (let k = 0; k < shown.length; k++) assert.ok(exact.has(shown[k]), `${handle} ${kind}: overview sample ${k} is ${shown[k]}`);
            if (kind === 'index') assert.equal(Math.max(...shown), expected.length - 1, `${handle}: the index reaches the file's last row`);
        }
    }
    // A generated axis is the row number, itself a window.
    const generated = duck.timeSqlWithWindows({ _duckdb: { generatedTime: true } });
    assert.equal(generated.windows.length, 1, 'a generated time axis is a row-number window');
    console.log('lazy data tools: time-axis index and step are exact on a lazy file, overview included');
}

// ── A formula reading neighbours shows the file's values, not the overview's ─
{
    const gridLazy = await loadLazy('grid.csv');
    const gridEager = await eagerFrom(gridLazy);
    const gh = app(gridLazy);
    const result = gh._evaluateDerivedFormula('diff(h) * 100', gridLazy);
    const variable = gh._formulaDerivedVariable('dh', 'diff(h) * 100', result);
    assert.ok(Array.from(variable.data).every(Number.isNaN), 'no overview values until the file is read: diff over overview samples would be wrong');
    gridLazy.variables.dh = variable;
    gh.derivedByFile.set('f', new Map([['dh', { name: 'dh', formula: 'diff(h) * 100', variable }]]));
    gh._reapplyDerivedVariables('f', gridLazy);
    await gh._lazyOverviewRefreshes?.get('f')?.promise;
    const exact = new Set(app(gridEager)._evaluateDerivedFormula('diff(h) * 100', gridEager).values);
    const shown = gridLazy.variables.dh.data;
    assert.ok(shown.length > 100 && shown.every(Number.isFinite), 'the overview is filled in');
    for (let k = 0; k < shown.length; k++) assert.ok(exact.has(shown[k]), `overview sample ${k} of diff(h) is ${shown[k]}`);
    console.log('lazy data tools: a diff() formula\'s overview is read from the file');
}

// ── What stays unavailable says so ──────────────────────────────────────────
{
    assert.equal(h._isDataToolAvailableForData('movingAverage', lazy), false, 'the moving average waits for the chunked executor');
    assert.equal(h._isDataToolAvailableForData('derivative', lazy), true, 'the derivative is available');
    assert.equal(h._isDataToolAvailableForData('integrate', lazy), true, 'the integral is available');
    assert.equal(h._isLazySqlToolConfig({ tool: 'detrend', params: { method: 'movingAverage' } }), false,
        'so does the moving-average baseline of a detrend');
    assert.equal(h._isLazySqlToolConfig({ tool: 'removeOutliers', method: 'spike' }), false, 'and the spike detector');
}
console.log('lazy data tools: derivative, integral, IQR and detrend run over every row of a lazy file');
