import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MatParser from '../src/parsers/mat-parser.js';
import MatlabMatFile, { detectMatFileVersion } from '../src/parsers/matlab-mat-file.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';
import { installTreeMethods, transposeMatrixSeries } from '../src/app/methods/tree-methods.js';

const MB = 1024 * 1024;

class MatlabLimitHarness {
    constructor({ desktop = false, limitMb } = {}) {
        this.capabilities = { isDesktop: desktop };
        this.advancedSettings = limitMb == null ? {} : { matlabFullLoadMb: limitMb };
    }
}

installFileMethods(MatlabLimitHarness);

assert.equal(new MatlabLimitHarness()._matlabEagerLimitBytes(), 250 * MB,
    'Light Web defaults to a 250 MB MAT eager limit');
assert.equal(new MatlabLimitHarness({ desktop: true })._matlabEagerLimitBytes(), 1024 * MB,
    'Full Desktop defaults to a 1024 MB MAT eager limit');
assert.equal(new MatlabLimitHarness({ limitMb: 375 })._matlabEagerLimitBytes(), 375 * MB,
    'the configured MAT full-load limit overrides the runtime default');

class IndependentIndexPlotHarness {
    constructor() {
        this.files = new Map([['mat', { data: { variables: {
            short: { name: 'short', kind: 'variable', data: Float64Array.from([10, 20]), independentIndex: true },
        } } }]]);
    }
}
installPlotDataMethods(IndependentIndexPlotHarness);
const indexPlot = new IndependentIndexPlotHarness();
indexPlot._getTransformIndexData = () => ({ indexes: [0, 1, 2, 3], times: [0, 1, 2, 3] });
indexPlot._fileTransform = () => ({ gain: 1, yOffset: 0 });
indexPlot._transformCache = () => null;
indexPlot.isVariableSignInverted = () => false;
assert.deepEqual(indexPlot._getTransformedTimeDataForVariable('mat', 'short'), [0, 1],
    'a MAT signal uses only its own index extent');
assert.deepEqual(Array.from(indexPlot._getTransformedVariableData('mat', 'short')), [10, 20],
    'a MAT signal is transformed without NaN padding');

const transposedSeries = transposeMatrixSeries([
    Float64Array.from([1, 2]),
    Float64Array.from([3, 4]),
    Float64Array.from([5, 6]),
]);
assert.deepEqual(transposedSeries.map(values => Array.from(values)), [[1, 3, 5], [2, 4, 6]],
    'on-the-fly matrix transposition swaps series and sample dimensions');
assert.deepEqual(transposeMatrixSeries(transposedSeries).map(values => Array.from(values)), [[1, 2], [3, 4], [5, 6]],
    'transposing twice restores the original matrix series');

class MatrixTreeHarness {
    constructor() {
        const variable = (name, values) => ({
            name, data: Float64Array.from(values), kind: 'variable', dataType: 'real',
            independentIndex: true, sampleIndexLength: values.length,
            matlab: { path: 'matrix', shape: [2, 3], displayShape: [2, 3], sampleAxisMode: 'rows' },
        });
        const data = {
            variables: {
                index: { name: 'index', data: Float64Array.from([0, 1]), kind: 'abscissa', syntheticIndex: true },
                'matrix[1]': variable('matrix[1]', [1, 2]),
                'matrix[2]': variable('matrix[2]', [3, 4]),
                'matrix[3]': variable('matrix[3]', [5, 6]),
            },
            metadata: { timeName: 'index', matlab: { matrixOrientations: { matrix: 'rows' } } },
        };
        this.node = {
            _variables: { '[1]': data.variables['matrix[1]'], '[2]': data.variables['matrix[2]'], '[3]': data.variables['matrix[3]'] },
            _matlabMatrix: { path: 'matrix', shape: [2, 3], displayShape: [2, 3], orientation: 'rows' },
        };
        data.tree = { _children: { matrix: this.node }, _variables: {} };
        this.activeFileId = 'mat';
        this.parser = new MatParser();
        this.plotManager = { files: new Map([['mat', { data }]]), plots: new Map() };
        this.derivedByFile = new Map();
        this.selectedVariables = new Set();
    }
}
installTreeMethods(MatrixTreeHarness);
MatrixTreeHarness.prototype._renderFilteredTree = function() {
    this.fullTreeRenderCount = (this.fullTreeRenderCount || 0) + 1;
};
const matrixTree = new MatrixTreeHarness();
assert.equal(await matrixTree._transposeMatlabMatrixNode(matrixTree.node), true,
    'an independent-index matrix can be transposed from its tree node');
assert.deepEqual(Array.from(matrixTree.plotManager.files.get('mat').data.variables['matrix[1]'].data), [1, 3, 5]);
assert.equal(matrixTree.node._info, '(3 × 2)', 'on-the-fly transposition updates the displayed matrix size');
assert.equal(matrixTree.node._matlabMatrix.orientation, 'columns', 'on-the-fly orientation is persisted');
assert.equal(matrixTree.fullTreeRenderCount || 0, 0,
    'on-the-fly matrix transposition does not rebuild and collapse the full variable tree');

const fixture = name => {
    const bytes = readFileSync(new URL(`../test-files/matlab/${name}`, import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const parser = new MatlabMatFile(new MatParser());

const exampleSource = readFileSync(new URL('../public/examples/example-data.js', import.meta.url), 'utf8');
const exampleBase64 = exampleSource.match(/EXAMPLE_DATA_B64\s*=\s*"([^"]+)"/)?.[1];
assert.ok(exampleBase64, 'bundled OpenModelica fixture is available');
const exampleBytes = Buffer.from(exampleBase64, 'base64');
const exampleBuffer = exampleBytes.buffer.slice(exampleBytes.byteOffset, exampleBytes.byteOffset + exampleBytes.byteLength);
const modelicaInspection = await parser.inspect(exampleBuffer, 'ExampleSimplePendulum.mat');
assert.equal(modelicaInspection.kind, 'modelica', 'OpenModelica/Dymola MAT v4 bypasses the general picker');
assert.ok(modelicaInspection.data.variables.time, 'legacy simulation time remains available');
assert.ok(Object.keys(modelicaInspection.data.variables).length > 2, 'legacy simulation variables remain available');

assert.equal(detectMatFileVersion(fixture('general-v4.mat')), '4');
assert.equal(detectMatFileVersion(fixture('general-v5.mat')), '5-7');
assert.equal(detectMatFileVersion(fixture('general-v7-compressed.mat')), '5-7');
assert.equal(detectMatFileVersion(fixture('general-v73.mat')), '7.3');

for (const name of ['general-v4.mat', 'general-v5.mat', 'general-v7-compressed.mat', 'general-v73.mat']) {
    const inspection = await parser.inspect(fixture(name), name);
    assert.equal(inspection.kind, 'general', `${name} is a general MATLAB container`);
    const time = inspection.entries.find(entry => entry.path === 'time');
    const signals = inspection.entries.find(entry => entry.path === 'signals');
    assert.ok(time?.selectable, `${name} exposes its time vector`);
    assert.deepEqual(time.shape.filter(size => size > 1), [5], `${name} preserves vector length`);
    assert.ok(signals?.selectable, `${name} exposes its numeric matrix`);
    assert.deepEqual(signals.shape, [5, 2], `${name} preserves matrix shape`);

    const data = parser.materialize(inspection, {
        selectedIds: inspection.entries.filter(entry => entry.selectable).map(entry => entry.id),
        timeId: 'time',
        sampleAxisMode: 'rows',
    }, name);
    assert.equal(data.metadata.timeName, 'time');
    assert.deepEqual(Array.from(data.variables.time.data), [0, 1, 2, 3, 4]);
    assert.deepEqual(Array.from(data.variables['signals[1]'].data), [0, 10, 20, 30, 40]);
    assert.deepEqual(Array.from(data.variables['signals[2]'].data), [100, 101, 102, 103, 104]);
    assert.equal(data.variables.scalar.data[0], 42.5);
    assert.equal(data.metadata.matlab.sampleAxisMode, 'rows');
    assert.ok(data.tree._children.signals, `${name} keeps a matrix container in the variable tree`);
    assert.equal(data.tree._children.signals._info, '(5 × 2)', `${name} shows matrix dimensions on its tree node`);
    assert.ok(data.tree._children.signals._variables['[1]'], `${name} nests generated series below the matrix`);
    if (name === 'general-v4.mat') {
        assert.equal(inspection.entries.find(entry => entry.path === 'complex_signal')?.complex, true,
            'MAT v4 complex arrays retain their imaginary component');
        assert.equal(inspection.entries.find(entry => entry.path === 'label')?.selectable, false,
            'MAT v4 text matrices appear in overview without becoming numeric traces');
    }
}

const level5 = await parser.inspect(fixture('general-v5.mat'), 'general-v5.mat');
const complex = level5.entries.find(entry => entry.path === 'complex_signal');
assert.equal(complex.complex, true, 'Level 5 complex flag is retained');
const complexData = parser.materialize(level5, { selectedIds: ['time', 'complex_signal'], timeId: 'time' });
assert.ok(complexData.variables['complex_signal.real'], 'complex real component is imported explicitly');
assert.ok(complexData.variables['complex_signal.imag'], 'complex imaginary component is imported');
const transposedData = parser.materialize(level5, {
    selectedIds: ['signals'],
    timeMode: 'index',
    matrixOrientations: { signals: 'columns' },
});
assert.equal(transposedData.metadata.numTimesteps, 2, 'a matrix can independently use its columns as samples');
assert.deepEqual(Array.from(transposedData.variables['signals[1]'].data), [0, 100],
    'per-matrix transposition produces one series per original row');
assert.equal(transposedData.tree._children.signals._info, '(2 × 5)',
    'a transposed matrix reports its imported orientation in the variable tree');
assert.equal(transposedData.tree._variables.index, undefined,
    'the internal shared index is hidden when signals own their indexes');
const mixedLengthIndexData = parser.materialize(level5, {
    selectedIds: ['time', 'signals'],
    timeMode: 'index',
    matrixOrientations: { signals: 'columns' },
});
assert.equal(mixedLengthIndexData.metadata.numTimesteps, 5,
    'index mode uses the longest selected signal as its common index');
assert.deepEqual(Array.from(mixedLengthIndexData.variables['signals[1]'].data), [0, 100]);
assert.equal(mixedLengthIndexData.variables['signals[1]'].independentIndex, true,
    'index mode preserves each signal length and marks its index as independent');
assert.ok(level5.entries.some(entry => entry.path === 'config.gain'), 'Level 5 structs expose numeric fields');
assert.ok(level5.entries.some(entry => entry.path === 'config.profile'), 'Level 5 struct vectors are selectable');
assert.ok(level5.entries.some(entry => entry.path === 'config.nested.offset'), 'Level 5 nested struct paths remain hierarchical');
assert.ok(level5.entries.some(entry => entry.path.startsWith('samples_cell{1}')), 'Level 5 cell arrays expose numeric contents');
const sparse = level5.entries.find(entry => entry.path === 'sparse_signals');
assert.equal(sparse?.className, 'sparse', 'Level 5 sparse matrices are recognized');
assert.deepEqual(sparse?.shape, [5, 2], 'Level 5 sparse shape is retained');
assert.deepEqual(sparse?.data.slice(0, 5), [0, 10, 20, 30, 40], 'Level 5 sparse CSC values are expanded in MATLAB order');
assert.equal(level5.entries.find(entry => entry.path === 'flags')?.className, 'logical', 'Level 5 logical arrays retain their class');

const v73 = await parser.inspect(fixture('general-v73.mat'), 'general-v73.mat');
assert.ok(v73.entries.some(entry => entry.path === 'experiment/temperature'), 'v7.3 groups become hierarchical paths');
assert.equal(v73.entries.find(entry => entry.path === 'label').selectable, false, 'character arrays appear in overview but are not plotted');
assert.ok(v73.entries.some(entry => entry.path === 'samples_cell'), 'v7.3 cell references are dereferenced');
assert.ok(v73.entries.some(entry => entry.path === 'settings/gain'), 'v7.3 struct field references are dereferenced');
assert.equal(v73.entries.find(entry => entry.path === 'complex_signal')?.complex, true, 'v7.3 compound complex arrays are recognized');

// MCOS timetable: a Level-5 file whose only variable is a `timetable` object.
// Its datetime row-times and columns are surfaced as ordinary picker entries,
// so the timetable lists in the same "Select MATLAB arrays" dialog as plain
// arrays, with the row-times pre-selected as the time axis.
assert.equal(detectMatFileVersion(fixture('timetable-v5.mat')), '5-7', 'a timetable MAT-file is a Level 5/7 container');
const timetableInspection = await parser.inspect(fixture('timetable-v5.mat'), 'timetable-v5.mat');
assert.equal(timetableInspection.kind, 'general', 'a timetable lists in the standard MAT array picker');
const timeAxisEntry = timetableInspection.entries.find(entry => entry.path === 'time');
assert.ok(timeAxisEntry?.selectable, 'the datetime row-times are a selectable entry');
assert.equal(timeAxisEntry.className, 'datetime', 'the row-times entry is typed as datetime');
assert.equal(timeAxisEntry.datetime, true, 'the row-times entry is flagged as a datetime axis');
assert.equal(timeAxisEntry.preferredTime, true, 'the row-times entry is the preferred time axis');
const columnEntry = timetableInspection.entries.find(entry => entry.path === 'power_kW');
assert.ok(columnEntry?.selectable, 'the timetable column is a selectable numeric entry');
assert.deepEqual(columnEntry.shape, [4, 1], 'the timetable column keeps its length');

// Auto time selection uses the datetime row-times as the calendar axis.
const timetableData = parser.materialize(timetableInspection, {
    selectedIds: timetableInspection.entries.filter(entry => entry.selectable).map(entry => entry.id),
    timeMode: 'auto',
}, 'timetable-v5.mat');
assert.equal(timetableData.metadata.timeName, 'time', 'the timetable time axis keeps its dimension name');
assert.equal(timetableData.metadata.timeKind, 'datetime', 'timetable row-times import as a datetime axis');
assert.equal(timetableData.metadata.timeDisplayMode, 'calendar', 'a datetime axis defaults to the calendar display');
assert.equal(timetableData.metadata.numTimesteps, 4, 'the timetable preserves its row count');
const timetableTime = timetableData.variables.time;
assert.equal(timetableTime.timeKind, 'datetime', 'the time variable is flagged as datetime');
assert.equal(timetableTime.data[0], Date.UTC(2020, 0, 1, 0, 0, 0), 'row-times decode as epoch milliseconds');
assert.equal(timetableTime.timeOriginMs, timetableTime.data[0], 'the datetime origin is the first row time');
assert.deepEqual(Array.from(timetableData.variables.power_kW.data), [1.5, 2.5, 3.5, 4.5], 'the timetable column values are recovered in order');
assert.equal(timetableData.variables.power_kW.kind, 'variable', 'the timetable column is a plottable series');
assert.ok(timetableData.tree._children || timetableData.tree._variables, 'the timetable builds a variable tree');

// MATLAB timetable with regularly spaced row-times. MATLAB stores this
// axis compactly as origin + stepSize/sampleRate rather than one datetime per row.
const regularTimetableInspection = await parser.inspect(fixture('regular-timetable-v5.mat'), 'regular-timetable-v5.mat');
const regularDateAxis = regularTimetableInspection.entries.find(entry => entry.path === 'date');
assert.equal(regularDateAxis?.preferredTime, true, 'compact timetable row-times are the preferred time axis');
assert.equal(regularDateAxis?.datetime, true, 'compact timetable row-times retain datetime semantics');
assert.equal(regularDateAxis?.elementCount, 5, 'compact timetable row-times expand to the table row count');
assert.equal(regularDateAxis?.data[0], Date.UTC(2021, 0, 6), 'compact timetable origin is decoded');
assert.equal(regularDateAxis?.data[1] - regularDateAxis?.data[0], 60000, 'compact timetable step size is decoded');
const regularTimetableData = parser.materialize(regularTimetableInspection, {
    selectedIds: regularTimetableInspection.entries.filter(entry => entry.selectable).map(entry => entry.id),
    timeMode: 'auto',
}, 'regular-timetable-v5.mat');
assert.equal(regularTimetableData.metadata.timeName, 'date', 'the timetable uses its date dimension as time');
assert.equal(regularTimetableData.metadata.timeKind, 'datetime', 'the timetable imports a calendar axis');
assert.equal(regularTimetableData.metadata.numTimesteps, 5, 'the timetable keeps every timestamp');
assert.deepEqual(Array.from(regularTimetableData.variables.solar_kW.data), [10, 20, 30, 40, 50],
    'the timetable signal matches its expanded time axis');

// MCOS table: a plain `table` stores its fields directly on the object (not in
// a nested struct) and its datetime lives in a column rather than as row-times.
// That column should still surface as a selectable, pre-selected datetime axis.
const tableInspection = await parser.inspect(fixture('table-v5.mat'), 'table-v5.mat');
assert.equal(tableInspection.kind, 'general', 'a table lists in the standard MAT array picker');
const dateColumn = tableInspection.entries.find(entry => entry.path === 'date');
assert.equal(dateColumn?.className, 'datetime', 'a datetime column is typed as datetime');
assert.equal(dateColumn?.datetime, true, 'a datetime column can serve as a calendar axis');
assert.equal(dateColumn?.preferredTime, true, 'the first datetime column is the preferred time axis');
assert.ok(tableInspection.entries.find(entry => entry.path === 'load_MW')?.selectable, 'table numeric columns are selectable');
const tableData = parser.materialize(tableInspection, {
    selectedIds: tableInspection.entries.filter(entry => entry.selectable).map(entry => entry.id),
    timeMode: 'auto',
}, 'table-v5.mat');
assert.equal(tableData.metadata.timeName, 'date', 'the table datetime column becomes the time axis');
assert.equal(tableData.metadata.timeKind, 'datetime', 'the table datetime column drives a datetime axis');
assert.equal(tableData.variables.date.data[0], Date.UTC(2016, 0, 1, 0, 0, 0), 'the table datetime column decodes as epoch milliseconds');
assert.deepEqual(Array.from(tableData.variables.load_MW.data), [10, 20, 30], 'table numeric column values are recovered');

// A standalone datetime field (a `t` inside a struct/cell, not a table) must
// still load as a usable calendar axis alongside its numeric siblings.
const structInspection = await parser.inspect(fixture('struct-datetime-v5.mat'), 'struct-datetime-v5.mat');
assert.equal(structInspection.kind, 'general', 'a struct with a datetime field uses the standard picker');
const structTime = structInspection.entries.find(entry => entry.path === 'site.t');
assert.equal(structTime?.className, 'datetime', 'a standalone datetime field is typed as datetime');
assert.equal(structTime?.datetime, true, 'a standalone datetime field can serve as a calendar axis');
assert.equal(structTime?.preferredTime, true, 'a standalone datetime field is a preferred time axis');
assert.ok(structInspection.entries.find(entry => entry.path === 'site.P')?.selectable, 'the numeric sibling field is selectable');
const structData = parser.materialize(structInspection, {
    selectedIds: structInspection.entries.filter(entry => entry.selectable).map(entry => entry.id),
    timeMode: 'auto',
}, 'struct-datetime-v5.mat');
assert.equal(structData.metadata.timeName, 'site.t', 'the standalone datetime field becomes the time axis');
assert.equal(structData.metadata.timeKind, 'datetime', 'the standalone datetime field drives a datetime axis');
assert.equal(structData.variables['site.t'].data[0], Date.UTC(2021, 5, 1, 0, 0, 0), 'the standalone datetime decodes as epoch milliseconds');
assert.deepEqual(Array.from(structData.variables['site.P'].data), [11, 22, 33], 'the numeric sibling values are recovered');

const source = readFileSync(new URL('../src/ui/mat-variable-picker-dialog.js', import.meta.url), 'utf8');
assert.match(source, /preferredTime/, 'the array picker pre-selects a timetable row-times axis');
assert.match(source, /preferredTimeEntries/, 'the picker auto-detects among several datetime axes');
assert.match(source, /checkbox\.type = 'checkbox'/, 'MAT overview uses variable checkboxes');
assert.match(source, /matPickerOverview/, 'MAT overview includes value previews');
assert.match(source, /timeSelect/, 'MAT overview exposes time-axis selection');
assert.match(source, /mat-matrix-disclosure/, 'MAT matrices are expandable objects');
assert.match(source, /indexOption\.selected = true/, 'MAT imports use the independent sample index by default');
assert.match(source, /disclosure\.innerHTML = '<svg/, 'MAT matrix disclosure uses a chevron instead of a play symbol');
assert.match(source, /initialSelection/, 'MAT picker can restore a previous array selection');
assert.match(source, /matrixOrientations/, 'MAT matrices persist independent row or column orientation');
assert.match(source, /matPickerTransposeBlocked/, 'MAT matrix transposition respects the selected time vector');
assert.match(source, /mat-picker-filter-wrap/, 'MAT overview reuses the sidebar variable-filter control');
assert.match(source, /clearVariableFilter/, 'MAT variable filtering includes the standard clear action');
const treeMethodsSource = readFileSync(new URL('../src/app/methods/tree-methods.js', import.meta.url), 'utf8');
assert.match(treeMethodsSource, /tree-matrix-transpose/, 'independent MAT matrix nodes expose an on-the-fly transpose control');
assert.match(treeMethodsSource, /_transposeMatlabMatrixNode/, 'MAT tree transposition rebuilds matrix children');

const fileMethodsSource = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
assert.match(fileMethodsSource, /_expandMatEntries\(excelEntries\)/, 'MAT inspection runs before the loading batch');
assert.match(fileMethodsSource, /matSelection: entry\.matlab \|\| null/, 'reload preserves the chosen MATLAB arrays');
assert.match(fileMethodsSource, /_parseMatlabResultBuffer/, '.mat files use the general MATLAB dispatcher');
assert.match(fileMethodsSource, /adjustMatlabArrays/, 'loaded general MAT files can reopen the array selector');
assert.match(fileMethodsSource, /file-entry-mat-arrays/, 'general MAT file rows expose the array-selection button');
const sessionSource = readFileSync(new URL('../src/app/methods/session-methods.js', import.meta.url), 'utf8');
assert.match(sessionSource, /matlab: entry\.matlab/, 'project sessions serialize MATLAB import choices');
assert.match(sessionSource, /matSelection: fileMeta\.matlab/, 'project sessions restore MATLAB import choices without reopening the picker');
const translationsSource = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['matPickerTitle', 'matSelectArraysAction', 'matPickerBody', 'matPickerOverview', 'matPickerTime', 'matPickerTimeIndex', 'matPickerSampleDimension', 'matPickerTranspose', 'matPickerTransposeBlocked', 'matPickerIncompatibleLengths', 'matlabMatrixTranspose', 'matlabMatrixTransposeConfirm', 'matPickerImport', 'fileTypeMatlab', 'fileFormatMatlab', 'matlabFullLoadLimit', 'matlabFullLoadLimitHelp']) {
    assert.equal([...translationsSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} is translated in all languages`);
}
// The per-format refusal messages were replaced by one shared over-limit
// warning, so the "no implementation jargon" rule follows it to its new home.
const overLimitMessages = [...translationsSource.matchAll(/\bfileOverLimitBody:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
assert.equal(overLimitMessages.length, 4, 'all locales define the over-limit warning');
assert.ok(overLimitMessages.every((message) => !/\beager\b/i.test(message)), 'over-limit warnings avoid implementation jargon');
assert.ok(
    overLimitMessages.every((message) => message.includes('{format}') && message.includes('{setting}')),
    'the shared warning names both the format and the setting that governs it',
);
assert.match(fileMethodsSource, /modal-dialog-mat-too-large/, 'the MAT reader still uses the wider alert for long messages');

// ---------------------------------------------------------------------------
// Hostile Level 5 files, assembled byte by byte.
//
// Everything a MAT file says about its own size is a claim: the compressed
// element's real size is only known after inflating it, and a declared shape is
// just six bytes. All three cases below are a few hundred bytes of file that
// used to ask for tens of GB or billions of iterations.
// ---------------------------------------------------------------------------
function matElement(type, payload) {
    // miCOMPRESSED (15) is written without the usual 8-byte padding.
    const stored = type === 15 ? payload.length : Math.ceil(payload.length / 8) * 8;
    const element = new Uint8Array(8 + stored);
    const view = new DataView(element.buffer);
    view.setUint32(0, type, true);
    view.setUint32(4, payload.length, true);
    element.set(payload, 8);
    return element;
}

function matUint32Payload(values) {
    const payload = new Uint8Array(values.length * 4);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setUint32(index * 4, value, true));
    return payload;
}

function matInt32Payload(values) {
    const payload = new Uint8Array(values.length * 4);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setInt32(index * 4, value, true));
    return payload;
}

function matAsciiPayload(text, length = text.length) {
    const payload = new Uint8Array(length);
    for (let index = 0; index < text.length && index < length; index += 1) {
        payload[index] = text.charCodeAt(index);
    }
    return payload;
}

function matFloat64Payload(values) {
    const payload = new Uint8Array(values.length * 8);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setFloat64(index * 8, value, true));
    return payload;
}

function matMatrix(classId, dimensions, name, extra = []) {
    const parts = [
        matElement(6, matUint32Payload([classId, 0])),   // array flags
        matElement(5, matInt32Payload(dimensions)),      // dimensions
        matElement(1, matAsciiPayload(name)),            // name
        ...extra,
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const body = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) { body.set(part, cursor); cursor += part.length; }
    return matElement(14, body);
}

function matFile(elements) {
    const header = new Uint8Array(128);
    header.set(matAsciiPayload('MATLAB 5.0 MAT-file, synthetic security fixture'), 0);
    new DataView(header.buffer).setUint16(124, 0x0100, true);
    header[126] = 'I'.charCodeAt(0);   // little-endian marker
    header[127] = 'M'.charCodeAt(0);
    const total = 128 + elements.reduce((sum, element) => sum + element.length, 0);
    const bytes = new Uint8Array(total);
    bytes.set(header, 0);
    let cursor = 128;
    for (const element of elements) { bytes.set(element, cursor); cursor += element.length; }
    return bytes.buffer;
}

{
    const matFileParser = new MatlabMatFile(new MatParser());

    // 1) Decompression bomb, spread over several elements.
    //
    // The budget is a fixed ceiling, not a compression ratio, so a bomb has to be
    // big enough to reach it — and that is the point. A ratio cannot separate a
    // bomb from real data: measured on 8 MB of Float64, a constant signal
    // compresses 683:1 and an all-NaN one 683:1, which a result file full of held
    // parameters and NaN padding hits routinely. The limit asks whether the data
    // fits in memory and refuses either kind once it does not.
    //
    // Eight elements of 200 MB each rather than one of 1.6 GB: it keeps the test
    // cheap, and it is the case the budget exists for. Any per-element check would
    // pass all eight — only a total carried across the file catches them.
    const { zlibSync } = await import('fflate');
    const oneBlock = zlibSync(new Uint8Array(200 * MB), { level: 6 });
    const bomb = matFile(Array.from({ length: 8 }, () => matElement(15, oneBlock)));
    assert.ok(bomb.byteLength < 8 * MB, 'the bomb is still a small file');
    await assert.rejects(
        () => matFileParser.inspect(bomb, 'bomb.mat'),
        (err) => /decompresses to more than/.test(err.message)
            && !/corrupt|not a genuine/i.test(err.message),
        'inflated bytes are counted across the whole file, and refused without calling it corrupt',
    );

    // The counterpart, and the reason the limit is not a ratio: a held parameter
    // stored as a full-length trace is a real thing in a simulation result, and it
    // compresses 683:1 — indistinguishable from the bomb above by ratio alone.
    // 143 KB of file, 95 MB of constant signal. A 20:1 rule with a 64 MB floor
    // refused this, and told its owner the file was corrupt.
    const held = new Float64Array(12_500_000).fill(42);
    const heldMatrix = matMatrix(6, [1, held.length], 'held_parameter', [
        matElement(9, new Uint8Array(held.buffer)),
    ]);
    const heldFile = matFile([matElement(15, zlibSync(heldMatrix, { level: 6 }))]);
    assert.ok(heldFile.byteLength < MB, 'the honest file is small too');
    const heldInspection = await matFileParser.inspect(heldFile, 'held-parameter.mat');
    assert.equal(
        heldInspection.entries.find(entry => entry.path === 'held_parameter')?.elementCount,
        held.length,
        'a highly compressible but legitimate signal is read, not refused',
    );

    // An empty compressed element carries nothing and is skipped, rather than
    // failing the whole file the way unzlibSync's "invalid zlib data" did.
    const emptyCompressed = matFile([
        matElement(15, new Uint8Array(0)),
        matMatrix(6, [1, 3], 'kept', [matElement(9, matFloat64Payload([7, 8, 9]))]),
    ]);
    const afterEmpty = await matFileParser.inspect(emptyCompressed, 'empty-element.mat');
    assert.ok(
        afterEmpty.entries.some(entry => (entry.path || entry.name) === 'kept'),
        'the variable after an empty compressed element is still read',
    );

    // 2) Sparse matrix declaring 2 × 2^30 elements: a valid JS array length, and
    //    tens of GB of dense fill from a file with no data in it at all.
    const sparse = matFile([matMatrix(5, [2, 2 ** 30], 'huge')]);
    await assert.rejects(
        () => matFileParser.inspect(sparse, 'sparse.mat'),
        /more than this reader expands/,
        'a sparse shape larger than the dense expansion limit is refused',
    );

    // 3) Struct declaring 65535 × 65535 instances with no instance data: the loop
    //    used to run ~4.3e9 times on the main thread. Bounded by what is there,
    //    it now returns immediately — so this test finishing IS the assertion.
    const struct = matFile([matMatrix(2, [65535, 65535], 'fake', [
        matElement(5, matInt32Payload([32])),        // field name length
        matElement(1, matAsciiPayload('a', 32)),     // one field, no instances
    ])]);
    const started = performance.now();
    await matFileParser.inspect(struct, 'struct.mat').catch(() => {});
    assert.ok(
        performance.now() - started < 5000,
        'a struct with an inflated declared shape does not spin on the declaration',
    );

    // The other half of that bound: a WELL-FORMED struct array must still be read
    // whole. No fixture has a struct array with more than one instance, so
    // bounding the loop by the instance data present was unverified against the
    // case it must not break. A 1x2 struct with two fields carries 4 submatrices,
    // and all four values have to come back.
    const structArray = matFile([matMatrix(2, [1, 2], 'sensors', [
        matElement(5, matInt32Payload([32])),
        matElement(1, new Uint8Array([...matAsciiPayload('temp', 32), ...matAsciiPayload('flow', 32)])),
        matMatrix(6, [1, 3], '', [matElement(9, matFloat64Payload([1, 2, 3]))]),
        matMatrix(6, [1, 3], '', [matElement(9, matFloat64Payload([10, 20, 30]))]),
        matMatrix(6, [1, 3], '', [matElement(9, matFloat64Payload([4, 5, 6]))]),
        matMatrix(6, [1, 3], '', [matElement(9, matFloat64Payload([40, 50, 60]))]),
    ])]);
    const arrayInspection = await matFileParser.inspect(structArray, 'struct-array.mat');
    assert.deepEqual(
        arrayInspection.entries.map(entry => entry.path).sort(),
        ['sensors(1).flow', 'sensors(1).temp', 'sensors(2).flow', 'sensors(2).temp'],
        'both instances of a two-field struct array are read',
    );
    const arrayData = matFileParser.materialize(arrayInspection, {
        selectedIds: arrayInspection.entries.filter(entry => entry.selectable).map(entry => entry.id),
        timeMode: 'index',
    }, 'struct-array.mat');
    assert.deepEqual(
        Array.from(arrayData.variables['sensors(2).flow'].data),
        [40, 50, 60],
        'the last instance keeps its own values rather than the first instance\'s',
    );
}

console.log('MATLAB MAT parser tests passed.');
