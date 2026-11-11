// End-to-end check of the animated guide (src/ui/guide.js), in a real browser.
//
// Each demo of the guide is a script that drives the real app inside a frame:
// it looks for buttons, menus and lists where they are today. So a demo is the
// first thing to break when a toolbar is rearranged — silently, since nothing
// else depends on it. This plays every demo to its end, fast, and fails on the
// first one that cannot find what it was going to click.
//
// It also checks what the guide promises about its frame: the app in it is in
// demo mode (src/app/demo-mode.js) and leaves nothing in the browser's storage.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:guide`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

import { GUIDE_CHAPTERS } from '../src/ui/guide-chapters.js';

// Times the pace of a person. Waits for the app itself (a file parsed, a plot
// drawn) are not shortened.
const SPEED = 6;
const DEMO_TIMEOUT_MS = 90000;

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 880 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // The page-view counter is a third-party script; a test does not call it.
    await page.route(url => !url.href.startsWith(baseUrl), route => route.abort());
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });

    // ── The way in: Menu → Animated guide, and from the Help window ──
    await page.click('#extra-menu-btn');
    await page.click('#extra-menu [data-action="extraGuide"]');
    await page.waitForSelector('.guide-back.open .guide-item');
    assert.equal(await page.locator('.guide-item').count(), GUIDE_CHAPTERS.length, 'one entry per demo');
    assert.deepEqual(
        await page.locator('.guide-item .guide-name').allTextContents(),
        GUIDE_CHAPTERS.map(chapter => chapter.t.en));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.guide-back').count(), 0, 'Escape closes the guide');

    await page.evaluate(() => window.app.showHelp());
    await page.click('.help-guide-link');
    await page.waitForSelector('.guide-back.open');
    assert.equal(await page.locator('.help-backdrop').count(), 0, 'the Help window makes room for the guide');
    await page.click('.guide-x');

    const storageBefore = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));

    // ── Every demo, to its end ──
    for (const chapter of GUIDE_CHAPTERS) {
        await page.evaluate(({ id, speed }) => {
            const app = window.app;
            app.openGuide(id);
            app._guide.speed = speed;
            app._guide.loops = 0;
            app._guide.lastError = null;
        }, { id: chapter.id, speed: SPEED });
        const started = Date.now();
        let state;
        // Seen at some point of the run: at its end the frame is already
        // loading again for the next loop.
        let sawDemoMode = false;
        for (;;) {
            await page.waitForTimeout(250);
            state = await page.evaluate(() => {
                const guide = window.app._guide;
                const frame = document.querySelector('.guide iframe')?.contentWindow;
                return {
                    loops: guide.loops,
                    error: guide.lastError ? String(guide.lastError.stack || guide.lastError) : '',
                    caption: guide.cap?.textContent || '',
                    demo: !!frame?.document?.documentElement?.classList.contains('demo'),
                    frameUrl: frame?.location?.search || '',
                };
            });
            sawDemoMode ||= state.demo && /[?&]demo(&|$)/.test(state.frameUrl);
            if (state.error || state.loops > 0) break;
            assert.ok(Date.now() - started < DEMO_TIMEOUT_MS, `${chapter.id}: did not finish (last caption: "${state.caption}")`);
        }
        assert.equal(state.error, '', `${chapter.id}: stopped at "${state.caption}"`);
        assert.equal(sawDemoMode, true, `${chapter.id}: the frame is the app in demo mode`);
        assert.equal(
            await page.locator('.guide-item.on .guide-name').textContent(), chapter.t.en,
            `${chapter.id}: opened by its id`);
        await page.evaluate(() => window.app._guide.close());
        console.log(`  ${chapter.id}: ok (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }

    // The demos loaded files, split panels and changed settings — in the frame.
    // Neither the browser's storage nor the app around the guide saw any of it.
    assert.equal(
        await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort())), storageBefore,
        'the demos leave the browser storage as it was');
    assert.equal(await page.evaluate(() => window.app.files.size), 0, 'the app around the guide has no file');

    // ── The frame speaks the language and wears the theme of the app ──
    await page.evaluate(() => { window.app.setLanguage('es'); window.app.applyTheme('dark'); window.app.openGuide('fft'); });
    await page.waitForFunction(() => {
        const frame = document.querySelector('.guide iframe')?.contentWindow;
        return frame?.app && frame.document.body.classList.contains('theme-dark') && frame.app.language === 'es';
    }, null, { timeout: 30000 });
    assert.equal(await page.locator('.guide-head h2').textContent(), 'Guía animada');
    await page.evaluate(() => window.app._guide.close());

    // ── Not offered inside its own frame ──
    const inner = await context.newPage();
    await inner.route(url => !url.href.startsWith(baseUrl), route => route.abort());
    await inner.goto(`${baseUrl}?demo&lang=en&theme=light`);
    await inner.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    await inner.click('#extra-menu-btn');
    assert.equal(await inner.locator('#extra-menu [data-action="extraGuide"]').count(), 0, 'no guide inside the guide');
    await inner.close();

    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
    console.log('animated guide: every demo plays to its end — ok');
} finally {
    await browser.close();
    await server.close();
}
