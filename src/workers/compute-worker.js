// Off-thread host for the Data Tools kernels and the FFT.
//
// Everything it imports is pure compute — no DOM, no i18n, no Plotly — which is
// what keeps the worker chunk small enough that spawning it is not itself a
// stall.
//
// The `fft:spectrum` op is here so fft-methods.js can eventually drop its own
// worker (src/workers/fft-worker.js) and its hand-rolled lifecycle. That
// migration has not happened yet; both exist today.

import { runDataToolPipeline, runResample, runCrossCorrelation } from '../compute/kernels/index.js';
import { detectSpikeWindow } from '../compute/kernels/outliers.js';
import { computeAmplitudeSpectrum } from '../utils/fft.js';
import { detectSamplingGaps } from '../utils/sampling-gaps.js';
import { curveFitRows } from '../compute/analysis/curve-fit.js';
import { trendExpOf, trendRows } from '../compute/analysis/trend.js';
import { pairFitRows } from '../compute/analysis/pair-fit.js';
import { histogramCountsOf, histogramStatsOf } from '../compute/analysis/histogram.js';
import { pairCorrelationRows } from '../compute/analysis/correlation.js';
import { integralMissingDays, integralRows } from '../compute/analysis/integral.js';
import { buildCalendarHeatmap } from '../utils/calendar-heatmap.js';
import { buildTemporalProfile } from '../utils/temporal-profile.js';

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
    // The spike detector over one core of a lazy file and its surroundings
    // (src/compute/kernels/windowed.js): the chunked executor runs the cores
    // here, several at a time.
    'dataTool:spikeWindow': ({ values, coreStart, coreEnd, params }) => {
        const result = detectSpikeWindow({ values, coreStart, coreEnd }, params || {});
        return { result, transfer: collectBuffers([result.values, result.aux]) };
    },
    'dataTool:xcorr': (payload) => {
        const result = runCrossCorrelation(payload || {});
        return {
            result,
            transfer: collectBuffers([result.lags, result.values, result.counts]),
        };
    },
    // The step of a time axis (the cross-correlation panel's lag unit): the
    // measurement is a few hundred ms on 10 M samples. Only what the panel
    // reads comes back, not the list of gaps.
    'axis:step': ({ values }) => {
        const info = detectSamplingGaps(values);
        return { result: { medianDt: info.medianDt, hasNominalStep: info.hasNominalStep, reason: info.reason } };
    },
    // The analyses of an in-memory file (src/core/analysis-pool.js): each op
    // runs the very function the main thread runs where there is no worker.
    'analysis:curveFit': (payload) => {
        const result = curveFitRows(payload || {});
        return { result, transfer: collectBuffers([result.residual?.x, result.residual?.y]) };
    },
    'analysis:trend': (payload) => ({ result: trendRows(payload || {}) }),
    'analysis:trendExp': (payload) => ({ result: trendExpOf(payload || {}) }),
    'analysis:pairFit': (payload) => ({ result: pairFitRows(payload || {}) }),
    // The values come back with their stats: the panel counts them next, and
    // a buffer handed over and back is never copied.
    'analysis:histogramStats': (payload) => {
        const values = payload?.values;
        return { result: { stat: histogramStatsOf(payload || {}), values }, transfer: collectBuffers([values]) };
    },
    'analysis:histogramCounts': (payload) => {
        const result = histogramCountsOf(payload || {});
        return { result, transfer: collectBuffers([result.counts]) };
    },
    'analysis:correlation': (payload) => ({ result: pairCorrelationRows(payload || {}) }),
    'analysis:integral': (payload) => ({ result: integralRows(payload || {}) }),
    'analysis:integralMissingDays': (payload) => ({ result: integralMissingDays(payload || {}) }),
    // Already functions of plain data: the worker runs them as they are.
    'analysis:heatmap': (payload) => ({ result: buildCalendarHeatmap(payload || {}) }),
    'analysis:temporalProfile': (payload) => ({ result: buildTemporalProfile(payload || {}) }),
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

// The rows of a lazy file arrive as the chunks they were read in, their
// buffers handed over one by one so the main thread never joins them: here
// each named field is joined into one array, and the op runs on the result as
// it would on arrays that were whole from the start (the fit kernels'
// accumulators give the same bits either way; joined, the job is one function
// call instead of a pass per chunk).
HANDLERS['analysis:joined'] = ({ op, payload, chunks }) => {
    const handler = HANDLERS[op];
    if (!handler || op === 'analysis:joined') throw new Error(`Unknown op "${op}"`);
    const joined = { ...(payload || {}) };
    for (const [field, parts] of Object.entries(chunks || {})) joined[field] = joinChunks(parts);
    return handler(joined);
};

function joinChunks(parts) {
    const list = parts || [];
    if (list.length === 1) return list[0];
    const out = new Float64Array(list.reduce((n, part) => n + (part?.length || 0), 0));
    let at = 0;
    for (const part of list) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

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
