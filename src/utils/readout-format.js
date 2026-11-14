// How a number reads inside a hover box (the "readout").
//
// The hover boxes used to print with whatever each one had been written with:
// `.6g` in the spectrum, `.4g` on a time series, `toPrecision(5)` or `(6)` in
// others. That gave "Period = 0.000627379 s" next to "Amplitude = 0.00721255",
// "1.234e+4" for sample 12345, "1.0000" for a one, and — for the toPrecision
// ones — a decimal point even where Settings asks for a comma. A hover is read
// at a glance, so every one of them now goes through this one rule:
//
//   - four significant digits for a value, trailing zeros dropped;
//   - plain decimals between 0.01 and 10 000, where a number already reads
//     well ("0.1234 V", "1593.9 Hz");
//   - an SI prefix outside that band, never an exponent: 627.4 µs, 7.213 mV,
//     12.35 kPa. The prefix joins the unit when the unit takes one; a unit that
//     does not (°C, %, dB, or one that already carries a prefix, like kg) gets
//     "×10⁻³" instead, because "1.2 mkg" or "1.2 m°C" is wrong;
//   - an abscissa (time, frequency) keeps the digits its resolution needs, so
//     two neighbouring samples or bins never print the same string.
//
// Pure: no DOM, no i18n, no Plotly. The caller passes the resolved number
// format and escapes the result for HTML.

import { defaultNumberFormat } from './number-format.js';

export const READOUT_DIGITS = 4;
export const READOUT_MAX_DIGITS = 15;
/** The band in which a value is written as a plain decimal, |v| in [min, max). */
export const READOUT_PLAIN_MIN = 0.01;
export const READOUT_PLAIN_MAX = 10000;

const PREFIXES = {
    '-24': 'y', '-21': 'z', '-18': 'a', '-15': 'f', '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm',
    3: 'k', 6: 'M', 9: 'G', 12: 'T', 15: 'P', 18: 'E', 21: 'Z', 24: 'Y',
};

// Units an SI prefix may be glued to. Deliberately a list rather than a rule:
// `min`, `h`, `d`, `°C`, `%`, `dB`, `kg`, `ms` all look like letters and none
// of them takes a prefix. A compound unit takes one when its first symbol does
// ("m/s" → "mm/s", "V/√Hz" → "µV/√Hz").
const PREFIXABLE_UNITS = new Set([
    's', 'Hz', 'V', 'A', 'W', 'Ω', 'F', 'H', 'T', 'Wb', 'S', 'J', 'N', 'Pa', 'C',
    'm', 'g', 'L', 'l', 'mol', 'cd', 'K', 'eV', 'bar', 'VA', 'var', 'VAr', 'Wh', 'Ah',
    'lm', 'lx', 'Bq', 'Gy', 'Sv', 'kat', 'rad', 'sr', 'Np', 'B', 'b',
]);

const SUPERSCRIPT = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const superscript = exponent => String(exponent).replace(/[-\d]/g, ch => SUPERSCRIPT[ch]);

// Matches a plotly-drawn tick or hover: U+2212, not the hyphen.
const MINUS = '−';

/** Whether an SI prefix may be written in front of `unit`. */
export function unitTakesPrefix(unit) {
    const text = String(unit ?? '').trim();
    if (!text) return true;
    const head = /^[A-Za-zΩ]+/.exec(text)?.[0];
    if (!head) return false;
    const rest = text.slice(head.length);
    if (rest && !/^[/·*⋅^²³⁻¹√ ]/.test(rest)) return false;
    return PREFIXABLE_UNITS.has(head);
}

/**
 * Significant digits for one value of an axis whose samples sit `resolution`
 * apart: the digits down to the step, plus one, never fewer than four.
 */
export function readoutDigitsForResolution(value, resolution, minimum = READOUT_DIGITS) {
    const magnitude = Math.abs(Number(value));
    const step = Math.abs(Number(resolution));
    if (!(magnitude > 0) || !(step > 0) || !Number.isFinite(magnitude / step)) return minimum;
    const digits = Math.ceil(Math.log10(magnitude / step)) + 1;
    return Math.min(READOUT_MAX_DIGITS, Math.max(minimum, digits));
}


// Grouping is left out on purpose: a readout never has more than four integer
// figures, and "1,594" next to a Spanish decimal comma is a trap. What is left
// of punctuation is the decimal mark and the minus sign. `plain` is a
// JavaScript number string with no exponent, so both are one replace each.
const punctuate = (plain, decimal) => {
    const text = decimal === '.' ? plain : plain.replace('.', decimal);
    return text.charCodeAt(0) === 45 ? MINUS + text.slice(1) : text;
};

/**
 * A formatter with the options settled once, for a whole array of values: the
 * unit's check and the format lookup are not repeated per point.
 *
 * @param {object} [options]
 * @param {string} [options.unit] the unit, unescaped; '' for none
 * @param {number} [options.digits] significant digits (default 4)
 * @param {number} [options.resolution] the axis step, for an abscissa
 * @param {{decimal: string}} [options.format] the resolved number format
 * @returns {(value: number) => string} plain text, to be escaped by an HTML caller
 */
export function readoutFormatter(options = {}) {
    const { unit = '', resolution = null, format = defaultNumberFormat() } = options;
    const unitText = String(unit ?? '').trim();
    const unitTail = unitText ? ` ${unitText}` : '';
    const prefixed = unitTakesPrefix(unitText);
    const decimal = format?.decimal || '.';
    const baseDigits = Math.min(READOUT_MAX_DIGITS, Math.max(1, Math.round(options.digits ?? READOUT_DIGITS)));
    const step = Number(resolution) > 0 ? Number(resolution) : 0;

    return (value) => {
        if (value === null || value === undefined || value === '') return '—';
        const number = Number(value);
        if (Number.isNaN(number)) return '—';
        if (number === Infinity) return '∞';
        if (number === -Infinity) return `${MINUS}∞`;
        if (number === 0) return `0${unitTail}`;

        const digits = step ? readoutDigitsForResolution(number, step, baseDigits) : baseDigits;
        const magnitude = Math.abs(number);
        if (magnitude >= READOUT_PLAIN_MIN && magnitude < READOUT_PLAIN_MAX) {
            const rounded = Number(number.toPrecision(digits));
            // 9999.96 rounds to 10000, which belongs to the prefixed side.
            if (Math.abs(rounded) < READOUT_PLAIN_MAX) return punctuate(String(rounded), decimal) + unitTail;
        }

        let exponent = Math.floor(Math.log10(magnitude) / 3) * 3;
        let mantissa = Number((exponent < 0 ? number * 10 ** -exponent : number / 10 ** exponent).toPrecision(digits));
        // 999.96 µ rounds to 1000 µ, which is 1 m.
        if (Math.abs(mantissa) >= 1000) {
            exponent += 3;
            mantissa = Number((exponent < 0 ? number * 10 ** -exponent : number / 10 ** exponent).toPrecision(digits));
        }
        const mantissaText = punctuate(String(mantissa), decimal);
        const prefix = PREFIXES[exponent];
        if (prefix !== undefined && prefixed) {
            const tail = prefix + unitText;
            return tail ? `${mantissaText} ${tail}` : mantissaText;
        }
        return `${mantissaText}×10${superscript(exponent)}${unitTail}`;
    };
}

/**
 * One value, read the way every hover box reads it. See the top of the file.
 * Same options as `readoutFormatter`.
 */
export function formatReadout(value, options = {}) {
    return readoutFormatter(options)(value);
}

/**
 * A readout for many values at once, the shape a Plotly `customdata` or
 * `hovertext` array takes.
 */
export function formatReadouts(values, options = {}) {
    const format = readoutFormatter(options);
    const length = values?.length || 0;
    const out = new Array(length);
    for (let i = 0; i < length; i++) out[i] = format(values[i]);
    return out;
}
