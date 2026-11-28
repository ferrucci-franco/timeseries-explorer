// Captures the figures of the user manual (public/manual/img/*.webp).
//
// Each figure is one bundled example as the app opens it from the Examples
// menu, in the light theme, in English: the list is MANUAL_FIGURES in
// scripts/manual/render-manual.mjs. Run it again when the look of the app has
// changed enough for the figures to mislead: `npm run manual:figures`.
//
// Needs a Chromium for Playwright.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';
import translations from '../src/i18n/translations.js';
import { MANUAL_FIGURES } from './manual/render-manual.mjs';

const outDir = fileURLToPath(new URL('../public/manual/img/', import.meta.url));
const WIDTH = 1280;
const HEIGHT = 800;

await mkdir(outDir, { recursive: true });
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    for (const figure of MANUAL_FIGURES) {
        const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, locale: 'en-US' });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
        if (await page.evaluate(() => !document.body.classList.contains('theme-light'))) {
            await page.click('#theme-toggle');
            await page.waitForFunction(() => document.body.classList.contains('theme-light'));
        }
        await page.click('#welcome-examples-btn');
        await page.getByText(translations.en[figure.example], { exact: true }).first().click();
        await page.waitForFunction(() => window.app.plotManager.files.size >= 1, null, { timeout: 120000 });
        // The example lays its panels out, then its analyses compute.
        await page.waitForLoadState('networkidle');
        await page.waitForFunction(() => !document.querySelector('.analysis-computing-indicator'), null, { timeout: 120000 }).catch(() => {});
        await page.waitForTimeout(6000);
        await page.mouse.move(WIDTH - 5, HEIGHT - 5);
        const png = await page.screenshot();
        await sharp(png).webp({ quality: 82 }).toFile(`${outDir}${figure.file}`);
        console.log(`manual figure: ${figure.file}`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
