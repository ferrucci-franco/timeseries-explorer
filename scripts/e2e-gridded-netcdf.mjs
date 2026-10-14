// Gridded netCDF files open on a map, in a real browser.
//
// 1. An ERA5 file as the new Copernicus CDS writes it opens on its map (no
//    series expansion). A click places a point and the button extracts it;
//    typed coordinates and a typed box (CDS-style North/West/East/South) do
//    the same; extractions can be removed; the colour bar never resizes the
//    map; export uses the panels' dialog; the checked series plot in the
//    explorer; reload reopens the map.
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
    // 1. New-CDS ERA5: map, point, region, slider, plot, export, reload.
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
                mode: document.querySelector('#gridded-view .gridded-mode.active')?.dataset.mode,
                cursor: document.querySelector('#gridded-view .gridded-map').classList.contains('gridded-cursor-point'),
                scope: document.querySelector('#gridded-view [data-role="scope"]').textContent,
                toolbarRows: (() => {
                    // Rows of the toolbar, by vertical centre (its items differ in height).
                    const centres = [...document.querySelectorAll('#gridded-view .gridded-toolbar > *')]
                        .filter(el => el.offsetParent)
                        .map(el => { const rect = el.getBoundingClientRect(); return rect.top + rect.height / 2; });
                    return Math.max(...centres) - Math.min(...centres) < 12 ? 1 : 2;
                })(),
            };
        });
        assert.equal(state.gridded, true, 'the ERA5 file opens as a gridded dataset');
        assert.equal(state.format, 'gridded-netcdf');
        assert.deepEqual(state.variables.sort(), ['/t', '/t2m'], 'expver and number are not offered as maps');
        assert.equal(state.level, '850 hPa');
        assert.match(state.time, /^2024-01-01 00:00 +\(1\/4\)$/);
        assert.equal(state.abscissa, 'valid_time');
        assert.equal(state.mode, 'point', 'the point tool is the starting tool');
        assert.equal(state.cursor, true, 'the point tool shows a crosshair, not the move cursor');
        assert.match(state.scope, /t · 850 hPa · .*4/, 'the panel says which level and how many steps an extraction uses');
        assert.equal(state.toolbarRows, 1, 'the toolbar is one row at this width');

        // A click places a marker and fills the coordinates; nothing is read yet.
        const plot = await page.$eval('#gridded-view .gridded-map .nsewdrag', el => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        });
        await page.mouse.click(plot.x + plot.w * 0.55, plot.y + plot.h * 0.35);
        await page.waitForFunction(() => document.querySelector('#gridded-view [data-input="lat"]').value !== '');
        assert.equal((await extractions(page)).length, 0, 'a click alone extracts nothing');
        assert.equal(await page.isEnabled('#gridded-view [data-action="extract-point"]'), true);
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => document.querySelectorAll('#gridded-view .gridded-result').length === 1, null, { timeout: 60000 });

        // Typed coordinates, on t2m: 44 N 92 E is the cell 45 N 90 E.
        await page.selectOption('#gridded-view [data-role="variable"]', '/t2m');
        await page.fill('#gridded-view [data-input="lat"]', '44');
        await page.fill('#gridded-view [data-input="lon"]', '92');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => document.querySelectorAll('#gridded-view .gridded-result').length === 2, null, { timeout: 60000 });
        let all = await extractions(page);
        const point = all[1];
        assert.match(point.label, /^P2 · t2m · 45°N 90°E$/);
        point.values.forEach((value, step) => assert(Math.abs(value - field(45, 90, step, 5)) < 1e-3, `point value at step ${step}`));

        // A region typed like the CDS form: North, West, East, South.
        await page.click('#gridded-view [data-mode="region"]');
        assert.equal(await page.evaluate(() => document.querySelector('#gridded-view .gridded-map').classList.contains('gridded-cursor-region')), true);
        await page.fill('#gridded-view [data-input="north"]', '50');
        await page.fill('#gridded-view [data-input="south"]', '0');
        await page.fill('#gridded-view [data-input="west"]', '-50');
        await page.fill('#gridded-view [data-input="east"]', '50');
        // The box is on the map, editable, before anything is computed.
        await page.waitForFunction(() => (document.querySelector('#gridded-view .gridded-map').layout.shapes || []).some(shape => shape.editable));
        await page.click('#gridded-view [data-action="extract-region"]');
        await page.waitForFunction(() => document.querySelectorAll('#gridded-view .gridded-result').length === 3, null, { timeout: 60000 });
        all = await extractions(page);
        assert.equal(all.length, 5, 'two points and the three curves of one region');
        const mean = all.find(item => /^R1 · .*mean/.test(item.label));
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
        const overlays = await page.evaluate(() => {
            const div = document.querySelector('#gridded-view .gridded-map');
            return { shapes: (div.layout.shapes || []).length, editable: (div.layout.shapes || []).filter(shape => shape.editable).length };
        });
        assert.deepEqual(overlays, { shapes: 1, editable: 0 }, 'the computed region stays on the map, dashed and fixed');

        // Removing an extraction removes its variables.
        await page.click('#gridded-view .gridded-result[data-group="g1"] [data-action="remove-group"]');
        assert.equal((await extractions(page)).length, 4);

        // The colour scale is fitted to the whole period and stays put while
        // the time moves (t2m at 850 hPa... here t2m: 4 steps, exact range).
        const scale = () => page.evaluate(() => [
            Number(document.querySelector('#gridded-view [data-role="range-min"]').value),
            Number(document.querySelector('#gridded-view [data-role="range-max"]').value),
        ]);
        await page.waitForFunction(() => window.app._griddedVisibleView().scale.range, null, { timeout: 30000 });
        const period = await scale();
        assert(Math.abs(period[0] - field(-75, 0, 0, 5)) < 0.01 && Math.abs(period[1] - field(75, 315, 3, 5)) < 0.01,
            `the scale covers every step of the period (${period})`);
        const width = () => page.evaluate(() => document.querySelector('#gridded-view .gridded-map .nsewdrag').getBoundingClientRect().width);
        const before = await width();
        await page.click('#gridded-view [data-step="next"]');
        await page.waitForFunction(() => /\(2\/4\)/.test(document.querySelector('#gridded-view [data-role="time-label"]').textContent));
        await page.waitForTimeout(300);
        assert.deepEqual(await scale(), period, 'moving in time does not change the colour scale');
        assert.deepEqual(await page.evaluate(() => {
            const trace = document.querySelector('#gridded-view .gridded-map').data[0];
            return [trace.zmin, trace.zmax];
        }), await page.evaluate(() => window.app._griddedVisibleView().scale.range), 'the map is drawn with it');
        // Auto-fit to the step on screen, then a typed bound (manual).
        await page.click('#gridded-view [data-action="autofit-menu"]');
        await page.click('#gridded-view [data-autofit="step"]');
        const step = await scale();
        assert(step[1] < period[1], 'fitted to one step, the maximum is that step\'s');
        await page.fill('#gridded-view [data-role="range-min"]', '-123456.789');
        await page.dispatchEvent('#gridded-view [data-role="range-min"]', 'change');
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => window.app._griddedVisibleView().scale.source), 'manual');
        // The colour bar does not move the map when the range changes.
        assert.equal(Math.round(await width()), Math.round(before), 'the plot area keeps its width');

        // The boundary between map and preview drags.
        const previewHeight = () => page.evaluate(() => document.querySelector('#gridded-view [data-role="preview"]').getBoundingClientRect().height);
        const heightBefore = await previewHeight();
        const grip = await page.$eval('#gridded-view [data-role="splitter"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        await page.mouse.move(grip.x, grip.y - 120, { steps: 6 });
        await page.mouse.up();
        assert(await previewHeight() > heightBefore + 100, 'dragging the splitter up makes the preview taller');

        // Export goes through the panels' export dialog.
        await page.click('#gridded-view [data-action="export-map"]');
        await page.waitForSelector('.modal-dialog-plot-export', { timeout: 10000 });
        await page.keyboard.press('Escape');
        await page.waitForSelector('.modal-dialog-plot-export', { state: 'detached', timeout: 10000 });

        // Open in the plots: the map closes, the checked curves draw.
        await page.click('#gridded-view [data-action="plot"]');
        await page.waitForFunction(() => [...window.app.plotManager.plots.values()].some(plot => plot.traces.length === 4), null, { timeout: 30000 });
        assert.equal(await page.evaluate(() => document.getElementById('gridded-view').hidden), true);
        // Over the plots, a button says the map is still there; it brings it back.
        await page.waitForSelector('#gridded-return:not([hidden])');
        await page.click('#gridded-return');
        await mapShown(page);
        assert.equal(await page.evaluate(() => document.getElementById('gridded-return').hidden), true);
        // So does the labelled "Map" button on the file row.
        await page.click('#gridded-view [data-action="close"]');
        await page.click('.file-entry-map');
        await mapShown(page);
        // A wheel zoom only ever moves one way: no redraw between notches puts
        // back the ranges it started from, and a grid this small is drawn
        // whole once, never again for a zoom. The pointer is over the region
        // drawn above, which must not swallow the wheel.
        await page.evaluate(() => {
            const div = document.querySelector('#gridded-view .gridded-map');
            window.__zoom = { spans: [], drawn: window.app._griddedVisibleView().drawn, stop: false };
            const sample = () => {
                const range = div._fullLayout.xaxis.range;
                window.__zoom.spans.push(Math.abs(range[1] - range[0]));
                if (!window.__zoom.stop) requestAnimationFrame(sample);
            };
            sample();
        });
        const centre = await page.$eval('#gridded-view .gridded-map .nsewdrag', el => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        await page.mouse.move(centre.x, centre.y);
        for (let notch = 0; notch < 8; notch++) {
            await page.mouse.wheel(0, -100);
            await page.waitForTimeout(70);
        }
        await page.waitForTimeout(800);
        const zoom = await page.evaluate(() => {
            window.__zoom.stop = true;
            const view = window.app._griddedVisibleView();
            return { spans: window.__zoom.spans, sameDrawing: view.drawn === window.__zoom.drawn, zoomed: !!view.zoom };
        });
        assert.equal(zoom.zoomed, true, 'the wheel zooms the map');
        assert.ok(zoom.spans.at(-1) < zoom.spans[0] * 0.8, `the map zoomed in (${zoom.spans[0]} → ${zoom.spans.at(-1)})`);
        zoom.spans.forEach((span, index) => {
            if (index) assert.ok(span <= zoom.spans[index - 1] + 1e-9, `zooming in never widens the view (${zoom.spans.join(', ')})`);
        });
        assert.equal(zoom.sameDrawing, true, 'a small grid is not redrawn for a zoom');
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
