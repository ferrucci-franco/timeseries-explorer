import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import h5wasm from 'h5wasm/node';

const DEFAULT_FILE = 'test-files/pypsa/vetea_example_01.nc';
const filePath = resolve(process.argv[2] || DEFAULT_FILE);

if (!existsSync(filePath)) {
    console.error(`PyPSA netCDF fixture not found: ${filePath}`);
    console.error(`Pass a .nc path explicitly, e.g. npm.cmd run inspect:pypsa -- path/to/network.nc`);
    process.exit(1);
}

const HDF5_MAGIC = '89 48 44 46 0D 0A 1A 0A';
const NETCDF3_MAGICS = new Set(['43 44 46 01', '43 44 46 02', '43 44 46 05']);

function magicString(path, bytes = 8) {
    return [...readFileSync(path).subarray(0, bytes)]
        .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
}

function compact(value, limit = 6) {
    if (value == null) return value;
    if (typeof value === 'bigint') return value.toString();
    if (ArrayBuffer.isView(value)) return [...value.slice(0, limit)].map(compact);
    if (Array.isArray(value)) return value.slice(0, limit).map(compact);
    return value;
}

function datasetInfo(file, name) {
    const obj = file.get(name);
    if (!obj || obj.type !== 'Dataset') return null;
    return {
        name,
        obj,
        shape: obj.shape || [],
        dtype: obj.dtype,
        attrs: Object.keys(obj.attrs || {}),
    };
}

function read1d(dataset, limit = 6) {
    const shape = dataset.shape || [];
    if (shape.length === 0) return compact(dataset.value);
    return compact(dataset.slice([[0, Math.min(limit, shape[0])]]), limit);
}

function read2d(dataset, rows = 3, cols = 3) {
    const shape = dataset.shape || [];
    if (shape.length < 2) return read1d(dataset, rows * cols);
    return compact(dataset.slice([
        [0, Math.min(rows, shape[0])],
        [0, Math.min(cols, shape[1])],
    ]), rows * cols);
}

function isDynamicName(name) {
    return /^.+_t_.+$/.test(name) && !name.endsWith('_i');
}

function dynamicParts(name) {
    const match = name.match(/^(.+)_t_(.+)$/);
    return match ? { component: match[1], attribute: match[2] } : null;
}

function componentIndexes(keys) {
    return keys
        .filter(key => key.endsWith('_i') && !key.includes('_t_'))
        .map(key => key.slice(0, -2))
        .filter(key => key !== 'snapshots' && key !== 'investment_periods')
        .sort();
}

function staticParts(name, components) {
    for (const component of components) {
        const prefix = `${component}_`;
        if (name.startsWith(prefix) && !name.startsWith(`${component}_t_`) && name !== `${component}_i`) {
            return { component, attribute: name.slice(prefix.length) };
        }
    }
    return null;
}

await h5wasm.ready;

const magic8 = magicString(filePath, 8);
const magic4 = magic8.split(' ').slice(0, 4).join(' ');
const format = magic8 === HDF5_MAGIC
    ? 'HDF5 / netCDF4'
    : NETCDF3_MAGICS.has(magic4)
        ? 'netCDF3 classic'
        : 'unknown';

console.log(`PyPSA netCDF inspection`);
console.log(`file: ${filePath}`);
console.log(`magic: ${magic8} (${format})`);

const file = new h5wasm.File(filePath, 'r');
try {
    const keys = file.keys().sort();
    const datasets = keys.map(key => datasetInfo(file, key)).filter(Boolean);
    const snapshots = datasetInfo(file, 'snapshots');
    const components = componentIndexes(keys);
    const dynamic = keys
        .filter(isDynamicName)
        .map(name => ({ ...dynamicParts(name), ...datasetInfo(file, name), index: datasetInfo(file, `${name}_i`) }))
        .filter(item => item.obj);
    const statics = keys
        .map(name => ({ ...staticParts(name, components), ...datasetInfo(file, name) }))
        .filter(item => item.obj && item.component);

    console.log(`datasets: ${datasets.length}`);
    console.log(`component indexes: ${components.length ? components.join(', ') : '(none)'}`);

    if (snapshots) {
        console.log(`snapshots: shape=${JSON.stringify(snapshots.shape)} dtype=${snapshots.dtype} sample=${JSON.stringify(read1d(snapshots.obj))}`);
    } else {
        console.log(`snapshots: MISSING`);
    }

    console.log(`\nComponent index samples:`);
    for (const component of components) {
        const index = datasetInfo(file, `${component}_i`);
        if (!index) continue;
        console.log(`- ${component}: count=${index.shape[0] || 0} sample=${JSON.stringify(read1d(index.obj))}`);
    }

    console.log(`\nDynamic time-series datasets: ${dynamic.length}`);
    for (const item of dynamic) {
        const snapshotLen = snapshots?.shape?.[0] || 0;
        const indexLen = item.index?.shape?.[0] || 0;
        const aligned = item.shape.includes(snapshotLen);
        const ownIndex = item.index ? `${item.name}_i` : '(missing)';
        const sampleIds = item.index ? read1d(item.index.obj) : [];
        const sampleValues = read2d(item.obj);
        console.log(`- ${item.component}.${item.attribute}: shape=${JSON.stringify(item.shape)} dtype=${item.dtype} ownIndex=${ownIndex} indexCount=${indexLen} snapshotsAligned=${aligned}`);
        console.log(`  ids=${JSON.stringify(sampleIds)} values=${JSON.stringify(sampleValues)}`);
        if (!aligned) {
            console.log(`  WARNING: no dimension matches snapshots length ${snapshotLen}`);
        }
    }

    console.log(`\nStatic component datasets: ${statics.length}`);
    for (const item of statics.slice(0, 40)) {
        console.log(`- ${item.component}.${item.attribute}: shape=${JSON.stringify(item.shape)} dtype=${item.dtype} sample=${JSON.stringify(read1d(item.obj))}`);
    }
    if (statics.length > 40) console.log(`- ... ${statics.length - 40} more`);

    console.log(`\nParser implications:`);
    console.log(`- Use HDF5/netCDF4 reader path for this real PyPSA file.`);
    console.log(`- Emit one abscissa from snapshots, then validate each dynamic series against it.`);
    console.log(`- Map every dynamic dataset with its own *_i index, not the full component *_i index.`);
    console.log(`- Keep static component attrs as metadata/non-plottable until the tree has an explicit non-plottable flag.`);
} finally {
    file.close();
}
