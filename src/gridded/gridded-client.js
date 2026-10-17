// Main-thread handle on the gridded workers: promise per request, progress
// callbacks, cancellation.
//
// One worker serves every open dataset: maps, colour ranges, opening and
// closing. A long series (a point or a region over every time step) on a
// large dataset is split along time between that worker and a few helpers,
// each holding the same files open by parts (mounted, never copied): a slice
// of the steps each, read side by side, joined here in order. Every step is
// computed the same way wherever it runs, so the joined series is the one a
// single worker would return. Where workers are unavailable (the portable
// build opened from file://), the same requests run in the page on the whole
// file in memory: slower and bounded by memory, but the view works.

import { canUseWorkers } from '../core/worker-pool.js';
import { handleGriddedRequest } from './gridded-protocol.js';

let sequence = 0;

export function nextDatasetId() {
    sequence += 1;
    return `grid-${Date.now().toString(36)}-${sequence}`;
}

// A series is split only where it pays: on a small file the helpers' start
// (each loads the HDF5 reader) costs more than the read itself.
const PARALLEL_DEFAULTS = { minBytes: 64 * 1024 * 1024, minSteps: 32, maxWorkers: 4 };

function toError(error) {
    const result = new Error(error?.message || 'Gridded request failed');
    result.name = error?.name || 'Error';
    if (error?.code) result.code = error.code;
    if (error?.cancelled) result.cancelled = true;
    return result;
}

/**
 * The time axis `[0, total)` cut into at most `parts` slices of whole
 * chunks (`chunk` steps each), as `[start, stop)` pairs in order: no chunk
 * is decompressed by two workers.
 */
export function splitTimeRange(total, chunk, parts) {
    const step = Math.max(1, Math.floor(chunk) || 1);
    const chunks = Math.ceil(total / step);
    const count = Math.max(1, Math.min(parts, chunks));
    const ranges = [];
    for (let index = 0; index < count; index++) {
        const start = Math.round((index * chunks) / count) * step;
        const stop = Math.min(total, Math.round(((index + 1) * chunks) / count) * step);
        if (stop > start) ranges.push([start, stop]);
    }
    return ranges;
}

const SERIES_FIELDS = {
    point: ['values'],
    region: ['mean', 'min', 'max', 'validFraction', 'minLat', 'minLon', 'maxLat', 'maxLon'],
};

/** The slices of a point or region result, in time order, joined into one. */
export function joinSeriesSlices(op, slices) {
    const fields = SERIES_FIELDS[op];
    const join = parts => {
        const out = { ...parts[0] };
        for (const field of fields) {
            if (!parts[0][field]) continue;
            const joined = new Float64Array(parts.reduce((sum, part) => sum + part[field].length, 0));
            let offset = 0;
            for (const part of parts) {
                joined.set(part[field], offset);
                offset += part[field].length;
            }
            out[field] = joined;
        }
        return out;
    };
    if (!slices[0].byLevel) return join(slices);
    return {
        ...slices[0],
        byLevel: slices[0].byLevel.map((level, index) => join(slices.map(slice => slice.byLevel[index]))),
    };
}

export class GriddedClient {
    constructor() {
        this.slots = [];
        this.pending = new Map();
        this.composites = new Map();
        this.requestId = 0;
        this.inline = !canUseWorkers();
        this.inlineDatasets = new Map();
        this.inlineJobs = new Map();
        // What each open dataset was opened from, so a helper can open it too.
        this.datasets = new Map();
        this.parallel = { ...PARALLEL_DEFAULTS };
    }

    get usesWorker() {
        return !this.inline;
    }

    get worker() {
        return this.slots[0]?.worker || null;
    }

    _spawn(index) {
        const worker = new Worker(new URL('../workers/gridded-worker.js', import.meta.url), { type: 'module' });
        const slot = { worker, open: new Set(), index };
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
            // A crashed worker loses every dataset it held. The first one
            // holds them all for the app, which is told; a helper is just
            // dropped, and the next long series starts a new one.
            const error = Object.assign(new Error(event?.message || 'The gridded data worker stopped.'), { code: 'GRIDDED_WORKER_LOST' });
            for (const [id, entry] of this.pending) {
                if (entry.slot !== slot) continue;
                this.pending.delete(id);
                entry.reject(error);
            }
            try { worker.terminate(); } catch { /* already gone */ }
            if (this.slots[index] === slot) this.slots[index] = null;
            if (index === 0) this.onWorkerLost?.();
        };
        worker.addEventListener('error', fail);
        worker.addEventListener('messageerror', fail);
        this.slots[index] = slot;
        return slot;
    }

    _slot(index) {
        return this.slots[index] || this._spawn(index);
    }

    _post(slot, op, payload, { onProgress = null, transfer = [] } = {}) {
        const id = ++this.requestId;
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress, slot });
        });
        slot.worker.postMessage({ id, op, payload }, transfer);
        return { id, promise };
    }

    /**
     * @returns {{id: number, promise: Promise<any>}}
     */
    request(op, payload, { onProgress = null, transfer = [] } = {}) {
        if (this.inline) {
            const id = ++this.requestId;
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
        const ranges = (op === 'point' || op === 'region') ? this._parallelRanges(payload) : null;
        if (ranges) return this._requestParallel(op, payload, ranges, onProgress);
        return this._post(this._slot(0), op, payload, { onProgress, transfer });
    }

    _workerCount() {
        const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
        return Math.min(this.parallel.maxWorkers, cores);
    }

    /** The time slices a series request is split into, or null to read it in one worker. */
    _parallelRanges(payload) {
        const dataset = this.datasets.get(payload.datasetId);
        const variable = dataset?.model?.variables?.find(item => item.key === payload.variable);
        const steps = variable?.timeDim ? dataset.model.axes[variable.timeDim]?.size || 0 : 0;
        const workers = this._workerCount();
        if (workers < 2 || !variable || steps < this.parallel.minSteps || dataset.bytes < this.parallel.minBytes) return null;
        const ranges = splitTimeRange(steps, variable.timeChunk || 1, workers);
        return ranges.length > 1 ? ranges : null;
    }

    /**
     * Starts the helpers and opens a large dataset in them ahead of its
     * first series (the view calls this when the point or region tool is
     * picked), so that series does not wait for them. Nothing happens for a
     * dataset a series would not be split for.
     */
    prepareParallel(datasetId) {
        if (this.inline) return;
        const dataset = this.datasets.get(datasetId);
        const timeDim = dataset?.model?.primaryTimeDim;
        const steps = timeDim ? dataset.model.axes[timeDim]?.size || 0 : 0;
        if (!dataset || steps < this.parallel.minSteps || dataset.bytes < this.parallel.minBytes) return;
        for (let index = 1; index < this._workerCount(); index++) {
            this._ensureOpen(this._slot(index), datasetId).catch(() => { /* the series will retry, or read in one worker */ });
        }
    }

    _requestParallel(op, payload, ranges, onProgress) {
        const id = ++this.requestId;
        const composite = { subs: [], cancelled: false };
        this.composites.set(id, composite);
        const total = ranges.at(-1)[1] - ranges[0][0];
        const shares = ranges.map(() => 0);
        const report = () => onProgress?.(shares.reduce((sum, share, index) => sum + share * (ranges[index][1] - ranges[index][0]), 0) / total);
        const promise = (async () => {
            try {
                const slices = await Promise.all(ranges.map(async (timeRange, index) => {
                    const slot = this._slot(index);
                    await this._ensureOpen(slot, payload.datasetId);
                    if (composite.cancelled) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', cancelled: true });
                    const sub = this._post(slot, op, { ...payload, timeRange }, {
                        onProgress: share => { shares[index] = share; report(); },
                    });
                    composite.subs.push({ slot, id: sub.id });
                    return sub.promise;
                }));
                return joinSeriesSlices(op, slices);
            } catch (error) {
                this._cancelComposite(composite);
                if (error?.cancelled || composite.cancelled) throw error;
                // A helper that failed (it ran out of memory, say) must not
                // fail the series: the first worker reads it all, as before.
                console.warn('[gridded] parallel read failed, reading in one worker:', error?.message || error);
                return this._post(this._slot(0), op, payload, { onProgress }).promise;
            } finally {
                this.composites.delete(id);
            }
        })();
        return { id, promise };
    }

    async _ensureOpen(slot, datasetId) {
        if (slot.index === 0 || slot.open.has(datasetId)) return;
        const dataset = this.datasets.get(datasetId);
        if (!dataset) throw Object.assign(new Error('The dataset is no longer open.'), { code: 'GRIDDED_NOT_OPEN' });
        if (!slot.opening) slot.opening = new Map();
        if (!slot.opening.has(datasetId)) {
            const inputs = dataset.files.map(file => ({ file, filename: file.name }));
            slot.opening.set(datasetId, this._post(slot, 'open', { datasetId, inputs, options: dataset.options }).promise
                .then(() => { slot.open.add(datasetId); })
                .finally(() => slot.opening.delete(datasetId)));
        }
        await slot.opening.get(datasetId);
    }

    _cancelComposite(composite) {
        composite.cancelled = true;
        for (const { slot, id } of composite.subs) slot.worker.postMessage({ id: 0, op: 'cancel', payload: { jobId: id } });
    }

    cancel(id) {
        if (this.inline) {
            const job = this.inlineJobs.get(id);
            if (job) job.cancelled = true;
            return;
        }
        const composite = this.composites.get(id);
        if (composite) {
            this._cancelComposite(composite);
            return;
        }
        const entry = this.pending.get(id);
        (entry?.slot?.worker || this.worker)?.postMessage({ id: 0, op: 'cancel', payload: { jobId: id } });
    }

    // The helpers drop their copy of a dataset closed or opened anew.
    _closeOnHelpers(datasetId) {
        for (const slot of this.slots.slice(1)) {
            if (!slot?.open.has(datasetId)) continue;
            slot.open.delete(datasetId);
            this._post(slot, 'close', { datasetId }).promise.catch(() => false);
        }
    }

    async open(datasetId, files, options = {}) {
        this._closeOnHelpers(datasetId);
        const inputs = files.map(file => ({ file, filename: file.name }));
        const result = await this.request('open', { datasetId, inputs, options }).promise;
        if (result?.gridded && !this.inline) {
            const bytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
            this.datasets.set(datasetId, { files, options, model: result.model, bytes });
        }
        return result;
    }

    close(datasetId) {
        if (!datasetId) return Promise.resolve(false);
        this.datasets.delete(datasetId);
        this._closeOnHelpers(datasetId);
        // With nothing left open the helpers only hold memory: they stop,
        // and the next large dataset starts them again.
        if (!this.datasets.size) {
            for (const [index, slot] of this.slots.entries()) {
                if (index === 0 || !slot) continue;
                try { slot.worker.terminate(); } catch { /* already gone */ }
                this.slots[index] = null;
            }
        }
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
