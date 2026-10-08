// Files that follow one another in time, exported as one record.
//
//   node scripts/test-timeseries-concat-export.mjs
//
// One file per day, the same variable overlaid from all of them: the CSV used
// to give every day its own time and value columns. When the files do not
// overlap in time it now writes one time column and one column per variable,
// the files placed one after another in time order.
//
// Three layers are checked. The pure planner and block writer
// (src/plots/timeseries-concat.js); the export itself, run on CSV files parsed
// by the app's own parser, with calendar time; and parity between a lazy file
// read from disk through DuckDB and the same file held in memory. PlotManager
// imports Plotly, so its methods are sliced out of the source and run against
// a harness carrying the real data methods — the technique of
// test-lazy-csv-export.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const {
    planTimeConcat, concatenatedCsvBlocks, normalizeConcatBoundaryMode,
} = await import(new URL('../src/plots/timeseries-concat.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { csvTextCell, csvValueCell } = await import(new URL('../src/utils/csv-cell.js', import.meta.url));
const translations = (await import(new URL('../src/i18n/translations.js', import.meta.url))).default;
const CsvParser = (await import(new URL('../src/parsers/csv-parser.js', import.meta.url))).default;

// ── The planner ─────────────────────────────────────────────────────────────
{
    // Out of order, touching at midnight: placed by time, one shared instant
    // per boundary, no overlap.
    const days = [{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 1, end: 2 }];
    const plan = planTimeConcat(days);
    assert.deepEqual(plan.order, [1, 2, 0], 'files are placed in time order, not load order');
    assert.equal(plan.overlaps, 0);
    assert.equal(plan.boundaryInstants, 2, 'a file starting where the previous one ends shares that instant');

    const gaps = planTimeConcat([{ start: 0, end: 0.9 }, { start: 1, end: 1.9 }]);
    assert.equal(gaps.overlaps + gaps.boundaryInstants, 0, 'a gap between files is neither');

    // Relative time: thirty days that all start at zero. Every one after the
    // first overlaps, and only the first overlap is described.
    const relative = planTimeConcat(Array.from({ length: 30 }, () => ({ start: 0, end: 86400 })));
    assert.equal(relative.overlaps, 29, 'every file but the first overlaps an earlier one');
    assert.deepEqual(relative.firstOverlap, { earlier: 0, later: 1 }, 'and one example is kept');

    // A long file covering two short ones: both overlap it, not each other.
    const covered = planTimeConcat([{ start: 0, end: 10 }, { start: 2, end: 3 }, { start: 5, end: 6 }]);
    assert.equal(covered.overlaps, 2, 'an overlap is with the reach of every earlier file, not only the last');
    assert.deepEqual(covered.firstOverlap, { earlier: 0, later: 1 });

    const empty = planTimeConcat([{ start: NaN, end: NaN }, { start: 0, end: 1 }]);
    assert.deepEqual(empty.order, [1, 0], 'a file with no finite time goes last');
    assert.equal(empty.overlaps, 0);

    assert.equal(normalizeConcatBoundaryMode('bogus'), 'keep', 'an unknown mode keeps every row');
}

// ── The block writer ────────────────────────────────────────────────────────
// A segment reading from plain arrays, `blockRows` at a time.
function segment(label, rows, varNames) {
    let offset = 0;
    return {
        label,
        varNames,
        async take(n) {
            const from = offset;
            const to = Math.min(rows.length, from + n);
            offset = to;
            const slice = rows.slice(from, to);
            return {
                rows: slice.length,
                rawTime: Float64Array.from(slice, row => row.t),
                time: slice.map(row => `t${row.t}`),
                values: new Map(varNames.map(name => [name, Float64Array.from(slice, row => row[name])])),
            };
        },
    };
}
async function table(options) {
    const lines = [];
    for await (const { columns, rows } of concatenatedCsvBlocks(options)) {
        for (let i = 0; i < rows; i++) {
            lines.push(columns.map(column => {
                const value = column[i];
                return value === undefined ? '' : String(value);
            }).join(','));
        }
    }
    return lines;
}
{
    const days = () => [
        segment('d1', [{ t: 0, a: 1, b: 10 }, { t: 1, a: 2, b: 20 }, { t: 2, a: 3, b: 30 }], ['a', 'b']),
        // d2 lacks b, and repeats an instant of its own (t = 3) which is the
        // file's business, never merged.
        segment('d2', [{ t: 2, a: 5 }, { t: 3, a: 6 }, { t: 3, a: 7 }, { t: 4, a: 8 }], ['a']),
        segment('d3', [{ t: 4, a: NaN, b: 40 }, { t: 5, a: 9, b: 50 }], ['a', 'b']),
    ];
    for (const blockRows of [1, 2, 65536]) {
        const keep = await table({ segments: days(), varNames: ['a', 'b'], blockRows });
        assert.deepEqual(keep, [
            't0,1,10', 't1,2,20', 't2,3,30',
            't2,5,', 't3,6,', 't3,7,', 't4,8,',
            't4,NaN,40', 't5,9,50',
        ], `keep: every row, a missing variable left empty (blocks of ${blockRows})`);

        const mean = await table({ segments: days(), varNames: ['a', 'b'], boundaryMode: 'mean', blockRows });
        assert.deepEqual(mean, [
            't0,1,10', 't1,2,20', 't2,4,30',
            't3,6,', 't3,7,', 't4,8,40', 't5,9,50',
        ], `mean: one row per shared instant, over the values present and finite (blocks of ${blockRows})`);

        const first = await table({ segments: days(), varNames: ['a', 'b'], boundaryMode: 'first', blockRows });
        assert.deepEqual(first.slice(2, 3), ['t2,3,30'], 'first: the file that ends there');
        assert.deepEqual(first.slice(5), ['t4,8,40', 't5,9,50'],
            'first: a variable the earlier file lacks comes from the file that has it');

        const last = await table({ segments: days(), varNames: ['a', 'b'], boundaryMode: 'last', blockRows });
        assert.deepEqual(last.slice(2, 3), ['t2,5,30'], 'last: the file that starts there');
        assert.deepEqual(last.slice(5, 6), ['t4,NaN,40'], 'last: an empty reading is that file\'s value');

        const sourced = await table({
            segments: days(), varNames: ['a', 'b'], boundaryMode: 'mean', blockRows, sourceCell: label => `"${label}"`,
        });
        assert.deepEqual(sourced.map(line => line.split(',').at(-1)), [
            '"d1"', '"d1"', '"d1 + d2"', '"d2"', '"d2"', '"d2 + d3"', '"d3"',
        ], 'the source column names every file a merged row came from');
    }
}

// ── The export, sliced out of PlotManager ───────────────────────────────────
const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(source);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = source.indexOf('\n    }\n', braceAt);
    const body = source.slice(braceAt, end + '\n    }'.length);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${body};`;
}
const methods = [
    '_exportCSV', '_writeCsvFile', '_writeCsvChunks', '_lazyTimeseriesCsvPlan',
    '_timeseriesConcatPlan', '_concatTimeRange', '_exportConcatenatedTimeseriesCsv',
    '_lazyCsvRowFeeder', '_memoryCsvRowFeeder', '_appendTimeseriesExportColumns',
    '_getTimeVar', '_traceName', '_extractUnit', 'isVariableSignInverted', '_timeShiftForMode',
];
const helperStart = source.indexOf('function joinCsvRowPieces(');
const helper = source.slice(helperStart, source.indexOf('\n}\n', helperStart) + 2);
const en = translations.en;
const proto = {};
let downloads = [];
const alerts = [];
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
vm.runInNewContext(`${helper}\n${methods.map(sliceMethod).join('\n')}`, {
    proto,
    console,
    streamColumns,
    csvTextCell,
    csvValueCell,
    planTimeConcat,
    concatenatedCsvBlocks,
    i18n: { t: key => en[key] ?? key, formatNumber: value => String(value) },
    Modal: { alert: async (...args) => { alerts.push(args); } },
    Blob: class {
        constructor(parts) { this.text = Array.from(parts, part => (typeof part === 'string' ? part : part.text)).join(''); }
    },
    URL: { createObjectURL: blob => { downloads.push(blob.text); return 'blob:x'; }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() {} }) },
});
class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = null;
        this.plots = new Map();
        this.onBusyOverlay = () => ({ progress() {}, close() {} });
    }
    _hasContent(plot) { return !!plot?.traces?.length; }
    _yieldToPaint() { return Promise.resolve(); }
}
installPlotDataMethods(Harness);
Object.assign(Harness.prototype, proto);

async function exportPlot(h, plot, options = {}) {
    downloads = [];
    h.plots.set('p', plot);
    await h._exportCSV('p', { fileName: 'out.csv', ...options });
    assert.equal(downloads.length, 1, 'one file is written');
    return downloads[0].split('\n');
}

// Daily reports as a logger writes them: every five minutes, midnight to the
// next midnight included, so each day shares its last instant with the next.
const parser = new CsvParser();
function dailyCsv(day, extraColumn = false) {
    const lines = [extraColumn ? 'Heure,PV(W),Load(W)' : 'Heure,PV(W)'];
    const base = Date.UTC(2026, 8, day);
    for (let k = 0; k <= 288; k++) {
        const stamp = new Date(base + k * 300000).toISOString().replace('T', ' ').slice(0, 19);
        const pv = day * 1000 + k;
        lines.push(extraColumn ? `${stamp},${pv},${-pv}` : `${stamp},${pv}`);
    }
    return `﻿${lines.join('\n')}\n`;
}
async function parseDaily(day, extraColumn) {
    const bytes = new TextEncoder().encode(dailyCsv(day, extraColumn));
    return parser.parse(bytes.buffer);
}

{
    const h = new Harness();
    // Loaded out of order on purpose.
    for (const day of [3, 1, 2]) {
        const data = await parseDaily(day, day === 2);
        h.files.set(`day${day}`, { name: `report_${day}.csv`, data, transform: {} });
    }
    const pv = Object.keys(h.files.get('day1').data.variables).find(name => name.startsWith('PV'));
    const load = Object.keys(h.files.get('day2').data.variables).find(name => name.startsWith('Load'));
    assert.ok(pv && load, 'the fixture parses into PV and Load columns');
    assert.ok(h._isCalendarTime('day1'), 'with calendar time');

    const plot = {
        mode: 'timeseries',
        traces: [
            { fileId: 'day2', varName: pv }, { fileId: 'day2', varName: load },
            { fileId: 'day1', varName: pv }, { fileId: 'day3', varName: pv },
        ],
    };
    const concat = h._timeseriesConcatPlan(plot);
    assert.equal(concat.available, true, 'three days that only touch can be joined');
    assert.deepEqual(Array.from(concat.segments, segment => segment.fileId), ['day1', 'day2', 'day3']);
    assert.equal(concat.boundaryInstants, 2, 'two midnights are shared');

    // The default: one time column, one per variable, every row kept.
    const keep = await exportPlot(h, plot);
    assert.equal(keep[0], "time [datetime UTC],PV [W],Load [W]", 'one time column, no file name in the headers');
    assert.equal(keep.length, 1 + 3 * 289, 'every row of every file');
    assert.match(keep[1], /^2026-09-01[ T]00:00:00/, 'the earliest day comes first, whatever the load order');
    assert.equal(keep[1].split(',').slice(1).join(','), '1000,', 'day 1 has no Load: the cell is empty');
    const firstOfDay2 = keep.findIndex(line => line.endsWith(',2000,-2000'));
    assert.equal(firstOfDay2, 1 + 289, 'day 2 follows day 1');
    assert.equal(keep[firstOfDay2 - 1].split(',')[0], keep[firstOfDay2].split(',')[0],
        'kept, the shared midnight appears twice');

    // One row per shared midnight, from the later file.
    const last = await exportPlot(h, plot, { boundaryMode: 'last', sourceColumn: true });
    assert.equal(last[0], "time [datetime UTC],PV [W],Load [W],source_file", 'the source column comes last');
    assert.equal(last.length, 1 + 3 * 289 - 2, 'each shared midnight is one row');
    const midnight = last[289];
    assert.ok(midnight.startsWith(keep[289].split(',')[0]), 'that row is at the shared instant');
    assert.ok(midnight.endsWith(',2000,-2000,report_1.csv + report_2.csv'),
        'with the later file\'s values, and both files named');
    assert.equal(new Set(last.slice(1).map(line => line.split(',')[0])).size, last.length - 1,
        'no instant appears twice');

    // The old layout is still there when asked for.
    const perTrace = await exportPlot(h, plot, { timeLayout: 'per-trace' });
    assert.equal(perTrace[0].split(',').length, 8, 'per trace: a time and a value column for each of the four');

    // Relative time: every day starts at zero, and they all overlap.
    for (const id of ['day1', 'day2', 'day3']) {
        h.files.get(id).transform = { timeDisplayMode: 'elapsedSeconds' };
        delete h.files.get(id)._transformCache;   // what the app does on a transform change
    }
    const relative = h._timeseriesConcatPlan(plot);
    assert.equal(relative.available, false, 'files that overlap as plotted are not joined');
    assert.equal(relative.reason,
        en.exportCsvLayoutOverlapMany.replace('{count}', '2').replace('{earlier}', 'report_2.csv').replace('{later}', 'report_1.csv'),
        'and the reason names one overlap and counts the rest');
    const fallback = await exportPlot(h, plot);
    assert.equal(fallback[0].split(',').length, 8, 'the export then keeps the trace-by-trace layout');

    assert.equal(h._timeseriesConcatPlan({ mode: 'timeseries', traces: [{ fileId: 'day1', varName: pv }] }), null,
        'a single file has nothing to join');
}

// ── Lazy files: the rows read from disk are the rows held in memory ─────────
{
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
    const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
    const duck = new DuckDbSource();
    duck._db = db;
    duck._conn = db.connect();

    // Numeric seconds, 20 001 rows a file: well past the 500-point overview.
    const ROWS = 20001;
    const fixtures = [0, 1, 2].map((k) => {
        const t = new Float64Array(ROWS);
        const speed = new Float64Array(ROWS);
        const lines = ['t,speed'];
        for (let i = 0; i < ROWS; i++) {
            t[i] = k * (ROWS - 1) + i;   // each file starts where the previous one ends
            speed[i] = Math.round(Math.sin(i / 50 + k) * 1e4) / 1e4;
            lines.push(`${t[i]},${speed[i]}`);
        }
        db.registerFileText(`seg${k}.csv`, `${lines.join('\n')}\n`);
        return { t, speed };
    });
    const loadLazy = name => duck._loadIntoLegacy(name, `omv_concat_${Math.random().toString(36).slice(2)}`,
        { lazy: true, overviewPoints: 500, format: 'csv' });
    const eagerFrom = (lazy, fixture) => {
        const data = structuredClone({ metadata: lazy.metadata, variables: Object.fromEntries(
            Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])) });
        data.variables[data.metadata.timeName].data = fixture.t;
        data.variables.speed.data = fixture.speed;
        data.metadata.numTimesteps = ROWS;
        return data;
    };
    const build = async (lazyIds) => {
        const h = new Harness();
        for (const k of [2, 0, 1]) {
            const lazy = await loadLazy(`seg${k}.csv`);
            h.files.set(`seg${k}`, { name: `seg${k}.csv`, data: lazyIds.includes(k) ? lazy : eagerFrom(lazy, fixtures[k]), transform: {} });
        }
        return h;
    };
    const plot = { mode: 'timeseries', traces: [0, 1, 2].map(k => ({ fileId: `seg${k}`, varName: 'speed' })) };
    const lazyHarness = await build([0, 1, 2]);
    assert.ok(lazyHarness.files.get('seg0').data.variables.speed.data.length < ROWS, 'the lazy files hold an overview');
    const plan = lazyHarness._timeseriesConcatPlan(plot);
    assert.equal(plan.available, true, 'three lazy files that only touch can be joined');
    assert.deepEqual(Array.from(plan.segments, segment => [segment.start, segment.end]),
        [[0, ROWS - 1], [ROWS - 1, 2 * (ROWS - 1)], [2 * (ROWS - 1), 3 * (ROWS - 1)]],
        'a lazy file is placed by its true first and last instants, which its overview need not hold');
    assert.equal(plan.boundaryInstants, 2);

    for (const options of [{}, { boundaryMode: 'mean', sourceColumn: true }]) {
        const fromDisk = await exportPlot(lazyHarness, plot, options);
        const fromMemory = await exportPlot(await build([]), plot, options);
        const mixed = await exportPlot(await build([1]), plot, options);
        assert.equal(fromDisk.length, 1 + 3 * ROWS - (options.boundaryMode ? 2 : 0), 'every row of every file');
        assert.deepEqual(fromDisk, fromMemory, 'read from disk, the table is the one written from memory');
        assert.deepEqual(mixed, fromMemory, 'and so with lazy and in-memory files together');
    }
}

// ── The dialog offers the choice ────────────────────────────────────────────
{
    const dialog = readFileSync(new URL('../src/ui/plot-export-dialog.js', import.meta.url), 'utf8');
    const exportMethods = readFileSync(new URL('../src/plots/methods/export-methods.js', import.meta.url), 'utf8');
    assert.match(dialog, /timeLayout: 'concat',[\s\S]*?boundaryMode: 'keep',[\s\S]*?sourceColumn: false,/,
        'joining is the default, every row is kept, and no source column is added unless asked');
    assert.match(dialog, /layoutSection\.hidden = state\.format !== 'csv' \|\| !csvLayout;/,
        'the layout is offered only for a CSV of a panel over several files');
    assert.match(dialog, /boundarySection\.hidden = state\.format !== 'csv' \|\| !concat \|\| boundaryCountValue === 0;/,
        'the shared-instant choice appears only when there is one to make');
    assert.match(exportMethods, /timeLayout: result\.timeLayout,\s*boundaryMode: result\.boundaryMode,\s*sourceColumn: result\.sourceColumn,/,
        'and what was chosen reaches the export');
    for (const lang of Object.keys(translations)) {
        for (const key of Object.keys(en).filter(name => name.startsWith('exportCsvLayout') || name.startsWith('exportCsvBoundary') || name.startsWith('exportCsvSource'))) {
            assert.ok(translations[lang][key], `${lang}: ${key} is translated`);
        }
    }
}

console.log('Time-series concatenated CSV export tests passed');
