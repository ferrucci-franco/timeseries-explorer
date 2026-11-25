// The ERA5 Argentina examples that ship with the app open as gridded datasets,
// in the layout the Copernicus CDS writes, and still hold the real values of
// August 2024 and of the cold outbreak of the 2nd to the 4th.
//
// The three files are written by `python3 scripts/fetch-era5-argentina-example.py`
// from the NSF NCAR copy of ERA5 on AWS Open Data (RDA ds633.0). The expected
// numbers below are ERA5's own: if a regenerated file moves them, either the
// window or the source changed, and the documentation has to change with it
// (docs/era5-argentina-example.md).
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { GriddedDataset } from '../src/gridded/dataset.js';

const FULL = 'public/examples/era5-argentina-cold-front.nc';
const MONTH = 'public/examples/era5-argentina-august-2024.nc';
const DEMO = 'public/examples/guide/era5_argentina.nc';

const SIX = ['/d2m', '/msl', '/t2m', '/tcc', '/u10', '/v10'];

const expected = {
    [FULL]: {
        // They travel inside the desktop and portable packages, so a
        // regenerated file must not quietly grow.
        cap: 4.0e6,
        steps: 24, ny: 141, nx: 89,
        first: '2024-08-02 12:00', last: '2024-08-03 11:00',
        variables: SIX,
        buenosAires: [294.7047, 286.6392],
        // The event: the box is colder at the end than at the start, at the
        // same hour of the day, so this is cold air and not the daily cycle.
        meanDrop: 2.1,
    },
    [MONTH]: {
        cap: 10.5e6,
        steps: 248, ny: 71, nx: 45,
        first: '2024-08-01 00:00', last: '2024-08-31 21:00',
        variables: SIX,
        buenosAires: [289.2844, 284.8665],
        // A month holds several fronts, so its ends say nothing; what it must
        // still hold is the warm afternoon before this front and the coldest
        // morning of the month.
        extremes: {
            warmest: { label: '2024-08-02 18:00', celsius: 26.11 },
            coldest: { label: '2024-08-12 09:00', celsius: 4.69 },
        },
    },
    [DEMO]: {
        cap: 0.6e6,
        steps: 16, ny: 71, nx: 45,
        first: '2024-08-02 12:00', last: '2024-08-04 09:00',
        variables: ['/msl', '/t2m', '/u10', '/v10'],
        buenosAires: [294.7047, 284.1471],
        meanDrop: 4.8,
    },
};

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
const close = (actual, wanted, message, tolerance = 1e-3) =>
    assert(Math.abs(actual - wanted) <= tolerance, `${message}: ${actual} vs ${wanted}`);

const maps = {};
for (const name of [FULL, MONTH, DEMO]) {
    const want = expected[name];
    assert(statSync(name).size <= want.cap,
        `${name} is larger than the cap it ships under (${want.cap} bytes)`);

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

    if (want.meanDrop !== undefined) {
        const drop = mean(first.values) - mean(last.values);
        assert(drop > want.meanDrop,
            `${name}: the cold outbreak should cool the box by more than ${want.meanDrop} K, got ${drop.toFixed(2)}`);
    }

    const point = await dataset.pointSeries('/t2m', {}, -34.6, -58.4);
    assert.deepEqual(point.cell, { lat: -34.5, lon: -58.5 }, `${name}: nearest cell to Buenos Aires`);
    close(point.values[0], want.buenosAires[0], `${name}: t2m over Buenos Aires at the first step`);
    close(point.values[want.steps - 1], want.buenosAires[1], `${name}: t2m over Buenos Aires at the last step`);

    if (want.extremes) {
        const series = Array.from(point.values);
        const at = (pick) => series.indexOf(pick(...series));
        const warmest = at(Math.max);
        const coldest = at(Math.min);
        assert.equal(axis.labels[warmest], want.extremes.warmest.label,
            `${name}: when Buenos Aires is warmest in the month`);
        assert.equal(axis.labels[coldest], want.extremes.coldest.label,
            `${name}: when Buenos Aires is coldest in the month`);
        close(series[warmest] - 273.15, want.extremes.warmest.celsius, `${name}: the warmest value`, 0.01);
        close(series[coldest] - 273.15, want.extremes.coldest.celsius, `${name}: the coldest value`, 0.01);
    }

    maps[name] = { first, dataset, axis };
}

// The three files are cuts of one dataset, not three readings of it: where two
// of them hold the same instant on the same grid, every cell is identical.
const sameCells = (a, b, labelA, labelB) => {
    const key = (lat, lon) => `${lat.toFixed(2)}|${lon.toFixed(2)}`;
    const index = new Map();
    for (let y = 0; y < a.ny; y++) {
        for (let x = 0; x < a.nx; x++) index.set(key(a.lat[y], a.lon[x]), a.values[y * a.nx + x]);
    }
    let compared = 0;
    for (let y = 0; y < b.ny; y++) {
        for (let x = 0; x < b.nx; x++) {
            const found = index.get(key(b.lat[y], b.lon[x]));
            assert(found !== undefined, `cell ${b.lat[y]},${b.lon[x]} of ${labelB} is not in ${labelA}`);
            assert.equal(b.values[y * b.nx + x], found,
                `cell ${b.lat[y]},${b.lon[x]} differs between ${labelA} and ${labelB}`);
            compared++;
        }
    }
    return compared;
};

// 2024-08-02 12:00 is the first step of the day-long file and of the demo, and
// step 13 of the month.
const monthAtEvent = maps[MONTH].dataset.readMap('/t2m', { valid_time: 12 });
assert.equal(maps[MONTH].axis.labels[12], '2024-08-02 12:00');
console.log(`  the day file and the demo agree on ${sameCells(maps[FULL].first, maps[DEMO].first, 'the day file', 'the demo')} cells`);
console.log(`  the month and the day file agree on ${sameCells(maps[FULL].first, monthAtEvent, 'the day file', 'the month')} cells`);

console.log('ERA5 Argentina examples: OK');
