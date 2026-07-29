// Off-thread host for the Data Tools kernels and the FFT.
//
// Everything it imports is pure compute — no DOM, no i18n, no Plotly — which is
// what keeps the worker chunk small enough that spawning it is not itself a
// stall.
//
// The `fft:spectrum` op is here so fft-methods.js can eventually drop its own
// worker (src/workers/fft-worker.js) and its hand-rolled lifecycle. That
// migration has not happened yet; both exist today.

import { runDataToolPipeline, runResample } from '../compute/kernels/index.js';
import { computeAmplitudeSpectrum } from '../utils/fft.js';

const HANDLERS = {
    'dataTool:pipeline': ({ values, time, steps }) => {
        const result = runDataToolPipeline(values, time, steps);
        return {
            result,
            // `values` is the last entry of stepValues, so collectBuffers'
            // Set dedupe is what stops it being listed as transferable twice
            // (which throws DataCloneError).
            transfer: collectBuffers([result.values, ...result.stepValues]),
        };
    },
    'dataTool:resample': (payload) => {
        const result = runResample(payload || {});
        return {
            result,
            transfer: collectBuffers([result.grid, ...result.columns]),
        };
    },
    'fft:spectrum': (input) => {
        const spectrum = computeAmplitudeSpectrum(input || {});
        return {
            result: spectrum,
            transfer: collectBuffers([
                spectrum?.frequencies,
                spectrum?.amplitudes,
                spectrum?.rawAmplitudes,
            ]),
        };
    },
};

self.addEventListener('message', (event) => {
    const { id, op, payload } = event.data || {};
    const handler = HANDLERS[op];
    if (!handler) {
        self.postMessage({ id, ok: false, error: { name: 'Error', message: `Unknown op "${op}"` } });
        return;
    }
    try {
        const { result, transfer } = handler(payload);
        self.postMessage({ id, ok: true, result }, transfer || []);
    } catch (err) {
        self.postMessage({
            id,
            ok: false,
            error: {
                name: err?.name || 'Error',
                message: err?.message || String(err),
                // Kernels raise DataToolError with a stable code; the UI maps it
                // back to i18n.t(). Losing this would turn a translated warning
                // into a raw English string.
                code: err?.code || '',
                stack: err?.stack || '',
                // Parsers attach their own fields (pickle reports .format and
                // .type) and the UI turns them into translated messages, so a
                // fixed name/message pair would lose the diagnosis.
                details: ownProps(err),
            },
        });
    }
});

function collectBuffers(views) {
    const buffers = new Set();
    for (const view of views) {
        const buffer = view?.buffer;
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) buffers.add(buffer);
    }
    return [...buffers];
}

// Own enumerable properties of an Error, minus the ones already sent above.
function ownProps(err) {
    if (!err || typeof err !== 'object') return {};
    const out = {};
    for (const key of Object.keys(err)) {
        if (key === 'code' || key === 'stack' || key === 'message' || key === 'name') continue;
        const value = err[key];
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    }
    return out;
}
