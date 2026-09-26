// Exporting a lazy file writes every row of the file, not the overview.
//
//   node scripts/test-lazy-csv-export.mjs
//
// The same CSV is loaded twice — lazily, through the app's DuckDBSource on a
// real DuckDB-WASM engine (the Node build of the package the app ships), and
// eagerly, as the arrays the in-memory path holds — and exported from both.
// The two files must be byte for byte the same, with a crop, a time shift, a
// gain, an offset and an inverted sign all switched on: the lazy path claims
// parity by construction, and this is where that claim is checked.
//
// PlotManager imports Plotly, so its export methods are sliced out of the
// source and run against a harness carrying the real data methods — the
// technique test-csv-export-time-columns.mjs uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { csvTextCell } = await import(new URL('../src/utils/csv-cell.js', import.meta.url));

// ── The PlotManager methods under test, and the ones they call ──────────────
// Flattened where it is read, so the slicing below holds on a CRLF checkout.
const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(source);
    assert.ok(match, `${name} is present`);
    // The opening brace is the second-to-last character matched.
    const braceAt = match.index + match[0].length - 2;
    const end = source.indexOf('\n    }\n', braceAt);
    const body = source.slice(braceAt, end + '\n    }'.length);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${body};`;
}
const methods = [
    '_writeCsvFile', '_writeCsvChunks', '_lazyTimeseriesCsvPlan', '_exportLazyTimeseriesCsv',
    '_appendTimeseriesExportColumns', '_getTimeVar', '_traceName', '_extractUnit',
    'isVariableSignInverted', '_timeShiftForMode',
];
const proto = {};
let downloads = [];
const alerts = [];
vm.runInNewContext(methods.map(sliceMethod).join('\n'), {
    proto,
    console,
    streamColumns,
    csvTextCell,
    i18n: { t: key => key, formatNumber: value => String(value) },
    Modal: { alert: async (...args) => { alerts.push(args); } },
    Blob: class {
        constructor(parts) { this.text = Array.from(parts, part => (typeof part === 'string' ? part : part.text)).join(''); this.last = this; }
    },
    URL: { createObjectURL: blob => { downloads.push(blob.text); return 'blob:x'; }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() {} }) },
});

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        this.onBusyOverlay = () => ({ progress() {}, close() {} });
    }
    _yieldToPaint() { return Promise.resolve(); }
}
installPlotDataMethods(Harness);
Object.assign(Harness.prototype, proto);

// ── The fixture ─────────────────────────────────────────────────────────────
const ROWS = 60001;
const lines = ['t,speed,torque'];
const t = new Float64Array(ROWS);
const speed = new Float64Array(ROWS);
const torque = new Float64Array(ROWS);
for (let i = 0; i < ROWS; i++) {
    t[i] = i / 50;
    speed[i] = Math.round(Math.cos(i / 40) * 1e5) / 1e5;
    torque[i] = i % 11 === 0 ? NaN : (i % 997) / 8;
    lines.push(`${t[i]},${speed[i]},${Number.isNaN(torque[i]) ? '' : torque[i]}`);
}
const csv = lines.join('\n') + '\n';

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
db.registerFileText('drive.csv', csv);
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

async function loadLazy() {
    return duck._loadIntoLegacy('drive.csv', `omv_export_${Math.random().toString(36).slice(2)}`, { lazy: true, overviewPoints: 500, format: 'csv' });
}
function eagerFrom(lazy) {
    // The same file as the in-memory path holds it: the lazy loader's own
    // metadata and variable descriptions, with the full arrays instead of the
    // overview.
    const data = structuredClone({ metadata: lazy.metadata, variables: Object.fromEntries(
        Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])) });
    const timeName = data.metadata.timeName;
    data.variables[timeName].data = t;
    data.variables.speed.data = speed;
    data.variables.torque.data = torque;
    data.metadata.numTimesteps = ROWS;
    return data;
}
function harnessWith(data, transform = {}, inverted = []) {
    const h = new Harness();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}
async function exportPanel(h) {
    downloads = [];
    const plot = { mode: 'timeseries', traces: [{ fileId: 'f', varName: 'speed' }, { fileId: 'f', varName: 'torque' }] };
    const plan = h._lazyTimeseriesCsvPlan(plot);
    if (plan?.exact) {
        await h._exportLazyTimeseriesCsv(plot, plan, 'out.csv');
    } else {
        const headers = [];
        const columns = [];
        h._appendTimeseriesExportColumns(plot, headers, columns);
        await h._writeCsvFile(headers, columns, 'out.csv');
    }
    assert.equal(downloads.length, 1, 'one file is written');
    return downloads[0];
}

// ── Exact: every row, the same bytes as the in-memory export ────────────────
{
    const lazy = await loadLazy();
    assert.ok(lazy._duckdb?.viewMode, 'the fixture loads as a view, the way a large file does');
    assert.ok(lazy.variables.speed.data.length < ROWS, 'what is in memory is an overview, not the file');
    const plan = harnessWith(lazy)._lazyTimeseriesCsvPlan({ traces: [{ fileId: 'f', varName: 'speed' }] });
    assert.equal(plan.exact, true, 'a lazy file\'s own columns export exactly');

    const lazyCsv = await exportPanel(harnessWith(lazy));
    const eagerCsv = await exportPanel(harnessWith(eagerFrom(lazy)));
    assert.equal(lazyCsv.split('\n').length, ROWS + 1, 'every row of the file is written, plus the header');
    assert.equal(lazyCsv, eagerCsv, 'and the file is the one the in-memory path writes');
}

// ── With every transform switched on ────────────────────────────────────────
{
    const transform = { gain: 2.5, yOffset: -3, timeShift: 7, cropStart: 100, cropEnd: 900 };
    const lazy = await loadLazy();
    const lazyCsv = await exportPanel(harnessWith(lazy, transform, ['torque']));
    const eagerCsv = await exportPanel(harnessWith(eagerFrom(lazy), transform, ['torque']));
    assert.ok(lazyCsv.split('\n').length > 1000 && lazyCsv.split('\n').length < ROWS,
        'the crop keeps a window of the file');
    assert.equal(lazyCsv, eagerCsv, 'crop, shift, gain, offset and sign are applied exactly as in memory');
}

// ── What cannot be read from the file says so ───────────────────────────────
{
    const lazy = await loadLazy();
    lazy.variables.derived = { name: 'derived', description: '', data: new Float64Array(lazy.variables.speed.data.length) };
    const h = harnessWith(lazy);
    const plan = h._lazyTimeseriesCsvPlan({ traces: [{ fileId: 'f', varName: 'speed' }, { fileId: 'f', varName: 'derived' }] });
    assert.equal(plan.exact, false, 'a variable computed over the overview has no column to read');
    const mixed = h._lazyTimeseriesCsvPlan({ traces: [{ fileId: 'f', varName: 'speed' }, { fileId: 'g', varName: 'speed' }] });
    assert.equal(mixed.exact, false, 'nor do traces from several files have rows in common');
    assert.equal(harnessWith(eagerFrom(lazy))._lazyTimeseriesCsvPlan({ traces: [{ fileId: 'f', varName: 'speed' }] }), null,
        'an eager file needs no plan: its export is already exact');
    assert.match(source, /if \(lazyPlan\) \{[\s\S]*?Modal\.alert\(i18n\.t\('exportDialogTitle'\), i18n\.t\('csvExportOverviewNotice'\)/,
        'the overview fallback is announced');
}

// ── A read that fails writes nothing, and says why ──────────────────────────
{
    const lazy = await loadLazy();
    lazy._duckdb.tableName = 'omv_no_such_table';
    downloads = [];
    alerts.length = 0;
    const h = harnessWith(lazy);
    const plot = { mode: 'timeseries', traces: [{ fileId: 'f', varName: 'speed' }] };
    const result = await h._exportLazyTimeseriesCsv(plot, h._lazyTimeseriesCsvPlan(plot), 'out.csv');
    assert.equal(result, null, 'the export reports that nothing was written');
    assert.equal(downloads.length, 0, 'and no partial file is handed to the browser');
    assert.equal(alerts.length, 1, 'the user is told');
    assert.equal(alerts[0][1], 'csvExportReadFailed');
}
console.log('lazy CSV export: every row, byte-identical to the in-memory export');
