#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import CsvParser from '../src/parsers/csv-parser.js';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

const parser = new CsvParser();

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

testPlotlyCalendarTypedArrayConversion();

console.log(`CSV fixtures OK: ${rows.length} files`);
