// A netCDF file being read by parts in a worker, as a columnar reader on the
// thread the engine is on.
//
// The file has to be read in a worker — FileReaderSync, and h5wasm's WORKERFS,
// exist nowhere else — and DuckDB-WASM lives on the main thread, so the blocks
// cross between them. They are **pulled**: the ingest asks for the next block
// only once it has appended the last, so the worker never runs ahead of the
// engine and no queue builds up. That is the whole of the backpressure, and it
// is why this is three plain requests rather than a channel of its own, the
// shape the gridded datasets use for maps (src/gridded/gridded-protocol.js).
//
// The reader stays open in the worker between asks, under the id this passes,
// and the caller closes it when the ingest is done.

import { netcdfTreeFromSkeleton } from '../parsers/netcdf-columns.js';

function abortError() {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * @param {object} description what `netcdf-columns:open` handed back: every
 *   field of the reader that is data (rows, columns, the variables, the
 *   metadata, the tree skeleton).
 * @param {{ id: string, request: (op: string, payload: object) => Promise<any> }} link
 *   the reader's id in the worker, and how to ask it something.
 * @returns {object} the reader `ingestColumnarReader` reads.
 */
export function netcdfColumnarReader(description, { id, request }) {
    const columns = Number(description.columns) || 1;
    const rows = Number(description.rows) || 0;
    return {
        ...description,
        buildTree: (built) => netcdfTreeFromSkeleton(description.tree, built),
        async *blocks({ signal = null, blockBytes = 0 } = {}) {
            const perBlock = blockBytes > 0
                ? Math.max(1, Math.floor(blockBytes / (8 * columns)))
                : Math.max(1, Number(description.rowsPerBlock) || 1);
            for (let rowStart = 0; rowStart < rows; rowStart += perBlock) {
                if (signal?.aborted) throw abortError();
                const count = Math.min(perBlock, rows - rowStart);
                const block = await request('netcdf-columns:block', { id, rowStart, rows: count });
                if (signal?.aborted) throw abortError();
                yield block;
            }
        },
    };
}
