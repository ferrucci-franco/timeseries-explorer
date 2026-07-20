/**
 * MATLAB MCOS (MATLAB Class Object System) subsystem reader.
 *
 * MATLAB stores class objects — timetable, table, datetime, duration,
 * categorical, string, containers.Map, and user classes — in an undocumented
 * "subsystem" region of Level 5 / v7 MAT-files. The top-level variable is an
 * mxOPAQUE_CLASS placeholder that only references object ids; the real data
 * lives in the subsystem as a FileWrapper__ object whose payload is a cell
 * array of property values plus a binary metadata table describing classes,
 * objects and their properties.
 *
 * This module parses that subsystem into a graph of objects and exposes a few
 * interpreters (timetable/table/datetime/duration) so the general MAT reader
 * can turn a saved timetable back into a time axis and numeric columns.
 *
 * The format was reconstructed from real files and matches the public
 * reverse-engineering work (mahalex/MatFileHandler, pymatreader).
 */

const MAT5_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 14, 15, 16, 17, 18]);
const OBJECT_REFERENCE_MARKER = 0xdd000000;

function decodeAscii(bytes) {
    return new TextDecoder('latin1').decode(bytes).replace(/\0+$/g, '');
}

export function isObjectReferenceArray(values) {
    return Array.isArray(values) && values.length >= 6 && (values[0] >>> 0) === OBJECT_REFERENCE_MARKER;
}

/**
 * Decode a MATLAB object-reference array
 * `[0xDD000000, ndims, dim1..dimN, objId1..objIdM, classId]`.
 */
export function decodeObjectReference(values) {
    const ndims = Number(values[1]) || 0;
    const dims = values.slice(2, 2 + ndims).map(Number);
    const count = dims.reduce((total, size) => total * Math.max(0, size || 0), dims.length ? 1 : 0) || 1;
    const objectIds = values.slice(2 + ndims, 2 + ndims + count).map(Number);
    const classId = Number(values[2 + ndims + count]);
    return { dims, objectIds, classId };
}

/** Low-level Level 5 element reader, self-contained so callers stay decoupled. */
class Mat5Stream {
    constructor(bytes, littleEndian = true) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.le = littleEndian;
    }

    tag(offset) {
        if (offset + 8 > this.bytes.byteLength) return null;
        const regularType = this.view.getUint32(offset, this.le);
        if (MAT5_TYPES.has(regularType)) {
            const length = this.view.getUint32(offset + 4, this.le);
            return {
                type: regularType,
                length,
                dataOffset: offset + 8,
                nextOffset: offset + 8 + Math.ceil(length / 8) * 8,
            };
        }
        const type = this.view.getUint16(offset, this.le);
        const length = this.view.getUint16(offset + 2, this.le);
        if (!MAT5_TYPES.has(type) || length > 4) return null;
        return { type, length, dataOffset: offset + 4, nextOffset: offset + 8, small: true };
    }

    subElements(dataOffset, length) {
        const parts = [];
        let offset = dataOffset;
        const end = dataOffset + length;
        while (offset + 8 <= end) {
            const tag = this.tag(offset);
            if (!tag || tag.nextOffset <= offset || tag.dataOffset + tag.length > end) break;
            parts.push(tag);
            offset = tag.nextOffset;
        }
        return parts;
    }

    numbers(tag) {
        if (!tag) return [];
        const reader = {
            1: [1, o => this.view.getInt8(o)], 2: [1, o => this.view.getUint8(o)],
            3: [2, o => this.view.getInt16(o, this.le)], 4: [2, o => this.view.getUint16(o, this.le)],
            5: [4, o => this.view.getInt32(o, this.le)], 6: [4, o => this.view.getUint32(o, this.le)],
            7: [4, o => this.view.getFloat32(o, this.le)], 9: [8, o => this.view.getFloat64(o, this.le)],
            12: [8, o => Number(this.view.getBigInt64(o, this.le))], 13: [8, o => Number(this.view.getBigUint64(o, this.le))],
            16: [1, o => this.view.getUint8(o)], 17: [2, o => this.view.getUint16(o, this.le)], 18: [4, o => this.view.getUint32(o, this.le)],
        }[tag.type];
        if (!reader) return [];
        const [size, read] = reader;
        const values = [];
        for (let offset = tag.dataOffset; offset + size <= tag.dataOffset + tag.length; offset += size) {
            values.push(read(offset));
        }
        return values;
    }

    text(tag) {
        if (!tag) return '';
        return decodeAscii(this.bytes.subarray(tag.dataOffset, tag.dataOffset + tag.length));
    }

    /** Parse a miMATRIX element into a normalized value node (recursive). */
    matrix(tag) {
        const parts = this.subElements(tag.dataOffset, tag.length);
        if (parts.length < 3) return { kind: 'empty' };
        const flags = this.numbers(parts[0]);
        const classId = Number(flags[0] || 0) & 0xff;

        if (classId === 17) { // mxOPAQUE_CLASS: [flags, name, typeSystem, className, payload]
            const chars = parts.slice(1).filter(part => part.type === 4 || part.type === 16).map(part => this.text(part));
            const payload = parts.find(part => part.type === 14);
            const value = payload ? this.matrix(payload) : { kind: 'empty' };
            return { kind: 'opaque', className: chars[chars.length - 1] || '', value };
        }

        const dims = this.numbers(parts[1]).map(size => Math.max(0, Number(size) || 0));
        const count = dims.reduce((total, size) => total * size, dims.length ? 1 : 0);

        if (classId === 1) { // cell
            const items = parts.slice(3).filter(part => part.type === 14).map(part => this.matrix(part));
            return { kind: 'cell', dims, items };
        }
        if (classId === 2 || classId === 3) { // struct / object payload
            const fieldLength = Number(this.numbers(parts[3])[0] || 0);
            const nameBytes = this.bytes.subarray(parts[4].dataOffset, parts[4].dataOffset + parts[4].length);
            const fieldNames = [];
            for (let offset = 0; fieldLength > 0 && offset < nameBytes.length; offset += fieldLength) {
                fieldNames.push(decodeAscii(nameBytes.subarray(offset, offset + fieldLength)));
            }
            const matrices = parts.slice(5).filter(part => part.type === 14);
            const instances = Math.max(1, count);
            const fields = {};
            for (let field = 0; field < fieldNames.length; field++) {
                const matrix = matrices[field]; // first instance only (scalar structs cover our needs)
                fields[fieldNames[field]] = matrix ? this.matrix(matrix) : { kind: 'empty' };
            }
            return { kind: 'struct', dims, fieldNames, fields, instances };
        }
        if (classId === 4) { // char
            const codes = parts[3] ? this.numbers(parts[3]) : [];
            return { kind: 'char', dims, text: String.fromCodePoint(...codes.filter(code => code > 0 && code <= 0x10ffff)) };
        }
        // numeric / logical — a bare object reference is a uint32 array with the marker.
        const data = parts[3] ? this.numbers(parts[3]) : [];
        if (isObjectReferenceArray(data)) {
            return { kind: 'objref', dims, ...decodeObjectReference(data) };
        }
        return { kind: 'numeric', classId, dims, data };
    }
}

export default class McosSubsystem {
    /**
     * @param {Uint8Array} bytes decompressed subsystem payload (the uint8 blob
     *   whose contents form the FileWrapper stream).
     * @param {boolean} littleEndian endianness of the parent MAT-file.
     */
    constructor(bytes, littleEndian = true) {
        this.stream = new Mat5Stream(bytes, littleEndian);
        this.classes = [];   // classId -> { name }
        this.objects = [];   // objectId -> { classId, className, props }
        this.cells = [];     // FileWrapper cell contents (value nodes)
        this._cache = new Map();
        this._parse();
    }

    _parse() {
        // The payload begins with an 8-byte header (version + "IM"/"MI"); the
        // FileWrapper stream is the miMATRIX that follows.
        const rootTag = this.stream.tag(8);
        if (!rootTag) throw new Error('MATLAB subsystem is not a MAT stream.');
        const root = this.stream.matrix(rootTag);
        const wrapper = this._findFileWrapperCells(root);
        if (!wrapper) throw new Error('MATLAB subsystem has no FileWrapper cell array.');
        this.cells = wrapper.items;
        this._parseMetadata(this.cells[0]);
    }

    _findFileWrapperCells(node) {
        // root is a scalar struct whose (only) opaque field resolves, in the
        // stream, to a cell array of [metadata, ...values].
        if (node?.kind === 'cell') return node;
        if (node?.kind === 'opaque') return this._findFileWrapperCells(node.value);
        if (node?.kind === 'struct') {
            for (const name of node.fieldNames) {
                const found = this._findFileWrapperCells(node.fields[name]);
                if (found) return found;
            }
        }
        return null;
    }

    _parseMetadata(metaCell) {
        if (metaCell?.kind !== 'numeric') throw new Error('MATLAB subsystem metadata is missing.');
        const blob = Uint8Array.from(metaCell.data, value => value & 0xff);
        const view = new DataView(blob.buffer);
        const le = this.stream.le;
        const u32 = offset => view.getUint32(offset, le);
        const region = [u32(8), u32(12), u32(16), u32(20), u32(24), u32(28)];

        // Names: after the 32-byte header, skip alignment nulls, then read
        // null-terminated strings until the first region begins. 1-indexed.
        this.names = [''];
        let cursor = 32;
        while (cursor < region[0] && blob[cursor] === 0) cursor += 1;
        while (cursor < region[0]) {
            let end = cursor;
            while (end < region[0] && blob[end] !== 0) end += 1;
            if (end > cursor) this.names.push(decodeAscii(blob.subarray(cursor, end)));
            cursor = end + 1;
        }

        // Class table: entries of 4 uint32 [namespaceNameIdx, classNameIdx, 0, 0].
        // The first entry is the reserved classId 0, so classId indexes directly.
        this.classes = [];
        for (let offset = region[0]; offset + 16 <= region[1]; offset += 16) {
            this.classes.push({ name: this.names[u32(offset + 4)] || '' });
        }

        const segment1 = this._parsePropertySegment(view, region[1], region[2], le);
        // Object table: entries of 6 uint32 [classId, 0, 0, seg1Idx, seg2Idx, objDepId].
        const objectTable = [];
        for (let offset = region[2]; offset + 24 <= region[3]; offset += 24) {
            objectTable.push({
                classId: u32(offset),
                seg1: u32(offset + 12),
                seg2: u32(offset + 16),
            });
        }
        const segment2 = this._parsePropertySegment(view, region[3], region[4], le);

        this.objects = objectTable.map((entry, index) => {
            if (index === 0) return { classId: 0, className: '', props: [] };
            const props = [...(segment1[entry.seg1] || []), ...(segment2[entry.seg2] || [])];
            return {
                classId: entry.classId,
                className: this.classes[entry.classId]?.name || '',
                props,
            };
        });
    }

    /** Parse a property segment into an array of per-object property blocks. */
    _parsePropertySegment(view, start, end, le) {
        const u32 = offset => view.getUint32(offset, le);
        const blocks = [];
        let offset = start;
        while (offset + 4 <= end) {
            const count = u32(offset);
            offset += 4;
            const props = [];
            for (let index = 0; index < count && offset + 12 <= end; index++) {
                props.push({ nameIdx: u32(offset), flag: u32(offset + 4), value: u32(offset + 8) });
                offset += 12;
            }
            blocks.push(props);
            // Blocks are padded so the next block starts on an 8-byte boundary.
            if ((offset - start) % 8 !== 0) offset += 4;
        }
        return blocks;
    }

    /** Resolve a property flag/value pair into a value node. */
    _propertyValue(prop) {
        // flag 1: value indexes the FileWrapper value cells (cell{1} is metadata,
        // cell{2} is reserved, values start at cell{3} == index 0).
        if (prop.flag === 1) return this.cells[prop.value + 2] || { kind: 'empty' };
        // flag 2: the value is the property itself, stored inline as an integer.
        if (prop.flag === 2) return { kind: 'numeric', classId: 13, dims: [1, 1], data: [prop.value] };
        // flag 0: a boolean-valued property (0/1) stored inline.
        return { kind: 'numeric', classId: 9, dims: [1, 1], data: [prop.value] };
    }

    object(objectId) {
        return this.objects[objectId] || null;
    }

    property(objectId, name) {
        const object = this.objects[objectId];
        if (!object) return null;
        for (const prop of object.props) {
            if (this.names[prop.nameIdx] === name) return this._propertyValue(prop);
        }
        return null;
    }

    /** Map a value node into a plain interpreted value, following object refs. */
    resolve(node) {
        if (!node) return null;
        if (node.kind === 'objref') {
            return node.objectIds.map(id => this.resolveObject(id, node.classId));
        }
        if (node.kind === 'cell') return node.items.map(item => this.resolve(item));
        if (node.kind === 'char') return node.text;
        if (node.kind === 'numeric') return node;
        if (node.kind === 'struct') {
            const out = {};
            for (const name of node.fieldNames) out[name] = this.resolve(node.fields[name]);
            return out;
        }
        return null;
    }

    // ---- High-level interpreters -------------------------------------------

    _scalar(node) {
        return node && node.kind === 'numeric' && node.data.length ? Number(node.data[0]) : null;
    }

    _stringList(value) {
        if (typeof value === 'string') return [value];
        if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
        return [];
    }

    _numericArray(node) {
        if (Array.isArray(node)) return node.length && node[0]?.className ? this._objectMillis(node[0]) : node.map(Number);
        if (node && node.kind === 'numeric') return node.data.map(Number);
        return null;
    }

    /** Milliseconds since the Unix epoch for a datetime, or ms for a duration. */
    _objectMillis(object) {
        const cls = object?.className;
        if (cls === 'datetime') return this._numericArray(object.props?.data) || [];
        if (cls === 'duration') return this._numericArray(object.props?.millis) || [];
        return [];
    }

    _tabularStruct(object) {
        for (const value of Object.values(object.props || {})) {
            if (value && typeof value === 'object' && !Array.isArray(value)
                && 'varNames' in value && 'data' in value) {
                return value;
            }
        }
        return null;
    }

    _columnSeries(name, column, numRows) {
        const series = [];
        // A variable that is itself a datetime/duration object collapses to ms.
        if (Array.isArray(column) && column[0]?.className) {
            series.push({ name, data: this._objectMillis(column[0]) });
            return series;
        }
        if (!column || column.kind !== 'numeric') return series;
        const rows = numRows || column.dims?.[0] || column.data.length;
        const cols = rows > 0 ? Math.max(1, Math.round(column.data.length / rows)) : 1;
        if (cols <= 1) {
            series.push({ name, data: column.data.map(Number) });
            return series;
        }
        // Column-major matrix variable: one series per sub-column.
        for (let col = 0; col < cols; col++) {
            const values = new Array(rows);
            for (let row = 0; row < rows; row++) values[row] = Number(column.data[col * rows + row]);
            series.push({ name: `${name}[${col + 1}]`, data: values });
        }
        return series;
    }

    /**
     * Interpret a resolved timetable/table object into a time axis and columns.
     * Returns null when the object is not tabular.
     */
    interpretTable(objectId) {
        const object = this.resolveObject(objectId);
        if (object.className !== 'timetable' && object.className !== 'table') return null;
        const guts = this._tabularStruct(object);
        if (!guts) return null;
        const numRows = this._scalar(guts.numRows) || 0;
        const varNames = this._stringList(guts.varNames);
        const dimNames = this._stringList(guts.dimNames);
        const dataColumns = Array.isArray(guts.data) ? guts.data : [];

        let time = { kind: 'index', name: dimNames[0] || 'Row', values: null };
        const rowTimes = Array.isArray(guts.rowTimes) ? guts.rowTimes[0] : null;
        if (rowTimes?.className === 'datetime') {
            time = { kind: 'datetime', name: dimNames[0] || 'Time', values: this._objectMillis(rowTimes) };
        } else if (rowTimes?.className === 'duration') {
            // durations are relative; expose as seconds on a numeric axis.
            time = { kind: 'numeric', name: dimNames[0] || 'Time', values: this._objectMillis(rowTimes).map(ms => ms / 1000) };
        }

        const columns = [];
        varNames.forEach((name, index) => {
            for (const series of this._columnSeries(name, dataColumns[index], numRows)) columns.push(series);
        });
        return { className: object.className, numRows, time, columns };
    }

    resolveObject(objectId, classIdHint = null) {
        if (this._cache.has(objectId)) return this._cache.get(objectId);
        const object = this.objects[objectId];
        const className = object?.className || this.classes[classIdHint]?.name || '';
        const result = { objectId, className, props: {} };
        this._cache.set(objectId, result);
        if (object) {
            for (const prop of object.props) {
                result.props[this.names[prop.nameIdx]] = this.resolve(this._propertyValue(prop));
            }
        }
        return result;
    }
}
