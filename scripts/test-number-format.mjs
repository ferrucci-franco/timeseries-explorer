// The decimal and thousands separators: the language's convention, and the
// Settings overrides that sit on top of it.
//
// Everything behavioural lives in src/utils/number-format.js, which is pure, so
// it is exercised directly. The wiring — i18n, the Plotly seam, the Settings
// panel, and the one place the setting must NOT reach — is checked at source
// level, the way test-integral-analysis.mjs does it.
//
//   node scripts/test-number-format.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import i18n from '../src/i18n/index.js';
import {
    DEFAULT_NUMBER_FORMAT_SETTINGS,
    NUMBER_DECIMAL_CHOICES,
    NUMBER_GROUP_CHOICES,
    defaultNumberFormat,
    formatNumber,
    plotlySeparators,
    punctuateNumber,
    resolveNumberFormat,
} from '../src/utils/number-format.js';
import { formatIntegralDuration, formatIntegralNumber } from '../src/utils/integral-presentation.js';
import { csvValueCell } from '../src/utils/csv-cell.js';

let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

const NARROW_SPACE = ' ';

// ─── 1. The language's own convention is the default ──────────────────────
// Nobody who never opens the setting may see anything change, so `auto` has to
// reproduce exactly what each language did before this existed.
{
    const expected = {
        en: { decimal: '.', group: ',', sample: '1,234,567.25', four: '1,311' },
        es: { decimal: ',', group: '.', sample: '1.234.567,25', four: '1311' },
        fr: { decimal: ',', group: NARROW_SPACE, sample: `1${NARROW_SPACE}234${NARROW_SPACE}567,25`, four: `1${NARROW_SPACE}311` },
        it: { decimal: ',', group: '.', sample: '1.234.567,25', four: '1311' },
    };
    for (const [language, want] of Object.entries(expected)) {
        const format = resolveNumberFormat(language, DEFAULT_NUMBER_FORMAT_SETTINGS);
        eq(format.decimal, want.decimal, `${language} keeps its decimal separator`);
        eq(format.group, want.group, `${language} keeps its thousands separator`);
        eq(formatNumber(1234567.25, format), want.sample, `${language} formats a large number as before`);
        // Spanish and Italian leave a four-digit number ungrouped and group
        // from five. That is their rule, not ours, and `auto` must keep it.
        eq(formatNumber(1311, format), want.four, `${language} keeps its own rule about when to group`);
        eq(formatNumber(13110, format), `13${want.group}110`, `${language} groups from five digits`);
    }
    eq(defaultNumberFormat(), resolveNumberFormat('en', DEFAULT_NUMBER_FORMAT_SETTINGS),
        'the module default is English with no overrides');
    // An unknown language tag costs no number.
    ok(formatNumber(1234.5, resolveNumberFormat('zz-ZZ', {})).length > 0,
        'an unrecognised language still produces a number');
}

// ─── 2. The overrides ─────────────────────────────────────────────────────
{
    const dotSpace = resolveNumberFormat('en', { decimalSeparator: 'dot', thousandsSeparator: 'space' });
    eq(formatNumber(1234567.25, dotSpace), `1${NARROW_SPACE}234${NARROW_SPACE}567.25`,
        'a dot decimal with spaced thousands');
    // U+202F, the character Intl itself emits for French — a plain blank could
    // be broken across a line, splitting the number in half.
    eq(NUMBER_GROUP_CHOICES.space, NARROW_SPACE, 'the space is the narrow no-break one');

    const commaDot = resolveNumberFormat('en', { decimalSeparator: 'comma', thousandsSeparator: 'dot' });
    eq(formatNumber(1234567.25, commaDot), '1.234.567,25', 'the continental convention on an English interface');
    // An explicit separator groups from four digits: choosing one is asking to
    // see it, whatever the language would have done on its own.
    eq(formatNumber(1311, resolveNumberFormat('es', { thousandsSeparator: 'dot' })), '1.311',
        'an explicit separator groups a four-digit number even in Spanish');
    eq(formatNumber(1311, resolveNumberFormat('es', {})), '1311',
        'while automatic leaves it alone, as Spanish does');

    const none = resolveNumberFormat('en', { thousandsSeparator: 'none' });
    eq(formatNumber(1234567.25, none), '1234567.25', 'thousands can be turned off entirely');
    eq(none.group, '', 'which is what an empty group character means');

    eq(formatNumber(1234.5, resolveNumberFormat('en', { thousandsSeparator: 'apostrophe' })), '1’234.5',
        'and the Swiss apostrophe is on the menu');

    // The decimal always survives a collision: a number without its grouping is
    // still readable, a number with an unidentifiable decimal is not.
    const collide = resolveNumberFormat('en', { decimalSeparator: 'dot', thousandsSeparator: 'dot' });
    eq(collide.decimal, '.', 'on a collision the decimal is kept');
    eq(collide.group, '', 'and the grouping gives way');
    eq(formatNumber(1234567.25, collide), '1234567.25', 'so the number stays unambiguous');

    // Junk falls back rather than throwing or leaking through.
    eq(resolveNumberFormat('en', { decimalSeparator: 'semicolon' }).decimal, '.',
        'an unknown decimal choice falls back to the language');
    eq(resolveNumberFormat('en', { thousandsSeparator: 'pipe' }).group, ',',
        'and so does an unknown grouping choice');
    eq(Object.keys(NUMBER_DECIMAL_CHOICES), ['auto', 'dot', 'comma'], 'the decimal menu is the documented one');
}

// ─── 3. Punctuating digits a caller already chose ─────────────────────────
// The analyses decide their own precision (toPrecision, toFixed, toExponential)
// and only want the punctuation applied, without a float round-trip that could
// move a digit.
{
    const es = resolveNumberFormat('es', {});
    eq(punctuateNumber('1310.8', es), '1310,8', 'a plain decimal is re-punctuated');
    eq(punctuateNumber('-1234567.25', es), '-1.234.567,25', 'a negative keeps its sign and gains its grouping');
    eq(punctuateNumber('1234567', es), '1.234.567', 'an integer is grouped');
    // An exponential has no thousands to group, and grouping its exponent
    // would be nonsense.
    eq(punctuateNumber('2.4e+7', es), '2,4e+7', 'an exponential gets the decimal only');
    eq(punctuateNumber('-1.2345e-5', es), '-1,2345e-5', 'including a negative one');
    // Anything that is not a number we wrote comes back untouched: the em dash
    // the panels use for "no value" must not be mangled into one.
    eq(punctuateNumber('—', es), '—', 'a non-number is left alone');
    eq(punctuateNumber('', es), '', 'and so is nothing at all');
    eq(formatNumber(NaN, es), '', 'a broken number reads as a gap, never as the word NaN');
    eq(formatNumber(Infinity, es), '', 'and so does an infinite one');
}

// ─── 4. The analyses punctuate what they print ────────────────────────────
{
    const es = resolveNumberFormat('es', {});
    const en = resolveNumberFormat('en', {});
    eq(formatIntegralNumber(1310.8, 5, es), '1310,8', 'an integral total follows the setting');
    eq(formatIntegralNumber(1310.8, 5, en), '1,310.8', 'and the English default is unchanged');
    eq(formatIntegralNumber(24000000, 4, es), '2,400e+7', 'a large total keeps its exponential, re-punctuated');
    eq(formatIntegralNumber(0, 4, es), '0', 'zero is zero everywhere');
    eq(formatIntegralNumber(NaN, 4, es), '—', 'and no value is a dash');
    // Durations are printed with toFixed, which always writes a dot.
    eq(formatIntegralDuration(1.5 * 86400, 'datetime', { format: es }), '1,5 d',
        'a duration in days is punctuated too');
    eq(formatIntegralDuration(1.5 * 86400, 'datetime', { format: en }), '1.5 d',
        'and reads as before in English');
}

// ─── 5. i18n carries the resolved format ──────────────────────────────────
{
    const language = i18n.currentLang;
    const settings = { ...i18n.numberSettings };
    eq(i18n.formatNumber(1234567.25), '1,234,567.25', 'the default is the English convention');

    // Derived from `currentLang`, not stored: the FFT locale tests assign the
    // field directly to avoid setLanguage()'s DOM repaint, and the punctuation
    // has to follow them or it is silently stale.
    i18n.currentLang = 'es';
    eq(i18n.formatNumber(1234567.25), '1.234.567,25', 'assigning the language directly still re-resolves');

    i18n.setNumberSettings({ thousandsSeparator: 'apostrophe' });
    eq(i18n.formatNumber(1234567.25), '1’234’567,25', 'an override sits on top of the language');
    i18n.currentLang = 'en';
    eq(i18n.formatNumber(1234567.25), '1’234’567.25',
        'and survives a language change, which only moves the part it did not override');
    eq(i18n.formatNumber(NaN), '', 'a broken count is still a gap');

    i18n.setNumberSettings(null);
    eq(i18n.formatNumber(1234567.25), '1’234’567.25', 'junk cannot clear the choices');
    i18n.setNumberSettings({});
    eq(i18n.formatNumber(1234567.25), '1,234,567.25', 'an empty object is "automatic", which clears them');

    i18n.currentLang = language;
    i18n.setNumberSettings(settings);
}

// ─── 6. Plotly writes its own numbers, in the same convention ─────────────
{
    eq(plotlySeparators(resolveNumberFormat('en', {})), '.,', 'decimal first, grouping second');
    eq(plotlySeparators(resolveNumberFormat('es', {})), ',.', 'the Spanish pair');
    eq(plotlySeparators(resolveNumberFormat('en', { thousandsSeparator: 'none' })), '.',
        'with no grouping the string is just the decimal');

    const vendor = readFileSync(new URL('../src/vendor/plotly.js', import.meta.url), 'utf8');
    ok(vendor.includes('export function setPlotNumberSeparators'), 'the vendor wrapper exposes the seam');
    ok(/layoutFor = layout => withSeparators\(/.test(vendor),
        'and every newPlot and react goes through it, rather than seventeen layout builders');
    ok(/layout\.separators !== undefined\) return layout/.test(vendor),
        'a layout that names its own separators is left alone');
}

// ─── 7. The setting is stored, validated and offered ──────────────────────
{
    const app = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
    const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');

    ok(/decimalSeparator: 'auto'/.test(app) && /thousandsSeparator: 'auto'/.test(app),
        'both settings default to automatic, so nothing moves until someone asks');
    ok(app.includes('_advancedSettingChoices()'),
        'the words a setting may take live in one declarative table');
    ok(/_applyNumberFormat\(\)[\s\S]{0,400}i18n\.setNumberSettings/.test(app),
        'resolving hands the choices to the app formatter');
    ok(/_applyNumberFormat[\s\S]{0,500}setPlotNumberSeparators/.test(app), 'and to Plotly');
    // A language change moves the default the overrides sit on. i18n derives
    // the format from its own `currentLang`, so that part needs nothing; what
    // the app still has to do is hand Plotly the new separators.
    ok(/setLanguage\(lang\)[\s\S]{0,600}_applyNumberFormat\(\)/.test(app),
        'a language change re-resolves the punctuation for Plotly too');

    ok(ui.includes("'decimal-separator'") && ui.includes("'thousands-separator'"),
        'Settings offers both controls');
    ok(ui.includes('plot-settings-number-tab'), 'under a topic of their own');
    ok(/numberPreview\.textContent = /.test(ui), 'with a live sample of the choice');
    ok(/option\.disabled = !!character && character === chosenDecimal/.test(ui),
        'and the colliding option is taken off the menu rather than ignored afterwards');
    ok(/applyNumberSettings[\s\S]{0,900}layoutManager\.render\(\)/.test(ui),
        'changing it redraws, because Plotly reads the separators when a plot is drawn');
    ok(/_resetAdvancedSettings\(\);[\s\S]{0,400}_applyNumberFormat\(\)/.test(ui),
        'and Reset puts the punctuation back too');

    for (const language of ['en', 'es', 'fr', 'it']) {
        const block = translations.slice(translations.indexOf(`        ${language}: {`));
        const body = block.slice(0, block.indexOf('\n        },'));
        for (const key of ['numberFormatSettingsTitle', 'numberDecimalSeparator',
            'numberThousandsSeparator', 'numberSeparatorAuto', 'numberSeparatorSpace',
            'numberFormatPreview']) {
            ok(body.includes(`${key}:`), `${language} carries ${key}`);
        }
    }
}

// ─── 8. What the setting must NOT reach ───────────────────────────────────
// A CSV with comma decimals next to comma delimiters is a broken file. The
// export builds its cells from raw values and never from a display formatter,
// and that is the property worth pinning: it is one careless edit from a
// spreadsheet that reads every number as text.
{
    // The cell escaper is the last thing every exported value passes through,
    // and it stringifies rather than formats. Pinning it here is cheap and
    // catches the one edit — "make the CSV match what the panel shows" — that
    // would quietly break every export.
    const cell = readFileSync(new URL('../src/utils/csv-cell.js', import.meta.url), 'utf8');
    ok(!/formatNumber|punctuateNumber|toLocaleString|i18n/.test(cell),
        'the CSV cell writer knows nothing about display punctuation');
    ok(/String\(value \?\? ''\)/.test(cell), 'it stringifies the value as the data had it');
    eq(csvValueCell(1234567.25), '1234567.25', 'so a number goes out with a dot and no grouping');
    eq(csvValueCell(-0.5), '-0.5', 'including a negative one');

    const presentation = readFileSync(new URL('../src/utils/integral-presentation.js', import.meta.url), 'utf8');
    const tableStart = presentation.indexOf('export function buildIntegralExportTable');
    const table = presentation.slice(tableStart, presentation.indexOf('\nexport function', tableStart + 1));
    ok(!/formatIntegralNumber|punctuateNumber/.test(table),
        'and the export table carries numbers, not strings someone punctuated');

    // The progress overlay beside the export is a different thing: "12,345 of
    // 61,368 rows" is prose for a reader and follows the setting like any
    // other count.
    const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
    ok(/csvExportProgress[\s\S]{0,200}i18n\.formatNumber/.test(manager),
        'while the export progress message is punctuated, because a reader reads it');
}

console.log(`number format: ${checks} checks passed`);
