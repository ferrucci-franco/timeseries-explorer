// The ERA5 Argentina examples that ship with the app open as gridded datasets,
// in the layout the Copernicus CDS writes, and still hold the real values of
// the cold outbreak of 2-4 August 2024.
//
// Both files are written by `python3 scripts/fetch-era5-argentina-example.py`
// from the NSF NCAR copy of ERA5 on AWS Open Data (RDA ds633.0). The expected
// numbers below are ERA5's own: if a regenerated file moves them, either the
// window or the source changed, and the documentation has to change with it
// (docs/era5-argentina-example.md).
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { GriddedDataset } from '../src/gridded/dataset.js';

const FULL = 'public/examples/era5-argentina-cold-front.nc';
const DEMO = 'public/examples/guide/era5_argentina.nc';

// They travel with the app, so a regenerated file must not quietly grow.
const SIZE_CAP = { [FULL]: 4.0e6, [DEMO]: 0.6e6 };

const open = async (name) => {
    const bytes = readFileSync(name);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return GriddedDataset.open([{ buffer, filename: name.split('/').pop() }]);
};
const mean = (values) => {
    let sum = 0;
    let count = 0;
    for (const value of values) if (Number.isFinite(value)) { sum += value; count++; }
    return sum / count;
};
const close = (actual, expected, message, tolerance = 1e-3) =>
    assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

const expected = {
    [FULL]: {
        steps: 24, ny: 141, nx: 89,
        first: '2024-08-02 12:00', last: '2024-08-03 11:00',
        variables: ['/d2m', '/msl', '/t2m', '/tcc', '/u10', '/v10'],
        buenosAires: [294.7047, 286.6392],
        meanDrop: 2.1,
    },
    [DEMO]: {
        steps: 16, ny: 71, nx: 45,
        first: '2024-08-02 12:00', last: '2024-08-04 09:00',
        variables: ['/msl', '/t2m', '/u10', '/v10'],
        buenosAires: [294.7047, 284.1471],
        meanDrop: 4.8,
    },
};

const maps = {};
for (const name of [FULL, DEMO]) {
    const want = expected[name];
    assert(statSync(name).size <= SIZE_CAP[name],
        `${name} is larger than the cap it ships under (${SIZE_CAP[name]} bytes)`);

    const dataset = await open(name);
    const model = dataset.model();
    assert.equal(model.gridded, true, `${name} opens as a map, not as loose series`);
    assert.equal(model.primaryTimeDim, 'valid_time', `${name} keeps the CDS time name`);

    const axis = model.axes.valid_time;
    assert.equal(axis.kind, 'datetime', `${name}: seconds since 1970 are read as dates`);
    assert.equal(axis.values.length, want.steps);
    assert.equal(axis.labels[0], want.first);
    assert.equal(axis.labels[want.steps - 1], want.last);
    assert.equal(model.axes.latitude.role, 'y');
    assert.equal(model.axes.longitude.role, 'x');

    assert.deepEqual(model.variables.filter(item => item.mapable).map(item => item.key).sort(),
        want.variables, `${name} offers its variables as maps`);
    assert(!model.variables.some(item => item.mapable && /number|expver/.test(item.key)),
        `${name}: the CDS extras are not offered as maps`);

    const first = dataset.readMap('/t2m', { valid_time: 0 });
    const last = dataset.readMap('/t2m', { valid_time: want.steps - 1 });
    assert.equal(first.ny, want.ny);
    assert.equal(first.nx, want.nx);
    assert.equal(first.validCount, want.ny * want.nx, `${name}: ERA5 surface fields have no gaps here`);
    assert.equal(first.lat[0], -56, 'the map is presented south to north');
    assert.equal(first.lat[want.ny - 1], -21);
    assert.equal(first.lon[0], -74, 'longitudes stay in -180..180, as the CDS writes them for this area');
    assert.equal(first.lon[want.nx - 1], -52);

    // The event: the country is colder at the end than at the start, at the
    // same hour of the day, so this is cold air and not the daily cycle.
    const drop = mean(first.values) - mean(last.values);
    assert(drop > want.meanDrop,
        `${name}: the cold outbreak should cool the box by more than ${want.meanDrop} K, got ${drop.toFixed(2)}`);

    const point = await dataset.pointSeries('/t2m', {}, -34.6, -58.4);
    assert.deepEqual(point.cell, { lat: -34.5, lon: -58.5 }, `${name}: nearest cell to Buenos Aires`);
    close(point.values[0], want.buenosAires[0], `${name}: t2m over Buenos Aires at the first step`);
    close(point.values[want.steps - 1], want.buenosAires[1], `${name}: t2m over Buenos Aires at the last step`);

    maps[name] = first;
}

// The small file is the big one's own cells, kept one in two, not an average
// or a reinterpolation: where the two grids meet, the values are identical.
{
    const full = maps[FULL];
    const demo = maps[DEMO];
    const key = (lat, lon) => `${lat.toFixed(2)}|${lon.toFixed(2)}`;
    const index = new Map();
    for (let y = 0; y < full.ny; y++) {
        for (let x = 0; x < full.nx; x++) index.set(key(full.lat[y], full.lon[x]), full.values[y * full.nx + x]);
    }
    let compared = 0;
    for (let y = 0; y < demo.ny; y++) {
        for (let x = 0; x < demo.nx; x++) {
            const found = index.get(key(demo.lat[y], demo.lon[x]));
            assert(found !== undefined, `cell ${demo.lat[y]},${demo.lon[x]} of the demo is not in the full example`);
            assert.equal(demo.values[y * demo.nx + x], found,
                `cell ${demo.lat[y]},${demo.lon[x]} differs between the two files`);
            compared++;
        }
    }
    assert.equal(compared, demo.ny * demo.nx);
    console.log(`  the two files agree on all ${compared} shared cells`);
}

console.log('ERA5 Argentina examples: OK');
