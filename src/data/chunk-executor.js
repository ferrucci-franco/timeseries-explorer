// A Data Tool over a file too large to hold, a chunk at a time.
//
// The tools the lazy path cannot write as SQL (a moving average, a filter, …)
// are kernels with an incremental form: `push(chunk)` gives the outputs the
// kernel can already give, `flush()` the rest (createMovingAverage in
// src/compute/kernels/moving-average.js). The same code runs over an array in
// memory — one push — and here, over a lazy file read in order, so the output
// is the same doubles either way.
//
//   const sink = await source.createSink(data);
//   await runChunkedJob({ data, sourceNames: ['a'], kernel, sink, signal, onProgress });
//
// The executor reads the file with DuckDbSource.streamJobColumns (the rows
// every lazy query serves, in the file's order, on a connection of their own
// so zooms are not held up), hands each chunk to the kernel and writes what
// comes out to the sink, at the file positions of the rows it belongs to.
// Outputs trail inputs — a centred window needs the samples after the one it
// gives — so the positions wait in a queue until their outputs come.
//
// Nothing here holds the file: one chunk read, the kernel's own state (a
// window of samples) and one chunk of the sink being written.
//
// What the later sub-phases add here (docs/any-size-files.md, 4b): overlap and
// a look-ahead to the next finite sample for the kernels without state, and a
// second pass reading a sink backwards for the zero-phase filter.

/**
 * @param {object} job
 * @param {object} job.data a lazy file
 * @param {string[]} job.sourceNames the variables the kernel reads
 * @param {{ push(chunk): Float64Array|Float64Array[], flush(): Float64Array|Float64Array[] }} job.kernel
 *   fed the stream's chunks — `{ rows, x, yByVar }` — in order; returns one
 *   output column (or one per sink column) for the next rows
 * @param {object} job.sink from DuckDbSource.createSink
 * @param {boolean} [job.withTime] whether the kernel reads the time axis (x)
 * @param {number} [job.chunkRows]
 * @param {AbortSignal} [job.signal] cancels: the stream stops and the sink is
 *   dropped
 * @param {(progress: { rows: number, totalRows: number|null }) => void} [job.onProgress]
 * @returns {Promise<{ sink: object, rows: number }>} `rows`: rows read
 */
export async function runChunkedJob({
    data, sourceNames, kernel, sink, withTime = false, chunkRows, signal = null, onProgress = null,
}) {
    const source = data?._duckdb?.source;
    if (!source?.streamJobColumns) throw new Error('runChunkedJob: the file is not lazy');
    const totalRows = Number.isFinite(Number(data._duckdb.totalRows)) ? Number(data._duckdb.totalRows) : null;
    const writer = source.openSinkWriter(data, sink, { chunkRows });

    // File positions of the rows read whose outputs have not come yet.
    let queue = new Float64Array(0);
    let rowsRead = 0;
    const emit = async (out) => {
        const columns = Array.isArray(out) ? out : [out];
        const n = columns[0]?.length || 0;
        if (!n) return;
        if (n > queue.length) throw new Error(`runChunkedJob: the kernel gave ${n} outputs for ${queue.length} rows`);
        await writer.write(queue.subarray(0, n), columns);
        queue = queue.subarray(n);
    };

    try {
        for await (const chunk of source.streamJobColumns(data, sourceNames, { chunkRows, signal, withTime })) {
            const rows = chunk.rows;
            const grown = new Float64Array(queue.length + rows.length);
            grown.set(queue, 0);
            grown.set(rows, queue.length);
            queue = grown;
            rowsRead += rows.length;
            await emit(kernel.push(chunk));
            onProgress?.({ rows: rowsRead, totalRows });
            if (signal?.aborted) throw abortError();
        }
        await emit(kernel.flush());
        if (queue.length) throw new Error(`runChunkedJob: ${queue.length} rows were given no output`);
        if (signal?.aborted) throw abortError();
        await writer.finish();
        return { sink, rows: rowsRead };
    } catch (err) {
        await writer.abort();
        throw err;
    }
}

function abortError() {
    const err = new Error('Job cancelled');
    err.name = 'AbortError';
    return err;
}
