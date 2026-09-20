// Which dictionary the desktop spellchecker uses, and how the user changes it.
//
// The browser build has no equivalent: there Chrome owns the spellchecker and
// its right-click menu already offers "Languages". The desktop build removes
// the application menu at startup (Menu.setApplicationMenu(null) plus
// win.removeMenu()) and had no context menu of its own, so whatever dictionary
// Electron picked from the OS locale was the only one available — everything
// typed in another language came back underlined in red with no way to change
// it (#41).
//
// Chromium's codes are regional ("en-US"), the app's languages are not ("en"),
// and which regional variants a machine actually has installed varies. So every
// lookup here is tolerant: an exact code wins, otherwise any installed code
// with the same base language does.

// The app's four UI languages, in the order the menu lists them, each with the
// dictionary we ask for first. Autonyms: a language menu that names languages
// in some OTHER language is a menu you have to already be able to read.
const SPELLCHECK_LANGUAGES = [
    { code: 'en', label: 'English', preferred: 'en-US' },
    { code: 'fr', label: 'Français', preferred: 'fr-FR' },
    { code: 'es', label: 'Español', preferred: 'es-ES' },
    { code: 'it', label: 'Italiano', preferred: 'it-IT' },
];

const DEFAULT_SPELLCHECK_LANGUAGE = 'en';

/** The base language of a tag: "fr-CA" and "FR" both answer "fr". */
function baseLanguage(tag) {
    return String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
}

/** One of the app's four languages, or null for anything else. */
function normalizeSpellcheckLanguage(value) {
    const base = baseLanguage(value);
    return SPELLCHECK_LANGUAGES.some(item => item.code === base) ? base : null;
}

/**
 * Which language to spell-check in.
 *
 * An explicit choice from the menu outranks everything and keeps outranking it
 * — that is what makes it a setting rather than a hint. With no choice made,
 * follow the language the app is being used in, which is the best guess
 * available for what the user is about to type; then the OS; then English.
 */
function resolveSpellcheckLanguage({ stored, uiLanguage, appLocale } = {}) {
    return normalizeSpellcheckLanguage(stored)
        || normalizeSpellcheckLanguage(uiLanguage)
        || normalizeSpellcheckLanguage(appLocale)
        || DEFAULT_SPELLCHECK_LANGUAGE;
}

/**
 * The codes to hand Electron's setSpellCheckerLanguages, given what this
 * machine has. Returns [] when nothing matches — the caller must then leave the
 * session alone, because asking for a dictionary that is not installed throws
 * and would take the window down with it.
 */
function spellcheckerCodesFor(language, availableCodes = []) {
    const entry = SPELLCHECK_LANGUAGES.find(item => item.code === normalizeSpellcheckLanguage(language));
    if (!entry) return [];
    const available = (availableCodes || []).map(String);
    // Nothing to check against (an Electron build without the list): trust the
    // preferred code rather than refuse to set anything at all.
    if (!available.length) return [entry.preferred];
    const exact = available.find(code => code === entry.preferred);
    if (exact) return [exact];
    const sameLanguage = available.find(code => baseLanguage(code) === entry.code);
    return sameLanguage ? [sameLanguage] : [];
}

/** The language menu, ready to render: one radio item per language. */
function spellcheckMenuItems(currentLanguage, availableCodes = []) {
    const current = resolveSpellcheckLanguage({ stored: currentLanguage });
    return SPELLCHECK_LANGUAGES.map(item => ({
        code: item.code,
        label: item.label,
        checked: item.code === current,
        // A dictionary this machine does not have cannot be selected. Shown
        // rather than hidden: "Italiano, greyed out" says the app knows about
        // it and the machine does not, which a missing row does not say.
        enabled: spellcheckerCodesFor(item.code, availableCodes).length > 0,
    }));
}

module.exports = {
    DEFAULT_SPELLCHECK_LANGUAGE,
    SPELLCHECK_LANGUAGES,
    baseLanguage,
    normalizeSpellcheckLanguage,
    resolveSpellcheckLanguage,
    spellcheckMenuItems,
    spellcheckerCodesFor,
};
