// Off-thread host for the Data Tools kernels and the FFT.
//
// This replaces the bespoke fft-worker.js lifecycle with the shared envelope
// from src/core/worker-pool.js. Everything it imports is pure compute — no DOM,
// no i18n, no Plotly — which is what keeps the worker chunk small enough that
// spawning it is not itself a stall.

import { runDataToolPipeline } from '../compute/kernels/index.js';
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
