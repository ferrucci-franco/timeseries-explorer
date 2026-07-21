import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import NetcdfParser from '../src/parsers/netcdf-parser.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';

const fixtures = {
    classic: 'test-files/netcdf/generic-timeseries-classic.nc',
    offset64: 'test-files/netcdf/generic-timeseries-64bit-offset.nc',
    netcdf4: 'test-files/netcdf/generic-grouped-netcdf4.netcdf',
    pypsa: 'test-files/pypsa/vetea_example_01.nc',
};

for (const path of Object.values(fixtures)) assert(existsSync(path), `Missing netCDF fixture: ${path}`);

function arrayBuffer(path) {
    const bytes = readFileSync(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const parser = new NetcdfParser();

class FileHarness {
    constructor() {
        this.capabilities = { isDesktop: false };
        this.advancedSettings = {};
        this.plotManager = { files: new Map() };
    }
}
installFileMethods(FileHarness);

class ClassicWriter {
    constructor() {
        this.parts = [];
        this.length = 0;
    }

    bytes(value) {
        const data = value instanceof Uint8Array ? value : new Uint8Array(value);
        this.parts.push(data);
        this.length += data.length;
    }

    uint(value) {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setUint32(0, value, false);
        this.bytes(data);
    }

    name(value) {
        const data = new TextEncoder().encode(value);
        this.uint(data.length);
        this.bytes(data);
        this.pad();
    }

    pad() {
        const remainder = this.length % 4;
        if (remainder) this.bytes(new Uint8Array(4 - remainder));
    }

    finish() {
        const output = new Uint8Array(this.length);
        let offset = 0;
        for (const part of this.parts) {
            output.set(part, offset);
            offset += part.length;
        }
        return output.buffer;
    }
}

const TYPES = { char: 2, int: 4, float: 5 };
const TYPE_BYTES = { char: 1, int: 4, float: 4 };

function encodeValues(type, values) {
    if (type === 'char') return new TextEncoder().encode(Array.isArray(values) ? values.join('') : String(values));
    const data = new Uint8Array(values.length * TYPE_BYTES[type]);
    const view = new DataView(data.buffer);
    values.forEach((value, index) => {
        const offset = index * TYPE_BYTES[type];
        if (type === 'int') view.setInt32(offset, value, false);
        else if (type === 'float') view.setFloat32(offset, value, false);
    });
    return data;
}

function writeAttributes(writer, attributes = []) {
    if (!attributes.length) {
        writer.uint(0);
        writer.uint(0);
        return;
    }
    writer.uint(12);
    writer.uint(attributes.length);
    for (const attribute of attributes) {
        writer.name(attribute.name);
        writer.uint(TYPES[attribute.type]);
        const values = attribute.type === 'char' ? String(attribute.value) : [].concat(attribute.value);
        writer.uint(values.length);
        writer.bytes(encodeValues(attribute.type, values));
        writer.pad();
    }
}

function classicHeader(dimensions, variables, begins) {
    const writer = new ClassicWriter();
    writer.bytes(new Uint8Array([0x43, 0x44, 0x46, 0x01]));
    writer.uint(0);
    writer.uint(10);
    writer.uint(dimensions.length);
    for (const dimension of dimensions) {
        writer.name(dimension.name);
        writer.uint(dimension.size);
    }
    writeAttributes(writer);
    writer.uint(11);
    writer.uint(variables.length);
    variables.forEach((variable, index) => {
        writer.name(variable.name);
        writer.uint(variable.dimensions.length);
        variable.dimensions.forEach(id => writer.uint(id));
        writeAttributes(writer, variable.attributes);
        writer.uint(TYPES[variable.type]);
        const valueBytes = encodeValues(variable.type, variable.values);
        writer.uint(valueBytes.length + ((4 - valueBytes.length % 4) % 4));
        writer.uint(begins?.[index] || 0);
    });
    return writer.finish();
}

function createClassicBuffer(dimensions, variables) {
    const firstHeader = classicHeader(dimensions, variables);
    const begins = [];
    let offset = firstHeader.byteLength;
    for (const variable of variables) {
        begins.push(offset);
        const byteLength = encodeValues(variable.type, variable.values).length;
        offset += byteLength + ((4 - byteLength % 4) % 4);
    }
    const header = new Uint8Array(classicHeader(dimensions, variables, begins));
    const writer = new ClassicWriter();
    writer.bytes(header);
    for (const variable of variables) {
        writer.bytes(encodeValues(variable.type, variable.values));
        writer.pad();
    }
    return writer.finish();
}

const classic = await parser.parse(arrayBuffer(fixtures.classic), fixtures.classic);
assert.equal(classic.metadata.format, 'generic-netcdf');
assert.equal(classic.metadata.source, 'netcdf');
assert.equal(classic.metadata.storageFormat, 'netcdf3-classic');
assert.equal(classic.metadata.timeKind, 'datetime');
assert.equal(classic.metadata.sampleCount, 4);
assert.equal(new Date(classic.variables[classic.metadata.timeName].data[0]).toISOString(), '2024-01-01T00:00:00.000Z');
assert.equal(new Date(classic.variables[classic.metadata.timeName].data[3]).toISOString(), '2024-01-01T18:00:00.000Z');
assert.deepEqual(Array.from(classic.variables['netcdf:temperature/station=101'].data), [20, 22, NaN, 26]);
assert.deepEqual(Array.from(classic.variables['netcdf:temperature/station=202'].data), [21, 23, 25, 27]);
assert.deepEqual(Array.from(classic.variables['netcdf:pressure'].data), [1012, 1011.5, 1010, 1009.5]);
assert.equal(classic.variables['netcdf:temperature/station=101'].units, 'degC');
assert.match(classic.variables['netcdf:temperature/station=101'].description, /air temperature/);
assert.equal(classic.metadata.globalAttributes.title, 'Generic netCDF3 time-series example');
assert.equal(classic.metadata.skippedVariablesCount, 1);
assert.equal(classic.metadata.skippedVariables[0].name, '/spectrum');
assert.equal(classic.metadata.auxiliaryCoordinateCount, 2);
assert.equal(classic.tree._variables.time.name, classic.metadata.timeName);
assert(classic.tree._children.temperature._variables['station=101']);
assert.deepEqual(classic.tree._children.Coordinates._variables['/station'].data, [101, 202]);
assert.equal(classic.tree._children['File metadata']._variables.title.plottable, false);
assert.equal(classic.tree._children['Unsupported variables']._variables['/spectrum'].plottable, false);

const offset64 = await parser.parse(arrayBuffer(fixtures.offset64), fixtures.offset64);
assert.equal(offset64.metadata.storageFormat, 'netcdf3-64-bit-offset');
assert.deepEqual(Array.from(offset64.variables['netcdf:temperature/station=202'].data), [21, 23, 25, 27]);

const netcdf4 = await parser.parse(arrayBuffer(fixtures.netcdf4), fixtures.netcdf4);
assert.equal(netcdf4.metadata.format, 'generic-netcdf');
assert.equal(netcdf4.metadata.storageFormat, 'netcdf4-hdf5');
assert.equal(netcdf4.metadata.coordinateDataset, '/time');
assert.equal(netcdf4.metadata.generatedSeriesCount, 5);
assert.equal(new Date(netcdf4.variables[netcdf4.metadata.timeName].data[0]).toISOString(), '2025-02-01T00:00:00.000Z');
assert.deepEqual(Array.from(netcdf4.variables['netcdf:observations/temperature/station=north'].data), [12, 13, NaN, 15]);
assert.deepEqual(Array.from(netcdf4.variables['netcdf:observations/temperature/station=south'].data), [14, 15, 16, 17]);
assert.deepEqual(Array.from(netcdf4.variables['netcdf:observations/humidity/station=north'].data), [70, 68, 66, 64]);
assert.deepEqual(Array.from(netcdf4.variables['netcdf:observations/humidity/station=south'].data), [60, 58, 56, 54]);
assert.deepEqual(Array.from(netcdf4.variables['netcdf:observations/wind_speed'].data), [3, 4, 5, 6]);
assert.equal(netcdf4.metadata.globalAttributes.institution, 'Time Series Explorer tests');
assert.equal(netcdf4.metadata.skippedVariablesCount, 1);
assert.equal(netcdf4.metadata.skippedVariables[0].name, '/observations/spectrum');
assert.equal(netcdf4.metadata.auxiliaryCoordinateCount, 2);
assert(netcdf4.tree._children.observations._children.temperature._variables['station=north']);
assert.deepEqual(netcdf4.tree._children.Coordinates._variables['/station'].data, ['north', 'south']);

const harness = new FileHarness();
const integrated = await harness._parseResultBuffer(fixtures.netcdf4, arrayBuffer(fixtures.netcdf4));
harness.plotManager.files.set('generic', { data: integrated });
assert.equal(integrated.metadata.format, 'generic-netcdf');
assert.equal(harness._fileTypeLabel(null, 'generic'), 'Generic netCDF dataset');
assert.equal(harness._fileTypeHasWarnings(null, 'generic'), true);
assert.match(harness._fileTypeTooltip(null, 'generic', 'Generic netCDF dataset'), /1 netCDF variable/);

const pypsa = await parser.parse(arrayBuffer(fixtures.pypsa), fixtures.pypsa);
assert.equal(pypsa.metadata.format, 'pypsa-netcdf', 'PyPSA files must retain the specialized parser and tree');
assert(pypsa.variables['pypsa:generators/PV1/p_max_pu']);

const offsetTime = await parser.parse(createClassicBuffer(
    [{ name: 'Time', size: 3 }],
    [
        {
            name: 'base_time', dimensions: [], type: 'int', values: [1077114120],
            attributes: [{ name: 'long_name', type: 'char', value: 'Seconds since Jan 1, 1970.' }],
        },
        {
            name: 'time_offset', dimensions: [0], type: 'float', values: [0, 1, 2],
            attributes: [{ name: 'long_name', type: 'char', value: 'Seconds since base_time.' }],
        },
        { name: 'signal', dimensions: [0], type: 'float', values: [4, 5, 6] },
    ]
), 'time-offset.nc');
assert.equal(offsetTime.metadata.coordinateDataset, '/time_offset');
assert.equal(offsetTime.metadata.timeKind, 'datetime');
assert.equal(new Date(offsetTime.variables[offsetTime.metadata.timeName].data[0]).toISOString(), '2004-02-18T14:22:00.000Z');
assert.deepEqual(Array.from(offsetTime.variables['netcdf:signal'].data), [4, 5, 6]);

const wrfTimes = await parser.parse(createClassicBuffer(
    [{ name: 'Time', size: 3 }, { name: 'DateStrLen', size: 19 }],
    [
        {
            name: 'Times', dimensions: [0, 1], type: 'char',
            values: ['2000-01-24_12:00:00', '2000-01-24_13:00:00', '2000-01-24_14:00:00'],
        },
        { name: 'T2', dimensions: [0], type: 'float', values: [280, 281, 282], attributes: [{ name: 'units', type: 'char', value: 'K' }] },
    ]
), 'wrf-times.nc');
assert.equal(wrfTimes.metadata.coordinateDataset, '/Times');
assert.equal(wrfTimes.metadata.timeKind, 'datetime');
assert.equal(new Date(wrfTimes.variables[wrfTimes.metadata.timeName].data[2]).toISOString(), '2000-01-24T14:00:00.000Z');
assert.deepEqual(Array.from(wrfTimes.variables['netcdf:T2'].data), [280, 281, 282]);

await assert.rejects(
    () => parser.parse(new Uint8Array([0x43, 0x44, 0x46, 0x05, 0, 0, 0, 0]).buffer, 'cdf5.nc'),
    /CDF-5 files are not supported/
);
await assert.rejects(
    () => parser.parse(new Uint8Array([1, 2, 3, 4]).buffer, 'invalid.nc'),
    /not a recognized netCDF3 or netCDF4/
);
await assert.rejects(
    () => parser.parse(arrayBuffer(fixtures.classic), fixtures.classic, { maxFileBytes: 10 }),
    /limited to files that fit in memory/
);

console.log('Generic netCDF parser tests passed for netCDF3, grouped netCDF4, and PyPSA dispatch.');
