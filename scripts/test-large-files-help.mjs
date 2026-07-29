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
        assert.equal((bodies[lang].match(/<h4>/g) || []).length, 9, `${lang} has all nine sections`);
        assert.match(bodies[lang], /<table/, `${lang} includes the limits table`);
    }
});

check(() => {
    // It has to open by saying what a limit IS. Starting from the table left
    // the reader to work out the concept from a list of settings.
    const opener = { en: /why it exists/i, fr: /pourquoi elle existe/i, es: /por que existe/i, it: /perche esiste/i };
    for (const lang of LANGS) {
        const firstHeading = bodies[lang].slice(bodies[lang].indexOf('<h4>'), bodies[lang].indexOf('</h4>'));
        assert.match(firstHeading, opener[lang], `${lang} opens by explaining what a limit is`);
    }
});

check(() => {
    // The single most important sentence: over the limit is not a refusal.
    const notRefused = { en: /does not mean the file is rejected/i, fr: /ne veut pas dire que le fichier est refuse/i, es: /no significa que el archivo sea rechazado/i, it: /non significa che il file venga rifiutato/i };
    for (const lang of LANGS) {
        assert.match(bodies[lang], notRefused[lang], `${lang} states plainly that a limit is not a refusal`);
    }
});

check(() => {
    // Jargon that a non-technical reader cannot act on. The facts these stood
    // for are still present, in the technical note, in plain words.
    for (const lang of LANGS) {
        for (const jargon of ['file://', 'WebAssembly', 'Web Worker', 'DuckDB', 'columnar', 'address']) {
            assert.ok(!bodies[lang].includes(jargon), `${lang} should not need "${jargon}" to make its point`);
        }
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
    const expected = {
        en: /outliers by upper and lower bounds/i,
        fr: /valeurs aberrantes par bornes haute et basse/i,
        es: /valores atipicos por limites superior e inferior/i,
        it: /outlier per soglie superiore e inferiore/i,
    };
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
    // Reading a file in pieces is NOT desktop-only, which the old text left
    // ambiguous. The section answers the question a reader would actually ask.
    const sameBoth = { en: /same in the browser and in the Full Desktop version/i, fr: /pareil dans le navigateur et dans la version Full Desktop/i, es: /igual en el navegador y en la version Full Desktop/i, it: /stesso modo nel browser e nella versione Full Desktop/i };
    for (const lang of LANGS) {
        assert.match(bodies[lang], sameBoth[lang], `${lang} says it behaves the same in both versions`);
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
        ['audioFullLoadMb', "desktop ? 1024 : 400"],
    ];
    for (const [key, value] of expected) {
        assert.ok(defaults.includes(`${key}: ${value}`), `${key} default is still ${value} — update the help table if this changed`);
    }
    // And the numbers the help quotes.
    for (const mb of ['150 MB', '100 MB', '200 MB', '250 MB', '1024 MB', '50 MB', '80 MB', '400 MB']) {
        assert.ok(bodies.en.includes(mb), `the help table quotes ${mb}`);
    }
});

check(() => {
    // The conversion threshold is documented as advisory only.
    for (const lang of LANGS) {
        assert.match(bodies[lang], /500 MB/, `${lang} names the conversion-suggestion threshold`);
    }
});

check(() => {
    // Who can convert what was genuinely ambiguous, and then genuinely
    // asymmetric: spreadsheets convert in both runtimes, text files only in
    // the desktop one. Saying "conversion is desktop-only" would now be wrong,
    // and saying nothing sends people back to the question they started with.
    const spreadsheetsBoth = {
        en: /Spreadsheets can be converted in either version/i,
        fr: /Les feuilles de calcul peuvent etre converties dans les deux versions/i,
        es: /Las hojas de calculo se pueden convertir en cualquiera de las dos versiones/i,
        it: /I fogli di calcolo si possono convertire in entrambe le versioni/i,
    };
    // The old text said text files could only be converted in the Full Desktop
    // version. The browser converts them too, and had done for a while.
    const textBothVersions = {
        en: 'Both versions can do it',
        fr: 'Les deux versions savent le faire',
        es: 'Las dos versiones pueden hacerlo',
        it: 'Entrambe le versioni possono farlo',
    };
    // And converting a file without opening it, which the help never mentioned.
    const fromTheMenu = {
        en: 'Convert a file to Parquet',
        fr: 'Convertir un fichier en Parquet',
        es: 'Convertir un archivo a Parquet',
        it: 'Converti un file in Parquet',
    };
    for (const lang of LANGS) {
        assert.match(bodies[lang], spreadsheetsBoth[lang], `${lang} says spreadsheets convert in both versions`);
        assert.ok(bodies[lang].includes(textBothVersions[lang]), `${lang} says text files convert in both versions`);
        assert.ok(!/only in the Full Desktop|seulement dans la version Full Desktop|solo en la version Full Desktop|solo nella versione Full Desktop/.test(bodies[lang]),
            `${lang} no longer calls text conversion desktop-only`);
        assert.ok(bodies[lang].includes(fromTheMenu[lang]), `${lang} names the menu entry that converts without opening`);
    }
});

check(() => {
    // The "check the parsing first" step had its own heading added because a
    // reader looking for it could not find it inside a subordinate clause.
    const heading = {
        en: /<h4>You always check the parsing first<\/h4>/,
        fr: /<h4>Vous verifiez toujours l analyse d abord<\/h4>/,
        es: /<h4>Siempre revisas el parseo primero<\/h4>/,
        it: /<h4>Controlli sempre prima il parsing<\/h4>/,
    };
    for (const lang of LANGS) {
        assert.match(bodies[lang], heading[lang], `${lang} gives the parsing check its own section`);
    }
});

check(() => {
    // And it must say WHAT you get to check, not just that you check something.
    const decimal = { en: /decimal mark/i, fr: /marque decimale/i, es: /marca decimal/i, it: /segno decimale/i };
    for (const lang of LANGS) {
        assert.match(bodies[lang], decimal[lang], `${lang} names a concrete thing the preview lets you fix`);
    }
});

// ─── Per-field Settings help says the consequence ─────────────────────────

check(() => {
    const switching = ['csvFullLoadLimitHelp', 'parquetFullLoadLimitHelp'];
    const warning = ['matlabFullLoadLimitHelp', 'excelFullLoadLimitHelp', 'pickleFullLoadLimitHelp', 'pypsaNetcdfFullLoadLimitHelp', 'audioFullLoadLimitHelp'];
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
