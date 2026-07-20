/**
 * Generate a tiny MATLAB Level-5 MAT-file that stores a `timetable`, so the JS
 * parser can be tested against the real MCOS subsystem layout without needing
 * MATLAB (scipy cannot write class objects).
 *
 * The file mirrors what MATLAB emits for `timetable(datetime(...), values)`:
 * a top-level mxOPAQUE placeholder plus a subsystem holding a FileWrapper__
 * object whose cell array carries the metadata table, the datetime row-times
 * and the tabular struct. Elements are written uncompressed for clarity.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../test-files/matlab/timetable-v5.mat', import.meta.url));

const LE = true;
const enc = new TextEncoder();

function concat(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
}

/** A Level-5 element: 8-byte tag + data padded to an 8-byte boundary. */
function element(type, data) {
    const padded = Math.ceil(data.byteLength / 8) * 8;
    const out = new Uint8Array(8 + padded);
    const view = new DataView(out.buffer);
    view.setUint32(0, type, LE);
    view.setUint32(4, data.byteLength, LE);
    out.set(data, 8);
    return out;
}

const u8 = values => Uint8Array.from(values, v => v & 0xff);
const i8 = text => enc.encode(text);
function u32(values) {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, LE));
    return out;
}
function i32(values) {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setInt32(index * 4, value | 0, LE));
    return out;
}
function f64(values) {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setFloat64(index * 8, value, LE));
    return out;
}

const arrayFlags = (classId, flagBits = 0) => element(6, u32([(flagBits << 8) | classId, 0]));

function matrix(classId, dims, name, dataElements) {
    return element(14, concat([
        arrayFlags(classId),
        element(5, i32(dims)),
        element(1, i8(name)),
        ...dataElements,
    ]));
}

const doubleMatrix = (name, dims, values) => matrix(6, dims, name, [element(9, f64(values))]);
const uint8Matrix = (name, dims, values) => matrix(9, dims, name, [element(2, u8(values))]);
const uint32Matrix = (name, dims, values) => matrix(13, dims, name, [element(6, u32(values))]);
const charMatrix = (name, text) => matrix(4, [1, text.length], name, [element(16, i8(text))]);
const emptyMatrix = name => matrix(6, [0, 0], name, []);
const cellMatrix = (name, dims, items) => matrix(1, dims, name, items);

function structMatrix(name, dims, fields) {
    const names = Object.keys(fields);
    const fieldLen = Math.max(...names.map(field => field.length)) + 1;
    const nameBlock = new Uint8Array(names.length * fieldLen);
    names.forEach((field, index) => nameBlock.set(i8(field), index * fieldLen));
    return matrix(2, dims, name, [
        element(5, i32([fieldLen])),
        element(1, nameBlock),
        ...names.map(field => fields[field]),
    ]);
}

/** mxOPAQUE placeholder: [flags(class 17), name, typeSystem, className, ref]. */
function opaque(name, typeSystem, className, refMatrix) {
    return element(14, concat([
        arrayFlags(17),
        element(1, i8(name)),
        element(1, i8(typeSystem)),
        element(1, i8(className)),
        refMatrix,
    ]));
}

const OBJECT_REFERENCE_MARKER = 0xdd000000;
// Scalar object reference: [marker, ndims, dim1, dim2, objectId, classId].
const objectReference = (name, objectId, classId) =>
    uint32Matrix(name, [1, 6], [OBJECT_REFERENCE_MARKER, 2, 1, 1, objectId, classId]);

// ---- Sample timetable content ---------------------------------------------

const rows = 4;
const startMs = Date.UTC(2020, 0, 1, 0, 0, 0);
const rowTimesMs = Array.from({ length: rows }, (_, index) => startMs + index * 3600000);
const values = [1.5, 2.5, 3.5, 4.5];

// ---- MCOS metadata blob ----------------------------------------------------
// Names are 1-indexed: any=1 (timetable payload), data=2 (datetime payload),
// datetime=3, timetable=4.
const names = ['any', 'data', 'datetime', 'timetable'];
function buildMetadata() {
    const header = 32;
    let nameBytes = 0;
    for (const name of names) nameBytes += name.length + 1;
    const namesEnd = header + Math.ceil(nameBytes / 8) * 8;

    const classTable = namesEnd;                 // reserved, datetime, timetable
    const segment1 = classTable + 3 * 16;
    const objectTable = segment1 + 24;           // reserved, timetable, datetime
    const segment2 = objectTable + 3 * 24;
    const segment3 = segment2 + 24;
    const end = segment3;

    const blob = new Uint8Array(end);
    const view = new DataView(blob.buffer);
    const setU32 = (offset, value) => view.setUint32(offset, value >>> 0, LE);

    // Header: [ver, nStrings, region offsets...]. Only the offsets are read back.
    [4, names.length, classTable, segment1, objectTable, segment2, segment3, end]
        .forEach((value, index) => setU32(index * 4, value));

    // String table.
    let cursor = header;
    for (const name of names) { blob.set(i8(name), cursor); cursor += name.length + 1; }

    // Class table: [namespaceNameIdx, classNameIdx, 0, 0]; entry 0 is reserved.
    setU32(classTable + 16 + 4, 3); // classId 1 -> datetime
    setU32(classTable + 32 + 4, 4); // classId 2 -> timetable

    // Property segment 1 (block index 1 = timetable): { any(1), flag 1, cell value 1 }.
    [0, 0, 1, 1, 1, 1].forEach((value, index) => setU32(segment1 + index * 4, value));

    // Object table: [classId, 0, 0, seg1Idx, seg2Idx, dep]; entry 0 reserved.
    [2, 0, 0, 1, 0, 0].forEach((value, index) => setU32(objectTable + 24 + index * 4, value)); // obj1 timetable
    [1, 0, 0, 0, 1, 0].forEach((value, index) => setU32(objectTable + 48 + index * 4, value)); // obj2 datetime

    // Property segment 2 (block index 1 = datetime): { data(2), flag 1, cell value 0 }.
    [0, 0, 1, 2, 1, 0].forEach((value, index) => setU32(segment2 + index * 4, value));

    return blob;
}

// ---- FileWrapper cell array ------------------------------------------------
// cell{1}=metadata, cell{2}=reserved, cell{3}=datetime ms (value 0),
// cell{4}=tabular struct (value 1).
const tabularStruct = structMatrix('', [1, 1], {
    data: cellMatrix('', [1, 1], [doubleMatrix('', [rows, 1], values)]),
    varNames: cellMatrix('', [1, 1], [charMatrix('', 'power_kW')]),
    dimNames: cellMatrix('', [1, 2], [charMatrix('', 'time'), charMatrix('', 'Variables')]),
    numRows: doubleMatrix('', [1, 1], [rows]),
    numVars: doubleMatrix('', [1, 1], [1]),
    rowTimes: objectReference('', 2, 1), // datetime object id 2, class id 1
});

const fileWrapper = opaque('', 'MCOS', 'FileWrapper__', cellMatrix('', [4, 1], [
    uint8Matrix('', [buildMetadata().length, 1], buildMetadata()),
    emptyMatrix(''),
    doubleMatrix('', [rows, 1], rowTimesMs),
    tabularStruct,
]));

// Inner subsystem stream: 8-byte header + struct{ MCOS: FileWrapper__ }.
const innerHeader = u8([0x00, 0x01, 0x49, 0x4d, 0, 0, 0, 0]);
const innerStream = concat([innerHeader, structMatrix('', [1, 1], { MCOS: fileWrapper })]);

// The subsystem itself is a uint8 miMATRIX wrapping that stream.
const subsystemElement = uint8Matrix('', [1, innerStream.length], innerStream);

// Top-level opaque timetable variable referencing object id 1 (class id 2).
const topVariable = opaque('trace', 'MCOS', 'timetable', objectReference('', 1, 2));

// ---- Assemble the file -----------------------------------------------------
const header = new Uint8Array(128);
const headerView = new DataView(header.buffer);
header.set(i8('MATLAB 5.0 MAT-file, Platform: synthetic, Created by timeseries-explorer tests'));
const subsysOffset = 128 + topVariable.length;
headerView.setUint32(116, subsysOffset >>> 0, LE); // subsystem byte offset (low)
headerView.setUint32(120, 0, LE);                   // (high)
headerView.setUint16(124, 0x0100, LE);              // version
header.set(i8('IM'), 126);                          // little-endian marker

writeFileSync(OUT, concat([header, topVariable, subsystemElement]));
console.log(`Generated MATLAB timetable fixture at ${OUT}`);
