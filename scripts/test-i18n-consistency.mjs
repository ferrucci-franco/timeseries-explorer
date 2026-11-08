// Guards the five language blocks (en/fr/es/it/zh) against drift: every key must
// exist in every language with a non-empty value, and no language may carry an
// extra key. Also spot-checks the time-axis keys added on this branch.
import assert from 'node:assert/strict';
import translations from '../src/i18n/translations.js';

const langs = Object.keys(translations);
assert.deepEqual(langs.sort(), ['en', 'es', 'fr', 'it', 'zh'], 'exactly the five expected languages');

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
    'timeAxisIndexDescription', 'timeAxisDeltaDescription',
    'timeAxisIndexModifiedTitle', 'timeAxisIndexModifiedBody', 'timeAxisIndexReuse', 'timeAxisIndexRegenerate',
    'timeAxisOptionExists', 'timeAxisOptionIndexLabel', 'timeAxisOptionIndexHelp',
    'timeAxisOptionDeltaLabel', 'timeAxisOptionDeltaHelp',
    // Time-axis inspector (button, dialog, diagnostics).
    'timeAxisInspectButton', 'timeAxisInspectTitle', 'timeAxisInspectBody', 'timeAxisInspectLazyNote',
    'timeAxisInspectCreate', 'timeAxisInspectHint',
    'timeAxisDiagHeading', 'timeAxisSignalsHeading', 'timeAxisSignalsLead',
    'timeAxisSummaryComputing', 'timeAxisSummaryEquidistant', 'timeAxisSummaryAnomalies',
    'timeAxisSummaryPartial', 'timeAxisSummaryEmpty',
    'timeAxisCountRepeatedOne', 'timeAxisCountRepeatedMany', 'timeAxisCountGapsOne',
    'timeAxisCountGapsMany', 'timeAxisCountBackwardsOne', 'timeAxisCountBackwardsMany',
    'timeAxisDiagSamples', 'timeAxisDiagSpan', 'timeAxisDiagStep', 'timeAxisDiagStepConstant',
    'timeAxisDiagRepeated', 'timeAxisDiagGaps', 'timeAxisDiagBackwards', 'timeAxisDiagNotChecked',
    'timeAxisDiagExcludesRepeated', 'timeAxisDiagVerdictEquidistant',
    'timeAxisDiagVerdictEquidistantRepeats', 'timeAxisDiagVerdictIrregular', 'timeAxisDiagVerdictUnknown',
    'timeAxisDiagCancelled', 'timeAxisDiagFailed', 'timeAxisDiagRetry',
];

// Singular/plural pairs must differ, and only the plural takes a count.
for (const lang of langs) {
    for (const base of ['timeAxisCountRepeated', 'timeAxisCountGaps', 'timeAxisCountBackwards']) {
        const one = translations[lang][`${base}One`];
        const many = translations[lang][`${base}Many`];
        assert.notEqual(one, many, `${lang}.${base} must distinguish singular from plural`);
        assert.ok(!one.includes('{n}'), `${lang}.${base}One is the singular, so it needs no {n}`);
        assert.ok(many.includes('{n}'), `${lang}.${base}Many must interpolate {n}`);
    }
}

// The drag-warning keys were replaced by the inspector dialog.
const replacedKeys = ['timeAxisDragWarnTitle', 'timeAxisDragWarnBody', 'timeAxisDragWarnContinue',
    'timeAxisOptionValueLabel', 'timeAxisOptionValueHelp', 'timeAxisValueDescription',
    'timeAxisSummaryIrregular'];
for (const lang of langs) {
    for (const key of replacedKeys) {
        assert.ok(!keySets[lang].has(key), `${lang} should no longer define replaced key ${key}`);
    }
}
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

// Every language is reachable from both pickers: the top-bar menu and the
// phone layout's segmented control. A language present only in the data is
// one nobody can choose.
{
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const menuLangs = [...html.matchAll(/class="[^"]*\blang-btn\b[^"]*"[^>]*data-lang="([a-z]+)"/g)].map(m => m[1]);
    assert.deepEqual([...menuLangs].sort(), [...langs].sort(), 'the top-bar language menu offers every language');
    const compact = readFileSync(new URL('../src/app/methods/compact-methods.js', import.meta.url), 'utf8');
    const compactList = compact.match(/for \(const lang of (\[[^\]]*\])\)/)?.[1];
    assert.ok(compactList, 'the compact language picker lists its languages');
    assert.deepEqual(JSON.parse(compactList.replace(/'/g, '"')).sort(), [...langs].sort(),
        'the compact language picker offers every language');
}

console.log(`i18n consistency tests passed (${reference.size} keys × ${langs.length} languages).`);
