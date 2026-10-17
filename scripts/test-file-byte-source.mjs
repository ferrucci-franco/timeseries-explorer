// Reading a file by parts in the worker: FileByteSource.
//
// Each FileReaderSync call costs about a millisecond in Chromium whatever its
// size, and opening a GRIB walks it header by header: a month of hourly fields
// on a small box (28 682 messages, 23 MB) made 200 000 reads of a few bytes
// and took four minutes to open. Small reads moving forward are now served
// from a block read ahead; scattered ones are still read on their own.
//
// FileReaderSync only exists in a Worker, so a stand-in counts the calls and
// the bytes each one reads. The time it saves was measured in Chromium on the
// file above (see the commit that added this test).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FileByteSource, BufferByteSource } from '../src/gridded/byte-source.js';
import { scanGrib } from '../src/gridded/grib-reader.js';

const stats = { calls: 0, bytes: 0 };
globalThis.FileReaderSync = class {
    readAsArrayBuffer(blob) {
        stats.calls += 1;
        stats.bytes += blob.bytes.length;
        return blob.bytes.slice().buffer;
    }
};
const fakeFile = bytes => ({
    size: bytes.length,
    slice: (start, end) => ({ bytes: bytes.subarray(start, end) }),
});
const reset = () => { stats.calls = 0; stats.bytes = 0; };

// Deterministic bytes, so a wrong offset cannot read back the right values.
const data = new Uint8Array(5 * 1024 * 1024 + 123);
for (let index = 0, seed = 7; index < data.length; index++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[index] = seed >>> 24;
}
const expect = (source, offset, length, message) => {
    const got = source.read(offset, length);
    const start = Math.max(0, Math.min(data.length, offset));
    const end = Math.max(start, Math.min(data.length, offset + length));
    assert.deepEqual(got, data.subarray(start, end), message);
    return got;
};

// ── Every read returns the file's bytes, whatever the pattern ──────────────
{
    const source = new FileByteSource(fakeFile(data));
    let seed = 99;
    const next = limit => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % limit; };
    for (let step = 0; step < 3000; step++) {
        const kind = next(4);
        const offset = kind === 0 ? next(data.length) : Math.max(0, (source.lastEnd || 0) + next(2000) - 200);
        const length = kind === 1 ? 64 * 1024 + next(300000) : next(5000);
        expect(source, offset, length, `read ${step} (${offset}, ${length})`);
    }
    expect(source, data.length - 10, 100, 'a read past the end stops at the end');
    expect(source, data.length + 5, 10, 'a read after the end is empty');
}

// ── A forward walk of small reads costs a few block reads ─────────────────
{
    reset();
    const source = new FileByteSource(fakeFile(data));
    let reads = 0;
    // Like scanGrib on small messages: a 16-byte head, sections inside the
    // message (some before the previous read's end), the data skipped.
    for (let offset = 0; offset + 900 <= data.length; offset += 900) {
        expect(source, offset, 16, 'message head');
        expect(source, offset + 8, 3, 'section length, behind the last read');
        expect(source, offset + 8, 28, 'section');
        expect(source, offset + 36, 11, 'data section head');
        reads += 4;
    }
    assert.ok(stats.calls <= 8, `${reads} small forward reads took ${stats.calls} file reads`);
    assert.ok(stats.bytes <= data.length + 2 * 1024 * 1024, 'and read the file about once');
}

// ── Scattered small reads are not read ahead ──────────────────────────────
// One value out of every record of a large netCDF: a block per value would
// read the whole file many times over.
{
    reset();
    const source = new FileByteSource(fakeFile(data));
    const stride = 200 * 1024;
    let reads = 0;
    for (let offset = 17; offset < data.length; offset += stride) {
        expect(source, offset, 4, 'one value per record');
        reads += 1;
    }
    assert.equal(stats.calls, reads, 'each read on its own');
    assert.equal(stats.bytes, reads * 4, 'reading only its own bytes');
    // Backwards, also not ahead.
    reset();
    for (let offset = data.length - 100; offset > 0; offset -= stride) expect(source, offset, 4, 'backwards');
    assert.ok(stats.bytes < 1024, 'nothing read ahead going backwards');
}

// ── Large reads go straight to the file ───────────────────────────────────
{
    reset();
    const source = new FileByteSource(fakeFile(data));
    expect(source, 0, 16, 'start');
    expect(source, 1000, 300000, 'a whole map');
    assert.equal(stats.bytes, 16 + 300000, 'a large read is not padded to a block');
}

// ── What it returns is the caller's own ───────────────────────────────────
{
    const source = new FileByteSource(fakeFile(data));
    source.read(0, 16);
    const first = source.read(100, 8);
    first.fill(0);
    expect(source, 100, 8, 'changing a returned array does not change the next read');
    assert.notEqual(source.read(100, 8).buffer, source.block.buffer, 'it is a copy, not a view of the block');
}

// ── scanGrib reads the same fields through it ─────────────────────────────
for (const name of ['era5-grib1-sfc.grib', 'era5-grib2-pl.grib2', 'era5-grib2-complex.grib2']) {
    const raw = new Uint8Array(readFileSync(new URL(`../test-files/grib/${name}`, import.meta.url)));
    // Several copies one after another: a longer walk than the fixture alone.
    const repeated = new Uint8Array(raw.length * 400);
    for (let copy = 0; copy < 400; copy++) repeated.set(raw, copy * raw.length);
    const fromBuffer = scanGrib(new BufferByteSource(repeated));
    reset();
    const fromFile = scanGrib(new FileByteSource(fakeFile(repeated)));
    assert.deepEqual(fromFile, fromBuffer, `${name}: the same fields`);
    assert.ok(stats.calls <= Math.ceil(repeated.length / (1024 * 1024)) + 2,
        `${name}: ${fromFile.fields.length} fields scanned in ${stats.calls} file reads`);
}

console.log('File byte source tests passed: same bytes, forward reads ahead, scattered reads alone, GRIB scan.');
