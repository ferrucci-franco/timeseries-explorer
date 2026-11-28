// The user manual page is built from the texts of the in-app Help
// (scripts/manual/render-manual.mjs). This fails when the two could drift
// apart: a Help topic the manual does not show, a language without its page,
// a figure whose file is missing, or a link between the pages that goes
// nowhere.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import translations from '../src/i18n/translations.js';
import { HELP_TOPICS } from '../src/app/help-topics.js';
import {
    MANUAL_DEFAULT_LANG,
    MANUAL_FIGURES,
    MANUAL_LANGS,
    manualPagePath,
    renderManualPages,
} from './manual/render-manual.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

assert.deepEqual(MANUAL_LANGS, Object.keys(translations), 'one page per language of the app');
assert.equal(manualPagePath(MANUAL_DEFAULT_LANG), 'manual/index.html');

// Every Help text of the app is a topic of the manual, and the other way round.
const helpSections = Object.keys(translations.en)
    .map(key => /^helpSec(\d+)Body$/.exec(key)?.[1])
    .filter(Boolean)
    .sort();
assert.deepEqual(HELP_TOPICS.map(topic => topic.section).sort(), helpSections, 'HELP_TOPICS lists every helpSec<n>Body');

for (const figure of MANUAL_FIGURES) {
    assert.ok(HELP_TOPICS.some(topic => topic.section === figure.section), `figure ${figure.file} belongs to a topic`);
    assert.ok(existsSync(`${root}public/manual/img/${figure.file}`), `public/manual/img/${figure.file} exists (npm run manual:figures)`);
    assert.ok(translations.en[figure.example], `figure ${figure.file} is captioned by an example name`);
}

const pages = renderManualPages({ version: '9.9.9' });
assert.equal(pages.length, MANUAL_LANGS.length);
const paths = new Set(pages.map(page => page.path));
for (const page of pages) {
    const t = translations[page.lang];
    assert.ok(page.html.startsWith('<!doctype html>'));
    assert.ok(page.html.includes(`<html lang="${page.lang}">`));
    assert.ok(page.html.includes('9.9.9'), 'the page shows the version');
    for (const topic of HELP_TOPICS) {
        assert.ok(page.html.includes(`id="topic-${topic.section}"`), `${page.lang}: topic ${topic.section}`);
        assert.ok(page.html.includes(`href="#topic-${topic.section}"`), `${page.lang}: topic ${topic.section} is in the contents`);
        // The body goes in as written, apart from its headings moving up a level.
        const body = t[`helpSec${topic.section}Body`].replace(/<(\/?)h4(\s|>)/g, '<$1h3$2');
        assert.ok(page.html.includes(body), `${page.lang}: text of topic ${topic.section}`);
    }
    assert.ok(!/<\/?h4[\s>]/.test(page.html), `${page.lang}: no heading skips a level`);
    assert.equal((page.html.match(/<figure>/g) || []).length, MANUAL_FIGURES.length, `${page.lang}: every figure`);

    // Links between the pages, and to the figures, resolve inside manual/.
    const base = new URL(page.path, 'https://site.invalid/');
    for (const [, attribute, target] of page.html.matchAll(/\s(href|src)="([^"#][^"]*)"/g)) {
        if (/^https?:/.test(target)) continue;
        const resolved = new URL(target, base).pathname.replace(/^\//, '');
        if (attribute === 'src') {
            assert.ok(existsSync(`${root}public/${resolved}`), `${page.lang}: ${target} is a file of the site`);
        } else if (resolved.startsWith('manual/')) {
            assert.ok(paths.has(resolved), `${page.lang}: ${target} is a page of the manual`);
        } else {
            assert.ok(resolved === '' || existsSync(`${root}public/${resolved}`), `${page.lang}: ${target} is the app or a file of the site`);
        }
    }
}

console.log(`User manual checks passed (${pages.length} languages, ${HELP_TOPICS.length} topics, ${MANUAL_FIGURES.length} figures).`);
