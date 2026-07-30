// A small pool of module workers speaking one request/response envelope.
//
// Before this existed, every feature that wanted a worker hand-rolled its own
// lifecycle (see the original _getParserWorker and _computeFftSpectrumInWorker):
// two copies of spawn, pending-map, error teardown and fallback detection. This
// centralizes that so new off-thread work is a `run()` call.
//
// Envelope, both directions:
//   -> { id, op, payload }
//   <- { id, ok: true,  result }
//   <- { id, ok: false, error: { name, message, stack, code } }
//
// Deliberately NOT included: SharedArrayBuffer. It needs cross-origin isolation
// (COOP/COEP), which the app does not set today, and transferables already give
// us zero-copy handoff in both directions.

export class WorkerUnavailableError extends Error {
    constructor(message = 'Worker unavailable') {
        super(message);
        this.name = 'WorkerUnavailableError';
        this.workerUnavailable = true;
    }
}

export class TaskCancelledError extends Error {
    constructor(message = 'Task superseded') {
        super(message);
        this.name = 'TaskCancelledError';
        this.cancelled = true;
    }
}

// A worker that dies mid-task. Overwhelmingly this means it ran out of memory
// on a large file and the browser terminated it — in which case the `error`
// event carries no message at all, which is why the previous generic "Worker
// crashed" told nobody anything. The `workerCrashed` flag is what the
// load-error mapper keys on, because the wording here comes partly from the
// browser and is not ours to depend on.
export class WorkerDiedError extends Error {
    constructor({ op = '', poolName = '', detail = '' } = {}) {
        const doing = op ? `while running "${op}"` : 'while idle';
        super(`The ${poolName || 'background'} worker stopped ${doing}${detail ? `: ${detail}` : ''}`);
        this.name = 'WorkerDiedError';
        this.workerCrashed = true;
        this.op = op;
        this.poolName = poolName;
    }
}

// Workers are unavailable under file:// on most browsers, and in any non-DOM
// context (the Node test harnesses import these modules directly).
export function canUseWorkers() {
    return typeof Worker !== 'undefined'
        && typeof window !== 'undefined'
        && window.location?.protocol !== 'file:';
}

export default class WorkerPool {
    /**
     * @param {() => Worker} spawn creates one worker; kept as a callback so the
     *   `new Worker(new URL(...), { type: 'module' })` form stays in the calling
     *   module, which is what lets the bundler find and emit the worker chunk.
     * @param {{ size?: number, name?: string }} options
     */
    constructor(spawn, { size, name = 'pool' } = {}) {
        this._spawn = spawn;
        this._name = name;
        this._size = Math.max(1, size || defaultPoolSize());
        this._workers = [];
        this._next = 0;
        this._seq = 0;
        this._pending = new Map();   // id -> { resolve, reject, worker }
        this._byKey = new Map();     // key -> id, for supersede semantics
        this._disabled = false;
    }

    get available() {
        return !this._disabled && canUseWorkers();
    }

    /**
     * @param {string} op
     * @param {any} payload structured-cloneable
     * @param {{ transfer?: Transferable[], key?: string, signal?: AbortSignal }} options
     *   `key` gives last-one-wins semantics: a newer run() with the same key
     *   rejects the older one with TaskCancelledError. The worker still finishes
     *   the stale task — we drop its result rather than terminate, because
     *   respawning costs more than letting a now-fast kernel run to completion.
     */
    run(op, payload, { transfer = [], key = '', signal = null } = {}) {
        if (!this.available) return Promise.reject(new WorkerUnavailableError());

        let worker;
        try {
            worker = this._acquire();
        } catch (err) {
            this._disabled = true;
            return Promise.reject(new WorkerUnavailableError(err?.message));
        }

        const id = `${this._name}-${++this._seq}`;

        if (key) {
            const previous = this._byKey.get(key);
            if (previous && this._pending.has(previous)) {
                this._settle(previous, 'reject', new TaskCancelledError());
            }
            this._byKey.set(key, id);
        }

        return new Promise((resolve, reject) => {
            // `op` is retained so a crash can name what the worker was doing.
            // "The parse worker stopped while running parse:mat" is a report;
            // "Worker crashed" is not.
            this._pending.set(id, { resolve, reject, worker, key, op });

            if (signal) {
                if (signal.aborted) {
                    this._settle(id, 'reject', new TaskCancelledError('Aborted'));
                    return;
                }
                signal.addEventListener(
                    'abort',
                    () => this._settle(id, 'reject', new TaskCancelledError('Aborted')),
                    { once: true },
                );
            }

            try {
                worker.postMessage({ id, op, payload }, transfer);
            } catch (err) {
                this._settle(id, 'reject', err);
            }
        });
    }

    terminate() {
        for (const worker of this._workers) {
            try { worker.terminate(); } catch { /* already gone */ }
        }
        this._workers = [];
        for (const id of [...this._pending.keys()]) {
            this._settle(id, 'reject', new TaskCancelledError('Pool terminated'));
        }
        this._byKey.clear();
    }

    _acquire() {
        if (this._workers.length < this._size) {
            const worker = this._spawn();
            worker.addEventListener('message', event => this._onMessage(event));
            worker.addEventListener('error', event => this._onWorkerError(worker, event));
            // A result that cannot be deserialized fires messageerror, not error
            // or message: without this the reply is simply dropped and the
            // caller's promise never settles, which is a hang no Esc can break.
            worker.addEventListener('messageerror', event => this._onWorkerError(worker, event));
            this._workers.push(worker);
            return worker;
        }
        const worker = this._workers[this._next % this._workers.length];
        this._next++;
        return worker;
    }

    _onMessage(event) {
        const { id, ok, result, error } = event.data || {};
        if (!this._pending.has(id)) return;   // superseded or aborted; drop it
        if (ok) {
            this._settle(id, 'resolve', result);
            return;
        }
        const err = new Error(error?.message || 'Worker task failed');
        err.name = error?.name || 'Error';
        if (error?.code) err.code = error.code;
        if (error?.stack) err.stack = error.stack;
        // Parser-specific fields the UI needs to build a translated message.
        if (error?.details) Object.assign(err, error.details);
        this._settle(id, 'reject', err);
    }

    _onWorkerError(worker, event) {
        // Each pending task gets its own error naming its own op, rather than
        // one shared message that is accurate for at most one of them.
        for (const [id, entry] of [...this._pending]) {
            if (entry.worker !== worker) continue;
            this._settle(id, 'reject', new WorkerDiedError({
                op: entry.op,
                poolName: this._name,
                detail: event?.message || '',
            }));
        }
        this._workers = this._workers.filter(w => w !== worker);
        try { worker.terminate(); } catch { /* already gone */ }
    }

    _settle(id, kind, value) {
        const entry = this._pending.get(id);
        if (!entry) return;
        this._pending.delete(id);
        if (entry.key && this._byKey.get(entry.key) === id) this._byKey.delete(entry.key);
        entry[kind](value);
    }
}

function defaultPoolSize() {
    const cores = Number(globalThis.navigator?.hardwareConcurrency) || 4;
    // Leave a core for the UI thread and one for DuckDB's own worker.
    return Math.max(1, Math.min(4, cores - 2));
}
