// The pure pieces of the phone's data tools (src/app/methods/compact-tools-methods.js):
// where every tool of the desktop's picker sits on a phone, which pieces of the
// side panel make its settings, the − / + a number field gets, the keypad it
// asks for, the height a tool's page opens at, and the words in four languages.
//
// The first check is the §11 rule of docs/phone-web-specification.md in code: a
// tool added to the desktop's picker and not placed here fails the suite, so the
// phone never silently lacks a tool.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import translations from '../src/i18n/translations.js';
import {
    COMPACT_TOOLS,
    COMPACT_TOOL_GROUPS,
    COMPACT_TOOL_HALF_MIN_HEIGHT,
    compactToolSettingsSelectors,
    compactToolSheetSize,
    numberInputMode,
    stepperStep,
} from '../src/app/methods/compact-tools-methods.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// ── Every tool of the desktop has its place on the phone, and no other ──────
const picker = html.match(/<select id="data-tool-select"[\s\S]*?<\/select>/)?.[0] || '';
assert.ok(picker, 'the desktop picker is in index.html');
const desktopTools = [...picker.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
assert.ok(desktopTools.length >= 10, 'the picker lists the tools');
for (const tool of desktopTools) {
    assert.ok(COMPACT_TOOLS.includes(tool), `${tool} is placed in a group of the phone's hub`);
}
for (const tool of COMPACT_TOOLS) {
    assert.ok(desktopTools.includes(tool), `${tool} is a tool of the desktop picker`);
}
assert.equal(new Set(COMPACT_TOOLS).size, COMPACT_TOOLS.length, 'no tool sits in two groups');
assert.deepEqual(COMPACT_TOOL_GROUPS.map(group => group.id), ['clean', 'calculus', 'smooth', 'time']);

// ── Each tool's settings are pieces the side panel has ──────────────────────
const kinds = [...html.matchAll(/class="data-tool-controls[^"]*" data-tool-kind="([^"]+)"/g)].map(m => m[1]);
for (const kind of kinds) {
    assert.ok(COMPACT_TOOLS.includes(kind), `the controls of ${kind} belong to a phone tool`);
}
for (const tool of COMPACT_TOOLS) {
    for (const selector of compactToolSettingsSelectors(tool)) {
        const id = selector.match(/^#([\w-]+)$/)?.[1];
        const cls = selector.match(/^\.([\w-]+)$/)?.[1];
        const kind = selector.match(/data-tool-kind="([^"]+)"/)?.[1];
        if (id) assert.ok(html.includes(`id="${id}"`), `${tool}: ${selector} is in the side panel`);
        else if (cls) assert.ok(html.includes(cls), `${tool}: ${selector} is in the side panel`);
        else if (kind) assert.ok(kinds.includes(kind), `${tool}: ${selector} is in the side panel`);
        else assert.fail(`${tool}: ${selector} is not a selector this test knows`);
    }
}
// Tools without settings of their own (derivative's single select counts as
// settings) still have one block: only Remove outliers is several.
assert.deepEqual(compactToolSettingsSelectors('removeOutliers'),
    ['#outlier-method-wrap', '.outlier-method-controls', '#outlier-replacement-wrap']);
assert.deepEqual(compactToolSettingsSelectors('filter'), ['.data-tool-controls[data-tool-kind="filter"]']);

// ── − and +: only a field that counts ───────────────────────────────────────
assert.equal(stepperStep('1'), 1, 'a window steps by one');
assert.equal(stepperStep('2'), 2, 'an odd window steps by two, staying odd');
assert.equal(stepperStep('0.1'), 0.1, 'the integral\'s start steps by a tenth');
assert.equal(stepperStep('any'), 0, 'a cut-off or a Δt is typed, not counted');
assert.equal(stepperStep(''), 0);
assert.equal(stepperStep(null), 0);
assert.equal(stepperStep('0'), 0);
assert.equal(stepperStep('-1'), 0);

// ── The keypad a number field asks for ──────────────────────────────────────
assert.equal(numberInputMode({ min: '2', step: '1' }), 'numeric', 'a window: digits only');
assert.equal(numberInputMode({ min: '0', step: 'any' }), 'decimal', 'a cut-off: digits and the point');
assert.equal(numberInputMode({ min: '0.01', step: 'any' }), 'decimal');
assert.equal(numberInputMode({ min: '0', step: '0.5' }), 'decimal');
assert.equal(numberInputMode({ min: null, step: '1' }), '', 'a field that may go negative keeps the full keyboard (iOS keypads have no minus)');
assert.equal(numberInputMode({ min: '-5', step: '1' }), '');
assert.equal(numberInputMode({ min: '', step: 'any' }), '');

// ── The height a tool's page opens at ───────────────────────────────────────
assert.equal(compactToolSheetSize(844), 'half', '390 × 844: the plot stays above the page');
assert.equal(compactToolSheetSize(915), 'half');
assert.equal(compactToolSheetSize(800), 'half');
assert.equal(compactToolSheetSize(568), 'full', '320 × 568: half a sheet would hold nothing');
assert.equal(compactToolSheetSize(COMPACT_TOOL_HALF_MIN_HEIGHT - 1), 'full');
assert.equal(compactToolSheetSize(COMPACT_TOOL_HALF_MIN_HEIGHT), 'half');

// ── Words, in every language ────────────────────────────────────────────────
const languages = ['en', 'fr', 'es', 'it', 'zh'];
const phoneKeys = Object.keys(translations.en).filter(key => key.startsWith('compactTool'));
assert.ok(phoneKeys.length > 40, 'the phone\'s data-tool strings are in the English table');
for (const lang of languages) {
    for (const key of phoneKeys) {
        assert.equal(typeof translations[lang][key], 'string', `${lang}.${key}`);
        assert.ok(translations[lang][key].trim(), `${lang}.${key} is not empty`);
    }
    for (const group of COMPACT_TOOL_GROUPS) {
        assert.ok(translations[lang][group.titleKey], `${lang}: the ${group.id} group has a title`);
    }
    for (const tool of COMPACT_TOOLS) {
        assert.ok(translations[lang][`compactToolDesc_${tool}`], `${lang}: ${tool} says what it does`);
    }
    // The placeholders each sentence is filled with survive translation.
    for (const key of phoneKeys) {
        const wanted = (translations.en[key].match(/\{\w+\}/g) || []).sort();
        const got = (translations[lang][key].match(/\{\w+\}/g) || []).sort();
        assert.deepEqual(got, wanted, `${lang}.${key} keeps its placeholders`);
    }
}
// Strings the phone borrows from the desktop panel exist in every language.
for (const key of ['dataTools', 'dataToolTransformations', 'dataToolRowAllVariables', 'dataToolRowDataset',
    'dataToolEditTitle', 'derivedDatasetEditTitle', 'dataToolDeleteTitle', 'derivedDatasetRemoveTitle',
    'dataToolDeleteConfirm', 'derivedDatasetDeleteConfirm', 'dataToolNo', 'dataToolCancel', 'dataToolUpdate',
    'dataToolCreate', 'dataToolFixParameters', 'outlierNoVariables', 'compactPlotN']) {
    for (const lang of languages) assert.ok(translations[lang][key], `${lang}.${key}`);
}

console.log('compact data tools: ok');
