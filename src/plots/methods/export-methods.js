import Plotly from '../../vendor/plotly.js';
import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import PlotExportDialog from '../../ui/plot-export-dialog.js';

/**
 * Panel export — the download button and everything behind it.
 *
 * The panel used to have a CSV button that wrote a file on click. It now has a
 * download button that opens one dialog offering the same CSV plus the plot
 * itself as PNG (with a quality multiplier) or SVG. Panels that show two charts
 * (time series + spectrum / histogram / heatmap / profile / correlation, and
 * the 2D fit workspace) let the user pick which one to save.
 *
 * The CSV writing itself stays in plot-manager (_exportCSV) and in the 2D fit
 * methods; this file only routes to them.
 */

// Node.DOCUMENT_POSITION_FOLLOWING — "b comes after a in the document".
const DOCUMENT_POSITION_FOLLOWING = 4;

// The Plotly layout keys the transparent background touches. The light-document
// background reuses the app's own theme update instead, so it covers fonts and
// grid lines too.
const CLEAR_COLOR = 'rgba(0,0,0,0)';

const readLayoutPath = (layout, path) => path.split('.')
    .reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), layout);

// Plotly hands back a data URL. Large PNGs make very long ones, and some
// browsers refuse to navigate to those, so the download goes through a blob.
const dataUrlToBlob = (dataUrl) => {
    const separator = dataUrl.indexOf(',');
    const head = dataUrl.slice(0, separator);
    const body = dataUrl.slice(separator + 1);
    const mime = head.slice(5).split(';')[0] || 'application/octet-stream';
    if (!head.includes('base64')) return new Blob([decodeURIComponent(body)], { type: mime });
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
};

const downloadBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking straight away can cut a large download short in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

export function installPlotExportMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // Every live Plotly chart in the panel, in the order they are drawn.
    proto._exportableCharts = function(plot) {
        if (!plot) return [];
        const analysisMode = ['fft', 'histogram', 'heatmap', 'temporal-profile', 'correlation'].includes(plot.mode);
        const inFitWorkspace = plot.mode === 'phase2d' && !!plot.phase2dFitTimeDiv;
        // In the 2D fit workspace plot.div is the scatter and the extra chart is
        // the time series; in the analysis modes plot.div is the time series.
        const mainLabelKey = inFitWorkspace ? 'modePhase2d'
            : analysisMode ? 'modeTimeseries'
                : ({
                    timeseries: 'modeTimeseries',
                    phase2d: 'modePhase2d',
                    phase2dt: 'modePhase2dt',
                    phase3d: 'modePhase3d',
                }[plot.mode] || (plot.mode === 'state-anim'
                    ? ((plot.stateAnimDim || 2) >= 3 ? 'modeStateAnim3d' : 'modeStateAnim2d')
                    : 'modeTimeseries'));

        const charts = [];
        const add = (div, id, labelKey) => {
            // _fullLayout appears once Plotly has drawn: a container that is
            // still empty has nothing to export.
            if (!div || !div._fullLayout) return;
            charts.push({
                id,
                div,
                label: i18n.t(labelKey),
                width: Math.max(1, Math.round(div._fullLayout.width || div.clientWidth || 800)),
                height: Math.max(1, Math.round(div._fullLayout.height || div.clientHeight || 450)),
            });
        };

        add(plot.div, inFitWorkspace ? 'scatter' : (analysisMode ? 'time' : 'plot'), mainLabelKey);
        add(plot.phase2dFitTimeDiv, 'time', 'modeTimeseries');
        add(plot.fftDiv, 'spectrum', 'exportChartSpectrum');
        add(plot.histogramDiv, 'histogram', 'exportChartHistogram');
        add(plot.heatmapDiv, 'heatmap', 'modeHeatmapLabel');
        add(plot.temporalProfileDiv, 'profile', 'temporalProfileModeLabel');
        add(plot.correlationDiv, 'correlation', 'modeCorrelationLabel');

        charts.sort((a, b) => (
            (a.div.compareDocumentPosition(b.div) & DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
        ));
        return charts;
    };

    // The chart the user is working in, which is the one they mean by "this
    // plot": the analysis pane when the panel has one.
    proto._defaultExportChartId = function(plot, charts) {
        const preferred = {
            fft: 'spectrum',
            histogram: 'histogram',
            heatmap: 'heatmap',
            'temporal-profile': 'profile',
            correlation: 'correlation',
        }[plot?.mode];
        if (preferred && charts.some(chart => chart.id === preferred)) return preferred;
        return charts[0]?.id || '';
    };

    // Why this panel has no data table to offer, or '' when CSV is available.
    // The dialog shows the reason on a disabled option instead of hiding it,
    // so the answer to "where did CSV go?" is in the dialog.
    proto._csvExportBlockedReason = function(plot) {
        if (!plot) return '';
        if (plot.mode === 'heatmap') return i18n.t('heatmapExportPending');
        if (plot.mode === 'temporal-profile') return i18n.t('exportCsvUnavailableProfile');
        if (plot.mode === 'correlation' && plot.correlation?.dirty) return i18n.t('exportCsvUnavailableStale');
        if (plot.mode === 'phase2d' && plot.phase2d?.fitEnabled
            && this._ensurePhase2dState?.(plot)?.dirty) return i18n.t('phase2dFitCsvDirty');
        return '';
    };

    // Default file name per format. The CSV names are the ones the CSV button
    // wrote before, so an established workflow keeps finding its files.
    proto._defaultExportBaseName = function(plot, format, chart, chartCount) {
        if (format === 'csv') {
            return (plot.mode === 'phase2d' && plot.phase2d?.fitEnabled)
                ? 'phase2d_fit'
                : `${plot.mode}_export`;
        }
        const mode = plot.mode === 'temporal-profile' ? 'profile' : plot.mode;
        return chartCount > 1 && chart ? `${mode}_${chart.id}` : mode;
    };

    proto._openExportDialog = async function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot)) return;

        const charts = this._exportableCharts(plot);
        const csvBlockedReason = this._csvExportBlockedReason(plot);
        if (!charts.length && csvBlockedReason) {
            Modal.alert(i18n.t('exportDialogTitle'), csvBlockedReason, { icon: false });
            return;
        }

        const result = await PlotExportDialog.open({
            contextLabel: charts.map(chart => chart.label).join(' · '),
            charts: charts.map(({ id, label, width, height }) => ({ id, label, width, height })),
            defaultChartId: this._defaultExportChartId(plot, charts),
            csvBlockedReason,
            defaultBaseName: (format, chart) => this._defaultExportBaseName(
                plot,
                format,
                chart ? charts.find(entry => entry.id === chart.id) : null,
                charts.length,
            ),
        });
        if (!result) return;

        if (result.format === 'csv') {
            this._exportCSV(panelId, { fileName: result.fileName, baseName: result.baseName });
            return;
        }
        const chart = charts.find(entry => entry.id === result.chartId) || charts[0];
        if (!chart) return;
        await this._exportPlotImage(panelId, plot, chart, result);
    };

    proto._exportPlotImage = async function(panelId, plot, chart, { format, scale, background, fileName }) {
        const restore = await this._applyExportBackground(panelId, plot, chart.div, background);
        try {
            const dataUrl = await Plotly.toImage(chart.div, {
                format,
                width: chart.width,
                height: chart.height,
                // Plotly multiplies the requested size by the scale; SVG is
                // resolution-independent, so only PNG uses the multiplier.
                scale: format === 'png' ? scale : 1,
            });
            downloadBlob(dataUrlToBlob(dataUrl), fileName);
        } catch (error) {
            Modal.alert(i18n.t('exportFailedTitle'), i18n.t('exportFailedBody'), {
                details: error?.message || String(error),
                detailsLabel: i18n.t('exportFailedDetails'),
            });
        } finally {
            await restore();
        }
    };

    /**
     * Repaint the chart for the export, and hand back the undo.
     *
     * Plotly renders whatever is on screen, so a figure for a white page has to
     * be a white figure for as long as it takes to snapshot it. The dialog's
     * default ("current theme") changes nothing at all.
     */
    proto._applyExportBackground = async function(panelId, plot, div, background) {
        const noop = () => Promise.resolve();
        if (background !== 'light' && background !== 'transparent') return noop;

        // A light Calendar Heatmap needs its per-signal axes rebuilt, not just
        // relayouted — same reason the app re-renders it on a theme change.
        if (background === 'light' && plot.mode === 'heatmap' && div === plot.heatmapDiv
            && this._renderCalendarHeatmapModels) {
            const realTheme = this.theme;
            this.theme = 'light';
            await Promise.resolve(this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true }));
            return async () => {
                this.theme = realTheme;
                await Promise.resolve(this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true }));
            };
        }

        const update = {};
        if (background === 'light') {
            const realTheme = this.theme;
            this.theme = 'light';
            try { Object.assign(update, this._themeRelayoutUpdate(plot)); }
            finally { this.theme = realTheme; }
        } else {
            update.paper_bgcolor = CLEAR_COLOR;
            update.plot_bgcolor = CLEAR_COLOR;
            if (div._fullLayout?.scene) update['scene.bgcolor'] = CLEAR_COLOR;
        }

        // Undo from what the chart actually had, not from what the theme says
        // it should have: the two differ once the user has zoomed a 3D scene or
        // an analysis pane has painted itself.
        const previous = {};
        for (const key of Object.keys(update)) {
            const value = readLayoutPath(div._fullLayout, key);
            if (value !== undefined) previous[key] = value;
        }

        await Plotly.relayout(div, update);
        this._refreshAxisDecorations?.(plot);
        this._refreshOriginCross?.(plot);
        return async () => {
            await Plotly.relayout(div, previous);
            this._refreshAxisDecorations?.(plot);
            this._refreshOriginCross?.(plot);
        };
    };
}
