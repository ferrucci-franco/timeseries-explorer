// A newer build deployed while the browser still holds the old page (#374),
// in a real browser against the dev server, with `version.json` stubbed.
//
// 1. A different build and nothing open: the page reloads onto it, once, and
//    the reload's `?build=` is gone from the address bar afterwards.
// 2. The server keeps handing out the old page (the CDN case): still only one
//    reload, never a loop.
// 3. A file open: no reload, a notice offering one instead -- in the desktop
//    and the phone layout, light and dark, in the language on screen.
// 4. No answer (offline, a 404): nothing happens at all.
//
// The logic is unit-tested in scripts/test-version-check.mjs. Needs a
// Chromium for Playwright. Run with `npm run e2e:version-check`; SHOTS_DIR=…
// saves screenshots of the notice.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;

// The dev server answers version.json with the build it is running
// (vite.config.js), so a page there finds itself current.
const running = (await (await fetch(`${baseUrl}version.json`)).json()).sha;
assert.match(running, /^[0-9a-f]{7,40}$/, 'the dev server publishes its build');
const other = running.startsWith('deadbee') ? 'feedbee' : 'deadbee';
const third = running.startsWith('c0ffee1') ? 'c0ffee2' : 'c0ffee1';

function csvFile() {
    const lines = ['time,voltage'];
    for (let i = 0; i < 200; i++) lines.push(`${(i / 10).toFixed(2)},${Math.sin(i / 10).toFixed(4)}`);
    return { name: 'signals.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// A page whose version.json says whatever `answer()` says, and that counts
// the documents it loads and the version.json requests it makes.
async function openPage(answer, contextOptions = {}) {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const state = { documents: [], versionRequests: 0, errors: [] };
    page.on('pageerror', e => state.errors.push(e.message));
    page.on('request', request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents.push(request.url());
    });
    await page.route('**/version.json*', async route => {
        state.versionRequests += 1;
        const reply = answer(state.versionRequests);
        if (reply === 'abort') return route.abort('internetdisconnected');
        if (reply === 404) return route.fulfill({ status: 404, body: 'Not Found' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: reply, date: '2026-11-15T00:00:00Z' }) });
    });
    return { context, page, state };
}

const appReady = page => page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
const guard = page => page.evaluate(() => sessionStorage.getItem('omv_version_reload'));

try {
    // ── 1 and 2: nothing open, the server keeps the old page ────────────────
    {
        const { context, page, state } = await openPage(() => other);
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?._versionCheckInitialized, null, { timeout: 60000 }).catch(() => {});
        // The first page reloads; the second must not.
        await page.waitForURL(url => state.documents.length >= 2, { timeout: 30000 }).catch(() => {});
        await appReady(page);
        await page.waitForFunction(() => !window.app._versionCheckInFlight, null, { timeout: 15000 });
        await page.waitForTimeout(1500);
        assert.equal(state.documents.length, 2, `one reload and no more: ${state.documents.join(' , ')}`);
        assert.equal(new URL(state.documents[1]).searchParams.get('build'), other, 'onto the new build, by an address no cache holds');
        assert.ok(state.versionRequests >= 2, 'the reloaded page looked again');
        assert.equal(new URL(page.url()).searchParams.has('build'), false, 'and the address bar is clean again');
        assert.equal(JSON.parse(await guard(page)).sha, other, 'the attempt is remembered for this tab');
        assert.equal(await page.locator('#version-update-notice').count(), 0, 'nothing offered either: the reload already failed once');
        assert.deepEqual(state.errors, []);
        await context.close();
    }

    // ── 1: the reload lands on the new build ────────────────────────────────
    {
        // The first page is told "other"; the page that comes back IS that
        // build as far as the check can tell, so it finds itself current.
        const { context, page, state } = await openPage(n => (n === 1 ? other : running));
        await page.goto(`${baseUrl}?lang=fr`);
        await page.waitForURL(() => state.documents.length >= 2, { timeout: 30000 }).catch(() => {});
        await appReady(page);
        await page.waitForFunction(() => !window.app._versionCheckInFlight, null, { timeout: 15000 });
        await page.waitForTimeout(800);
        assert.equal(state.documents.length, 2, 'one reload');
        const url = new URL(page.url());
        assert.equal(url.searchParams.has('build'), false, 'the reload query is removed');
        assert.equal(url.searchParams.get('lang'), 'fr', "the page's own query is kept");
        assert.equal(await guard(page), null, 'current again: the guard is cleared');
        assert.deepEqual(state.errors, []);
        await context.close();
    }

    // ── 4: no answer, nothing happens ───────────────────────────────────────
    for (const reply of [404, 'abort']) {
        const { context, page, state } = await openPage(() => reply);
        await page.goto(baseUrl);
        await appReady(page);
        await page.waitForFunction(() => window.app._versionLastCheckAt > 0 && !window.app._versionCheckInFlight, null, { timeout: 15000 });
        await page.waitForTimeout(500);
        assert.equal(state.documents.length, 1, `${reply}: no reload`);
        assert.equal(await page.locator('#version-update-notice').count(), 0, `${reply}: no notice`);
        assert.deepEqual(state.errors, [], `${reply}: no error`);
        await context.close();
    }

    // ── 3: a file open, desktop layout ──────────────────────────────────────
    {
        let deployed = running;
        const { context, page, state } = await openPage(() => deployed, { viewport: { width: 1280, height: 800 } });
        await page.goto(baseUrl);
        await appReady(page);
        await page.waitForFunction(() => window.app._versionLastCheckAt > 0 && !window.app._versionCheckInFlight, null, { timeout: 15000 });
        assert.equal(state.documents.length, 1, 'current: no reload');
        await page.setInputFiles('#file-input', [csvFile()]);
        await page.waitForFunction(() => window.app.files.size === 1, null, { timeout: 30000 });

        // The tab coming back so soon is not worth a look (once per 15 min).
        const before = state.versionRequests;
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.waitForTimeout(300);
        assert.equal(state.versionRequests, before, 'the look on visibilitychange is throttled');

        deployed = other;
        assert.equal(await page.evaluate(() => window.app._checkForNewVersion({ force: true })), 'banner');
        const notice = page.locator('#version-update-notice');
        await notice.waitFor({ state: 'visible' });
        await page.waitForTimeout(250);
        assert.equal(state.documents.length, 1, 'no reload under the open file');
        assert.equal(await notice.locator('.dismissible-notice-title').textContent(), 'A new version is available');
        assert.match(await notice.locator('.dismissible-notice-body').textContent(), /closes the files that are open/);
        assert.equal(await notice.locator('.version-update-reload').textContent(), 'Reload');
        const box = await notice.boundingBox();
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800, 'on screen');
        // Non-blocking: the page under it still answers.
        assert.equal(await page.evaluate(() => !!document.querySelector('.modal-overlay')), false, 'no dialog');
        await page.evaluate(() => window.app.applyTheme('light'));
        await page.waitForTimeout(400);
        if (shots) await page.screenshot({ path: `${shots}/version-desktop-light.png` });
        await page.evaluate(() => window.app.applyTheme('dark'));
        await page.waitForTimeout(400);
        if (shots) await page.screenshot({ path: `${shots}/version-desktop-dark.png` });

        // It follows the language.
        await page.evaluate(() => window.app.setLanguage('es'));
        assert.equal(await notice.locator('.dismissible-notice-title').textContent(), 'Hay una nueva versión disponible');
        assert.equal(await notice.locator('.dismissible-notice-close').getAttribute('aria-label'), 'Cerrar');
        await page.evaluate(() => window.app.setLanguage('en'));

        // Later: not offered again for this build...
        await notice.locator('.version-update-later').click();
        assert.equal(await notice.count(), 0, 'Later dismisses it');
        assert.equal(await page.evaluate(() => window.app._checkForNewVersion({ force: true })), 'none');
        assert.equal(await notice.count(), 0, 'and it stays dismissed for that build');
        // ...but a newer one is.
        deployed = third;
        assert.equal(await page.evaluate(() => window.app._checkForNewVersion({ force: true })), 'banner');
        await notice.waitFor({ state: 'visible' });
        // Reload, on the user's word: onto that build.
        await Promise.all([
            page.waitForURL(url => url.searchParams?.get?.('build') === third || state.documents.length >= 2, { timeout: 30000 }),
            notice.locator('.version-update-reload').click(),
        ]);
        await page.waitForTimeout(200);
        assert.equal(state.documents.length, 2, 'Reload reloads');
        assert.equal(new URL(state.documents[1]).searchParams.get('build'), third);
        assert.deepEqual(state.errors, []);
        await context.close();
    }

    // ── 3: a file open, phone layout, dark ──────────────────────────────────
    {
        let deployed = running;
        const { context, page, state } = await openPage(() => deployed, {
            viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
        });
        await page.goto(baseUrl);
        await appReady(page);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('compact')), true, 'the phone layout');
        await page.waitForFunction(() => window.app._versionLastCheckAt > 0 && !window.app._versionCheckInFlight, null, { timeout: 15000 });
        await page.setInputFiles('#file-input', [csvFile()]);
        await page.waitForFunction(() => window.app.files.size === 1, null, { timeout: 30000 });
        await page.evaluate(() => window.app.applyTheme('dark'));
        await page.waitForTimeout(400);
        deployed = other;
        assert.equal(await page.evaluate(() => window.app._checkForNewVersion({ force: true })), 'banner');
        const notice = page.locator('#version-update-notice');
        await notice.waitFor({ state: 'visible' });
        await page.waitForTimeout(250);
        const box = await notice.boundingBox();
        assert.ok(box.x >= 15 && box.x + box.width <= 390 - 15, `inside the side margins: ${JSON.stringify(box)}`);
        const appbar = await page.evaluate(() => {
            const bar = document.querySelector('#compact-appbar, .compact-appbar');
            return bar ? bar.getBoundingClientRect().bottom : 0;
        });
        assert.ok(box.y >= appbar, `below the app bar (${appbar}): ${JSON.stringify(box)}`);
        assert.ok(box.y + box.height <= 844, 'on screen');
        const reloadBox = await notice.locator('.version-update-reload').boundingBox();
        assert.ok(reloadBox.height >= 36, 'a button a finger can press');
        if (shots) await page.screenshot({ path: `${shots}/version-phone-dark.png` });
        await page.evaluate(() => window.app.applyTheme('light'));
        await page.waitForTimeout(400);
        if (shots) await page.screenshot({ path: `${shots}/version-phone-light.png` });
        // Sideways, the rail is on the left: the notice stays clear of it.
        await page.setViewportSize({ width: 844, height: 390 });
        await page.waitForFunction(() => document.documentElement.classList.contains('compact-landscape'), null, { timeout: 5000 });
        await page.waitForTimeout(250);
        const side = await notice.boundingBox();
        const rail = await page.evaluate(() => {
            const nav = document.querySelector('#compact-nav');
            return nav ? nav.getBoundingClientRect().right : 0;
        });
        assert.ok(side.x >= rail, `clear of the rail (${rail}): ${JSON.stringify(side)}`);
        assert.ok(side.x + side.width <= 844 && side.y + side.height <= 390, `on screen sideways: ${JSON.stringify(side)}`);
        if (shots) await page.screenshot({ path: `${shots}/version-phone-landscape.png` });
        assert.equal(state.documents.length, 1);
        assert.deepEqual(state.errors, []);
        await context.close();
    }

    console.log('e2e version-check: all checks passed');
} finally {
    await browser.close();
    await server.close();
}
