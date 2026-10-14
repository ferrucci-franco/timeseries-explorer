// Gridded netCDF files open on a map, in a real browser.
//
// 1. An ERA5 file as the new Copernicus CDS writes it opens on its map (no
//    series expansion); a point and a box become variables of the file with
//    the right values; the time slider moves; the extractions plot in the
//    explorer.
// 2. The CDS ZIP (instant + accumulated variables) is listed and opened as
//    one dataset.
// 3. A station file stays with the series reader, unchanged.
// 4. A GRIB file saved as ".nc" is explained, in the user's language.
// 5. The desktop path: a netCDF opened by path is fetched from the same local
//    file server Electron runs (electron/local-file-http.cjs), not read
//    through IPC into one buffer, and opens on its map.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:gridded-netcdf`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { streamLocalFile } = require('../electron/local-file-http.cjs');

const FIXTURES = resolve('test-files/netcdf');
const field = (lat, lon, t, offset = 0, level = 0) => 280 + offset + 0.1 * lat + 0.01 * lon + t - 10 * level;

// The renderer's desktop branch fetches /__omv_local__/file; serve it the way
// electron/main.cjs does, from the Electron module itself.
const localFilePlugin = {
    name: 'omv-local-file',
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname !== '/__omv_local__/file') return next();
            const filePath = url.searchParams.get('path');
            let stat;
            try {
                stat = statSync(filePath);
            } catch {
                res.statusCode = 404;
                res.end('File not found');
                return;
            }
            streamLocalFile(req, res, filePath, stat);
        });
    },
};

const server = await createServer({ logLevel: 'error', plugins: [localFilePlugin], server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

async function openApp(lang = 'en') {
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
    if (lang !== 'en') await page.evaluate(code => window.app.setLanguage(code), lang);
    return { context, page, errors };
}

const mapShown = page => page.waitForFunction(
    () => document.querySelector('#gridded-view:not([hidden]) .gridded-map .main-svg'),
    null, { timeout: 120000 },
);

const extractions = page => page.evaluate(() => {
    const data = window.app.plotManager.files.get(window.app.plotManager.activeFileId).data;
    const node = Object.values(data.tree._children).find(child => child._griddedExtractions);
    return Object.entries(node._variables).map(([label, variable]) => ({ label, name: variable.name, values: Array.from(variable.data) }));
});

try {
    // 1. New-CDS ERA5: map, point, box, slider, plot.
    {
        const { context, page, errors } = await openApp();
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-new-cds.nc'));
        await mapShown(page);
        const state = await page.evaluate(() => {
            const entry = [...window.app.files.values()][0];
            const data = window.app.plotManager.files.get(window.app.plotManager.activeFileId).data;
            return {
                gridded: !!entry.gridded,
                format: data.metadata.format,
                variables: [...document.querySelectorAll('#gridded-view [data-role="variable"] option')].map(option => option.value),
                level: document.querySelector('#gridded-view [data-dim="pressure_level"]')?.selectedOptions[0]?.textContent,
                time: document.querySelector('#gridded-view [data-role="time-label"]').textContent,
                abscissa: data.metadata.timeName,
            };
        });
        assert.equal(state.gridded, true, 'the ERA5 file opens as a gridded dataset');
        assert.equal(state.format, 'gridded-netcdf');
        assert.deepEqual(state.variables.sort(), ['/t', '/t2m'], 'expver and number are not offered as maps');
        assert.equal(state.level, '850 hPa');
        assert.match(state.time, /^2024-01-01 00:00 +\(1\/4\)$/);
        assert.equal(state.abscissa, 'valid_time');

        // A real click on the map adds one series.
        const plot = await page.$eval('#gridded-view .gridded-map .nsewdrag', el => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        });
        await page.mouse.click(plot.x + plot.w * 0.55, plot.y + plot.h * 0.35);
        await page.waitForFunction(() => !document.querySelector('#gridded-view [data-role="preview"]').hidden, null, { timeout: 60000 });
        assert.equal((await extractions(page)).length, 1);

        // The values, at a known cell: t2m at 45 N 90 E.
        await page.evaluate(async () => {
            const app = window.app;
            const view = app._griddedVisibleView();
            view.variableKey = '/t2m';
            app._griddedRenderControls(view);
            await app._griddedExtractPoint(view, 44, 92);
            await app._griddedExtractRegion(view, { latMin: 0, latMax: 50, lonMin: -50, lonMax: 50 });
        });
        const all = await extractions(page);
        assert.equal(all.length, 5);
        const point = all[1];
        assert.match(point.label, /^t2m · 45°N 90°E$/);
        point.values.forEach((value, step) => assert(Math.abs(value - field(45, 90, step, 5)) < 1e-3, `point value at step ${step}`));
        const mean = all.find(item => /mean/.test(item.label));
        const expected = step => {
            let sum = 0;
            let weights = 0;
            for (const lat of [15, 45]) for (const lon of [0, 45, 315]) {
                const w = Math.cos(lat * Math.PI / 180);
                sum += field(lat, lon, step, 5) * w;
                weights += w;
            }
            return sum / weights;
        };
        mean.values.forEach((value, step) => assert(Math.abs(value - expected(step)) < 1e-3, `area-weighted mean at step ${step}`));

        // The slider.
        await page.click('#gridded-view [data-step="next"]');
        await page.waitForFunction(() => /\(2\/4\)/.test(document.querySelector('#gridded-view [data-role="time-label"]').textContent));

        // Plot in the explorer: the map closes, the three region curves draw.
        await page.click('#gridded-view [data-action="plot"]');
        await page.waitForFunction(() => [...window.app.plotManager.plots.values()].some(plot => plot.traces.length === 3), null, { timeout: 30000 });
        assert.equal(await page.evaluate(() => document.getElementById('gridded-view').hidden), true);
        // The globe button on the file row brings the map back.
        await page.click('.file-entry-map');
        await mapShown(page);
        // Reload reopens the dataset on its map; it is never reparsed as series.
        await page.evaluate(() => window.app.reloadActiveFile());
        await mapShown(page);
        const reloaded = await page.evaluate(() => ({
            format: window.app.plotManager.files.get(window.app.plotManager.activeFileId).data.metadata.format,
            files: window.app.files.size,
            variable: window.app._griddedVisibleView().variableKey,
        }));
        assert.deepEqual(reloaded, { format: 'gridded-netcdf', files: 1, variable: '/t2m' });
        assert.equal((await extractions(page)).length, 0, 'extractions from the old data are dropped');
        assert.deepEqual(errors, []);
        await context.close();
    }

    // 2. The CDS ZIP, opened as one dataset.
    {
        const { context, page, errors } = await openApp();
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-instant-accum.zip'));
        await page.waitForSelector('.modal-overlay.show .modal-btn-confirm', { timeout: 60000 });
        const dialog = await page.$eval('.modal-overlay.show', el => el.innerText);
        assert.match(dialog, /stepType-instant\.nc/);
        assert.match(dialog, /stepType-accum\.nc/);
        await page.click('.modal-overlay.show .modal-btn-confirm');
        await mapShown(page);
        const variables = await page.$$eval('#gridded-view [data-role="variable"] option', options => options.map(option => option.value).sort());
        assert.deepEqual(variables, ['/t2m', '/tp']);
        assert.equal(await page.evaluate(() => window.app.files.size), 1);
        assert.deepEqual(errors, []);
        await context.close();
    }

    // 3 and 4. A station file is not a map; a GRIB is explained in Spanish.
    {
        const { context, page, errors } = await openApp('es');
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'generic-timeseries-classic.nc'));
        await page.waitForFunction(() => window.app.files.size === 1, null, { timeout: 60000 });
        const station = await page.evaluate(() => ({
            gridded: !![...window.app.files.values()][0].gridded,
            format: window.app.plotManager.files.get(window.app.plotManager.activeFileId).data.metadata.format,
            map: !!document.querySelector('#gridded-view:not([hidden])'),
        }));
        assert.deepEqual(station, { gridded: false, format: 'generic-netcdf', map: false });

        await page.setInputFiles('#file-input', {
            name: 'download.nc', mimeType: 'application/octet-stream',
            buffer: Buffer.concat([Buffer.from('GRIB'), Buffer.alloc(64)]),
        });
        await page.waitForSelector('.modal-overlay.show', { timeout: 60000 });
        const message = await page.$eval('.modal-overlay.show', el => el.innerText);
        assert.match(message, /es un archivo GRIB, no netCDF/);
        assert.equal(await page.evaluate(() => window.app.files.size), 1, 'the GRIB file is not added');
        assert.deepEqual(errors, []);
        await context.close();
    }

    // 5. The desktop path.
    {
        const { context, page, errors } = await openApp();
        const fixture = resolve(FIXTURES, 'era5-like-legacy-cds.nc');
        const result = await page.evaluate(async path => {
            const app = window.app;
            let ipcReads = 0;
            app.capabilities = { ...app.capabilities, isDesktop: true };
            globalThis.omvDesktop = {
                statFile: async () => ({ ok: true, size: 916, name: path.split('/').pop(), lastModified: Date.now() }),
                readFile: async () => { ipcReads += 1; return { ok: false, message: 'IPC read should not be used for netCDF' }; },
            };
            const file = await app._readLocalResultPath(path);
            await app.loadFiles([{ file, fileHandle: null, localPath: path }]);
            const entry = [...app.files.values()][0];
            return { ipcReads, size: file.size, gridded: !!entry?.gridded, localPath: entry?.localPath };
        }, fixture);
        assert.equal(result.ipcReads, 0, 'netCDF is fetched from the local server, not read through IPC');
        assert.equal(result.size, readFileSync(fixture).length);
        assert.equal(result.gridded, true);
        assert.equal(result.localPath, fixture);
        await mapShown(page);
        assert.match(await page.$eval('#gridded-view [data-role="time-label"]', el => el.textContent), /^2023-11-22 00:00/);
        assert.deepEqual(errors, []);
        await context.close();
    }

    console.log('Gridded netCDF e2e passed: map, point and box extractions, slider, plotting, CDS ZIP, series files untouched, GRIB message, desktop path.');
} finally {
    await browser.close();
    await server.close();
}
