/**
 * Internationalization Module
 * Handles multi-language support
 */

import translations from './translations.js';

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

    setLanguage(lang) {
        if (!this.translations[lang]) {
            console.warn(`Language ${lang} not found, defaulting to 'en'`);
            lang = 'en';
        }
        this.currentLang = lang;
        this.updateDOM();
    },

    /**
     * Get a translation key
     */
    t(key) {
        return this.translations[this.currentLang][key] || this.translations.en?.[key] || key;
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
