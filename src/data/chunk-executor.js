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
// The kernels without state (the spike detector, the fill of missing samples,
// the interpolation of outliers, the integral bridging a hole) come wrapped in
// the adapters of src/compute/kernels/windowed.js, which give them the rows
// around each chunk — a fixed overlap, or a look-ahead to the next finite
// sample — and may answer asynchronously: `push` and `flush` are awaited.
//
// A file that grows (live update) need not be read again from its first row.
// Every output a push gives is final — it waits for the rows it needs — and
// only what the flush gives at the end is provisional: the rows the kernel was
// still waiting on, given as the end of the series makes them. So a job run
// `resumable` saves the kernel's state just before its flush and puts it back
// after (each kernel's save()/load()), and returns that state with the queue
// of rows the flush answered: its `resume`. continueChunkedJob, when rows have
// been appended, rewrites the sink from the first of those rows on — reading
// the file from the row after the last one read, pushing into the saved state,
// flushing again — inside one transaction, so a reader sees the old sink or
// the new one. The outputs are the ones a run over the whole grown file gives,
// bit for bit: the kernel runs the same steps in the same order. A kernel
// whose outputs depend on the whole file in a way a flush cannot undo — the
// zero-phase filter's second pass — is not resumable, and a source whose own
// values for the rows already read may change when rows are appended (a
// window over its neighbours, the output of another tool) is the caller's to
// refuse (see _canContinueLazySink).

/**
 * @param {object} job
 * @param {object} job.data a lazy file
 * @param {string[]} job.sourceNames the variables the kernel reads
 * @param {{ push(chunk), flush(), backward?(s) }} job.kernel fed the stream's
 *   chunks — `{ rows, x, yByVar }` — in order; returns (or resolves to) the outputs for the next
 *   rows: one column, one per sink column, or `{ values, deferred }` when some
 *   of them belong to the second pass (see above)
 * @param {object} job.sink from DuckDbSource.createSink
 * @param {boolean} [job.withTime] whether the kernel reads the time axis (x)
 * @param {number} [job.chunkRows]
 * @param {AbortSignal} [job.signal] cancels: the stream stops and the sink is
 *   dropped
 * @param {(progress: { rows: number, totalRows: number|null, pass: 1|2 }) => void} [job.onProgress]
 *   rows read in the first pass; rows done of the rows deferred in the second
 * @param {boolean} [job.resumable] keep what continueChunkedJob needs (above),
 *   when the kernel can save its state and needed no second pass
 * @returns {Promise<{ sink: object, rows: number, report: object|null, used: number|undefined, resume: object|null }>}
 *   `rows`: rows read; `report` and `used`: the kernel's, after its flush;
 *   `resume`: the state to continue from, or null
 */
export async function runChunkedJob({
    data, sourceNames, kernel, sink, withTime = false, chunkRows, signal = null, onProgress = null, resumable = false,
}) {
    return runJob({ data, sourceNames, kernel, sink, withTime, chunkRows, signal, onProgress, resumable, resume: null });
}

/**
 * The job of a resume (runChunkedJob, `resumable`) continued over the rows
 * appended to the file since: the sink is rewritten from the first row the
 * last flush answered, and a new resume is returned. `kernel` and the rest
 * come from the resume; `sink` is the sink the job wrote.
 *
 * @param {object} job
 * @param {object} job.data the same lazy file, grown
 * @param {object} job.resume from the run (or the continuation) before
 * @returns same as runChunkedJob; `rows` counts every row read since the
 *   first run
 */
export async function continueChunkedJob({
    data, sourceNames, sink, resume, withTime = false, chunkRows, signal = null, onProgress = null,
}) {
    if (!resume?.kernel || !resume.state) throw new Error('continueChunkedJob: nothing to continue from');
    return runJob({ data, sourceNames, kernel: resume.kernel, sink, withTime, chunkRows, signal, onProgress, resumable: true, resume });
}

async function runJob({ data, sourceNames, kernel, sink, withTime, chunkRows, signal, onProgress, resumable, resume }) {
    const source = data?._duckdb?.source;
    if (!source?.streamJobColumns) throw new Error('runChunkedJob: the file is not lazy');
    const totalRows = Number.isFinite(Number(data._duckdb.totalRows)) ? Number(data._duckdb.totalRows) : null;
    const canSave = resumable && typeof kernel.save === 'function' && typeof kernel.load === 'function';
    if (resume) {
        // Back to the state before the last flush, for each attempt alike (a
        // continuation that failed leaves the resume as it was).
        kernel.load(resume.state);
    }
    // A continuation rewrites the sink from the first row the flush answered,
    // in one transaction (DuckDbSource.openSinkWriter, `fromRow`).
    const writer = source.openSinkWriter(data, sink, { chunkRows, fromRow: resume ? resume.tailRow : null });
    let work = null;
    let workWriter = null;

    // File positions of the rows read whose outputs have not come yet.
    let queue = resume ? Float64Array.from(resume.queue) : new Float64Array(0);
    let rowsRead = resume ? resume.rowsRead : 0;
    // The file position of the last row read, and where a continuation reads from.
    let lastRow = resume ? resume.lastRow : -1;
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
        const streamOptions = { chunkRows, signal, withTime, ...(resume ? { fromRow: lastRow + 1 } : {}) };
        for await (const chunk of source.streamJobColumns(data, sourceNames, streamOptions)) {
            const rows = chunk.rows;
            const grown = new Float64Array(queue.length + rows.length);
            grown.set(queue, 0);
            grown.set(rows, queue.length);
            queue = grown;
            rowsRead += rows.length;
            if (rows.length) lastRow = rows[rows.length - 1];
            await emit(await kernel.push(chunk));
            onProgress?.({ rows: rowsRead, totalRows, pass: 1 });
            if (signal?.aborted) throw abortError();
        }
        // The resume: the kernel as it is before the flush, with the rows the
        // flush is about to answer (every core in flight given first: a core
        // in flight is not state that can be saved).
        let next = null;
        if (canSave) {
            if (typeof kernel.settle === 'function') await emit(await kernel.settle());
            next = {
                kernel,
                state: kernel.save(),
                queue: Float64Array.from(queue),
                // The first row a continuation rewrites: the first one the
                // flush answers, or the end of what was written when it
                // answers none.
                tailRow: queue.length ? queue[0] : writer.nextRow(),
                lastRow,
                rowsRead,
            };
        }
        await emit(await kernel.flush());
        if (queue.length) throw new Error(`runChunkedJob: ${queue.length} rows were given no output`);
        if (signal?.aborted) throw abortError();
        // What the kernel counted, after its flush (the resume puts it back
        // to before).
        const report = typeof kernel.report === 'function' ? kernel.report() : null;
        const used = kernel.used;
        await writer.finish();
        if (deferredRuns.length) {
            await workWriter.finish();
            await secondPass();
        }
        if (next) kernel.load(next.state);
        const resumeOut = next && !deferredRuns.length ? next : null;
        return { sink, rows: rowsRead, report, used, resume: resumeOut };
    } catch (err) {
        // A failed continuation leaves the sink as it was (its transaction is
        // rolled back); a failed run drops it.
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

/**
 * A job whose output is not a column alongside the file but a table of its
 * own — a resample (another grid), a collapse (one row per instant): the
 * kernel gives `{ t, columns }` rows, however many, and they are appended to
 * a dataset table (DuckDbSource.createDatasetTable / openDatasetWriter) in
 * order. The time of every source row is read (`x`); the kernel decides which
 * rows it can give (src/compute/kernels/regrid.js createResampler,
 * collapse-repeats.js createCollapser).
 *
 * @param {object} job
 * @param {object} job.data a lazy file
 * @param {string[]} job.sourceNames the variables the kernel reads
 * @param {{ push(chunk), flush() }} job.kernel fed the stream's chunks in
 *   order; returns (or resolves to) `{ t, columns }` of output rows
 * @param {object} job.writer from DuckDbSource.openDatasetWriter
 * @param {number} [job.chunkRows]
 * @param {AbortSignal} [job.signal] cancels: the stream stops and the table is dropped
 * @param {(progress: { rows: number, totalRows: number|null, pass: 1 }) => void} [job.onProgress]
 * @returns {Promise<{ rows: number, written: number }>} rows read, rows written
 */
export async function runDatasetJob({ data, sourceNames, kernel, writer, chunkRows, signal = null, onProgress = null }) {
    const source = data?._duckdb?.source;
    if (!source?.streamJobColumns) throw new Error('runDatasetJob: the file is not lazy');
    const totalRows = Number.isFinite(Number(data._duckdb.totalRows)) ? Number(data._duckdb.totalRows) : null;
    let rowsRead = 0;
    let written = 0;
    const emit = async (out) => {
        if (!out?.t?.length) return;
        await writer.append(out.t, out.columns);
        written += out.t.length;
    };
    try {
        for await (const chunk of source.streamJobColumns(data, sourceNames, { chunkRows, signal, withTime: true })) {
            rowsRead += chunk.rows.length;
            await emit(await kernel.push(chunk));
            onProgress?.({ rows: rowsRead, totalRows, pass: 1 });
            if (signal?.aborted) throw abortError();
        }
        await emit(await kernel.flush());
        if (signal?.aborted) throw abortError();
        await writer.finish();
        return { rows: rowsRead, written };
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
