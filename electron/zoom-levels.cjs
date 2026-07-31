// The zoom ladder for the desktop window.
//
// The browser build has no equivalent: there the user still has the browser's
// own Ctrl +/- and this module is never loaded. Desktop needs it because the
// app menu is removed at startup (Menu.setApplicationMenu(null) plus
// win.removeMenu()), and in Electron the zoom accelerators come from that
// menu's roles -- removing it removed them, leaving no way to zoom at all.
//
// The steps are Chrome's, trimmed at both ends. Below 50% the sidebar controls
// stop being clickable targets; above 300% a single plot no longer fits the
// window, and neither extreme is a state worth being able to reach and then
// have to escape from.
const ZOOM_FACTORS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = ZOOM_FACTORS[0];
const MAX_ZOOM_FACTOR = ZOOM_FACTORS[ZOOM_FACTORS.length - 1];

// Chromium stores the zoom as a level, not a factor: level = log(factor)/log(1.2).
// A factor that goes through setZoomFactor() and comes back from
// getZoomFactor() is therefore the same number only to within rounding --
// 0.67 returns as 0.6700000000000002 -- so stepping compares with a tolerance.
// It is two orders of magnitude below the smallest gap in the ladder (0.05).
const STEP_EPSILON = 1e-3;

function normalizeZoomFactor(value) {
    const factor = Number(value);
    if (!Number.isFinite(factor) || factor <= 0) return DEFAULT_ZOOM_FACTOR;
    return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, factor));
}

function nextZoomFactor(current) {
    const factor = normalizeZoomFactor(current);
    return ZOOM_FACTORS.find(step => step > factor + STEP_EPSILON) ?? MAX_ZOOM_FACTOR;
}

function previousZoomFactor(current) {
    const factor = normalizeZoomFactor(current);
    const below = ZOOM_FACTORS.filter(step => step < factor - STEP_EPSILON);
    return below.length ? below[below.length - 1] : MIN_ZOOM_FACTOR;
}

// One entry point for every caller -- the menu buttons and the keyboard
// accelerators both come through here, so they cannot drift into two ladders.
function stepZoomFactor(current, action) {
    if (action === 'in') return nextZoomFactor(current);
    if (action === 'out') return previousZoomFactor(current);
    return DEFAULT_ZOOM_FACTOR;
}

function zoomPercent(factor) {
    return Math.round(normalizeZoomFactor(factor) * 100);
}

module.exports = {
    DEFAULT_ZOOM_FACTOR,
    MAX_ZOOM_FACTOR,
    MIN_ZOOM_FACTOR,
    ZOOM_FACTORS,
    normalizeZoomFactor,
    nextZoomFactor,
    previousZoomFactor,
    stepZoomFactor,
    zoomPercent,
};
