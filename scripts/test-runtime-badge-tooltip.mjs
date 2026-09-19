// The runtime badge ("Light Web" / "Full Desktop") carries a tooltip that
// explains what the running version is. That sentence used to be written in
// English inside viewer-app.js, so it stayed English forever: the badge sat in
// a Spanish or Italian top bar and answered in English, while every tooltip
// beside it followed the language buttons. The sentence now lives in
// translations.js, and this test keeps it there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import translations from '../src/i18n/translations.js';

const KEYS = ['runtimeBadgeWebTooltip', 'runtimeBadgeDesktopTooltip'];
const langs = Object.keys(translations);

for (const key of KEYS) {
    for (const lang of langs) {
        const value = translations[lang][key];
        assert.equal(typeof value, 'string', `${lang}.${key} must be a string`);
        assert.ok(value.trim() !== '', `${lang}.${key} must not be empty`);
    }
    // Translated, not copied: a language block that still holds the English
    // sentence is the bug this test exists for, wearing a different hat.
    for (const lang of langs.filter(l => l !== 'en')) {
        assert.notEqual(
            translations[lang][key],
            translations.en[key],
            `${lang}.${key} is still the English sentence`,
        );
    }
}

// The badge text itself stays 'Light Web' / 'Full Desktop' in every language —
// it is the version's name — so both tooltips keep naming it.
for (const lang of langs) {
    assert.match(translations[lang].runtimeBadgeWebTooltip, /Light Web/, `${lang} web tooltip names the runtime`);
    assert.match(translations[lang].runtimeBadgeDesktopTooltip, /Full Desktop/, `${lang} desktop tooltip names the runtime`);
}

const viewerApp = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
const summary = viewerApp.match(/_capabilitiesSummary\(caps\) \{([\s\S]*?)\n    \}/)?.[1];
assert.ok(summary, '_capabilitiesSummary should still be where the badge tooltip is produced');
assert.match(summary, /i18n\.t\(caps\.isDesktop \? 'runtimeBadgeDesktopTooltip' : 'runtimeBadgeWebTooltip'\)/,
    'the badge tooltip must be read from translations, not written in place');
assert.doesNotMatch(summary, /native local capabilities|browser-only version/,
    'the old hardcoded English sentences must be gone');
assert.match(viewerApp, /badge\.title = this\._capabilitiesSummary\(caps\)/, 'the badge still gets the tooltip');
// setLanguage() reapplies the capabilities UI, which is what repaints the
// tooltip; without that call the new keys would change nothing on screen.
assert.match(
    viewerApp,
    /setLanguage\(lang\) \{[\s\S]*?this\._applyCapabilitiesToUi\(\);/,
    'switching language must reapply the capabilities UI so the tooltip follows',
);

// End to end through i18n itself: the same runtime, two languages, two
// sentences. updateDOM() is stubbed out because this test has no DOM.
const originalDocument = globalThis.document;
globalThis.document = {
    querySelectorAll: () => [],
    getElementById: () => null,
    title: '',
};
try {
    const { default: i18n } = await import('../src/i18n/index.js');
    const tooltipFor = (lang, desktop) => {
        i18n.setLanguage(lang);
        return i18n.t(desktop ? 'runtimeBadgeDesktopTooltip' : 'runtimeBadgeWebTooltip');
    };
    for (const desktop of [false, true]) {
        const seen = new Set(langs.map(lang => tooltipFor(lang, desktop)));
        assert.equal(seen.size, langs.length, `each language must give its own ${desktop ? 'desktop' : 'web'} tooltip`);
    }
    i18n.setLanguage('en');
} finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
}

console.log(`Runtime badge tooltip checks passed (${langs.length} languages).`);
