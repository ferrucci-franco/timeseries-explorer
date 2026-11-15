// Analysis jobs: how an analysis computes without holding the main thread.
//
// Before these, only the FFT computed off the main thread. Every other
// analysis ran its kernel there, in one task: on a 10 M-row file in memory a
// histogram held the page for 1.7 s, a temporal profile for 3 s, an
// exponential fit for 19 to 44 s — the computing pill was drawn and its Cancel
// could not be pressed (docs/analysis-responsiveness.md).
//
// A job is opened, given the rows of the range, and asked to run kernels on
// them (src/compute/analysis-kernels.js):
//
//     const job = openAnalysisJob({ signal });
//     try {
//         await feedAnalysisJob(job, { values }, { start, end, signal });
//         const stat = await job.run('histogram:stats', { options });
//         const counts = await job.run('histogram:count', { spec });
//     } finally {
//         job.close();
//     }
//
// The job lives in a compute worker (the Data tools' worker script, in workers
// of its own). The rows cross a chunk at a time, copied and transferred, with
// a turn of the event loop between chunks, so handing over 10 M rows is a few
// milliseconds at a time. Its `signal` is the run's: aborted by Cancel and by
// the request that supersedes it, and an abort **terminates the worker** — a
// kernel in the middle of a twenty-second fit is stopped, not waited for. A
// job that ends normally hands its worker back, warm, for the next one.
//
// Without workers (a page opened from file:// that brought none, a Node test)
// the job runs here, on the caller's thread, through the same registry: the
// same code on the same numbers. The same when a column is not a typed array
// (a cropped file's values are a plain Array, which may hold what a
// Float64Array cannot): it is handed to the kernel as it is, as before.

import { canUseWorkers, spawnWorker } from './worker-pool.js';
import { createAnalysisJobState } from '../compute/analysis-kernels.js';

// Rows per chunk when a column in memory is handed to a worker: 4 MB a
// column, a millisecond or two to copy.
const FEED_CHUNK_ROWS = 1 << 19;

// Where a plot keeps the run signal of its analysis job (the panel's
// _analysisRunSignal(plot, slot)): one slot for every analysis, since a panel
// shows one analysis at a time.
export const ANALYSIS_JOB_SLOT = '_analysisJobAbort';
// Idle workers kept warm for the next job.
const MAX_IDLE_WORKERS = 2;

const idleWorkers = [];
let jobSerial = 0;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export function analysisAbortError(message = 'Analysis job aborted') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

// One turn of the event loop, as a task: a resolved promise would not let the
// browser handle input or paint in between. A MessageChannel rather than
// setTimeout, whose nested calls are clamped to 4 ms each.
export function yieldToBrowser() {
    if (typeof MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

export function analysisWorkersAvailable() {
    return canUseWorkers('compute');
}

// A typed array of numbers: what can be copied to a worker as doubles without
// changing a value. (A plain Array may hold null, which a kernel reads as
// "missing" and a Float64Array would turn into 0.)
export function isWorkerColumn(values) {
    return ArrayBuffer.isView(values) && !(values instanceof DataView)
        && !(typeof BigInt64Array === 'function' && values instanceof BigInt64Array)
        && !(typeof BigUint64Array === 'function' && values instanceof BigUint64Array);
}

function spawnAnalysisWorker() {
    // The literal `new Worker(new URL(...))` is what lets the bundler find and
    // emit the worker chunk; the portable build starts it from bundled text.
    return spawnWorker('compute', () => new Worker(new URL('../workers/compute-worker.js', import.meta.url), { type: 'module' }));
}

function buffersOf(columns) {
    const buffers = new Set();
    for (const values of Object.values(columns || {})) {
        const buffer = values?.buffer;
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) buffers.add(buffer);
    }
    return [...buffers];
}

// A job in a worker of its own.
class WorkerAnalysisJob {
    constructor(worker, signal) {
        this.local = false;
        // The time its kernels have run, in ms, and how many ran: the kernels
        // alone, as the worker timed them.
        this.kernelMs = 0;
        this.onKernel = null;
        this.id = `analysis-${++jobSerial}`;
        this._worker = worker;
        this._calls = new Map();
        this._seq = 0;
        this._done = false;
        this._onMessage = (event) => {
            const { id, ok, result, error } = event.data || {};
            const call = this._calls.get(id);
            if (!call) return;
            this._calls.delete(id);
            if (ok) {
                call.resolve(result);
                return;
            }
            const failure = new Error(error?.message || 'Analysis kernel failed');
            failure.name = error?.name || 'Error';
            if (error?.code) failure.code = error.code;
            if (error?.stack) failure.stack = error.stack;
            call.reject(failure);
        };
        this._onError = (event) => this._fail(new Error(event?.message || 'The analysis worker stopped'));
        worker.addEventListener('message', this._onMessage);
        worker.addEventListener('error', this._onError);
        worker.addEventListener('messageerror', this._onError);
        this._signal = signal || null;
        this._onAbort = () => this.abort();
        if (this._signal?.aborted) this.abort();
        else this._signal?.addEventListener?.('abort', this._onAbort, { once: true });
    }

    _call(op, payload, transfer = []) {
        if (this._done) return Promise.reject(analysisAbortError());
        const id = `${this.id}-${++this._seq}`;
        return new Promise((resolve, reject) => {
            this._calls.set(id, { resolve, reject });
            try {
                this._worker.postMessage({ id, op, payload }, transfer);
            } catch (error) {
                this._calls.delete(id);
                reject(error);
            }
        });
    }

    /** Rows for the job's columns: `{ name: Float64Array }`, transferred. */
    put(columns, { total = null } = {}) {
        return this._call('analysis:put', { job: this.id, columns, total }, buffersOf(columns));
    }

    /** Run a kernel; `chunk` is columns for this call alone, transferred. */
    run(kernel, params = {}, chunk = null) {
        return this._call('analysis:run', { job: this.id, kernel, params, chunk }, buffersOf(chunk)).then(({ value, ms }) => {
            this.kernelMs += ms;
            this.onKernel?.(ms);
            return value;
        });
    }

    _detach() {
        this._worker.removeEventListener('message', this._onMessage);
        this._worker.removeEventListener('error', this._onError);
        this._worker.removeEventListener('messageerror', this._onError);
        this._signal?.removeEventListener?.('abort', this._onAbort);
    }

    _fail(error) {
        if (this._done) return;
        this._done = true;
        this._detach();
        try { this._worker.terminate(); } catch (_) { /* already gone */ }
        for (const call of this._calls.values()) call.reject(error);
        this._calls.clear();
    }

    /** Done: the worker forgets the job and is kept for the next one. */
    close() {
        if (this._done) return;
        if (this._calls.size) {
            // Closed with a kernel still running: the same as an abort.
            this.abort();
            return;
        }
        this._done = true;
        this._detach();
        try {
            this._worker.postMessage({ id: `${this.id}-drop`, op: 'analysis:drop', payload: { job: this.id } });
        } catch (_) { /* gone */ }
        if (idleWorkers.length < MAX_IDLE_WORKERS) idleWorkers.push(this._worker);
        else {
            try { this._worker.terminate(); } catch (_) { /* already gone */ }
        }
    }

    /** Stop: whatever the worker is in the middle of, it ends now. */
    abort() {
        this._fail(analysisAbortError());
    }
}

// The same job on the caller's thread.
class LocalAnalysisJob {
    constructor(signal) {
        this.local = true;
        this.kernelMs = 0;
        this.onKernel = null;
        this._state = createAnalysisJobState();
        this._signal = signal || null;
        this._done = false;
    }

    _check() {
        if (this._done || this._signal?.aborted) throw analysisAbortError();
    }

    put(columns) {
        try {
            this._check();
            this._state.put(columns);
            return Promise.resolve(true);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    run(kernel, params = {}, chunk = null) {
        try {
            this._check();
            const startedAt = now();
            const value = this._state.run(kernel, params, chunk);
            const ms = now() - startedAt;
            this.kernelMs += ms;
            this.onKernel?.(ms);
            return Promise.resolve(value);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    close() {
        this._done = true;
        this._state = null;
    }

    abort() {
        this.close();
    }
}

/**
 * Open a job. `signal` is the run's: its abort stops the job. `local: true`
 * keeps it on this thread (for columns a worker cannot be given).
 * @returns {{ local: boolean, put: Function, run: Function, close: Function, abort: Function }}
 */
export function openAnalysisJob({ signal = null, local = false } = {}) {
    if (signal?.aborted) throw analysisAbortError();
    if (!local && analysisWorkersAvailable()) {
        try {
            const worker = idleWorkers.pop() || spawnAnalysisWorker();
            return new WorkerAnalysisJob(worker, signal);
        } catch (_) {
            // No worker after all (a browser that refuses the script): here.
        }
    }
    return new LocalAnalysisJob(signal);
}

/**
 * Give a job the rows `[start, end)` of columns held in memory.
 *
 * To a worker: `FEED_CHUNK_ROWS` at a time, each chunk a copy (as doubles)
 * that is transferred, with a turn of the event loop between chunks. On this
 * thread: the rows as one slice of each column — what the analysis used to
 * hand its kernel directly.
 */
export async function feedAnalysisJob(job, columns, { start = 0, end = null, signal = null, chunkRows = FEED_CHUNK_ROWS } = {}) {
    const names = Object.keys(columns || {});
    const length = Math.min(...names.map(name => columns[name]?.length || 0));
    const from = Math.max(0, Math.min(length, Math.round(start) || 0));
    const to = end === null ? length : Math.max(from, Math.min(length, Math.round(end)));
    if (job.local) {
        const whole = {};
        for (const name of names) {
            const values = columns[name];
            whole[name] = from === 0 && to === values.length ? values : values.slice(from, to);
        }
        await job.put(whole);
        return to - from;
    }
    const total = to - from;
    for (let at = from; at < to || at === from; at += chunkRows) {
        if (signal?.aborted) throw analysisAbortError();
        const upto = Math.min(to, at + chunkRows);
        const chunk = {};
        for (const name of names) {
            const values = columns[name];
            chunk[name] = values instanceof Float64Array ? values.slice(at, upto) : new Float64Array(values.subarray(at, upto));
        }
        // Not awaited one by one: the worker takes them in order, and the
        // kernel's call queues behind the last. The yield is what keeps the
        // page alive while the rows are copied.
        job.put(chunk, { total }).catch(() => null);
        if (upto >= to) break;
        await yieldToBrowser();
    }
    return total;
}

/** Whether every column can be handed to a worker (see isWorkerColumn). */
export function columnsFitWorker(columns) {
    return Object.values(columns || {}).every(isWorkerColumn);
}

// For tests: no warm workers left behind.
export function releaseAnalysisWorkers() {
    while (idleWorkers.length) {
        try { idleWorkers.pop().terminate(); } catch (_) { /* already gone */ }
    }
}
