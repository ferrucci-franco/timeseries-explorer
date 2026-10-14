// What a ".nc" file actually is, decided from its first bytes rather than its
// name. ERA5 downloads are the reason this exists: the Copernicus Climate Data
// Store returns a ZIP whenever a request mixes instantaneous and accumulated
// variables, GRIB when the format was left at its default, and an HTML or JSON
// error page when a request failed — and cdsapi users save all three under
// whatever name they passed as `target`, which is usually "something.nc". Each
// used to end in the same "not a recognized netCDF file", which reads as "the
// viewer is broken" when the file is simply something else.

const SIGNATURES = [
    { kind: 'hdf5', bytes: [0x89, 0x48, 0x44, 0x46, 0x0D, 0x0A, 0x1A, 0x0A] },
    { kind: 'netcdf3-classic', bytes: [0x43, 0x44, 0x46, 0x01] },
    { kind: 'netcdf3-64-bit-offset', bytes: [0x43, 0x44, 0x46, 0x02] },
    { kind: 'cdf5', bytes: [0x43, 0x44, 0x46, 0x05] },
    { kind: 'zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
    // An empty archive, which the CDS never sends but a failed copy can leave.
    { kind: 'zip', bytes: [0x50, 0x4B, 0x05, 0x06] },
    { kind: 'grib', bytes: [0x47, 0x52, 0x49, 0x42] },
    { kind: 'gzip', bytes: [0x1F, 0x8B] },
    { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
    { kind: 'png', bytes: [0x89, 0x50, 0x4E, 0x47] },
    { kind: 'jpeg', bytes: [0xFF, 0xD8, 0xFF] },
];

// The netCDF4 superblock is normally at byte 0, but HDF5 allows a user block
// in front of it, at 512, 1024, 2048, ... bytes.
const HDF5_USER_BLOCK_OFFSETS = [512, 1024, 2048, 4096];

function startsWith(view, bytes, offset = 0) {
    if (view.length < offset + bytes.length) return false;
    for (let index = 0; index < bytes.length; index++) {
        if (view[offset + index] !== bytes[index]) return false;
    }
    return true;
}

function looksLikeText(view) {
    const head = new TextDecoder('utf-8', { fatal: false })
        .decode(view.subarray(0, Math.min(view.length, 512)))
        .replace(/^﻿/, '')
        .trimStart()
        .toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<')) return 'html';
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
    return null;
}

/**
 * @param {ArrayBuffer|Uint8Array} source the first bytes of the file (at least
 *   8; 4 KB covers an HDF5 user block).
 * @returns {{kind: string}} one of hdf5, netcdf3-classic, netcdf3-64-bit-offset,
 *   cdf5, zip, grib, gzip, pdf, png, jpeg, html, json, empty, unknown.
 */
export function sniffNetcdfContainer(source) {
    const view = source instanceof Uint8Array ? source : new Uint8Array(source || new ArrayBuffer(0));
    if (!view.length) return { kind: 'empty' };
    for (const signature of SIGNATURES) {
        if (startsWith(view, signature.bytes)) return { kind: signature.kind };
    }
    for (const offset of HDF5_USER_BLOCK_OFFSETS) {
        if (startsWith(view, SIGNATURES[0].bytes, offset)) return { kind: 'hdf5', offset };
    }
    const text = looksLikeText(view);
    if (text) return { kind: text };
    return { kind: 'unknown' };
}

export const NETCDF_READABLE_KINDS = new Set(['hdf5', 'netcdf3-classic', 'netcdf3-64-bit-offset']);

/**
 * An Error whose `code` the UI turns into a translated, actionable message.
 * The English text is the fallback for the worker console and the tests.
 */
export function netcdfContainerError(kind) {
    const messages = {
        zip: 'This file is a ZIP archive, not a netCDF file. The Copernicus Climate Data Store sends a ZIP when a request mixes instantaneous and accumulated variables; open the archive itself so its netCDF files can be listed.',
        grib: 'This file is GRIB, not netCDF. ERA5 is natively GRIB; request "NetCDF4" as the data format in the Climate Data Store, or convert the file (for example with `cdo -f nc4 copy file.grib file.nc`).',
        gzip: 'This file is gzip-compressed. Decompress it first (it usually ends in .nc.gz), then open the .nc file inside.',
        html: 'This file is a web page or an XML document, not netCDF. The download most likely failed and saved the server\'s error page; download the file again.',
        json: 'This file is a JSON text, not netCDF. The download most likely failed and saved the server\'s error message; download the file again.',
        pdf: 'This file is a PDF document, not netCDF.',
        png: 'This file is an image, not netCDF.',
        jpeg: 'This file is an image, not netCDF.',
        cdf5: 'netCDF CDF-5 files are not supported by the browser reader. Convert the file to netCDF4/HDF5 or netCDF3 Classic (for example with `nccopy -k nc4 in.nc out.nc`).',
        empty: 'netCDF file is empty.',
        unknown: 'The selected file is not a recognized netCDF3 or netCDF4/HDF5 file.',
    };
    const error = new Error(messages[kind] || messages.unknown);
    error.code = `NETCDF_CONTAINER_${String(kind || 'unknown').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    error.containerKind = kind;
    return error;
}
