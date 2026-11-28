// The user manual as a PDF, printed from the manual page
// (scripts/manual/render-manual.mjs) by a headless Chromium, so the PDF is the
// page and never a second copy of it.
//
//   npm run manual:pdf              English, into manual-dist/
//   npm run manual:pdf -- --lang fr
//   npm run manual:pdf -- --out some/dir
//
// Needs a Chromium for Playwright.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { MANUAL_DEFAULT_LANG, MANUAL_LANGS, manualPagePath, renderManual } from './manual/render-manual.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const lang = option('--lang', MANUAL_DEFAULT_LANG);
if (!MANUAL_LANGS.includes(lang)) throw new Error(`Unknown language "${lang}" (${MANUAL_LANGS.join(', ')})`);
const outDir = resolve(root, option('--out', 'manual-dist'));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// The page as the site serves it: the page, its figures and the app icon.
const site = await mkdtemp(join(tmpdir(), 'tse-manual-'));
const browser = await chromium.launch();
try {
    const pageFile = join(site, manualPagePath(lang));
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, renderManual({ lang, version }));
    await cp(join(root, 'public/manual/img'), join(site, 'manual/img'), { recursive: true });
    await cp(join(root, 'public/icons'), join(site, 'icons'), { recursive: true });

    const page = await browser.newPage();
    await page.goto(pathToFileURL(pageFile).href);
    // Figures are lazy; a print needs them all.
    await page.evaluate(() => Promise.all([...document.images].map(image => {
        image.loading = 'eager';
        return image.decode().catch(() => {});
    })));
    await mkdir(outDir, { recursive: true });
    const suffix = lang === MANUAL_DEFAULT_LANG ? '' : `-${lang}`;
    const outFile = join(outDir, `Time-Series-Explorer-${version}-manual${suffix}.pdf`);
    await page.pdf({
        path: outFile,
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    });
    console.log(`Manual written to ${outFile}`);
} finally {
    await browser.close();
    await rm(site, { recursive: true, force: true });
}
