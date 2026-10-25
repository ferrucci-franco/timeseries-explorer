// How a number is punctuated on screen: which character separates the decimals
// and which groups the thousands.
//
// The app already chose both from the language the user picked, deliberately
// and not from the operating system (see i18n/index.js: a browser in English
// must not print "16,777,216" inside a Spanish sentence). That default stays.
// What this module adds is the ability to OVERRIDE either one, because the
// language convention and the convention a reader works in are not always the
// same: a Spanish-speaking engineer reading a report for an English-speaking
// client, a French convention wanted without the French interface, a shared
// screenshot that has to match a document.
//
// Both settings default to `auto`, which is exactly what the language does
// today — so nobody who never opens the setting sees anything change.
//
// Pure: no DOM, no i18n, no storage. The resolver turns a language plus the
// two choices into concrete characters, and everything downstream works with
// those, so no formatting site has to know about languages or settings again.
//
// NOT in scope, on purpose:
//   - the CSV export and anything else a machine reads back. A file with comma
//     decimals and comma delimiters is a broken file; exports stay raw.
//   - number input fields, which the browser parses by its own rules. Printing
//     a value in one convention into a field that only accepts another is how a
//     setting turns into lost input.

/** Decimal separator choices offered in Settings. `auto` follows the language. */
export const NUMBER_DECIMAL_CHOICES = Object.freeze({
    auto: null,
    dot: '.',
    comma: ',',
});

/**
 * Thousands separator choices. `auto` follows the language — including its own
 * rule about WHEN to group, which is not the same everywhere: Spanish and
 * Italian leave a four-digit number ungrouped (1311) and group from five
 * (13.110). Any explicit choice groups from four digits, because choosing a
 * separator is asking to see it.
 *
 * The space is U+202F (narrow no-break space), the one Intl itself emits for
 * French, so the choice looks native rather than like a typed blank that a
 * line break could split.
 */
export const NUMBER_GROUP_CHOICES = Object.freeze({
    auto: null,
    none: '',
    dot: '.',
    comma: ',',
    space: ' ',
    apostrophe: '’',
});

export const DEFAULT_NUMBER_FORMAT_SETTINGS = Object.freeze({
    decimalSeparator: 'auto',
    thousandsSeparator: 'auto',
});

const FALLBACK = Object.freeze({ decimal: '.', group: ',', groupFrom: 4 });

// What the language itself does, read from Intl rather than from a table of
// our own: the table would be one more thing to keep in step with the browser.
function languageConventions(language) {
    try {
        const formatter = new Intl.NumberFormat(language);
        const parts = formatter.formatToParts(12345.6);
        const decimal = parts.find(part => part.type === 'decimal')?.value ?? FALLBACK.decimal;
        const group = parts.find(part => part.type === 'group')?.value ?? '';
        // Does this language group a four-digit number, or only from five?
        const groupsFour = new Intl.NumberFormat(language)
            .formatToParts(1000).some(part => part.type === 'group');
        return { decimal, group, groupFrom: groupsFour ? 4 : 5 };
    } catch (_) {
        // An unknown language tag must not cost the caller its number.
        return { ...FALLBACK };
    }
}

/**
 * The language's conventions with the user's overrides applied.
 *
 * @param {string} language the app language ('en' | 'es' | 'fr' | 'it')
 * @param {{decimalSeparator?: string, thousandsSeparator?: string}} settings
 * @returns {{decimal: string, group: string, groupFrom: number}} `group` is ''
 *   when thousands are not separated, and `groupFrom` is the integer length at
 *   which grouping starts (Infinity when it never does).
 */
export function resolveNumberFormat(language = 'en', settings = {}) {
    const native = languageConventions(language);
    const decimalChoice = NUMBER_DECIMAL_CHOICES[settings.decimalSeparator];
    const groupChoice = NUMBER_GROUP_CHOICES[settings.thousandsSeparator];
    const decimal = decimalChoice ?? native.decimal;
    // `auto` keeps the language's own character AND its own rule about when to
    // group; an explicit character always groups from four digits.
    const explicitGroup = settings.thousandsSeparator !== undefined
        && settings.thousandsSeparator !== 'auto'
        && groupChoice !== undefined;
    const group = explicitGroup ? groupChoice : native.group;
    const groupFrom = explicitGroup ? 4 : native.groupFrom;
    // The two can never be the same character: "1.234.567.25" says nothing.
    // The decimal point is the one that must survive — a number without its
    // grouping is still readable, a number with an unidentifiable decimal is
    // not — so the grouping gives way.
    if (group && group === decimal) return { decimal, group: '', groupFrom: Infinity };
    return { decimal, group, groupFrom: group ? groupFrom : Infinity };
}

/** The format the app uses when nothing has been resolved yet. */
export function defaultNumberFormat() {
    return resolveNumberFormat('en', DEFAULT_NUMBER_FORMAT_SETTINGS);
}

// Canonical digits: a plain JavaScript number string, '.' for the decimal and
// no grouping, whatever the host locale is. Everything else in this module
// works on that, so there is one place where digits are decided and one place
// where they are punctuated.
function plainDigits(value, options = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    const { significantDigits, maximumFractionDigits, minimumFractionDigits } = options;
    if (Number.isFinite(significantDigits)) {
        // toPrecision, then back through Number to drop the trailing zeros it
        // pads with — "1.3110" reads as a claim about the fourth decimal.
        return String(Number(number.toPrecision(significantDigits)));
    }
    if (Number.isFinite(maximumFractionDigits) || Number.isFinite(minimumFractionDigits)) {
        return new Intl.NumberFormat('en-US', {
            useGrouping: false,
            maximumFractionDigits: maximumFractionDigits ?? 3,
            minimumFractionDigits: minimumFractionDigits ?? 0,
        }).format(number);
    }
    return new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 3 }).format(number);
}

function groupInteger(digits, format) {
    if (!format.group || !(digits.length >= format.groupFrom)) return digits;
    let out = '';
    for (let index = 0; index < digits.length; index++) {
        // Groups of three counted from the right, so the leading group is the
        // short one: 1234567 is 1·234·567, never 123·456·7.
        if (index > 0 && (digits.length - index) % 3 === 0) out += format.group;
        out += digits[index];
    }
    return out;
}

/**
 * Punctuate a plain number string — '.' decimal, no grouping — with a resolved
 * format. Works on strings rather than numbers so a caller that already chose
 * its digits (toPrecision, toFixed, toExponential) keeps them exactly.
 *
 * An exponential string keeps its mantissa ungrouped: "2.4e+7" has no thousands
 * to separate, and grouping the exponent would be nonsense.
 */
export function punctuateNumber(plain, format = defaultNumberFormat()) {
    const text = String(plain ?? '');
    const match = /^([-+]?)(\d+)(?:\.(\d+))?([eE][-+]?\d+)?$/.exec(text);
    if (!match) return text;
    const [, sign, integer, fraction, exponent] = match;
    const body = exponent
        ? integer
        : groupInteger(integer, format);
    const decimals = fraction ? `${format.decimal}${fraction}` : '';
    return `${sign}${body}${decimals}${exponent || ''}`;
}

/**
 * A number formatted for reading, in the resolved convention.
 *
 * `options.significantDigits` mirrors toPrecision; `maximumFractionDigits` /
 * `minimumFractionDigits` mirror Intl. With none of them the default is Intl's
 * own: up to three decimals.
 */
export function formatNumber(value, format = defaultNumberFormat(), options = {}) {
    const plain = plainDigits(value, options);
    return plain === '' ? '' : punctuateNumber(plain, format);
}

/**
 * The `layout.separators` string Plotly takes: decimal first, grouping second.
 *
 * It is what makes an axis tick agree with the panel beside it. Plotly only
 * prints the grouping character where an axis asks for `separatethousands`,
 * which this app never does — its ticks carry SI suffixes instead — so in
 * practice this settles the decimal and keeps the rest as it was.
 */
export function plotlySeparators(format = defaultNumberFormat()) {
    return `${format.decimal}${format.group || ''}`;
}
