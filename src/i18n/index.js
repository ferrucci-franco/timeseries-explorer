/**
 * Internationalization Module
 * Handles multi-language support
 */

import translations from './translations.js';

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

        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.title = this.t(el.getAttribute('data-i18n-title'));
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
            'live-update-file':    'liveUpdateTitle',
            'live-update-menu-btn':'liveUpdateOptions',
            'load-new-file':      'loadNewFile',
            'open-file-menu-btn':  'openFileOptions',
            'theme-toggle':       'toggleTheme',
            'toggle-sort':        'sortAZ',
            'toggle-descriptions':'toggleDescriptions',
            'derived-help-toggle':'derivedFormulaHelp',
            'timeseries-downsampling-help-toggle':'timeseriesDownsamplingHelpTitle',
            'expand-all':         'expandAll',
            'collapse-all':       'collapseAll',
            'reset-layout':       'resetLayout',
            'load-example-btn':   'loadExample',
            'toggle-cursors':     'toggleCursors',
            'mode-fft':           'modeFFT',
            'help-btn':           'help',
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
