// The desktop spellchecker's language, and the menu that changes it (#41).
//
// The desktop build removes the application menu at startup and had no context
// menu of its own, so the dictionary Electron picked from the OS locale was
// final: writing English on a French machine underlined every word, with no
// way to say otherwise. Chrome's own right-click "Languages" does not exist
// here, so the app has to provide it.
//
// The decision logic is a plain .cjs module with no Electron in it, so it is
// tested directly; the wiring around it is asserted against main.cjs, which
// cannot be imported without an Electron runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
    DEFAULT_SPELLCHECK_LANGUAGE,
    SPELLCHECK_LANGUAGES,
    baseLanguage,
    normalizeSpellcheckLanguage,
    resolveSpellcheckLanguage,
    spellcheckMenuItems,
    spellcheckerCodesFor,
} = require('../electron/spellcheck-languages.cjs');

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// ── The four languages are the app's four, named in themselves ──────────────
assert.deepEqual(SPELLCHECK_LANGUAGES.map(item => item.code), ['en', 'fr', 'es', 'it'],
    'the menu offers exactly the languages the app ships');
assert.deepEqual(SPELLCHECK_LANGUAGES.map(item => item.label),
    ['English', 'Français', 'Español', 'Italiano'],
    'each is named in itself — a language menu you must already read to use is no menu');

// Every offered language must exist in the translations, or the menu could
// offer a dictionary for a UI the app cannot present.
const translations = read('src/i18n/translations.js');
for (const key of ['spellcheckLanguageMenu', 'spellcheckAddToDictionary', 'spellcheckNoSuggestions']) {
    assert.equal((translations.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 4,
        `${key} is translated in all four languages`);
}

// ── Tags in, one of ours out ────────────────────────────────────────────────
assert.equal(baseLanguage('fr-CA'), 'fr');
assert.equal(baseLanguage('EN_US'), 'en');
assert.equal(baseLanguage(''), '');
assert.equal(baseLanguage(null), '');

assert.equal(normalizeSpellcheckLanguage('es-419'), 'es', 'a regional tag is still its language');
assert.equal(normalizeSpellcheckLanguage('IT'), 'it', 'case does not matter');
assert.equal(normalizeSpellcheckLanguage('de-DE'), null, 'a language the app does not ship is not offered');
assert.equal(normalizeSpellcheckLanguage(undefined), null);

// ── Which language to check in ──────────────────────────────────────────────
// A choice made by hand is a setting: it outranks the UI and keeps outranking
// it, which is the whole difference between this and the behaviour reported.
assert.equal(resolveSpellcheckLanguage({ stored: 'it', uiLanguage: 'es', appLocale: 'fr-FR' }), 'it');
// With no choice made, the app's own language is the best guess about what is
// about to be typed — better than the OS locale, which is the reported bug.
assert.equal(resolveSpellcheckLanguage({ uiLanguage: 'es', appLocale: 'fr-FR' }), 'es');
assert.equal(resolveSpellcheckLanguage({ appLocale: 'fr-FR' }), 'fr', 'then the OS');
assert.equal(resolveSpellcheckLanguage({}), DEFAULT_SPELLCHECK_LANGUAGE, 'then English');
// Junk at any level falls through rather than winning.
assert.equal(resolveSpellcheckLanguage({ stored: 'de', uiLanguage: 'es' }), 'es');
assert.equal(resolveSpellcheckLanguage({ stored: null, uiLanguage: '', appLocale: 'zz' }), 'en');

// ── Which dictionary code to ask Electron for ───────────────────────────────
assert.deepEqual(spellcheckerCodesFor('es', ['en-US', 'es-ES', 'fr-FR']), ['es-ES'],
    'the preferred regional code when the machine has it');
assert.deepEqual(spellcheckerCodesFor('fr', ['en-US', 'fr-CA']), ['fr-CA'],
    'another region of the same language rather than nothing');
assert.deepEqual(spellcheckerCodesFor('it', ['en-US', 'fr-FR']), [],
    'nothing at all when the machine has no dictionary for it');
assert.deepEqual(spellcheckerCodesFor('de', ['de-DE']), [],
    'a language the app does not offer is never set');
assert.deepEqual(spellcheckerCodesFor('en', []), ['en-US'],
    'an empty list means "cannot tell", not "has none"');

// ── The menu ────────────────────────────────────────────────────────────────
const items = spellcheckMenuItems('fr', ['en-US', 'fr-FR', 'es-MX']);
assert.deepEqual(items.map(item => item.code), ['en', 'fr', 'es', 'it'], 'always all four, in order');
assert.deepEqual(items.map(item => item.checked), [false, true, false, false], 'exactly one is ticked');
assert.deepEqual(items.map(item => item.enabled), [true, true, true, false],
    'a dictionary this machine lacks is shown greyed out, not hidden');
assert.equal(spellcheckMenuItems('de', ['en-US']).filter(item => item.checked).length, 1,
    'an unknown current language still leaves one item ticked');

// ── Wiring ──────────────────────────────────────────────────────────────────
const main = read('electron/main.cjs');
assert.match(main, /win\.webContents\.on\('context-menu'/,
    'the window gets a context menu — without it there is no way to change anything');
assert.match(main, /if \(!params\.isEditable\) return;/,
    'only on a text field: a right-click on a plot is Plotly’s business');
assert.match(main, /replaceMisspelling\(suggestion\)/, 'the suggestions are clickable');
assert.match(main, /addWordToSpellCheckerDictionary\(params\.misspelledWord\)/,
    'a word the dictionary lacks can be taught');
// Setting a code the machine does not have throws, and a window that dies
// because a dictionary is missing is far worse than one that does not check.
assert.match(main, /if \(!codes\.length\) return spellcheckLanguage;/,
    'an unavailable dictionary is never set');
assert.match(main, /process\.platform !== 'darwin'/,
    'macOS runs the OS spellchecker, where setSpellCheckerLanguages is a no-op');
// The stored choice must win over the renderer's language push, or the setting
// would be undone by the next language switch.
assert.match(main, /if \(readDesktopSettings\(\)\.spellcheckLanguage\) return;/,
    'a stored choice is not overwritten by the UI language');
assert.match(main, /settings\.spellcheckLanguage = language;/, 'and the choice is written down');
assert.match(main, /spellcheck: true,/, 'the web contents actually spell-check');

// ── The menu it actually builds ─────────────────────────────────────────────
// installSpellcheckContextMenu needs an Electron runtime, which this suite does
// not have. Slice it out and run it against doubles — the technique
// test-fft-clean-range.mjs uses for a method that imports Plotly — so what the
// menu contains is checked rather than only the source text that produces it.
const openMenu = ({ params, available = ['en-US', 'fr-FR', 'es-ES'], language = 'en', labels = {} }) => {
    const startMarker = 'function installSpellcheckContextMenu(win) {';
    const start = main.indexOf(startMarker);
    assert.ok(start >= 0, 'installSpellcheckContextMenu is present');
    // To its own closing brace at column zero, never to whatever follows it.
    const end = main.indexOf('\n}', start);
    assert.ok(end > start, 'its end is findable');
    const source = main.slice(start, end + 2);

    const calls = { replaced: [], added: [], applied: [], written: [], popped: [] };
    let template = null;
    let handler = null;
    const win = {
        isDestroyed: () => false,
        webContents: {
            on: (name, fn) => { if (name === 'context-menu') handler = fn; },
            replaceMisspelling: text => calls.replaced.push(text),
            session: {
                availableSpellCheckerLanguages: available,
                addWordToSpellCheckerDictionary: word => calls.added.push(word),
            },
        },
    };
    vm.runInNewContext(`${source}\ninstallSpellcheckContextMenu(win);`, {
        win,
        console,
        SPELLCHECK_SUPPORTED: true,
        spellcheckLanguage: language,
        rendererSpellcheckState: { uiLanguage: '', labels },
        spellcheckMenuItems,
        applySpellcheckLanguage: (_win, code) => { calls.applied.push(code); return code; },
        writeSpellcheckLanguage: code => calls.written.push(code),
        Menu: {
            buildFromTemplate: (items) => {
                template = items;
                return { popup: () => calls.popped.push(true) };
            },
        },
    });
    assert.ok(handler, 'the handler is registered on the window');
    handler({}, params);
    return { template, ...calls };
};

// Arrays built inside the vm carry that realm's Array prototype, which
// deepStrictEqual compares and rejects. Read the values out into this one.
const fieldOf = (items, key) => Array.from(items, item => item[key]);

// A right-click on something that is not a text field opens nothing: that is
// Plotly's own menu, or the page's.
{
    const menu = openMenu({ params: { isEditable: false, misspelledWord: 'teh' } });
    assert.equal(menu.template, null, 'no menu outside an editable field');
    assert.equal(menu.popped.length, 0);
}

// A misspelled word with suggestions: the suggestions come first, each one
// clickable, then the way to teach the dictionary.
{
    const menu = openMenu({
        params: {
            isEditable: true,
            misspelledWord: 'teh',
            dictionarySuggestions: ['the', 'tech'],
            editFlags: { canCut: true, canCopy: true, canPaste: true },
        },
        labels: { spellcheckAddToDictionary: 'Agregar al diccionario', spellcheckLanguageMenu: 'Idioma del corrector' },
    });
    assert.deepEqual(fieldOf(menu.template.slice(0, 2), 'label'), ['the', 'tech'],
        'the suggestions lead');
    menu.template[1].click();
    assert.deepEqual(menu.replaced, ['tech'], 'and clicking one replaces the word');

    const add = Array.from(menu.template).find(item => item.label === 'Agregar al diccionario');
    assert.ok(add, 'the labels the renderer sent are the ones used');
    add.click();
    assert.deepEqual(menu.added, ['teh'], 'and it teaches the word that was flagged');

    assert.deepEqual(
        fieldOf(Array.from(menu.template).filter(item => item.role), 'role'),
        ['cut', 'copy', 'paste', 'selectAll'],
        'a right-click menu on a text field still offers the edit actions');
    assert.equal(menu.popped.length, 1, 'and it is actually shown');
}

// A misspelling the dictionary has no suggestion for still says something,
// rather than opening a menu that begins with "Add to dictionary" alone.
{
    const menu = openMenu({
        params: { isEditable: true, misspelledWord: 'qwertyuiop', dictionarySuggestions: [], editFlags: {} },
        labels: { spellcheckNoSuggestions: 'Sin sugerencias' },
    });
    const first = menu.template[0];
    assert.equal(first.label, 'Sin sugerencias');
    assert.equal(first.enabled, false, 'it is a statement, not a thing to click');
}

// No misspelling at all: no suggestion block, but the language submenu is the
// point of the menu and must be reachable without one.
{
    const menu = openMenu({
        params: { isEditable: true, misspelledWord: '', dictionarySuggestions: [], editFlags: {} },
        language: 'fr',
    });
    assert.equal(Array.from(menu.template).filter(item => item.label === 'No suggestions').length, 0);
    const submenu = Array.from(menu.template).find(item => item.submenu)?.submenu;
    assert.deepEqual(fieldOf(submenu, 'label'), ['English', 'Français', 'Español', 'Italiano']);
    assert.deepEqual(fieldOf(submenu, 'type'), ['radio', 'radio', 'radio', 'radio'],
        'radios: one language is in use, not several');
    assert.deepEqual(fieldOf(submenu, 'checked'), [false, true, false, false],
        'the one in use is ticked');
    assert.deepEqual(fieldOf(submenu, 'enabled'), [true, true, true, false],
        'Italiano is greyed out because this machine has no Italian dictionary');

    submenu[2].click();
    assert.deepEqual(menu.applied, ['es'], 'choosing one applies it');
    assert.deepEqual(menu.written, ['es'], 'and writes it down, so it survives a restart');
}

// Fallback labels: a desktop window whose renderer has not reported yet still
// produces a usable menu rather than "undefined".
{
    const menu = openMenu({
        params: { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: [], editFlags: {} },
    });
    assert.deepEqual(
        fieldOf(Array.from(menu.template).filter(item => item.label), 'label').slice(0, 2),
        ['No suggestions', 'Add to dictionary']);
    assert.equal(Array.from(menu.template).find(item => item.submenu).label, 'Spelling language');
}

const preload = read('electron/preload.cjs');
assert.match(preload, /setSpellcheck: payload => ipcRenderer\.send\('omv:set-spellcheck'/,
    'the renderer can reach it');

const app = read('src/app/viewer-app.js');
assert.match(app, /setLanguage\(lang\)[\s\S]*?_syncSpellcheckLanguage\(\)/,
    'switching the app language re-syncs the spellchecker');
assert.match(app, /_syncSpellcheckLanguage\(\)\s*\{[\s\S]*?document\.documentElement\.lang = i18n\.currentLang;/,
    'the document says which language it is in — the web build has no other signal');
assert.match(app, /_syncSpellcheckLanguage\(\)\s*\{[\s\S]*?window\.omvDesktop\?\.setSpellcheck\?\./,
    'and the desktop is told, when there is one');
for (const key of ['spellcheckLanguageMenu', 'spellcheckAddToDictionary', 'spellcheckNoSuggestions']) {
    assert.match(app, new RegExp(`${key}: i18n\\.t\\('${key}'\\)`), `${key} travels to the menu`);
}

console.log('Desktop spellcheck checks passed.');
