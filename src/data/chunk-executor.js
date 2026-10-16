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
// A kernel that needs a second pass — the zero-phase filter, whose backward
// pass runs over the output of its forward pass — flags those first-pass
// outputs `deferred`: they go to a work table instead of the sink (the sink
// holds NaN there meanwhile). When the file has been read, `kernel.backward(s)`
// is fed each deferred run of rows from its last row to its first, a chunk at
// a time read back from the work table, and its outputs replace those rows of
// the sink. The work table goes when the job ends.
//
// What the later sub-phases add here (docs/any-size-files.md, 4b): overlap and
// a look-ahead to the next finite sample for the kernels without state.

/**
 * @param {object} job
 * @param {object} job.data a lazy file
 * @param {string[]} job.sourceNames the variables the kernel reads
 * @param {{ push(chunk), flush(), backward?(s) }} job.kernel fed the stream's
 *   chunks — `{ rows, x, yByVar }` — in order; returns the outputs for the next
 *   rows: one column, one per sink column, or `{ values, deferred }` when some
 *   of them belong to the second pass (see above)
 * @param {object} job.sink from DuckDbSource.createSink
 * @param {boolean} [job.withTime] whether the kernel reads the time axis (x)
 * @param {number} [job.chunkRows]
 * @param {AbortSignal} [job.signal] cancels: the stream stops and the sink is
 *   dropped
 * @param {(progress: { rows: number, totalRows: number|null, pass: 1|2 }) => void} [job.onProgress]
 *   rows read in the first pass; rows done of the rows deferred in the second
 * @returns {Promise<{ sink: object, rows: number }>} `rows`: rows read
 */
export async function runChunkedJob({
    data, sourceNames, kernel, sink, withTime = false, chunkRows, signal = null, onProgress = null,
}) {
    const source = data?._duckdb?.source;
    if (!source?.streamJobColumns) throw new Error('runChunkedJob: the file is not lazy');
    const totalRows = Number.isFinite(Number(data._duckdb.totalRows)) ? Number(data._duckdb.totalRows) : null;
    const writer = source.openSinkWriter(data, sink, { chunkRows });
    let work = null;
    let workWriter = null;

    // File positions of the rows read whose outputs have not come yet.
    let queue = new Float64Array(0);
    let rowsRead = 0;
    // Runs of deferred rows, by file position: [first, last].
    const deferredRuns = [];
    let inRun = false;
    let deferredRows = 0;
    const emit = async (out) => {
        // A typed array has a `values` method of its own: test the shape.
        const shaped = !!out && !ArrayBuffer.isView(out) && !Array.isArray(out);
        const deferred = shaped ? out.deferred : null;
        const columns = shaped ? [out.values] : (Array.isArray(out) ? out : [out]);
        const n = columns[0]?.length || 0;
        if (!n) return;
        if (n > queue.length) throw new Error(`runChunkedJob: the kernel gave ${n} outputs for ${queue.length} rows`);
        const rows = queue.subarray(0, n);
        if (!deferred) {
            await writer.write(rows, columns);
            inRun = false;
        } else {
            const placeholders = columns.map(column => Float64Array.from(column, (value, i) => (deferred[i] ? NaN : value)));
            await writer.write(rows, placeholders);
            const picked = [];
            for (let i = 0; i < n; i++) {
                if (!deferred[i]) { inRun = false; continue; }
                if (!inRun) deferredRuns.push([rows[i], rows[i]]);
                deferredRuns[deferredRuns.length - 1][1] = rows[i];
                inRun = true;
                picked.push(i);
            }
            if (picked.length) {
                if (!work) {
                    work = await source.createWorkTable(data);
                    workWriter = source.openWorkWriter(data, work, { chunkRows });
                }
                await workWriter.append(Float64Array.from(picked, i => rows[i]), Float64Array.from(picked, i => columns[0][i]));
                deferredRows += picked.length;
            }
        }
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
            onProgress?.({ rows: rowsRead, totalRows, pass: 1 });
            if (signal?.aborted) throw abortError();
        }
        await emit(kernel.flush());
        if (queue.length) throw new Error(`runChunkedJob: ${queue.length} rows were given no output`);
        if (signal?.aborted) throw abortError();
        await writer.finish();
        if (deferredRuns.length) {
            await workWriter.finish();
            await secondPass();
        }
        return { sink, rows: rowsRead };
    } catch (err) {
        await writer.abort();
        await workWriter?.abort();
        throw err;
    } finally {
        if (work) await source.dropSink(data, work.table);
    }

    // Each deferred run, from its last row to its first, a range of file
    // positions at a time.
    async function secondPass() {
        if (typeof kernel.backward !== 'function') throw new Error('runChunkedJob: deferred outputs, and no backward pass');
        if (kernel.longStretches && kernel.longStretches.length !== deferredRuns.length) {
            throw new Error(`runChunkedJob: ${deferredRuns.length} deferred runs for ${kernel.longStretches.length} stretches`);
        }
        const step = Math.max(1, Math.round(Number(chunkRows) || 262144));
        const updater = await source.openSinkUpdater(data, sink, work);
        let done = 0;
        try {
            for (let s = 0; s < deferredRuns.length; s++) {
                const [first, last] = deferredRuns[s];
                const backward = kernel.backward(s);
                for (let hi = last + 1; hi > first;) {
                    if (signal?.aborted) throw abortError();
                    const lo = Math.max(first, hi - step);
                    const { rows, values } = await updater.read(lo, hi);
                    const finals = backward.push(values.reverse()).reverse();
                    await updater.write(rows, finals);
                    done += rows.length;
                    onProgress?.({ rows: done, totalRows: deferredRows, pass: 2 });
                    hi = lo;
                }
            }
        } finally {
            await updater.close();
        }
    }
}

function abortError() {
    const err = new Error('Job cancelled');
    err.name = 'AbortError';
    return err;
}
