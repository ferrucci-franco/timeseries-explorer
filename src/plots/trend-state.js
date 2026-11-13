// Pure state of the time-series Trend analysis. No DOM and no Plotly, so it
// can be checked on its own; the panel lives in
// plots/methods/trend-methods.js and the computing in
// plots/methods/trend-lazy-methods.js.
//
// A panel holds a LIST of SEGMENTS. A long record is rarely one trend: a
// battery test is a charge, a rest and a discharge, and what the user wants is
// the mean, the slope and how straight each stretch is — side by side, in the
// same units, while the edges of a stretch are dragged. So each segment carries
// its own signal, its own time range and its own value band, and its numbers
// are written in that segment's own shifted time t′ = t − t₀.
//
// Every segment always reports its mean, its linear trend and its quadratic
// trend: the three come from two passes of sums over its rows, which is one
// aggregate query on a lazy file — cheap enough to recompute while a range is
// dragged. The exponential is per segment and off by default, because it is an
// iterative fit: on a lazy file of any size it is a score of reads of the range.
//
// The value band is what "remove the outliers of this stretch" means here: two
// bounds in the signal's own units, drawn as two draggable horizontal lines
// across the segment. A row whose value falls outside them is dropped from the
// mean and from every trend, and counted, so the table says how many rows the
// band took out. The test is the Data tools' bounds detector's
// (src/compute/kernels/outliers.js), and a seeded band is mean ± 3σ of the
// segment as it stands.

import { EXP_FAMILY_MODELS } from '../utils/exp-fit.js';

export const TREND_LAYOUTS = new Set(['horizontal', 'vertical']);
export const TREND_MAX_SEGMENTS = 12;

// The exponential models a segment may ask for, in menu order. `none` is the
// default: no exponential fit is computed for that segment.
export const TREND_EXP_OPTIONS = [
    { id: 'none', key: 'trendExpOff' },
    { id: 'exponential', key: 'fitModelExponential' },
    { id: 'exponential-offset', key: 'fitModelExponentialOffset' },
    { id: 'first-order', key: 'fitModelFirstOrder' },
    { id: 'first-order-offset', key: 'fitModelFirstOrderOffset' },
];

// Which curves the time pane draws. The numbers of mean, linear and quadratic
// are always in the table; this is only what is drawn over the signal.
export const TREND_CURVES = ['mean', 'linear', 'quadratic', 'exp'];

// How many stddevs the "3σ" button puts the band at.
export const TREND_BAND_SIGMA_MIN = 0.1;
export const TREND_BAND_SIGMA_MAX = 10;

// The colour of each segment: its band on the time pane, its curves, its row
// in the table and its swatch in the drawer. The Curve Fit analysis' palette,
// so a segment and a fit of the same number look alike.
const TREND_COLORS = ['#e53935', '#8e24aa', '#f57c00', '#00897b', '#3949ab', '#6d4c41', '#c2185b', '#7cb342'];

export function trendColor(index) {
    return TREND_COLORS[((Number(index) || 0) % TREND_COLORS.length + TREND_COLORS.length) % TREND_COLORS.length];
}

const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

let segmentSerial = 0;
const newSegmentId = () => `seg${Date.now().toString(36)}${(segmentSerial++).toString(36)}`;

export function defaultTrendSegment(overrides = {}) {
    return {
        id: newSegmentId(),
        fileId: null,
        varName: null,
        // A trend is almost always of a stretch, so a new segment starts on a
        // selection (seeded from the view by the panel), not on the whole file.
        rangeFull: false,
        x1: null,
        x2: null,
        // The value band: off until the user turns it on, and then two bounds
        // in the signal's units (null = that side is open).
        bandOn: false,
        lower: null,
        upper: null,
        // The exponential fit of this segment, when asked for.
        expModel: 'none',
        ...overrides,
    };
}

export function normalizeTrendSegment(raw = {}) {
    const blank = defaultTrendSegment();
    const expModel = EXP_FAMILY_MODELS.has(raw.expModel) ? raw.expModel : 'none';
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : blank.id,
        fileId: raw.fileId ?? null,
        varName: typeof raw.varName === 'string' ? raw.varName : null,
        rangeFull: raw.rangeFull === true,
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
        bandOn: raw.bandOn === true,
        lower: finiteOrNull(raw.lower),
        upper: finiteOrNull(raw.upper),
        expModel,
    };
}

export function defaultTrendState() {
    return {
        layout: 'vertical',
        split: 0.7,
        optionsVisible: true,
        tableHidden: false,
        // The unit of t′ on a calendar axis, as the Curve Fit analysis means it.
        timeUnit: 's',
        activeSegment: 0,
        bandSigma: 3,
        curves: { mean: true, linear: true, quadratic: false, exp: true },
        segments: [defaultTrendSegment()],
    };
}

export function normalizeTrendState(raw = {}) {
    const defaults = defaultTrendState();
    const split = Number(raw.split);
    const sigma = Number(raw.bandSigma);
    const segments = Array.isArray(raw.segments) && raw.segments.length
        ? raw.segments.slice(0, TREND_MAX_SEGMENTS).map(normalizeTrendSegment)
        : defaults.segments;
    const active = Number.isInteger(raw.activeSegment) ? raw.activeSegment : 0;
    const curves = { ...defaults.curves };
    for (const key of TREND_CURVES) {
        if (raw.curves && typeof raw.curves === 'object' && key in raw.curves) curves[key] = raw.curves[key] !== false;
    }
    return {
        layout: TREND_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.85, split)) : defaults.split,
        optionsVisible: raw.optionsVisible !== false,
        tableHidden: raw.tableHidden === true,
        timeUnit: raw.timeUnit === 's' || raw.timeUnit === 'min' || raw.timeUnit === 'h' || raw.timeUnit === 'd'
            ? raw.timeUnit
            : defaults.timeUnit,
        activeSegment: Math.max(0, Math.min(segments.length - 1, active)),
        bandSigma: Number.isFinite(sigma)
            ? Math.max(TREND_BAND_SIGMA_MIN, Math.min(TREND_BAND_SIGMA_MAX, sigma))
            : defaults.bandSigma,
        curves,
        segments,
    };
}

/**
 * The value band of a segment as the kernel and the SQL read it: `null` when it
 * is off or has no bound at all, `{ lower, upper }` otherwise (an open side is
 * null, which both paths take as ±∞).
 */
export function trendSegmentBand(segment) {
    if (!segment?.bandOn) return null;
    const lower = finiteOrNull(segment.lower);
    const upper = finiteOrNull(segment.upper);
    if (lower === null && upper === null) return null;
    return { lower, upper };
}
