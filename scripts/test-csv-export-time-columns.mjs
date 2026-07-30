// Runtime test for the time-series / FFT CSV export column layout. The method
// lives on the PlotManager class, so — like test-mode-toolbar — we slice its
// source out of plot-manager.js, rebind it as `proto.<name> = function`, and run
// the REAL code against a small mock `this`.
//
// Focus: once traces from DIFFERENT files can overlay, a single shared time
// column (the first file's clock) no longer describes the other traces. The
// export must then emit a per-trace time column.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { csvCell, csvTextCell, csvValueCell } from '../src/utils/csv-cell.js';

const plotManagerSource = readFileSync(
    new URL('../src/plots/plot-manager.js', import.meta.url),
    'utf8',
);

const startMarker = '    _appendTimeseriesExportColumns(plot, headers, columns) {';
const start = plotManagerSource.indexOf(startMarker);
assert.ok(start >= 0, '_appendTimeseriesExportColumns is present');
const end = plotManagerSource.indexOf('\n    _appendPhaseCSVTrace(', start + 1);
assert.ok(end > start, 'method end located');
const methodText = plotManagerSource.slice(start, end)
    .replace(startMarker, 'proto._appendTimeseriesExportColumns = function(plot, headers, columns) {');

const proto = {};
// The sliced method escapes its headers with the real shared helper.
vm.runInNewContext(methodText, { proto, csvTextCell });

class Harness {
    constructor() {
        this.files = new Map();
        this._times = new Map();    // fileId -> number[]
        this._values = new Map();   // `${fileId}|${varName}` -> number[]
        this._units = new Map();    // fileId -> unit label
        this._calendar = new Set(); // fileIds shown as calendar
    }
    addFile(fileId, vars, { unit = 's', calendar = false } = {}) {
        this.files.set(fileId, { data: { variables: vars } });
        this._units.set(fileId, unit);
        if (calendar) this._calendar.add(fileId);
    }
    setTime(fileId, times) { this._times.set(fileId, times); }
    setValues(fileId, varName, values) { this._values.set(`${fileId}\u0000${varName}`, values); }

    _getTimeVar(fileId) {
        const vars = this.files.get(fileId)?.data?.variables;
        return vars ? (Object.values(vars).find(v => v.kind === 'abscissa') || null) : null;
    }
    _getTransformedTimeDataForVariable(fileId) { return this._times.get(fileId) || []; }
    _timeUnitLabel(fileId) { return this._units.get(fileId) || 's'; }
    _extractUnit(desc) { const m = /\[([^\]]+)\]/.exec(desc || ''); return m ? m[1] : ''; }
    _isCalendarTime(fileId) { return this._calendar.has(fileId); }
    _traceName(varName) { return varName; }
    _formatTimeColumnForExport(fileId, times) { return Array.from(times, String); }
    _getTransformedVariableData(fileId, varName) { return this._values.get(`${fileId}\u0000${varName}`) || []; }
}
Harness.prototype._appendTimeseriesExportColumns = proto._appendTimeseriesExportColumns;

// ── Case 1: single file, two traces, no independent index → ONE shared time ──
{
    const h = new Harness();
    h.addFile('f1', {
        t:    { kind: 'abscissa', description: 'time [s]' },
        varA: { description: 'A [m]' },
        varB: { description: 'B [N]' },
    });
    h.setTime('f1', [0, 1, 2]);
    h.setValues('f1', 'varA', [10, 11, 12]);
    h.setValues('f1', 'varB', [20, 21, 22]);
    const headers = [], columns = [];
    h._appendTimeseriesExportColumns({ mode: 'timeseries', traces: [
        { fileId: 'f1', varName: 'varA' },
        { fileId: 'f1', varName: 'varB' },
    ] }, headers, columns);
    assert.deepEqual(headers, ['time [s]', 'varA [m]', 'varB [N]'], 'single file: one shared time column');
    assert.equal(columns.length, 3);
    assert.deepEqual(columns[0], ['0', '1', '2'], 'shared time is the file clock');
}

// ── Case 2: two files (different clocks) → PER-TRACE time columns ─────────────
{
    const h = new Harness();
    h.addFile('mat', { t: { kind: 'abscissa', description: 'time [s]' }, x: { description: 'x [rad]' } });
    h.addFile('csv', { t: { kind: 'abscissa', description: 'time [s]' }, load: { description: 'P [MW]' } }, { calendar: true });
    h.setTime('mat', [0, 0.5, 1.0]);
    h.setTime('csv', [1000, 2000]);
    h.setValues('mat', 'x', [1, 2, 3]);
    h.setValues('csv', 'load', [7, 8]);
    const headers = [], columns = [];
    h._appendTimeseriesExportColumns({ mode: 'timeseries', traces: [
        { fileId: 'mat', varName: 'x' },
        { fileId: 'csv', varName: 'load' },
    ] }, headers, columns);
    assert.deepEqual(
        headers,
        ['x time [s]', 'x [rad]', 'load time [datetime UTC]', 'load [MW]'],
        'cross-file overlay: each trace carries its own time column (calendar labelled)',
    );
    assert.equal(columns.length, 4);
    assert.deepEqual(columns[0], ['0', '0.5', '1'], 'first trace time is the .mat clock');
    assert.deepEqual(columns[2], ['1000', '2000'], 'second trace time is the CSV clock');
    // Uneven lengths are padded by the writer, not here — the columns keep their
    // native length.
    assert.equal(columns[1].length, 3);
    assert.equal(columns[3].length, 2);
}

// ── Case 3: independent index → per-trace row-index column (unchanged) ────────
{
    const h = new Harness();
    h.addFile('p', {
        t: { kind: 'abscissa', description: 'time [s]' },
        a: { description: 'A [-]', independentIndex: true },
    });
    h.setTime('p', [0, 1, 2, 3]);
    h.setValues('p', 'a', [5, 6, 7, 8]);
    const headers = [], columns = [];
    h._appendTimeseriesExportColumns({ mode: 'timeseries', traces: [
        { fileId: 'p', varName: 'a' },
    ] }, headers, columns);
    assert.deepEqual(headers, ['a index', 'a [-]'], 'independent index keeps its row-index column');
}

// ── Case 4: a file names its own columns, so a header can be an attack ────────
// A CSV whose header reads =HYPERLINK(...) round-trips through this export and
// is evaluated as a formula when the result is opened in Excel/LibreOffice
// (CWE-1236). A comma in a name is the plainer bug: it shifts every later
// column. Both are the escaper's job, and it must leave ordinary names alone.
{
    const h = new Harness();
    h.addFile('f1', {
        t: { kind: 'abscissa', description: 'time [s]' },
        '=HYPERLINK("http://evil","click")': { description: 'A [m]' },
        'power, total': { description: 'B [MW]' },
    });
    h.setTime('f1', [0, 1]);
    h.setValues('f1', '=HYPERLINK("http://evil","click")', [1, 2]);
    h.setValues('f1', 'power, total', [3, 4]);
    const headers = [], columns = [];
    h._appendTimeseriesExportColumns({ mode: 'timeseries', traces: [
        { fileId: 'f1', varName: '=HYPERLINK("http://evil","click")' },
        { fileId: 'f1', varName: 'power, total' },
    ] }, headers, columns);
    assert.deepEqual(
        headers,
        [
            'time [s]',
            '"\'=HYPERLINK(""http://evil"",""click"") [m]"',
            '"power, total [MW]"',
        ],
        'a formula header is neutralized and a comma in a name is quoted',
    );
}

// The escaper itself: text cells are defused, numbers are left untouched.
{
    assert.equal(csvTextCell('=cmd|calc'), "'=cmd|calc", 'a leading = is defused');
    assert.equal(csvTextCell('@SUM(A1)'), "'@SUM(A1)", 'a leading @ is defused');
    assert.equal(csvTextCell('-2+3+cmd'), "'-2+3+cmd", 'a leading - is defused');
    assert.equal(csvTextCell('temperature'), 'temperature', 'an ordinary name is untouched');
    assert.equal(csvTextCell('a"b'), '"a""b"', 'a quote is doubled and the cell wrapped');
    assert.equal(csvCell(-1.5), '-1.5', 'a negative number stays a number');
    assert.equal(csvValueCell(-1.5), '-1.5', 'a typed number is not treated as a formula');
    assert.equal(csvValueCell('-signal'), "'-signal", 'a string that looks like a formula is defused');
}

console.log('CSV export time-column tests passed.');
