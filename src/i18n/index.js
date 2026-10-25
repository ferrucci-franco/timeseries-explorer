/**
 * Internationalization Module
 * Handles multi-language support
 */

import translations from './translations.js';
import {
    DEFAULT_NUMBER_FORMAT_SETTINGS,
    formatNumber as formatWithSeparators,
    resolveNumberFormat,
} from '../utils/number-format.js';

// `**bold**` inside a translated string, and nothing else. Everything is escaped
// before the markers are honoured, so the only tags that can reach the DOM are
// the ones produced here — a translation file is data, not markup.
function renderRichText(text) {
    const escaped = String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const i18n = {
    currentLang: 'en',
    translations,
    // How numbers are punctuated: the language's own convention, with whatever
    // Settings overrides (utils/number-format.js). The SETTINGS are what is
    // stored and the format is derived, so changing the language re-resolves
    // on its own — a format pushed in from outside would go stale the moment
    // someone called setLanguage directly, which is exactly what the FFT
    // locale tests do.
    numberSettings: { ...DEFAULT_NUMBER_FORMAT_SETTINGS },

    /**
     * Derived on read from `currentLang` and `numberSettings`, memoised on the
     * pair. Derived rather than stored because `currentLang` is also assigned
     * directly — the FFT locale tests do exactly that, to get the formatting
     * without the DOM repaint setLanguage() does — and a stored copy would go
     * stale the moment anyone did.
     */
    get numberFormat() {
        const settings = this.numberSettings;
        const key = `${this.currentLang}\u0000${settings.decimalSeparator}\u0000${settings.thousandsSeparator}`;
        if (this._numberFormatKey !== key) {
            this._numberFormatKey = key;
            this._numberFormatCache = resolveNumberFormat(this.currentLang, settings);
        }
        return this._numberFormatCache;
    },

    setLanguage(lang) {
        if (!this.translations[lang]) {
            console.warn(`Language ${lang} not found, defaulting to 'en'`);
            lang = 'en';
        }
        this.currentLang = lang;
        this.updateDOM();
    },

    /**
     * The user's separator choices. The language still supplies the default
     * each one sits on, so this only has to store them.
     */
    setNumberSettings(settings) {
        if (settings && typeof settings === 'object') {
            this.numberSettings = {
                decimalSeparator: settings.decimalSeparator ?? 'auto',
                thousandsSeparator: settings.thousandsSeparator ?? 'auto',
            };
        }
        return this.numberFormat;
    },

    /**
     * Get a translation key
     */
    t(key) {
        return this.translations[this.currentLang][key] || this.translations.en?.[key] || key;
    },

    /**
     * A number formatted for the language the USER picked, not the one the
     * browser happens to run in. Plain toLocaleString() follows the browser, so
     * an app switched to Spanish on an English browser prints "16,777,216"
     * inside a Spanish sentence — the separators say one thing and the words
     * another.
     *
     * Settings can override either separator; `numberFormat` already carries
     * that decision, so every caller gets it without knowing it exists.
     *
     * @param {number} value
     * @param {object} [options] `significantDigits`, or Intl's
     *   `maximumFractionDigits` / `minimumFractionDigits`.
     */
    formatNumber(value, options) {
        const n = Number(value);
        // Empty, never the literal "NaN" or "Infinity": this goes into visible
        // labels, and a broken count reads better as a gap than as a word the
        // user cannot act on.
        if (!Number.isFinite(n)) return '';
        return formatWithSeparators(n, this.numberFormat, options);
    },

    /**
     * A string for innerHTML: escaped, with **emphasis** turned into <strong>.
     *
     * The same markup data-i18n-rich already applies in the DOM, exposed for the
     * places that build HTML in JavaScript. Those used to inline fully translated
     * HTML per language, which meant a new locale silently fell back to the
     * hardcoded English even when translations.js had an entry for it.
     */
    rich(key) {
        return renderRichText(this.t(key));
    },

    /** The same string with the emphasis markers dropped, for a title or alert. */
    plain(key) {
        return this.t(key).replace(/\*\*/g, '');
    },

    /**
     * Update all elements with data-i18n attribute
     */
    updateDOM() {
        const elements = document.querySelectorAll('[data-i18n]');
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = this.t(key);

            // Update text content or placeholder
            if (el.tagName === 'INPUT' && el.type === 'text') {
                el.placeholder = translation;
            } else {
                el.textContent = translation;
            }
        });

        // Strings that need a word or two emphasised INSIDE the sentence — a
        // coefficient name, a formula. Splitting them into three keys around the
        // emphasis would wreck them for translators, whose word order differs:
        // the marker travels with the word instead. Only **bold** is understood,
        // and the text is escaped first, so a translation can never inject HTML.
        document.querySelectorAll('[data-i18n-rich]').forEach(el => {
            el.innerHTML = renderRichText(this.t(el.getAttribute('data-i18n-rich')));
        });

        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.title = this.t(el.getAttribute('data-i18n-title'));
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.placeholder = this.t(el.getAttribute('data-i18n-placeholder'));
        });

        document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
            el.setAttribute('aria-label', this.t(el.getAttribute('data-i18n-aria-label')));
        });

        // Update tooltips
        const tooltips = {
            'toggle-sidebar':     'toggleSidebar',
            'auto-zoom':          'autoZoom',
            'clear-plots':        'clearPlots',
            'reload-file':        'reloadFile',
            'reload-file-menu-btn':'reloadFileOptions',
            'load-new-file':      'loadNewFile',
            'open-file-menu-btn':  'openFileOptions',
            'theme-toggle':       'toggleTheme',
            'toggle-sort':        'sortAZ',
            'toggle-descriptions':'toggleDescriptions',
            'toggle-point-counts':'togglePointCounts',
            'toggle-numeric-only':'toggleNumericOnly',
            'derived-help-toggle':'derivedFormulaHelp',
            'outlier-help-toggle':'outlierHelpTitle',
            'expand-all':         'expandAll',
            'collapse-all':       'collapseAll',
            'reset-layout':       'resetLayout',
            'load-example-btn':   'loadExample',
            'extra-menu-btn':     'extraMenu',
            'toggle-cursors':     'toggleCursors',
            'mode-fft':           'modeFFT',
        };

        for (const [id, key] of Object.entries(tooltips)) {
            const el = document.getElementById(id);
            if (el) el.title = this.t(key);
        }

        // Update browser title tab
        document.title = this.t('appTitle');
    }
};

export default i18n;
