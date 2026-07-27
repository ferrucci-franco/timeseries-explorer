// The "Large files and memory use" help must match what the app does.
//
//   node scripts/test-large-files-help.mjs
//
// The previous text was generic enough to be misleading: it described every
// per-format limit as the same kind of thing when half of them switch a file to
// memory-saving mode and half warn about holding it whole, and it implied Full
// Desktop raises every limit when the CSV limit is identical in both. These
// checks pin the claims that were wrong, against the code that decides them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import translations from '../src/i18n/translations.js';

const LANGS = ['en', 'fr', 'es', 'it'];
let checks = 0;
const check = (fn) => { fn(); checks++; };

const bodies = Object.fromEntries(LANGS.map(l => [l, translations[l].helpSec11Body]));

check(() => {
    for (const lang of LANGS) {
        assert.ok(bodies[lang].length > 2000, `${lang} help is substantial`);
        assert.equal((bodies[lang].match(/<h4>/g) || []).length, 7, `${lang} has all seven sections`);
        assert.match(bodies[lang], /<table/, `${lang} includes the limits table`);
    }
});

// ─── The claims that were wrong ───────────────────────────────────────────

check(() => {
    // Every format that has NO memory-saving path must be named, so nobody has
    // to infer it from silence.
    for (const lang of LANGS) {
        for (const needle of ['MAT', 'netCDF', 'pickle', 'Parquet']) {
            assert.match(bodies[lang], new RegExp(needle), `${lang} names ${needle}`);
        }
    }
});

check(() => {
    // The CSV limit is 150 MB in BOTH runtimes. The old text implied desktop
    // raises everything.
    for (const lang of LANGS) {
        assert.match(bodies[lang], /150 MB[\s\S]{0,80}150 MB/, `${lang} shows the CSV limit as equal in both runtimes`);
    }
});

check(() => {
    // Data Tools being cut down to one operation in memory-saving mode was
    // documented nowhere at all.
    const expected = { en: /outliers by bounds/i, fr: /valeurs aberrantes par bornes/i, es: /valores atipicos por limites/i, it: /outlier per soglie/i };
    for (const lang of LANGS) {
        assert.match(bodies[lang], expected[lang], `${lang} states the Data Tools restriction`);
    }
});

check(() => {
    // Nor was the ZIP block.
    for (const lang of LANGS) {
        assert.match(bodies[lang], /\.zip/i, `${lang} states that complete-project saving is blocked`);
    }
});

check(() => {
    // Memory-saving mode is NOT desktop-only, which the old text left ambiguous.
    for (const lang of LANGS) {
        assert.match(bodies[lang], /file:\/\//, `${lang} names the condition that actually disables it`);
    }
});

check(() => {
    for (const lang of LANGS) {
        assert.match(bodies[lang], /4 ?GB|4 ?Go/, `${lang} states the query engine's fixed ceiling`);
    }
});

// ─── Defaults quoted in the help must match the code ──────────────────────

check(() => {
    const viewerApp = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
    // Anchor on the definition, not the first mention: _loadAdvancedSettings is
    // called in the constructor, well above where the defaults are declared.
    const from = viewerApp.indexOf('_defaultAdvancedSettings() {');
    const to = viewerApp.indexOf('_normalizeAdvancedSettings(', from);
    assert.ok(from > 0 && to > from, 'located the defaults block');
    const defaults = viewerApp.slice(from, to);
    const expected = [
        ['csvFullLoadMb', '150'],
        ['parquetFullLoadMb', "desktop ? 200 : 100"],
        ['matlabFullLoadMb', "desktop ? 1024 : 250"],
        ['excelFullLoadMb', "desktop ? 150 : 50"],
        ['pickleFullLoadMb', "desktop ? 200 : 80"],
        ['pypsaNetcdfFullLoadMb', "desktop ? 1024 : 250"],
    ];
    for (const [key, value] of expected) {
        assert.ok(defaults.includes(`${key}: ${value}`), `${key} default is still ${value} — update the help table if this changed`);
    }
    // And the numbers the help quotes.
    for (const mb of ['150 MB', '100 MB', '200 MB', '250 MB', '1024 MB', '50 MB', '80 MB']) {
        assert.ok(bodies.en.includes(mb), `the help table quotes ${mb}`);
    }
});

check(() => {
    // The conversion threshold is documented as advisory only.
    for (const lang of LANGS) {
        assert.match(bodies[lang], /500 MB/, `${lang} names the conversion-suggestion threshold`);
    }
});

// ─── Per-field Settings help says the consequence ─────────────────────────

check(() => {
    const switching = ['csvFullLoadLimitHelp', 'parquetFullLoadLimitHelp'];
    const warning = ['matlabFullLoadLimitHelp', 'excelFullLoadLimitHelp', 'pickleFullLoadLimitHelp', 'pypsaNetcdfFullLoadLimitHelp'];
    const stillOpens = { en: /still open/i, fr: /s ouvrent quand meme/i, es: /se abren igual/i, it: /si aprono comunque/i };
    const warns = { en: /warned/i, fr: /averti/i, es: /se te avisa/i, it: /avvisato/i };

    for (const lang of LANGS) {
        for (const key of switching) {
            assert.match(translations[lang][key], stillOpens[lang], `${lang}.${key} says the file still opens`);
        }
        for (const key of warning) {
            assert.match(translations[lang][key], warns[lang], `${lang}.${key} says the user is warned, not refused`);
        }
    }
});

console.log(`large-files help: ${checks} checks passed`);
