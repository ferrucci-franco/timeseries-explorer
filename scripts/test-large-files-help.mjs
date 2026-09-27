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
    // The CSV limit is 300 MB in BOTH runtimes. The old text implied desktop
    // raises everything.
    for (const lang of LANGS) {
        assert.match(bodies[lang], /<td>CSV and text files<\/td><td>300 MB<\/td><td>300 MB<\/td>/, `${lang} shows the CSV limit as equal in both runtimes`);
        assert.match(bodies[lang], /300 MB/, `${lang} quotes it in the desktop section too`);
        assert.doesNotMatch(bodies[lang], /<td>CSV and text files<\/td><td>150 MB/, `${lang} no longer quotes the old default`);
    }
});

check(() => {
    // What Data Tools offers in memory-saving mode, which used to be one
    // operation and was documented nowhere; now four, and the help says which.
    const expected = {
        en: /outliers by upper and lower bounds/i,
        fr: /valeurs aberrantes par bornes haute et basse/i,
        es: /valores atipicos por limites superior e inferior/i,
        it: /outlier per soglie superiore e inferiore/i,
    };
    for (const lang of LANGS) {
        assert.match(bodies[lang], expected[lang], `${lang} states the Data Tools restriction`);
    }
    // And no longer claims derivative and integral are missing there.
    const stale = {
        en: /Derivative, integral, moving average and the automatic spike detectors all need every point/,
        fr: /Derivee, integrale, moyenne glissante et les detecteurs automatiques de pics ont besoin/,
        es: /Derivada, integral, media movil y los detectores automaticos de picos necesitan/,
        it: /Derivata, integrale, media mobile e i rilevatori automatici di picchi hanno bisogno/,
    };
    const offered = { en: /Derivative, Integral, Detrend/, fr: /Derivee, Integrale, Detendancer/, es: /Derivada, Integral, Quitar tendencia/, it: /Derivata, Integrale, Rimuovere la tendenza/ };
    for (const lang of LANGS) {
        assert.doesNotMatch(bodies[lang], stale[lang], `${lang} drops the outdated list of missing tools`);
        assert.match(bodies[lang], offered[lang], `${lang} names the tools that do work`);
    }
});

check(() => {
    // Which limits are warnings and which are not, said in so many words.
    const notWarning = { en: /the limit is not a warning/, fr: /la limite n est pas un avertissement/, es: /el limite no es un aviso/, it: /il limite non e un avviso/ };
    const onlyWarning = { en: /the limit is only a warning/, fr: /la limite n est qu un avertissement/, es: /el limite es solo un aviso/, it: /il limite e solo un avviso/ };
    for (const lang of LANGS) {
        assert.match(bodies[lang], notWarning[lang], `${lang} says text and Parquet are not warned about`);
        assert.match(bodies[lang], onlyWarning[lang], `${lang} says the other formats' limit is only a warning`);
    }
});

check(() => {
    // Zero: no limit, for both kinds, with what each does when the file does
    // not fit — and the ceilings zero does not lift.
    const zero = { en: /<b>0 means no limit<\/b>/, fr: /<b>0 veut dire aucune limite<\/b>/, es: /<b>0 significa sin limite<\/b>/, it: /<b>0 significa nessun limite<\/b>/ };
    const fallsBack = { en: /if it does not fit, the app opens it a piece at a time/, fr: /s il ne tient pas, l app l ouvre d elle-meme morceau par morceau/, es: /si no entra, la app lo abre sola de a partes/, it: /se non entra, l app lo apre da sola un pezzo alla volta/ };
    const onlyMemory = { en: /the only limit left is your computer's memory/, fr: /la seule limite restante est la memoire/, es: /el unico limite que queda es la memoria/, it: /l unico limite che resta e la memoria/ };
    for (const lang of LANGS) {
        assert.match(bodies[lang], zero[lang], `${lang} says what 0 means`);
        assert.match(bodies[lang], fallsBack[lang], `${lang} says text and Parquet fall back when they do not fit`);
        assert.match(bodies[lang], onlyMemory[lang], `${lang} says memory is the only limit left for the others`);
        assert.match(bodies[lang], /1[.,]5 G[Bo]/, `${lang} names the MAT ceiling`);
        assert.match(bodies[lang], /512 M[Bo]/, `${lang} names the pickle array ceiling`);
        assert.match(bodies[lang], /2 G[Bo]/, `${lang} names the desktop read ceiling`);
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
        ['csvFullLoadMb', '300'],
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
    for (const mb of ['300 MB', '150 MB', '100 MB', '200 MB', '250 MB', '1024 MB', '50 MB', '80 MB', '400 MB']) {
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
            assert.match(translations[lang][key], /\b0\b/, `${lang}.${key} says what 0 does`);
        }
        for (const key of warning) {
            assert.match(translations[lang][key], /\b0\b/, `${lang}.${key} says what 0 does`);
        }
        for (const key of ['fileOverLimitBody', 'fileOverLimitAudioBody']) {
            assert.match(translations[lang][key], /\{setting\}, [^"]*\b0\b/, `${lang}.${key} offers 0 at the moment of the warning`);
        }
        assert.match(translations[lang].lazyFileNoticeBodyMemory, /\{file\}/, `${lang} has the notice for a file that did not fit`);
        for (const key of warning) {
            assert.match(translations[lang][key], warns[lang], `${lang}.${key} says the user is warned, not refused`);
        }
    }
});

console.log(`large-files help: ${checks} checks passed`);
