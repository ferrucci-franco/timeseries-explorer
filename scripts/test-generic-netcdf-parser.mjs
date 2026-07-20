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
