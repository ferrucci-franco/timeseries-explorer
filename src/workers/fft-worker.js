import { computeAmplitudeSpectrum, finiteExtent, selectFftRangeFromParts } from '../utils/fft.js';

self.addEventListener('message', (event) => {
    const { id, input } = event.data || {};
    try {
        // A lazy read arrives as the chunks it was read in, with its range:
        // joined and cut here, off the main thread (#174).
        let job = input || {};
        if (job.parts) {
            const { times, values } = selectFftRangeFromParts(job.parts, job.range);
            job = { ...job, times, values, parts: null };
        }
        const spectrum = computeAmplitudeSpectrum(job);
        // The extent the panel scales its Y axis to, found here rather than
        // over millions of bins on the main thread (#174). The same scan as
        // PlotManager._finiteExtent, so the same numbers.
        if (spectrum?.ok && spectrum.rawAmplitudes) spectrum.rawExtent = finiteExtent(spectrum.rawAmplitudes);
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
