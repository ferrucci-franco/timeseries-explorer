// Presentation layer for the Integral analysis: everything between "the kernel
// returned a number" and "Plotly draws a bar".
//
// Pure and DOM-free, like utils/temporal-profile.js. The bar chart, the pie, the
// summary table and the CSV export all read the SAME object built here, so the
// four cannot disagree about a value, a unit or an order — which they would if
// each formatted the models itself.

export const INTEGRAL_LAYOUTS = new Set(['horizontal', 'vertical']);
export const INTEGRAL_ORIENTATIONS = new Set(['vertical', 'horizontal']);
export const INTEGRAL_UNITS = new Set(['hour', 'second']);
export const INTEGRAL_SORTS = new Set(['panel', 'desc', 'asc']);
export const INTEGRAL_METHODS = new Set(['trapezoidal', 'rectangular']);

// 'auto' picks ONE exponent for the whole panel from the largest total. A
// per-signal prefix would make the bars incomparable, which is the single thing
// a bar chart must never do.
export const INTEGRAL_SCALE_EXPONENTS = { '1': 0, k: 3, M: 6, G: 9, T: 12, m: -3, u: -6 };
export const INTEGRAL_SCALES = new Set(['auto', ...Object.keys(INTEGRAL_SCALE_EXPONENTS)]);

// Only the unambiguous large prefixes are recognised INSIDE a unit. Stripping a
// lowercase 'm' would turn metres into millis and minutes into milli-inches;
// k/M/G/T are never units on their own, so folding them is safe.
const UNIT_PREFIX_POWERS = { k: 3, M: 6, G: 9, T: 12 };
const POWER_TO_PREFIX = { '-6': 'µ', '-3': 'm', 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T', 15: 'P' };

// Seconds per unit of a numeric time axis. A unit absent from here cannot be
// converted, and the panel says "seconds assumed" instead of guessing quietly.
export const TIME_UNIT_SECONDS = {
    ps: 1e-12, ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: 1e-3,
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
};

export function defaultIntegralState() {
    return {
        layout: 'vertical',
        split: 0.5,
        timeSeriesHidden: false,
        optionsVisible: true,
        rangeFull: true,
        x1: null,
        x2: null,
        method: 'trapezoidal',
        missingPolicy: 'zero',
        discardIncompleteEnds: false,
        integralUnit: 'hour',
        scale: 'auto',
        orientation: 'vertical',
        showPie: false,
        showValues: true,
        sort: 'panel',
        warnings: [],
    };
}

function finiteOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function hasFinite(value) {
    return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

// `missingPolicies` is injected rather than imported so this module stays
// independent of the kernel; the caller passes the kernel's own set.
export function normalizeIntegralState(raw = {}, missingPolicies) {
    const defaults = defaultIntegralState();
    const split = Number(raw.split);
    const policyOk = missingPolicies ? missingPolicies.has(raw.missingPolicy) : false;
    return {
        ...defaults,
        ...raw,
        layout: INTEGRAL_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        timeSeriesHidden: raw.timeSeriesHidden === true,
        optionsVisible: raw.optionsVisible !== false,
        // A session predating rangeFull that carries an explicit window keeps it.
        rangeFull: raw.rangeFull !== undefined ? !!raw.rangeFull : !(hasFinite(raw.x1) || hasFinite(raw.x2)),
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
        method: INTEGRAL_METHODS.has(raw.method) ? raw.method : defaults.method,
        missingPolicy: policyOk ? raw.missingPolicy : defaults.missingPolicy,
        discardIncompleteEnds: raw.discardIncompleteEnds === true,
        integralUnit: INTEGRAL_UNITS.has(raw.integralUnit) ? raw.integralUnit : defaults.integralUnit,
        scale: INTEGRAL_SCALES.has(raw.scale) ? raw.scale : defaults.scale,
        orientation: INTEGRAL_ORIENTATIONS.has(raw.orientation) ? raw.orientation : defaults.orientation,
        showPie: raw.showPie === true,
        showValues: raw.showValues !== false,
        sort: INTEGRAL_SORTS.has(raw.sort) ? raw.sort : defaults.sort,
        warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 20) : [],
    };
}

// Seconds per abscissa unit, and whether that conversion is known or assumed.
// `assumed` is what raises the panel warning: an integral labelled MW·h over an
// axis whose unit nobody declared is a guess and should not look authoritative.
export function timeBaseForAxis(kind, axisUnit) {
    if (kind === 'datetime' || kind === 'index') return { kind, secondsPerUnit: 1, assumed: false };
    const unit = String(axisUnit || '').trim();
    if (unit === 'duration' || unit === 'datetime') return { kind, secondsPerUnit: 1, assumed: false, axisUnit: unit };
    const factor = TIME_UNIT_SECONDS[unit] ?? TIME_UNIT_SECONDS[unit.toLowerCase()];
    if (Number.isFinite(factor)) return { kind, secondsPerUnit: factor, assumed: false, axisUnit: unit };
    return { kind, secondsPerUnit: 1, assumed: true, axisUnit: unit };
}

// The unit the totals carry: the signal's unit times the chosen time unit. Same
// spelling the calendar heatmap already uses for its per-cell integral, so a
// power in MW reads MW·h in both places.
export function integralResultUnit(unit, integralUnit, timeKind, samplesLabel = 'samples') {
    if (timeKind === 'index') return unit ? `${unit}·${samplesLabel}` : samplesLabel;
    const suffix = integralUnit === 'second' ? 's' : 'h';
    return unit ? `${unit}·${suffix}` : suffix;
}

export function splitUnitPrefix(unit) {
    const raw = String(unit || '');
    const head = raw[0];
    const rest = raw.slice(1);
    if (rest && Object.prototype.hasOwnProperty.call(UNIT_PREFIX_POWERS, head)) {
        return { power: UNIT_PREFIX_POWERS[head], rest };
    }
    return { power: 0, rest: raw };
}

// A unit can absorb an SI prefix only if its leading token looks like a symbol
// — one to three letters, as W, MW, VAr or EUR do. `p.u.` does not, and writing
// "kp.u.·h" would be worse than showing the decade outright.
const PREFIXABLE_HEAD = /^[A-Za-zµΩ°]{1,3}$/;

function unitAcceptsPrefix(rest) {
    return PREFIXABLE_HEAD.test(String(rest).split('·')[0]);
}

// Fold `exponent` into `unit`: MW·h scaled by 10³ must read GW·h, never GMW·h.
// When the combination has no SI spelling, the leftover decade comes back as
// `residual` so the caller can state it rather than hide it.
export function scaleUnitLabel(unit, exponent) {
    if (!exponent) return { label: unit || '', residual: 0 };
    if (!unit) return { label: '', residual: exponent };
    const { power, rest } = splitUnitPrefix(unit);
    const prefix = POWER_TO_PREFIX[String(power + exponent)];
    if (prefix === undefined || !unitAcceptsPrefix(rest)) return { label: unit, residual: exponent };
    return { label: `${prefix}${rest}`, residual: 0 };
}

export function autoExponent(maxAbs) {
    if (!Number.isFinite(maxAbs) || maxAbs === 0) return 0;
    return Math.floor(Math.floor(Math.log10(Math.abs(maxAbs))) / 3) * 3;
}

export function superscript(value) {
    const digits = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    return String(value).split('').map(char => digits[char] ?? char).join('');
}

export function formatIntegralNumber(value, digits = 4, locale = 'en') {
    if (!Number.isFinite(value)) return '—';
    if (value === 0) return '0';
    const abs = Math.abs(value);
    if (abs >= 1e6 || abs < 1e-4) return value.toExponential(Math.max(0, digits - 1));
    return Number(value.toPrecision(digits)).toLocaleString(locale);
}

// Durations are reported in the abscissa's own unit. On a calendar axis that is
// seconds and reads naturally as hours or days; on a numeric axis it is
// x-units, and calling those hours would invent a calendar.
export function formatIntegralDuration(seconds, timeKind, labels = {}) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0';
    if (timeKind === 'index') return `${formatIntegralNumber(seconds, 4, labels.locale)} ${labels.samples || 'samples'}`;
    if (timeKind !== 'datetime') return formatIntegralNumber(seconds, 4, labels.locale);
    if (seconds >= 86400) return `${Number((seconds / 86400).toFixed(2))} d`;
    if (seconds >= 3600) return `${Number((seconds / 3600).toFixed(2))} h`;
    if (seconds >= 60) return `${Number((seconds / 60).toFixed(1))} min`;
    return `${Number(seconds.toFixed(1))} s`;
}

/**
 * Turn the computed models into everything the four consumers need.
 *
 * A model is `{ name, unit, base, result }` where `result` is a
 * computeDefiniteIntegral() return value and `base` a timeBaseForAxis() one.
 *
 * @returns {{ rows, exponent, factor, axisUnit, resultUnit, mixedUnits, timeKind }}
 *   `rows[].value` is the true total in the chosen unit; `rows[].scaled` is what
 *   gets plotted. Exports read `value`, charts read `scaled` — a spreadsheet has
 *   no use for the panel's display prefix.
 */
export function buildIntegralPresentation(models, state, options = {}) {
    const ready = models.filter(model => model?.result?.ok);
    const rows = ready.map(model => {
        // The kernel answers in value-unit × abscissa-unit. Two conversions get
        // it to the requested reading: the axis unit to seconds, then seconds to
        // hours when asked. An index axis has neither, so it stays per-sample.
        const isIndex = model.base?.kind === 'index';
        const seconds = isIndex ? model.result.value : model.result.value * (model.base?.secondsPerUnit ?? 1);
        const value = !isIndex && state.integralUnit === 'hour' ? seconds / 3600 : seconds;
        return { model, value };
    });

    const timeKind = ready[0]?.result?.timeKind || 'datetime';
    const units = new Set(ready.map(model => model.unit).filter(Boolean));
    const mixedUnits = units.size > 1;
    const baseUnit = mixedUnits ? '' : ([...units][0] || '');
    const resultUnit = integralResultUnit(baseUnit, state.integralUnit, timeKind, options.samplesLabel);

    const maxAbs = rows.reduce((max, row) => Math.max(max, Math.abs(row.value)), 0);
    const exponent = state.scale === 'auto'
        ? autoExponent(maxAbs)
        : (INTEGRAL_SCALE_EXPONENTS[state.scale] ?? 0);
    const factor = 10 ** exponent;
    const { label, residual } = scaleUnitLabel(mixedUnits ? '' : resultUnit, exponent);
    // Mixed units get NO axis unit: picking one of them would be a lie, and
    // inventing a neutral one would be worse.
    const axisUnit = mixedUnits
        ? ''
        : residual
            ? `${resultUnit} ×10${superscript(residual)}`
            : label;

    const ordered = rows.slice();
    if (state.sort === 'desc') ordered.sort((a, b) => b.value - a.value);
    else if (state.sort === 'asc') ordered.sort((a, b) => a.value - b.value);

    return {
        state,
        rows: ordered.map(row => ({ ...row, scaled: row.value / factor })),
        exponent,
        factor,
        axisUnit,
        resultUnit,
        mixedUnits,
        timeKind,
    };
}

/**
 * Rows for the CSV export: one per signal, because the totals ARE the analysis
 * and the raw series would be the wrong table.
 *
 * The UNSCALED value is exported with its unit spelt out — the panel's display
 * prefix exists for reading a chart, not for a spreadsheet — together with the
 * policy and the coverage, so a total can be audited away from the app.
 */
export function buildIntegralExportTable(view, options = {}) {
    const fileNameFor = options.fileNameFor || (() => '');
    const headers = ['signal', 'file', 'value_unit', 'integral', 'integral_unit', 'method', 'missing_policy',
        'range_start', 'range_end', 'covered', 'uncovered', 'discarded_days', 'days_in_range', 'samples'];
    const isCalendar = view.timeKind === 'datetime';
    const stamp = (value) => (isCalendar && Number.isFinite(value) ? new Date(value).toISOString() : value);
    const rows = view.rows.map(({ model, value }) => {
        const result = model.result;
        return [
            model.name,
            fileNameFor(model.trace?.fileId),
            model.unit,
            value,
            integralResultUnit(model.unit, view.state.integralUnit, result.timeKind, options.samplesLabel),
            result.method,
            result.missingPolicy,
            stamp(result.rangeStart),
            stamp(result.rangeEnd),
            result.coveredTime,
            result.uncoveredTime,
            result.discardedDayCount,
            result.dayCount,
            result.sampleCount,
        ];
    });
    return { headers, rows };
}

// A pie is only honest when every slice is a share of one whole: one unit, one
// sign. Power-grid series routinely break the second condition (a storage unit
// charges and discharges), so this is a real gate, not a formality.
export function integralPieAllowed(view) {
    if (!view?.state?.showPie || !view.rows.length) return false;
    if (view.mixedUnits) return false;
    const positive = view.rows.some(row => row.value > 0);
    const negative = view.rows.some(row => row.value < 0);
    return !(positive && negative);
}
