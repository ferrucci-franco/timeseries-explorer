import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import h5wasm from 'h5wasm';
import PypsaNetcdfParser from '../src/parsers/pypsa-netcdf-parser.js';

const fixture = 'test-files/pypsa/vetea_example_01.nc';

if (!existsSync(fixture)) {
    console.warn(`Skipping PyPSA netCDF parser test: fixture not found at ${fixture}`);
    process.exit(0);
}

const bytes = readFileSync(fixture);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parser = new PypsaNetcdfParser();
const data = await parser.parse(buffer, fixture);

async function makeGenericHdf5Buffer() {
    const module = await h5wasm.ready;
    const { FS } = module;
    const path = `/generic-netcdf-${Date.now()}.nc`;
    const file = new h5wasm.File(path, 'w');
    try {
        file.create_dataset({ name: 'time', data: [0, 1, 2], shape: [3], dtype: '<d' });
        file.create_dataset({ name: 'temperature', data: [10, 11, 12], shape: [3], dtype: '<d' });
    } finally {
        file.close();
    }
    const bytes = FS.readFile(path);
    FS.unlink(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function makeEdgeCasePypsaBuffer() {
    const module = await h5wasm.ready;
    const { FS } = module;
    const path = `/edge-pypsa-${Date.now()}.nc`;
    const file = new h5wasm.File(path, 'w');
    try {
        file.create_dataset({ name: 'snapshots', data: [0, 1, 2], shape: [3], dtype: '<d' });
        file.create_dataset({ name: 'snapshots_snapshot', data: [0, 1, 2], shape: [3], dtype: '<d' });
        file.get('snapshots_snapshot').create_attribute('units', 'hours since 2030-01-01 00:00:00');
        file.get('snapshots_snapshot').create_attribute('calendar', 'proleptic_gregorian');
        file.create_dataset({ name: 'generators_i', data: ['solar/a.1', 'wind B'] });
        file.create_dataset({ name: 'generators_carrier', data: ['PV/South', 'Wind.Onshore'] });
        file.create_dataset({ name: 'generators_t_p_i', data: ['solar/a.1', 'wind B'] });
        file.create_dataset({
            name: 'generators_t_p',
            data: [10, 11, 12, 20, 21, 22],
            shape: [2, 3],
            dtype: '<d',
        });
        file.get('generators_t_p').create_attribute('units', 'MW');
        file.get('generators_t_p').create_attribute('long_name', 'Generator active power');
        file.create_dataset({ name: 'generators_t_bad_i', data: ['solar/a.1', 'wind B'] });
        file.create_dataset({
            name: 'generators_t_bad',
            data: [
                1, 2, 3, 4,
                5, 6, 7, 8,
                9, 10, 11, 12,
            ],
            shape: [3, 2, 2],
            dtype: '<d',
        });
    } finally {
        file.close();
    }
    const bytes = FS.readFile(path);
    FS.unlink(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

assert.equal(data.metadata.format, 'pypsa-netcdf');
assert.equal(data.metadata.source, 'pypsa');
assert.equal(data.metadata.timeName, 'snapshots');
assert.equal(data.metadata.timeKind, 'datetime');
assert(data.metadata.staticAttributeCount > 0, 'static attributes should be exposed in the tree');
assert.equal(data.variables.snapshots.kind, 'abscissa');
assert.equal(data.variables.snapshots.data.length, 2016);
assert.equal(new Date(data.variables.snapshots.data[0]).toISOString(), '2020-07-01T00:00:00.000Z');

assert.equal(data.metadata.skippedDynamic.length, 0);
assert.deepEqual(data.metadata.components.map(component => component.name), [
    'buses',
    'generators',
    'lines',
    'links',
    'loads',
    'stores',
]);

const generatorPv = data.variables['pypsa:generators/PV1/p_max_pu'];
assert(generatorPv, 'generator PV1 p_max_pu series should be exposed');
assert.equal(generatorPv.data.length, data.variables.snapshots.data.length);
assert.equal(generatorPv.pypsa.indexDataset, 'generators_t_p_max_pu_i');
assert.equal(generatorPv.pypsa.asset, 'PV1');
assert.match(generatorPv.description, /carrier=PV/);

const load = data.variables['pypsa:loads/L1/p_set'];
assert(load, 'load L1 p_set series should be exposed');
assert.equal(load.data.length, data.variables.snapshots.data.length);
assert.match(load.description, /bus=Bus 1/);

assert(data.tree._children.Generators._children.PV1._variables.p_max_pu);
assert(data.tree._children.Loads._children.L1._variables.p_set);

const pvStatic = data.tree._children.Generators._children.PV1._children['Static attributes'];
assert(pvStatic, 'PV1 should expose static attributes as a tree child');
assert.equal(pvStatic._variables.carrier.data[0], 'PV');
assert.equal(pvStatic._variables.carrier.plottable, false);
assert.equal(pvStatic._variables.carrier.kind, 'parameter');
assert.equal(data.variables[pvStatic._variables.carrier.name], undefined, 'static metadata must not be emitted as a plottable data variable');

const genericBuffer = await makeGenericHdf5Buffer();
await assert.rejects(
    () => parser.parse(genericBuffer, 'generic.nc'),
    /Generic netCDF\/HDF5 files are not supported yet/
);

await assert.rejects(
    () => parser.parse(new Uint8Array([0x43, 0x44, 0x46, 0x01]).buffer, 'classic.nc'),
    /not HDF5\/netCDF4/
);

const edgeData = await parser.parse(await makeEdgeCasePypsaBuffer(), 'edge.nc');
assert.equal(edgeData.metadata.timeKind, 'datetime');
assert.equal(edgeData.metadata.timeDisplayMode, 'calendar');
assert.equal(new Date(edgeData.variables.snapshots.data[0]).toISOString(), '2030-01-01T00:00:00.000Z');
assert.equal(new Date(edgeData.variables.snapshots.data[2]).toISOString(), '2030-01-01T02:00:00.000Z');
const encodedSolar = edgeData.variables['pypsa:generators/solar%2Fa.1/p'];
const encodedWind = edgeData.variables['pypsa:generators/wind%20B/p'];
assert(encodedSolar, 'asset names containing slashes should use escaped stable ids');
assert(encodedWind, 'asset names containing spaces should use escaped stable ids');
assert.deepEqual(Array.from(encodedSolar.data), [10, 11, 12], 'component-first dynamic arrays should be transposed onto snapshots');
assert.deepEqual(Array.from(encodedWind.data), [20, 21, 22], 'second component-first series should be read by its own index');
assert.equal(encodedSolar.pypsa.asset, 'solar/a.1');
assert.equal(encodedSolar.displayName, 'Generators / solar/a.1 / p');
assert.equal(encodedSolar.units, 'MW');
assert.equal(encodedSolar.pypsa.attrs.units, 'MW');
assert.match(encodedSolar.description, /\[MW\]/);
assert.match(encodedSolar.description, /Generator active power/);
assert(edgeData.tree._children.Generators._children['solar/a.1']._variables.p);
const edgeStatic = edgeData.tree._children.Generators._children['solar/a.1']._children['Static attributes']._variables.carrier;
assert.equal(edgeStatic.data[0], 'PV/South');
assert.equal(edgeStatic.name, 'pypsa:generators/solar%2Fa.1/@carrier');
assert.equal(edgeData.metadata.skippedDynamicCount, 1);
assert.equal(edgeData.metadata.skippedDynamic[0].name, 'generators_t_bad');
const skippedNode = edgeData.tree._children['Unsupported time-series datasets'];
assert(skippedNode, 'skipped dynamic datasets should be visible in the tree');
assert.equal(skippedNode._variables.generators_t_bad.plottable, false);
assert.match(skippedNode._variables.generators_t_bad.description, /Expected a two-dimensional dynamic array/);

console.log(`PyPSA netCDF parser test passed: ${Object.keys(data.variables).length} variables`);
