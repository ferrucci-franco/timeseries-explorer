// Captures the figures of the user manual (public/manual/img/*.webp).
//
// The list is MANUAL_FIGURES in scripts/manual/render-manual.mjs. A figure is
// either a bundled example as the Examples menu opens it, or a scene: a small
// function below, of the figure's id, that drives the real app to the state
// to show (loads a generated file, plots signals, turns an analysis on, opens
// a dialog) and may return a `clip`, the part of the window to keep when the
// whole of it would make the subject too small.
//
// Every figure is taken in the light theme, in English, on one of three
// screens: a desktop window, a phone held upright or a tablet held sideways.
// The data is seeded (scripts/manual/figure-data.mjs), the script waits on
// conditions and parks the pointer, so two runs give the same picture.
//
//   npm run manual:figures                       every figure
//   npm run manual:figures -- --only cursors     one (or several, comma-separated)
//   npm run manual:figures -- --out some/dir     somewhere else than public/manual/img
//
// Run it again when the look of the app has changed enough for a figure to
// mislead. Needs a Chromium for Playwright.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';
import translations from '../src/i18n/translations.js';
import { MANUAL_FIGURES, MANUAL_FIGURE_SCALE } from './manual/render-manual.mjs';
import { gapsCsv, largeCsv, loggerCsv, noisyCsv, pendulumRuns, signalsCsv, stepCsv, trendCsv } from './manual/figure-data.mjs';

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
};
const only = option('--only')?.split(',').map(id => id.trim()).filter(Boolean) || null;
const outDir = option('--out') ? resolve(option('--out')) : fileURLToPath(new URL('../public/manual/img/', import.meta.url));

// ── The three screens ───────────────────────────────────────────────────────
// The phone is an iPhone 15 with Safari's toolbar folded away (393 x 740 of
// its 852 px); the tablet an iPad held sideways (1080 x 810) or upright
// (810 x 1080). Both are Playwright's device profiles as they are, touch and
// mobile flags included: the figure shows what such a device gets, not a
// desktop window of the same size.
const DESKTOP = { width: 1280, height: 800 };
const SCREENS = {
    desktop: { viewport: DESKTOP, deviceScaleFactor: MANUAL_FIGURE_SCALE },
    phone: { ...devices['iPhone 15'], viewport: { width: 393, height: 740 } },
    tablet: { ...devices['iPad (gen 7) landscape'] },
    'tablet-portrait': { ...devices['iPad (gen 7)'] },
};
// A single panel is easier to read in a smaller window than in a large one
// shrunk to the width of the page.
const SMALL = { width: 1040, height: 680 };
// And a tall one shows a whole sidebar: files, variables and parameters.
const TALL = { width: 1280, height: 960 };
const WEBP_QUALITY = 82;

// ── What the scenes are made of ─────────────────────────────────────────────
const t = key => translations.en[key];
const pause = (page, ms) => page.waitForTimeout(ms);

async function waitForApp(page) {
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(async () => {
        const app = window.app;
        if (app.theme !== 'light') app.toggleTheme();
        if (window.i18n?.currentLang && window.i18n.currentLang !== 'en') await app.setLanguage('en');
    });
    await page.waitForFunction(() => document.body.classList.contains('theme-light'));
}

const isPhone = page => page.evaluate(() => document.documentElement.classList.contains('compact'));

/** Open a bundled example the way a reader does: from the Examples menu. */
async function openExample(page, key) {
    if (await isPhone(page)) {
        await page.locator('.compact-try-example').click();
        await page.locator('.compact-sheet').getByText(t(key), { exact: true }).click();
    } else {
        await page.click('#welcome-examples-btn');
        await page.getByText(t(key), { exact: true }).first().click();
    }
    await page.waitForFunction(() => window.app.plotManager.files.size >= 1, null, { timeout: 120000 });
    await settle(page, 6000);
}

/** Open generated files through the app's file input. */
async function openFiles(page, files) {
    const list = Array.isArray(files) ? files : [files];
    const before = await page.evaluate(() => window.app.plotManager.files.size);
    await page.setInputFiles('#file-input', list);
    await page.waitForFunction(count => window.app.plotManager.files.size >= count, before + list.length, { timeout: 120000 });
    await pause(page, 500);
}

const panelIds = page => page.evaluate(() => [...document.querySelectorAll('.layout-panel')].map(panel => panel.dataset.id));

/** Put variables of a file (by its position in the list) on a panel. */
async function plot(page, panelId, names, fileIndex = 0) {
    await page.evaluate(({ panelId, names, fileIndex }) => {
        const app = window.app;
        const fileId = [...app.plotManager.files.keys()][fileIndex];
        app.setActiveFile(fileId);
        const panel = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        for (const name of names) app.plotManager.addTrace(panelId, name, panel, fileId);
    }, { panelId, names, fileIndex });
    await page.waitForFunction(id => {
        const item = window.app.plotManager.plots.get(id);
        return (item?.traces?.length || item?.phaseTraces?.length || 0) > 0;
    }, panelId, { timeout: 60000 });
}

async function split(page, panelId, direction) {
    const before = (await panelIds(page)).length;
    await page.evaluate(({ panelId, direction }) => window.app.layoutManager.splitPanel(panelId, direction, false), { panelId, direction });
    await page.waitForFunction(count => document.querySelectorAll('.layout-panel').length > count, before);
    return (await panelIds(page)).find(id => id !== panelId);
}

/** Pick an analysis from the panel's Analysis menu. */
async function analysis(page, panelId, mark) {
    await page.locator(`.layout-panel[data-id="${panelId}"] .timeseries-analysis-menu-btn`).click();
    await page.locator(`.analysis-card.marks-item-${mark}`).click();
    await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
    await settle(page, 1500);
}

/** Everything has finished loading, computing and drawing; the pointer is out of the way. */
async function settle(page, ms = 1200) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.analysis-computing-indicator'), null, { timeout: 120000 }).catch(() => {});
    await pause(page, ms);
    const size = page.viewportSize();
    if (!(await page.evaluate(() => navigator.maxTouchPoints > 0))) await page.mouse.move(size.width - 5, size.height - 5);
}

const closeNotices = page => page.evaluate(() => document.querySelectorAll('.dismissible-notice').forEach(notice => notice.remove()));

/** The rectangle around some elements, with a margin, kept inside the window. */
async function clipAround(page, selectors, margin = 12) {
    const size = page.viewportSize();
    const box = await page.evaluate((list) => {
        const boxes = list.flatMap(selector => [...document.querySelectorAll(selector)])
            .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
        if (!boxes.length) return null;
        return {
            left: Math.min(...boxes.map(rect => rect.left)), top: Math.min(...boxes.map(rect => rect.top)),
            right: Math.max(...boxes.map(rect => rect.right)), bottom: Math.max(...boxes.map(rect => rect.bottom)),
        };
    }, [].concat(selectors));
    if (!box) throw new Error(`nothing to clip around: ${selectors}`);
    const x = Math.max(0, Math.floor(box.left - margin));
    const y = Math.max(0, Math.floor(box.top - margin));
    return { x, y, width: Math.min(size.width, Math.ceil(box.right + margin)) - x, height: Math.min(size.height, Math.ceil(box.bottom + margin)) - y };
}

const sheet = (page, name) => page.locator(`.compact-nav-btn[data-sheet="${name}"]`).click();
const phonePlot = page => page.evaluate(() => window.app._compactActivePanelId());

// ── The scenes ──────────────────────────────────────────────────────────────

/** The start screen, before any file. */
async function welcome(page) {
    await settle(page, 600);
}

/** The CSV parsing preview on a logger file with a preamble and decimal commas. */
async function csvPreview(page) {
    await openFiles(page, loggerCsv());
    const [panel] = await panelIds(page);
    await plot(page, panel, ['Pressure', 'Flow']);
    await page.locator('#files-list .file-entry-csv-parsing').first().click({ force: true });
    // Show the lines above the header too: they are what the dialog skipped.
    await page.getByLabel(t('csvPreviewHidePreambleRows'), { exact: true }).uncheck();
    await settle(page, 1500);
    return { clip: await clipAround(page, '.csv-preview-dialog', 10) };
}

/** Three runs of a Modelica model: its tree with parameters, and the runs overlaid. */
async function modelicaTree(page) {
    await openFiles(page, pendulumRuns());
    const [panel] = await panelIds(page);
    for (const index of [0, 1, 2]) await plot(page, panel, ['theta'], index);
    await settle(page);
}

/** The sidebar with a filter typed and several variables selected. */
async function sidebarFilter(page) {
    await openFiles(page, pendulumRuns()[0]);
    const [panel] = await panelIds(page);
    await plot(page, panel, ['theta']);
    await page.locator('.variable-filter-wrap input').fill('omega');
    await pause(page, 400);
    const item = name => page.locator(`#variables-tree .tree-item[data-var-name="${name}"]`);
    await item('omega').click({ modifiers: ['Control'] });
    await item('omega_deg_s').click({ modifiers: ['Control'] });
    await item('omega0_deg').click({ modifiers: ['Control'] });
    await settle(page);
    return { clip: { x: 0, y: 0, width: 720, height: 500 } };
}

/** Two signals of different scales, the second on the right axis; the View menu open. */
async function rightAxis(page) {
    await openFiles(page, loggerCsv());
    const [panel] = await panelIds(page);
    await page.click('#toggle-sidebar');
    await plot(page, panel, ['Pressure', 'Flow']);
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        pm._toggleTimeseriesY2(id);
        pm.plots.get(id).traces.find(trace => trace.varName === 'Flow').axis = 'y2';
        pm._rebuildPanel(id);
    }, panel);
    await settle(page);
    await page.locator(`.layout-panel[data-id="${panel}"] .panel-view-btn`).click();
    await pause(page, 400);
}

/** Marks: the holes and the lost values of a measurement. */
async function marksGaps(page) {
    await openFiles(page, gapsCsv());
    const [panel] = await panelIds(page);
    await page.click('#toggle-sidebar');
    await plot(page, panel, ['level', 'flow']);
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        pm._toggleNaN(id);
        pm._toggleGaps(id);
    }, panel);
    await settle(page, 1500);
}

/** A dashboard of value cards beside the time series of the same signals. */
async function dashboard(page) {
    await openFiles(page, loggerCsv());
    const [left] = await panelIds(page);
    await plot(page, left, ['Pressure', 'Flow', 'Temperature']);
    const right = await split(page, left, 'h');
    await plot(page, right, ['Pressure', 'Flow', 'Temperature']);
    await page.evaluate(id => window.app.plotManager._setMode(id, 'dashboard', null, { preserveTimeTraces: true }), right);
    await settle(page, 1500);
}

/** The Time axis menu of a file. */
async function timeAxis(page) {
    await openFiles(page, loggerCsv());
    const [panel] = await panelIds(page);
    await plot(page, panel, ['Pressure']);
    await page.locator('#files-list .file-entry-transform').first().click({ force: true });
    await settle(page, 1200);
    return { clip: { x: 0, y: 0, width: 760, height: 680 } };
}

/** One signal of the power-grid example alone in a panel, turned into an analysis. */
async function powerGridPanel(page, mark) {
    await openExample(page, 'examplePowergridTimeseries');
    const names = await page.evaluate(() => {
        const pm = window.app.plotManager;
        const first = [...pm.plots.values()].find(item => item.traces?.length);
        const trace = first.traces[0];
        pm.clearAll();
        return { fileId: trace.fileId, varName: trace.varName };
    });
    await page.evaluate(() => window.app.layoutManager.resetLayout?.());
    await page.click('#toggle-sidebar');
    await pause(page, 500);
    const [panel] = await panelIds(page);
    await page.evaluate(({ panel, names }) => {
        const app = window.app;
        app.setActiveFile(names.fileId);
        app.plotManager.addTrace(panel, names.varName, document.querySelector(`.layout-panel[data-id="${panel}"]`), names.fileId);
    }, { panel, names });
    await analysis(page, panel, mark);
    await settle(page, 2500);
    return panel;
}

/** The distribution of a year of a load. */
async function histogram(page) {
    await powerGridPanel(page, 'histogram');
}

/** A year of a load as a calendar heatmap. */
async function heatmap(page) {
    await powerGridPanel(page, 'heatmap');
}

/** The energy of a year of a load, month by month. */
async function integral(page) {
    const panel = await powerGridPanel(page, 'integral');
    // Group by month: the select of the options panel that offers it.
    await page.evaluate((id) => {
        const select = [...document.querySelectorAll(`.layout-panel[data-id="${id}"] select`)]
            .find(node => [...node.options].some(item => item.value === 'month') && [...node.options].some(item => item.value === 'none'));
        select.value = 'month';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, panel);
    await settle(page, 2500);
}

/** A first-order response fitted to the rise of a temperature. */
async function curveFitTime(page) {
    await openFiles(page, stepCsv());
    const [panel] = await panelIds(page);
    await page.click('#toggle-sidebar');
    await plot(page, panel, ['temperature']);
    await analysis(page, panel, 'curve-fit');
    await page.evaluate(id => window.app.plotManager._updateCurveFitEntry(id, { model: 'first-order-offset', x1: 20, x2: 110 }), panel);
    await settle(page, 2500);
}

/** The trend analysis: the mean and the slope of a stretch of a signal. */
async function trend(page) {
    await openFiles(page, trendCsv());
    const [panel] = await panelIds(page);
    await page.click('#toggle-sidebar');
    await plot(page, panel, ['pressure']);
    await analysis(page, panel, 'trend');
    await page.evaluate(id => window.app.plotManager._updateTrendSegment(id, { x1: 650, x2: 1150 }), panel);
    await page.locator('.trend-options').getByLabel('Linear', { exact: true }).check();
    await settle(page, 2500);
}

/** Cursors A and B on two signals, with their readout. */
async function cursors(page) {
    await openFiles(page, pendulumRuns()[0]);
    const [panel] = await panelIds(page);
    await page.click('#toggle-sidebar');
    await plot(page, panel, ['theta', 'omega']);
    await page.locator(`.layout-panel[data-id="${panel}"] .cursor-btn`).click();
    await settle(page, 1500);
}

/** The statistics of the signals of a panel. */
async function statistics(page) {
    await openFiles(page, pendulumRuns()[0]);
    const [panel] = await panelIds(page);
    await plot(page, panel, ['theta', 'omega']);
    await page.locator(`.layout-panel[data-id="${panel}"] .panel-stats-btn`).dispatchEvent('click');
    await page.locator('.modal-dialog-stats').waitFor();
    await settle(page);
    return { clip: await clipAround(page, '.modal-dialog-stats', 10) };
}

/** Runs of a simulation overlaid; the hover names the parameter that differs. */
async function compareRuns(page) {
    await openFiles(page, pendulumRuns());
    const [panel] = await panelIds(page);
    await page.click('#toggle-sidebar');
    await plot(page, panel, ['theta'], 0);
    // The panel's own command: the same signal from every open file.
    await page.locator(`.layout-panel[data-id="${panel}"] .compare-files-btn`).click();
    await page.locator('.modal-overlay .modal-btn-confirm').click();
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
    await settle(page, 1500);
    const point = await page.evaluate((id) => {
        const div = window.app.plotManager.plots.get(id).div;
        const rect = div.getBoundingClientRect();
        const { xaxis, yaxis } = div._fullLayout;
        const trace = div.data[1];
        const index = trace.x.findIndex(value => Number(value) >= 3.1);
        return { x: rect.left + xaxis._offset + xaxis.l2p(Number(trace.x[index])), y: rect.top + yaxis._offset + yaxis.l2p(Number(trace.y[index])) };
    }, panel);
    await page.mouse.move(point.x - 30, point.y - 20);
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await pause(page, 1500);
}

/** The Data tools of the sidebar, with the card of the tool under the pointer. */
async function dataTools(page) {
    await openFiles(page, noisyCsv());
    const [panel] = await panelIds(page);
    await plot(page, panel, ['vibration']);
    await page.locator('.data-tools-section').scrollIntoViewIfNeeded();
    await settle(page);
    await page.locator('.data-tool-tile[data-tool="filter"]').hover();
    await page.locator('#data-tool-hovercard:not([hidden])').waitFor();
    await pause(page, 600);
    return { clip: { x: 0, y: 0, width: 800, height: 800 } };
}

/** A low-pass filter being designed, its result drawn over the raw signal. */
async function digitalFilter(page) {
    await openFiles(page, noisyCsv());
    const [panel] = await panelIds(page);
    await plot(page, panel, ['vibration']);
    await page.locator('.data-tool-tile[data-tool="filter"]').click();
    await page.locator('#outlier-variable').selectOption('vibration');
    await page.locator('#filter-design-cutoff').fill('10');
    await page.locator('#filter-design-cutoff').dispatchEvent('change');
    await settle(page, 2500);
    await page.locator('#filter-design-cutoff').scrollIntoViewIfNeeded();
    await settle(page, 600);
}

/** The formula editor, with a derived variable being written. */
async function derivedEditor(page) {
    await openFiles(page, pendulumRuns()[0]);
    const [panel] = await panelIds(page);
    await plot(page, panel, ['Ekin']);
    await page.locator('#derived-toggle').click();
    await page.locator('#derived-name').fill('Ekin_check');
    await page.locator('#derived-expand').click();
    await page.locator('.formula-editor-formula').fill('0.5 * m * (L * omega)^2');
    await settle(page, 1200);
    return { clip: await clipAround(page, '.formula-editor', 10) };
}

/** A CSV past its size limit: open in memory-saving mode, with the clover by its name. */
async function memorySaving(page) {
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 2 }));
    await openFiles(page, largeCsv());
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    const [panel] = await panelIds(page);
    await plot(page, panel, ['speed']);
    await settle(page, 2500);
}

/** The export dialog of a panel. */
async function exportDialog(page) {
    await openFiles(page, loggerCsv());
    const [panel] = await panelIds(page);
    await plot(page, panel, ['Pressure', 'Flow']);
    await page.locator(`.layout-panel[data-id="${panel}"] .panel-export-btn`).click();
    await page.getByText(t('exportFormatPng'), { exact: true }).click();
    await settle(page, 1500);
    return { clip: await clipAround(page, '.modal-overlay .modal-content', 10) };
}

/** The phone: a plot between the top bar and the four buttons. */
async function phonePlotScene(page) {
    await openExample(page, 'examplePendulum');
    await settle(page);
}

/** The phone's Data sheet: tap a variable to plot it. */
async function phoneData(page) {
    await openFiles(page, signalsCsv());
    await sheet(page, 'data');
    const leaf = name => page.locator(`#variables-tree .tree-item[data-var-name="${name}"]`);
    await leaf('voltage').click();
    await leaf('current').click();
    await page.waitForFunction(() => window.app.plotManager.plots.get(window.app._compactActivePanelId())?.traces.length === 2);
    await pause(page, 3500);   // the toast that says what the tap did goes away
    // The list of variables, rather than the buttons above it.
    await page.locator('.compact-sheet-body').evaluate((body) => {
        const tree = body.querySelector('#variables-tree');
        body.scrollTop += tree.getBoundingClientRect().top - body.getBoundingClientRect().top - 185;
    });
    await settle(page);
}

/** The phone's Plot sheet. */
async function phonePlotSheet(page) {
    await openExample(page, 'examplePendulum');
    await sheet(page, 'plot');
    await settle(page);
}

/** The phone's Analyze sheet, with the plot turned into its spectrum. */
async function phoneAnalyze(page) {
    await openFiles(page, signalsCsv());
    await sheet(page, 'data');
    await page.locator('#variables-tree .tree-item[data-var-name="voltage"]').click();
    await page.locator('#variables-tree .tree-item[data-var-name="current"]').click();
    await sheet(page, 'analyze');
    await page.locator('.compact-sheet').getByText(t('analysisItemFft'), { exact: true }).click();
    await settle(page, 4000);
}

/** A gridded file on its map, on the phone. */
async function phoneMap(page) {
    await openExample(page, 'exampleEra5Argentina');
    await settle(page, 2000);
}

/** The phone's data tools: a moving average, its result dotted on the plot. */
async function phoneTools(page) {
    await openFiles(page, noisyCsv());
    await sheet(page, 'data');
    await page.locator('#variables-tree .tree-item[data-var-name="vibration"]').click();
    await sheet(page, 'analyze');
    await page.locator('.compact-tools-analyze-row').click();
    await page.locator('.compact-tool-tile[data-tool="movingAverage"]').click();
    await settle(page, 3000);
}

/** A tablet held sideways: the full layout, driven by touch. */
async function tablet(page) {
    await openExample(page, 'examplePendulum');
    await settle(page);
}

/** A gridded file on its map, on a tablet held sideways. */
async function tabletMap(page) {
    await openExample(page, 'exampleEra5Argentina');
    await settle(page, 2000);
}

/** A tablet held upright: the same full layout, with less room across. */
async function tabletPortrait(page) {
    await openExample(page, 'examplePendulum');
    await settle(page, 2000);
}

// A scene by the id of its figure; `viewport` where the desktop window is not
// the usual one.
const SCENES = {
    welcome: { run: welcome },
    'csv-preview': { run: csvPreview },
    'modelica-tree': { run: modelicaTree, viewport: TALL },
    'sidebar-filter': { run: sidebarFilter },
    'right-axis': { run: rightAxis, viewport: SMALL },
    'marks-gaps': { run: marksGaps, viewport: SMALL },
    dashboard: { run: dashboard },
    'time-axis': { run: timeAxis, viewport: SMALL },
    histogram: { run: histogram, viewport: SMALL },
    heatmap: { run: heatmap, viewport: SMALL },
    integral: { run: integral, viewport: SMALL },
    'curve-fit-time': { run: curveFitTime, viewport: SMALL },
    trend: { run: trend, viewport: SMALL },
    cursors: { run: cursors, viewport: SMALL },
    statistics: { run: statistics, viewport: SMALL },
    'compare-runs': { run: compareRuns, viewport: SMALL },
    'data-tools': { run: dataTools },
    'digital-filter': { run: digitalFilter, viewport: SMALL },
    'derived-editor': { run: derivedEditor },
    'memory-saving': { run: memorySaving, viewport: SMALL },
    'export-dialog': { run: exportDialog },
    'phone-plot': { run: phonePlotScene },
    'phone-data': { run: phoneData },
    'phone-plot-sheet': { run: phonePlotSheet },
    'phone-analyze': { run: phoneAnalyze },
    'phone-map': { run: phoneMap },
    'phone-tools': { run: phoneTools },
    tablet: { run: tablet },
    'tablet-map': { run: tabletMap },
    'tablet-portrait': { run: tabletPortrait },
};

// ── The run ─────────────────────────────────────────────────────────────────
const figures = MANUAL_FIGURES.filter(figure => !only || only.includes(figure.id));
if (only) {
    const unknown = only.filter(id => !MANUAL_FIGURES.some(figure => figure.id === id));
    if (unknown.length) throw new Error(`No such figure: ${unknown.join(', ')}`);
}
for (const figure of figures) {
    if (!figure.example && !SCENES[figure.id]) throw new Error(`Figure "${figure.id}" has neither an example nor a scene`);
}

await mkdir(outDir, { recursive: true });
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const failed = [];
try {
    for (const figure of figures) {
        const scene = SCENES[figure.id];
        const screen = { ...SCREENS[figure.device] };
        if (scene?.viewport && figure.device === 'desktop') screen.viewport = scene.viewport;
        const context = await browser.newContext({ ...screen, locale: 'en-US' });
        // The notes a first visit shows are not what a figure is about.
        await context.addInitScript(() => {
            try {
                localStorage.setItem('omv_touch_hint_seen', '1');
                localStorage.setItem('omv_guide_seen', '1');
            } catch (_) { /* no storage: the notes show */ }
        });
        const page = await context.newPage();
        try {
            await page.goto(baseUrl);
            await waitForApp(page);
            let clip = null;
            if (scene) clip = (await scene.run(page))?.clip || null;
            else await openExample(page, figure.example);
            const png = await page.screenshot(clip ? { clip } : {});
            let image = sharp(png);
            // Every figure is kept at twice its size on the screen.
            const shown = clip ? clip.width : page.viewportSize().width;
            const { width } = await image.metadata();
            if (width > shown * MANUAL_FIGURE_SCALE) image = image.resize({ width: Math.round(shown * MANUAL_FIGURE_SCALE) });
            const info = await image.webp({ quality: WEBP_QUALITY }).toFile(`${outDir}/${figure.file}`);
            console.log(`manual figure: ${figure.file} ${info.width}x${info.height} ${Math.round(info.size / 1024)} KB`);
        } catch (error) {
            failed.push(figure.id);
            console.error(`manual figure: ${figure.id} FAILED\n${error.stack || error}`);
            await page.screenshot({ path: `${outDir}/${figure.id}.failed.png` }).catch(() => {});
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failed.length) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exit(1);
}
