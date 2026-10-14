// The gridded netCDF engine (src/gridded/) on the fixtures that copy what broke
// the viewer: ERA5 as the new and the legacy Copernicus CDS write it, the CDS
// ZIP, a model calendar, CDF-5. Regenerate the fixtures with
// `python3 scripts/generate-gridded-netcdf-fixtures.py`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GriddedDataset } from '../src/gridded/dataset.js';
import { GriddedClient } from '../src/gridded/gridded-client.js';
import { decodeCfTime } from '../src/gridded/cf-time.js';
import { extractZipEntry, isNetcdfEntryName, listZipEntries } from '../src/gridded/zip-reader.js';
import { openNetcdf3 } from '../src/gridded/nc3-reader.js';
import { BufferByteSource } from '../src/gridded/byte-source.js';
import { sniffNetcdfContainer } from '../src/parsers/netcdf-sniff.js';
import NetcdfParser from '../src/parsers/netcdf-parser.js';

const DIR = 'test-files/netcdf';
const buffer = name => {
    const bytes = readFileSync(`${DIR}/${name}`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const open = (name, options) => GriddedDataset.open([{ buffer: buffer(name), filename: name }], options);
const close = (actual, expected, message, tolerance = 1e-3) => assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
// The fixtures' field: 280 + offset + 0.1 lat + 0.01 lon + t (- 10 per level).
const field = (lat, lon, t, offset = 0, level = 0) => 280 + offset + 0.1 * lat + 0.01 * lon + t - 10 * level;
const displayIndex = (map, lat, lon) => map.lat.indexOf(lat) * map.nx + map.lon.indexOf(lon);

// --- New CDS (netCDF4, valid_time int64, latitude descending, longitude 0..315)
{
    const dataset = await open('era5-like-new-cds.nc');
    const model = dataset.model();
    assert.equal(model.gridded, true);
    assert.equal(model.primaryTimeDim, 'valid_time');
    assert.equal(model.axes.valid_time.role, 't');
    assert.equal(model.axes.valid_time.kind, 'datetime');
    assert.equal(model.axes.valid_time.labels[1], '2024-01-01 01:00');
    assert.equal(new Date(model.axes.valid_time.values[0]).toISOString(), '2024-01-01T00:00:00.000Z');
    assert.equal(model.axes.pressure_level.role, 'z');
    assert.equal(model.axes.latitude.role, 'y');
    assert.equal(model.axes.longitude.role, 'x');
    const t = model.variables.find(item => item.key === '/t');
    const t2m = model.variables.find(item => item.key === '/t2m');
    assert(t.mapable && t2m.mapable);
    assert.deepEqual(t.roles, ['t', 'z', 'y', 'x']);
    // `expver` (text) and `number` (scalar) are never offered as maps.
    assert(!model.variables.some(item => item.mapable && /expver|number/.test(item.key)));

    const map = dataset.readMap('/t2m', { valid_time: 0 });
    assert.equal(map.ny, 6);
    assert.equal(map.nx, 8);
    assert.deepEqual(Array.from(map.lat), [-75, -45, -15, 15, 45, 75], 'latitude is presented ascending');
    assert.deepEqual(Array.from(map.lon), [-135, -90, -45, 0, 45, 90, 135, 180], '0..315 is rolled to -180..180');
    close(map.values[displayIndex(map, 45, 90)], field(45, 90, 0, 5), 't2m at 45N 90E');
    close(map.values[displayIndex(map, 15, -45)], field(15, 315, 0, 5), 't2m at 15N 45W (stored as 315E)');
    assert(Number.isNaN(map.values[displayIndex(map, 75, 0)]), 'the NaN fill stays missing');
    assert.equal(map.validCount, 47);

    const level = dataset.readMap('/t', { valid_time: 2, pressure_level: 1 });
    close(level.values[displayIndex(level, -15, 180)], field(-15, 180, 2, 0, 1), 't at 500 hPa, third step');

    const point = await dataset.pointSeries('/t2m', {}, 44, 92);
    assert.deepEqual(point.cell, { lat: 45, lon: 90 }, 'nearest cell');
    point.values.forEach((value, step) => close(value, field(45, 90, step, 5), `point step ${step}`));

    // A box over 0..50 N, 50 W..50 E: rows 15 and 45 N; columns 0, 45 E and
    // 45 W, the last stored at 315 E, so the read wraps the seam.
    const progress = [];
    const region = await dataset.regionStats('/t', { pressure_level: 0 }, { latMin: 0, latMax: 50, lonMin: -50, lonMax: 50 },
        { onProgress: value => progress.push(value) });
    assert.equal(region.cells, 6);
    assert.equal(region.weighting, 'cos-lat');
    for (let step = 0; step < 4; step++) {
        let sum = 0;
        let weights = 0;
        for (const lat of [15, 45]) {
            for (const lon of [0, 45, 315]) {
                const w = Math.cos(lat * Math.PI / 180);
                sum += field(lat, lon, step) * w;
                weights += w;
            }
        }
        close(region.mean[step], sum / weights, `area-weighted mean, step ${step}`);
        close(region.min[step], field(15, 0, step), `min, step ${step}`);
        close(region.max[step], field(45, 315, step), `max, step ${step}`);
        assert.equal(region.maxLat[step], 45);
        assert.equal(region.maxLon[step], -45, 'the location is reported in display longitude');
    }
    assert.equal(progress.at(-1), 1);

    // A box across the antimeridian.
    const across = await dataset.regionStats('/t2m', {}, { latMin: -20, latMax: 20, lonMin: 170, lonMax: -170 });
    assert.equal(across.cells, 2);
    close(across.mean[0], (field(-15, 180, 0, 5) + field(15, 180, 0, 5)) / 2, 'two equal-weight cells at 180');

    // Missing cells are skipped and counted.
    const corner = await dataset.regionStats('/t2m', {}, { latMin: 70, latMax: 80, lonMin: -10, lonMax: 50 });
    assert.equal(corner.cells, 2);
    assert.equal(corner.validFraction[0], 0.5);
    close(corner.mean[0], field(75, 45, 0, 5), 'only the valid cell counts');

    await assert.rejects(() => dataset.regionStats('/t2m', {}, { latMin: 80, latMax: 85, lonMin: 0, lonMax: 1 }), { code: 'GRIDDED_EMPTY_REGION' });
    const job = { cancelled: true };
    await assert.rejects(() => dataset.pointSeries('/t2m', {}, 0, 0, job), error => error.cancelled === true);
    dataset.close();
}

// --- Legacy CDS (netCDF3, unlimited time, int16 packed, odd-sized records)
{
    const dataset = await open('era5-like-legacy-cds.nc');
    const model = dataset.model();
    assert.equal(model.members[0].storageFormat, 'netcdf3-64-bit-offset');
    assert.equal(model.axes.time.kind, 'datetime');
    assert.equal(model.axes.time.labels[0], '2023-11-22 00:00');
    for (let step = 0; step < 3; step++) {
        const map = dataset.readMap('/t2m', { time: step });
        close(map.values[displayIndex(map, 50, 10)], field(50, 10, step), `packed t2m, step ${step}`, 0.006);
        close(map.values[displayIndex(map, 20, -30)], field(20, -30, step), `packed t2m corner, step ${step}`, 0.006);
    }
    dataset.close();

    // The series reader used netcdfjs here, which kept the record padding as
    // data and shifted every record after the first by one value.
    const parsed = await new NetcdfParser().parse(buffer('era5-like-legacy-cds.nc'), 'legacy.nc');
    const series = parsed.variables['netcdf:t2m/latitude=50/longitude=10'];
    assert(series, 'series for 50N 10E');
    Array.from(series.data).forEach((value, step) => close(value, field(50, 10, step), `series step ${step}`, 0.006));
}

// --- The by-parts netCDF3 reader agrees with itself on hyperslabs.
{
    const opened = openNetcdf3(new BufferByteSource(buffer('era5-like-legacy-cds.nc')));
    const t2m = opened.descriptors.find(item => item.name === 't2m');
    const all = t2m.read();
    const slab = t2m.read([[1, 3], [1, 4], [2, 6]]);
    const expected = [];
    for (let t = 1; t < 3; t++) for (let y = 1; y < 4; y++) for (let x = 2; x < 6; x++) expected.push(all[(t * 5 + y) * 7 + x]);
    assert.deepEqual(Array.from(slab), expected);
}

// --- Model calendars and CDF-5
{
    const dataset = await open('cmip-noleap.nc');
    const time = dataset.model().axes.time;
    assert.equal(time.kind, 'calendar');
    assert.deepEqual(time.labels, ['2000-01-01', '2000-03-01', '2001-01-01', '2001-03-01'], 'noleap has no 29 February');
    assert.deepEqual(Array.from(time.values), [0, 59, 365, 424]);
    dataset.close();

    assert.deepEqual(decodeCfTime([0, 59, 360], 'days since 2000-01-01', '360_day').labels, ['2000-01-01', '2000-02-30', '2001-01-01']);
    assert.deepEqual(decodeCfTime([0, 31, 60], 'days since 2000-01-01', 'julian').labels, ['2000-01-01', '2000-02-01', '2000-03-01']);
    assert.deepEqual(decodeCfTime([0, 6], 'hours since 2000-01-01', 'all_leap').labels, ['2000-01-01 00:00', '2000-01-01 06:00']);

    const cdf5 = await open('cdf5-grid.nc');
    const map = cdf5.readMap('/pr', { time: 1 });
    assert.deepEqual(Array.from(map.values), [60006, 60007, 60008, 60009, 60010, 60011], 'uint16 CDF-5 data, second record');
    cdf5.close();
}

// --- Files that are not grids stay with the series reader.
{
    const stations = await open('generic-timeseries-classic.nc');
    assert.equal(stations.gridded, false);
    stations.close();
    const pypsa = await GriddedDataset.open([{ buffer: readFileSync('test-files/pypsa/vetea_example_01.nc').buffer.slice(0), filename: 'network.nc' }]);
    assert.equal(pypsa.gridded, false, 'PyPSA files keep their own reader');
    pypsa.close();
}

// --- The CDS ZIP: listed from its central directory, entries extracted and
//     opened together as one dataset (instant + accumulated variables).
{
    const zipBytes = readFileSync(`${DIR}/era5-like-instant-accum.zip`);
    const zipFile = new File([zipBytes], 'download.nc');
    assert.equal(sniffNetcdfContainer(new Uint8Array(await zipFile.slice(0, 4096).arrayBuffer())).kind, 'zip');
    const entries = await listZipEntries(zipFile);
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['data_stream-oper_stepType-accum.nc', 'data_stream-oper_stepType-instant.nc']);
    assert(entries.every(entry => isNetcdfEntryName(entry.name)));
    const files = [];
    for (const entry of entries) files.push(await extractZipEntry(zipFile, entry));
    assert.equal(files[0].size, entries[0].size);
    const inputs = await Promise.all(files.map(async file => ({ buffer: await file.arrayBuffer(), filename: file.name })));
    const merged = await GriddedDataset.open(inputs, { mode: 'merge-variables' });
    const keys = merged.model().variables.filter(item => item.mapable).map(item => item.key).sort();
    assert.deepEqual(keys, ['/t2m', '/tp']);
    const tp = merged.readMap('/tp', { valid_time: 3 });
    close(tp.values[displayIndex(tp, 45, 0)], field(45, 0, 3, -280), 'tp from the accumulated member');

    // Joined in time: the same file twice is eight steps, the second half
    // read from the second member.
    const instant = inputs.find(input => /instant/.test(input.filename));
    const joined = await GriddedDataset.open([instant, instant], { mode: 'concat-time' });
    assert.equal(joined.model().axes.valid_time.size, 8);
    const late = joined.readMap('/t2m', { valid_time: 5 });
    close(late.values[displayIndex(late, 45, 0)], field(45, 0, 1), 'step 5 is step 1 of the second file');
    const series = await joined.pointSeries('/t2m', {}, 45, 0);
    assert.equal(series.values.length, 8);
    close(series.values[7], field(45, 0, 3), 'the column runs across both files');
    await assert.rejects(() => GriddedDataset.open(inputs, { mode: 'concat-time' }), { code: 'GRIDDED_INCOMPATIBLE' });
    merged.close();
    joined.close();
}

// --- What a ".nc" really is, before anything tries to parse it.
{
    const parser = new NetcdfParser();
    const cases = [
        [[0x47, 0x52, 0x49, 0x42, 0, 0, 0, 2], 'NETCDF_CONTAINER_GRIB'],
        [[0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0], 'NETCDF_CONTAINER_ZIP'],
        [[0x1F, 0x8B, 8, 0], 'NETCDF_CONTAINER_GZIP'],
        [Array.from(new TextEncoder().encode('<!DOCTYPE html><html>')), 'NETCDF_CONTAINER_HTML'],
        [Array.from(new TextEncoder().encode('{"error": "quota"}')), 'NETCDF_CONTAINER_JSON'],
    ];
    for (const [bytes, code] of cases) {
        await assert.rejects(() => parser.parse(new Uint8Array(bytes).buffer, 'download.nc'), { code });
    }
}

// --- The main-thread client runs the same requests in the page when there
//     is no Worker (here: Node).
{
    const client = new GriddedClient();
    assert.equal(client.usesWorker, false);
    const file = new File([readFileSync(`${DIR}/era5-like-new-cds.nc`)], 'era5.nc');
    const opened = await client.open('test-1', [file]);
    assert.equal(opened.gridded, true);
    const map = await client.request('map', { datasetId: 'test-1', variable: '/t2m', selection: { valid_time: 1 } }).promise;
    close(map.values[displayIndex(map, 45, 90)], field(45, 90, 1, 5), 'map through the client');
    await client.close('test-1');
    await assert.rejects(() => client.request('map', { datasetId: 'test-1', variable: '/t2m' }).promise, { code: 'GRIDDED_NOT_OPEN' });
}

console.log('Gridded dataset tests passed: new and legacy CDS layouts, ZIP, calendars, CDF-5, regions, client.');
