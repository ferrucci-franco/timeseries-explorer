import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import NetcdfParser from '../src/parsers/netcdf-parser.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';
import Modal from '../src/ui/modal.js';

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

// Large gridded climate variables used to be rejected wholesale whenever their
// spatial expansion exceeded 10,000 series. They now load a representative,
// bounded subset and report the partial load separately from the variables that
// could not be read at all.
function timeDescriptor(length, name = '/time') {
    return {
        path: name, name: name.slice(1), shape: [length], dimensions: [name],
        dataType: 'double', userAttrs: { units: 'hours since 2000-01-01 00:00:00' },
        read: () => Array.from({ length }, (_, index) => index), supportsSlice: false,
    };
}

function gridDescriptor(path, shape) {
    const values = Float32Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, index) => index);
    return {
        path, name: path.slice(1), shape,
        dimensions: ['/time', '/lat', '/lon'].slice(0, shape.length),
        dataType: 'float', userAttrs: { units: '%' },
        read: () => values, supportsSlice: false,
    };
}

{
    const grid = parser._parseGeneric(
        [timeDescriptor(2), gridDescriptor('/humidity', [2, 201, 201])],
        {}, 'large-grid.nc', 'netcdf3-classic',
    );
    assert.equal(grid.metadata.partialVariablesCount, 1);
    assert.equal(grid.metadata.skippedVariablesCount, 0, 'a partial load is not a skipped variable');
    const partial = grid.metadata.partialVariables[0];
    assert.equal(partial.partial, true);
    assert.equal(partial.availableSeriesCount, 40401);
    assert.equal(partial.generatedSeriesCount, grid.metadata.generatedSeriesCount);
    assert(partial.generatedSeriesCount <= 10000 && partial.generatedSeriesCount > 5000,
        `the file-wide limit should bind for a 2-sample grid, got ${partial.generatedSeriesCount}`);

    // Thinned along BOTH axes, not along the flattened index: walking the flat
    // order would have taken whole leading latitude rows and no others.
    assert.deepEqual(partial.sampledAxes.map(item => item.dimension), ['lat', 'lon']);
    assert.equal(partial.sampledAxes[0].kept, partial.sampledAxes[1].kept);
    assert(partial.sampledAxes[0].kept < 201 && partial.sampledAxes[0].kept > 1);
    const lats = new Set();
    const lons = new Set();
    for (const variable of Object.values(grid.variables)) {
        if (variable.kind !== 'variable') continue;
        lats.add(variable.netcdf.selection.lat.index);
        lons.add(variable.netcdf.selection.lon.index);
    }
    assert.equal(lats.size, partial.sampledAxes[0].kept);
    assert.equal(lons.size, partial.sampledAxes[1].kept);
    // Both ends of each axis are present, so the subset spans the whole field.
    for (const axis of [lats, lons]) {
        assert(axis.has(0) && axis.has(200), 'the sample must reach both ends of the axis');
    }
    assert(grid.tree._children['Partially loaded variables']._variables['/humidity']);
}

// Nothing is thinned that would have fitted whole. An earlier draft capped
// every variable at a fixed 2,048 slices and so cut down sresa1b's `ua`
// (4,352 slices), which main loaded entire — a regression paid for nothing.
{
    const fits = parser._parseGeneric(
        [timeDescriptor(4), gridDescriptor('/ua', [4, 66, 66])],
        {}, 'fits-whole.nc', 'netcdf3-classic',
    );
    assert.equal(fits.metadata.partialVariablesCount, 0);
    assert.equal(fits.metadata.generatedSeriesCount, 4356);
}

// Seventeen variables on one grid (ECMWF ERA-40's shape). A generous
// per-variable allowance would let the first few spend the file's whole budget
// and leave the rest rejected — the same disappearing-variable failure, moved
// one step down the file. Every variable has to come back.
{
    const descriptors = [timeDescriptor(4)];
    for (let index = 0; index < 17; index++) descriptors.push(gridDescriptor(`/var${index}`, [4, 40, 50]));
    const many = parser._parseGeneric(descriptors, {}, 'many-grids.nc', 'netcdf3-classic');
    assert.equal(many.metadata.partialVariablesCount, 17, 'every variable must be present, if only in part');
    assert.equal(many.metadata.skippedVariablesCount, 0);
    assert(many.metadata.generatedSeriesCount <= 10000);
    const counts = new Set(many.metadata.partialVariables.map(item => item.generatedSeriesCount));
    assert.equal(counts.size, 1, `variables with identical shapes must get identical allowances, got ${[...counts]}`);
}

// The detail dialog groups variables that got the same allowance. ERA-40 puts
// seventeen variables on one grid and ECHAM a hundred and twenty-seven, and
// listing the identical three lines once per variable made a dialog 2,000 px
// tall that pushed its own Close button off the screen.
{
    const many = new FileHarness();
    const descriptors = [timeDescriptor(4)];
    for (let index = 0; index < 17; index++) descriptors.push(gridDescriptor(`/var${index}`, [4, 40, 50]));
    many.plotManager.files.set('grids', { data: parser._parseGeneric(descriptors, {}, 'many.nc', 'netcdf3-classic') });

    const alerts = [];
    const realAlert = Modal.alert;
    Modal.alert = async (title, body, options) => { alerts.push({ title, body, options }); };
    try {
        await many._showNetcdfPartialLoadDetails('grids');
    } finally {
        Modal.alert = realAlert;
    }

    assert.equal(alerts.length, 1);
    const { body, options } = alerts[0];
    assert.equal(options.className, 'modal-dialog-netcdf-partial', 'the dialog has to cap its own height');
    assert.equal(
        (body.match(/slices each/g) || []).length, 1,
        'seventeen variables on one grid are one entry, not seventeen',
    );
    for (let index = 0; index < 17; index++) assert(body.includes(`/var${index}`), `missing /var${index}`);
    // Distinct allowances stay distinct, and a lone variable is not "each".
    const mixed = new FileHarness();
    mixed.plotManager.files.set('mixed', { data: parser._parseGeneric(
        [timeDescriptor(4), gridDescriptor('/a', [4, 80, 80]), gridDescriptor('/b', [4, 120, 120])],
        {}, 'mixed.nc', 'netcdf3-classic',
    ) });
    alerts.length = 0;
    Modal.alert = async (title, body, options) => { alerts.push({ title, body, options }); };
    try {
        await mixed._showNetcdfPartialLoadDetails('mixed');
    } finally {
        Modal.alert = realAlert;
    }
    assert.equal((alerts[0].body.match(/slices loaded/g) || []).length, 2, 'two allowances, two entries, neither "each"');
}

// The budget is over retained VALUES, not over slice count: the same grid
// thins or not depending on how long its time axis is.
{
    const long = parser._parseGeneric(
        [timeDescriptor(2100), gridDescriptor('/temp', [2100, 34, 34])],
        {}, 'long-axis.nc', 'netcdf3-classic',
    );
    const short = parser._parseGeneric(
        [timeDescriptor(4), gridDescriptor('/temp', [4, 34, 34])],
        {}, 'short-axis.nc', 'netcdf3-classic',
    );
    assert.equal(short.metadata.partialVariablesCount, 0, 'the same grid at 4 samples fits whole');
    assert.equal(short.metadata.generatedSeriesCount, 1156);
    assert.equal(long.metadata.partialVariablesCount, 1, 'at 2,100 samples the same grid does not');
    assert(long.metadata.generatedSeriesCount < 1156);
}

// The floor stops the budget from thinning a field out of existence: past
// ~31,000 samples a slice costs more than the budget divides into, and without
// a floor the answer would fall to single figures.
{
    const veryLong = parser._parseGeneric(
        [timeDescriptor(31300), gridDescriptor('/temp', [31300, 9, 9])],
        {}, 'very-long-axis.nc', 'netcdf3-classic',
    );
    assert.equal(veryLong.metadata.generatedSeriesCount, 64, 'the 64-slice floor, as an 8 x 8 grid');
    assert.deepEqual(veryLong.metadata.partialVariables[0].sampledAxes.map(item => item.kept), [8, 8]);
}

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
