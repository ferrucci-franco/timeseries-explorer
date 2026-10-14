// The worker that holds gridded netCDF datasets open.
//
// Unlike the parse worker, which reads a file and hands back everything it
// found, this one keeps the files: a map view asks for one map at a time,
// then a column, then a region, for as long as the dataset stays open. The
// files are mounted, not copied (see src/gridded/dataset.js), so a dataset's
// cost here is its header and whatever request is in flight.
//
// Protocol: { id, op, payload } in; { id, ok, result } / { id, ok: false,
// error } out, plus { id, progress } while a long request runs. A request is
// cancelled with { op: 'cancel', payload: { jobId } }; long requests yield
// between blocks, which is where they notice.

import { GriddedDataset } from '../gridded/dataset.js';
import { handleGriddedRequest } from '../gridded/gridded-protocol.js';

const datasets = new Map();
const jobs = new Map();

self.addEventListener('message', async (event) => {
    const { id, op, payload } = event.data || {};
    if (op === 'cancel') {
        const job = jobs.get(payload?.jobId);
        if (job) job.cancelled = true;
        return;
    }
    const job = { cancelled: false, onProgress: progress => self.postMessage({ id, progress }) };
    jobs.set(id, job);
    try {
        const { result, transfer } = await handleGriddedRequest({ GriddedDataset, datasets }, op, payload || {}, job);
        self.postMessage({ id, ok: true, result }, transfer || []);
    } catch (error) {
        self.postMessage({
            id,
            ok: false,
            error: {
                name: error?.name || 'Error',
                message: error?.message || String(error),
                code: error?.code || '',
                cancelled: error?.cancelled === true,
            },
        });
    } finally {
        jobs.delete(id);
    }
});
