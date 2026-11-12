// The Heatmap and the Temporal profile of a lazy file aggregate every row of
// the file, by the axis the panel shows, and come out as the in-memory ones —
// for the file's columns and for the signals derived from them.
//
//   node scripts/test-lazy-heatmap-profile.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds (every row, streamed once). On the lazy file
// the derived signals are made as the app makes them: a derivative (window
// columns), a moving average (a sink written by the chunked executor), an
// integral, and two formulas (one pointwise, one reading neighbouring rows).
// The exact queries (getCalendarHeatmapAggregates, getTemporalProfileAggregates)
// bucket by the axis PlotManager._lazyCalendarTimeSql gives them and are
// densified as the panels do; the in-memory reference is the kernel of
// src/utils/calendar-heatmap.js / temporal-profile.js over the rows transformed
// by the same function the lazy FFT and histogram use for rows read from the
// file. Checked, to the rounding of a sum taken in another order:
//
//   · every aggregation (mean, min, max, sum, count, integral), both calendar
//     modes; every profile period, day grouping with weekends combined,
//     discarding incomplete periods; the whole file and a selection;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//   · a datetime column shown as calendar dates; a file with no time column
//     whose axis is generated from an origin date (origin + row × Δt); a
//     datetime column the user reindexed the same way (the column is not the
//     axis any more); a numeric axis promoted to a calendar;
//   · several signals of one file in one scan;
//   · a signal that exists only on the overview is left out and named; an axis
//     not shown as a calendar is refused as the in-memory path refuses it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));
const { buildCalendarHeatmap, densifyCalendarHeatmap } = await import(new URL('../src/utils/calendar-heatmap.js', import.meta.url));
const { buildTemporalProfile } = await import(new URL('../src/utils/temporal-profile.js', import.meta.url));

// The panels hand the exact queries the axis they show and name what is left out.
const heatmapSource = readFileSync(new URL('../src/plots/methods/heatmap-methods.js', import.meta.url), 'utf8');
assert.match(heatmapSource, /const timeSql = this\._lazyCalendarTimeSql\(fileId\);/, 'the heatmap asks for the displayed axis');
assert.match(heatmapSource, /transforms,\n\s*timeSql,\n\s*(signal,\n\s*)?\}\);/, 'and buckets the lazy query by it');
assert.doesNotMatch(heatmapSource, /heatmapLazyUnsupported|heatmapLazyIntegralUnsupported/, 'no "not available yet" is left');
const profileSource = readFileSync(new URL('../src/plots/methods/temporal-profile-methods.js', import.meta.url), 'utf8');
assert.match(profileSource, /const timeSql = this\._lazyCalendarTimeSql\(fileId\);/, 'the profile asks for the displayed axis');
assert.match(profileSource, /transforms,\n\s*timeSql,\n\s*(signal,\n\s*)?\}\);/, 'and buckets the lazy query by it');

// PlotManager imports Plotly, so the few of its methods the data methods call
// are sliced out of it (as scripts/test-lazy-histogram.mjs does).
const managerSource = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const managerMethods = {};
vm.runInNewContext(['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_extractUnit', '_traceName'].map(sliceMethod).join('\n'), { proto: managerMethods, console });

class Panels {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
    }
}
installPlotDataMethods(Panels);
Object.assign(Panels.prototype, managerMethods);

// The app, enough of it to create data-tool variables and formulas on a lazy file.
class App {
    constructor(data) {
        this.files = new Map([['f', { data }]]);
        this.activeFileId = 'f';
        this.dataToolVariablesByFile = new Map();
        this.derivedByFile = new Map();
        this.plotManager = { files: this.files, updateFileData() {}, plots: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
    }
}
installDataToolsMethods(App);
installLazyDataToolsMethods(App);
installDerivedMethods(App);
Object.assign(App.prototype, { _renderFilteredTree() {}, _syncDataTools() {}, _setOutlierMessage() {}, _setDerivedMessage() {}, _refreshLazyOverviewSoon() {} });

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 41;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 30011;
const STEP_MS = 5 * 60000;
const START = Date.UTC(2024, 2, 4, 6, 0, 0); // a Monday, so weeks and days are mixed
// Five-minute samples over ~104 days: holes, a few ±∞, a long gap, and a
// second signal on another scale.
const lines = ['time,a,b'];
const rawTimes = [];
for (let i = 0; i < ROWS; i++) {
    const t = START + i * STEP_MS + (i > 12000 && i < 12400 ? 3 * 86400000 : 0);
    rawTimes.push(t);
    const hour = ((t / 3600000) % 24 + 24) % 24;
    let a = 10 + 6 * Math.sin((hour / 24) * 2 * Math.PI) + random() * 2;
    if (i % 2003 === 7) a = 50 + random();
    const aText = i % 131 === 7 ? '' : (i % 5003 === 11 ? 'inf' : String(Math.round(a * 1e6) / 1e6));
    const b = String(Math.round((random() - 0.5) * 2000) / 100);
    lines.push(`${new Date(t).toISOString()},${aText},${b}`);
}
const numericLines = ['t,a,b', ...lines.slice(1).map((line, i) => line.replace(/^[^,]*/, String(i * 300)))];
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['time', 'a', 'b'],
    headers: [{ name: 'time' }, { name: 'a' }, { name: 'b' }],
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
db.registerFileText('cal.csv', lines.join('\n') + '\n');
db.registerFileText('num.csv', numericLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle, csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_cal_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });

// The derived signals, as the app makes them on a lazy file.
async function deriveOn(data) {
    const app = new App(data);
    const ctx = (tool, source, output) => ({ fileId: 'f', data, sourceName: source, sourceVariable: data.variables[source], outputName: output, targetMode: 'create', tool, lazy: true });
    await app._applyLazyDataToolCreateMode(ctx('derivative', 'a', 'da'), { tool: 'derivative', params: { method: 'centered' } }, { silent: true });
    await app._applyLazyDataToolCreateMode(ctx('movingAverage', 'a', 'ma'), { tool: 'movingAverage', params: { window: 7 } }, { silent: true });
    await app._applyLazyDataToolCreateMode(ctx('integrate', 'a', 'ia'), { tool: 'integrate', params: { method: 'trapezoidal', gapPolicy: 'zero', initial: 0 } }, { silent: true });
    for (const [name, formula] of [['fa', 'sqrt(abs(a)) + b / 10'], ['fd', 'diff(a) * 2']]) {
        const result = app._evaluateDerivedFormula(formula, data);
        data.variables[name] = app._formulaDerivedVariable(name, formula, result);
    }
    assert.ok(data.variables.da._duckdbWindows?.length, 'the derivative reads windows');
    assert.ok(data.variables.ma._duckdbWindows?.some(w => w.sink), 'the moving average reads a sink');
    assert.ok(data.variables.fa._duckdbExpr && !data.variables.fa._duckdbWindows?.length, 'the pointwise formula is SQL over the columns');
    assert.ok(data.variables.fd._duckdbWindows?.length, 'the formula with diff() reads a window');
    // And one that exists only on the overview (nothing to read it from the file).
    data.variables.ov = { name: 'ov', data: new Float64Array(data.variables.a.data.length).fill(1), kind: 'variable', dataType: 'real', derived: true };
    return data;
}

// Every row of the lazy file, as the in-memory path would hold it.
async function rowsOf(lazy, names) {
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const n = chunks.reduce((total, c) => total + c.x.length, 0);
    const concat = (pick) => {
        const out = new Float64Array(n);
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    const rowIndex = new Float64Array(n);
    for (let i = 0; i < n; i++) rowIndex[i] = i;
    return { time: concat(c => c.x), rowIndex, byVar: new Map(names.map(name => [name, concat(c => c.yByVar.get(name))])) };
}

function panels(data, transform = {}, inverted = []) {
    const h = new Panels();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}

// What _runLazyCalendarHeatmap and the profile's lazy job hand the query.
function lazyOptions(h, names) {
    const transform = h._fileTransform('f');
    const cropStart = h._parseTimeBoundary('f', transform.cropStart);
    const cropEnd = h._parseTimeBoundary('f', transform.cropEnd);
    const transforms = {};
    for (const name of names) {
        const sign = h.isVariableSignInverted('f', name) ? -1 : 1;
        transforms[name] = { gain: transform.gain * sign, yOffset: transform.yOffset };
    }
    return {
        timeShiftMs: h._parseTimeShift('f', transform.timeShift) || 0,
        cropRange: cropStart != null || cropEnd != null ? [cropStart ?? -Infinity, cropEnd ?? Infinity] : null,
        transforms,
        timeSql: h._lazyCalendarTimeSql('f'),
    };
}

// The rows transformed as the panels transform rows read from the file, cut to
// the selection the way the in-memory heatmap and profile cut their arrays.
function reference(h, rows, names, range) {
    const transformed = h._transformFetchedPhaseTrajectory('f', rows.time, rows.rowIndex, rows.byVar, names);
    let start = 0;
    let end = transformed.time.length;
    if (range) {
        let [lower, upper] = range;
        if (lower > upper) [lower, upper] = [upper, lower];
        start = h._lowerBound(transformed.time, lower);
        end = Math.max(start, h._upperBound(transformed.time, upper));
    }
    return {
        times: transformed.time.slice(start, end),
        valuesByVar: new Map(names.map(name => [name, transformed.valuesByVar.get(name).slice(start, end)])),
    };
}

const close = (a, b, label) => {
    if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) {
        assert.ok((a == null || Number.isNaN(a)) && (b == null || Number.isNaN(b)), `${label}: ${a} vs ${b}`);
        return;
    }
    assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} vs ${b}`);
};

// ── Heatmap ─────────────────────────────────────────────────────────────────
async function compareHeatmaps(h, lazy, rows, names, { calendarMode, aggregation, range }, label) {
    const ref = reference(h, rows, names, range);
    const domainStart = range ? range[0] : Math.min(...ref.times);
    const domainEnd = range ? range[1] : Math.max(...ref.times);
    const densify = { calendarMode, aggregation, domainStart, domainEnd, traceCount: names.length, runtime: 'web' };
    const result = await duck.getCalendarHeatmapAggregates(lazy, names, {
        calendarMode, aggregation, ...lazyOptions(h, names), selectionRange: range,
    });
    assert.equal(result.ok, true, `${label}: the lazy query answers (${result.reason})`);
    assert.deepEqual(result.blocked, [], `${label}: nothing left out`);
    for (const name of names) {
        const entry = result.traces.find(item => item.varName === name);
        assert.ok(entry?.cells, `${label}: ${name} answered`);
        // As _runLazyCalendarHeatmap: no row in scope is the in-memory "no rows".
        const dense = !entry.cells.some(cell => Number(cell.nScope) > 0) ? { ok: false, reason: 'noRows' } : densifyCalendarHeatmap({
            accumulators: entry.cells, calendarMode, rangeActive: !!range,
            rangeStartMs: range ? range[0] : null, rangeEndMs: range ? range[1] : null,
            domainStartMs: domainStart, domainEndMs: domainEnd,
        }, densify);
        const want = buildCalendarHeatmap({
            times: ref.times, values: ref.valuesByVar.get(name), calendarMode, aggregation,
            rangeStart: null, rangeEnd: null, timeShiftMs: 0, domainStart, domainEnd, traceCount: names.length, runtime: 'web',
        });
        assert.equal(dense.ok, want.ok, `${label}: ${name} both built (${dense.reason} / ${want.reason})`);
        if (!want.ok) continue;
        assert.equal(dense.z.length, want.z.length, `${label}: ${name} rows`);
        for (let r = 0; r < want.z.length; r++) {
            assert.equal(dense.z[r].length, want.z[r].length, `${label}: ${name} columns`);
            for (let c = 0; c < want.z[r].length; c++) close(dense.z[r][c], want.z[r][c], `${label}: ${name} cell ${r},${c}`);
        }
        if (aggregation === 'integral') {
            assert.equal(entry.integralAvailable !== false, !want.warnings.includes('integralUnavailable'), `${label}: ${name} integral availability`);
        }
        const stats = result.traces.length && !dense.stats
            ? null
            : dense.stats;
        if (stats) {
            assert.equal(stats.nScope, want.stats.nScope, `${label}: ${name} rows in scope`);
            assert.equal(stats.nFinite, want.stats.nFinite, `${label}: ${name} finite`);
        }
    }
}

// ── Profile ─────────────────────────────────────────────────────────────────
// Numbers to the rounding of a sum taken in another order; everything else exactly.
function assertClose(got, want, label) {
    if (typeof want === 'number' || typeof got === 'number') return close(got, want, label);
    if (Array.isArray(want)) {
        assert.ok(Array.isArray(got) && got.length === want.length, `${label}: ${got?.length} items, in memory ${want.length}`);
        want.forEach((item, i) => assertClose(got[i], item, `${label}[${i}]`));
        return;
    }
    if (want && typeof want === 'object') {
        assert.deepEqual(Object.keys(got || {}).sort(), Object.keys(want).sort(), `${label}: keys`);
        for (const key of Object.keys(want)) assertClose(got[key], want[key], `${label}.${key}`);
        return;
    }
    assert.deepEqual(got, want, label);
}
const stableFloat = value => value;
function normalizeProfile(result) {
    return {
        period: result.period,
        resolutionUnit: result.resolutionUnit,
        binCount: result.binCount,
        absoluteBins: !!result.absoluteBins,
        binYears: result.binYears || null,
        categories: result.categories.map(category => ({
            id: category.id,
            total: category.total,
            included: category.included,
            discarded: category.discarded,
            partial: category.partial,
            withGaps: category.withGaps,
            withInvalid: category.withInvalid,
            bins: category.bins.map(bin => ({
                mean: stableFloat(bin.mean),
                std: stableFloat(bin.std),
                nPeriods: bin.nPeriods,
                nExpectedPeriods: bin.nExpectedPeriods,
                coverage: stableFloat(bin.coverage),
                nInvalidSamples: bin.nInvalidSamples,
                nGapPeriods: bin.nGapPeriods,
            })),
        })),
        stats: {
            nScope: result.stats.nScope,
            nFinite: result.stats.nFinite,
            nInvalid: result.stats.nInvalid,
            nPeriods: result.stats.nPeriods,
            nDiscardedPeriods: result.stats.nDiscardedPeriods,
        },
    };
}
const PROFILES = [
    { period: 'day', resolutionMinutes: 60, resolutionUnit: 'minute', dayGrouping: 'all', combineWeekends: false, discardIncomplete: false },
    { period: 'day', resolutionMinutes: 30, resolutionUnit: 'minute', dayGrouping: 'day-type', combineWeekends: true, discardIncomplete: true },
    { period: 'week', resolutionMinutes: 240, resolutionUnit: 'minute', dayGrouping: 'all', combineWeekends: false, discardIncomplete: false },
    { period: 'month', resolutionMinutes: 1440, resolutionUnit: 'minute', dayGrouping: 'all', combineWeekends: false, discardIncomplete: true },
    { period: 'year', resolutionMinutes: 1440, resolutionUnit: 'month', dayGrouping: 'all', combineWeekends: false, discardIncomplete: false },
    { period: 'multi-year', resolutionMinutes: null, resolutionUnit: 'year', dayGrouping: 'all', combineWeekends: false, discardIncomplete: false },
];
async function compareProfiles(h, lazy, rows, names, config, range, label) {
    const ref = reference(h, rows, names, range);
    const result = await duck.getTemporalProfileAggregates(lazy, names, { ...config, ...lazyOptions(h, names), selectionRange: range });
    assert.equal(result.ok, true, `${label}: the lazy query answers (${result.reason})`);
    assert.deepEqual(result.blocked, [], `${label}: nothing left out`);
    for (const name of names) {
        const got = result.traces.find(item => item.varName === name)?.result;
        assert.ok(got, `${label}: ${name} answered`);
        // As the panel's in-memory branch: arrays cut to the selection, and the
        // selection's bounds so the kernel knows which periods it cuts.
        const want = buildTemporalProfile({
            times: ref.times, values: ref.valuesByVar.get(name), ...config,
            rangeStart: range ? range[0] : null, rangeEnd: range ? range[1] : null,
        });
        assert.equal(want.ok, true, `${label}: ${name} in-memory profile built (${want.reason})`);
        assertClose(normalizeProfile(got), normalizeProfile(want), `${label}: ${name} profile`);
    }
}

const NAMES = ['a', 'b', 'da', 'ma', 'ia', 'fa', 'fd'];
const AGGREGATIONS = ['mean', 'min', 'max', 'sum', 'count', 'integral'];

// ── A datetime column: every signal, every aggregation, with and without transforms ──
const lazy = await deriveOn(await loadLazy('cal.csv'));
assert.ok(lazy.variables.a.data.length < ROWS / 10, 'what is in memory is an overview');
const rows = await rowsOf(lazy, NAMES);
assert.equal(rows.time.length, ROWS, 'every row of the file is read for the reference');
{
    let heatmaps = 0;
    let profiles = 0;
    for (const [label, transform, inverted] of [
        ['no transform', {}, []],
        ['crop, shift, gain, offset, sign', { gain: 2.5, yOffset: -3, timeShift: '00:17:00', cropStart: '2024-03-10T00:00', cropEnd: '2024-06-01T12:00' }, ['b', 'da']],
    ]) {
        const h = panels(lazy, transform, inverted);
        assert.ok(h._lazyCalendarTimeSql('f'), `${label}: the datetime column is the axis`);
        // Selections on and between samples, past the file, and none.
        for (const range of [null, [Date.UTC(2024, 3, 2, 7, 30), Date.UTC(2024, 4, 20, 0, 0)], [Date.UTC(2024, 2, 4, 6, 0), Date.UTC(2024, 2, 9, 0, 0, 0, 0)]]) {
            for (const calendarMode of ['week-day', 'day-hour']) {
                for (const aggregation of AGGREGATIONS) {
                    await compareHeatmaps(h, lazy, rows, NAMES, { calendarMode, aggregation, range }, `${label}, ${calendarMode}/${aggregation}, range ${JSON.stringify(range)}`);
                    heatmaps++;
                }
            }
            for (const config of PROFILES) {
                await compareProfiles(h, lazy, rows, NAMES, config, range, `${label}, ${config.period}/${config.resolutionUnit}, range ${JSON.stringify(range)}`);
                profiles++;
            }
        }
    }
    console.log(`lazy heatmap/profile: ${heatmaps} heatmaps (${NAMES.length} signals each) and ${profiles} profiles are the in-memory ones: column, derivative, moving average, integral, two formulas; crop, shift, gain, offset, sign`);
}

// ── Left out, and refused ───────────────────────────────────────────────────
{
    const h = panels(lazy);
    const heat = await duck.getCalendarHeatmapAggregates(lazy, ['a', 'ov'], { calendarMode: 'week-day', aggregation: 'mean', ...lazyOptions(h, ['a', 'ov']) });
    assert.deepEqual(heat.blocked, ['ov'], 'the overview-only signal is named as left out of the heatmap');
    assert.equal(heat.traces.length, 1, 'the column is aggregated');
    const prof = await duck.getTemporalProfileAggregates(lazy, ['ov', 'a'], { ...PROFILES[0], ...lazyOptions(h, ['a', 'ov']) });
    assert.deepEqual(prof.blocked, ['ov'], 'and of the profile');
    assert.equal(prof.traces.length, 1);
    // An axis not shown as a calendar: the in-memory path refuses it too.
    const elapsed = panels(lazy, { timeDisplayMode: 'elapsedSeconds' });
    assert.equal(elapsed._lazyCalendarTimeSql('f'), null, 'elapsed seconds are not a calendar axis');
    const refused = await duck.getCalendarHeatmapAggregates(lazy, ['a'], { calendarMode: 'week-day', aggregation: 'mean', timeSql: null });
    assert.deepEqual([refused.ok, refused.reason], [false, 'notDatetime'], 'the query refuses it as such');
    const refusedProfile = await duck.getTemporalProfileAggregates(lazy, ['a'], { ...PROFILES[0], timeSql: null });
    assert.deepEqual([refusedProfile.ok, refusedProfile.reason], [false, 'notDatetime']);
    console.log('lazy heatmap/profile: a signal that exists only on the overview is left out and named; an axis not shown as a calendar is refused');
}

// ── A datetime column reindexed from an origin date: the column is no longer the axis ──
{
    const transform = { timeDisplayMode: 'index', timeStepMode: 'custom', customTimeStep: '00:10:00', timeStepOriginMode: 'calendar', timeStepOriginDate: '2023-11-20T08:30' };
    const h = panels(lazy, transform);
    assert.ok(h._isGeneratedFromDetectedTime('f') && h._isGeneratedCalendarTime('f'), 'the axis is row × 10 min from the origin');
    const timeSql = h._lazyCalendarTimeSql('f');
    assert.ok(timeSql.windows.length === 1, 'the axis reads the row number');
    const ref = reference(h, rows, ['a'], null);
    assert.equal(ref.times[0], Date.UTC(2023, 10, 20, 8, 30), 'the first row sits on the origin');
    assert.equal(ref.times[ROWS - 1], Date.UTC(2023, 10, 20, 8, 30) + (ROWS - 1) * 600000, 'and the last at row × Δt');
    // The domain of the panels is the file's extent on that axis, which needs
    // the row count; a CSV opened as a view is not counted when it loads, so
    // the panels count it once before placing the axis.
    assert.equal(lazy._duckdb.totalRows, undefined, 'a CSV opened as a view is not counted when it loads');
    assert.equal(h._needsLazyRowCount('f'), true, 'an uncounted view with a row-number axis must be counted');
    assert.equal(panels(lazy)._needsLazyRowCount('f'), false, 'but not while its datetime column is the axis');
    assert.equal(h._lazyTimeExtent('f').length, 1, 'uncounted, the last row cannot be placed');
    assert.equal(await h._ensureLazyRowCount('f'), ROWS, 'the count is the file\'s rows');
    assert.equal(lazy._duckdb.totalRows, ROWS, 'and is kept');
    assert.equal(h._needsLazyRowCount('f'), false);
    assert.deepEqual(Array.from(h._lazyTimeExtent('f')), [ref.times[0], ref.times[ROWS - 1]], 'counted, the extent of the file on the reindexed axis is the rows\'');
    let checks = 0;
    for (const range of [null, [Date.UTC(2023, 11, 25), Date.UTC(2024, 1, 2, 12)]]) {
        for (const aggregation of ['mean', 'count', 'integral']) {
            await compareHeatmaps(h, lazy, rows, ['a', 'ma', 'fd'], { calendarMode: 'day-hour', aggregation, range }, `reindexed datetime, ${aggregation}, range ${JSON.stringify(range)}`);
            checks++;
        }
        for (const config of PROFILES.slice(0, 3)) {
            await compareProfiles(h, lazy, rows, ['a', 'da'], config, range, `reindexed datetime, ${config.period}, range ${JSON.stringify(range)}`);
            checks++;
        }
    }
    console.log(`lazy heatmap/profile: a datetime column reindexed from an origin date is bucketed by row × Δt, as in memory (${checks} checks)`);
}

// ── No time column: the axis is generated from an origin date ───────────────
{
    const generated = await deriveOn(await loadLazy('cal.csv', generatedProfile));
    const generatedRows = await rowsOf(generated, ['a', 'da', 'fa']);
    const h = panels(generated, { timeStepMode: '1minute', timeStepOriginMode: 'calendar', timeStepOriginDate: '2024-01-01T00:00' });
    assert.ok(h._isGeneratedIndexTime('f') && h._isGeneratedCalendarTime('f') && generated._duckdb.generatedTime, 'a generated calendar axis over a file with no time column');
    assert.equal(panels(generated)._lazyCalendarTimeSql('f'), null, 'as a plain row number it is no calendar axis');
    let checks = 0;
    for (const range of [null, [Date.UTC(2024, 0, 3, 12), Date.UTC(2024, 0, 15)]]) {
        for (const aggregation of ['mean', 'max', 'integral']) {
            await compareHeatmaps(h, generated, generatedRows, ['a', 'da', 'fa'], { calendarMode: 'week-day', aggregation, range }, `generated axis, ${aggregation}, range ${JSON.stringify(range)}`);
            checks++;
        }
        for (const config of [PROFILES[0], PROFILES[2], PROFILES[5]]) {
            await compareProfiles(h, generated, generatedRows, ['a', 'da', 'fa'], config, range, `generated axis, ${config.period}, range ${JSON.stringify(range)}`);
            checks++;
        }
    }
    await duck.release(generated);
    console.log(`lazy heatmap/profile: a file with no time column, its axis generated from an origin date, is bucketed as in memory (${checks} checks)`);
}

// ── A numeric axis promoted to a calendar ───────────────────────────────────
{
    const numeric = await deriveOn(await loadLazy('num.csv'));
    assert.notEqual(numeric.metadata.timeKind, 'datetime', 'the axis is numeric seconds');
    const numericRows = await rowsOf(numeric, ['a', 'ma']);
    assert.equal(panels(numeric)._lazyCalendarTimeSql('f'), null, 'shown as seconds it is no calendar axis');
    const h = panels(numeric, { numericTimeDisplay: 'calendar', timeStepOriginDate: '2024-03-04T06:00', gain: -1, timeShift: '01:00:00' }, ['ma']);
    assert.ok(h._isNumericCalendarAxis('f'), 'promoted to a calendar from the origin');
    let checks = 0;
    for (const range of [null, [Date.UTC(2024, 2, 20), Date.UTC(2024, 3, 2, 0, 0, 0)]]) {
        for (const aggregation of ['mean', 'sum', 'integral']) {
            await compareHeatmaps(h, numeric, numericRows, ['a', 'ma'], { calendarMode: 'day-hour', aggregation, range }, `numeric calendar, ${aggregation}, range ${JSON.stringify(range)}`);
            checks++;
        }
        for (const config of [PROFILES[0], PROFILES[1]]) {
            await compareProfiles(h, numeric, numericRows, ['a', 'ma'], config, range, `numeric calendar, ${config.period}, range ${JSON.stringify(range)}`);
            checks++;
        }
    }
    await duck.release(numeric);
    console.log(`lazy heatmap/profile: a numeric axis promoted to a calendar is bucketed as in memory (${checks} checks)`);
}

await duck.release(lazy);
console.log('test-lazy-heatmap-profile: OK');
