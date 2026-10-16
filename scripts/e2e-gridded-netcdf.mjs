// Gridded netCDF files open on a map, in a real browser.
//
// 1. An ERA5 file as the new Copernicus CDS writes it opens on its map (no
//    series expansion). A click places a point and the button extracts it;
//    typed coordinates and a typed box (CDS-style North/West/East/South) do
//    the same; extractions can be removed; the colour bar never resizes the
//    map; export uses the panels' dialog; the checked series plot in the
//    explorer; reload reopens the map.
// 1b. On a touch screen a tap places the point, a finger drags the ring, and
//    a finger elsewhere pans the map.
// 2. The CDS ZIP (instant + accumulated variables) is listed and opened as
//    one dataset.
// 3. A station file stays with the series reader, unchanged.
// 4. A GRIB file saved as ".nc" is explained, in the user's language.
// 5. The desktop path: a netCDF opened by path is fetched from the same local
//    file server Electron runs (electron/local-file-http.cjs), not read
//    through IPC into one buffer, and opens on its map.
// 6. A saved project brings the map back: its places (P1, R1…), their series
//    and values, the tree folders they live in, what the map was showing and
//    the panel that plotted them.
// 7. A dataset made of several files (a CDS ZIP read as one, months joined
//    along time) is saved with all of its files and opens joined again.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:gridded-netcdf`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
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

// Every extracted series, from the "Extractions" folder of the variable tree
// (one subfolder per place: P1, R1…), with the name its curves carry.
const extractions = page => page.evaluate(() => {
    const data = window.app.plotManager.files.get(window.app.plotManager.activeFileId).data;
    const node = Object.values(data.tree._children).find(child => child._griddedExtractions);
    return Object.entries(node._children).flatMap(([folder, place]) => Object.entries(place._variables)
        .map(([leaf, variable]) => ({ folder, leaf, label: variable.displayName, name: variable.name, values: Array.from(variable.data) })));
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
        assert.equal(state.mode, 'navigate', 'the map opens in Navigate: a click places nothing before a tool is picked');
        assert.equal(state.cursor, false);
        assert.match(state.scope, /t · 850 hPa · .*4/, 'the panel says which level and how many steps an extraction uses');
        assert.equal(state.toolbarRows, 1, 'the toolbar is one row at this width');

        // In the point tool (a crosshair, not the move cursor) a click places
        // a marker and fills the coordinates; nothing is read yet.
        const plot = await page.$eval('#gridded-view .gridded-map .nsewdrag', el => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        });
        await page.mouse.click(plot.x + plot.w * 0.55, plot.y + plot.h * 0.35);
        assert.equal(await page.evaluate(() => window.app._griddedVisibleView().pendingPoint), null, 'Navigate places nothing');
        await page.click('#gridded-view [data-mode="point"]');
        assert.equal(await page.evaluate(() => document.querySelector('#gridded-view .gridded-map').classList.contains('gridded-cursor-point')), true);
        await page.mouse.click(plot.x + plot.w * 0.55, plot.y + plot.h * 0.35);
        await page.waitForFunction(() => document.querySelector('#gridded-view [data-input="lat"]').value !== '');
        assert.equal((await extractions(page)).length, 0, 'a click alone extracts nothing');
        assert.equal(await page.isEnabled('#gridded-view [data-action="extract-point"]'), true);
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => document.querySelectorAll('#gridded-view .gridded-result').length === 1, null, { timeout: 60000 });
        assert.equal(await page.evaluate(() => window.app._griddedVisibleView().mode), 'navigate', 'an extraction goes back to Navigate');

        // Typed coordinates, on t2m: 44 N 92 E is the cell 45 N 90 E.
        await page.click('#gridded-view [data-mode="point"]');
        await page.selectOption('#gridded-view [data-role="variable"]', '/t2m');
        await page.fill('#gridded-view [data-input="lat"]', '44');
        await page.fill('#gridded-view [data-input="lon"]', '92');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => document.querySelectorAll('#gridded-view .gridded-result').length === 2, null, { timeout: 60000 });
        let all = await extractions(page);
        const point = all[1];
        assert.match(point.label, /^P2 · 2 metre temperature \(t2m\) · 45°N 90°E$/, "the name says what the quantity is, not only its short name");
        assert.equal(point.folder, 'P2 · 45°N 90°E', 'each place is a folder of the tree');
        assert.equal(point.leaf, '2 metre temperature (t2m)', 'in its folder a series says only what it is');
        point.values.forEach((value, step) => assert(Math.abs(value - field(45, 90, step, 5)) < 1e-3, `point value at step ${step}`));

        // A region typed like the CDS form: North, West, East, South.
        await page.click('#gridded-view [data-mode="region"]');
        assert.equal(await page.evaluate(() => document.querySelector('#gridded-view .gridded-map').classList.contains('gridded-cursor-region')), true);
        await page.fill('#gridded-view [data-input="north"]', '50');
        await page.fill('#gridded-view [data-input="south"]', '0');
        await page.fill('#gridded-view [data-input="west"]', '-50');
        await page.fill('#gridded-view [data-input="east"]', '50');
        // The box is on the map before anything is computed.
        await page.waitForFunction(() => (document.querySelector('#gridded-view .gridded-map').layout.shapes || []).some(shape => shape.name === 'pending-box'));
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
            return { shapes: (div.layout.shapes || []).length, pending: (div.layout.shapes || []).filter(shape => shape.name === 'pending-box').length };
        });
        assert.deepEqual(overlays, { shapes: 1, pending: 0 }, 'the computed region stays on the map, dashed and fixed');

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
        // Everything about the scale is under one "Color range" button: the
        // fit it comes from is marked in blue, and so are typed ends.
        const marked = () => page.evaluate(() => ({
            fits: [...document.querySelectorAll('#gridded-view [data-autofit].active')].map(button => button.dataset.autofit),
            typed: document.querySelector('#gridded-view [data-role="range-row"]').classList.contains('active'),
        }));
        assert.equal(await page.isVisible('#gridded-view [data-role="range-min"]'), false, 'the ends are inside the menu, not on the toolbar');
        await page.click('#gridded-view [data-action="autofit-menu"]');
        assert.deepEqual(await marked(), { fits: ['sample'], typed: false }, 'the menu marks the fit in use');
        await page.click('#gridded-view [data-autofit="step"]');
        const step = await scale();
        assert(step[1] < period[1], 'fitted to one step, the maximum is that step\'s');
        await page.click('#gridded-view [data-action="autofit-menu"]');
        assert.deepEqual(await marked(), { fits: ['step'], typed: false });
        await page.fill('#gridded-view [data-role="range-min"]', '-123456.789');
        await page.dispatchEvent('#gridded-view [data-role="range-min"]', 'change');
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => window.app._griddedVisibleView().scale.source), 'manual');
        assert.deepEqual(await marked(), { fits: [], typed: true }, 'typed ends mark their row');
        await page.keyboard.press('Escape');
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
        // A second trip goes to the same panel, brought up to date (P2
        // unchecked leaves it), instead of a new panel every time.
        const extractionPanels = () => page.evaluate(() => [...window.app.plotManager.plots.values()]
            .filter(plot => plot.traces.some(trace => String(trace.varName).startsWith('grid:x')))
            .map(plot => plot.traces.length));
        const p2Box = '#gridded-view .gridded-result:first-child input[type="checkbox"]';
        await page.uncheck(p2Box);
        await page.click('#gridded-view [data-action="plot"]');
        await page.waitForSelector('#gridded-return:not([hidden])');
        await page.waitForFunction(() => [...window.app.plotManager.plots.values()].some(plot => plot.traces.length === 3), null, { timeout: 30000 });
        await page.waitForTimeout(500);
        assert.deepEqual(await extractionPanels(), [3], 'the same panel, without the unchecked curve');
        await page.click('#gridded-return');
        await mapShown(page);
        await page.check(p2Box);
        // The preview pans with the right button, like the explorer's plots.
        const previewRange = () => page.evaluate(() => [...document.querySelector('#gridded-view [data-role="preview-chart"]')._fullLayout.xaxis.range]);
        const previewBefore = await previewRange();
        const preview = await page.$eval('#gridded-view [data-role="preview-chart"] .nsewdrag', el => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        await page.mouse.move(preview.x, preview.y);
        await page.mouse.down({ button: 'right' });
        for (let step = 1; step <= 6; step++) await page.mouse.move(preview.x - step * 20, preview.y);
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(200);
        assert.notDeepEqual(await previewRange(), previewBefore, 'a right-button drag pans the preview');
        // "Hide" folds the list and the preview away, the map takes the
        // height, and the heading still counts the series; "Show" brings
        // them back.
        const layoutNow = () => page.evaluate(() => ({
            body: document.querySelector('#gridded-view [data-role="results-body"]').hidden,
            preview: document.querySelector('#gridded-view [data-role="preview"]').hidden,
            map: document.querySelector('#gridded-view .gridded-map').clientHeight,
            heading: document.querySelector('#gridded-view [data-role="results-heading"]').textContent,
        }));
        const shown = await layoutNow();
        await page.click('#gridded-view [data-action="toggle-results"]');
        await page.waitForTimeout(300);
        const folded = await layoutNow();
        assert.equal(folded.body, true, 'Hide folds the list away');
        assert.equal(folded.preview, true, 'and the preview under the map');
        assert.ok(folded.map > shown.map + 50, `the map takes the height (${shown.map} → ${folded.map})`);
        assert.match(folded.heading, /\(\d+\)$/, 'the heading counts the series');
        await page.click('#gridded-view [data-action="toggle-results"]');
        await page.waitForTimeout(300);
        const back = await layoutNow();
        assert.deepEqual([back.body, back.preview], [false, false], 'Show brings both back');
        // The "Map" button on the file row opens the map again. A map closed
        // with "Close map" does not put a button over the plots asking to
        // come back.
        await page.click('#gridded-view [data-action="close"]');
        assert.equal(await page.evaluate(() => document.getElementById('gridded-return')?.hidden !== false), true, 'no way-back button after Close map');
        await page.click('.file-entry-map');
        await mapShown(page);
        // The scale's controls explain themselves; the bounded "Open as
        // series" is gone.
        const tips = await page.evaluate(() => [
            ...[...document.querySelectorAll('#gridded-view [data-autofit]')].map(button => button.title),
            ...[...document.querySelectorAll('#gridded-view [data-scale-option]')].map(input => input.closest('label').title),
            document.querySelector('#gridded-view [data-role="range-row"]').title,
        ]);
        assert.ok(tips.length === 8 && tips.every(tip => tip.length > 30), `every scale option has a tooltip (${JSON.stringify(tips)})`);
        assert.equal(await page.$('#gridded-view [data-action="as-series"]'), null);
        // Text buttons beside icon buttons are as tall as they are.
        const heights = await page.evaluate(() => ['export-map', 'close', 'toggle-results', 'remove-all', 'export-series']
            .map(action => Math.round(document.querySelector(`#gridded-view [data-action="${action}"]`).getBoundingClientRect().height)));
        assert.ok(heights.every(height => height === heights[0]), `one height for the toolbar and list buttons (${heights})`);
        // A wheel zoom only ever moves one way: no redraw between notches puts
        // back the ranges it started from, and a grid this small is drawn
        // whole once, never again for a zoom. The pointer is over the region
        // drawn above, which must not swallow the wheel.
        // The map was just reopened: let its own redraws (the colour scale
        // arriving, the preview resizing it) finish before measuring.
        await page.waitForFunction(() => new Promise(resolve => {
            const view = window.app._griddedVisibleView();
            const drawn = view.drawn;
            setTimeout(() => resolve(view.drawn === drawn && !view.job), 800);
        }), null, { timeout: 30000, polling: 100 });
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
            return { spans: window.__zoom.spans, sameDrawing: view.drawn === window.__zoom.drawn, zoomed: !!view.zoom, drawn: [window.__zoom.drawn, view.drawn] };
        });
        assert.equal(zoom.zoomed, true, 'the wheel zooms the map');
        assert.ok(zoom.spans.at(-1) < zoom.spans[0] * 0.8, `the map zoomed in (${zoom.spans[0]} → ${zoom.spans.at(-1)})`);
        zoom.spans.forEach((span, index) => {
            if (index) assert.ok(span <= zoom.spans[index - 1] + 1e-9, `zooming in never widens the view (${zoom.spans.join(', ')})`);
        });
        assert.equal(zoom.sameDrawing, true, `a small grid is not redrawn for a zoom (${JSON.stringify(zoom.drawn)})`);
        // Two fingers on a trackpad: sideways or diagonally the map pans
        // (the span stays), up or down it zooms, as the wheel did above.
        const ranges = () => page.evaluate(() => {
            const { xaxis, yaxis } = document.querySelector('#gridded-view .gridded-map')._fullLayout;
            return { x: [...xaxis.range], y: [...yaxis.range] };
        });
        const swipe = async (dx, dy) => {
            for (let step = 0; step < 6; step++) {
                await page.mouse.wheel(dx, dy);
                await page.waitForTimeout(30);
            }
            await page.waitForTimeout(900);
        };
        const beforeSwipe = await ranges();
        await swipe(40, 0);
        const sideways = await ranges();
        const span = range => range[1] - range[0];
        assert.ok(sideways.x[0] > beforeSwipe.x[0] + 1, `a sideways swipe pans east (${beforeSwipe.x} → ${sideways.x})`);
        assert.ok(Math.abs(span(sideways.x) - span(beforeSwipe.x)) < 1e-6 && Math.abs(sideways.y[0] - beforeSwipe.y[0]) < 1e-6, 'without zooming or moving north');
        await swipe(-30, 30);
        const diagonal = await ranges();
        assert.ok(diagonal.x[0] < sideways.x[0] - 1 && diagonal.y[0] < sideways.y[0] - 1, `a diagonal swipe pans both ways (${JSON.stringify([sideways, diagonal])})`);
        assert.ok(Math.abs(span(diagonal.x) - span(sideways.x)) < 1e-6, 'still without zooming');
        await swipe(0, 40);
        const vertical = await ranges();
        assert.ok(span(vertical.x) > span(diagonal.x) * 1.05, `up or down zooms (${span(diagonal.x)} → ${span(vertical.x)})`);
        // Navigate shows an open hand, closed while pressed (away from the
        // region drawn above, which shows the pointer of what can be picked).
        const corner = await page.$eval('#gridded-view .gridded-map .nsewdrag', el => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width * 0.03, y: rect.y + rect.height * 0.97 };
        });
        await page.mouse.move(corner.x, corner.y);
        await page.waitForFunction(() => ![...document.querySelector('#gridded-view .gridded-map').classList].some(name => name.startsWith('gridded-over-')));
        const cursorNow = () => page.$eval('#gridded-view .gridded-map .nsewdrag', el => getComputedStyle(el).cursor);
        assert.equal(await cursorNow(), 'grab', 'Navigate shows a hand');
        // A short drag, not a click, which would select the region the
        // zoomed view may lie in.
        await page.mouse.down();
        assert.equal(await cursorNow(), 'grabbing', 'that closes while pressed');
        await page.mouse.move(corner.x + 20, corner.y - 10, { steps: 4 });
        await page.mouse.up();
        assert.equal(await cursorNow(), 'grab');
        // Back to the view the checks below were written for.
        await page.evaluate(async restore => {
            const { default: Plotly } = await import('/src/vendor/plotly.js');
            await Plotly.relayout(document.querySelector('#gridded-view .gridded-map'), { 'xaxis.range': restore.x, 'yaxis.range': restore.y });
        }, beforeSwipe);
        await page.waitForTimeout(400);

        // The coastlines and borders stay inside the axes. They are SVG
        // traces — the WebGL layer is one canvas over the whole figure, and
        // with `constrain: 'domain'` (which shrinks the drawing area to keep
        // a degree square) its clipping left them a few pixels outside — and
        // they are cut to a window around the view, which is what keeps the
        // 1:50m set (80.000 points worldwide) cheap. A pan out of that window
        // draws them again.
        const coastState = () => page.evaluate(() => {
            const div = document.querySelector('#gridded-view .gridded-map');
            const view = window.app._griddedVisibleView();
            const lines = div.data.filter(trace => trace.hoverinfo === 'skip' && trace.mode === 'lines');
            return {
                types: [...new Set(lines.map(trace => trace.type))],
                points: lines.reduce((total, trace) => total + trace.x.filter(value => value !== null).length, 0),
                window: view.drawn?.coastWindow,
                zoom: view.zoom,
            };
        });
        const zoomedCoast = await coastState();
        assert.deepEqual(zoomedCoast.types, ['scatter'], 'the coast is an SVG trace, which Plotly clips to the axes');
        assert.ok(zoomedCoast.points > 0 && zoomedCoast.points < 20000, `zoomed in, only the coast in sight is drawn (${zoomedCoast.points} points)`);
        assert.ok(zoomedCoast.window.x[0] <= zoomedCoast.zoom.x[0] && zoomedCoast.window.x[1] >= zoomedCoast.zoom.x[1],
            `the window holds the view with room to pan (${JSON.stringify(zoomedCoast)})`);
        // Nothing is painted above the plot area: that band of the margin
        // carries neither the title nor the ticks, so every pixel of it is
        // the paper colour — in either theme — unless the map leaks out.
        const band = await page.evaluate(() => {
            const div = document.querySelector('#gridded-view .gridded-map');
            const rect = div.getBoundingClientRect();
            const { xaxis, yaxis } = div._fullLayout;
            const paper = window.app._griddedColors().bg;
            return {
                clip: {
                    x: Math.round(rect.left + xaxis._offset + xaxis._length * 0.45),
                    y: Math.round(rect.top + yaxis._offset) - 6,
                    width: Math.round(xaxis._length * 0.5),
                    height: 5,
                },
                paper: [1, 3, 5].map(at => parseInt(paper.slice(at, at + 2), 16)),
            };
        });
        const bandPixels = await sharp(await page.screenshot({ clip: band.clip })).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let strayed = 0;
        for (let index = 0; index < bandPixels.data.length; index += bandPixels.info.channels) {
            const away = band.paper.reduce((top, channel, at) => Math.max(top, Math.abs(bandPixels.data[index + at] - channel)), 0);
            if (away > 12) strayed += 1;
        }
        assert.equal(strayed, 0, `nothing of the map is drawn above the axes (${strayed} pixels are not the paper colour ${band.paper})`);
        const panned = await page.evaluate(async () => {
            const view = window.app._griddedVisibleView();
            const drawn = view.drawn;
            const span = Math.abs(view.zoom.x[1] - view.zoom.x[0]);
            view.zoom = { x: [view.zoom.x[0] + span * 3, view.zoom.x[1] + span * 3], y: [...view.zoom.y] };
            const needs = window.app._griddedZoomNeedsRedraw(view);
            await window.app._griddedDrawMap(view);
            return { needs, redrawn: view.drawn !== drawn, window: view.drawn.coastWindow, zoom: view.zoom };
        });
        assert.equal(panned.needs, true, 'a pan out of that window asks for a redraw');
        assert.ok(panned.window.x[0] <= panned.zoom.x[0] && panned.window.x[1] >= panned.zoom.x[1], 'and the new window follows the view');

        // Points and boxes on the map. A click places the ring where it lands
        // (from the pixel, not from a lagging hover); the ring drags; the
        // right button opens a menu that removes it; a box drawn after the
        // ring has been on the map is still in degrees; a click on an
        // extraction selects it and its row, Delete removes it; the trash
        // empties the list.
        await page.evaluate(async () => {
            const view = window.app._griddedVisibleView();
            view.zoom = null;
            await window.app._griddedDrawMap(view);
        });
        const toPage = (lon, lat) => page.evaluate(([lon, lat]) => {
            const div = document.querySelector('#gridded-view .gridded-map');
            const rect = div.getBoundingClientRect();
            const { xaxis, yaxis } = div._fullLayout;
            return [rect.left + xaxis._offset + xaxis.l2p(lon), rect.top + yaxis._offset + yaxis.l2p(lat)];
        }, [lon, lat]);
        const objects = () => page.evaluate(() => {
            const view = window.app._griddedVisibleView();
            return {
                point: view.pendingPoint,
                box: view.pendingBox,
                selected: view.selected,
                groups: view.groups.map(group => ({ id: group.id, kind: group.kind, tag: group.tag, geometry: group.geometry })),
                rows: [...document.querySelectorAll('#gridded-view .gridded-result.selected')].map(row => row.dataset.group),
                menu: [...document.querySelectorAll('.gridded-context-menu button')].map(button => button.textContent),
            };
        });
        const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
        const mouseDrag = async (from, to) => {
            await page.mouse.move(...from);
            await page.mouse.down();
            for (let step = 1; step <= 8; step++) await page.mouse.move(from[0] + (to[0] - from[0]) * step / 8, from[1] + (to[1] - from[1]) * step / 8);
            await page.mouse.up();
            await page.waitForTimeout(400);
        };
        await page.click('#gridded-view [data-mode="point"]');
        await page.mouse.click(...await toPage(-30, 20));
        let objectsNow = await objects();
        assert.ok(near(objectsNow.point?.lon, -30) && near(objectsNow.point?.lat, 20), `the ring lands where clicked (${JSON.stringify(objectsNow.point)})`);
        await mouseDrag(await toPage(-30, 20), await toPage(10, -10));
        objectsNow = await objects();
        assert.ok(near(objectsNow.point?.lon, 10) && near(objectsNow.point?.lat, -10), `the ring follows a drag (${JSON.stringify(objectsNow.point)})`);
        assert.equal(await page.inputValue('#gridded-view [data-input="lon"]'), String(objectsNow.point.lon), 'the coordinates follow the ring');
        await page.mouse.click(...await toPage(10, -10), { button: 'right' });
        await page.waitForSelector('.gridded-context-menu');
        assert.equal((await objects()).menu.length, 2, 'the ring\'s menu: extract, remove');
        await page.click('.gridded-context-menu button:last-child');
        objectsNow = await objects();
        assert.equal(objectsNow.point, null, 'the menu removes the ring');
        assert.equal(objectsNow.menu.length, 0, 'and closes');

        await page.mouse.click(...await toPage(-30, 20));
        await page.click('#gridded-view [data-mode="region"]');
        if ((await objects()).box) await page.click('#gridded-view [data-action="clear-region"]');
        await mouseDrag(await toPage(-60, -30), await toPage(-20, 10));
        objectsNow = await objects();
        assert.ok(objectsNow.box && near(objectsNow.box.lonMin, -60) && near(objectsNow.box.lonMax, -20)
            && near(objectsNow.box.latMin, -30) && near(objectsNow.box.latMax, 10), `a box drawn after the ring is in degrees (${JSON.stringify(objectsNow.box)})`);
        // The orange box moves from inside (also from a quarter of its width
        // in, where Plotly would have resized it) and resizes only from a
        // thin band along an edge.
        const boxPixels = () => page.evaluate(() => {
            const div = document.querySelector('#gridded-view .gridded-map');
            const box = window.app._griddedVisibleView().pendingBox;
            const rect = div.getBoundingClientRect();
            const { xaxis, yaxis } = div._fullLayout;
            const x = lon => rect.left + xaxis._offset + xaxis.l2p(lon);
            const y = lat => rect.top + yaxis._offset + yaxis.l2p(lat);
            return { box, left: x(box.lonMin), right: x(box.lonMax), top: y(box.latMax), bottom: y(box.latMin) };
        });
        let pixels = await boxPixels();
        const boxWidth = pixels.box.lonMax - pixels.box.lonMin;
        const middleY = (pixels.top + pixels.bottom) / 2;
        const quarterX = pixels.left + (pixels.right - pixels.left) / 4;
        await mouseDrag([quarterX, middleY], [quarterX + 30, middleY]);
        const moved = (await boxPixels()).box;
        assert.ok(moved.lonMin > pixels.box.lonMin + 1 && near(moved.lonMax - moved.lonMin, boxWidth, 0.05), `a drag a quarter in moves the box (${JSON.stringify([pixels.box, moved])})`);
        pixels = await boxPixels();
        await mouseDrag([pixels.right - 3, middleY], [pixels.right + 40, middleY]);
        const resized = (await boxPixels()).box;
        assert.ok(near(resized.lonMin, moved.lonMin, 0.05) && resized.lonMax > moved.lonMax + 5, `the east edge resizes it (${JSON.stringify([moved, resized])})`);
        // The right button drags the map; it opens no menu after a drag.
        const mapRange = () => page.evaluate(() => [...document.querySelector('#gridded-view .gridded-map')._fullLayout.xaxis.range]);
        const rangeBefore = await mapRange();
        const empty = await toPage(100, -60);
        await page.mouse.move(...empty);
        await page.mouse.down({ button: 'right' });
        for (let step = 1; step <= 6; step++) await page.mouse.move(empty[0] - step * 15, empty[1]);
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(300);
        assert.ok((await mapRange())[0] > rangeBefore[0] + 1, `a right-button drag pans the map (${rangeBefore} → ${await mapRange()})`);
        assert.equal((await objects()).menu.length, 0, 'no menu after a right-button drag');
        await page.evaluate(async () => {
            const view = window.app._griddedVisibleView();
            view.zoom = null;
            await window.app._griddedDrawMap(view);
        });
        const groupsBefore = objectsNow.groups.length;
        await page.click('#gridded-view [data-action="extract-region"]');
        await page.waitForFunction(count => window.app._griddedVisibleView().groups.length === count, groupsBefore + 1, { timeout: 60000 });
        await page.waitForTimeout(500);
        const region = (await objects()).groups.at(-1);
        // A plain click inside a box does not select it (a point may be wanted
        // there); a click on its edge does, and marks its row.
        await page.mouse.click(...await toPage(region.geometry.lonMin, (region.geometry.latMin + region.geometry.latMax) / 2));
        objectsNow = await objects();
        assert.deepEqual(objectsNow.selected, { kind: 'group', id: region.id }, 'a click on a box\'s edge selects it');
        assert.deepEqual(objectsNow.rows, [region.id], 'and marks its row');
        await page.keyboard.press('Delete');
        objectsNow = await objects();
        assert.ok(!objectsNow.groups.some(group => group.id === region.id), 'Delete removes the selected box');
        assert.equal(objectsNow.selected, null);

        // An extracted point: its row selects it on the map; the right
        // button removes it.
        await page.click('#gridded-view [data-mode="point"]');
        await page.mouse.click(...await toPage(135, -15));
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(count => window.app._griddedVisibleView().groups.length === count, objectsNow.groups.length + 1, { timeout: 60000 });
        await page.waitForTimeout(500);
        const extracted = (await objects()).groups.at(-1);
        await page.click(`#gridded-view .gridded-result[data-group="${extracted.id}"] .gridded-result-text`);
        assert.deepEqual((await objects()).selected, { kind: 'group', id: extracted.id }, 'a row selects its point');
        await page.mouse.click(...await toPage(extracted.geometry.lon, extracted.geometry.lat), { button: 'right' });
        await page.waitForSelector('.gridded-context-menu');
        assert.ok((await objects()).menu.some(item => item.includes(extracted.tag)), 'the menu names the extraction');
        await page.click('.gridded-context-menu button:last-child');
        assert.ok(!(await objects()).groups.some(group => group.id === extracted.id), 'the menu removes the point and its series');

        // A place is a folder. "+" puts it back on the map; another variable,
        // at all its levels (read in one go), joins the same place; the same
        // series asked again is not added twice; one series leaves alone.
        const groupCount = (await objects()).groups.length;
        await page.click('#gridded-view [data-mode="point"]');
        await page.mouse.click(...await toPage(-90, -45));
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(count => window.app._griddedVisibleView().groups.length === count, groupCount + 1, { timeout: 60000 });
        const place = await page.evaluate(() => {
            const group = window.app._griddedVisibleView().groups.at(-1);
            return { id: group.id, tag: group.tag, geometry: group.geometry };
        });
        await page.click(`#gridded-view .gridded-result[data-group="${place.id}"] [data-action="reuse-group"]`);
        const reused = await page.evaluate(() => ({ mode: window.app._griddedVisibleView().mode, point: window.app._griddedVisibleView().pendingPoint }));
        assert.deepEqual(reused, { mode: 'point', point: place.geometry }, '"+" puts the place back as the orange point');
        await page.selectOption('#gridded-view [data-role="variable"]', '/t');
        assert.equal(await page.isVisible('#gridded-view [data-role="levels-row"]'), true, 'a variable with levels offers the levels');
        await page.click('#gridded-view [data-action="levels-menu"]');
        await page.click('#gridded-view [data-action="levels-all"]');
        assert.match(await page.textContent('#gridded-view [data-role="scope"]'), /all 2 levels/);
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(id => window.app._griddedVisibleView().groups.find(group => group.id === id).sets.length === 3, place.id, { timeout: 60000 });
        const placeSeries = (await extractions(page)).filter(item => item.folder.startsWith(`${place.tag} · `));
        assert.deepEqual(placeSeries.map(item => item.leaf), ['2 metre temperature (t2m)', 'Temperature (t) · 850 hPa', 'Temperature (t) · 500 hPa'], 'one folder, one series per variable and level');
        placeSeries.slice(1).forEach((series, level) => series.values.forEach((value, step) => {
            assert(Math.abs(value - field(-45, 270, step, 0, level)) < 1e-3, `level ${level}, step ${step}`);
        }));
        await page.click(`#gridded-view .gridded-result[data-group="${place.id}"] [data-action="reuse-group"]`);
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => /already/.test(document.querySelector('#gridded-view [data-role="status"]').textContent), null, { timeout: 30000 });
        const setIds = await page.evaluate(id => window.app._griddedVisibleView().groups.find(group => group.id === id).sets.map(set => set.id), place.id);
        assert.equal(setIds.length, 3, 'the same series is not added twice');
        await page.click(`#gridded-view [data-set="${setIds[1]}"] [data-action="remove-set"]`);
        assert.equal((await extractions(page)).filter(item => item.folder.startsWith(`${place.tag} · `)).length, 2, 'one series removed, the place stays');
        await page.selectOption('#gridded-view [data-role="variable"]', '/t2m');

        // A point read by bilinear interpolation: the value between the four
        // cells around it (exact on the fixture's linear field), a place of
        // its own even where a nearest-cell place stands; the "?" of the
        // panel explains both methods, over a blurred page.
        const groupsBeforeBilinear = (await objects()).groups.length;
        await page.click('#gridded-view [data-mode="point"]');
        await page.selectOption('#gridded-view [data-role="point-method"]', 'bilinear');
        await page.fill('#gridded-view [data-input="lat"]', '30');
        await page.fill('#gridded-view [data-input="lon"]', '22.5');
        // Under the ring, the cells the point is read from: the four cell
        // centres around it, joined and marked; one cell's edges for nearest.
        const stencil = () => page.evaluate(() => {
            const trace = (document.querySelector('#gridded-view [data-role="map"]')?.data || []).find(item => item.name === 'pending-stencil');
            const map = window.app._griddedVisibleView().map;
            return trace ? {
                mode: trace.mode, x: Array.from(trace.x), y: Array.from(trace.y),
                lons: Array.from(map.lon), lats: Array.from(map.lat),
            } : null;
        });
        await page.waitForFunction(() => (document.querySelector('#gridded-view [data-role="map"]')?.data || []).some(item => item.name === 'pending-stencil' && item.mode === 'lines+markers'));
        const corners = await stencil();
        assert(corners.x.every(value => corners.lons.includes(value)) && corners.y.every(value => corners.lats.includes(value)), 'bilinear corners are cell centres');
        assert(Math.min(...corners.x) < 22.5 && Math.max(...corners.x) > 22.5 && Math.min(...corners.y) <= 30 && Math.max(...corners.y) > 30, 'and surround the point');
        await page.selectOption('#gridded-view [data-role="point-method"]', 'nearest');
        await page.waitForFunction(() => (document.querySelector('#gridded-view [data-role="map"]')?.data || []).some(item => item.name === 'pending-stencil' && item.mode === 'lines'));
        const cell = await stencil();
        assert(Math.min(...cell.x) <= 22.5 && Math.max(...cell.x) >= 22.5 && Math.min(...cell.y) <= 30 && Math.max(...cell.y) >= 30, 'nearest outlines the cell holding the point');
        assert(!cell.x.some(value => cell.lons.includes(value)), 'by its edges, not its centre');
        await page.selectOption('#gridded-view [data-role="point-method"]', 'bilinear');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(count => window.app._griddedVisibleView().groups.length === count, groupsBeforeBilinear + 1, { timeout: 60000 });
        await page.waitForFunction(() => (document.querySelector('#gridded-view [data-role="map"]')?.data || []).some(item => Array.isArray(item.marker?.symbol) && item.marker.symbol.includes('diamond')));
        const symbols = await page.evaluate(() => {
            const view = window.app._griddedVisibleView();
            const trace = document.querySelector('#gridded-view [data-role="map"]').data.find(item => Array.isArray(item.marker?.symbol));
            const points = view.groups.filter(group => group.kind === 'point');
            return points.map((group, index) => [group.method || 'nearest', trace.marker.symbol[index]]);
        });
        symbols.forEach(([method, symbol]) => assert.equal(symbol, method === 'bilinear' ? 'diamond' : 'circle', `a ${method} point is drawn as a ${symbol}`));
        const interpolated = (await extractions(page)).filter(item => /\(bilinear\)$/.test(item.folder));
        assert.equal(interpolated.length, 1, 'one bilinear place');
        assert.match(interpolated[0].folder, /^P\d+ · 30°N 22\.5°E \(bilinear\)$/, 'the place is the point itself, marked bilinear');
        interpolated[0].values.forEach((value, step) => assert(Math.abs(value - field(30, 22.5, step, 5)) < 1e-3, `bilinear value at step ${step}`));
        await page.click('#gridded-view [data-mode="point"]');
        await page.selectOption('#gridded-view [data-role="point-method"]', 'nearest');
        await page.fill('#gridded-view [data-input="lat"]', '30');
        await page.fill('#gridded-view [data-input="lon"]', '22.5');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(count => window.app._griddedVisibleView().groups.length === count, groupsBeforeBilinear + 2, { timeout: 60000 });
        assert.equal(await page.evaluate(() => window.app._griddedVisibleView().groups.at(-1).method), 'nearest', 'nearest at the same coordinates is another place');
        await page.click('#gridded-view [data-action="methods-help"]');
        await page.waitForSelector('.gridded-help-dialog');
        const help = await page.evaluate(() => ({
            text: document.querySelector('.gridded-help-dialog').innerText,
            blur: getComputedStyle(document.querySelector('.modal-overlay')).backdropFilter,
            width: document.querySelector('.gridded-help-dialog').getBoundingClientRect().width / window.innerWidth,
        }));
        assert.ok(help.width >= 0.69, `the help uses most of the window's width (${help.width})`);
        assert.match(help.text, /Bilinear interpolation/, 'the help explains the point methods');
        assert.match(help.text, /weighted by area/, 'and the region statistics');
        assert.match(help.blur, /blur/, 'over a blurred page');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.gridded-help-dialog', { state: 'detached' });

        // The trash empties the list, after asking.
        await page.click('#gridded-view [data-action="remove-all"]');
        await page.click('.modal-overlay .modal-btn-confirm');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 0);
        assert.equal((await extractions(page)).length, 0, 'their variables leave the file too');

        // The time bar's buttons are drawn icons of one size; play turns into pause.
        const steps = await page.$$eval('#gridded-view .gridded-step', buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return { w: Math.round(rect.width), h: Math.round(rect.height), centre: Math.round(rect.top + rect.height / 2), svg: !!button.querySelector('svg') };
        }));
        assert.ok(steps.every(step => step.svg && step.w === steps[0].w && step.h === steps[0].h && step.centre === steps[0].centre), `aligned time buttons (${JSON.stringify(steps)})`);
        await page.click('#gridded-view [data-step="play"]');
        assert.equal(await page.getAttribute('#gridded-view [data-step="play"]', 'data-icon'), 'pause');
        await page.click('#gridded-view [data-step="play"]');
        assert.equal(await page.getAttribute('#gridded-view [data-step="play"]', 'data-icon'), 'play');

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

    // 1b. A touch screen: a tap in the point tool places the ring, a finger
    // drags it, and a finger elsewhere pans the map as on every plot.
    {
        const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, hasTouch: true });
        // The one-time touch tips are not what this checks.
        await context.addInitScript(() => localStorage.setItem('omv_touch_hint_seen', '1'));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-new-cds.nc'));
        await mapShown(page);
        await page.waitForTimeout(800);
        const toPage = (lon, lat) => page.evaluate(([lon, lat]) => {
            const div = document.querySelector('#gridded-view .gridded-map');
            const rect = div.getBoundingClientRect();
            const { xaxis, yaxis } = div._fullLayout;
            return [rect.left + xaxis._offset + xaxis.l2p(lon), rect.top + yaxis._offset + yaxis.l2p(lat)];
        }, [lon, lat]);
        const cdp = await context.newCDPSession(page);
        const fingerDrag = async (from, to) => {
            const point = ([x, y]) => [{ x, y, id: 1 }];
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
            for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point([from[0] + (to[0] - from[0]) * step / 8, from[1] + (to[1] - from[1]) * step / 8]) });
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(400);
        };
        await page.click('#gridded-view [data-mode="point"]');
        await page.touchscreen.tap(...await toPage(-30, 20));
        await page.waitForTimeout(400);
        let ring = await page.evaluate(() => window.app._griddedVisibleView().pendingPoint);
        assert.ok(ring && Math.abs(ring.lon + 30) < 2 && Math.abs(ring.lat - 20) < 2, `a tap places the ring (${JSON.stringify(ring)})`);
        const rangeBefore = await page.evaluate(() => [...document.querySelector('#gridded-view .gridded-map')._fullLayout.xaxis.range]);
        await fingerDrag(await toPage(-30, 20), await toPage(30, -20));
        ring = await page.evaluate(() => window.app._griddedVisibleView().pendingPoint);
        assert.ok(Math.abs(ring.lon - 30) < 2 && Math.abs(ring.lat + 20) < 2, `a finger drags the ring (${JSON.stringify(ring)})`);
        assert.deepEqual(await page.evaluate(() => [...document.querySelector('#gridded-view .gridded-map')._fullLayout.xaxis.range]), rangeBefore, 'dragging the ring does not pan the map');
        await fingerDrag(await toPage(100, -60), await toPage(60, -60));
        const rangeAfter = await page.evaluate(() => [...document.querySelector('#gridded-view .gridded-map')._fullLayout.xaxis.range]);
        assert.ok(rangeAfter[0] > rangeBefore[0] + 1, `a finger elsewhere pans the map (${rangeBefore} → ${rangeAfter})`);
        // In Region, a finger on the orange box moves it; Plotly does not
        // start drawing a new one under it.
        await page.click('#gridded-view [data-mode="region"]');
        await page.fill('#gridded-view [data-input="north"]', '40');
        await page.fill('#gridded-view [data-input="south"]', '-20');
        await page.fill('#gridded-view [data-input="west"]', '-40');
        await page.fill('#gridded-view [data-input="east"]', '40');
        await page.waitForTimeout(500);
        await fingerDrag(await toPage(0, 10), await toPage(20, 20));
        const box = await page.evaluate(() => window.app._griddedVisibleView().pendingBox);
        assert.ok(Math.abs(box.lonMin + 20) < 3 && Math.abs(box.lonMax - 60) < 3 && Math.abs(box.latMax - 50) < 3, `a finger moves the box (${JSON.stringify(box)})`);
        assert.equal(await page.evaluate(() => (document.querySelector('#gridded-view .gridded-map').layout.shapes || []).filter(shape => !shape.name).length), 0, 'no new box drawn under the finger');
        assert.deepEqual(errors, []);
        await context.close();
    }

    // 1c. A phone, upright and on its side: the map takes the width, the
    // colour bar lies under it, the tools scroll under the map; a placed
    // point is extracted from a button over the map, and a finger held on a
    // place opens its menu without scrolling the map away.
    {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await context.addInitScript(() => localStorage.setItem('omv_touch_hint_seen', '1'));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-new-cds.nc'));
        await mapShown(page);
        await page.waitForTimeout(1000);
        const layout = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const div = document.querySelector('#gridded-view .gridded-map');
            const label = document.querySelector('#gridded-view [data-role="time-label"]');
            return {
                compact: document.documentElement.classList.contains('compact'),
                map: rect('#gridded-view .gridded-map'),
                plot: { width: div._fullLayout.xaxis._length, height: div._fullLayout.yaxis._length },
                colorbar: div.data[0].colorbar.orientation,
                axisTitle: div._fullLayout.xaxis.title.text,
                toolbar: rect('#gridded-view .gridded-toolbar').height,
                labelHeight: label.getBoundingClientRect().height,
                pageWidth: document.documentElement.scrollWidth,
                help: document.querySelector('#gridded-view [data-role="mode-help"]').textContent,
            };
        });
        assert.equal(layout.compact, true, 'a phone gets the compact layout');
        assert.equal(layout.pageWidth, 390, 'nothing is wider than the phone');
        assert.equal(layout.colorbar, 'h', 'the colour bar lies under the map');
        assert.equal(layout.axisTitle, '', 'without axis titles');
        assert.ok(layout.plot.width > 390 * 0.8, `the map takes the width of the phone (${layout.plot.width}px)`);
        assert.ok(layout.map.height < 844 * 0.65 && Math.abs(layout.plot.height - layout.plot.width / 2) < 12, `as tall as a world map needs (${JSON.stringify(layout)})`);
        assert.ok(layout.toolbar < 90, `the toolbar is two rows (${layout.toolbar}px)`);
        assert.ok(layout.labelHeight < 24, `the time stays on one line (${layout.labelHeight}px)`);
        assert.match(layout.help, /pinch/, 'the help speaks of fingers');
        // The ring, then extract from over the map.
        await page.click('#gridded-view [data-mode="point"]');
        await page.evaluate(() => { document.querySelector('#gridded-view .gridded-main').scrollTop = 0; });
        const phoneAt = (lon, lat) => page.evaluate(([lon, lat]) => {
            const div = document.querySelector('#gridded-view .gridded-map');
            const rect = div.getBoundingClientRect();
            const { xaxis, yaxis } = div._fullLayout;
            return [rect.left + xaxis._offset + xaxis.l2p(lon), rect.top + yaxis._offset + yaxis.l2p(lat)];
        }, [lon, lat]);
        assert.equal(await page.isVisible('#gridded-view [data-action="map-extract"]'), false, 'no button over the map before a point is placed');
        await page.touchscreen.tap(...await phoneAt(45, 15));
        await page.waitForSelector('#gridded-view [data-action="map-extract"]:visible');
        await page.click('#gridded-view [data-action="map-extract"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 1, null, { timeout: 60000 });
        await page.waitForTimeout(600);
        // A finger held on P1: its menu, and the map stays where it is.
        const cdp = await context.newCDPSession(page);
        const p1 = await phoneAt(45, 15);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p1[0], y: p1[1], id: 1 }] });
        await page.waitForTimeout(800);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(300);
        const held = await page.evaluate(() => ({
            menu: [...document.querySelectorAll('.gridded-context-menu button')].map(button => button.textContent),
            scrolled: document.querySelector('#gridded-view .gridded-main').scrollTop,
            groups: window.app._griddedVisibleView().groups.length,
            point: window.app._griddedVisibleView().pendingPoint,
        }));
        assert.ok(held.menu.some(text => /Remove P1/.test(text)), `holding a place opens its menu (${JSON.stringify(held)})`);
        assert.equal(held.scrolled, 0, 'and does not scroll the map away');
        assert.equal(held.groups, 1);
        await page.click('.gridded-context-menu button:last-child');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 0);
        // The colour menu stays on the screen.
        await page.click('#gridded-view [data-action="autofit-menu"]');
        const menuBox = await page.$eval('#gridded-view [data-role="autofit-menu"]', el => { const rect = el.getBoundingClientRect(); return [rect.left, rect.right]; });
        assert.ok(menuBox[0] >= 0 && menuBox[1] <= 390, `the colour menu fits the phone (${menuBox})`);
        await page.click('#gridded-view [data-action="autofit-menu"]');
        // On its side the phone is short of height: the bar goes back beside the map.
        await page.setViewportSize({ width: 844, height: 390 });
        await page.waitForFunction(() => document.querySelector('#gridded-view .gridded-map').data[0].colorbar.orientation !== 'h', null, { timeout: 10000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 844);
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

    // 6. A project keeps the map: its places, their series and their values,
    //    what the map was showing, and the panel that plotted them.
    {
        const { context, page, errors } = await openApp();
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-new-cds.nc'));
        await mapShown(page);
        // A point at a typed place, on t2m.
        await page.click('#gridded-view [data-mode="point"]');
        await page.selectOption('#gridded-view [data-role="variable"]', '/t2m');
        await page.fill('#gridded-view [data-input="lat"]', '44');
        await page.fill('#gridded-view [data-input="lon"]', '92');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 1, null, { timeout: 60000 });
        // The same place again, with another variable at both its levels:
        // one folder, three series.
        await page.click('#gridded-view .gridded-result[data-group="g1"] [data-action="reuse-group"]');
        await page.selectOption('#gridded-view [data-role="variable"]', '/t');
        await page.click('#gridded-view [data-action="levels-menu"]');
        await page.click('#gridded-view [data-action="levels-all"]');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups[0].sets.length === 3, null, { timeout: 60000 });
        // And a region, back on t2m (a surface field, so no levels to pick):
        // mean, minimum and maximum, three series.
        await page.selectOption('#gridded-view [data-role="variable"]', '/t2m');
        await page.click('#gridded-view [data-mode="region"]');
        await page.fill('#gridded-view [data-input="north"]', '50');
        await page.fill('#gridded-view [data-input="south"]', '0');
        await page.fill('#gridded-view [data-input="west"]', '-50');
        await page.fill('#gridded-view [data-input="east"]', '50');
        await page.click('#gridded-view [data-action="extract-region"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 2, null, { timeout: 60000 });
        // One series unchecked: that too is part of the state.
        await page.uncheck('#gridded-view .gridded-result[data-group="g1"] .gridded-set:nth-child(2) input[type="checkbox"]');
        // What the map shows: another step, another palette, typed ends (all
        // three under the "Color range" button).
        await page.click('#gridded-view [data-step="next"]');
        await page.click('#gridded-view [data-action="autofit-menu"]');
        await page.selectOption('#gridded-view [data-role="palette"]', 'Cividis');
        await page.fill('#gridded-view [data-role="range-min"]', '250');
        await page.fill('#gridded-view [data-role="range-max"]', '300');
        await page.dispatchEvent('#gridded-view [data-role="range-max"]', 'change');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        // The checked series in a panel of the explorer: two of P1 (one is
        // unchecked) and the three of R1. They are added one at a time, so
        // wait until the panel has stopped filling.
        await page.click('#gridded-view [data-action="plot"]');
        await page.waitForSelector('#gridded-return:not([hidden])');
        const extractionTraces = () => page.evaluate(() => [...window.app.plotManager.plots.values()]
            .filter(plot => plot.traces.some(trace => String(trace.varName).startsWith('grid:x')))
            .map(plot => plot.traces.length));
        await page.waitForFunction(() => new Promise(resolve => {
            const count = () => [...window.app.plotManager.plots.values()]
                .reduce((total, plot) => total + plot.traces.filter(trace => String(trace.varName).startsWith('grid:x')).length, 0);
            const before = count();
            setTimeout(() => resolve(before > 0 && count() === before), 900);
        }), null, { timeout: 60000, polling: 300 });
        assert.deepEqual(await extractionTraces(), [5], 'the checked series are in one panel');
        await page.click('#gridded-return');
        await mapShown(page);

        const before = await page.evaluate(() => {
            const view = window.app._griddedVisibleView();
            const data = window.app.plotManager.files.get(view.fileId).data;
            const node = Object.values(data.tree._children).find(child => child._griddedExtractions);
            return {
                groups: view.groups.map(group => ({
                    tag: group.tag, kind: group.kind, where: group.where, color: group.color,
                    geometry: group.geometry,
                    sets: group.sets.map(set => ({
                        label: set.label, checked: set.checked, color: set.color, key: set.key,
                        variableKey: set.variableKey, levelIndex: set.levelIndex,
                        names: [...set.names], roles: [...set.roles],
                    })),
                })),
                variableKey: view.variableKey,
                selection: { ...view.selection },
                palette: view.palette,
                scale: { range: view.scale.range, source: view.scale.source },
                folders: Object.entries(node._children).map(([folder, place]) => [folder, Object.keys(place._variables)]),
                values: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, Array.from(variable.data)])),
                labels: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, variable.displayName])),
                traces: [...window.app.plotManager.plots.entries()]
                    .filter(([, plot]) => plot.traces.some(trace => String(trace.varName).startsWith('grid:x')))
                    .map(([panelId, plot]) => [panelId, plot.traces.map(trace => trace.varName).sort()]),
                mapOpen: !document.getElementById('gridded-view').hidden,
            };
        });
        assert.equal(before.groups.length, 2);
        assert.equal(before.groups[0].sets.length, 3, 'one folder with the three series of the place');
        assert.deepEqual(before.groups[0].sets.map(set => [set.variableKey, set.levelIndex]), [['/t2m', null], ['/t', 0], ['/t', 1]],
            'every set says which field and which level it was read from');

        // Save the project (the bytes the download would carry), then load it
        // back over the workspace, as a user would after reopening the app.
        const saved = await page.evaluate(async () => {
            const original = window.app._downloadBlob;
            let blob = null;
            window.app._downloadBlob = value => { blob = value; };
            const ok = await window.app.saveProjectSession();
            window.app._downloadBlob = original;
            if (!ok || !blob) return null;
            window.__project = blob;
            const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
            const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
            const session = JSON.parse(strFromU8(entries['session.json']));
            return { names: Object.keys(entries), gridded: session.files[0].gridded, size: blob.size };
        });
        assert.ok(saved, 'the project is saved');
        assert.equal(saved.gridded.files.length, 1, 'the dataset lists the file it was opened from');
        assert.ok(saved.names.includes(saved.gridded.files[0].archivePath), 'and the archive carries it');
        assert.equal(saved.gridded.view.groups.length, 2, 'the places travel with the session');
        assert.equal(saved.gridded.view.palette, 'Cividis');
        assert.deepEqual(saved.gridded.view.scale.range, [250, 300]);

        const loaded = await page.evaluate(async () => {
            const file = new File([window.__project], 'project.zip');
            return window.app.loadSessionOrProjectFile(file, { replaceConfirmed: true, silent: true });
        });
        assert.equal(loaded, true, 'the project loads');
        await page.waitForFunction(() => !document.getElementById('gridded-view')?.hidden, null, { timeout: 60000 });
        await page.waitForTimeout(800);

        const after = await page.evaluate(() => {
            const view = window.app._griddedVisibleView();
            const data = window.app.plotManager.files.get(view.fileId).data;
            const node = Object.values(data.tree._children).find(child => child._griddedExtractions);
            return {
                files: window.app.files.size,
                groups: view.groups.map(group => ({
                    tag: group.tag, kind: group.kind, where: group.where, color: group.color,
                    geometry: group.geometry,
                    sets: group.sets.map(set => ({
                        label: set.label, checked: set.checked, color: set.color, key: set.key,
                        variableKey: set.variableKey, levelIndex: set.levelIndex,
                        names: [...set.names], roles: [...set.roles],
                    })),
                })),
                variableKey: view.variableKey,
                selection: { ...view.selection },
                palette: view.palette,
                scale: { range: view.scale.range, source: view.scale.source },
                folders: Object.entries(node._children).map(([folder, place]) => [folder, Object.keys(place._variables)]),
                values: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, Array.from(variable.data)])),
                labels: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, variable.displayName])),
                traces: [...window.app.plotManager.plots.entries()]
                    .filter(([, plot]) => plot.traces.some(trace => String(trace.varName).startsWith('grid:x')))
                    .map(([panelId, plot]) => [panelId, plot.traces.map(trace => trace.varName).sort()]),
                mapOpen: !document.getElementById('gridded-view').hidden,
                rows: document.querySelectorAll('#gridded-view .gridded-result').length,
            };
        });
        assert.equal(after.files, 1, 'one dataset, not one file per member');
        assert.deepEqual(after.groups, before.groups, 'the places, their series, colours and ticks come back');
        assert.deepEqual(after.folders, before.folders, 'the tree has the same folders and the same names');
        assert.deepEqual(after.values, before.values, 'with the same values');
        assert.deepEqual(after.labels, before.labels, 'and the same names on the curves');
        assert.deepEqual(after.traces, before.traces, 'the panel that plotted them plots them again');
        assert.equal(after.variableKey, before.variableKey);
        assert.deepEqual(after.selection, before.selection, 'the variable, level and step of the map');
        assert.equal(after.palette, 'Cividis');
        assert.deepEqual(after.scale, { range: [250, 300], source: 'manual' }, 'the colour range as it was typed');
        assert.equal(after.mapOpen, true, 'a project saved with the map open opens on it');
        assert.equal(after.rows, 2, 'the panel lists both places');
        // Another extraction after the restore gets its own name and tag.
        await page.click('#gridded-view [data-mode="point"]');
        await page.fill('#gridded-view [data-input="lat"]', '-15');
        await page.fill('#gridded-view [data-input="lon"]', '135');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 3, null, { timeout: 60000 });
        const fresh = await page.evaluate(() => {
            const view = window.app._griddedVisibleView();
            const data = window.app.plotManager.files.get(view.fileId).data;
            const group = view.groups.at(-1);
            return { tag: group.tag, names: group.sets[0].names, known: Object.keys(data.variables).filter(name => name.startsWith('grid:x')).length };
        });
        assert.equal(fresh.tag, 'P2', 'the next point is P2, not P1 again');
        assert.equal(fresh.names.every(name => !Object.keys(before.values).includes(name)), true, 'and its series take new names');
        assert.equal(fresh.known, Object.keys(before.values).length + 1);

        // The same map as a view session (JSON, no data at all), applied over
        // the file that is already open: the trash empties the list, the
        // session puts every place, name and value back.
        const mapState = () => page.evaluate(() => {
            const view = window.app._griddedVisibleView();
            const data = window.app.plotManager.files.get(view.fileId).data;
            const node = Object.values(data.tree._children).find(child => child._griddedExtractions);
            return {
                tags: view.groups.map(group => group.tag),
                folders: Object.entries(node._children).map(([folder, place]) => [folder, Object.keys(place._variables)]),
                values: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, Array.from(variable.data)])),
            };
        });
        const beforeView = await mapState();
        const viewJson = await page.evaluate(async () => {
            const original = window.app._downloadBlob;
            let blob = null;
            window.app._downloadBlob = value => { blob = value; };
            await window.app.saveViewSession();
            window.app._downloadBlob = original;
            return blob ? blob.text() : null;
        });
        assert.equal(viewJson ? JSON.parse(viewJson).files[0].gridded.view.groups.length : 0, 3,
            'a view session carries the places too');
        await page.click('#gridded-view [data-action="remove-all"]');
        await page.click('.modal-overlay .modal-btn-confirm');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 0);
        assert.equal((await extractions(page)).length, 0);
        // The dialog that says the session was applied is answered as it comes.
        const applying = page.evaluate(json => window.app.loadSessionOrProjectFile(new File([json], 'view.json')), viewJson);
        await page.waitForSelector('.modal-overlay.show .modal-btn-confirm', { timeout: 60000 });
        await page.click('.modal-overlay.show .modal-btn-confirm');
        await applying;
        await page.waitForTimeout(500);
        assert.deepEqual(await mapState(), beforeView, 'the JSON alone puts the places, their names and their values back');
        assert.deepEqual(errors, []);
        await context.close();
    }

    // 7. A dataset of several files (here the CDS ZIP read as one): the
    //    project keeps every file and the way they were joined.
    {
        const { context, page, errors } = await openApp();
        await page.setInputFiles('#file-input', resolve(FIXTURES, 'era5-like-instant-accum.zip'));
        await page.waitForSelector('.modal-overlay.show .modal-btn-confirm', { timeout: 60000 });
        await page.click('.modal-overlay.show .modal-btn-confirm');
        await mapShown(page);
        await page.click('#gridded-view [data-mode="point"]');
        await page.fill('#gridded-view [data-input="lat"]', '44');
        await page.fill('#gridded-view [data-input="lon"]', '92');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups.length === 1, null, { timeout: 60000 });
        // The same place on the other variable, whose unit is not the same
        // (total precipitation in m against a temperature in K): the preview
        // gives it its own axis instead of reading it in kelvin.
        await page.click('#gridded-view .gridded-result[data-group="g1"] [data-action="reuse-group"]');
        await page.selectOption('#gridded-view [data-role="variable"]', '/tp');
        await page.click('#gridded-view [data-action="extract-point"]');
        await page.waitForFunction(() => window.app._griddedVisibleView().groups[0].sets.length === 2, null, { timeout: 60000 });
        await page.waitForTimeout(600);
        const axes = await page.evaluate(() => {
            const chart = document.querySelector('#gridded-view [data-role="preview-chart"]');
            const layout = chart._fullLayout;
            return {
                y: layout.yaxis.title.text,
                y2: layout.yaxis2?.title.text,
                y2Shown: !!layout.yaxis2?.visible,
                traces: chart.data.map(trace => [trace.name, trace.yaxis || 'y']),
            };
        });
        assert.equal(axes.y, 'K', 'the first unit keeps the left axis');
        assert.equal(axes.y2, 'm', 'the other one gets the axis on the right');
        assert.equal(axes.y2Shown, true);
        assert.deepEqual(axes.traces.map(([, axis]) => axis), ['y', 'y2'], 'each curve is drawn against its own unit');
        assert.ok(axes.traces.every(([name]) => /\[(K|m)\]$/.test(name)), `mixed units are named in the legend (${JSON.stringify(axes.traces)})`);
        const before = await page.evaluate(() => {
            const entry = [...window.app.files.values()][0];
            const view = window.app._griddedVisibleView();
            const data = window.app.plotManager.files.get(view.fileId).data;
            return {
                members: entry.gridded.files.map(file => file.name).sort(),
                options: entry.gridded.options,
                name: entry.name,
                variables: [...document.querySelectorAll('#gridded-view [data-role="variable"] option')].map(option => option.value).sort(),
                values: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, Array.from(variable.data)])),
            };
        });
        assert.equal(before.members.length, 2, 'the ZIP was opened as one dataset of two files');

        const saved = await page.evaluate(async () => {
            const original = window.app._downloadBlob;
            let blob = null;
            window.app._downloadBlob = value => { blob = value; };
            const ok = await window.app.saveProjectSession();
            window.app._downloadBlob = original;
            if (!ok || !blob) return null;
            window.__project = blob;
            const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
            const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
            const session = JSON.parse(strFromU8(entries['session.json']));
            return {
                names: Object.keys(entries),
                gridded: session.files[0].gridded,
                sizes: session.files[0].gridded.files.map(member => entries[member.archivePath]?.length || 0),
            };
        });
        assert.ok(saved, 'a dataset of several files can be saved at all (it has no single file of its own)');
        assert.equal(saved.gridded.files.length, 2, 'both files are listed');
        assert.deepEqual(saved.gridded.files.map(member => member.name).sort(), before.members);
        assert.ok(saved.sizes.every(size => size > 0), `both files are in the archive (${saved.sizes})`);
        assert.equal(saved.gridded.options.mode, 'merge-variables', 'and the way they were joined');

        const loaded = await page.evaluate(async () => {
            const file = new File([window.__project], 'project.zip');
            return window.app.loadSessionOrProjectFile(file, { replaceConfirmed: true, silent: true });
        });
        assert.equal(loaded, true);
        await page.waitForFunction(() => !document.getElementById('gridded-view')?.hidden, null, { timeout: 60000 });
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => {
            const entry = [...window.app.files.values()][0];
            const view = window.app._griddedVisibleView();
            const data = window.app.plotManager.files.get(view.fileId).data;
            return {
                files: window.app.files.size,
                members: entry.gridded.files.map(file => file.name).sort(),
                options: entry.gridded.options,
                name: entry.name,
                variables: [...document.querySelectorAll('#gridded-view [data-role="variable"] option')].map(option => option.value).sort(),
                values: Object.fromEntries(Object.entries(data.variables)
                    .filter(([name]) => name.startsWith('grid:x'))
                    .map(([name, variable]) => [name, Array.from(variable.data)])),
            };
        });
        assert.equal(after.files, 1, 'one dataset again, not two files');
        assert.deepEqual(after.members, before.members);
        assert.deepEqual(after.options, before.options);
        assert.equal(after.name, before.name, 'with the name it had');
        assert.deepEqual(after.variables, before.variables, 'both files\' variables are on the map again');
        assert.deepEqual(after.values, before.values, 'and the series extracted from it');
        assert.deepEqual(errors, []);
        await context.close();
    }

    console.log('Gridded netCDF e2e passed: map, point and box extractions, slider, plotting, CDS ZIP, series files untouched, GRIB message, desktop path, projects that keep the map.');
} finally {
    await browser.close();
    await server.close();
}
