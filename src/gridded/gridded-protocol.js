// The requests a gridded dataset answers, shared by the worker and by the
// in-page fallback (no Worker under file://), so both run the same code.

function transferOf(...arrays) {
    return arrays.filter(array => ArrayBuffer.isView(array)).map(array => array.buffer);
}

/**
 * @param {{GriddedDataset: Function, datasets: Map}} context
 * @param {string} op
 * @param {object} payload
 * @param {{cancelled: boolean, onProgress?: Function}} job
 * @returns {Promise<{result: any, transfer?: ArrayBuffer[]}>}
 */
export async function handleGriddedRequest({ GriddedDataset, datasets }, op, payload, job) {
    const dataset = () => {
        const found = datasets.get(payload.datasetId);
        if (!found) throw Object.assign(new Error('The dataset is no longer open.'), { code: 'GRIDDED_NOT_OPEN' });
        return found;
    };
    switch (op) {
    case 'open': {
        const opened = await GriddedDataset.open(payload.inputs || [], payload.options || {});
        const model = opened.model();
        if (!opened.gridded) {
            opened.close();
            return { result: { gridded: false, model } };
        }
        datasets.get(payload.datasetId)?.close();
        datasets.set(payload.datasetId, opened);
        return { result: { gridded: true, model } };
    }
    case 'map': {
        const map = dataset().readMap(payload.variable, payload.selection || {});
        return { result: map, transfer: transferOf(map.values) };
    }
    case 'point': {
        const series = await dataset().pointSeries(payload.variable, payload.selection || {}, payload.lat, payload.lon, job, { levels: payload.levels, method: payload.method, timeRange: payload.timeRange });
        const parts = series.byLevel || [series];
        return { result: series, transfer: transferOf(...parts.map(part => part.values)) };
    }
    case 'region': {
        const stats = await dataset().regionStats(payload.variable, payload.selection || {}, payload.box, job, { levels: payload.levels, timeRange: payload.timeRange });
        const parts = stats.byLevel || [stats];
        return { result: stats, transfer: transferOf(...parts.flatMap(part => [part.mean, part.min, part.max, part.validFraction])) };
    }
    case 'range': {
        const range = await dataset().valueRange(payload.variable, payload.selection || {}, payload.options || {}, job);
        return { result: range };
    }
    case 'close': {
        datasets.get(payload.datasetId)?.close();
        datasets.delete(payload.datasetId);
        return { result: true };
    }
    default:
        throw new Error(`Unknown op "${op}"`);
    }
}
