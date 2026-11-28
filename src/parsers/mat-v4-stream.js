// An OpenModelica / Dymola result file (MAT v4 trajectory) read by parts.
//
// MatParser reads the whole file into memory. A result of several GB does not
// fit, so this reader never holds it: it walks the matrix headers by slices of
// the File, reads the small matrices that describe the variables (names,
// descriptions, dataInfo, the parameters of data_1) and hands the samples of
// data_2 out a block of time steps at a time.
//
// data_2 of a trajectory written "binTrans" (what OpenModelica and Dymola
// write) is stored one time step after the other: `mrows` series for step 0,
// then `mrows` for step 1, … So a stretch of the file is a stretch of time,
// and a block of steps is one slice.
//
// What a variable is — its name, kind, row and sign — is decided by
// MatParser.describeTrajectory, the same code the in-memory path runs.
//
// The reader is a "columnar reader": the shape src/data/columnar-ingest.js
// turns into a memory-saving (lazy) dataset. A reader for another format (a
// MATLAB v5 or v7.3 file, issue #396) that gives the same shape is opened
// lazily by the same ingest:
//
//   {
//     format,                    // 'mat-v4'
//     rows,                      // time steps
//     columns,                   // how many series `blocks` yields, the time among them
//     timeColumn,                // which of them is the time
//     variables: [{ name, description, kind, interpolation, negate,
//                   column,       // index into the block's columns
//                   extra }       // fields the generic shape has no room for
//                 | { …, kind: 'parameter', values }],   // a constant, held here
//     metadata,                  // format-specific, kept on the dataset
//     timeKind?,                 // 'datetime' when the axis is milliseconds
//     buildTree?,                // (variables) → the tree this format groups by
//     async *blocks({ signal, blockBytes }) → { rowStart, rows, columns: Float64Array[] }
//   }

import MatParser from './mat-parser.js';

const HEADER_BYTES = 20;
const ELEM_SIZES = { 0: 8, 1: 4, 2: 4, 3: 2, 4: 2, 5: 1 };
// The matrices that describe the variables are read whole, and decoded where
// this is called; past this they are not "small" (hundreds of thousands of
// variables) and the file is left to the in-memory path and its own limits.
const MAX_DESCRIPTION_BYTES = 64 * 1024 * 1024;
export const MAT_V4_BLOCK_BYTES = 8 * 1024 * 1024;

const sliceBuffer = (blob, start, end) => blob.slice(start, end).arrayBuffer();

function abortError() {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * The matrices of a MAT v4 file: where each one is, never its values.
 * The header is validated as MatParser._readMatrices validates it. Null when
 * the file is not MAT v4 (a Level 5 or 7.3 file starts with a text header).
 */
export async function scanMatV4(blob) {
    const size = Number(blob?.size) || 0;
    if (size < HEADER_BYTES) return null;
    const head = new Uint8Array(await sliceBuffer(blob, 0, Math.min(size, 6)));
    if (String.fromCharCode(...head) === 'MATLAB') return null;
    const matrices = [];
    let offset = 0;
    while (offset + HEADER_BYTES <= size) {
        // The header and, nearly always, the name in one read.
        const chunk = await sliceBuffer(blob, offset, Math.min(size, offset + HEADER_BYTES + 256));
        const view = new DataView(chunk);
        let littleEndian = true;
        let mopt = view.getInt32(0, true);
        let mrows = view.getInt32(4, true);
        let ncols = view.getInt32(8, true);
        let imagf = view.getInt32(12, true);
        let namlen = view.getInt32(16, true);
        if (Math.floor(mopt / 1000) > 1 || mrows < 0 || ncols < 0 || namlen < 1 || namlen > 100000) {
            littleEndian = false;
            mopt = view.getInt32(0, false);
            mrows = view.getInt32(4, false);
            ncols = view.getInt32(8, false);
            imagf = view.getInt32(12, false);
            namlen = view.getInt32(16, false);
            if (mrows < 0 || ncols < 0 || namlen < 1) break;
        }
        const P = Math.floor((mopt % 100) / 10);
        const T = mopt % 10;
        const elemSize = ELEM_SIZES[P] || 8;
        const nameStart = offset + HEADER_BYTES;
        if (nameStart + namlen > size) return matrices.length ? matrices : null;
        const nameBytes = namlen <= chunk.byteLength - HEADER_BYTES
            ? new Uint8Array(chunk, HEADER_BYTES, namlen)
            : new Uint8Array(await sliceBuffer(blob, nameStart, nameStart + namlen));
        let name = '';
        for (let i = 0; i < namlen; i++) {
            if (nameBytes[i] === 0) break;
            name += String.fromCharCode(nameBytes[i]);
        }
        const dataOffset = nameStart + namlen;
        const dataBytes = mrows * ncols * elemSize;
        const end = dataOffset + dataBytes * (imagf ? 2 : 1);
        if (end > size) {
            // A file cut short (a simulation still writing, a failed copy).
            const error = new Error(`MAT v4: matrix '${name}' runs past the end of the file`);
            error.code = 'MAT_TRUNCATED';
            throw error;
        }
        matrices.push({ name, mrows, ncols, P, T, imagf: !!imagf, littleEndian, elemSize, headerOffset: offset, dataOffset, dataBytes, end });
        offset = end;
    }
    return matrices.length ? matrices : null;
}

// A block of data_2 as one Float64Array per wanted series.
function decodeBlock(buffer, steps, mrows, rows, P, littleEndian) {
    const columns = rows.map(() => new Float64Array(steps));
    const nativeLittle = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (P === 0 && littleEndian === nativeLittle) {
        const values = new Float64Array(buffer, 0, steps * mrows);
        for (let k = 0; k < rows.length; k++) {
            const column = columns[k];
            for (let i = 0, at = rows[k]; i < steps; i++, at += mrows) column[i] = values[at];
        }
        return columns;
    }
    const view = new DataView(buffer);
    const size = ELEM_SIZES[P] || 8;
    const read = P === 0 ? at => view.getFloat64(at, littleEndian)
        : P === 1 ? at => view.getFloat32(at, littleEndian)
        : P === 2 ? at => view.getInt32(at, littleEndian)
        : P === 3 ? at => view.getInt16(at, littleEndian)
        : P === 4 ? at => view.getUint16(at, littleEndian)
        : P === 5 ? at => view.getUint8(at)
        : at => view.getFloat64(at, littleEndian);
    for (let k = 0; k < rows.length; k++) {
        const column = columns[k];
        for (let i = 0, at = rows[k] * size; i < steps; i++, at += mrows * size) column[i] = read(at);
    }
    return columns;
}

/**
 * A trajectory file as a columnar reader, or null when this file is not one
 * this reader takes: not MAT v4, not a trajectory, not written binTrans, or
 * with its samples somewhere other than data_2. Null means "open it the way
 * it was always opened", never an error of its own.
 *
 * @param {Blob} blob the file
 * @param {{ parser?: MatParser }} options
 */
export async function openMatV4Trajectory(blob, { parser = new MatParser() } = {}) {
    const scanned = await scanMatV4(blob);
    if (!scanned) return null;
    const byName = new Map(scanned.map(matrix => [matrix.name, matrix]));
    const samples = byName.get('data_2');
    if (!samples || !byName.has('Aclass') || !byName.has('name') || !byName.has('dataInfo')) return null;
    if (samples.imagf) return null;
    // Samples in a third matrix: the in-memory path skips those variables,
    // and here they would be silently missing from a file opened as "all of it".
    if (scanned.some(matrix => /^data_\d+$/.test(matrix.name) && !['data_1', 'data_2'].includes(matrix.name))) return null;

    // The matrices that describe the variables, as one small MAT v4 file.
    const described = scanned.filter(matrix => matrix !== samples);
    const describedBytes = described.reduce((sum, matrix) => sum + (matrix.end - matrix.headerOffset), 0);
    if (describedBytes > MAX_DESCRIPTION_BYTES) return null;
    const small = new Uint8Array(describedBytes);
    let at = 0;
    for (const matrix of described) {
        small.set(new Uint8Array(await sliceBuffer(blob, matrix.headerOffset, matrix.end)), at);
        at += matrix.end - matrix.headerOffset;
    }
    const matrices = parser._readMatrices(small.buffer);
    let needsTranspose;
    let entries;
    try {
        ({ needsTranspose, entries } = parser.describeTrajectory(matrices));
    } catch (_) {
        // Not a description this reader understands: the in-memory path
        // reads the file and says what is wrong with it.
        return null;
    }
    if (!needsTranspose) return null;

    const parameters = matrices.data_1?.data || null;
    const series = samples.mrows;
    const rows = samples.ncols;
    // As MatParser.parse: an entry whose matrix or row is not there is
    // skipped, and of two entries with one name the later one stays.
    const kept = new Map();
    for (const entry of entries) {
        if (entry.actualMat === 2) {
            if (entry.row < 0 || entry.row >= series) continue;
        } else if (entry.actualMat === 1) {
            if (!parameters || entry.row < 0 || entry.row >= parameters.length) continue;
        } else continue;
        kept.set(entry.name, entry);
    }
    let timeEntry = null;
    for (const entry of kept.values()) if (entry.kind === 'abscissa') timeEntry = entry;
    if (!timeEntry || timeEntry.negate || timeEntry.actualMat !== 2) return null;

    // The series of data_2 some variable reads, the time first.
    const usedRows = [...new Set([...kept.values()].filter(entry => entry.actualMat === 2).map(entry => entry.row))]
        .sort((a, b) => a - b);
    const ordered = [timeEntry.row, ...usedRows.filter(row => row !== timeEntry.row)];
    const columnOfRow = new Map(ordered.map((row, index) => [row, index]));
    const variables = [...kept.values()].map((entry) => {
        const base = {
            name: entry.name,
            description: entry.description,
            kind: entry.kind,
            interpolation: entry.interpolation,
            negate: entry.negate,
        };
        if (entry.actualMat === 2) return { ...base, column: columnOfRow.get(entry.row) };
        const values = parameters[entry.row];
        return { ...base, values: entry.negate ? values.map(v => -v) : values };
    });

    const stepBytes = series * samples.elemSize;
    return {
        format: 'mat-v4',
        rows,
        columns: ordered.length,
        timeColumn: 0,
        timeName: timeEntry.name,
        variables,
        metadata: { binTrans: needsTranspose },
        bytes: samples.dataBytes,
        async *blocks({ signal = null, blockBytes = MAT_V4_BLOCK_BYTES } = {}) {
            const stepsPerBlock = Math.max(1, Math.floor(blockBytes / Math.max(1, stepBytes)));
            for (let rowStart = 0; rowStart < rows; rowStart += stepsPerBlock) {
                if (signal?.aborted) throw abortError();
                const steps = Math.min(stepsPerBlock, rows - rowStart);
                const start = samples.dataOffset + rowStart * stepBytes;
                const buffer = await sliceBuffer(blob, start, start + steps * stepBytes);
                if (signal?.aborted) throw abortError();
                yield {
                    rowStart,
                    rows: steps,
                    columns: decodeBlock(buffer, steps, series, ordered, samples.P, samples.littleEndian),
                };
            }
        },
    };
}
