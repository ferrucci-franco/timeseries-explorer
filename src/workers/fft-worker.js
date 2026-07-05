import { computeAmplitudeSpectrum } from '../utils/fft.js';

self.addEventListener('message', (event) => {
    const { id, input } = event.data || {};
    try {
        const spectrum = computeAmplitudeSpectrum(input || {});
        self.postMessage({ id, ok: true, spectrum }, transferSpectrumBuffers(spectrum));
    } catch (err) {
        self.postMessage({
            id,
            ok: false,
            error: {
                name: err?.name || 'Error',
                message: err?.message || String(err),
                stack: err?.stack || '',
            },
        });
    }
});

function transferSpectrumBuffers(spectrum) {
    const buffers = new Set();
    for (const key of ['frequencies', 'amplitudes', 'rawAmplitudes']) {
        const buffer = spectrum?.[key]?.buffer;
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) buffers.add(buffer);
    }
    return [...buffers];
}
