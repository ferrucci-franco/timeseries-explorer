// The panel download button and the export dialog behind it: which charts a
// panel offers, which one is preselected, why CSV is sometimes unavailable,
// how the files are named, and that a theme chosen for the export is put
// back afterwards.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import translations from '../src/i18n/translations.js';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const exportMethodsSource = read('src/plots/methods/export-methods.js');
const dialogSource = read('src/ui/plot-export-dialog.js');
const interactionSource = read('src/plots/methods/interaction-methods.js');
const plotManagerSource = read('src/plots/plot-manager.js');
const overlaysCss = read('src/styles/overlays.css');
const contentCss = read('src/styles/content.css');

// ── The toolbar button ──────────────────────────────────────────────────
assert.ok(
    interactionSource.includes("panel-action-btn panel-export-btn"),
    'the panel toolbar carries an export button',
);
assert.ok(
    !interactionSource.includes('csv-export-btn'),
    'the CSV-only button is gone; one button now covers every format',
);
assert.ok(
    interactionSource.includes('this._openExportDialog(panelId)'),
    'the export button opens the dialog instead of writing a file on click',
);
assert.ok(
    interactionSource.includes('exportBtn.innerHTML = \'<svg'),
    'the export button shows a download icon, not the word CSV',
);
assert.ok(
    interactionSource.includes("exportBtn.title = i18n.t('exportPanel')")
    && interactionSource.includes("exportBtn.setAttribute('aria-label', exportBtn.title)"),
    'an icon-only button still names itself for tooltip and screen reader',
);
assert.ok(
    contentCss.includes('.panel-export-btn svg'),
    'the download icon is sized like the other icon buttons',
);

// The button stays usable in the modes with no data table: the dialog still
// exports the plot as an image there.
const refreshStart = plotManagerSource.indexOf('    _refreshActionBtns(panelId) {');
const refreshEnd = plotManagerSource.indexOf('\n    _exportCSV(', refreshStart + 1);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'the toolbar refresher is present');
const refreshSource = plotManagerSource.slice(refreshStart, refreshEnd);
assert.ok(
    refreshSource.includes("panelEl.querySelector('.panel-export-btn')")
    && refreshSource.includes('exportBtn.disabled = !has;'),
    'the export button is disabled only by an empty panel',
);
assert.ok(
    !refreshSource.includes('csvBtn'),
    'no mode-specific disabling survives on the button itself',
);
assert.ok(
    plotManagerSource.includes('a.download = options.fileName || `${plot.mode}_export.csv`;'),
    'CSV keeps its old default name and accepts the one typed in the dialog',
);

// ── The dialog ──────────────────────────────────────────────────────────
assert.ok(
    overlaysCss.includes('.modal-dialog-plot-export'),
    'the export dialog is styled',
);
assert.ok(
    overlaysCss.includes('backdrop-filter: blur('),
    'the dialog dims and blurs what is behind it',
);
for (const key of ['exportFormatCsv', 'exportFormatPng', 'exportFormatSvg', 'exportQuality',
    'exportTheme', 'exportFileName', 'exportAction']) {
    assert.ok(dialogSource.includes(`i18n.t('${key}')`), `the dialog is translated: ${key}`);
}
assert.ok(
    dialogSource.includes('const remembered = {'),
    'format, quality and theme survive between openings',
);

const translationKeys = [
    'exportPanel', 'exportDialogTitle', 'exportDialogBody', 'exportFormat',
    'exportFormatCsv', 'exportFormatCsvHint', 'exportFormatPng', 'exportFormatPngHint',
    'exportFormatSvg', 'exportFormatSvgHint', 'exportChart', 'exportChartSpectrum',
    'exportChartHistogram', 'exportQuality', 'exportQualityHint', 'exportTheme',
    'exportThemeCurrent', 'exportThemeLight', 'exportThemeDark', 'exportThemeLightTransparent',
    'exportFileName', 'exportAction', 'exportCsvUnavailableProfile', 'exportCsvUnavailableStale',
    'exportFailedTitle', 'exportFailedBody', 'exportFailedDetails',
];
for (const locale of ['en', 'fr', 'es', 'it']) {
    for (const key of translationKeys) {
        assert.ok(translations[locale]?.[key], `${locale}.${key} is translated`);
    }
}
for (const locale of ['en', 'fr', 'es', 'it']) {
    const hint = translations[locale].exportQualityHint;
    assert.ok(hint.includes('{w}') && hint.includes('{h}'), `${locale} reports the exported pixel size`);
}

// ── Behaviour ───────────────────────────────────────────────────────────
// The module runs in a sandbox with the imports replaced by stubs, so the real
// routing code is exercised rather than a copy of it.
const sandboxSource = exportMethodsSource
    .split('\n')
    .filter(line => !line.startsWith('import '))
    .join('\n')
    .replace('export function installPlotExportMethods', 'function installPlotExportMethods');

class Harness {
    constructor(plot, { theme = 'dark' } = {}) {
        this.theme = theme;
        this.plot = plot;
        this.plots = new Map([['panel', plot]]);
        this.csvExports = [];
        this.heatmapRenders = [];
    }

    _hasContent() { return true; }

    _exportCSV(panelId, options) { this.csvExports.push({ panelId, options }); }

    _themeRelayoutUpdate() {
        const light = this.theme === 'light';
        return { paper_bgcolor: light ? '#ffffff' : '#2d2d2d', 'font.color': light ? '#333333' : '#d0d0d0' };
    }

    _renderCalendarHeatmapModels(panelId, plot, options) {
        this.heatmapRenders.push({ theme: this.theme, options });
        return Promise.resolve(true);
    }
}

const relayouts = [];
const toImageCalls = [];
const alerts = [];
let dialogAnswer = null;
let dialogOptions = null;
const downloads = [];

const makeDiv = (order, width = 800, height = 450, extraLayout = {}) => {
    const div = {
        order,
        _fullLayout: {
            width,
            height,
            paper_bgcolor: '#2d2d2d',
            plot_bgcolor: '#2d2d2d',
            font: { color: '#d0d0d0' },
            ...extraLayout,
        },
    };
    // Node.DOCUMENT_POSITION_FOLLOWING is 4: "the other node comes after me".
    div.compareDocumentPosition = (other) => (other.order > div.order ? 4 : 2);
    return div;
};

const sandbox = {
    console,
    setTimeout,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Uint8Array,
    document: {
        createElement: () => ({
            setAttribute() {},
            click() { downloads.push(this.download); },
            remove() {},
        }),
        body: { appendChild() {} },
    },
    i18n: { t: (key) => key },
    Modal: { alert: (title, body) => alerts.push({ title, body }) },
    PlotExportDialog: {
        open: async (options) => { dialogOptions = options; return dialogAnswer; },
    },
    Plotly: {
        relayout: async (div, update) => { relayouts.push({ div, update }); },
        toImage: async (div, options) => {
            toImageCalls.push({ div, options });
            return 'data:image/png;base64,AAAA';
        },
    },
};
vm.runInNewContext(`${sandboxSource}\ninstallPlotExportMethods(Harness);`, { ...sandbox, Harness });

// Charts offered per panel type.
{
    const plot = { mode: 'timeseries', div: makeDiv(1) };
    const manager = new Harness(plot);
    const charts = manager._exportableCharts(plot);
    assert.deepEqual(Array.from(charts, c => c.id), ['plot'], 'a plain time-series panel offers one chart');
    assert.equal(charts[0].label, 'modeTimeseries', 'the single chart is named after the mode');
    assert.equal(manager._defaultExportChartId(plot, charts), 'plot', 'the only chart is preselected');
    assert.equal(manager._defaultExportBaseName(plot, 'png', charts[0], 1), 'timeseries',
        'one chart needs no chart suffix in the file name');
}

for (const [mode, extraKey, chartId] of [
    ['fft', 'fftDiv', 'spectrum'],
    ['histogram', 'histogramDiv', 'histogram'],
    ['heatmap', 'heatmapDiv', 'heatmap'],
    ['temporal-profile', 'temporalProfileDiv', 'profile'],
    ['correlation', 'correlationDiv', 'correlation'],
]) {
    const plot = { mode, div: makeDiv(1), [extraKey]: makeDiv(2) };
    const manager = new Harness(plot);
    const charts = manager._exportableCharts(plot);
    assert.deepEqual(Array.from(charts, c => c.id), ['time', chartId],
        `${mode} offers the time series and its analysis pane, in display order`);
    assert.equal(manager._defaultExportChartId(plot, charts), chartId,
        `${mode} preselects the analysis pane the user is working in`);
    assert.equal(manager._defaultExportBaseName(plot, 'png', charts[1], charts.length),
        `${mode === 'temporal-profile' ? 'profile' : mode}_${chartId}`,
        `${mode} names the image after mode and chart`);
}

// The 2D fit workspace: plot.div is the scatter, the extra chart is the time
// series, and the CSV keeps the names the fit exports always used.
{
    const plot = { mode: 'phase2d', div: makeDiv(2), phase2dFitTimeDiv: makeDiv(1), phase2d: { fitEnabled: true } };
    const manager = new Harness(plot);
    const charts = manager._exportableCharts(plot);
    assert.deepEqual(Array.from(charts, c => c.id), ['time', 'scatter'], 'the fit workspace offers both of its charts');
    assert.equal(charts[1].label, 'modePhase2d', 'the scatter is named as the 2D plot');
    assert.equal(manager._defaultExportBaseName(plot, 'csv', null, 2), 'phase2d_fit',
        'the fit CSV keeps its established base name');
}

// An empty container is not a chart.
{
    const plot = { mode: 'fft', div: makeDiv(1), fftDiv: { order: 2, compareDocumentPosition: () => 4 } };
    const charts = new Harness(plot)._exportableCharts(plot);
    assert.deepEqual(Array.from(charts, c => c.id), ['time'], 'a pane Plotly has not drawn yet is not offered');
}

// Why CSV is unavailable, and that it usually is not.
{
    const cases = [
        [{ mode: 'timeseries' }, ''],
        [{ mode: 'phase3d' }, ''],
        [{ mode: 'heatmap' }, 'heatmapExportPending'],
        [{ mode: 'temporal-profile' }, 'exportCsvUnavailableProfile'],
        [{ mode: 'correlation', correlation: { dirty: true } }, 'exportCsvUnavailableStale'],
        [{ mode: 'correlation', correlation: { dirty: false } }, ''],
    ];
    for (const [plot, expected] of cases) {
        assert.equal(new Harness(plot)._csvExportBlockedReason(plot), expected,
            `${plot.mode} reports the right CSV availability`);
    }
    const stale = { mode: 'phase2d', phase2d: { fitEnabled: true } };
    const manager = new Harness(stale);
    manager._ensurePhase2dState = () => ({ dirty: true });
    assert.equal(manager._csvExportBlockedReason(stale), 'phase2dFitCsvDirty',
        'a stale curve fit is not exported as if it were current');
}

// CSV routing carries the name chosen in the dialog.
{
    const plot = { mode: 'timeseries', div: makeDiv(1) };
    const manager = new Harness(plot);
    dialogAnswer = { format: 'csv', chartId: 'plot', scale: 2, theme: 'current', baseName: 'run7', fileName: 'run7.csv' };
    await manager._openExportDialog('panel');
    assert.equal(manager.csvExports.length, 1, 'one CSV export is requested');
    assert.equal(manager.csvExports[0].panelId, 'panel', 'the export targets the panel that asked');
    assert.equal(manager.csvExports[0].options.fileName, 'run7.csv', 'the CSV export receives the chosen file name');
    assert.equal(manager.csvExports[0].options.baseName, 'run7', 'the base name travels too, for the fit exports');
    assert.equal(dialogOptions.csvBlockedReason, '', 'CSV is offered for a time-series panel');
    assert.deepEqual(Array.from(dialogOptions.charts, c => c.width), [800], 'the dialog is told the chart size');
}

// Cancelling exports nothing.
{
    const plot = { mode: 'timeseries', div: makeDiv(1) };
    const manager = new Harness(plot);
    dialogAnswer = null;
    await manager._openExportDialog('panel');
    assert.equal(manager.csvExports.length, 0, 'a dismissed dialog writes no file');
    assert.equal(toImageCalls.length, 0, 'a dismissed dialog renders no image');
}

// PNG: the quality multiplier reaches Plotly, SVG never does.
{
    const plot = { mode: 'fft', div: makeDiv(1), fftDiv: makeDiv(2, 640, 360) };
    const manager = new Harness(plot);
    toImageCalls.length = 0;
    downloads.length = 0;
    dialogAnswer = { format: 'png', chartId: 'spectrum', scale: 3, theme: 'current', baseName: 'fft_spectrum', fileName: 'fft_spectrum.png' };
    await manager._openExportDialog('panel');
    assert.equal(toImageCalls.length, 1, 'one image is rendered');
    assert.equal(toImageCalls[0].options.format, 'png', 'PNG is requested as PNG');
    assert.equal(toImageCalls[0].options.width, 640, 'the image keeps the chart width');
    assert.equal(toImageCalls[0].options.height, 360, 'the image keeps the chart height');
    assert.equal(toImageCalls[0].options.scale, 3, 'the chosen quality multiplies the pixels');
    assert.equal(toImageCalls[0].div, plot.fftDiv, 'the chosen chart is the one rendered');
    assert.deepEqual(downloads, ['fft_spectrum.png'], 'the file is saved under the chosen name');

    toImageCalls.length = 0;
    dialogAnswer = { format: 'svg', chartId: 'time', scale: 4, theme: 'current', baseName: 'fft_time', fileName: 'fft_time.svg' };
    await manager._openExportDialog('panel');
    assert.equal(toImageCalls[0].options.scale, 1, 'a vector image ignores the pixel multiplier');
    assert.equal(toImageCalls[0].options.format, 'svg', 'SVG is requested as SVG');
}

// A theme chosen for the export is applied to the whole figure, not just its
// paper, and the panel is put back afterwards. The app runs the dark theme
// here, so "dark" has to be an explicit choice rather than a no-op.
{
    const plot = { mode: 'timeseries', div: makeDiv(1) };
    const manager = new Harness(plot);

    relayouts.length = 0;
    dialogAnswer = { format: 'png', chartId: 'plot', scale: 1, theme: 'light', baseName: 'p', fileName: 'p.png' };
    await manager._openExportDialog('panel');
    assert.equal(relayouts.length, 2, 'the chart is repainted for the export and restored after it');
    assert.equal(relayouts[0].update.paper_bgcolor, '#ffffff', 'a light export gets light paper');
    assert.equal(relayouts[0].update['font.color'], '#333333', 'a light export gets readable text, not the dark theme');
    assert.equal(relayouts[1].update.paper_bgcolor, '#2d2d2d', 'the panel gets its own paper back');
    assert.equal(relayouts[1].update['font.color'], '#d0d0d0', 'the panel keeps the theme it had');
    assert.equal(manager.theme, 'dark', 'the app theme itself is never changed');

    relayouts.length = 0;
    const lightApp = new Harness(plot, { theme: 'light' });
    dialogAnswer = { format: 'png', chartId: 'plot', scale: 1, theme: 'dark', baseName: 'p', fileName: 'p.png' };
    await lightApp._openExportDialog('panel');
    assert.equal(relayouts[0].update.paper_bgcolor, '#2d2d2d', 'a dark export gets dark paper from a light app');
    assert.equal(relayouts[0].update['font.color'], '#d0d0d0', 'a dark export gets light text');
    assert.equal(lightApp.theme, 'light', 'the app theme itself is never changed');

    relayouts.length = 0;
    dialogAnswer = { format: 'png', chartId: 'plot', scale: 1, theme: 'light-transparent', baseName: 'p', fileName: 'p.png' };
    await manager._openExportDialog('panel');
    assert.equal(relayouts[0].update.paper_bgcolor, 'rgba(0,0,0,0)', 'transparent takes the paper away');
    assert.equal(relayouts[0].update.plot_bgcolor, 'rgba(0,0,0,0)', 'transparent takes the plot area away too');
    assert.equal(relayouts[0].update['font.color'], '#333333',
        'transparent is a variant of light: the text is the one that reads on a white page');
    assert.equal(relayouts[1].update.paper_bgcolor, '#2d2d2d', 'the panel gets its paper back');

    relayouts.length = 0;
    dialogAnswer = { format: 'png', chartId: 'plot', scale: 1, theme: 'current', baseName: 'p', fileName: 'p.png' };
    await manager._openExportDialog('panel');
    assert.equal(relayouts.length, 0, 'exporting with the current theme touches nothing');

    relayouts.length = 0;
    dialogAnswer = { format: 'png', chartId: 'plot', scale: 1, theme: 'dark', baseName: 'p', fileName: 'p.png' };
    await manager._openExportDialog('panel');
    assert.equal(relayouts.length, 0, 'naming the theme the app is already in touches nothing either');
}

// The Calendar Heatmap needs a rebuild rather than a relayout to change theme.
{
    const plot = { mode: 'heatmap', div: makeDiv(1), heatmapDiv: makeDiv(2) };
    const manager = new Harness(plot);
    relayouts.length = 0;
    dialogAnswer = { format: 'png', chartId: 'heatmap', scale: 2, theme: 'light', baseName: 'h', fileName: 'h.png' };
    await manager._openExportDialog('panel');
    assert.deepEqual(Array.from(manager.heatmapRenders, r => r.theme), ['light', 'dark'],
        'the heatmap is rebuilt light for the export and dark again after it');
    assert.equal(relayouts.length, 0, 'the heatmap takes the rebuild path, not the relayout one');
    assert.equal(manager.theme, 'dark', 'the app theme survives the heatmap export');
    assert.equal(dialogOptions.csvBlockedReason, 'heatmapExportPending',
        'the dialog explains why the heatmap has no CSV');

    // Transparent still rides on top of the rebuild.
    manager.heatmapRenders.length = 0;
    relayouts.length = 0;
    dialogAnswer = { format: 'png', chartId: 'heatmap', scale: 2, theme: 'light-transparent', baseName: 'h', fileName: 'h.png' };
    await manager._openExportDialog('panel');
    assert.deepEqual(Array.from(manager.heatmapRenders, r => r.theme), ['light', 'dark'],
        'a transparent heatmap is still rebuilt in its export theme');
    assert.equal(relayouts[0].update.paper_bgcolor, 'rgba(0,0,0,0)', 'and then loses its paper');
    assert.equal(relayouts[1].update.paper_bgcolor, '#2d2d2d', 'and gets it back afterwards');
}

// A failed render reports instead of throwing, and still restores the panel.
{
    const plot = { mode: 'timeseries', div: makeDiv(1) };
    const manager = new Harness(plot);
    relayouts.length = 0;
    alerts.length = 0;
    const workingToImage = sandbox.Plotly.toImage;
    sandbox.Plotly.toImage = async () => { throw new Error('WebGL context lost'); };
    dialogAnswer = { format: 'png', chartId: 'plot', scale: 1, theme: 'light-transparent', baseName: 'p', fileName: 'p.png' };
    await manager._openExportDialog('panel');
    sandbox.Plotly.toImage = workingToImage;
    assert.equal(alerts.length, 1, 'the failure is reported');
    assert.equal(alerts[0].title, 'exportFailedTitle', 'the report says the export failed');
    assert.equal(relayouts.length, 2, 'the panel is restored even when the render fails');
}

console.log('Export dialog tests passed');
