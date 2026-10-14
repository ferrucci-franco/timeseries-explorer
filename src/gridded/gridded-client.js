// Main-thread handle on the gridded worker: promise per request, progress
// callbacks, cancellation.
//
// One worker serves every open dataset. Where workers are unavailable (the
// portable build opened from file://), the same requests run in the page on
// the whole file in memory: slower and bounded by memory, but the view works.

import { canUseWorkers } from '../core/worker-pool.js';
import { handleGriddedRequest } from './gridded-protocol.js';

let sequence = 0;

export function nextDatasetId() {
    sequence += 1;
    return `grid-${Date.now().toString(36)}-${sequence}`;
}

function toError(error) {
    const result = new Error(error?.message || 'Gridded request failed');
    result.name = error?.name || 'Error';
    if (error?.code) result.code = error.code;
    if (error?.cancelled) result.cancelled = true;
    return result;
}

export class GriddedClient {
    constructor() {
        this.worker = null;
        this.pending = new Map();
        this.requestId = 0;
        this.inline = !canUseWorkers();
        this.inlineDatasets = new Map();
        this.inlineJobs = new Map();
    }

    get usesWorker() {
        return !this.inline;
    }

    _ensureWorker() {
        if (this.worker) return this.worker;
        const worker = new Worker(new URL('../workers/gridded-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', event => {
            const { id, ok, result, error, progress } = event.data || {};
            const entry = this.pending.get(id);
            if (!entry) return;
            if (progress !== undefined) {
                entry.onProgress?.(progress);
                return;
            }
            this.pending.delete(id);
            if (ok) entry.resolve(result);
            else entry.reject(toError(error));
        });
        const fail = event => {
            // A crashed worker loses every open dataset with it.
            const error = Object.assign(new Error(event?.message || 'The gridded data worker stopped.'), { code: 'GRIDDED_WORKER_LOST' });
            for (const entry of this.pending.values()) entry.reject(error);
            this.pending.clear();
            this.worker = null;
            this.onWorkerLost?.();
        };
        worker.addEventListener('error', fail);
        worker.addEventListener('messageerror', fail);
        this.worker = worker;
        return worker;
    }

    /**
     * @returns {{id: number, promise: Promise<any>}}
     */
    request(op, payload, { onProgress = null, transfer = [] } = {}) {
        const id = ++this.requestId;
        if (this.inline) {
            const job = { cancelled: false, onProgress };
            this.inlineJobs.set(id, job);
            const promise = (async () => {
                const { GriddedDataset } = await import('./dataset.js');
                const prepared = op === 'open' ? await inlinePayload(payload) : payload;
                try {
                    const { result } = await handleGriddedRequest({ GriddedDataset, datasets: this.inlineDatasets }, op, prepared, job);
                    return result;
                } finally {
                    this.inlineJobs.delete(id);
                }
            })();
            return { id, promise };
        }
        const worker = this._ensureWorker();
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress });
        });
        worker.postMessage({ id, op, payload }, transfer);
        return { id, promise };
    }

    cancel(id) {
        if (this.inline) {
            const job = this.inlineJobs.get(id);
            if (job) job.cancelled = true;
            return;
        }
        this.worker?.postMessage({ id: 0, op: 'cancel', payload: { jobId: id } });
    }

    async open(datasetId, files, options = {}) {
        const inputs = files.map(file => ({ file, filename: file.name }));
        return this.request('open', { datasetId, inputs, options }).promise;
    }

    close(datasetId) {
        if (!datasetId) return Promise.resolve(false);
        return this.request('close', { datasetId }).promise.catch(() => false);
    }
}

// In the page there is no FileReaderSync, so the reader gets the bytes.
async function inlinePayload(payload) {
    const inputs = [];
    for (const input of payload.inputs || []) {
        if (input.buffer || !input.file) inputs.push(input);
        else inputs.push({ buffer: await input.file.arrayBuffer(), filename: input.filename || input.file.name });
    }
    return { ...payload, inputs };
}

let sharedClient = null;
export function griddedClient() {
    if (!sharedClient) sharedClient = new GriddedClient();
    return sharedClient;
}
