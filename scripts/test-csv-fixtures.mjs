#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import duckdbPkg from 'duckdb';
import CsvParser from '../src/parsers/csv-parser.js';
import { parseCsvTimeValue } from '../src/parsers/csv-time-detection.js';
import CsvParsingPreviewDialog from '../src/ui/csv-parsing-preview-dialog.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';
import {
    closeDuckDbConnection,
    closeDuckDbDatabase,
    csvReadExpr,
    csvColumnSpecs,
    projectionSql,
    rowFilterSql,
    runDuckDb,
    sqlPath,
    timeInfoFromProfile,
} from '../src/data/csv-to-parquet-core.js';

const parser = new CsvParser();
const { Database } = duckdbPkg;

function arrayBufferFromNodeBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function fixtureFiles() {
    const files = [];
    const csvDir = 'test-files/csv';
    if (existsSync(csvDir)) {
        for (const name of readdirSync(csvDir)) {
            if (name.startsWith('.')) continue;
            if (name.toLowerCase().endsWith('.parquet')) continue;
            const path = join(csvDir, name);
            if (statSync(path).isFile()) files.push(path);
        }
    }
    const datacenters = 'bench/data/datacenters_load_2030.csv';
    if (existsSync(datacenters)) files.push(datacenters);
    return files;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertParsedData(path, data, profile) {
    assert(data?.metadata, `${path}: missing metadata`);
    assert(data.metadata.numTimesteps > 0, `${path}: no time steps parsed`);
    const time = data.variables?.[data.metadata.timeName];
    assert(time?.data?.length === data.metadata.numTimesteps, `${path}: time length mismatch`);
    for (const value of time.data) {
        assert(Number.isFinite(Number(value)), `${path}: non-finite time value`);
    }
    for (const [name, variable] of Object.entries(data.variables || {})) {
        if (variable.kind === 'parameter') continue;
        assert(variable.data?.length === data.metadata.numTimesteps, `${path}: ${name} length mismatch`);
    }
    if (data.metadata.timeKind === 'datetime') {
        assert(Number.isFinite(data.metadata.timeOriginMs), `${path}: missing datetime origin`);
    }
    assert(profile?.timeSource?.ok, `${path}: sample inspection did not detect a time source`);
}

function testPlotlyCalendarTypedArrayConversion() {
    class Dummy {}
    installPlotDataMethods(Dummy);
    const plotter = new Dummy();
    plotter.files = new Map([[
        'f1',
        {
            transform: {},
            data: {
                metadata: { timeName: 'time' },
                variables: {
                    time: { name: 'time', timeKind: 'datetime', timeDisplayMode: 'calendar', data: new Float64Array([1893456000000]) },
                },
            },
        },
    ]]);
    plotter._getTimeVar = () => plotter.files.get('f1').data.variables.time;
    const converted = plotter._plotlyTimeArray('f1', new Float64Array([1893456000000, 1893459600000]), plotter._getTimeVar());
    assert(Array.isArray(converted), 'calendar typed-array conversion must return a JS Array');
    assert(converted[0] === '2030-01-01T00:00:00.000Z', 'calendar typed-array conversion returned the wrong first timestamp');
}

async function testCsvRowFilter() {
    const csv = [
        'Source,Year,Mean',
        'GCAG,1850,-0.4',
        'GISTEMP,1850,-0.2',
        'GCAG,1851,-0.3',
    ].join('\n');
    const baseProfile = {
        delimiter: ',',
        decimalSeparator: 'auto',
        hasHeader: true,
        headerIndex: 0,
        dataStartIndex: 1,
        rawHeaders: ['Source', 'Year', 'Mean'],
        headers: [
            { name: 'Source', description: '' },
            { name: 'Year', description: '' },
            { name: 'Mean', description: '' },
        ],
        timeSource: {
            ok: true,
            kind: 'datetime',
            mode: 'parts',
            strategy: 'parts',
            sourceIndexes: [1],
            name: 'time',
            description: '[datetime]',
            format: { parts: { year: 1 } },
        },
    };
    const buffer = arrayBufferFromNodeBuffer(Buffer.from(csv));
    const gcag = await parser.parseWithProfile(buffer, {
        ...baseProfile,
        rowFilter: { enabled: true, columnIndex: 0, operator: '==', value: 'GCAG' },
    });
    assert(gcag.metadata.numTimesteps === 2, 'CSV row filter == should keep two GCAG rows');
    assert(gcag.metadata.skippedFilteredRows === 1, 'CSV row filter == should report one filtered row');
    assert(gcag.variables.Source.data.every(value => value === 'GCAG'), 'CSV row filter == kept the wrong source');

    const notGcag = await parser.parseWithProfile(buffer, {
        ...baseProfile,
        rowFilter: { enabled: true, columnIndex: 0, operator: '!=', value: 'GCAG' },
    });
    assert(notGcag.metadata.numTimesteps === 1, 'CSV row filter != should keep one row');
    assert(notGcag.variables.Source.data[0] === 'GISTEMP', 'CSV row filter != kept the wrong source');

    const append = parser.parseRowsWithProfile('GISTEMP,1852,-0.1\n', {
        ...baseProfile,
        rowFilter: { enabled: true, columnIndex: 0, operator: '==', value: 'GCAG' },
    }, { startRowIndex: 2 });
    assert(append.timeValues.length === 0, 'CSV row filter should ignore non-matching appended rows');
}

function testPartialDateCustomPattern() {
    const source = {
        ok: true,
        kind: 'datetime',
        mode: 'single',
        strategy: 'custom-format',
        sourceIndexes: [0],
        format: { pattern: 'yyyy-MM' },
    };
    const parsed = parseCsvTimeValue(source, ['1949-01'], 0, ',');
    assert(new Date(parsed).toISOString() === '1949-01-01T00:00:00.000Z', 'Custom yyyy-MM should assume day 01');

    const ampmSource = {
        ok: true,
        kind: 'datetime',
        mode: 'single',
        strategy: 'custom-format',
        sourceIndexes: [0],
        format: { pattern: 'MM/dd/yyyy hh:mm AM/PM' },
    };
    const ampm = parseCsvTimeValue(ampmSource, ['01/31/2024 01:45 PM'], 0, ',');
    assert(new Date(ampm).toISOString() === '2024-01-31T13:45:00.000Z', 'Custom AM/PM pattern should parse 12-hour time');
}

function testCsvPreviewHiddenRowsDoNotChangeProfile() {
    const path = 'test-files/csv/09_tesla_stock_dirty.csv';
    const buffer = readFileSync(path);
    const ab = arrayBufferFromNodeBuffer(buffer);
    const autoProfile = parser.inspectSample(ab, { maxRows: 700 });
    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: ab,
        csvProfile: autoProfile,
        title: '09_tesla_stock_dirty.csv',
    });
    dialog.preview = parser.inspectPreview(ab, {
        maxRows: 10,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog._rebuildProfile();
    assert(dialog.validation.ok, 'CSV preview should remain valid when preamble rows are hidden');
    assert(dialog.resultProfile.rawHeaders[0] === 'date', 'CSV preview should keep the real header row');
    assert(dialog.resultProfile.dataStartIndex === 1, 'CSV preview should keep the first data row index');
    assert(dialog.validation.totalDataRows === 9, 'CSV preview should evaluate all visible data rows after the header');
    assert(dialog.validation.validTimeRows === 8, 'CSV preview should only mark the dirty time row invalid');
    const headerEntry = dialog._allPreviewRowEntries().find(entry => entry.logicalIndex === 0);
    assert(headerEntry && !headerEntry.isPreamble, 'CSV preview should not mark the header row as preamble');
    assert(dialog._previewRowEntries().some(entry => entry.logicalIndex === 0), 'CSV preview should keep the header visible when hiding preamble rows');
}

function testCsvPreviewHidePreambleKeepsHeader() {
    const path = 'test-files/csv/date-parsing-options/08_dirty_preamble_blank_lines.csv';
    const buffer = readFileSync(path);
    const ab = arrayBufferFromNodeBuffer(buffer);
    const autoProfile = parser.inspectSample(ab, { maxRows: 50 });
    assert(autoProfile.headerIndex === 3, 'Dirty preamble fixture header should be detected on file row 4');
    assert(autoProfile.dataStartIndex === 4, 'Dirty preamble fixture data should start on file row 5');
    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: ab,
        csvProfile: autoProfile,
        title: '08_dirty_preamble_blank_lines.csv',
    });
    dialog.preview = parser.inspectPreview(ab, {
        maxRows: 10,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog._rebuildProfile();
    const visibleLogicalIndexes = dialog._previewRowEntries()
        .filter(entry => !entry.isEmpty)
        .map(entry => entry.logicalIndex);
    assert(!visibleLogicalIndexes.includes(0), 'CSV preview should hide the first preamble row');
    assert(!visibleLogicalIndexes.includes(1), 'CSV preview should hide the second preamble row');
    assert(!visibleLogicalIndexes.includes(2), 'CSV preview should hide blank preamble rows');
    assert(visibleLogicalIndexes.includes(3), 'CSV preview should keep the header row visible');
}

async function testCsvPreviewDirtyPreambleCustomDatePattern() {
    const path = 'test-files/csv/date-parsing-options/08_dirty_preamble_blank_lines.csv';
    const buffer = readFileSync(path);
    const ab = arrayBufferFromNodeBuffer(buffer);
    const autoProfile = parser.inspectSample(ab, { maxRows: 50 });
    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: ab,
        csvProfile: autoProfile,
        title: '08_dirty_preamble_blank_lines.csv',
    });
    dialog.preview = parser.inspectPreview(ab, {
        maxRows: 20,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog.state.timeMode = 'single';
    dialog.state.timeColumn = 0;
    dialog.state.timeFormat = 'custom';
    dialog.state.customDatetimePattern = 'yyyy-MM-dd';
    dialog._rebuildProfile();
    assert(dialog.resultProfile.headerIndex === 3, 'Dirty custom date profile should keep the header on file row 4');
    assert(dialog.resultProfile.dataStartIndex === 4, 'Dirty custom date profile should keep data start on file row 5');
    assert(dialog.validation.ok, 'Dirty custom date profile should validate despite one invalid data row');
    assert(dialog.validation.validTimeRows === 3, 'Dirty custom date profile should find three valid date rows');
    assert(dialog.validation.totalDataRows === 4, 'Dirty custom date profile should keep the invalid row visible for review');

    const data = await parser.parseWithProfile(ab, dialog.resultProfile);
    assert(data.variables.value?.dataType !== 'string', 'Invalid time rows should not make numeric value columns string');
    assert(Array.from(data.variables.value.data).every(Number.isFinite), 'Dirty custom date value column should contain only finite numeric data');

    const specs = csvColumnSpecs(dialog.resultProfile);
    assert(specs.find(spec => spec.name === 'value')?.type === 'DOUBLE', 'DuckDB CSV type inference should ignore invalid time rows');
}

async function testCsvNumericColumnsTolerateInvalidCells() {
    const csv = [
        'date,value',
        '2024-01-01,10',
        '2024-01-02,N/A',
        '2024-01-03,12',
    ].join('\n');
    const buffer = arrayBufferFromNodeBuffer(Buffer.from(csv));
    const profile = parser.inspectSample(buffer, { maxRows: 20 });
    const dialog = new CsvParsingPreviewDialog({ parser, sampleBuffer: buffer, csvProfile: profile, title: 'numeric-invalid.csv' });
    dialog.preview = parser.inspectPreview(buffer, { maxRows: 10, delimiter: dialog.state.delimiter, encoding: dialog.state.encoding });
    dialog.state.timeMode = 'single';
    dialog.state.timeColumn = 0;
    dialog.state.timeFormat = 'custom';
    dialog.state.customDatetimePattern = 'yyyy-MM-dd';
    dialog._rebuildProfile();

    assert(dialog.validation.ok, 'A non-numeric variable cell should not invalidate time parsing');
    assert(dialog.resultProfile.numericColumnIndexes.includes(1), 'Mostly numeric value column should be inferred as numeric');
    assert(dialog._allPreviewRowEntries().some(entry => entry.hasInvalidNumericCell), 'Preview should flag non-numeric cells in numeric columns');

    const data = await parser.parseWithProfile(buffer, dialog.resultProfile);
    assert(data.variables.value?.dataType !== 'string', 'Mostly numeric value column should remain numeric');
    assert(Number.isNaN(Number(data.variables.value.data[1])), 'Non-numeric value cell should import as NaN');

    const specs = csvColumnSpecs(dialog.resultProfile);
    const valueSpec = specs.find(spec => spec.name === 'value');
    assert(valueSpec?.type === 'DOUBLE', 'DuckDB type inference should keep mostly numeric columns as DOUBLE');
    assert(valueSpec?.readType === 'VARCHAR', 'DuckDB should read tolerant numeric columns as text before try_cast');

    const dir = mkdtempSync(join(tmpdir(), 'omv-csv-duckdb-profile-'));
    const csvPath = join(dir, 'numeric-invalid.csv');
    try {
        writeFileSync(csvPath, csv);
        const db = new Database(':memory:');
        const conn = db.connect();
        try {
            const timeInfo = timeInfoFromProfile(dialog.resultProfile);
            const filterWhere = rowFilterSql(dialog.resultProfile);
            const readExpr = csvReadExpr(sqlPath(csvPath), dialog.resultProfile);
            const projection = projectionSql(dialog.resultProfile, timeInfo);
            const rows = await runDuckDb(conn, `
                WITH raw AS (
                    SELECT * FROM ${readExpr}
                    ${filterWhere ? `WHERE ${filterWhere}` : ''}
                ),
                projected AS (
                    SELECT ${projection}
                    FROM raw
                )
                SELECT
                    COUNT(*) AS n,
                    typeof(value) AS value_type,
                    SUM(CASE WHEN value IS NULL THEN 1 ELSE 0 END) AS nulls,
                    SUM(value) AS value_sum
                FROM projected
                WHERE "__omv_time" IS NOT NULL
                GROUP BY typeof(value)
            `);
            assert(Number(rows[0]?.n) === 3, 'DuckDB profile path should preserve all valid-time rows');
            assert(String(rows[0]?.value_type).toUpperCase() === 'DOUBLE', 'DuckDB profile path should project value as DOUBLE');
            assert(Number(rows[0]?.nulls) === 1, 'DuckDB profile path should project non-numeric numeric cells as NULL/NaN');
            assert(Number(rows[0]?.value_sum) === 22, 'DuckDB profile path should preserve numeric values around NULL/NaN');
        } finally {
            await closeDuckDbConnection(conn);
            await closeDuckDbDatabase(db);
        }
    } finally {
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
        } catch (err) {
            console.warn(`warning: could not remove temporary DuckDB test directory ${dir}: ${err?.message || err}`);
        }
    }

    dialog.state.rowFilter = { enabled: true, columnIndex: 1, operator: 'is_numeric', value: '' };
    dialog._rebuildProfile();
    assert(dialog.validation.totalDataRows === 2, 'Row filter is numeric should keep only numeric value rows');
}

async function testCsvMixedMinorityNumericColumnsStayString() {
    const csv = [
        'date,value',
        '2024-01-01,10',
        '2024-01-02,foo',
        '2024-01-03,bar',
        '2024-01-04,12',
        '2024-01-05,baz',
    ].join('\n');
    const buffer = arrayBufferFromNodeBuffer(Buffer.from(csv));
    const autoData = await parser.parse(buffer);
    assert(autoData.variables.value?.dataType === 'string', 'JS auto parse should keep 40% numeric columns as string');

    const profile = parser.inspectSample(buffer, { maxRows: 20 });
    const profiledData = await parser.parseWithProfile(buffer, profile);
    assert(profiledData.variables.value?.dataType === 'string', 'JS profile parse should keep 40% numeric columns as string');
    assert(!profiledData.metadata.csvProfile.numericColumnIndexes.includes(1), 'JS profile should record value as non-numeric');

    const specs = csvColumnSpecs(profiledData.metadata.csvProfile);
    const valueSpec = specs.find(spec => spec.name === 'value');
    assert(valueSpec?.type === 'VARCHAR', 'DuckDB/Parquet profile should keep 40% numeric columns as VARCHAR');

    const append = parser.parseRowsWithProfile('2024-01-06,13\n', profiledData.metadata.csvProfile, { startRowIndex: 5 });
    assert(append.variables.get('value')?.[0] === '13', 'Live append should preserve string columns even when appended value looks numeric');
}

function testCsvPreviewHeaderlessProfileStaysHeaderless() {
    const path = 'test-files/csv/Campbell_Total_10minutes.txt';
    const buffer = readFileSync(path);
    const ab = arrayBufferFromNodeBuffer(buffer);
    const autoProfile = parser.inspectSample(ab, { maxRows: 100 });
    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: ab,
        csvProfile: autoProfile,
        title: 'Campbell_Total_10minutes.txt',
    });
    dialog.preview = parser.inspectPreview(ab, {
        maxRows: 10,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog.state.hasHeader = true;
    dialog._rebuildProfile();
    assert(dialog.headerlessProfileLocked, 'CSV preview should lock generated-header files as headerless');
    assert(dialog.resultProfile.hasHeader === false, 'CSV preview should not allow a generated-header file to become headered');
    assert(dialog.resultProfile.rawHeaders[0] === 'column_1', 'CSV preview should keep generated column names');
    assert(dialog.resultProfile.dataStartIndex === 0, 'CSV preview should keep the first row as data');
}

async function testUsMdySlashDatetimeWithAmPm() {
    const path = 'test-files/csv/date-parsing-options/03_us_mdy_slash_datetime.csv';
    const buffer = readFileSync(path);
    const ab = arrayBufferFromNodeBuffer(buffer);
    const profile = parser.inspectSample(ab, { maxRows: 100 });
    const data = await parser.parse(ab);
    assert(profile.timeSource?.strategy === 'slash-date', 'US MDY slash datetime fixture should detect slash-date strategy');
    assert(profile.timeSource?.format?.dateOrder === 'MDY', 'US MDY slash datetime fixture should detect MDY date order');
    assert(profile.timeSource?.format?.hasMeridiem === true, 'US MDY slash datetime fixture should preserve AM/PM format metadata');
    assert(data.metadata.timeKind === 'datetime', 'US MDY slash datetime fixture should parse as datetime');
    const first = new Date(data.variables[data.metadata.timeName].data[0]).toISOString();
    assert(first === '2024-01-31T13:45:00.000Z', 'US MDY slash datetime fixture should parse PM time correctly');

    const dialog = new CsvParsingPreviewDialog({
        parser,
        sampleBuffer: ab,
        csvProfile: profile,
        title: '03_us_mdy_slash_datetime.csv',
    });
    dialog.preview = parser.inspectPreview(ab, {
        maxRows: 10,
        delimiter: dialog.state.delimiter,
        encoding: dialog.state.encoding,
    });
    dialog._rebuildProfile();
    dialog._setTimeFormat('custom', { render: false });
    assert(dialog.state.customDatetimePattern === 'MM/dd/yyyy hh:mm AM/PM', 'Auto to Custom should copy the detected AM/PM pattern');
}

function testCsvPreviewCustomExcelMatlabAliases() {
    const csv = [
        'excel,matlab,value',
        '45292.5,739252.5,1',
        '45293.5,739253.5,2',
        '45294.5,739254.5,3',
    ].join('\n');
    const buffer = arrayBufferFromNodeBuffer(Buffer.from(csv));
    const profile = parser.inspectSample(buffer, { maxRows: 50 });
    const dialog = new CsvParsingPreviewDialog({ parser, sampleBuffer: buffer, csvProfile: profile, title: 'aliases.csv' });
    dialog.preview = parser.inspectPreview(buffer, { maxRows: 10, delimiter: dialog.state.delimiter, encoding: dialog.state.encoding });
    dialog._rebuildProfile();

    dialog.state.timeMode = 'single';
    dialog.state.timeColumn = 0;
    dialog.state.timeFormat = 'custom';
    dialog.state.customDatetimePattern = 'Excel';
    dialog._rebuildProfile();
    assert(dialog.validation.ok, 'Custom Excel alias should validate');
    assert(dialog.resultProfile.timeSource.strategy === 'excel-serial', 'Custom Excel alias should select excel-serial strategy');

    dialog.state.timeColumn = 1;
    dialog.state.customDatetimePattern = 'Matlab';
    dialog._rebuildProfile();
    assert(dialog.validation.ok, 'Custom Matlab alias should validate');
    assert(dialog.resultProfile.timeSource.strategy === 'matlab-datenum', 'Custom Matlab alias should select matlab-datenum strategy');
}

async function testExistingIndexColumnRenameDrivesAxisName() {
    const csv = [
        'sample,value',
        '0,10',
        '1,11',
        '2,12',
    ].join('\n');
    const buffer = arrayBufferFromNodeBuffer(Buffer.from(csv));
    const profile = parser.inspectSample(buffer, { maxRows: 20 });
    const dialog = new CsvParsingPreviewDialog({ parser, sampleBuffer: buffer, csvProfile: profile, title: 'index-column.csv' });
    dialog.preview = parser.inspectPreview(buffer, { maxRows: 10, delimiter: dialog.state.delimiter, encoding: dialog.state.encoding });
    dialog.state.timeMode = 'index-column';
    dialog.state.timeColumn = 0;
    dialog.state.columnOverrides = { 0: { name: 'sample_id' }, 1: { name: 'signal' } };
    dialog.state.ignoredColumns = [1];
    dialog._rebuildProfile();

    assert(dialog.validation.ok, 'Renamed existing index column should validate');
    assert(dialog.resultProfile.timeSource.name === 'sample_id', 'Existing index column time source should use renamed column');
    assert(dialog.resultProfile.timeSource.strategy === 'index-column', 'Existing index column should keep index-column strategy');

    const data = await parser.parseWithProfile(buffer, dialog.resultProfile);
    assert(data.metadata.timeName === 'sample_id', 'Parsed existing index column should become the renamed time variable');
    assert(data.variables.sample_id?.timeSourceStrategy === 'index-column', 'Time variable should preserve index-column strategy');

    class DummyPlotter {}
    installPlotDataMethods(DummyPlotter);
    const plotter = new DummyPlotter();
    plotter.files = new Map([['f1', { transform: {}, data }]]);
    plotter._getTimeVar = fileId => {
        const d = plotter.files.get(fileId)?.data;
        return Object.values(d.variables).find(variable => variable.kind === 'abscissa') || null;
    };
    assert(plotter._timeAxisTitle('f1') === 'sample_id', 'Existing index column axis title should use the renamed label');

    dialog._resetColumnTools({ render: false });
    assert(dialog.state.ignoredColumns.length === 0, 'Column reset should select all columns');
    assert(Object.keys(dialog.state.columnOverrides).length === 0, 'Column reset should restore detected names');
}

const rows = [];
for (const path of fixtureFiles()) {
    const buffer = readFileSync(path);
    const ab = arrayBufferFromNodeBuffer(buffer);
    const profile = parser.inspectSample(ab, { maxRows: 700 });
    const data = await parser.parse(ab);
    assertParsedData(path, data, profile);
    rows.push({
        path,
        rows: data.metadata.numTimesteps,
        vars: data.metadata.numTimevarying,
        timeKind: data.metadata.timeKind,
        strategy: profile.timeSource?.strategy || '',
        skippedInvalidTimeRows: data.metadata.skippedInvalidTimeRows || 0,
    });
}

const tesla = rows.find(row => row.path.endsWith('09_tesla_stock_dirty.csv'));
assert(tesla?.skippedInvalidTimeRows >= 1, 'Tesla dirty fixture should skip at least one invalid time row');

const datacenters = rows.find(row => row.path.endsWith('datacenters_load_2030.csv'));
assert(datacenters?.timeKind === 'datetime', 'datacenters fixture should parse as datetime');
assert(datacenters?.vars === 2, 'datacenters fixture should expose two variables');

const airline = rows.find(row => row.path.endsWith('01_airline_passengers_monthly.csv'));
assert(airline?.strategy === 'partial-year-month', 'Airline monthly fixture should parse YYYY-MM as year-month datetime');

testPlotlyCalendarTypedArrayConversion();
await testCsvRowFilter();
testPartialDateCustomPattern();
testCsvPreviewHiddenRowsDoNotChangeProfile();
testCsvPreviewHidePreambleKeepsHeader();
await testCsvPreviewDirtyPreambleCustomDatePattern();
await testCsvNumericColumnsTolerateInvalidCells();
await testCsvMixedMinorityNumericColumnsStayString();
testCsvPreviewHeaderlessProfileStaysHeaderless();
await testUsMdySlashDatetimeWithAmPm();
testCsvPreviewCustomExcelMatlabAliases();
await testExistingIndexColumnRenameDrivesAxisName();

console.log(`CSV fixtures OK: ${rows.length} files`);
