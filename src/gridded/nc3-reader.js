// A netCDF3 reader that reads by parts: Classic (CDF-1), 64-bit offset (CDF-2)
// and 64-bit data (CDF-5).
//
// netcdfjs, which the series reader uses, wants the whole file in one buffer.
// A legacy-CDS ERA5 month is a 1.5 GB netCDF3 file, so here only the header is
// read up front and every data request becomes the byte ranges it covers. The
// format makes that cheap: a fixed variable is one contiguous row-major block,
// and a record variable is one contiguous block per record, `recsize` bytes
// apart.
//
// Format reference: https://docs.unidata.ucar.edu/netcdf-c/current/file_format_specifications.html

import { attrsFromNetcdf3 } from '../parsers/netcdf-cf.js';

const NC_DIMENSION = 10;
const NC_VARIABLE = 11;
const NC_ATTRIBUTE = 12;
const STREAMING = 0xFFFFFFFF;
const TYPES = {
    1: { name: 'byte', size: 1 },
    2: { name: 'char', size: 1 },
    3: { name: 'short', size: 2 },
    4: { name: 'int', size: 4 },
    5: { name: 'float', size: 4 },
    6: { name: 'double', size: 8 },
    7: { name: 'ubyte', size: 1 },
    8: { name: 'ushort', size: 2 },
    9: { name: 'uint', size: 4 },
    10: { name: 'int64', size: 8 },
    11: { name: 'uint64', size: 8 },
};
// A contiguous read may cover elements nobody asked for (the gaps between the
// rows of a region) when that is cheaper than one read per row. Past this
// waste, the request is split along its outermost dimension instead.
const MIN_SPAN_VALUES = 256 * 1024;
const MAX_SPAN_WASTE = 4;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

class NeedMoreHeader extends Error {}

function pad4(length) {
    return (4 - (length % 4)) % 4;
}

class HeaderCursor {
    constructor(bytes, version) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.bytes = bytes;
        this.pos = 0;
        this.version = version;
    }

    need(count) {
        if (this.pos + count > this.view.byteLength) throw new NeedMoreHeader();
    }

    u32() {
        this.need(4);
        const value = this.view.getUint32(this.pos, false);
        this.pos += 4;
        return value;
    }

    u64() {
        this.need(8);
        const high = this.view.getUint32(this.pos, false);
        const low = this.view.getUint32(this.pos + 4, false);
        this.pos += 8;
        return high * 2 ** 32 + low;
    }

    count() {
        return this.version === 5 ? this.u64() : this.u32();
    }

    offset() {
        return this.version === 1 ? this.u32() : this.u64();
    }

    name() {
        const length = this.count();
        this.need(length + pad4(length));
        const text = new TextDecoder('utf-8').decode(this.bytes.subarray(this.pos, this.pos + length));
        this.pos += length + pad4(length);
        return text;
    }

    values(typeId, count) {
        const type = TYPES[typeId];
        if (!type) throw new Error(`Unknown netCDF type ${typeId}.`);
        const byteLength = count * type.size;
        this.need(byteLength + pad4(byteLength));
        const values = decodeValues(typeId, this.bytes.subarray(this.pos, this.pos + byteLength), count);
        this.pos += byteLength + pad4(byteLength);
        if (typeId === 2) return values.join('').replace(/\0+$/, '');
        return Array.from(values, value => (typeof value === 'bigint' ? Number(value) : value));
    }

    attributes() {
        const tag = this.u32();
        const count = this.count();
        if (tag === 0 && count === 0) return [];
        if (tag !== NC_ATTRIBUTE) throw new Error('Malformed netCDF3 header (attribute list).');
        const attributes = [];
        for (let index = 0; index < count; index++) {
            const name = this.name();
            const typeId = this.u32();
            const length = this.count();
            attributes.push({ name, type: TYPES[typeId]?.name, value: this.values(typeId, length) });
        }
        return attributes;
    }
}

/** Big-endian bytes to a typed array of the variable's own type (chars as strings). */
export function decodeValues(typeId, bytes, count) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (typeId) {
    case 1: return new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count));
    case 2: return Array.from(bytes.subarray(0, count), code => String.fromCharCode(code));
    case 7: return new Uint8Array(bytes.subarray(0, count));
    case 3: { const out = new Int16Array(count); for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, false); return out; }
    case 8: { const out = new Uint16Array(count); for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, false); return out; }
    case 4: { const out = new Int32Array(count); for (let i = 0; i < count; i++) out[i] = view.getInt32(i * 4, false); return out; }
    case 9: { const out = new Uint32Array(count); for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, false); return out; }
    case 5: { const out = new Float32Array(count); for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, false); return out; }
    case 6: { const out = new Float64Array(count); for (let i = 0; i < count; i++) out[i] = view.getFloat64(i * 8, false); return out; }
    case 10: { const out = new BigInt64Array(count); for (let i = 0; i < count; i++) out[i] = view.getBigInt64(i * 8, false); return out; }
    case 11: { const out = new BigUint64Array(count); for (let i = 0; i < count; i++) out[i] = view.getBigUint64(i * 8, false); return out; }
    default: throw new Error(`Unknown netCDF type ${typeId}.`);
    }
}

function allocate(typeId, count) {
    switch (typeId) {
    case 1: return new Int8Array(count);
    case 2: return new Array(count);
    case 7: return new Uint8Array(count);
    case 3: return new Int16Array(count);
    case 8: return new Uint16Array(count);
    case 4: return new Int32Array(count);
    case 9: return new Uint32Array(count);
    case 5: return new Float32Array(count);
    case 6: return new Float64Array(count);
    case 10: return new BigInt64Array(count);
    case 11: return new BigUint64Array(count);
    default: throw new Error(`Unknown netCDF type ${typeId}.`);
    }
}

function strides(shape) {
    const result = new Array(shape.length).fill(1);
    for (let axis = shape.length - 2; axis >= 0; axis--) result[axis] = result[axis + 1] * shape[axis + 1];
    return result;
}

function parseHeader(bytes, fileSize) {
    const version = bytes[3];
    const cursor = new HeaderCursor(bytes, version);
    cursor.pos = 4;
    let numrecs = version === 5 ? cursor.u64() : cursor.u32();

    const dimensions = [];
    {
        const tag = cursor.u32();
        const count = cursor.count();
        if (!(tag === 0 && count === 0)) {
            if (tag !== NC_DIMENSION) throw new Error('Malformed netCDF3 header (dimension list).');
            for (let index = 0; index < count; index++) {
                const name = cursor.name();
                const size = cursor.count();
                dimensions.push({ name, size, unlimited: size === 0 });
            }
        }
    }
    const globalAttributes = cursor.attributes();
    const variables = [];
    {
        const tag = cursor.u32();
        const count = cursor.count();
        if (!(tag === 0 && count === 0)) {
            if (tag !== NC_VARIABLE) throw new Error('Malformed netCDF3 header (variable list).');
            for (let index = 0; index < count; index++) {
                const name = cursor.name();
                const rank = cursor.count();
                const dimensionIds = [];
                for (let axis = 0; axis < rank; axis++) dimensionIds.push(cursor.count());
                const attributes = cursor.attributes();
                const typeId = cursor.u32();
                const vsize = cursor.count();
                const begin = cursor.offset();
                variables.push({ name, dimensionIds, attributes, typeId, vsize, begin });
            }
        }
    }

    const recordVariables = variables.filter(variable => dimensions[variable.dimensionIds[0]]?.unlimited);
    const recordBytes = variable => variable.dimensionIds.slice(1)
        .reduce((total, id) => total * dimensions[id].size, TYPES[variable.typeId].size);
    // A lone record variable is not padded to four bytes per record; any other
    // layout is (the spec's one exception to its own alignment rule).
    const recsize = recordVariables.length === 1
        ? recordBytes(recordVariables[0])
        : recordVariables.reduce((total, variable) => {
            const bytesPerRecord = recordBytes(variable);
            return total + bytesPerRecord + pad4(bytesPerRecord);
        }, 0);
    if (numrecs === STREAMING && recsize > 0) {
        const firstRecord = Math.min(...recordVariables.map(variable => variable.begin));
        numrecs = Math.floor((fileSize - firstRecord) / recsize);
    }
    return { version, numrecs, dimensions, globalAttributes, variables, recsize, headerBytes: cursor.pos };
}

/**
 * @param {{size: number, read(offset: number, length: number): Uint8Array}} source
 * @returns {{storageFormat: string, globalAttrs: object, descriptors: object[]}}
 *   descriptors in the same shape the series reader builds for HDF5, so the
 *   dataset engine treats both formats alike.
 */
export function openNetcdf3(source) {
    let headerLength = Math.min(source.size, 64 * 1024);
    let header = null;
    for (;;) {
        try {
            header = parseHeader(source.read(0, headerLength), source.size);
            break;
        } catch (error) {
            if (!(error instanceof NeedMoreHeader) || headerLength >= source.size || headerLength >= MAX_HEADER_BYTES) {
                if (error instanceof NeedMoreHeader) throw new Error('The netCDF3 header is truncated.');
                throw error;
            }
            headerLength = Math.min(source.size, headerLength * 4);
        }
    }
    const storageFormat = header.version === 1 ? 'netcdf3-classic' : header.version === 2 ? 'netcdf3-64-bit-offset' : 'netcdf3-cdf5';
    const descriptors = header.variables.map(variable => {
        const dims = variable.dimensionIds.map(id => header.dimensions[id]);
        const isRecord = Boolean(dims[0]?.unlimited);
        const shape = dims.map(dimension => (dimension.unlimited ? header.numrecs : dimension.size));
        const attrs = attrsFromNetcdf3(variable.attributes);
        return {
            path: `/${variable.name}`,
            name: variable.name,
            group: '/',
            shape,
            dimensions: dims.map(dimension => `/${dimension.name}`),
            attrs,
            userAttrs: attrs,
            supportsSlice: true,
            numeric: variable.typeId !== 2,
            textual: variable.typeId === 2,
            chunks: isRecord ? [1, ...shape.slice(1)] : null,
            read: ranges => readHyperslab(source, header, variable, shape, isRecord, ranges),
        };
    });
    return { storageFormat, globalAttrs: attrsFromNetcdf3(header.globalAttributes), descriptors };
}

function readHyperslab(source, header, variable, shape, isRecord, ranges) {
    const typeId = variable.typeId;
    const size = TYPES[typeId].size;
    const wanted = shape.map((extent, axis) => {
        const range = ranges?.[axis];
        if (!range || !range.length) return [0, extent];
        return [Math.max(0, range[0] ?? 0), Math.min(extent, range[1] ?? extent)];
    });
    const counts = wanted.map(([start, stop]) => Math.max(0, stop - start));
    const total = counts.reduce((a, b) => a * b, 1);
    const out = allocate(typeId, total);
    if (!total) return out;
    let position = 0;

    // Gather one contiguous block of the variable's storage: `dims` are the
    // extents laid out row-major from `byteBase`, `rgs` what is wanted of them.
    const readBlock = (byteBase, dims, rgs) => {
        const blockStrides = strides(dims);
        const needed = rgs.reduce((a, [start, stop]) => a * (stop - start), 1);
        const first = rgs.reduce((a, [start], axis) => a + start * blockStrides[axis], 0);
        const last = rgs.reduce((a, [, stop], axis) => a + (stop - 1) * blockStrides[axis], 0);
        const span = last - first + 1;
        if (dims.length > 1 && span > Math.max(MIN_SPAN_VALUES, needed * MAX_SPAN_WASTE)) {
            for (let index = rgs[0][0]; index < rgs[0][1]; index++) {
                readBlock(byteBase + index * blockStrides[0] * size, dims.slice(1), rgs.slice(1));
            }
            return;
        }
        const values = decodeValues(typeId, source.read(byteBase + first * size, span * size), span);
        const rank = dims.length;
        const index = rgs.map(([start]) => start);
        for (let n = 0; n < needed; n++) {
            let offset = 0;
            for (let axis = 0; axis < rank; axis++) offset += index[axis] * blockStrides[axis];
            out[position++] = values[offset - first];
            for (let axis = rank - 1; axis >= 0; axis--) {
                index[axis] += 1;
                if (index[axis] < rgs[axis][1]) break;
                index[axis] = rgs[axis][0];
            }
        }
    };

    if (isRecord) {
        const inner = shape.slice(1);
        for (let record = wanted[0][0]; record < wanted[0][1]; record++) {
            const base = variable.begin + record * header.recsize;
            if (inner.length) readBlock(base, inner, wanted.slice(1));
            else out[position++] = decodeValues(typeId, source.read(base, size), 1)[0];
        }
    } else if (shape.length) {
        readBlock(variable.begin, shape, wanted);
    } else {
        out[position++] = decodeValues(typeId, source.read(variable.begin, size), 1)[0];
    }
    return out;
}
