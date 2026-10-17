// Lists and extracts the entries of a ZIP file without reading the whole
// archive, for the ZIP the Copernicus Climate Data Store sends when a request
// mixes instantaneous and accumulated variables (usually saved as ".nc").
//
// Only the central directory is read to list the entries. Extracting one reads
// its compressed bytes in slices and inflates them as a stream into a Blob, so
// the archive and the extracted file are never both held whole in one buffer.

import { Inflate } from 'fflate';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const READ_SLICE_BYTES = 8 * 1024 * 1024;

async function readBytes(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function u64(view, offset) {
    return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
}

/**
 * @param {Blob} file
 * @returns {Promise<Array<{name: string, method: number, compressedSize: number,
 *   size: number, localHeaderOffset: number}>>}
 */
export async function listZipEntries(file) {
    const tailLength = Math.min(file.size, 65557);
    const tail = await readBytes(file, file.size - tailLength, file.size);
    const tailView = new DataView(tail.buffer);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
        if (tailView.getUint32(index, true) === EOCD_SIGNATURE) { eocd = index; break; }
    }
    if (eocd < 0) throw Object.assign(new Error('The ZIP archive is damaged (no central directory).'), { code: 'ZIP_DAMAGED' });
    let count = tailView.getUint16(eocd + 10, true);
    let directorySize = tailView.getUint32(eocd + 12, true);
    let directoryOffset = tailView.getUint32(eocd + 16, true);
    const locator = eocd - 20;
    if (locator >= 0 && tailView.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
        const zip64Offset = u64(tailView, locator + 8);
        const record = await readBytes(file, zip64Offset, zip64Offset + 56);
        const view = new DataView(record.buffer);
        if (view.getUint32(0, true) === ZIP64_EOCD_SIGNATURE) {
            count = u64(view, 32);
            directorySize = u64(view, 40);
            directoryOffset = u64(view, 48);
        }
    }
    const directory = await readBytes(file, directoryOffset, directoryOffset + directorySize);
    const view = new DataView(directory.buffer);
    const entries = [];
    let position = 0;
    for (let index = 0; index < count && position + 46 <= directory.length; index++) {
        if (view.getUint32(position, true) !== CENTRAL_SIGNATURE) break;
        const method = view.getUint16(position + 10, true);
        let compressedSize = view.getUint32(position + 20, true);
        let size = view.getUint32(position + 24, true);
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        let localHeaderOffset = view.getUint32(position + 42, true);
        const name = new TextDecoder('utf-8').decode(directory.subarray(position + 46, position + 46 + nameLength));
        // ZIP64 extra field: the 64-bit values, in order, for each 32-bit field saturated at 0xFFFFFFFF.
        let extra = position + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
            const id = view.getUint16(extra, true);
            const length = view.getUint16(extra + 2, true);
            if (id === 0x0001) {
                let cursor = extra + 4;
                if (size === 0xFFFFFFFF) { size = u64(view, cursor); cursor += 8; }
                if (compressedSize === 0xFFFFFFFF) { compressedSize = u64(view, cursor); cursor += 8; }
                if (localHeaderOffset === 0xFFFFFFFF) { localHeaderOffset = u64(view, cursor); }
            }
            extra += 4 + length;
        }
        if (!name.endsWith('/')) entries.push({ name, method, compressedSize, size, localHeaderOffset });
        position += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

export function isNetcdfEntryName(name) {
    return /\.(nc|nc4|netcdf|cdf|h5|hdf5|he5|grib|grb|grib1|grib2|grb2)$/i.test(String(name || ''));
}

/** Extracts one entry as a File (named after the entry, without its folder). */
export async function extractZipEntry(file, entry, { onProgress = null } = {}) {
    const header = await readBytes(file, entry.localHeaderOffset, entry.localHeaderOffset + 30);
    const view = new DataView(header.buffer);
    if (view.getUint32(0, true) !== LOCAL_SIGNATURE) throw Object.assign(new Error('The ZIP archive is damaged.'), { code: 'ZIP_DAMAGED' });
    const dataStart = entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const dataEnd = dataStart + entry.compressedSize;
    const baseName = entry.name.split('/').filter(Boolean).pop() || 'entry.nc';
    if (entry.method === 0) {
        return new File([file.slice(dataStart, dataEnd)], baseName);
    }
    if (entry.method !== 8) {
        throw Object.assign(new Error(`ZIP compression method ${entry.method} is not supported.`), { code: 'ZIP_METHOD_UNSUPPORTED' });
    }
    const parts = [];
    const inflater = new Inflate();
    inflater.ondata = chunk => { parts.push(chunk); };
    for (let offset = dataStart; offset < dataEnd; offset += READ_SLICE_BYTES) {
        const stop = Math.min(dataEnd, offset + READ_SLICE_BYTES);
        inflater.push(await readBytes(file, offset, stop), stop >= dataEnd);
        onProgress?.((stop - dataStart) / Math.max(1, entry.compressedSize));
    }
    return new File(parts, baseName);
}
