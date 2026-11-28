// The user manual as a web page, built from the texts of the in-app Help.
//
// The Help (Menu -> Help) is the manual: sixteen topics, in every language of
// the app, kept in src/i18n/translations.js. It could only be read inside the
// app. This module renders the same texts, in the same order, as one static
// page per language, with figures captured from the app itself:
//
//   manual/index.html        English
//   manual/<lang>/index.html the other languages
//   manual/img/*.webp        the figures (public/manual/img, captured by
//                            `npm run manual:figures`)
//
// There is one source. The build writes the pages (vite.config.js), so a
// change to a Help text changes the manual with the next build, and
// `npm run test:manual` fails when a topic, a figure or a language is missing.
import { readFileSync } from 'node:fs';
import translations from '../../src/i18n/translations.js';
import { HELP_TOPICS } from '../../src/app/help-topics.js';

export const MANUAL_LANGS = Object.keys(translations);
export const MANUAL_DEFAULT_LANG = 'en';

// What each language calls itself, for the language links of the page.
const LANG_NAMES = { en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', zh: '中文' };

// A figure is a capture of the real app, shown under the topic it
// illustrates. Each has an `id` (its file is `<id>.webp`) and one of:
//
//   example  the key of a bundled example: the figure is that example as the
//            Examples menu opens it, and its caption is built from the app's
//            own labels ("Examples -> Lorenz Attractor"), which is also how to
//            get the same screen;
//   (none)   a scripted scene of the same id in
//            scripts/capture-manual-figures.mjs, which drives the app to the
//            state shown; its caption is the text `manualFig_<id>` of
//            src/i18n/translations.js, in every language.
//
// `device` is the screen it was captured on: 'desktop' (the default,
// 1280 x 800 unless the scene asks for another size), 'phone' (upright),
// 'tablet' (sideways) or 'tablet-portrait'. The phone and the tablets are
// Playwright's own device profiles, touch included, so a figure shows what
// that device really gets. Phone figures are drawn narrow, side by side.
export const MANUAL_FIGURES = [
    { section: '1', id: 'welcome' },
    { section: '1', id: 'pendulum', example: 'examplePendulum' },
    { section: '2', id: 'csv-preview' },
    { section: '2', id: 'era5-map', example: 'exampleEra5Argentina' },
    { section: '3', id: 'modelica-tree' },
    { section: '4', id: 'sidebar-filter' },
    { section: '5', id: 'right-axis' },
    { section: '5', id: 'marks-gaps' },
    { section: '5', id: 'dashboard' },
    { section: '15', id: 'time-axis' },
    { section: '6', id: 'fft', example: 'exampleNoisyChirpFourierTransform' },
    { section: '6', id: 'histogram' },
    { section: '6', id: 'heatmap' },
    { section: '6', id: 'temporal-profile', example: 'examplePowergridTimeseries' },
    { section: '6', id: 'integral' },
    { section: '6', id: 'curve-fit-time' },
    { section: '6', id: 'trend' },
    { section: '6', id: 'curve-fit', example: 'exampleCorrelationCurveFitting' },
    { section: '7', id: 'lorenz', example: 'exampleLorenz' },
    { section: '8', id: 'cursors' },
    { section: '8', id: 'statistics' },
    { section: '9', id: 'compare-runs' },
    { section: '10', id: 'data-tools' },
    { section: '10', id: 'digital-filter' },
    { section: '10', id: 'derived-editor' },
    { section: '11', id: 'memory-saving' },
    { section: '13', id: 'export-dialog' },
    { section: '16', id: 'phone-plot', device: 'phone' },
    { section: '16', id: 'phone-data', device: 'phone' },
    { section: '16', id: 'phone-plot-sheet', device: 'phone' },
    { section: '16', id: 'phone-analyze', device: 'phone' },
    { section: '16', id: 'phone-map', device: 'phone' },
    { section: '16', id: 'phone-tools', device: 'phone' },
    { section: '16', id: 'tablet', device: 'tablet' },
    { section: '16', id: 'tablet-map', device: 'tablet' },
    { section: '16', id: 'tablet-portrait', device: 'tablet-portrait' },
].map(figure => ({ device: 'desktop', file: `${figure.id}.webp`, ...figure }));

// Captures are saved at twice the size they have on the screen, so a figure
// is never drawn wider than half its pixels.
export const MANUAL_FIGURE_SCALE = 2;

const figureDir = new URL('../../public/manual/img/', import.meta.url);

/**
 * The pixel size of a WebP file, read from its header: the three layouts a
 * WebP can have (lossy, lossless, extended). Null when the file is missing.
 */
export function webpSize(url) {
    let bytes;
    try {
        bytes = readFileSync(url);
    } catch (_) {
        return null;
    }
    if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
    const kind = bytes.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    return null;
}

/** The size of a figure's file, in pixels. */
export function manualFigureSize(figure) {
    const size = webpSize(new URL(figure.file, figureDir));
    if (!size) throw new Error(`manual: public/manual/img/${figure.file} is missing or not a WebP (npm run manual:figures)`);
    return size;
}

/** A figure's caption in one language. */
export function manualFigureCaption(figure, lang) {
    if (figure.example) return `${text(lang, 'welcomeExamples')} → ${text(lang, figure.example)}`;
    return text(lang, `manualFig_${figure.id.replace(/-/g, '_')}`);
}

function figureHtml(figure, lang, root) {
    const caption = manualFigureCaption(figure, lang);
    const { width, height } = manualFigureSize(figure);
    const shown = Math.round(width / MANUAL_FIGURE_SCALE);
    return `<figure class="fig-${figure.device}"><img src="${root}img/${figure.file}" alt="${escapeHtml(caption)}" width="${width}" height="${height}" style="width: ${shown}px" loading="lazy"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

// The figures of a topic. Phone figures that follow one another share a row.
function figuresHtml(section, lang, root) {
    const out = [];
    let row = null;
    for (const figure of MANUAL_FIGURES.filter(item => item.section === section)) {
        const html = figureHtml(figure, lang, root);
        if (figure.device !== 'phone') {
            row = null;
            out.push(html);
        } else if (row) {
            row.push(html);
        } else {
            row = [html];
            out.push(row);
        }
    }
    return out.map(item => (Array.isArray(item) ? `<div class="figure-row">\n${item.join('\n')}\n</div>` : item)).join('\n');
}

const escapeHtml = value => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(lang, key) {
    const value = translations[lang]?.[key];
    if (typeof value !== 'string' || !value) throw new Error(`manual: no "${key}" text in "${lang}"`);
    return value;
}

// The Help texts use <h4> under the dialog's own <h3> topic title. On the page
// a topic is an <h2>, so its sub-headings become <h3>.
const promoteHeadings = html => html.replace(/<(\/?)h4(\s|>)/g, '<$1h3$2');

export function manualPagePath(lang) {
    return lang === MANUAL_DEFAULT_LANG ? 'manual/index.html' : `manual/${lang}/index.html`;
}

const STYLE = `
:root { --bg: #ffffff; --fg: #1f2933; --muted: #5b6770; --line: #d9dee3; --accent: #1d6fd6; --soft: #f3f6f9; --code: #eef1f4; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181b; --fg: #e6e9ec; --muted: #9aa5ae; --line: #343a40; --accent: #6db3ff; --soft: #1f2327; --code: #262b30; }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; }
a { color: var(--accent); }
.page { display: grid; grid-template-columns: 17rem minmax(0, 46rem); gap: 3rem; max-width: 68rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header.top { grid-column: 1 / -1; border-bottom: 1px solid var(--line); padding-bottom: 1rem; }
header.top h1 { margin: 0 0 .25rem; font-size: 1.9rem; line-height: 1.2; }
header.top p { margin: 0; color: var(--muted); }
.langs { margin-top: .6rem; display: flex; flex-wrap: wrap; gap: .25rem .9rem; font-size: .95rem; }
.langs [aria-current] { font-weight: 600; color: var(--fg); text-decoration: none; }
nav.toc { position: sticky; top: 1rem; align-self: start; max-height: calc(100vh - 2rem); overflow: auto; font-size: .95rem; }
nav.toc ol { list-style: none; margin: 0; padding: 0; counter-reset: topic; }
nav.toc li { counter-increment: topic; margin: .15rem 0; }
nav.toc a { display: block; padding: .2rem .4rem; border-radius: 4px; text-decoration: none; color: var(--fg); }
nav.toc a::before { content: counter(topic) ". "; color: var(--muted); }
nav.toc a:hover { background: var(--soft); }
main section { padding-top: .5rem; margin-bottom: 2.5rem; }
main h2 { font-size: 1.45rem; line-height: 1.25; margin: 0 0 .75rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
main h3 { font-size: 1.08rem; margin: 1.5rem 0 .4rem; }
main p, main ul, main ol { margin: .5rem 0 .8rem; }
main li { margin: .25rem 0; }
code { background: var(--code); border-radius: 3px; padding: .05em .3em; font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.help-callout { background: var(--soft); border-left: 4px solid var(--accent); padding: .7rem 1rem; border-radius: 0 4px 4px 0; margin: 1rem 0; }
.table-wrap, .supported-formats-table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .93rem; margin: .8rem 0; }
th, td { border: 1px solid var(--line); padding: .4rem .55rem; text-align: left; vertical-align: top; }
th { background: var(--soft); }
figure { margin: 1.2rem 0 1.6rem; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
figcaption { color: var(--muted); font-size: .9rem; margin-top: .4rem; }
.figure-row { display: flex; flex-wrap: wrap; gap: 1rem 1.25rem; align-items: flex-start; margin: 1.2rem 0 1.6rem; }
.figure-row figure { margin: 0; flex: 0 1 220px; min-width: 0; }
figure.fig-phone { max-width: 300px; }
figure.fig-phone img { width: 100% !important; }
figure.fig-tablet-portrait { max-width: 460px; }
.help-usecases li { margin: .4rem 0; }
footer { grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 1rem; color: var(--muted); font-size: .9rem; }
@media (max-width: 860px) {
  .page { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; }
  nav.toc { position: static; max-height: none; border: 1px solid var(--line); border-radius: 6px; padding: .6rem; }
}
@media print {
  :root { --bg: #fff; --fg: #000; --muted: #444; --line: #bbb; --accent: #1d4f91; --soft: #f2f2f2; --code: #f0f0f0; }
  body { font-size: 10.5pt; }
  .page { display: block; max-width: none; padding: 0; }
  .langs { display: none; }
  nav.toc { position: static; max-height: none; overflow: visible; margin: 1rem 0 0; page-break-after: always; }
  main h2 { page-break-after: avoid; }
  main h3 { page-break-after: avoid; }
  figure, table, .help-callout { page-break-inside: avoid; }
  .figure-row { gap: .6rem; }
  .figure-row figure { flex-basis: 150px; }
  figure.fig-desktop img, figure.fig-tablet img, figure.fig-tablet-portrait img { max-height: 105mm; width: auto !important; }
  a { color: inherit; text-decoration: none; }
}
`;

/**
 * The manual page of one language, as a complete HTML document.
 * `version` is the app version shown under the title.
 */
export function renderManual({ lang = MANUAL_DEFAULT_LANG, version = '' } = {}) {
    if (!translations[lang]) throw new Error(`manual: unknown language "${lang}"`);
    const isDefault = lang === MANUAL_DEFAULT_LANG;
    const root = isDefault ? '' : '../';   // from this page to manual/
    const appUrl = `${root}../`;           // from this page to the app

    const toc = [];
    const sections = [];
    for (const topic of HELP_TOPICS) {
        const id = `topic-${topic.section}`;
        const title = text(lang, `helpSec${topic.section}Title`);
        const figures = figuresHtml(topic.section, lang, root);
        toc.push(`<li><a href="#${id}">${escapeHtml(title)}</a></li>`);
        sections.push(`<section id="${id}">\n<h2>${escapeHtml(title)}</h2>\n${promoteHeadings(text(lang, `helpSec${topic.section}Body`))}\n${figures}\n</section>`);
    }
    // The list of supported formats is a dialog of its own in the app (the
    // "more!" link of the top bar); in the manual it is the last topic.
    const formatsTitle = text(lang, 'supportedFormatsTitle');
    toc.push(`<li><a href="#topic-formats">${escapeHtml(formatsTitle)}</a></li>`);
    sections.push(`<section id="topic-formats">\n<h2>${escapeHtml(formatsTitle)}</h2>\n${promoteHeadings(text(lang, 'supportedFormatsBody'))}\n</section>`);

    const langLinks = MANUAL_LANGS.map(code => {
        const href = code === MANUAL_DEFAULT_LANG ? `${root}index.html` : `${root}${code}/index.html`;
        const current = code === lang ? ' aria-current="page"' : '';
        return `<a href="${href}" lang="${code}" hreflang="${code}"${current}>${escapeHtml(LANG_NAMES[code] || code)}</a>`;
    }).join('\n');

    const title = `Time Series Explorer — ${text(lang, 'manualTitle')}`;
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(text(lang, 'helpSec1Title'))} — Time Series Explorer">
<link rel="icon" href="${appUrl}icons/app-icon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<header class="top">
<h1>${escapeHtml(title)}</h1>
<p>Time Series Explorer${version ? ` ${escapeHtml(version)}` : ''} · <a href="${appUrl}">www.unditas.com</a> · <a href="https://github.com/ferrucci-franco/timeseries-explorer">GitHub</a></p>
<div class="langs">
${langLinks}
</div>
</header>
<nav class="toc" aria-label="${escapeHtml(title)}">
<ol>
${toc.join('\n')}
</ol>
</nav>
<main>
${sections.join('\n')}
</main>
<footer>Time Series Explorer${version ? ` ${escapeHtml(version)}` : ''} — Franco Ferrucci — MIT License</footer>
</div>
</body>
</html>
`;
}

/** Every page of the manual: `[{ path, lang, html }]`, paths relative to the site root. */
export function renderManualPages({ version = '' } = {}) {
    return MANUAL_LANGS.map(lang => ({ lang, path: manualPagePath(lang), html: renderManual({ lang, version }) }));
}
