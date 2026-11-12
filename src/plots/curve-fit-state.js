// Pure state of the time-series Curve Fit analysis. No DOM and no Plotly, so
// it can be checked on its own; the panel lives in
// plots/methods/curve-fit-methods.js.
//
// A panel holds a LIST of fits. A transient is rarely one curve from end to
// end: a heater that sits idle, then ramps, then settles is a constant, a line
// and a first-order response, each over its own stretch of time. Each fit
// therefore carries its own signal, model and time range, and the equation of
// each is written in its own shifted time t′ = t − t₀, with t₀ the start of
// that range.

import { FIT_MODELS } from '../utils/fit-models.js';

export const CURVE_FIT_LAYOUTS = new Set(['horizontal', 'vertical']);
export const CURVE_FIT_MAX_FITS = 12;

// What one unit of t′ is, on a calendar axis (whose times are milliseconds).
// A numeric axis keeps its own unit: there is nothing to convert.
export const CURVE_FIT_TIME_UNITS = {
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
};

const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

let fitSerial = 0;
const newFitId = () => `fit${Date.now().toString(36)}${(fitSerial++).toString(36)}`;

export function defaultCurveFitEntry(overrides = {}) {
    return {
        id: newFitId(),
        fileId: null,
        varName: null,
        model: 'none',
        // Fits are almost always of a stretch of the signal, so a new fit starts
        // on a selection (seeded from the view by the panel), not on all of it.
        rangeFull: false,
        x1: null,
        x2: null,
        ...overrides,
    };
}

export function normalizeCurveFitEntry(raw = {}) {
    const entry = defaultCurveFitEntry();
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : entry.id,
        fileId: raw.fileId ?? null,
        varName: typeof raw.varName === 'string' ? raw.varName : null,
        model: FIT_MODELS.has(raw.model) ? raw.model : 'none',
        rangeFull: raw.rangeFull === true,
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
    };
}

export function defaultCurveFitState() {
    return {
        layout: 'vertical',
        split: 0.68,
        optionsVisible: true,
        residualsHidden: false,
        // A fit saved as a signal is NaN outside its own range unless asked.
        extrapolate: false,
        timeUnit: 's',
        activeFit: 0,
        fits: [defaultCurveFitEntry()],
    };
}

export function normalizeCurveFitState(raw = {}) {
    const defaults = defaultCurveFitState();
    const split = Number(raw.split);
    const fits = Array.isArray(raw.fits) && raw.fits.length
        ? raw.fits.slice(0, CURVE_FIT_MAX_FITS).map(normalizeCurveFitEntry)
        : defaults.fits;
    const active = Number.isInteger(raw.activeFit) ? raw.activeFit : 0;
    return {
        layout: CURVE_FIT_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.85, split)) : defaults.split,
        optionsVisible: raw.optionsVisible !== false,
        residualsHidden: raw.residualsHidden === true,
        extrapolate: raw.extrapolate === true,
        timeUnit: Object.hasOwn(CURVE_FIT_TIME_UNITS, raw.timeUnit) ? raw.timeUnit : defaults.timeUnit,
        activeFit: Math.max(0, Math.min(fits.length - 1, active)),
        fits,
    };
}

// The rows of a sorted time array inside [lo, hi], as start/end indices.
export function rangeIndices(times, lo, hi) {
    const n = times?.length || 0;
    let a = 0;
    let b = n;
    while (a < b) { const m = (a + b) >> 1; if (Number(times[m]) < lo) a = m + 1; else b = m; }
    const start = a;
    a = start;
    b = n;
    while (a < b) { const m = (a + b) >> 1; if (Number(times[m]) <= hi) a = m + 1; else b = m; }
    return [start, a];
}

/**
 * Shift and scale a stretch of time for a fit: t′ = (t − t₀) / unit. Returns
 * a Float64Array the same length as `times`.
 */
export function shiftedTime(times, t0, unitScale = 1) {
    const n = times?.length || 0;
    const out = new Float64Array(n);
    const scale = unitScale > 0 ? unitScale : 1;
    for (let i = 0; i < n; i++) out[i] = (Number(times[i]) - t0) / scale;
    return out;
}

/**
 * Min/max decimation of a residual series for drawing: at most `buckets`
 * buckets, each keeping its lowest and highest point in time order, so spikes
 * survive. Non-finite residuals become gaps (null). Returns { x, y } arrays.
 */
export function decimateMinMax(x, y, buckets = 2000) {
    const n = Math.min(x?.length || 0, y?.length || 0);
    if (n <= buckets * 2) {
        return {
            x: Array.from({ length: n }, (_, i) => x[i]),
            y: Array.from({ length: n }, (_, i) => (Number.isFinite(y[i]) ? y[i] : null)),
        };
    }
    const outX = [];
    const outY = [];
    const size = n / buckets;
    for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * size);
        const end = Math.min(n, Math.floor((b + 1) * size));
        let iMin = -1;
        let iMax = -1;
        for (let i = start; i < end; i++) {
            const v = y[i];
            if (!Number.isFinite(v)) continue;
            if (iMin < 0 || v < y[iMin]) iMin = i;
            if (iMax < 0 || v > y[iMax]) iMax = i;
        }
        if (iMin < 0) {
            outX.push(x[start]);
            outY.push(null);
            continue;
        }
        const first = Math.min(iMin, iMax);
        const second = Math.max(iMin, iMax);
        outX.push(x[first]);
        outY.push(y[first]);
        if (second !== first) {
            outX.push(x[second]);
            outY.push(y[second]);
        }
    }
    return { x: outX, y: outY };
}

// How a variable name is written into a formula: bare when the tokenizer reads
// it back as that one name, in backticks otherwise (src/expr/parse.js).
export function formulaName(name) {
    return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `\`${name}\``;
}

// A number as a formula literal, at full precision; negatives in parentheses
// so they can follow any operator.
export function formulaNumber(value) {
    const text = String(Number(value));
    return value < 0 ? `(${text})` : text;
}

/**
 * The fitted curve of one result as a derived-variable formula over the
 * file's own time column — the record a saved signal keeps, which the app
 * recomputes on reload and over a lazy file in SQL.
 *
 *   fit       ŷ(t′), mapped back through the file's gain/offset so that the
 *             new variable DISPLAYS as ŷ (the panel transform applies to it
 *             like to any other variable of the file)
 *   residual  y − ŷ, the same way
 *
 * `time` maps the stored time column to t′: t′ = (T − origin) / divisor.
 * Outside [lo, hi] (stored-time units) the value is NaN unless `extrapolate`:
 * 0·sqrt(min(T − lo, hi − T)) is 0 inside and NaN outside, in JavaScript and
 * in the SQL translation alike. Throws when the fit cannot be written.
 */
export function curveFitFormula(fit, { kind = 'fit', time, signal = null, gain = 1, yOffset = 0, sign = 1, extrapolate = false } = {}) {
    if (!fit || fit.status !== 'ok') throw new Error('no-fit');
    const n = formulaNumber;
    const T = formulaName(time.name);
    const tp = time.divisor === 1
        ? `(${T} - ${n(time.origin)})`
        : `((${T} - ${n(time.origin)}) / ${n(time.divisor)})`;
    // Euler's number as a literal: a file may have a variable called e.
    const E = String(Math.E);
    let expr;
    switch (fit.model) {
        case 'linear': expr = `${n(fit.b0)} + ${n(fit.b1)}*${tp}`; break;
        case 'quadratic': expr = `${n(fit.a)}*${tp}^2 + ${n(fit.b)}*${tp} + ${n(fit.c)}`; break;
        case 'power': expr = `${n(fit.a)}*${tp}^${n(fit.b)}`; break;
        case 'exponential': expr = `${n(fit.a)}*${E}^(${n(fit.b)}*${tp})`; break;
        case 'exponential-offset': expr = `${n(fit.a)}*${E}^(${n(fit.b)}*${tp}) + ${n(fit.c)}`; break;
        case 'first-order': expr = `${n(fit.K)}*(1 - ${E}^(${n(fit.alpha)}*${tp}))`; break;
        case 'first-order-offset': expr = `${n(fit.y0)} + ${n(fit.K)}*(1 - ${E}^(${n(fit.alpha)}*${tp}))`; break;
        default: throw new Error('no-fit');
    }
    const coefficients = ['a', 'b', 'c', 'b0', 'b1', 'K', 'alpha', 'y0']
        .filter(key => fit[key] !== undefined && fit[key] !== null && !Number.isNaN(fit[key]));
    if (coefficients.some(key => !Number.isFinite(fit[key]))) throw new Error('coefficient-overflow');
    const g = Number.isFinite(gain) && gain !== 0 ? gain : 1;
    const off = Number.isFinite(yOffset) ? yOffset : 0;
    let out;
    if (kind === 'residual') {
        if (!signal) throw new Error('no-signal');
        const y = sign < 0 ? `(-${formulaName(signal)})` : formulaName(signal);
        out = g === 1 ? `${y} - (${expr})` : `${y} - (${expr}) / ${n(g)}`;
    } else if (g === 1 && off === 0) {
        out = expr;
    } else {
        out = `((${expr}) - ${n(off)}) / ${n(g)}`;
    }
    if (!extrapolate) {
        const lo = n(time.lo);
        const hi = n(time.hi);
        out = `${out} + 0*sqrt(min(${T} - ${lo}, ${hi} - ${T}))`;
    }
    return out;
}
