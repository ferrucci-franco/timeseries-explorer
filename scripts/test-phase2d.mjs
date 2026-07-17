import assert from 'node:assert/strict';
import {
    defaultPhase2dState,
    normalizePhase2dState,
    phase2dPlotlyMode,
    phase2dShowsMarkers,
    clampNumber,
} from '../src/plots/phase2d-state.js';

// Defaults: legacy-compatible line trajectory.
const d = defaultPhase2dState();
assert.equal(d.displayMode, 'lines', 'default display is lines (legacy behaviour)');
assert.equal(d.markerSize, 4);
assert.equal(d.markerOpacity, 0.65);
assert.equal(d.fitModel, 'none');
assert.equal(d.rangeFull, true);

// Enum validation falls back to defaults.
assert.equal(normalizePhase2dState({ displayMode: 'bogus' }).displayMode, 'lines');
assert.equal(normalizePhase2dState({ displayMode: 'markers' }).displayMode, 'markers');
assert.equal(normalizePhase2dState({ displayMode: 'lines+markers' }).displayMode, 'lines+markers');
assert.equal(normalizePhase2dState({ fitModel: 'cubic' }).fitModel, 'none');
assert.equal(normalizePhase2dState({ fitModel: 'quadratic' }).fitModel, 'quadratic');
assert.equal(normalizePhase2dState({ layout: 'diagonal' }).layout, 'vertical');

// Marker size / opacity are clamped to their valid ranges.
assert.equal(normalizePhase2dState({ markerSize: 999 }).markerSize, 20, 'size clamps to max 20');
assert.equal(normalizePhase2dState({ markerSize: 0 }).markerSize, 1, 'size clamps to min 1');
assert.equal(normalizePhase2dState({ markerSize: 'oops' }).markerSize, 4, 'non-numeric size -> default');
assert.equal(normalizePhase2dState({ markerOpacity: 5 }).markerOpacity, 1, 'opacity clamps to max 1');
assert.equal(normalizePhase2dState({ markerOpacity: 0 }).markerOpacity, 0.05, 'opacity clamps to min 0.05');

// Split clamps to 0.2..0.8.
assert.equal(normalizePhase2dState({ split: 0.05 }).split, 0.2);
assert.equal(normalizePhase2dState({ split: 0.95 }).split, 0.8);
assert.equal(normalizePhase2dState({ split: 0.4 }).split, 0.4);

// rangeFull is inferred from x1/x2 when not given explicitly.
assert.equal(normalizePhase2dState({ x1: 1, x2: 2 }).rangeFull, false, 'a selection implies rangeFull=false');
assert.equal(normalizePhase2dState({}).rangeFull, true, 'no selection implies rangeFull=true');
assert.equal(normalizePhase2dState({ x1: 'nope' }).x1, null, 'non-finite x1 -> null');
assert.equal(normalizePhase2dState({ rangeFull: false, x1: 3, x2: 9 }).rangeFull, false);

// Plotly mode / marker-visibility mapping.
assert.equal(phase2dPlotlyMode({ displayMode: 'lines' }), 'lines');
assert.equal(phase2dPlotlyMode({ displayMode: 'markers' }), 'markers');
assert.equal(phase2dPlotlyMode({ displayMode: 'lines+markers' }), 'lines+markers');
assert.equal(phase2dShowsMarkers({ displayMode: 'lines' }), false);
assert.equal(phase2dShowsMarkers({ displayMode: 'markers' }), true);
assert.equal(phase2dShowsMarkers({ displayMode: 'lines+markers' }), true);

// clampNumber helper.
assert.equal(clampNumber(15, 1, 20, 4), 15);
assert.equal(clampNumber(NaN, 1, 20, 4), 4);
assert.equal(clampNumber(-3, 1, 20, 4), 1);

console.log('phase2d state tests passed');
