// Random access to a file's bytes, without holding the file.
//
// The gridded reader never asks for "the file": it asks for byte ranges — a
// header, one map, one column of a region — so a 3 GB ERA5 month costs what the
// view on screen costs. Two sources cover every case the app has:
//
// - FileByteSource: a File/Blob read synchronously inside a Worker with
//   FileReaderSync. Only the requested slice is read from disk, or for small
//   reads moving forward, the block read ahead around it.
// - BufferByteSource: bytes already in memory (Node tests, the main-thread
//   fallback, an entry extracted from a ZIP that is small enough to keep).

export class BufferByteSource {
    constructor(buffer) {
        this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        this.size = this.bytes.byteLength;
    }

    read(offset, length) {
        const start = Math.max(0, Math.min(this.size, offset));
        const end = Math.max(start, Math.min(this.size, offset + length));
        return this.bytes.subarray(start, end);
    }
}

// A FileReaderSync call costs about a millisecond in Chromium whatever its
// size, and a GRIB has no index: it is walked header by header, several reads
// of a few bytes per message. A month of hourly fields on a small box is tens
// of thousands of messages, and opening one took minutes. Small reads moving
// forward through the file are therefore served from a block read ahead; a
// small read far from the last one (a point picked out of every record of a
// large netCDF) is still read on its own, or each would pull in a whole block.
const READ_AHEAD_BYTES = 1024 * 1024;
const SMALL_READ_BYTES = 64 * 1024;

export class FileByteSource {
    constructor(file) {
        if (typeof FileReaderSync !== 'function') {
            throw new Error('Reading a file by parts needs a Worker (FileReaderSync is not available here).');
        }
        this.file = file;
        this.size = file.size;
        this.reader = new FileReaderSync();
        this.block = null;
        this.blockStart = 0;
        this.lastStart = -1;
        this.lastEnd = -1;
    }

    read(offset, length) {
        const start = Math.max(0, Math.min(this.size, offset));
        const end = Math.max(start, Math.min(this.size, offset + length));
        const forward = this.lastStart >= 0 && start >= this.lastStart && start - this.lastEnd <= SMALL_READ_BYTES;
        this.lastStart = start;
        this.lastEnd = end;
        if (end - start > SMALL_READ_BYTES) return this._readDirect(start, end);
        const block = this.block;
        if (block && start >= this.blockStart && end <= this.blockStart + block.length) {
            // A copy, as a direct read would give: callers may keep or transfer it.
            return block.slice(start - this.blockStart, end - this.blockStart);
        }
        if (!forward) return this._readDirect(start, end);
        this.block = this._readDirect(start, Math.min(this.size, start + READ_AHEAD_BYTES));
        this.blockStart = start;
        return this.block.slice(0, end - start);
    }

    _readDirect(start, end) {
        return new Uint8Array(this.reader.readAsArrayBuffer(this.file.slice(start, end)));
    }
}

export function byteSourceFor(input) {
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        return new BufferByteSource(ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : input);
    }
    if (input && typeof input.slice === 'function' && Number.isFinite(input.size)) return new FileByteSource(input);
    throw new Error('Unsupported byte source.');
}
