// Random access to a file's bytes, without holding the file.
//
// The gridded reader never asks for "the file": it asks for byte ranges — a
// header, one map, one column of a region — so a 3 GB ERA5 month costs what the
// view on screen costs. Two sources cover every case the app has:
//
// - FileByteSource: a File/Blob read synchronously inside a Worker with
//   FileReaderSync. Only the requested slice is read from disk.
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

export class FileByteSource {
    constructor(file) {
        if (typeof FileReaderSync !== 'function') {
            throw new Error('Reading a file by parts needs a Worker (FileReaderSync is not available here).');
        }
        this.file = file;
        this.size = file.size;
        this.reader = new FileReaderSync();
    }

    read(offset, length) {
        const start = Math.max(0, Math.min(this.size, offset));
        const end = Math.max(start, Math.min(this.size, offset + length));
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
