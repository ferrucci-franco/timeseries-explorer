// Pure state for the 2D-mode display + fitting feature (TODO 10). No DOM /
// Plotly here so it is unit-testable in isolation; the DOM/render glue lives in
// plots/methods/phase2d-fit-methods.js.

export const PHASE2D_DISPLAY_MODES = new Set(['lines', 'markers', 'lines+markers']);
export const PHASE2D_FIT_MODELS = new Set(['none', 'linear', 'quadratic']);
export const PHASE2D_LAYOUTS = new Set(['horizontal', 'vertical']);
export const MARKER_SIZE_MIN = 1;
export const MARKER_SIZE_MAX = 20;
export const MARKER_OPACITY_MIN = 0.05;
export const MARKER_OPACITY_MAX = 1;

export const clampNumber = (value, lo, hi, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
};

export const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

export function defaultPhase2dState() {
    return {
        displayMode: 'lines',   // 'lines' | 'markers' | 'lines+markers'
        markerSize: 4,
        markerOpacity: 0.65,
        fitEnabled: false,      // Curve Fit workspace open (toolbar toggle)
        activePairIndex: 0,     // which pair the drawer edits/shows
        layout: 'vertical',
        split: 0.5,
        optionsVisible: true,
        timeSeriesHidden: true, // fit workspace focuses on the 2D scatter by default
        rangeFull: true,
        x1: null,
        x2: null,
        warnings: [],
        dirty: false,
    };
}

export function normalizePhase2dState(raw = {}) {
    const defaults = defaultPhase2dState();
    const split = Number(raw.split);
    const x1 = finiteOrNull(raw.x1);
    const x2 = finiteOrNull(raw.x2);
    return {
        ...defaults,
        ...raw,
        displayMode: PHASE2D_DISPLAY_MODES.has(raw.displayMode) ? raw.displayMode : defaults.displayMode,
        markerSize: clampNumber(raw.markerSize, MARKER_SIZE_MIN, MARKER_SIZE_MAX, defaults.markerSize),
        markerOpacity: clampNumber(raw.markerOpacity, MARKER_OPACITY_MIN, MARKER_OPACITY_MAX, defaults.markerOpacity),
        // Curve Fit workspace toggle. Migrate legacy sessions that stored a
        // global fitModel: a non-'none' model means the workspace was open.
        fitEnabled: raw.fitEnabled !== undefined ? !!raw.fitEnabled : (!!raw.fitModel && raw.fitModel !== 'none'),
        activePairIndex: Number.isInteger(raw.activePairIndex) && raw.activePairIndex >= 0 ? raw.activePairIndex : 0,
        layout: PHASE2D_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        optionsVisible: raw.optionsVisible !== false,
        timeSeriesHidden: raw.timeSeriesHidden !== false,
        rangeFull: raw.rangeFull !== undefined ? !!raw.rangeFull : !(x1 !== null || x2 !== null),
        x1,
        x2,
        warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 20) : [],
        dirty: !!raw.dirty,
    };
}

// The Plotly `mode` string for a display setting.
export function phase2dPlotlyMode(state) {
    if (state?.displayMode === 'markers') return 'markers';
    if (state?.displayMode === 'lines+markers') return 'lines+markers';
    return 'lines';
}

export function phase2dShowsMarkers(state) {
    return state?.displayMode === 'markers' || state?.displayMode === 'lines+markers';
}
