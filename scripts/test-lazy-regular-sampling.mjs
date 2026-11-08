// "Complete missing timestamps" on a lazy file: whether every step of the
// time axis is a whole multiple of the usual one is judged over the whole
// file, and the verdict is the in-memory one.
//
//   node scripts/test-lazy-regular-sampling.mjs
//
// detectRegularSampling (src/compute/kernels/regrid.js) over the axis as an
// array, against _lazyRegularSampling over the same file read lazily through
// the app's DuckDbSource on a real DuckDB-WASM engine: regular, with gaps,
// with repeated stamps, jittered within the tolerance and past it, going
// back, a stamp that is not a number before and after one going back, too
// few rows, an even number of steps (the median between two), a calendar
// axis in milliseconds. And the panel offers the mode on a lazy file once the
// verdict is in, saying meanwhile that it is measuring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { detectRegularSampling } = await import(new URL('../src/compute/kernels/regrid.js', import.meta.url));
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installLazyDatasetMethods } = await import(new URL('../src/app/methods/lazy-dataset-methods.js', import.meta.url));
const { installResampleMethods } = await import(new URL('../src/app/methods/resample-methods.js', import.meta.url));

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
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

class App {
    constructor() {
        this.files = new Map();
        this.dataToolVariablesByFile = new Map();
        this.plotManager = { files: this.files };
    }
}
installDataToolsMethods(App);
installLazyDataToolsMethods(App);
installLazyDatasetMethods(App);
installResampleMethods(App);
App.prototype._syncDataTools = function() { this.synced = (this.synced || 0) + 1; };

let id = 0;
// A CSV whose time column holds `stamps` as written (numbers, or ISO dates).
async function load(stamps) {
    const lines = ['t,a', ...stamps.map((s, i) => `${s},${i % 7}`)];
    const handle = `reg_${id}.csv`;
    db.registerFileText(handle, `${lines.join('\n')}\n`);
    return duck._loadIntoLegacy(handle, `omv_reg_${id++}`, { lazy: true, overviewPoints: 50, format: 'csv' });
}
async function axisOf(data) {
    const out = [];
    for await (const chunk of duck.streamColumns(data, ['a'])) for (const v of chunk.x) out.push(v);
    return Float64Array.from(out);
}

const n = 5000;
const range = (count, f) => Array.from({ length: count }, (_, i) => f(i));
const cases = [
    ['regular', range(n, i => (i * 0.25).toFixed(2))],
    ['gaps', range(n, i => i * 2 + (i > 1000 ? 6 : 0) + (i > 3000 ? 10 : 0))],
    ['repeated stamps', range(n, i => (i % 97 === 50 ? i - 1 : i))],
    ['gaps and repeats', range(n, i => (i % 211 === 3 ? i - 1 : i) + (i > 4000 ? 3 : 0))],
    ['jitter within the tolerance', range(n, i => (i + (i % 3 === 0 ? 4e-4 : 0)).toFixed(6))],
    ['jitter past it', range(n, i => (i + (i === 2500 ? 0.3 : 0)).toFixed(3))],
    ['going back', range(n, i => (i === 3000 ? 2990 : i))],
    ['not a number, then going back', range(n, i => (i === 100 ? 'inf' : (i === 3000 ? 2990 : i)))],
    ['going back, then not a number', range(n, i => (i === 3000 ? 'inf' : (i === 100 ? 90 : i)))],
    ['too few rows', [0, 1]],
    ['three rows', [0, 1, 3]],
    ['an even number of steps', range(6, i => [0, 1, 3, 5, 8, 9][i])],
    ['one step only, the rest repeated', [0, 0, 0, 1]],
    ['a calendar axis', range(n, i => new Date(Date.UTC(2024, 0, 1) + i * 60000 + (i > 2000 ? 300000 : 0)).toISOString())],
];
const app = new App();
let checked = 0;
for (const [label, stamps] of cases) {
    const data = await load(stamps);
    const axis = await axisOf(data);
    const want = detectRegularSampling(axis);
    const got = await app._lazyRegularSampling(data);
    for (const key of ['ok', 'reason', 'gaps', 'missing', 'repeats']) {
        assert.ok(Object.is(got[key], want[key]), `${label}: ${key} is ${got[key]}, in memory ${want[key]}`);
    }
    assert.ok(Object.is(got.step, want.step) || (Number.isNaN(got.step) && Number.isNaN(want.step)), `${label}: step ${got.step}, in memory ${want.step}`);
    checked++;
    await duck.release(data);
}
console.log(`lazy regular sampling: ${checked} axes judged over the file as detectRegularSampling judges the array (verdict, step, gaps, missing, repeats)`);

// ── The panel: measuring, then the verdict ──────────────────────────────────
{
    const data = await load(cases[1][1]);
    app.files.set('f', { data });
    const first = app._resampleRegularSampling(data);
    assert.deepEqual([first.ok, first.reason], [false, 'measuring'], 'measuring first');
    await Promise.all([...(app._lazyAxisStepRuns?.values() || [])]);
    const after = app._resampleRegularSampling(data);
    assert.equal(after.ok, true, 'then the verdict over the file');
    assert.ok(app.synced >= 1, 'and the panel synced again');
    await duck.release(data);
    const panel = readFileSync(new URL('../src/app/methods/resample-methods.js', import.meta.url), 'utf8');
    assert.doesNotMatch(panel, /dataToolResampleCompleteLazy/, 'no "not offered for lazy files" left');
    console.log('lazy regular sampling: the panel says it is measuring, then offers the mode from the verdict over the file');
}
console.log('test-lazy-regular-sampling: OK');
