// The user manual page is built from the texts of the in-app Help
// (scripts/manual/render-manual.mjs). This fails when the two could drift
// apart: a Help topic the manual does not show, a language without its page,
// a figure whose file or caption is missing, a figure drawn at another size
// than its file, or a link between the pages that goes nowhere.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import translations from '../src/i18n/translations.js';
import { HELP_TOPICS } from '../src/app/help-topics.js';
import {
    MANUAL_DEFAULT_LANG,
    MANUAL_FIGURES,
    MANUAL_FIGURE_SCALE,
    MANUAL_LANGS,
    manualFigureCaption,
    manualFigureSize,
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

// Every figure: one file, of the size the page says, on a topic, with a
// caption in every language; and every topic with a screen to show has one.
const DEVICES = ['desktop', 'phone', 'tablet', 'tablet-portrait'];
// Live Update exists in the desktop edition only: its figure cannot be
// captured from the web build. The last topic is the credits.
const TOPICS_WITHOUT_FIGURE = new Set(['12', '14']);
assert.equal(new Set(MANUAL_FIGURES.map(figure => figure.id)).size, MANUAL_FIGURES.length, 'figure ids are unique');
assert.ok(MANUAL_FIGURES.length >= 22, 'the manual shows the app: at least 22 figures');
const sizes = new Map();
for (const figure of MANUAL_FIGURES) {
    assert.ok(HELP_TOPICS.some(topic => topic.section === figure.section), `figure ${figure.id} belongs to a topic`);
    assert.ok(DEVICES.includes(figure.device), `figure ${figure.id} names its screen`);
    assert.equal(figure.file, `${figure.id}.webp`);
    const path = `${root}public/manual/img/${figure.file}`;
    assert.ok(existsSync(path), `public/manual/img/${figure.file} exists (npm run manual:figures -- --only ${figure.id})`);
    const meta = await sharp(path).metadata();
    assert.equal(meta.format, 'webp', `${figure.file} is a WebP`);
    assert.deepEqual(manualFigureSize(figure), { width: meta.width, height: meta.height }, `${figure.file}: the size read from its header`);
    sizes.set(figure.file, meta);
    assert.ok(statSync(path).size <= 300 * 1024, `${figure.file} stays light (${Math.round(statSync(path).size / 1024)} KB)`);
    if (figure.device === 'phone') assert.ok(meta.height > meta.width, `${figure.file}: a phone is held upright`);
    if (figure.device === 'tablet') assert.ok(meta.width > meta.height, `${figure.file}: a tablet is held sideways`);
    if (figure.device === 'tablet-portrait') assert.ok(meta.height > meta.width, `${figure.file}: this tablet is held upright`);
    for (const lang of MANUAL_LANGS) {
        if (figure.example) assert.ok(translations[lang][figure.example], `${lang}: figure ${figure.id} is captioned by an example name`);
        else assert.ok(translations[lang][`manualFig_${figure.id.replace(/-/g, '_')}`], `${lang}: manualFig_${figure.id.replace(/-/g, '_')} is the caption of figure ${figure.id}`);
        assert.ok(manualFigureCaption(figure, lang).length >= 6, `${lang}: figure ${figure.id} has a caption`);
    }
}
for (const topic of HELP_TOPICS) {
    const count = MANUAL_FIGURES.filter(figure => figure.section === topic.section).length;
    if (!TOPICS_WITHOUT_FIGURE.has(topic.section)) assert.ok(count >= 1, `topic ${topic.section} has a figure`);
}
assert.ok(MANUAL_FIGURES.filter(figure => figure.device === 'phone').length >= 4, 'the phone layout is shown');
assert.ok(MANUAL_FIGURES.filter(figure => figure.device === 'tablet').length >= 2, 'and a tablet held sideways, twice');
// No caption without a figure, and no file nobody shows.
const captionKeys = new Set(MANUAL_FIGURES.filter(figure => !figure.example).map(figure => `manualFig_${figure.id.replace(/-/g, '_')}`));
for (const lang of MANUAL_LANGS) {
    for (const key of Object.keys(translations[lang])) {
        if (key.startsWith('manualFig_')) assert.ok(captionKeys.has(key), `${lang}: ${key} captions a figure of MANUAL_FIGURES`);
    }
}
const files = new Set(MANUAL_FIGURES.map(figure => figure.file));
for (const name of readdirSync(`${root}public/manual/img`)) assert.ok(files.has(name), `public/manual/img/${name} is a figure of the manual`);

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
    const drawn = [...page.html.matchAll(/<figure class="fig-([\w-]+)"><img src="[^"]*\/([^"/]+)" alt="([^"]*)" width="(\d+)" height="(\d+)" style="width: (\d+)px"/g)];
    assert.equal(drawn.length, MANUAL_FIGURES.length, `${page.lang}: every figure`);
    assert.equal((page.html.match(/<figure/g) || []).length, MANUAL_FIGURES.length, `${page.lang}: and nothing else`);
    for (const [, device, file, alt, width, height, shown] of drawn) {
        const figure = MANUAL_FIGURES.find(item => item.file === file);
        assert.ok(figure, `${page.lang}: ${file} is a figure`);
        assert.equal(device, figure.device);
        assert.ok(alt.length >= 6, `${page.lang}: ${file} has a text alternative`);
        assert.deepEqual([Number(width), Number(height)], [sizes.get(file).width, sizes.get(file).height], `${page.lang}: ${file} is drawn with the size of its file`);
        assert.equal(Number(shown), Math.round(sizes.get(file).width / MANUAL_FIGURE_SCALE), `${page.lang}: ${file} is shown at its size on the screen`);
        // Under its own topic.
        const section = page.html.slice(page.html.indexOf(`<section id="topic-${figure.section}">`));
        assert.ok(section.slice(0, section.indexOf('</section>')).includes(`img/${file}"`), `${page.lang}: ${file} is under topic ${figure.section}`);
    }
    // Phone figures are narrow and share rows.
    const phones = MANUAL_FIGURES.filter(figure => figure.device === 'phone').length;
    const rows = [...page.html.matchAll(/<div class="figure-row">([\s\S]*?)<\/div>/g)];
    assert.equal(rows.reduce((sum, row) => sum + (row[1].match(/<figure class="fig-phone">/g) || []).length, 0), phones, `${page.lang}: phone figures are in rows`);

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
