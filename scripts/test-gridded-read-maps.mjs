// Several maps in one read, for files chunked along time.
//
// The new CDS writes a long hourly request in chunks of 2920 steps (four
// months) by a part of the grid. Any map read from such a file decompresses
// every chunk it touches, whole: on a year of hourly Argentina (166×149,
// 371 MB) a map cost about 2 s, and Play ran at 0.6 frames a second.
// GriddedDataset.readMaps takes all the steps Play is about to show from one
// strided read, which costs what one map did; the app asks for them in
// batches (time-stride.js batchIndices, gridded-methods.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GriddedDataset } from '../src/gridded/dataset.js';
import { GriddedClient } from '../src/gridded/gridded-client.js';

const DIR = 'test-files/netcdf';
const bytes = name => {
    const raw = readFileSync(`${DIR}/${name}`);
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
};
const open = name => GriddedDataset.open([{ buffer: bytes(name), filename: name }]);
const field = (lat, lon, t) => 280 + 0.1 * lat + 0.01 * lon + t;
const same = (a, b) => a.length === b.length && Array.from(a).every((value, index) => Object.is(value, b[index]) || value === b[index]);

// Counts the reads that reach the file.
function countReads(dataset) {
    const counter = { reads: 0 };
    for (const variable of dataset.variables.values()) {
        for (const segment of variable.segments) {
            const read = segment.descriptor.read;
            segment.descriptor.read = ranges => {
                counter.reads += 1;
                return read(ranges);
            };
        }
    }
    return counter;
}

// ── A file chunked along time ──────────────────────────────────────────────
{
    const dataset = await open('era5-like-time-chunked.nc');
    const model = dataset.model();
    const variable = model.variables.find(item => item.key === '/t');
    assert.equal(variable.timeChunk, 48, 'the model says how many steps a chunk holds');
    const dim = model.primaryTimeDim;
    const map = index => dataset.readMap('/t', { [dim]: index });
    const counter = countReads(dataset);
    const check = (indices, reads, message) => {
        counter.reads = 0;
        const got = dataset.readMaps('/t', {}, indices);
        assert.equal(counter.reads, reads, `${message}: ${counter.reads} reads`);
        const expected = [...new Set(indices)].sort((a, b) => a - b);
        assert.deepEqual(got.map(item => item.index), expected, `${message}: every step asked, once, in order`);
        for (const item of got) assert.ok(same(item.map.values, map(item.index).values), `${message}: step ${item.index} as readMap reads it`);
        return got;
    };
    // Values, not only agreement with readMap.
    const first = check(Array.from({ length: 48 }, (_, index) => index), 1, 'a whole chunk of steps');
    const at = (result, lat, lon) => result.map.values[result.map.lat.indexOf(lat) * result.map.nx + result.map.lon.indexOf(lon)];
    assert.ok(Math.abs(at(first[7], 45, 90) - field(45, 90, 7)) < 1e-3, 'the right value at the right place and step');
    check([5, 29, 53, 77], 1, 'a day apart, across chunks');
    check([0, 24, 72], 1, 'gaps of one and two days: strided by a day, the step between dropped');
    check([77, 5, 29, 29], 1, 'out of order and repeated');
    check([60], 1, 'a single step');
    const map7 = check([7, 8], 1, 'two steps')[0];
    assert.equal(map7.map.validCount, 48);
    assert.deepEqual([map7.map.ny, map7.map.nx], [6, 8]);
}

// ── Readers that cannot stride read map by map ────────────────────────────
{
    const dataset = await open('era5-like-legacy-cds.nc');
    const model = dataset.model();
    const key = model.variables.find(item => item.mapable).key;
    const dim = model.primaryTimeDim;
    const counter = countReads(dataset);
    const got = dataset.readMaps(key, {}, [0, 1, 2]);
    assert.equal(counter.reads, 3, 'netCDF3: one read per map, as before');
    for (const item of got) assert.ok(same(item.map.values, dataset.readMap(key, { [dim]: item.index }).values));
}

// ── Through the client, as the map view asks ──────────────────────────────
{
    const client = new GriddedClient();
    const file = new File([readFileSync(`${DIR}/era5-like-time-chunked.nc`)], 'chunked.nc');
    const opened = await client.open('maps-1', [file]);
    assert.equal(opened.gridded, true);
    const result = await client.request('maps', { datasetId: 'maps-1', variable: '/t', selection: {}, indices: [3, 27, 51] }).promise;
    assert.deepEqual(result.maps.map(item => item.index), [3, 27, 51]);
    const single = await client.request('map', { datasetId: 'maps-1', variable: '/t', selection: { valid_time: 27 } }).promise;
    assert.ok(same(result.maps[1].map.values, single.values), "the 'maps' request gives what 'map' does");
    await client.close('maps-1');
}

console.log('Gridded read-maps tests passed: one read for many steps of a time-chunked file, map by map elsewhere.');
