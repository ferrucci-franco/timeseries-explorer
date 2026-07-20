/**
 * Generate tiny MATLAB Level-5 MAT-files that store MCOS class objects, so the
 * JS parser can be tested against the real subsystem layout without needing
 * MATLAB (scipy cannot write class objects).
 *
 * Three fixtures are produced, covering the serialization forms MATLAB uses:
 *   - timetable-v5.mat: a `timetable`, whose tabular fields live in one nested
 *     struct property and whose datetime row-times are the axis.
 *   - regular-timetable-v5.mat: a `timetable` whose regularly spaced row-times
 *     are stored compactly as an origin plus step size/sample rate.
 *   - table-v5.mat: a `table`, whose fields (data/varnames/nrows/…) are stored
 *     directly on the object and whose first column is a datetime variable.
 *
 * Elements are written uncompressed for clarity; real files zlib-compress them.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
function typedBytes(values, bytesPer, setter) {
    const out = new Uint8Array(values.length * bytesPer);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => setter(view, index * bytesPer, value));
    return out;
}
const u32 = values => typedBytes(values, 4, (view, offset, value) => view.setUint32(offset, value >>> 0, LE));
const i32 = values => typedBytes(values, 4, (view, offset, value) => view.setInt32(offset, value | 0, LE));
const f64 = values => typedBytes(values, 8, (view, offset, value) => view.setFloat64(offset, value, LE));

const arrayFlags = classId => element(6, u32([classId, 0]));

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
    const fieldLen = Math.max(1, ...names.map(field => field.length)) + 1;
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

// ---- MCOS metadata + file assembly ----------------------------------------

/** Serialize property blocks into 8-byte-aligned uint32 words. */
function serializeSegment(blocks) {
    const words = [];
    for (const block of blocks) {
        words.push(block.length);
        for (const prop of block) words.push(prop.nameIdx, prop.flag, prop.value);
        if (words.length % 2 !== 0) words.push(0); // pad to an 8-byte boundary
    }
    return words;
}

/**
 * Build a whole MAT-file for one MCOS object.
 * @param names   1-indexed string table (index 0 is '').
 * @param classes classId 1..N -> { nameIdx }.
 * @param objects objId 1..M -> { classId, seg1: props[], seg2: props[] } where
 *                a prop is { nameIdx, flag, value }; value indexes valueCells.
 * @param valueCells miMATRIX elements addressed by property value (0-based).
 */
function buildMcosFile({ topVar, className, topObjectId, names, classes, objects, valueCells }) {
    const seg1Blocks = [[]];
    const seg2Blocks = [[]];
    const objectMeta = objects.map(object => {
        let seg1 = 0;
        let seg2 = 0;
        if (object.seg1?.length) { seg1 = seg1Blocks.length; seg1Blocks.push(object.seg1); }
        if (object.seg2?.length) { seg2 = seg2Blocks.length; seg2Blocks.push(object.seg2); }
        return { classId: object.classId, seg1, seg2 };
    });
    const seg1Words = serializeSegment(seg1Blocks);
    const seg2Words = serializeSegment(seg2Blocks);

    const nameBytes = names.slice(1).reduce((sum, name) => sum + name.length + 1, 0);
    const headerEnd = 32;
    const classTable = headerEnd + Math.ceil(nameBytes / 8) * 8;
    const segment1 = classTable + (classes.length + 1) * 16;
    const objectTable = segment1 + seg1Words.length * 4;
    const segment2 = objectTable + (objectMeta.length + 1) * 24;
    const segment3 = segment2 + seg2Words.length * 4;
    const end = segment3;

    const blob = new Uint8Array(end);
    const view = new DataView(blob.buffer);
    const setU32 = (offset, value) => view.setUint32(offset, value >>> 0, LE);
    [4, names.length, classTable, segment1, objectTable, segment2, segment3, end]
        .forEach((value, index) => setU32(index * 4, value));

    let cursor = headerEnd;
    for (const name of names.slice(1)) { blob.set(i8(name), cursor); cursor += name.length + 1; }

    classes.forEach((entry, index) => setU32(classTable + (index + 1) * 16 + 4, entry.nameIdx));
    seg1Words.forEach((word, index) => setU32(segment1 + index * 4, word));
    objectMeta.forEach((object, index) => {
        const base = objectTable + (index + 1) * 24;
        setU32(base, object.classId);
        setU32(base + 12, object.seg1);
        setU32(base + 16, object.seg2);
    });
    seg2Words.forEach((word, index) => setU32(segment2 + index * 4, word));

    // FileWrapper cells: [metadata, reserved, ...valueCells]; property value v
    // addresses cell index v + 2.
    const cells = [uint8Matrix('', [blob.length, 1], blob), emptyMatrix(''), ...valueCells];
    const fileWrapper = opaque('', 'MCOS', 'FileWrapper__', cellMatrix('', [cells.length, 1], cells));
    const innerHeader = u8([0x00, 0x01, 0x49, 0x4d, 0, 0, 0, 0]);
    const innerStream = concat([innerHeader, structMatrix('', [1, 1], { MCOS: fileWrapper })]);
    const subsystemElement = uint8Matrix('', [1, innerStream.length], innerStream);
    const topVariable = opaque(topVar, 'MCOS', className, objectReference('', topObjectId, classes.findIndex(c => c.name === className) + 1));

    const header = new Uint8Array(128);
    const headerView = new DataView(header.buffer);
    header.set(i8('MATLAB 5.0 MAT-file, Platform: synthetic, Created by timeseries-explorer tests'));
    headerView.setUint32(116, (128 + topVariable.length) >>> 0, LE); // subsystem byte offset
    headerView.setUint16(124, 0x0100, LE);
    header.set(i8('IM'), 126);
    return concat([header, topVariable, subsystemElement]);
}

// ---- timetable fixture (nested-struct form) --------------------------------

function timetableFixture() {
    const rows = 4;
    const start = Date.UTC(2020, 0, 1, 0, 0, 0);
    const rowTimesMs = Array.from({ length: rows }, (_, index) => start + index * 3600000);
    const tabular = structMatrix('', [1, 1], {
        data: cellMatrix('', [1, 1], [doubleMatrix('', [rows, 1], [1.5, 2.5, 3.5, 4.5])]),
        varNames: cellMatrix('', [1, 1], [charMatrix('', 'power_kW')]),
        dimNames: cellMatrix('', [1, 2], [charMatrix('', 'time'), charMatrix('', 'Variables')]),
        numRows: doubleMatrix('', [1, 1], [rows]),
        numVars: doubleMatrix('', [1, 1], [1]),
        rowTimes: objectReference('', 2, 1),
    });
    return buildMcosFile({
        topVar: 'trace', className: 'timetable', topObjectId: 1,
        names: ['', 'any', 'data', 'datetime', 'timetable'],
        classes: [{ name: 'datetime', nameIdx: 3 }, { name: 'timetable', nameIdx: 4 }],
        objects: [
            { classId: 2, seg1: [{ nameIdx: 1, flag: 1, value: 1 }] }, // timetable.any -> valueCells[1]
            { classId: 1, seg2: [{ nameIdx: 2, flag: 1, value: 0 }] }, // datetime.data -> valueCells[0]
        ],
        valueCells: [doubleMatrix('', [rows, 1], rowTimesMs), tabular],
    });
}

// ---- regular timetable fixture (compact row-times form) -------------------

function regularTimetableFixture() {
    const rows = 5;
    const start = Date.UTC(2021, 0, 6, 0, 0, 0);
    const tabular = structMatrix('', [1, 1], {
        data: cellMatrix('', [1, 1], [doubleMatrix('', [rows, 1], [10, 20, 30, 40, 50])]),
        varNames: cellMatrix('', [1, 1], [charMatrix('', 'solar_kW')]),
        dimNames: cellMatrix('', [1, 2], [charMatrix('', 'date'), charMatrix('', 'Variables')]),
        numRows: doubleMatrix('', [1, 1], [rows]),
        numVars: doubleMatrix('', [1, 1], [1]),
        rowTimes: structMatrix('', [1, 1], {
            origin: objectReference('', 2, 1),
            specifiedAsRate: uint8Matrix('', [1, 1], [0]),
            stepSize: objectReference('', 3, 2),
            sampleRate: doubleMatrix('', [1, 1], [1 / 60]),
        }),
    });
    return buildMcosFile({
        topVar: 'solar', className: 'timetable', topObjectId: 1,
        names: ['', 'any', 'data', 'datetime', 'millis', 'duration', 'timetable'],
        classes: [
            { name: 'datetime', nameIdx: 3 },
            { name: 'duration', nameIdx: 5 },
            { name: 'timetable', nameIdx: 6 },
        ],
        objects: [
            { classId: 3, seg1: [{ nameIdx: 1, flag: 1, value: 2 }] },
            { classId: 1, seg2: [{ nameIdx: 2, flag: 1, value: 0 }] },
            { classId: 2, seg2: [{ nameIdx: 4, flag: 1, value: 1 }] },
        ],
        valueCells: [
            doubleMatrix('', [1, 1], [start]),
            doubleMatrix('', [1, 1], [60000]),
            tabular,
        ],
    });
}

// ---- table fixture (direct-property form, datetime column) -----------------

function tableFixture() {
    const rows = 3;
    const start = Date.UTC(2016, 0, 1, 0, 0, 0);
    const dateMs = Array.from({ length: rows }, (_, index) => start + index * 3600000);
    const dataCell = cellMatrix('', [1, 2], [
        objectReference('', 2, 1),               // date column -> datetime object 2
        doubleMatrix('', [rows, 1], [10, 20, 30]), // load_MW column
    ]);
    return buildMcosFile({
        topVar: 'edt', className: 'table', topObjectId: 1,
        names: ['', 'data', 'ndims', 'nrows', 'rownames', 'nvars', 'varnames', 'props', 'datetime', 'table'],
        classes: [{ name: 'datetime', nameIdx: 8 }, { name: 'table', nameIdx: 9 }],
        objects: [
            {
                classId: 2,
                seg1: [
                    { nameIdx: 1, flag: 1, value: 0 }, // data -> valueCells[0]
                    { nameIdx: 2, flag: 1, value: 3 }, // ndims
                    { nameIdx: 3, flag: 1, value: 2 }, // nrows
                    { nameIdx: 4, flag: 1, value: 5 }, // rownames
                    { nameIdx: 5, flag: 1, value: 4 }, // nvars
                    { nameIdx: 6, flag: 1, value: 1 }, // varnames -> valueCells[1]
                    { nameIdx: 7, flag: 1, value: 6 }, // props
                ],
            },
            { classId: 1, seg2: [{ nameIdx: 1, flag: 1, value: 7 }] }, // datetime.data -> valueCells[7]
        ],
        valueCells: [
            dataCell,
            cellMatrix('', [1, 2], [charMatrix('', 'date'), charMatrix('', 'load_MW')]),
            doubleMatrix('', [1, 1], [rows]),  // nrows
            doubleMatrix('', [1, 1], [2]),     // ndims
            doubleMatrix('', [1, 1], [2]),     // nvars
            cellMatrix('', [0, 0], []),        // rownames
            emptyMatrix(''),                   // props
            doubleMatrix('', [rows, 1], dateMs),
        ],
    });
}

const timetablePath = fileURLToPath(new URL('../test-files/matlab/timetable-v5.mat', import.meta.url));
const regularTimetablePath = fileURLToPath(new URL('../test-files/matlab/regular-timetable-v5.mat', import.meta.url));
const tablePath = fileURLToPath(new URL('../test-files/matlab/table-v5.mat', import.meta.url));
writeFileSync(timetablePath, timetableFixture());
writeFileSync(regularTimetablePath, regularTimetableFixture());
writeFileSync(tablePath, tableFixture());
console.log(`Generated MATLAB MCOS fixtures:\n  ${timetablePath}\n  ${regularTimetablePath}\n  ${tablePath}`);
