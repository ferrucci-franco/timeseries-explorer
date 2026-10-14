// Tables whose layout the automatic reading used to get wrong, and the two
// things a reader can now set about any table: which folders its columns go
// in, and a settings file to read the next one the same way.
//
// The file that started it is a PV-monitoring daily report (an Excel sheet):
// dates as text "08.10.2026 00:05", units in the second row ("[A]", "[W/m²]"),
// and columns named "Courant AC L1 | Primo 5.0-1 (1)" — the device AFTER the
// separator, with a dot in its name. It came in with an index for a time axis,
// the units row taken for the header, and folders cut at the "5.0".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

import CsvParser from '../src/parsers/csv-parser.js';
import MatParser from '../src/parsers/mat-parser.js';
import { detectCsvTimeAxis, parseCsvTimeValue } from '../src/parsers/csv-time-detection.js';
import {
    buildCsvTree,
    normalizeCsvGrouping,
    resolveCsvGrouping,
    splitCsvVariableName,
    summarizeCsvGrouping,
    treeForDerivedData,
} from '../src/parsers/csv-tree-grouping.js';
import { csvTextToBuffer, nonEmptySheetNames, readWorkbook, sheetToCsvText } from '../src/parsers/excel-workbook.js';
import CsvParsingPreviewDialog from '../src/ui/csv-parsing-preview-dialog.js';

const parser = new CsvParser();
const toBuffer = text => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const folderNames = tree => Object.keys(tree._children).sort();
const leaves = node => Object.keys(node._variables).sort();

// ─── Dates written with dots ───────────────────────────────────────────────
{
    const rows = [['08.10.2026 00:00', '1'], ['08.10.2026 00:05', '2'], ['08.10.2026 00:10', '3']];
    const source = detectCsvTimeAxis(['Date et heure', 'P'], rows);
    assert.equal(source.ok, true);
    assert.equal(source.kind, 'datetime', 'dd.MM.yyyy HH:mm is a date, not an index');
    assert.equal(source.strategy, 'dot-date');
    assert.equal(source.format.dateOrder, 'DMY', 'a dotted date is day-first unless the data says otherwise');
    assert.equal(source.parse(rows[1]), Date.UTC(2026, 9, 8, 0, 5));
    assert.equal(parseCsvTimeValue(source, rows[2]), Date.UTC(2026, 9, 8, 0, 10),
        'the serialized source parses the same instants as the closure');

    // Year first, the Hungarian/East-Asian way, and a two-digit year.
    const ymd = detectCsvTimeAxis(['t', 'v'], [['2026.10.08 12:00', '1'], ['2026.10.09 12:00', '2'], ['2026.10.10 12:00', '3']]);
    assert.equal(ymd.strategy, 'dot-date');
    assert.equal(ymd.parse(['2026.10.09 12:00']), Date.UTC(2026, 9, 9, 12));
    const shortYear = detectCsvTimeAxis(['Datum', 'v'], [['31.12.25', '1'], ['01.01.26', '2'], ['02.01.26', '3']]);
    assert.equal(shortYear.strategy, 'dot-date');
    assert.equal(shortYear.parse(['01.01.26']), Date.UTC(2026, 0, 1));

    // Decimal numbers and version-like strings are not dates.
    assert.notEqual(detectCsvTimeAxis(['x', 'v'], [['1.5', '1'], ['2.5', '2'], ['3.5', '3']]).strategy, 'dot-date');
    assert.notEqual(detectCsvTimeAxis(['x', 'v'], [['1.2.3', '1'], ['1.2.4', '2'], ['1.2.5', '3']]).strategy, 'dot-date');

    // Separate date and clock columns with a dotted date.
    const split = detectCsvTimeAxis(['Datum', 'Uhrzeit', 'v'], [
        ['08.10.2026', '00:00', '1'], ['08.10.2026', '00:05', '2'], ['08.10.2026', '00:10', '3'],
    ]);
    assert.equal(split.mode, 'split');
    assert.equal(split.format.dotSeparator, true);
    assert.equal(parseCsvTimeValue(split, ['08.10.2026', '00:05', '2']), Date.UTC(2026, 9, 8, 0, 5));
}

// The CSV fixture: semicolons, decimal commas, dotted dates.
{
    const text = readFileSync('test-files/csv/date-parsing-options/17_dot_dmy_datetime_semicolon.csv');
    const data = await parser.parse(text.buffer.slice(text.byteOffset, text.byteOffset + text.byteLength));
    assert.equal(data.metadata.timeKind, 'datetime');
    assert.equal(data.metadata.numTimesteps, 6);
    assert.equal(data.metadata.timeOriginMs, Date.UTC(2026, 9, 8));
    assert.equal(data.variables.Temperatura.data[0], 23.5);
}

// ─── Folders ───────────────────────────────────────────────────────────────
{
    const devices = ['Courant | Primo 5.0-1 (1)', 'Courant | Primo 6.0-1 (1)', 'Énergie | Primo 5.0-1 (1)',
        'Énergie | Primo 6.0-1 (1)', 'Tension | Primo 5.0-1 (1)', 'Tension | Primo 6.0-1 (1)',
        'Isolation | Sensor Card / Box (1)', 'Production photovoltaïque'];
    const auto = resolveCsvGrouping(null, devices);
    assert.deepEqual(auto, { mode: 'separator', separator: '|', position: 'suffix', detected: true },
        'the device repeats most, so it is the folder, even written after the separator');
    // As many quantities as devices: nothing to tell them apart, so reading order.
    assert.equal(resolveCsvGrouping(null, ['P | X', 'Q | X', 'P | Y', 'Q | Y']).position, 'prefix');
    assert.deepEqual(splitCsvVariableName(devices[0], auto), { path: ['Primo 5.0-1 (1)'], leaf: 'Courant' });
    assert.deepEqual(splitCsvVariableName('Production photovoltaïque', auto),
        { path: [], leaf: 'Production photovoltaïque' }, 'a name without the separator stays at the top');
    assert.deepEqual(summarizeCsvGrouping(devices, auto), {
        folders: [
            { name: 'Primo 5.0-1 (1)', count: 3 },
            { name: 'Primo 6.0-1 (1)', count: 3 },
            { name: 'Sensor Card / Box (1)', count: 1 },
        ],
        topLevel: 1,
    });

    // Device first: the folder is the prefix.
    const prefixed = ['Inv1 | P', 'Inv1 | Q', 'Inv1 | U', 'Inv2 | P', 'Inv2 | Q', 'Inv2 | U'];
    assert.equal(resolveCsvGrouping({ mode: 'auto' }, prefixed).position, 'prefix');
    // A separator whose sides never repeat folds nothing.
    assert.equal(resolveCsvGrouping(null, ['a | x', 'b | y', 'c | z']).mode, 'dots');

    // The reader's choices.
    assert.equal(resolveCsvGrouping({ mode: 'none' }, devices).mode, 'none');
    assert.deepEqual(splitCsvVariableName('a.b.c', { mode: 'none' }), { path: [], leaf: 'a.b.c' });
    const forcedPrefix = resolveCsvGrouping({ mode: 'separator', separator: '|', position: 'prefix' }, devices);
    assert.deepEqual(splitCsvVariableName(devices[0], forcedPrefix), { path: ['Courant'], leaf: 'Primo 5.0-1 (1)' });
    const dash = resolveCsvGrouping({ mode: 'separator', separator: ' - ' }, ['Site A - P', 'Site A - Q', 'Site B - P']);
    assert.deepEqual(splitCsvVariableName('Site A - P', dash), { path: ['Site A'], leaf: 'P' });
    assert.deepEqual(normalizeCsvGrouping({ mode: 'bogus', position: 'up', separator: 3 }),
        { mode: 'auto', separator: '', position: 'auto' });
}

// Dotted names: Modelica paths are still cut, numbers and abbreviations not.
{
    const dots = { mode: 'dots' };
    const legacy = new MatParser();
    for (const name of ['motor.inertia.phi', 'bus[2].v', 'a.b.der(c.d)', 'der(x)', 'x_1.y', 'Sensor 1.Voltage']) {
        assert.deepEqual(splitCsvVariableName(name, dots), legacy.splitModelicaName(name),
            `${name}: a Modelica-style path is cut as it always was`);
    }
    assert.deepEqual(splitCsvVariableName('Primo 5.0-1 (1)', dots), { path: [], leaf: 'Primo 5.0-1 (1)' });
    assert.deepEqual(splitCsvVariableName('Temp. ambiante', dots), { path: [], leaf: 'Temp. ambiante' });
    assert.deepEqual(splitCsvVariableName('No.1', dots), { path: [], leaf: 'No.1' });
    assert.deepEqual(splitCsvVariableName('Courant | Primo 5.0-1 (1)', dots),
        { path: [], leaf: 'Courant | Primo 5.0-1 (1)' });
}

// The tree: time axis at the top, no leaf hidden by a twin.
{
    const variables = {
        time: { name: 'time', kind: 'abscissa' },
        'P | A': { name: 'P | A', kind: 'variable' },
        'Q | A': { name: 'Q | A', kind: 'variable' },
        'P | B': { name: 'P | B', kind: 'variable' },
        'P|B': { name: 'P|B', kind: 'variable' },
    };
    const resolved = resolveCsvGrouping({ mode: 'separator', separator: '|', position: 'suffix' }, Object.keys(variables));
    const tree = buildCsvTree(variables, resolved);
    assert.ok(tree._variables.time, 'the time axis stays at the top level');
    assert.deepEqual(folderNames(tree), ['A', 'B']);
    assert.deepEqual(leaves(tree._children.B), ['P', 'P|B'], 'a leaf that would collide keeps its full name');
    assert.equal(tree._children.A._variables.P.name, 'P | A', 'the variable keeps its full name');

    // A dataset computed from the table keeps its folders.
    const sourceData = { metadata: { csvGrouping: resolved } };
    const metadata = {};
    const derived = treeForDerivedData(sourceData, metadata, variables, () => assert.fail('not a Modelica tree'));
    assert.deepEqual(folderNames(derived), ['A', 'B']);
    assert.deepEqual(metadata.csvGrouping, resolved);
    let fellBack = false;
    treeForDerivedData({ metadata: {} }, {}, variables, () => { fellBack = true; return {}; });
    assert.ok(fellBack, 'anything else gets the tree of its own format');
}

// ─── The report itself, through the Excel path ─────────────────────────────
const workbookBytes = readFileSync('test-files/excel/units-row-dotted-dates-device-suffix.xlsx');
const workbook = readWorkbook(XLSX, workbookBytes.buffer.slice(workbookBytes.byteOffset, workbookBytes.byteOffset + workbookBytes.byteLength));
const reportCsv = sheetToCsvText(workbook, nonEmptySheetNames(workbook)[0]);
const reportBuffer = csvTextToBuffer(reportCsv);
{
    const data = await parser.parse(reportBuffer);
    const meta = data.metadata;
    assert.equal(meta.timeKind, 'datetime', 'the dates are read as dates');
    assert.equal(meta.timeName, 'Date et heure');
    assert.equal(meta.numTimesteps, 288);
    assert.equal(meta.timeOriginMs, Date.UTC(2026, 9, 8));
    assert.equal(meta.hasHeader, true);
    assert.equal(meta.skippedRows, 0, 'the first row is the header, not preamble');
    assert.equal(meta.unitRowIndex, 1, 'the second row is the units row');

    const current = data.variables['Courant AC L1 | Primo 5.0-1 (1)'];
    assert.ok(current, `full names are kept (has: ${Object.keys(data.variables).join(', ')})`);
    assert.equal(current.description, '[A]', 'the unit comes from the units row, brackets and all unwrapped');
    assert.equal(data.variables['Isolation | Sensor Card / Box (1)'].description, '[W/m²]');
    assert.ok(data.variables['Production photovoltaïque'], 'the column with no device is there');

    assert.deepEqual(folderNames(data.tree), ['Primo 5.0-1 (1)', 'Primo 6.0-1 (1)', 'Sensor Card / Box (1)']);
    assert.deepEqual(leaves(data.tree._children['Primo 5.0-1 (1)']), ['Courant AC L1', 'Tension DC MPP1', 'Énergie']);
    assert.deepEqual(leaves(data.tree), ['Date et heure', 'Production photovoltaïque']);

    const profile = parser.inspectSample(reportBuffer, { maxRows: 700 });
    assert.equal(profile.unitsMode, 'row');
    assert.equal(profile.unitRowIndex, 1);
    assert.equal(profile.timeSource.strategy, 'dot-date');
    assert.deepEqual(profile.headers.map(h => h.name), profile.rawHeaders,
        'the profile names the columns exactly as written');

    // "Flat" and a forced prefix, through a saved profile.
    const flat = await parser.parseWithProfile(reportBuffer, { ...profile, profileSource: 'user', grouping: { mode: 'none' } });
    assert.deepEqual(folderNames(flat.tree), []);
    assert.equal(leaves(flat.tree).length, Object.keys(flat.variables).length);
    assert.equal(flat.metadata.csvGrouping.mode, 'none');
    const byQuantity = await parser.parseWithProfile(reportBuffer, {
        ...profile, profileSource: 'user', grouping: { mode: 'separator', separator: '|', position: 'prefix' },
    });
    assert.ok(byQuantity.tree._children['Courant AC L1'], 'folders by quantity when asked');
    assert.deepEqual(leaves(byQuantity.tree._children['Courant AC L1']), ['Primo 5.0-1 (1)', 'Primo 6.0-1 (1)']);
    assert.equal(byQuantity.variables['Courant AC L1 | Primo 5.0-1 (1)'].description, '[A]',
        'a saved profile keeps the units from the row');
}

// Files read before keep reading the same way.
{
    const modelica = await parser.parse(toBuffer('time,motor.phi,motor.w,load.tau\n0,1,2,3\n1,2,3,4\n2,3,4,5\n'));
    assert.deepEqual(folderNames(modelica.tree), ['load', 'motor']);
    assert.deepEqual(leaves(modelica.tree._children.motor), ['phi', 'w']);
    const plain = await parser.parse(toBuffer('Time (s),Voltage (V),Current (A)\n0,1,2\n1,2,3\n2,3,4\n'));
    assert.deepEqual(Object.keys(plain.variables), ['Time', 'Voltage', 'Current'],
        'inline units are still cut from the title when there is no units row');
    assert.equal(plain.metadata.unitRowIndex, null);
    assert.equal(parser.inspectSample(toBuffer('Time (s),Voltage (V)\n0,1\n1,2\n2,3\n'), {}).unitsMode, undefined,
        'a profile says nothing about units unless a units row was found');
}

// ─── The dialog: folders and a settings file ───────────────────────────────
function openDialog(buffer, csvProfile) {
    const dialog = new CsvParsingPreviewDialog({ parser, sampleBuffer: buffer, csvProfile, title: 'Rapport journalier.xlsx' });
    dialog.preview = parser.inspectPreview(buffer, { maxRows: 50, delimiter: dialog.state.delimiter, encoding: dialog.state.encoding });
    dialog.state.lineLimit = 50;
    dialog._rebuildProfile();
    return dialog;
}
{
    const autoProfile = parser.inspectSample(reportBuffer, { maxRows: 700 });
    const dialog = openDialog(reportBuffer, autoProfile);
    assert.equal(dialog.state.unitsMode, 'row', 'the dialog opens with the units row it was given');
    assert.equal(dialog.validation.ok, true, dialog.validation.messages.join('; '));
    assert.equal(dialog.resultProfile.timeSource.strategy, 'dot-date');
    assert.equal(dialog.resultProfile.headers[4].name, 'Courant AC L1 | Primo 5.0-1 (1)');
    assert.equal(dialog.resultProfile.headers[4].description, '[A]', 'a bracketed unit is not bracketed twice');
    assert.deepEqual(dialog.resultProfile.grouping, { mode: 'auto', separator: '', position: 'auto' });
    const names = dialog._groupingVariableNames();
    assert.equal(names.length, 9, 'the time column is not a variable to fold');
    assert.match(dialog._folderSummaryText(names, resolveCsvGrouping(dialog.state.grouping, names)), /Primo 5\.0-1 \(1\) \(3\)/);

    // Change things, save, and load into a dialog on another file.
    dialog.state.grouping = { mode: 'none', separator: '', position: 'auto' };
    dialog.state.ignoredColumns = [2];
    dialog.state.columnOverrides = { 3: { name: 'PV' } };
    dialog._rebuildProfile();
    assert.deepEqual(dialog.resultProfile.grouping, { mode: 'none', separator: '', position: 'auto' });
    const saved = JSON.parse(JSON.stringify(dialog._settingsSnapshot()));
    assert.equal(saved.format, 'timeseries-explorer-parsing-settings');
    assert.equal(saved.columnCount, 10);
    assert.equal(saved.settings.unitsMode, 'row');
    assert.ok(!('sampleRows' in saved.settings) && !('sampleRows' in saved), 'no data travels in a settings file');
    assert.equal(dialog._settingsFileName(), 'Rapport journalier.parsing.json');

    const next = openDialog(reportBuffer, parser.inspectSample(reportBuffer, { maxRows: 700 }));
    next.applySettingsFile(saved, 'Rapport journalier.parsing.json');
    assert.deepEqual(next.resultProfile.grouping, { mode: 'none', separator: '', position: 'auto' });
    assert.deepEqual(next.resultProfile.ignoredColumns, [2]);
    assert.equal(next.resultProfile.headers[3].name, 'PV');
    assert.equal(next.validation.ok, true);
    const reparsed = await parser.parseWithProfile(reportBuffer, next.resultProfile);
    assert.deepEqual(folderNames(reparsed.tree), []);
    assert.ok(reparsed.variables.PV && !reparsed.variables['Isolation | Sensor Card / Box (1)']);

    // Another table: the settings apply, and the column count is called out.
    const other = openDialog(toBuffer('t;a;b\n08.10.2026 00:00;1;2\n08.10.2026 00:05;3;4\n08.10.2026 00:10;5;6\n'),
        parser.inspectSample(toBuffer('t;a;b\n08.10.2026 00:00;1;2\n08.10.2026 00:05;3;4\n08.10.2026 00:10;5;6\n'), {}));
    other.applySettingsFile({ ...saved, settings: { ...saved.settings, delimiter: ';', unitsMode: 'none', unitRowIndex: null, dataStartIndex: 1, ignoredColumns: [], columnOverrides: {} } });
    assert.ok(other.validation.warnings.some(w => /10/.test(w) && /3/.test(w)), 'a settings file made for another layout is flagged');

    assert.throws(() => next.applySettingsFile({ format: 'something-else', settings: {} }), /parsing-settings/);
    assert.throws(() => next.applySettingsFile(null));
}

console.log('CSV folder, units-row, dotted-date and settings-file checks passed.');
