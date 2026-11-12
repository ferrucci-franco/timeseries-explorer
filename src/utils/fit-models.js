// The fit models both Curve Fit analyses offer (the 2D pair fit and the
// time-series fit), how each is named in the menus, and how a result is
// written as an equation. Pure: no DOM, no i18n lookups (keys only), so the
// two drawers and the CSV exports cannot disagree about a model.

// In menu order. `key` is the i18n key of the menu label.
export const FIT_MODEL_OPTIONS = [
    { id: 'none', key: 'phase2dFitOff' },
    { id: 'linear', key: 'phase2dFitLinear' },
    { id: 'quadratic', key: 'phase2dFitQuadratic' },
    { id: 'power', key: 'phase2dFitPower' },
    { id: 'exponential', key: 'fitModelExponential' },
    { id: 'exponential-offset', key: 'fitModelExponentialOffset' },
    { id: 'first-order', key: 'fitModelFirstOrder' },
    { id: 'first-order-offset', key: 'fitModelFirstOrderOffset' },
];

export const FIT_MODELS = new Set(FIT_MODEL_OPTIONS.map(option => option.id));

// The short word a fit curve's legend entry and hover carry.
export const FIT_MODEL_SHORT_KEYS = {
    linear: 'phase2dFitLinear',
    quadratic: 'phase2dFitQuadratic',
    power: 'fitModelPowerShort',
    exponential: 'fitModelExponential',
    'exponential-offset': 'fitModelExponential',
    'first-order': 'fitModelFirstOrder',
    'first-order-offset': 'fitModelFirstOrder',
};

// Five significant digits, switching to exponent form where a fixed one would
// read as 0 or run on.
export function formatFitCoefficient(v) {
    if (!Number.isFinite(v)) return 'N/A';
    const a = Math.abs(v);
    return (a !== 0 && (a < 1e-3 || a >= 1e5)) ? v.toExponential(4) : String(Number(v.toPrecision(5)));
}

/**
 * The generic formula of a fit and its resolved coefficients, written in the
 * independent variable `x` (the 2D fit) or `t′` (the time-series fit, whose
 * time is shifted to the start of its range). Returns
 * { generic: 'y = a·x + b', coeffs: [['a', '2.5'], …] } or null.
 * A decaying exponential also lists its time constant τ = −1/rate.
 */
export function fitEquationParts(fit, variable = 'x', format = formatFitCoefficient) {
    if (!fit || fit.status !== 'ok') return null;
    const v = variable;
    const g = format;
    const tau = Number.isFinite(fit.timeConstant) ? [['τ', g(fit.timeConstant)]] : [];
    switch (fit.model) {
        case 'linear':
            return { generic: `y = a·${v} + b`, coeffs: [['a', g(fit.b1)], ['b', g(fit.b0)]] };
        case 'quadratic':
            return { generic: `y = a·${v}² + b·${v} + c`, coeffs: [['a', g(fit.a)], ['b', g(fit.b)], ['c', g(fit.c)]] };
        case 'power':
            return { generic: `y = a·${v}ᵇ`, coeffs: [['a', g(fit.a)], ['b', g(fit.b)]] };
        case 'exponential':
            return { generic: `y = a·e^(b·${v})`, coeffs: [['a', g(fit.a)], ['b', g(fit.b)], ...tau] };
        case 'exponential-offset':
            return { generic: `y = a·e^(b·${v}) + c`, coeffs: [['a', g(fit.a)], ['b', g(fit.b)], ['c', g(fit.c)], ...tau] };
        case 'first-order':
            return { generic: `y = K·(1 − e^(α·${v}))`, coeffs: [['K', g(fit.K)], ['α', g(fit.alpha)], ...tau] };
        case 'first-order-offset':
            return { generic: `y = y₀ + K·(1 − e^(α·${v}))`, coeffs: [['y₀', g(fit.y0)], ['K', g(fit.K)], ['α', g(fit.alpha)], ...tau] };
        default:
            return null;
    }
}

// The coefficients a CSV summary row carries, one column per name, so every
// model's numbers land in columns of their own.
export const FIT_CSV_COEFFICIENTS = [
    ['linear_intercept', 'linear', 'b0'],
    ['linear_slope', 'linear', 'b1'],
    ['quadratic_a', 'quadratic', 'a'],
    ['quadratic_b', 'quadratic', 'b'],
    ['quadratic_c', 'quadratic', 'c'],
    ['power_a', 'power', 'a'],
    ['power_b', 'power', 'b'],
    ['exp_a', ['exponential', 'exponential-offset'], 'a'],
    ['exp_b', ['exponential', 'exponential-offset'], 'b'],
    ['exp_c', ['exponential-offset'], 'c'],
    ['first_order_K', ['first-order', 'first-order-offset'], 'K'],
    ['first_order_alpha', ['first-order', 'first-order-offset'], 'alpha'],
    ['first_order_y0', ['first-order-offset'], 'y0'],
    ['time_constant', ['exponential', 'exponential-offset', 'first-order', 'first-order-offset'], 'timeConstant'],
];

export function fitCsvCoefficient(model, models) {
    return Array.isArray(models) ? models.includes(model) : models === model;
}
