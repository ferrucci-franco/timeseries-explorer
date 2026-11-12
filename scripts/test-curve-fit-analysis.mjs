// The time-series Curve Fit analysis: its pure state (plots/curve-fit-state.js),
// the shifted time every equation is written in, and the wiring that makes it
// one more analysis of the time-series family (menu, phone sheet, sessions,
// mode lists). The drawing itself is covered by the browser check in
// scripts/e2e-analysis-gallery.mjs and by hand.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CURVE_FIT_MAX_FITS,
    CURVE_FIT_TIME_UNITS,
    decimateMinMax,
    defaultCurveFitState,
    normalizeCurveFitState,
    rangeIndices,
    shiftedTime,
} from '../src/plots/curve-fit-state.js';
import { FIT_MODELS, fitEquationParts } from '../src/utils/fit-models.js';
import { fitPair } from '../src/utils/regression.js';
import { COMPACT_ANALYSES } from '../src/app/methods/compact-analyses.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ── State ──
{
    const state = defaultCurveFitState();
    assert.equal(state.fits.length, 1, 'a panel opens with one fit to fill in');
    assert.equal(state.fits[0].model, 'none', 'and nothing fitted until a model is chosen');
    assert.equal(state.fits[0].rangeFull, false, 'a fit starts on a stretch, not the whole signal');
    assert.equal(state.timeUnit, 's');

    const normalized = normalizeCurveFitState({
        layout: 'sideways',
        split: 7,
        timeUnit: 'fortnight',
        activeFit: 9,
        fits: [
            { id: 'a', model: 'first-order-offset', x1: '10', x2: 20, varName: 'v', fileId: 'f' },
            { id: 'b', model: 'cubic', rangeFull: true },
        ],
    });
    assert.equal(normalized.layout, 'vertical', 'an unknown layout falls back');
    assert.equal(normalized.split, 0.85, 'the split is clamped');
    assert.equal(normalized.timeUnit, 's', 'an unknown unit falls back');
    assert.equal(normalized.activeFit, 1, 'the active fit is clamped to the list');
    assert.deepEqual(normalized.fits.map(f => f.model), ['first-order-offset', 'none'], 'an unknown model is none');
    assert.equal(normalized.fits[0].x1, 10, 'numeric strings are read');
    assert.equal(normalized.fits[1].rangeFull, true);

    const many = normalizeCurveFitState({ fits: Array.from({ length: 40 }, (_, i) => ({ id: `f${i}` })) });
    assert.equal(many.fits.length, CURVE_FIT_MAX_FITS, 'the number of fits is bounded');
    for (const model of FIT_MODELS) assert.ok(normalizeCurveFitState({ fits: [{ model }] }).fits[0].model === model, `${model} survives a session`);
}

// ── Time: ranges, the shift, the units ──
{
    const times = [0, 1, 2, 3, 4, 5, 6];
    assert.deepEqual(rangeIndices(times, 2, 4), [2, 5], 'inclusive on both ends');
    assert.deepEqual(rangeIndices(times, 2.5, 3.5), [3, 4]);
    assert.deepEqual(rangeIndices(times, 10, 20), [7, 7], 'an empty range is empty');
    assert.deepEqual([...shiftedTime([1000, 61000, 121000], 1000, CURVE_FIT_TIME_UNITS.min)], [0, 1, 2], 't′ = (t − t₀)/unit');
    assert.equal(CURVE_FIT_TIME_UNITS.h, 3600000, 'a calendar axis is in milliseconds');

    // The point of the shift: a first-order response that starts at a calendar
    // instant reads its own K, α and y₀, not coefficients of the epoch.
    const start = Date.UTC(2026, 10, 10, 17, 9, 11);
    const t = Array.from({ length: 600 }, (_, i) => start + i * 10000);
    const y = t.map(v => 0.1 + 2.4 * (1 - Math.exp(-(v - start) / 1000 / 2650)));
    const fit = fitPair('first-order-offset', shiftedTime(t, start, CURVE_FIT_TIME_UNITS.s), y);
    assert.ok(Math.abs(fit.K - 2.4) < 1e-5, `K read in shifted time (${fit.K})`);
    assert.ok(Math.abs(fit.y0 - 0.1) < 1e-5, `y₀ is the value at t₀ (${fit.y0})`);
    assert.ok(Math.abs(fit.timeConstant - 2650) < 0.1, `τ in seconds (${fit.timeConstant})`);
    const parts = fitEquationParts(fit, 't′');
    assert.equal(parts.generic, 'y = y₀ + K·(1 − e^(α·t′))', 'the equation is written in t′');
    assert.deepEqual(parts.coeffs.map(([k]) => k), ['y₀', 'K', 'α', 'τ']);
}

// ── Residual decimation keeps spikes and gaps ──
{
    const x = Array.from({ length: 10000 }, (_, i) => i);
    const y = x.map(i => (i === 5000 ? 50 : (i === 7000 ? NaN : Math.sin(i))));
    const d = decimateMinMax(x, y, 100);
    assert.ok(d.x.length <= 200, 'at most two points per bucket');
    assert.ok(d.y.includes(50), 'a spike survives decimation');
    for (let i = 1; i < d.x.length; i++) assert.ok(d.x[i] >= d.x[i - 1], 'time order is kept');
    const small = decimateMinMax([1, 2, 3], [1, NaN, 3], 100);
    assert.deepEqual(small.y, [1, null, 3], 'a short series is kept whole, with gaps as gaps');
}

// ── Wiring ──
{
    const marks = read('src/plots/methods/marks-methods.js');
    assert.match(marks, /\{ id: 'curve-fit', label: 'analysisItemCurveFit', title: 'curveFitMode'/, 'offered in the Analysis menu');
    const interaction = read('src/plots/methods/interaction-methods.js');
    assert.match(interaction, /_toggleTimeseriesAnalysisMode[\s\S]{0,200}'curve-fit'/, 'switched to like the other analyses');
    assert.match(interaction, /case 'curve-fit': return this\._curveFitDomain/, 'its time domain is known');
    const manager = read('src/plots/plot-manager.js');
    assert.match(manager, /installPlotCurveFitMethods\(PlotManager\);/);
    assert.match(manager, /plot\.mode === 'curve-fit'\) \{\s+this\._createCurveFitChart/, 'built by the chart dispatcher');
    assert.match(manager, /closest\('\.curve-fit-container'\)/, 'torn down before the generic fft-container shell');
    assert.ok(manager.indexOf('if (curveFitContainer) {') < manager.indexOf('} else if (fftContainer) {'), 'its branch runs before the fft one');
    assert.match(manager, /plot\.mode === 'curve-fit' && this\._exportCurveFitCsv/, 'exports its own CSV');
    const session = read('src/app/methods/session-methods.js');
    assert.match(session, /curveFit: this\._cloneSerializable\(plot\.curveFit/, 'saved with the session');
    assert.match(session, /_normalizeCurveFitState\(saved\.curveFit/, 'and restored through the normaliser');
    const entry = COMPACT_ANALYSES.find(e => e.mode === 'curve-fit');
    assert.ok(entry, 'the phone layout knows it');
    assert.equal(entry.pane.div, 'curveFitResidualDiv');
    assert.equal(entry.signals, true);
    const gallery = read('src/plots/analysis-gallery.js');
    assert.match(gallery, /'curve-fit': art\(/, 'it has a card drawing');
    // The 2D fit offers the same models.
    const phase2d = read('src/plots/methods/phase2d-fit-methods.js');
    assert.match(phase2d, /FIT_MODEL_OPTIONS\.forEach/, 'the 2D drawer lists the shared models');
    assert.match(phase2d, /EXP_FAMILY_MODELS\.has\(this\._phase2dPairModel\(p\)\)/, 'a lazy 2D exponential fit reads rows instead of SQL aggregates');
}

console.log('curve-fit analysis tests passed');
