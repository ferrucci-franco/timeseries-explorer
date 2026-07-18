import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MatParser from '../src/parsers/mat-parser.js';
import MatlabMatFile, { detectMatFileVersion } from '../src/parsers/matlab-mat-file.js';

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

const source = readFileSync(new URL('../src/ui/mat-variable-picker-dialog.js', import.meta.url), 'utf8');
assert.match(source, /checkbox\.type = 'checkbox'/, 'MAT overview uses variable checkboxes');
assert.match(source, /matPickerOverview/, 'MAT overview includes value previews');
assert.match(source, /timeSelect/, 'MAT overview exposes time-axis selection');
assert.match(source, /sampleAxisSelect/, 'MAT overview lets the user choose rows or columns as samples');

const fileMethodsSource = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
assert.match(fileMethodsSource, /_expandMatEntries\(excelEntries\)/, 'MAT inspection runs before the loading batch');
assert.match(fileMethodsSource, /matSelection: entry\.matlab \|\| null/, 'reload preserves the chosen MATLAB arrays');
assert.match(fileMethodsSource, /_parseMatlabResultBuffer/, '.mat files use the general MATLAB dispatcher');
const sessionSource = readFileSync(new URL('../src/app/methods/session-methods.js', import.meta.url), 'utf8');
assert.match(sessionSource, /matlab: entry\.matlab/, 'project sessions serialize MATLAB import choices');
assert.match(sessionSource, /matSelection: fileMeta\.matlab/, 'project sessions restore MATLAB import choices without reopening the picker');
const translationsSource = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['matPickerTitle', 'matPickerBody', 'matPickerOverview', 'matPickerTime', 'matPickerSampleDimension', 'matPickerImport', 'fileTypeMatlab', 'matTooLarge']) {
    assert.equal([...translationsSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} is translated in all languages`);
}

console.log('MATLAB MAT parser tests passed.');
