// The portable build, opened with a double click (file://), uses its workers.
//
// A page on file:// cannot start a worker from a script URL, so the portable
// build ships each worker as a string and starts it from a Blob
// (src/core/worker-pool.js). With them:
// 1. An ERA5 netCDF opens on its map, read by parts in the gridded worker, and
//    a point extracted from it has the file's values.
// 2. A station netCDF is parsed in the parse worker, by parts: the page holds
//    no copy of the file.
// 3. Where the browser refuses a Blob worker, both still open, read in the
//    page as before.
//
// Builds the page alone (no Node runtime, no zip) into a temporary folder.
// Needs a Chromium for Playwright. Run with `npm run e2e:portable-file`.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildPortableApp } from './build-portable.mjs';

const FIXTURES = resolve('test-files/netcdf');
const field = (lat, lon, t, offset = 0, level = 0) => 280 + offset + 0.1 * lat + 0.01 * lon + t - 10 * level;

const packageDir = await mkdtemp(join(tmpdir(), 'omv-portable-'));
const browser = await chromium.launch();

// Which workers the page started, by name: each Blob URL is matched to the
// worker source it was made from.
const startedWorkers = page => page.evaluate(async () => {
    const sources = globalThis.__OMV_WORKER_SOURCES__ || {};
    const names = [];
    for (const url of window.__startedWorkers) {
        const text = url.startsWith('blob:') ? await (await fetch(url)).text() : null;
        names.push(Object.keys(sources).find(name => sources[name] === text) || url);
    }
    return names;
});

try {
    await buildPortableApp(packageDir);
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    await context.addInitScript(() => {
        window.__startedWorkers = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(url, options) {
                super(url, options);
                window.__startedWorkers.push(String(url));
            }
        };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(join(packageDir, 'index.html')).href);
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => location.protocol), 'file:');

    // 1. ERA5 on the map, in the gridded worker.
    await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-new-cds.nc'));
    await page.waitForFunction(
        () => document.querySelector('#gridded-view:not([hidden]) .gridded-map .main-svg'),
        null, { timeout: 120000 },
    );
    assert.ok((await startedWorkers(page)).includes('gridded'), 'the map is read in the gridded worker, not in the page');
    await page.click('#gridded-view [data-mode="point"]');
    await page.selectOption('#gridded-view [data-role="variable"]', '/t2m');
    await page.fill('#gridded-view [data-input="lat"]', '44');
    await page.fill('#gridded-view [data-input="lon"]', '92');
    await page.click('#gridded-view [data-action="extract-point"]');
    await page.waitForFunction(() => document.querySelectorAll('#gridded-view .gridded-result').length === 1, null, { timeout: 60000 });
    const values = await page.evaluate(() => {
        const data = window.app.plotManager.files.get(window.app.plotManager.activeFileId).data;
        const node = Object.values(data.tree._children).find(child => child._griddedExtractions);
        const place = Object.values(node._children)[0];
        return Array.from(Object.values(place._variables)[0].data);
    });
    assert.equal(values.length, 4);
    values.forEach((value, step) => assert(Math.abs(value - field(45, 90, step, 5)) < 1e-3, `point value at step ${step}: ${value}`));

    // 2. A station file, by parts in the parse worker.
    await page.setInputFiles('#file-input', resolve(FIXTURES, 'generic-timeseries-classic.nc'));
    await page.waitForFunction(() => window.app.files.size === 2, null, { timeout: 60000 });
    const station = await page.evaluate(() => {
        const entry = [...window.app.files.values()].find(file => !file.gridded);
        return { buffer: entry.buffer, hash: String(entry.contentHash).startsWith('file:') };
    });
    assert.deepEqual(station, { buffer: null, hash: true }, 'a station file is not read whole into the page');
    assert.ok((await startedWorkers(page)).includes('parse'), 'the station file is parsed in the parse worker');

    assert.deepEqual(errors, []);
    await context.close();

    // 3. No Blob workers: the page reads, as before.
    {
        const refusing = await browser.newContext({ viewport: { width: 1400, height: 860 } });
        await refusing.addInitScript(() => {
            window.Worker = class {
                constructor() { throw new DOMException('Blocked by the test', 'SecurityError'); }
            };
        });
        const page = await refusing.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(pathToFileURL(join(packageDir, 'index.html')).href);
        await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-new-cds.nc'));
        await page.waitForFunction(
            () => document.querySelector('#gridded-view:not([hidden]) .gridded-map .main-svg'),
            null, { timeout: 120000 },
        );
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'generic-timeseries-classic.nc'));
        await page.waitForFunction(() => window.app.files.size === 2, null, { timeout: 60000 });
        assert.equal(await page.evaluate(() => document.querySelectorAll('.modal-overlay.show').length), 0, 'no error is shown');
        assert.deepEqual(errors, []);
        await refusing.close();
    }
    console.log('Portable file:// e2e passed: map and series netCDF read in workers, and in the page without them.');
} finally {
    await browser.close();
    await rm(packageDir, { recursive: true, force: true });
}
