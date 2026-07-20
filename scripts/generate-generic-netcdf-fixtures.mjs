import { mkdirSync, writeFileSync } from 'node:fs';
import h5wasm from 'h5wasm';

const OUTPUT_DIR = new URL('../test-files/netcdf/', import.meta.url);
mkdirSync(OUTPUT_DIR, { recursive: true });

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

    int(value) {
        const data = new Uint8Array(4);
        new DataView(data.buffer).setInt32(0, value, false);
        this.bytes(data);
    }

    ulong(value) {
        const data = new Uint8Array(8);
        new DataView(data.buffer).setBigUint64(0, BigInt(value), false);
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
        return output;
    }
}

const TYPES = { char: 2, short: 3, int: 4, float: 5, double: 6 };
const TYPE_BYTES = { char: 1, short: 2, int: 4, float: 4, double: 8 };

function encodeValues(type, values) {
    if (type === 'char') return new TextEncoder().encode(String(values));
    const data = new Uint8Array(values.length * TYPE_BYTES[type]);
    const view = new DataView(data.buffer);
    values.forEach((value, index) => {
        const offset = index * TYPE_BYTES[type];
        if (type === 'short') view.setInt16(offset, value, false);
        else if (type === 'int') view.setInt32(offset, value, false);
        else if (type === 'float') view.setFloat32(offset, value, false);
        else if (type === 'double') view.setFloat64(offset, value, false);
    });
    return data;
}

function writeAttributes(writer, attributes) {
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

function classicHeader(dimensions, globalAttributes, variables, begins, version = 1) {
    const writer = new ClassicWriter();
    writer.bytes(new Uint8Array([0x43, 0x44, 0x46, version]));
    writer.uint(0);
    writer.uint(10);
    writer.uint(dimensions.length);
    for (const dimension of dimensions) {
        writer.name(dimension.name);
        writer.uint(dimension.size);
    }
    writeAttributes(writer, globalAttributes);
    writer.uint(11);
    writer.uint(variables.length);
    variables.forEach((variable, index) => {
        writer.name(variable.name);
        writer.uint(variable.dimensions.length);
        variable.dimensions.forEach(id => writer.uint(id));
        writeAttributes(writer, variable.attributes || []);
        writer.uint(TYPES[variable.type]);
        const valueBytes = encodeValues(variable.type, variable.values);
        writer.uint(valueBytes.length + ((4 - valueBytes.length % 4) % 4));
        if (version === 2) writer.ulong(begins?.[index] || 0);
        else writer.uint(begins?.[index] || 0);
    });
    return writer.finish();
}

function createClassicFixture(filename, version = 1) {
    const dimensions = [{ name: 'time', size: 4 }, { name: 'station', size: 2 }, { name: 'frequency', size: 3 }];
    const variables = [
        {
            name: 'time', dimensions: [0], type: 'double', values: [0, 6, 12, 18],
            attributes: [
                { name: 'standard_name', type: 'char', value: 'time' },
                { name: 'units', type: 'char', value: 'hours since 2024-01-01 00:00:00' },
                { name: 'calendar', type: 'char', value: 'standard' },
            ],
        },
        { name: 'station', dimensions: [1], type: 'int', values: [101, 202], attributes: [{ name: 'long_name', type: 'char', value: 'station identifier' }] },
        {
            name: 'temperature', dimensions: [0, 1], type: 'short', values: [0, 10, 20, 30, -9999, 50, 60, 70],
            attributes: [
                { name: 'long_name', type: 'char', value: 'air temperature' },
                { name: 'units', type: 'char', value: 'degC' },
                { name: 'scale_factor', type: 'double', value: 0.1 },
                { name: 'add_offset', type: 'double', value: 20 },
                { name: '_FillValue', type: 'short', value: -9999 },
            ],
        },
        { name: 'pressure', dimensions: [0], type: 'float', values: [1012, 1011.5, 1010, 1009.5], attributes: [{ name: 'units', type: 'char', value: 'hPa' }] },
        { name: 'frequency', dimensions: [2], type: 'float', values: [1, 2, 4], attributes: [{ name: 'units', type: 'char', value: 'Hz' }] },
        { name: 'spectrum', dimensions: [2], type: 'float', values: [4, 2, 1], attributes: [{ name: 'units', type: 'char', value: 'dB' }] },
    ];
    const title = version === 2 ? 'Generic netCDF3 64-bit-offset example' : 'Generic netCDF3 time-series example';
    const firstHeader = classicHeader(dimensions, [{ name: 'title', type: 'char', value: title }], variables, undefined, version);
    const begins = [];
    let offset = firstHeader.length;
    for (const variable of variables) {
        begins.push(offset);
        const byteLength = encodeValues(variable.type, variable.values).length;
        offset += byteLength + ((4 - byteLength % 4) % 4);
    }
    const header = classicHeader(dimensions, [{ name: 'title', type: 'char', value: title }], variables, begins, version);
    const writer = new ClassicWriter();
    writer.bytes(header);
    for (const variable of variables) {
        writer.bytes(encodeValues(variable.type, variable.values));
        writer.pad();
    }
    writeFileSync(new URL(filename, OUTPUT_DIR), writer.finish());
}

async function createNetcdf4Fixture() {
    const module = await h5wasm.ready;
    const virtualPath = `/generic-timeseries-netcdf4-${Date.now()}.nc`;
    const file = new h5wasm.File(virtualPath, 'w');
    try {
        file.create_attribute('title', 'Generic grouped netCDF4 time-series example');
        file.create_attribute('institution', 'Time Series Explorer tests');
        const time = file.create_dataset({ name: 'time', data: [0, 1, 2, 3], shape: [4], dtype: '<d' });
        time.make_scale('time');
        time.create_attribute('_Netcdf4Dimid', 0);
        time.create_attribute('standard_name', 'time');
        time.create_attribute('axis', 'T');
        time.create_attribute('units', 'days since 2025-02-01 00:00:00');
        time.create_attribute('calendar', 'proleptic_gregorian');

        const station = file.create_dataset({ name: 'station', data: ['north', 'south'] });
        station.make_scale('station');
        station.create_attribute('_Netcdf4Dimid', 1);

        const frequency = file.create_dataset({ name: 'frequency', data: [1, 2, 4], shape: [3], dtype: '<d' });
        frequency.make_scale('frequency');
        frequency.create_attribute('_Netcdf4Dimid', 2);
        frequency.create_attribute('units', 'Hz');

        const observations = file.create_group('observations');
        const temperature = observations.create_dataset({
            name: 'temperature', data: [12, 14, 13, 15, -9999, 16, 15, 17], shape: [4, 2], dtype: '<d',
        });
        temperature.attach_scale(0, '/time');
        temperature.attach_scale(1, '/station');
        temperature.create_attribute('long_name', 'near-surface air temperature');
        temperature.create_attribute('units', 'degC');
        temperature.create_attribute('_FillValue', -9999);

        const humidity = observations.create_dataset({
            name: 'humidity', data: [70, 68, 66, 64, 60, 58, 56, 54], shape: [2, 4], dtype: '<d',
        });
        humidity.attach_scale(0, '/station');
        humidity.attach_scale(1, '/time');
        humidity.create_attribute('units', '%');

        const wind = observations.create_dataset({ name: 'wind_speed', data: [3, 4, 5, 6], shape: [4], dtype: '<d' });
        wind.attach_scale(0, '/time');
        wind.create_attribute('units', 'm s-1');

        const spectrum = observations.create_dataset({ name: 'spectrum', data: [9, 4, 1], shape: [3], dtype: '<d' });
        spectrum.attach_scale(0, '/frequency');
        spectrum.create_attribute('units', 'dB');
    } finally {
        file.close();
    }
    const bytes = module.FS.readFile(virtualPath);
    module.FS.unlink(virtualPath);
    writeFileSync(new URL('generic-grouped-netcdf4.netcdf', OUTPUT_DIR), bytes);
}

createClassicFixture('generic-timeseries-classic.nc');
createClassicFixture('generic-timeseries-64bit-offset.nc', 2);
await createNetcdf4Fixture();
console.log('Generated generic netCDF3 Classic/64-bit-offset and netCDF4 fixtures.');
