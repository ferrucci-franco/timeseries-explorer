// Guards the four language blocks (en/fr/es/it) against drift: every key must
// exist in every language with a non-empty value, and no language may carry an
// extra key. Also spot-checks the time-axis keys added on this branch.
import assert from 'node:assert/strict';
import translations from '../src/i18n/translations.js';

const langs = Object.keys(translations);
assert.deepEqual(langs.sort(), ['en', 'es', 'fr', 'it'], 'exactly the four expected languages');

const keySets = Object.fromEntries(langs.map(l => [l, new Set(Object.keys(translations[l]))]));
const reference = keySets.en;

for (const lang of langs) {
    if (lang === 'en') continue;
    const missing = [...reference].filter(k => !keySets[lang].has(k));
    const extra = [...keySets[lang]].filter(k => !reference.has(k));
    assert.equal(missing.length, 0, `${lang} is missing keys present in en: ${missing.slice(0, 8).join(', ')}`);
    assert.equal(extra.length, 0, `${lang} has keys not in en: ${extra.slice(0, 8).join(', ')}`);
}

// No empty STRING values (some values are arrays, e.g. runtimeNoticeWebFeatures).
for (const lang of langs) {
    for (const [key, value] of Object.entries(translations[lang])) {
        if (typeof value !== 'string') continue;
        assert.ok(value.trim() !== '', `${lang}.${key} must not be an empty string`);
    }
}

// The time-axis unification keys added on this branch must be present everywhere.
const branchKeys = [
    'timeAxisTitle', 'timeAxisSource', 'timeAxisSourceFile', 'timeAxisSourceIndex',
    'timeAxisFormat', 'timeAxisFormatCalendar24h', 'timeAxisFormatCalendarAmPm',
    'timeAxisFormatDuration', 'timeAxisFormatSecondsNumeric', 'timeAxisFormatCalendarFromDate',
    'timeAxisNewStep', 'timeStepIndex', 'timeStep1Second', 'timeStep1Minute',
    'timeStep10Minutes', 'timeStep15Minutes', 'timeStep30Minutes', 'timeStep1Hour',
    'timeStep1Day', 'timeStepCustom', 'timeAxisShowAs', 'timeAxisShowCalendar',
    'reindexWarnTitle', 'reindexWarnEquidistant', 'reindexWarnGaps',
    'incompatTimeTitle', 'incompatTimeIntroTransform', 'incompatTimeIntroOverlay',
    'incompatTimeIntroTraces', 'incompatTimeBodyLead', 'incompatTimeKindsTitle',
    'incompatTimeKindCalendar', 'incompatTimeKindSeconds', 'incompatTimeKindIndex',
    'incompatTimeFixTitle', 'incompatTimeFixSeconds', 'incompatTimeFixCalendar', 'incompatTimeFixRemove',
];
for (const lang of langs) {
    for (const key of branchKeys) {
        assert.ok(keySets[lang].has(key), `${lang} must define ${key}`);
    }
}

// The removed orphan keys must be gone from every language.
const removedKeys = ['indexTimeStepLabel', 'indexTimeStepIndex', 'indexTimeStepSeconds',
    'indexTimeStep10Minutes', 'indexTimeStep1Hour', 'indexTimeStepCustom',
    'indexTimeOriginLabel', 'indexTimeOriginElapsed', 'indexTimeOriginCalendar', 'indexIgnoreDetectedHint'];
for (const lang of langs) {
    for (const key of removedKeys) {
        assert.ok(!keySets[lang].has(key), `${lang} should no longer define orphan key ${key}`);
    }
}

console.log(`i18n consistency tests passed (${reference.size} keys × ${langs.length} languages).`);
