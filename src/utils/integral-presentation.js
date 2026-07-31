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
        pieSplit: 0.62,
        timeSeriesHidden: false,
        optionsVisible: true,
        rangeFull: true,
        autoRangeLimited: false,
        x1: null,
        x2: null,
        method: 'trapezoidal',
        missingPolicy: 'zero',
        discardIncompleteEnds: false,
        extendLastSample: true,
        integralUnit: 'hour',
        unitOverride: '',
        scale: 'auto',
        orientation: 'vertical',
        showPie: false,
        showValues: true,
        sort: 'panel',
        quantity: 'total',
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
    const pieSplit = Number(raw.pieSplit);
    const policyOk = missingPolicies ? missingPolicies.has(raw.missingPolicy) : false;
    return {
        ...defaults,
        ...raw,
        layout: INTEGRAL_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        pieSplit: Number.isFinite(pieSplit) ? Math.max(0.2, Math.min(0.85, pieSplit)) : defaults.pieSplit,
        timeSeriesHidden: raw.timeSeriesHidden === true,
        optionsVisible: raw.optionsVisible !== false,
        // A session predating rangeFull that carries an explicit window keeps it.
        rangeFull: raw.rangeFull !== undefined ? !!raw.rangeFull : !(hasFinite(raw.x1) || hasFinite(raw.x2)),
        autoRangeLimited: raw.autoRangeLimited === true,
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
        method: INTEGRAL_METHODS.has(raw.method) ? raw.method : defaults.method,
        missingPolicy: policyOk ? raw.missingPolicy : defaults.missingPolicy,
        discardIncompleteEnds: raw.discardIncompleteEnds === true,
        extendLastSample: raw.extendLastSample !== false,
        integralUnit: INTEGRAL_UNITS.has(raw.integralUnit) ? raw.integralUnit : defaults.integralUnit,
        // Free text: the space of units is infinite, so it is trimmed and
        // capped rather than validated against a list that could not exist.
        unitOverride: String(raw.unitOverride ?? '').trim().slice(0, 24),
        scale: INTEGRAL_SCALES.has(raw.scale) ? raw.scale : defaults.scale,
        orientation: INTEGRAL_ORIENTATIONS.has(raw.orientation) ? raw.orientation : defaults.orientation,
        showPie: raw.showPie === true,
        showValues: raw.showValues !== false,
        sort: INTEGRAL_SORTS.has(raw.sort) ? raw.sort : defaults.sort,
        quantity: INTEGRAL_QUANTITIES.has(raw.quantity) ? raw.quantity : defaults.quantity,
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

// Stands in for a unit the file never declared. It is NOT the same as "no
// unit": a PyPSA netCDF simply carries no `units` attribute, so writing the
// integral of an undeclared signal as "h" would claim the signal was
// dimensionless and turn a total into what looks like a duration. The brackets
// also keep it out of the prefix arithmetic below, so it can never become "kh".
export const UNKNOWN_UNIT = '[?]';

// The unit the totals carry: the signal's unit times the chosen time unit. Same
// spelling the calendar heatmap already uses for its per-cell integral, so a
// power in MW reads MW·h in both places.
export function integralResultUnit(unit, integralUnit, timeKind, samplesLabel = 'samples') {
    const base = unit || UNKNOWN_UNIT;
    if (timeKind === 'index') return `${base}·${samplesLabel}`;
    return `${base}·${integralUnit === 'second' ? 's' : 'h'}`;
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

// Units that take an SI prefix, by name rather than by shape.
//
// The rule used to be "one to three letters", which is a guess about what a
// unit looks like — and it guessed wrong in both directions: `pu` became
// "kpu·h" and `°C` became "k°C·h", neither of which is a thing, while anything
// longer was refused whatever it was. Knowing the bases instead makes the
// default SAFE: what is not on this list keeps its spelling and shows the
// decade separately, which is never wrong, only less pretty.
//
// The list is the SI set plus the electrical vocabulary the app is aimed at.
// It is meant to grow when a real unit is missing, not to be exhaustive.
const PREFIXABLE_BASES = new Set([
    // electrical
    'W', 'Wh', 'VA', 'VAh', 'var', 'VAr', 'VAR', 'varh', 'V', 'A', 'Ah', 'Ω', 'ohm', 'F', 'H', 'S', 'C', 'Wb', 'Wp',
    // mechanical, thermal and the rest of SI
    'J', 'N', 'Pa', 'Hz', 'K', 'g', 't', 'm', 'm2', 'm3', 'l', 'L', 's', 'mol', 'cd', 'lm', 'lx', 'Bq', 'Gy', 'Sv',
    // data
    'b', 'B', 'bps',
]);

// The comparison ignores case only for a miss, never for a hit: `mm` is
// millimetres and `Mm` is megametres, and a unit table that conflated them
// would be worse than one that refuses.
function unitAcceptsPrefix(rest) {
    return PREFIXABLE_BASES.has(String(rest).split('·')[0]);
}

/**
 * What the scale dropdown will be able to do with a unit, for the panel to show
 * before the user commits to it.
 *
 * Typing a unit is free text — the space of units is infinite — so the app
 * cannot validate it. What it CAN do is say what it understood: `MW` folds to
 * kW·h / GW·h / TW·h, `pu` does not fold and gets ×10ⁿ instead. Seeing that is
 * what replaces a dropdown of impossible completeness.
 *
 * @returns {{ prefixable: boolean, examples: string[] }}
 */
export function describeUnitScaling(unit, integralUnit = 'hour', timeKind = 'datetime', samplesLabel = 'samples') {
    const result = integralResultUnit(unit, integralUnit, timeKind, samplesLabel);
    const examples = [];
    for (const exponent of [-3, 3, 6]) {
        const { label, residual } = scaleUnitLabel(result, exponent);
        if (!residual && label && !examples.includes(label)) examples.push(label);
    }
    return { prefixable: examples.length > 0, examples, resultUnit: result };
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

/**
 * A duration the kernel counted in abscissa units, converted to the unit the
 * formatter should render it in.
 *
 * The kernel counts in x-units, so a signal sampled in seconds reported "20"
 * while the same 20 seconds on a datetime axis read "20 s": the number was right
 * and said nothing. Converting through the axis unit first lets both axes use
 * the one seconds ladder. An axis whose unit was only ASSUMED converts anyway —
 * it is the same assumption that already gave the total its MW·h, and the panel
 * announces it — while an index axis has no unit at all and keeps its samples.
 *
 * @returns {{ seconds: number, kind: 'datetime'|'index' }}
 */
export function axisDuration(base, timeKind, rawTime) {
    if (timeKind === 'index') return { seconds: rawTime, kind: 'index' };
    const secondsPerUnit = Number(base?.secondsPerUnit);
    const factor = timeKind === 'datetime' || !Number.isFinite(secondsPerUnit) ? 1 : secondsPerUnit;
    return { seconds: rawTime * factor, kind: 'datetime' };
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

// What the bars plot. All three come from the same pair of numbers — the total
// and the duration actually integrated — so switching between them can never
// make two signals disagree about the underlying computation.
//
//   total    the definite integral, e.g. MW·h
//   per-day  that total divided by the integrated duration in days, MW·h/d.
//            The reading a grid operator compares across months of different
//            length, or across signals that lost days to a discard policy.
//   mean     the total divided by the integrated duration, back in the signal's
//            OWN unit (MW). The flat level that would produce the same area —
//            which is why a mean is only honest next to its coverage.
export const INTEGRAL_QUANTITIES = new Set(['total', 'per-day', 'mean']);

const SECONDS_PER_DAY = 86400;

// The unit of each quantity. `mean` drops back to the signal's own unit because
// dividing an area by the time it spans undoes the time factor exactly.
export function integralQuantityUnit(unit, quantity, integralUnit, timeKind, samplesLabel = 'samples') {
    const total = integralResultUnit(unit, integralUnit, timeKind, samplesLabel);
    // The mean drops back to the signal's own unit — undeclared included, since
    // "200.5" with nothing after it is the same silence as "308.2 h".
    if (quantity === 'mean') return unit || UNKNOWN_UNIT;
    if (quantity === 'per-day') return `${total}/d`;
    return total;
}

/**
 * Turn the computed models into everything the four consumers need.
 *
 * A model is `{ name, unit, base, result }` where `result` is a
 * computeDefiniteIntegral() return value and `base` a timeBaseForAxis() one.
 *
 * Every row carries all three quantities (`value`, `perDay`, `mean`) whatever
 * the panel is plotting, because the summary and the export show them together
 * — a total without its mean hides how much time it is spread over.
 *
 * `rows[].scaled` is the PLOTTED quantity after the shared exponent; exports
 * read the unscaled fields. A spreadsheet has no use for a display prefix.
 */
export function buildIntegralPresentation(models, state, options = {}) {
    const quantity = INTEGRAL_QUANTITIES.has(state.quantity) ? state.quantity : 'total';
    const ready = models.filter(model => model?.result?.ok);
    const rows = ready.map(model => {
        // The kernel answers in value-unit × abscissa-unit. Two conversions get
        // it to the requested reading: the axis unit to seconds, then seconds to
        // hours when asked. An index axis has neither, so it stays per-sample.
        const isIndex = model.base?.kind === 'index';
        const secondsPerUnit = isIndex ? 1 : (model.base?.secondsPerUnit ?? 1);
        const seconds = model.result.value * secondsPerUnit;
        const value = !isIndex && state.integralUnit === 'hour' ? seconds / 3600 : seconds;
        // Coverage in the abscissa's own units; converted to seconds the same
        // way, so the division cancels the time factor exactly rather than
        // approximately.
        const coveredSeconds = (model.result.coveredTime || 0) * secondsPerUnit;
        const mean = coveredSeconds > 0 ? seconds / coveredSeconds : null;
        // Per day only means something on a calendar axis; elsewhere there is
        // no day to divide by and inventing one would be a fiction.
        const perDay = (!isIndex && coveredSeconds > 0 && model.result.timeKind === 'datetime')
            ? value / (coveredSeconds / SECONDS_PER_DAY)
            : null;
        return { model, value, mean, perDay, coveredSeconds };
    });

    const timeKind = ready[0]?.result?.timeKind || 'datetime';
    // A unit the user typed replaces whatever the files said, for every signal
    // in the panel. Comparing totals only makes sense in one unit anyway — the
    // panel already refuses to compare two — so declaring one is declaring all
    // of them, and the mixed/undeclared warnings give way to "you said so".
    const override = String(state.unitOverride || '').trim();
    const units = new Set(ready.map(model => model.unit).filter(Boolean));
    const fileMixedUnits = units.size > 1;
    const mixedUnits = !override && fileMixedUnits;
    const baseUnit = override || (fileMixedUnits ? '' : ([...units][0] || ''));
    const declaredUnit = !!override;
    const undeclaredUnits = !override && units.size === 0;
    const resultUnit = integralResultUnit(baseUnit, state.integralUnit, timeKind, options.samplesLabel);
    // Same marker the total uses: a bare "200.5" is the same silence as "308.2 h".
    const meanUnit = baseUnit || UNKNOWN_UNIT;
    const perDayUnit = `${resultUnit}/d`;

    // The plotted number per row, and the unit that goes with it.
    const plotted = (row) => (quantity === 'mean' ? row.mean : quantity === 'per-day' ? row.perDay : row.value);
    const quantityUnit = integralQuantityUnit(baseUnit, quantity, state.integralUnit, timeKind, options.samplesLabel);

    const maxAbs = rows.reduce((max, row) => {
        const candidate = plotted(row);
        return Number.isFinite(candidate) ? Math.max(max, Math.abs(candidate)) : max;
    }, 0);
    const exponent = state.scale === 'auto'
        ? autoExponent(maxAbs)
        : (INTEGRAL_SCALE_EXPONENTS[state.scale] ?? 0);
    const factor = 10 ** exponent;
    const { label, residual } = scaleUnitLabel(mixedUnits ? '' : quantityUnit, exponent);
    // Mixed units get NO axis unit: picking one of them would be a lie, and
    // inventing a neutral one would be worse.
    const axisUnit = mixedUnits
        ? ''
        : residual
            ? `${quantityUnit} ×10${superscript(residual)}`
            : label;

    const ordered = rows.slice();
    const key = (row) => (Number.isFinite(plotted(row)) ? plotted(row) : -Infinity);
    if (state.sort === 'desc') ordered.sort((a, b) => key(b) - key(a));
    else if (state.sort === 'asc') ordered.sort((a, b) => key(a) - key(b));

    return {
        state,
        quantity,
        rows: ordered.map(row => ({
            ...row,
            // The unit each row is actually shown in, so the summary and the
            // export never read model.unit again and miss the override.
            unit: override || row.model.unit,
            plotted: plotted(row),
            scaled: Number.isFinite(plotted(row)) ? plotted(row) / factor : null,
        })),
        exponent,
        factor,
        axisUnit,
        resultUnit,
        meanUnit,
        perDayUnit,
        quantityUnit,
        mixedUnits,
        // Whether the unit was typed by the user rather than read from a file.
        // The panel says so instead of the mixed/undeclared warnings, and the
        // export records it — a total is not auditable without knowing where
        // its unit came from.
        declaredUnit,
        baseUnit,
        undeclaredUnits,
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
    const headers = ['signal', 'file', 'value_unit', 'value_unit_source', 'integral', 'integral_unit',
        'per_day', 'per_day_unit', 'mean', 'mean_unit',
        'method', 'missing_policy', 'sample_reading',
        'range_start', 'range_end', 'covered', 'uncovered', 'discarded_days', 'days_in_range', 'samples'];
    const isCalendar = view.timeKind === 'datetime';
    const stamp = (value) => (isCalendar && Number.isFinite(value) ? new Date(value).toISOString() : value);
    const rows = view.rows.map(({ model, unit, value, perDay, mean }) => {
        const result = model.result;
        const total = integralResultUnit(unit, view.state.integralUnit, result.timeKind, options.samplesLabel);
        return [
            model.name,
            fileNameFor(model.trace?.fileId),
            unit,
            // Where that unit came from. A total is not auditable without it:
            // "MW·h" read from the file and "MW·h" typed into the panel are the
            // same string and very different claims.
            unit ? (view.declaredUnit ? 'declared' : 'file') : 'none',
            value,
            total,
            // All three quantities go out together whatever the panel is
            // plotting: which one was on screen is a viewing choice, not a
            // property of the data.
            perDay ?? '',
            perDay == null ? '' : `${total}/d`,
            mean ?? '',
            mean == null ? '' : (unit || ''),
            result.method,
            result.missingPolicy,
            // Points or periods: a total is not auditable without it.
            result.extendLastSample ? 'periods' : 'points',
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
    // Judged on the PLOTTED quantity: per-day and mean are the total divided by
    // a positive duration, so the signs agree, but reading the plotted value
    // keeps the gate honest if that ever stops being true.
    const positive = view.rows.some(row => row.plotted > 0);
    const negative = view.rows.some(row => row.plotted < 0);
    return !(positive && negative);
}
