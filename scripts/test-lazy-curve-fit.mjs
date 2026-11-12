// A curve fit of a lazy file uses every row in its range, past any row cap,
// and gives the in-memory fit bit for bit.
//
//   node scripts/test-lazy-curve-fit.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as
// the arrays the in-memory path holds. Checked, with Object.is on every
// number:
//
//   · the chunked row pass (_lazyFitPass) reads the rows the one-piece fetch
//     (_fetchLazyFitRows) reads, transformed and cut alike;
//   · every model of the time-series fit, streamed pass by pass in small
//     chunks (_curveFitStreamed), equals the fit of the fetched rows and the
//     in-memory fit: coefficients, metrics, n, the drawn curve, the decimated
//     residuals, the rows in range;
//   · the 2D pair fit of every model, streamed (_streamLazyFit), equals the
//     in-memory fitPair;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//     over the whole file and a selection; on a generated (row number) axis;
//   · past the exponential kernel's subset size the polish really streams
//     (more passes than a linear fit makes) — and with the rows kept after
//     the second pass, it does not;
//   · cancel stops a streamed fit;
//   · both analyses stream instead of refusing when the rows pass the cap.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { installPlotFitLazyMethods, FIT_MAX_LAZY_ROWS, FIT_KEEP_LAZY_ROWS } = await import(new URL('../src/plots/methods/fit-lazy-methods.js', import.meta.url));
const { fitPair, fitSteps } = await import(new URL('../src/utils/regression.js', import.meta.url));
const { runPassesOnChunks } = await import(new URL('../src/utils/fit-passes.js', import.meta.url));
const { rangeIndices } = await import(new URL('../src/plots/curve-fit-state.js', import.meta.url));

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// PlotManager imports Plotly, so the few of its methods the data methods call
// are sliced out of it (as scripts/test-lazy-histogram.mjs does).
const managerSource = read('src/plots/plot-manager.js');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const managerMethods = {};
vm.runInNewContext(['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_extractUnit', '_traceName'].map(sliceMethod).join('\n'), { proto: managerMethods, console });

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
    }
}
installPlotDataMethods(Harness);
installPlotFitLazyMethods(Harness);
Object.assign(Harness.prototype, managerMethods);

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 41;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// Past the exponential kernel's subset size (20 000 rows), so its polish runs
// as passes over the stream.
const ROWS = 60013;
// a: a first-order step response with noise and holes; b: a decay to an
// offset, with an `inf`; c: positive, for the power model.
const lines = ['t,a,b,c'];
for (let i = 0; i < ROWS; i++) {
    const t = i * 0.01;
    const a = 2 + 5 * (1 - Math.exp(-t / 90)) + (random() - 0.5) * 0.05;
    const b = 1 + 8 * Math.exp(-t / 140) + (random() - 0.5) * 0.02;
    const c = 0.5 + 3 * Math.pow(t + 1, 0.7) + random() * 0.01;
    const aText = i % 173 === 9 ? '' : String(Math.round(a * 1e6) / 1e6);
    const bText = i === 31337 ? 'inf' : String(Math.round(b * 1e6) / 1e6);
    lines.push(`${t.toFixed(2)},${aText},${bText},${Math.round(c * 1e6) / 1e6}`);
}
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['t', 'a', 'b', 'c'],
    headers: [{ name: 't' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2, 3],
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
db.registerFileText('fit.csv', lines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (csvProfile = null) =>
    duck._loadIntoLegacy('fit.csv', `omv_fit_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName && lazy._duckdb.source.hasSqlValue(lazy.variables[name]));
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
    data.metadata.numTimesteps = data.variables[lazy.metadata.timeName].data.length;
    return data;
}
function harness(data, transform = {}, inverted = []) {
    const h = new Harness();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}

// Every number compared with Object.is (NaN equals NaN, 0 ≠ −0); arrays,
// typed arrays and objects key by key.
function assertSame(got, want, label) {
    if (typeof want === 'number' || typeof got === 'number') {
        assert.ok(Object.is(got, want), `${label}: ${got}, in memory ${want}`);
        return;
    }
    if (want && typeof want === 'object') {
        assert.ok(got && typeof got === 'object', `${label}: missing`);
        const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
        for (const key of keys) assertSame(got[key], want[key], `${label}.${key}`);
        return;
    }
    assert.equal(got, want, label);
}

const MODELS = ['linear', 'quadratic', 'power', 'exponential', 'exponential-offset', 'first-order', 'first-order-offset'];
// The signal each model is tried on: a has holes, b an `inf`, c is positive.
const SIGNAL_FOR = {
    linear: 'a', quadratic: 'b', power: 'c', exponential: 'b',
    'exponential-offset': 'b', 'first-order': 'a', 'first-order-offset': 'a',
};
const CHUNK = 7001;
const TRANSFORMS = [
    { name: 'no transform', transform: {}, inverted: [] },
    { name: 'every transform', transform: { gain: 2.5, yOffset: -1.25, timeShift: '3.5', cropStart: '12.3', cropEnd: '540.77' }, inverted: ['b'] },
];

// The in-memory time-series fit: the rows _curveFitEagerRows takes, through
// _curveFitFromRows.
function eagerCurveFit(h, trace, range, model, info) {
    const times = h._getTransformedTimeDataForVariable('f', trace.varName);
    const values = h._getTransformedVariableData('f', trace.varName);
    const [start, end] = rangeIndices(times, range[0], range[1]);
    return h._curveFitFromRows(null, { model }, trace, range, info, times.slice(start, end), values.slice(start, end));
}
// The in-memory 2D fit of a pair over a range.
function eagerPairFit(h, pair, range, model) {
    const times = h._getTransformedTimeDataForVariable('f', pair.x);
    const xs = h._getTransformedVariableData('f', pair.x);
    const ys = h._getTransformedVariableData('f', pair.y);
    const [start, end] = rangeIndices(times, range[0], range[1]);
    return { fit: fitPair(model, xs.slice(start, end), ys.slice(start, end)), nScope: end - start };
}
function domainOf(h, varName) {
    const times = h._getTransformedTimeDataForVariable('f', varName);
    let lo = Infinity, hi = -Infinity;
    for (const t of times) { if (t < lo) lo = t; if (t > hi) hi = t; }
    return [lo, hi];
}

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.ok(lazy.variables.a.data.length < ROWS / 10, 'what is in memory is an overview');
assert.equal(eager.variables.a.data.length, ROWS, 'the in-memory copy has every row');
const info = { scale: 1, unit: 's', calendar: false };

for (const { name, transform, inverted } of TRANSFORMS) {
    const hl = harness(lazy, transform, inverted);
    const he = harness(eager, transform, inverted);
    const domain = domainOf(he, 'a');
    const selection = [domain[0] + (domain[1] - domain[0]) * 0.17, domain[0] + (domain[1] - domain[0]) * 0.83];

    // The whole file plain, a selection with every transform: each path of
    // the range cut and of the transforms is crossed once.
    const ranges = transform.gain ? [['selection', selection]] : [['whole file', domain]];
    for (const [rangeName, range] of ranges) {
        // ── Rows: the chunked pass reads what the fetch reads ──
        const fetched = await hl._fetchLazyFitRows('f', ['a', 'b'], range);
        assert.ok(fetched.ok, `${name}, ${rangeName}: the fetch holds the rows`);
        const streamedTime = [];
        const streamedA = [];
        const streamedB = [];
        let chunks = 0;
        await hl._lazyFitPass('f', ['a', 'b'], range, (time, byVar) => {
            chunks++;
            streamedTime.push(...time);
            streamedA.push(...byVar.get('a'));
            streamedB.push(...byVar.get('b'));
        }, { chunkRows: CHUNK });
        assert.ok(chunks > 3, `${name}, ${rangeName}: read in ${chunks} chunks`);
        assertSame(streamedTime, Array.from(fetched.time), `${name}, ${rangeName}: time`);
        assertSame(streamedA, Array.from(fetched.valuesByVar.get('a')), `${name}, ${rangeName}: a`);
        assertSame(streamedB, Array.from(fetched.valuesByVar.get('b')), `${name}, ${rangeName}: b`);

        for (const model of MODELS) {
            for (const varName of [SIGNAL_FOR[model]]) {
                const trace = { fileId: 'f', varName };
                const want = eagerCurveFit(he, trace, range, model, info);
                const rows = await hl._fetchLazyFitRows('f', [varName], range);
                const viaFetch = hl._curveFitFromRows(null, { model }, trace, range, info, rows.time, rows.valuesByVar.get(varName));
                // Streamed twice: rows kept after the second pass (the
                // default at this size), and read again for every pass.
                const streamed = await hl._curveFitStreamed(null, { trace, range, info, entry: { model } }, { chunkRows: CHUNK });
                const reread = await hl._curveFitStreamed(null, { trace, range, info, entry: { model } }, { chunkRows: CHUNK, keepRows: 0 });
                const label = `${name}, ${rangeName}, ${model} of ${varName}`;
                assertSame(viaFetch, want, `${label} (fetched)`);
                assertSame(streamed, want, `${label} (streamed, rows kept)`);
                assertSame(reread, want, `${label} (streamed, every pass a read)`);
            }
            const pair = { x: 'c', y: 'b' };
            const want = eagerPairFit(he, pair, range, model);
            const streamed = await hl._streamLazyFit('f', [pair.x, pair.y], range, model,
                (time, byVar) => [byVar.get(pair.x), byVar.get(pair.y)], { chunkRows: CHUNK });
            assertSame(streamed, want, `${name}, ${rangeName}, 2D ${model} of c → b`);
        }
    }
}

// ── The fits really are good ones, so the comparison above means something ──
{
    const h = harness(eager);
    const fit = eagerCurveFit(h, { fileId: 'f', varName: 'a' }, domainOf(h, 'a'), 'first-order-offset', info).fit;
    assert.equal(fit.status, 'ok');
    assert.ok(Math.abs(fit.K - 5) < 0.05 && Math.abs(fit.alpha + 1 / 90) < 1e-3, `first-order recovered (K ${fit.K}, α ${fit.alpha})`);
    assert.ok(fit.n > 20000 && fit.nExcluded > 0, 'over the rows, holes left out');
}

// ── Past the subset size the exponential polish streams pass after pass ──
{
    const h = harness(lazy);
    const range = domainOf(harness(eager), 'a');
    const passesOf = async (model) => {
        let passes = 0;
        await runPassesOnChunks(fitSteps(model), async (pass) => {
            passes++;
            await h._lazyFitPass('f', ['a'], range, (time, byVar) => pass.chunk(time, byVar.get('a')));
        });
        return passes;
    };
    assert.equal(await passesOf('linear'), 1, 'a linear fit is one pass');
    assert.equal(await passesOf('quadratic'), 2, 'a quadratic two');
    const expPasses = await passesOf('first-order-offset');
    assert.ok(expPasses >= 6, `an exponential polishes on every row (${expPasses} passes)`);
    let keptPasses = 0;
    await h._streamLazyFit('f', ['a'], range, 'first-order-offset', (time, byVar) => [time, byVar.get('a')], {
        onProgress: (pass) => { keptPasses = Math.max(keptPasses, pass); },
    });
    assert.equal(keptPasses, 2, 'with the rows kept after its second pass, it reads them twice');
}

// ── A generated axis (row numbers) ──
{
    const lazyIndex = await loadLazy(generatedProfile);
    const eagerIndex = await eagerFrom(lazyIndex);
    const hl = harness(lazyIndex, { gain: -1 });
    const he = harness(eagerIndex, { gain: -1 });
    const domain = domainOf(he, 'a');
    const range = [domain[0] + 1234, domain[1] - 777];
    for (const model of ['linear', 'exponential-offset', 'first-order-offset']) {
        const trace = { fileId: 'f', varName: 'a' };
        const want = eagerCurveFit(he, trace, range, model, info);
        const streamed = await hl._curveFitStreamed(null, { trace, range, info, entry: { model } }, { chunkRows: CHUNK });
        assertSame(streamed, want, `generated axis, ${model}`);
        assert.equal(streamed.nScope, range[1] - range[0] + 1 - (Number.isInteger(range[0]) ? 0 : 1), 'every row number in range');
    }
}

// ── Cancel ──
{
    const h = harness(lazy);
    const range = domainOf(harness(eager), 'a');
    const controller = new AbortController();
    let seen = 0;
    await assert.rejects(
        h._streamLazyFit('f', ['a'], range, 'first-order-offset', (time, byVar) => [time, byVar.get('a')], {
            signal: controller.signal,
            chunkRows: CHUNK,
            onProgress: () => { if (++seen === 2) controller.abort(); },
        }),
        error => error?.name === 'AbortError',
        'an aborted fit stops with an AbortError',
    );
}

// ── Wiring: past the cap, both analyses stream ──
{
    assert.ok(FIT_MAX_LAZY_ROWS >= 1000000, 'the one-piece fetch keeps its size');
    assert.ok(FIT_KEEP_LAZY_ROWS > FIT_MAX_LAZY_ROWS, 'and a streamed fit keeps rows beyond it');
    const curve = read('src/plots/methods/curve-fit-methods.js');
    assert.match(curve, /rows\.reason === 'tooManyRows'\) \{\s+const result = await this\._curveFitStreamed\(/, 'the time-series fit streams past the cap');
    assert.match(curve, /if \(wanted\.get\(id\) === job\.key\) continue;\s+job\.controller\?\.abort\(\);/, 'a job asked for again runs on; one no longer wanted is stopped');
    const phase2d = read('src/plots/methods/phase2d-fit-methods.js');
    assert.match(phase2d, /const streamed = await this\._streamLazyFit\(/, 'the 2D fit streams past the cap');
    assert.match(phase2d, /if \(wanted && plot\._phase2dLazyJob\?\.wanted === wanted\) return;\s+plot\._phase2dLazyJob\?\.controller\?\.abort\(\);/, 'the same fits asked again run on; others replace them');
    assert.match(phase2d, /_fftDataToken\?\.\(pair\.fileId\)/, 'a 2D lazy fit is cached under its data, and not fitted again while it holds');
    assert.doesNotMatch(curve + phase2d, /too-many-rows|fitTooManyRows/, 'no fit is refused for its size any more');
    assert.match(curve, /_cleanupCurveFitDocListeners[\s\S]{0,600}this\._stopLazyFits\?\.\(plot\)/, 'closing the time-series fit stops its streams');
    assert.match(phase2d, /_cleanupPhase2dFitDocListeners\(plot\);\s+this\._stopLazyFits\?\.\(plot\);/, 'and closing the 2D fit');
    const translations = read('src/i18n/translations.js');
    assert.equal((translations.match(/fitLazyStreaming:/g) || []).length, 5, 'the progress line in every language');
    assert.equal((translations.match(/fitLazyResiduals:/g) || []).length, 5);
    const manager = read('src/plots/plot-manager.js');
    assert.match(manager, /installPlotFitLazyMethods\(PlotManager\);/, 'installed on the plot manager');
}

console.log('lazy curve fit: every row, the in-memory fit bit for bit');
