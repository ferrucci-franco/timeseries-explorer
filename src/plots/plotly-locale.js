const DEFAULT_APP_LANGUAGE = 'en';

const PLOTLY_LOCALE_BY_APP_LANGUAGE = Object.freeze({
    en: 'en-US',
    fr: 'fr',
    es: 'es',
    it: 'it',
});

const CALENDAR_DATE_FORMAT_BY_APP_LANGUAGE = Object.freeze({
    en: '%b %d, %Y',
    fr: '%d %b %Y',
    es: '%d %b %Y',
    it: '%d %b %Y',
});

export function normalizeAppLanguage(language = DEFAULT_APP_LANGUAGE) {
    const normalized = String(language || '').trim().toLowerCase();
    return Object.hasOwn(PLOTLY_LOCALE_BY_APP_LANGUAGE, normalized)
        ? normalized
        : DEFAULT_APP_LANGUAGE;
}

export function getPlotlyLocale(language = DEFAULT_APP_LANGUAGE) {
    return PLOTLY_LOCALE_BY_APP_LANGUAGE[normalizeAppLanguage(language)];
}

export function getCalendarDateTickFormat(language = DEFAULT_APP_LANGUAGE) {
    return CALENDAR_DATE_FORMAT_BY_APP_LANGUAGE[normalizeAppLanguage(language)];
}
