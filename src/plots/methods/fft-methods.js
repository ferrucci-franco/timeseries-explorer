import i18n from '../../i18n/index.js';
import {
    computeAmplitudeSpectrum,
    windowSpectrumForDisplay,
    fftWindowCoefficients,
    formatNaturalDuration,
    frequencyPeriod,
    nextPowerOfTwo,
    normalizeFftScale,
    normalizeFftWindow,
    normalizeZeroPaddingFactor,
    selectFftRange,
    estimateFftDurationMs,
    FFT_AUTO_SLOW_MS,
    FFT_AUTO_TARGET_POINTS,
    FFT_LIVE_MAX_POINTS,
    FFT_MAX_POINTS_DESKTOP,
    FFT_MAX_POINTS_WEB,
    FFT_WORKER_THRESHOLD_POINTS,
} from '../../utils/fft.js';
import { detectNaNRuns, detectSamplingGaps } from '../../utils/sampling-gaps.js';
import Plotly from '../../vendor/plotly.js';

const FFT_LAYOUTS = new Set(['horizontal', 'vertical']);
const FFT_AXIS_LIMIT_KEYS = new Set(['fMin', 'fMax', 'yMin', 'yMax']);

export function installPlotFftMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._defaultFftState = function() {
    return {
        layout: 'vertical',
        split: 0.5,
        timeSeriesHidden: false,
        optionsVisible: true,
        rangeFull: true,
        autoRangeLimited: false,
        x1: null,
        x2: null,
        windowType: 'none',
        showWindowed: false,
        removeMean: true,
        zeroPaddingFactor: 1,
        amplitudeScale: 'normal',
        fMin: null,
        fMax: null,
        yMin: null,
        yMax: null,
        warnings: [],
    };
};

proto._normalizeFftState = function(raw = {}) {
    const defaults = this._defaultFftState();
    const finiteOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };
    const layout = FFT_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout;
    const split = Number(raw.split);
    // Sessions saved before the range-mode split was removed carry
    // rangeMode + xMin/xMax; honor whichever pair was active back then.
    const preferNumeric = raw.rangeMode === 'numeric';
    const rawX1 = preferNumeric ? (raw.xMin ?? raw.x1) : (raw.x1 ?? raw.xMin);
    const rawX2 = preferNumeric ? (raw.xMax ?? raw.x2) : (raw.x2 ?? raw.xMax);
    const state = {
        ...defaults,
        ...raw,
        layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        timeSeriesHidden: raw.timeSeriesHidden === true,
        optionsVisible: raw.optionsVisible !== false,
        // Sessions predating rangeFull carry an explicit window: keep it.
        rangeFull: raw.rangeFull !== undefined
            ? !!raw.rangeFull
            : !(hasFiniteFftValue(rawX1) || hasFiniteFftValue(rawX2)),
        autoRangeLimited: raw.autoRangeLimited === true,
        x1: finiteOrNull(rawX1),
        x2: finiteOrNull(rawX2),
        windowType: normalizeFftWindow(raw.windowType),
        showWindowed: !!raw.showWindowed,
        removeMean: raw.removeMean !== false,
        zeroPaddingFactor: normalizeZeroPaddingFactor(raw.zeroPaddingFactor),
        amplitudeScale: normalizeFftScale(raw.amplitudeScale),
        fMin: finiteOrNull(raw.fMin),
        fMax: finiteOrNull(raw.fMax),
        yMin: finiteOrNull(raw.yMin),
        yMax: finiteOrNull(raw.yMax),
        warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 10) : [],
    };
    delete state.rangeMode;
    delete state.cursors;
    delete state.xMin;
    delete state.xMax;
    return state;
};

proto._ensureFftState = function(plot) {
    if (!plot) return this._defaultFftState();
    if (!plot.fft) {
        plot.fft = this._normalizeFftState({});
        return plot.fft;
    }
    Object.assign(plot.fft, this._normalizeFftState(plot.fft));
    return plot.fft;
};

proto._addFftTrace = function(panelId, varName, panelEl, plot) {
    if (plot.traces.find(t => t.varName === varName && t.fileId === this.activeFileId)) return;
    if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
    plot.traces.push({
        varName,
        color: this._nextTraceColor(plot.traces),
        fileId: this.activeFileId,
        axis: 'y',
    });
    this._ensureFftState(plot);
    this._ensureFftRange(plot);

    if (!plot.div) {
        this._createFftChart(panelId, panelEl);
    } else {
        this._refreshFftTimePlot(panelId, plot, { preserveView: true });
        this._scheduleFftRecompute(panelId, { immediate: true });
    }
};

proto._createFftChart = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    if (!this._hasContent(plot)) return;
    const state = this._ensureFftState(plot);
    this._ensureFftRange(plot);
    const restoreView = plot._pendingViewRestore || null;
    delete plot._pendingViewRestore;
    if (restoreView?.fftSpectrum) plot._fftPendingSpectrumView = restoreView.fftSpectrum;

    const placeholder = panelEl.querySelector('.layout-panel-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    panelEl.querySelector('.fft-container')?.remove();

    const container = document.createElement('div');
    container.className = `fft-container fft-layout-${state.layout}${state.timeSeriesHidden ? ' fft-time-series-hidden' : ''}`;
    container.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);

    const topbar = document.createElement('div');
    topbar.className = 'fft-topbar';
    const layoutGroup = document.createElement('div');
    layoutGroup.className = 'fft-topbar-group';
    const makeButton = (className, text, title, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    };
    const timeSeriesBtn = makeButton(
        'fft-tool-btn fft-time-series-btn',
        i18n.t('hideTimeSeries'),
        i18n.t('hideTimeSeriesTooltip'),
        () => this._toggleFftTimeSeries(panelId),
    );
    timeSeriesBtn.classList.toggle('active', state.timeSeriesHidden);
    timeSeriesBtn.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    layoutGroup.append(
        makeButton('fft-tool-btn fft-layout-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureFftState(plot).layout;
            this._setFftLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        }),
        timeSeriesBtn,
    );

    const actionGroup = document.createElement('div');
    actionGroup.className = 'fft-topbar-group';
    const optionsBtn = makeButton('fft-tool-btn fft-options-btn', i18n.t('fftOptionsLabel'), i18n.t('fftOptionsToggle'), () => this._toggleFftOptions(panelId));
    optionsBtn.classList.toggle('active', state.optionsVisible);
    optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
    actionGroup.append(
        makeButton('fft-tool-btn', i18n.t('fftResetLabel'), i18n.t('fftResetView'), () => this._resetFftView(panelId)),
        optionsBtn,
    );

    const status = document.createElement('span');
    status.className = 'fft-status';
    status.setAttribute('aria-live', 'polite');

    topbar.append(layoutGroup, actionGroup, status);

    const workspace = document.createElement('div');
    workspace.className = 'fft-workspace';
    const plotArea = document.createElement('div');
    plotArea.className = 'fft-plot-area';
    const timePane = document.createElement('div');
    timePane.className = 'fft-pane fft-time-pane';
    const spectrumPane = document.createElement('div');
    spectrumPane.className = 'fft-pane fft-spectrum-pane';
    const splitter = document.createElement('div');
    splitter.className = 'fft-splitter';
    splitter.setAttribute('role', 'separator');

    const timeDiv = document.createElement('div');
    timeDiv.className = 'plotly-container plotly-mode-fft-time';
    const spectrumDiv = document.createElement('div');
    spectrumDiv.className = 'plotly-container plotly-mode-fft-spectrum';
    timePane.appendChild(timeDiv);
    spectrumPane.appendChild(spectrumDiv);
    plotArea.append(timePane, splitter, spectrumPane);

    const options = document.createElement('aside');
    options.className = 'fft-options';
    options.hidden = !state.optionsVisible;
    workspace.append(plotArea, options);
    container.append(topbar, workspace);
    panelEl.appendChild(container);

    plot.fftContainer = container;
    plot.fftDiv = spectrumDiv;
    plot.div = timeDiv;

    this._renderFftOptionsPanel(panelId, plot);
    this._setFftStatus(plot, i18n.t('fftCalculating'), 'loading');
    this._setFftComputing(plot, true);

    const config = this._getPlotlyConfig();
    const preparationToken = (plot._fftPreparationToken || 0) + 1;
    plot._fftPreparationToken = preparationToken;
    // Let the browser paint the shell, controls and calculating indicator
    // before any signal inspection or Plotly trace construction begins.
    setTimeout(async () => {
        await this._prepareFftAutoRange(panelId, plot, preparationToken, { initial: true });
        if (plot._fftPreparationToken !== preparationToken || plot.mode !== 'fft' || !plot.fftContainer?.isConnected) return;
        // Opening FFT shows the whole signal, or the window around the block it
        // cut for itself — never the zoom the previous mode left behind. A
        // saved session view outranks both.
        if (!this._consumeSessionViewRestore(plot)) this._ensureFftState(plot).autoRangeFocusPending = true;
        const domain = this._fftDomain(plot);
        const fullTimeRange = domain ? [domain.min, domain.max] : null;
        await Promise.all([
            // The analyzed block is a green selection over the complete signal,
            // so the pane is built showing everything rather than zoomed to the
            // block. When the block was chosen automatically that view is then
            // narrowed to a padded window around it (_applyPendingAnalysisFocus
            // below): at full zoom the automatic block is a few pixels wide and
            // its edges cannot be dragged, which costs more than the context.
            Plotly.newPlot(timeDiv, this._buildFftTimeTraces(plot), this._buildFftTimeLayout(plot, fullTimeRange), config),
            Plotly.newPlot(spectrumDiv, [], this._buildFftSpectrumLayout(plot), config),
        ]);
        if (plot._fftPreparationToken !== preparationToken || plot.mode !== 'fft') return;
        this._refreshActionBtns(panelId);
        const viewPromise = restoreView
            ? this._restorePlotView(plot, restoreView)
            : this._autoScalePlotTimeOnly(plot);
        // Eager traces already contain their cached full-series overview.
        // Lazy traces still need their viewport query after Plotly exists.
        const hasLazyTrace = (plot.traces || []).some(trace =>
            !!this.files.get(trace.fileId)?.data?._duckdb);
        Promise.resolve(viewPromise).then(() => {
            // The viewport query is only owed to lazy traces; the focus is owed
            // to every trace, so it must not sit inside that branch.
            if (hasLazyTrace) this._refreshTimeseriesVisuals(panelId, plot);
            // After any restored view is applied, so the focus is not undone.
            this._applyPendingAnalysisFocus(plot, 'fft');
        });
        this._installFftPlotHandlers(panelId, plot);
        // Cursor handlers first: their capture listeners must run before the
        // selection ones so a cursor line inside the selection stays grabbable.
        this._installCursorHandlers(panelId, plot);
        this._installFftSelectionHandlers(panelId, plot);
        this._installFftSplitterHandlers(panelId, plot);
        // Two-finger horizontal pan on both FFT panes; vertical keeps zoom.
        this._installWheelPan(panelId, plot, plot.div, {
            finalize: (xRange) => this._onRelayout(panelId, { 'xaxis.range': xRange }),
        });
        this._installWheelPan(panelId, plot, plot.fftDiv, {
            finalize: () => { if (plot.cursorsSpectrum?.enabled) this._syncCursorDisplay(panelId, plot); },
        });
        // Right-button drag pans the same panes (Plotly's native drag ignores
        // button 2, which otherwise snaps to a zoom-box scale on release).
        this._installRightButtonPan(panelId, plot, plot.div, {
            finalize: (xRange) => this._onRelayout(panelId, { 'xaxis.range': xRange }),
        });
        this._installRightButtonPan(panelId, plot, plot.fftDiv, {
            finalize: () => { if (plot.cursorsSpectrum?.enabled) this._syncCursorDisplay(panelId, plot); },
        });
        this._syncCursorDisplay(panelId, plot);
        this._scheduleFftRecompute(panelId, {
            immediate: true,
            preserveSpectrumX: !!restoreView,
            preserveSpectrumY: !!restoreView,
        });
        let timer;
        const ro = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                Plotly.Plots.resize(timeDiv);
                Plotly.Plots.resize(spectrumDiv);
            }, 50);
        });
        ro.observe(panelEl);
        plot.resizeObserver = ro;
    }, 0);
};

proto._installFftPlotHandlers = function(panelId, plot) {
    if (!plot?.div || !plot?.fftDiv || plot._fftHandlersInstalled) return;
    plot._fftHandlersInstalled = true;
    const bindLegend = (div) => {
        let lastMouseDownHadShift = false;
        div.addEventListener('mousedown', event => {
            lastMouseDownHadShift = !!event.shiftKey;
        }, { capture: true });
        div.addEventListener('contextmenu', event => {
            if (this._handleFftLegendContextMenu(panelId, plot, div, event)) return;
            event.preventDefault();
        });
        div.on('plotly_legendclick', (ed) => {
            if (ed.event?.button !== undefined && ed.event.button !== 0) {
                lastMouseDownHadShift = false;
                return false;
            }
            const clickedName = ed.data?.[ed.curveNumber]?.name;
            const shiftClick = !!(ed.event?.shiftKey || lastMouseDownHadShift);
            lastMouseDownHadShift = false;
            this._handleFftLegendClick(panelId, plot, clickedName, shiftClick);
            return false;
        });
        div.on('plotly_legenddoubleclick', () => false);
        div.on('plotly_afterplot', () => {
            this._installLegendHoverHint(div);
            // Y-only pans/zooms produce no x-axis relayout update, so the
            // cursor overlays (line/dot pixels) must follow the redraw here,
            // like the timeseries chart does via _refreshPanelDomOverlays.
            this._refreshPanelDomOverlays(plot);
        });
    };
    bindLegend(plot.div);
    bindLegend(plot.fftDiv);
    plot.div.on('plotly_relayout', ed => this._onRelayout(panelId, ed));
    // Plotly can begin native autoscale on the second click, before dblclick is
    // dispatched. Capture that click first, paint Loading detail, then run ours.
    plot.div.addEventListener('click', event => {
        if (event.button !== 0 || event.detail !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        this._runWithEagerDetailLoading(panelId, () => this._autoScalePlotTimeOnly(plot));
    }, { capture: true });
    plot.div.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    }, { capture: true });
    plot.fftDiv.on('plotly_doubleclick', () => {
        this._scheduleFftAxisLimitReset(plot);
        return false;
    });
    // Keep the spectrum-pane cursors glued to their frequencies when the user
    // zooms or pans the spectrum, and re-window the drawn points to the new
    // frequency range so zooming reveals the fine zero-padded detail.
    plot.fftDiv.on('plotly_relayout', (ed) => {
        if (plot.cursorsSpectrum?.enabled) this._syncCursorDisplay(panelId, plot);
        const touchesX = ed && (
            ed['xaxis.autorange'] !== undefined
            || ed['xaxis.range'] !== undefined
            || ed['xaxis.range[0]'] !== undefined
            || ed['xaxis.range[1]'] !== undefined
        );
        if (!touchesX) return;
        const doWindow = () => {
            const r = plot.fftDiv?._fullLayout?.xaxis?.range;
            this._refreshFftSpectrumWindow(panelId, plot, Array.isArray(r) ? r.slice() : null);
        };
        clearTimeout(plot._fftSpectrumWindowTimer);
        plot._fftSpectrumWindowTimer = 0;
        // Honour the Pan/zoom refresh setting on the spectrum pane too:
        // Responsive re-windows during the drag (coalesced to one frame so the
        // restyle never runs re-entrantly inside the relayout event); Auto /
        // After-pan defer until panning settles.
        if ((this.relayoutRefreshMode || 'auto') === 'responsive') {
            if (!plot._fftSpectrumWindowFrame) {
                const scheduleFrame = typeof requestAnimationFrame === 'function'
                    ? requestAnimationFrame
                    : (callback) => setTimeout(callback, 16);
                plot._fftSpectrumWindowFrame = scheduleFrame(() => {
                    plot._fftSpectrumWindowFrame = 0;
                    doWindow();
                });
            }
        } else {
            plot._fftSpectrumWindowTimer = setTimeout(doWindow, 120);
        }
    });
    this._installLegendHoverHint(plot.div);
    this._installLegendHoverHint(plot.fftDiv);
};

proto._handleFftLegendContextMenu = function(panelId, plot, div, event) {
    const fullTrace = this._legendFullTraceFromContextEvent?.(div, event);
    const clickedName = fullTrace?.name;
    const trace = (plot.traces || []).find(t => this._traceName(t.varName, t.fileId) === clickedName);
    if (!trace) return false;
    event.preventDefault();
    event.stopPropagation();
    this._showLegendTraceMenu(event, trace, {
        onShow: () => this._setFftLegendSelection(panelId, plot, trace, 'show'),
        onHide: () => this._setFftLegendSelection(panelId, plot, trace, 'hide'),
        onOnly: () => this._setFftLegendSelection(panelId, plot, trace, 'only'),
        onRemove: () => this._removeFftTraceFromLegend(panelId, plot, trace),
    });
    return true;
};

proto._handleFftLegendClick = function(panelId, plot, clickedName, shiftClick = false) {
    if (!clickedName) return;
    const trace = (plot.traces || []).find(t => this._traceName(t.varName, t.fileId) === clickedName);
    if (!trace) return;
    if (shiftClick) {
        const index = plot.traces.indexOf(trace);
        if (index >= 0) plot.traces.splice(index, 1);
        if (!plot.traces.length) this._clearPanel(panelId);
        else this._rebuildPanel(panelId, { preserveView: true });
        return;
    }
    trace.visible = trace.visible === 'legendonly' ? true : 'legendonly';
    this._refreshFftTimePlot(panelId, plot, { preserveView: true });
    this._scheduleFftRecompute(panelId, { immediate: true });
};

proto._setFftLegendSelection = function(panelId, plot, selectedTrace, action) {
    for (const trace of plot.traces || []) {
        let visible = trace.visible === 'legendonly' || trace.visible === false ? 'legendonly' : true;
        if (action === 'show' && trace === selectedTrace) visible = true;
        if (action === 'hide' && trace === selectedTrace) visible = 'legendonly';
        if (action === 'only') visible = trace === selectedTrace ? true : 'legendonly';
        trace.visible = visible;
    }
    this._refreshFftTimePlot(panelId, plot, { preserveView: true });
    this._scheduleFftRecompute(panelId, { immediate: true });
};

proto._removeFftTraceFromLegend = function(panelId, plot, trace) {
    const index = (plot.traces || []).indexOf(trace);
    if (index >= 0) plot.traces.splice(index, 1);
    if (!plot.traces.length) this._clearPanel(panelId);
    else this._rebuildPanel(panelId, { preserveView: true });
};

proto._buildFftTimeTraces = function(plot, visibleRange = null) {
    // Gap discovery is linear in the complete signal. The automatically chosen
    // clean span has already been validated and must not trigger another scan.
    const gapInfo = visibleRange || this._fftShouldSkipGlobalGapScan(plot)
        ? { perFile: [] }
        : this._fftGapInfo(plot);
    const gapsByFile = new Map(gapInfo.perFile.map(f => [f.fileId, f]));
    const traces = plot.traces
        .map((t, idx) => {
            const built = this._buildTimeTrace(t, visibleRange, plot, idx, { attachSourceX: true });
            if (built) this._applyLineBreaks(built, gapsByFile.get(t.fileId)?.gaps);
            return built;
        })
        .filter(Boolean);
    if (this._ensureFftState(plot).showWindowed) {
        traces.push(...this._buildFftWindowedTimeTraces(plot, this._fftCurrentVisibleRange(plot)));
    }
    return traces;
};

// The current zoom window (frequency-independent x-range) of the time pane, or
// null when it is on autorange (full view). Used so the windowed overlay is
// downsampled to the same visible window as the real signals.
proto._fftCurrentVisibleRange = function(plot) {
    const xa = plot?.div?._fullLayout?.xaxis;
    return (xa && xa.autorange === false && Array.isArray(xa.range)) ? xa.range.slice() : null;
};

proto._buildFftWindowedTimeTraces = function(plot, visibleRange = null) {
    const state = this._ensureFftState(plot);
    const range = this._activeFftRange(plot);
    const out = [];
    for (const trace of plot.traces || []) {
        if (!this._isVisible(trace)) continue;
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const values = this._getTransformedVariableData(trace.fileId, trace.varName);
        const length = Math.min(times?.length || 0, values?.length || 0);
        let selectedCount = length;
        if (Array.isArray(range) && range.length >= 2 && length) {
            let lo = Number(range[0]);
            let hi = Number(range[1]);
            if (lo > hi) [lo, hi] = [hi, lo];
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
                selectedCount = Math.max(
                    0,
                    Math.min(length, this._upperBound(times, hi))
                        - Math.max(0, this._lowerBound(times, lo)),
                );
            }
        }
        // The dotted overlay is decorative. Do not copy a multi-million-point
        // manual selection on the UI thread merely to decide not to draw it.
        if (selectedCount < 2 || selectedCount > 200000) continue;
        const selected = selectFftRange(times, values, range);
        const n = Math.min(selected.times?.length || 0, selected.values?.length || 0);
        if (n < 2 || n > 200000) continue;
        const window = fftWindowCoefficients(state.windowType, n);
        let mean = 0;
        if (state.removeMean) {
            for (let i = 0; i < n; i++) mean += Number(selected.values[i]);
            mean /= n;
        }
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) y[i] = (Number(selected.values[i]) - (state.removeMean ? mean : 0)) * window[i];
        // Window is applied over the full selected range, then the RESULT is
        // downsampled to the visible window with the same config (and same
        // min/max downsampler) as the real signals — so zooming shows the same
        // level of detail instead of a coarse full-range overview.
        const visual = this._buildTimeseriesVisualData(selected.times, y, visibleRange, false);
        out.push({
            x: this._plotlyTimeArray(trace.fileId, visual.x, this._getTimeVar(trace.fileId)),
            y: visual.y,
            type: 'scatter',
            mode: 'lines',
            name: `${this._traceName(trace.varName, trace.fileId)} ${i18n.t('fftWindowedSuffix')}`,
            showlegend: false,
            hoverinfo: 'skip',
            line: { color: trace.color, width: 1, dash: 'dot' },
            opacity: 0.7,
            _fftWindowed: true,
        });
    }
    return out;
};

// Re-downsample the windowed overlay to the visible window on zoom/pan, in step
// with the real signals (_refreshTimeseriesVisuals only touches plot.traces, so
// the windowed overlay — extra traces — would otherwise stay at full-range res).
proto._refreshFftWindowedVisuals = function(panelId, plot = this.plots.get(panelId), visibleRange = null) {
    if (!plot?.div || plot.mode !== 'fft' || !this._ensureFftState(plot).showWindowed) return;
    const rebuilt = this._buildFftWindowedTimeTraces(plot, visibleRange);
    if (!rebuilt.length) return;
    const byName = new Map(rebuilt.map(tr => [tr.name, tr]));
    const indices = [];
    const xs = [];
    const ys = [];
    (plot.div.data || []).forEach((tr, i) => {
        if (!tr?._fftWindowed) return;
        const next = byName.get(tr.name);
        if (!next) return;
        indices.push(i);
        xs.push(next.x);
        ys.push(next.y);
    });
    if (!indices.length) return;
    Plotly.restyle(plot.div, { x: xs, y: ys }, indices);
};

proto._buildFftTimeLayout = function(plot, visibleRange = null) {
    const layout = this._buildTimeLayout(plot, visibleRange ? { timeRange: visibleRange } : undefined);
    layout.shapes = this._fftTimePaneShapes(plot);
    layout.margin = { ...(layout.margin || {}), t: 8 };
    // No hover on the time plot: the tooltips get in the way of the
    // selection handles. The spectrum plot keeps its hover.
    layout.hovermode = false;
    return layout;
};

proto._buildFftSpectrumLayout = function(plot) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const state = this._ensureFftState(plot);
    const xRange = this._fftResolvedAxisLimitRange(plot, 'fMin', 'fMax');
    const yRange = this._fftResolvedAxisLimitRange(plot, 'yMin', 'yMax');
    const yTitle = state.amplitudeScale === 'dbRelative'
        ? i18n.t('fftAmplitudeDbRelative')
        : state.amplitudeScale === 'db'
            ? i18n.t('fftAmplitudeDb')
            : i18n.t('fftAmplitude');
    return {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: true,
        legend: this._legendConfig(legendBg, gridColor),
        xaxis: {
            gridcolor: gridColor,
            linecolor: gridColor,
            tickcolor: gridColor,
            zeroline: false,
            title: { text: this._fftFrequencyAxisTitle(plot), font: { size: 10 } },
            ...(xRange ? { range: xRange, autorange: false } : {}),
        },
        yaxis: {
            gridcolor: gridColor,
            linecolor: gridColor,
            tickcolor: gridColor,
            zeroline: false,
            title: { text: yTitle, font: { size: 10 } },
            ...(yRange ? { range: yRange, autorange: false } : {}),
        },
        margin: { l: 58, r: 16, t: 8, b: 46 },
        autosize: true,
        hovermode: 'closest',
    };
};

proto._fftAxisRange = function(a, b) {
    const lo = Number(a);
    const hi = Number(b);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return null;
    return lo < hi ? [lo, hi] : [hi, lo];
};

proto._fftResolvedAxisLimitRange = function(plot, minKey, maxKey) {
    const state = this._ensureFftState(plot);
    const hasMin = hasFiniteFftValue(state[minKey]);
    const hasMax = hasFiniteFftValue(state[maxKey]);
    if (!hasMin && !hasMax) return null;
    const lo = hasMin ? Number(state[minKey]) : this._fftAxisLimitDisplayValue(plot, minKey);
    const hi = hasMax ? Number(state[maxKey]) : this._fftAxisLimitDisplayValue(plot, maxKey);
    return this._fftAxisRange(lo, hi);
};

proto._fftSpectrumExtent = function(plot, axis = 'x') {
    let min = Infinity;
    let max = -Infinity;
    for (const trace of plot?._fftSpectra || []) {
        if (trace?.visible === 'legendonly') continue;
        const ext = trace?._fftExtent;
        const lo = axis === 'y' ? Number(ext?.yMin) : Number(ext?.xMin);
        const hi = axis === 'y' ? Number(ext?.yMax) : Number(ext?.xMax);
        if (Number.isFinite(lo)) min = Math.min(min, lo);
        if (Number.isFinite(hi)) max = Math.max(max, hi);
    }
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };

    const axisLayout = axis === 'y' ? plot?.fftDiv?._fullLayout?.yaxis : plot?.fftDiv?._fullLayout?.xaxis;
    const r0 = this._coerceAxisValue(axisLayout?.range?.[0]);
    const r1 = this._coerceAxisValue(axisLayout?.range?.[1]);
    if (Number.isFinite(r0) && Number.isFinite(r1)) {
        return { min: Math.min(r0, r1), max: Math.max(r0, r1) };
    }
    return axis === 'y' ? { min: 0, max: 1 } : { min: 0, max: 1 };
};

proto._fftAxisLimitSliderDomain = function(plot, key) {
    const state = this._ensureFftState(plot);
    const isY = key === 'yMin' || key === 'yMax';
    const extent = this._fftSpectrumExtent(plot, isY ? 'y' : 'x');
    let min = Number(extent.min);
    let max = Number(extent.max);
    for (const candidateKey of isY ? ['yMin', 'yMax'] : ['fMin', 'fMax']) {
        if (hasFiniteFftValue(state[candidateKey])) {
            const value = Number(state[candidateKey]);
            min = Math.min(min, value);
            max = Math.max(max, value);
        }
    }
    if (!isY) min = Math.min(0, min);
    else if (state.amplitudeScale === 'normal') min = Math.min(0, min);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = isY ? 0 : 0;
        max = 1;
    }
    if (min === max) {
        const pad = Math.max(Math.abs(min) * 0.1, 1);
        min -= pad;
        max += pad;
    } else if (isY) {
        const pad = (max - min) * 0.05;
        min -= pad;
        max += pad;
    }
    return { min, max };
};

proto._fftAxisLimitDisplayValue = function(plot, key, domain = null) {
    const state = this._ensureFftState(plot);
    if (hasFiniteFftValue(state[key])) return Number(state[key]);
    const sliderDomain = domain || this._fftAxisLimitSliderDomain(plot, key);
    return key === 'fMin' || key === 'yMin' ? sliderDomain.min : sliderDomain.max;
};

proto._fftFrequencyUnitSuffix = function(plot) {
    const title = this._fftFrequencyAxisTitle(plot);
    const match = String(title || '').match(/\[[^\]]+\]/);
    return match ? ` ${match[0]}` : '';
};

proto._fftAmplitudeUnitSuffix = function(plot) {
    const scale = this._ensureFftState(plot).amplitudeScale;
    if (scale === 'dbRelative') return ' [dB rel.]';
    if (scale === 'db') return ' [dB]';
    return '';
};

proto._fftAxisLimitLabel = function(plot, key) {
    if (key === 'fMin') return `${i18n.t('fftFMin')}${this._fftFrequencyUnitSuffix(plot)}`;
    if (key === 'fMax') return `${i18n.t('fftFMax')}${this._fftFrequencyUnitSuffix(plot)}`;
    if (key === 'yMin') return `${i18n.t('fftYMin')}${this._fftAmplitudeUnitSuffix(plot)}`;
    if (key === 'yMax') return `${i18n.t('fftYMax')}${this._fftAmplitudeUnitSuffix(plot)}`;
    return key;
};

proto._configureFftAxisLimitSlider = function(input, plot, key) {
    const fmt = value => Number.isFinite(Number(value)) ? String(Number(Number(value).toPrecision(12))) : '';
    const domain = this._fftAxisLimitSliderDomain(plot, key);
    input.min = fmt(domain.min);
    input.max = fmt(domain.max);
    input.step = 'any';
    input.value = fmt(this._fftAxisLimitDisplayValue(plot, key, domain));
    input.title = this._fftAxisLimitTooltip(key);
};

proto._refreshFftTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
    if (!plot?.div || plot.mode !== 'fft') return Promise.resolve();
    const xRange = options.preserveView && options.preserveX !== false ? plot.div._fullLayout?.xaxis?.range : null;
    const yRange = options.preserveView && options.preserveY !== false ? plot.div._fullLayout?.yaxis?.range : null;
    const domain = this._fftDomain(plot);
    const fullTimeRange = domain ? [domain.min, domain.max] : null;
    const layout = this._buildFftTimeLayout(plot, fullTimeRange);
    if (Array.isArray(xRange)) {
        layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
    }
    if (Array.isArray(yRange)) {
        layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
    }
    return Plotly.react(plot.div, this._buildFftTimeTraces(plot), layout, this._getPlotlyConfig())
        .then(() => {
            this._installLegendHoverHint(plot.div);
            this._installCursorHandlers(panelId, plot);
            this._installFftSelectionHandlers(panelId, plot);
            this._syncCursorDisplay(panelId, plot);
            // Eager full-series overviews are cached. Lazy files still need
            // their exact viewport query after the Plotly rebuild.
            const hasLazyTrace = (plot.traces || []).some(trace =>
                !!this.files.get(trace.fileId)?.data?._duckdb);
            if (hasLazyTrace) this._refreshTimeseriesVisuals(panelId, plot);
        });
};

proto._scheduleFftRecompute = function(panelId, options = {}) {
    const plot = this.plots.get(panelId);
    if (!plot?.fftDiv || plot.mode !== 'fft') return;
    clearTimeout(plot._fftRecomputeTimer);
    // Merge view-preservation flags across coalesced calls: one "don't
    // preserve" request wins over any queued "preserve" ones.
    const prev = plot._fftRecomputeView || {};
    plot._fftRecomputeView = {
        preserveX: options.preserveSpectrumX !== false && prev.preserveX !== false,
        preserveY: options.preserveSpectrumY !== false && prev.preserveY !== false,
    };
    const run = async () => {
        if (plot.mode !== 'fft' || !plot.fftDiv) return;
        // Manual ranges are never shortened automatically: changing the green
        // selection is the user's explicit opt-in to a longer calculation.
        // The O(log n) preflight remains here solely to reject an NFFT above
        // the real platform memory limit before any enormous slice/copy.
        const preparationToken = (plot._fftPreparationToken || 0) + 1;
        plot._fftPreparationToken = preparationToken;
        const adjusted = await this._prepareFftAutoRange(panelId, plot, preparationToken);
        if (plot._fftPreparationToken !== preparationToken
            || plot.mode !== 'fft'
            || !plot.fftDiv) return;
        if (plot._fftPreflightTooLarge) {
            plot._fftToken = (plot._fftToken || 0) + 1;
            this._abortFftWorkerJob(plot, 'FFT selection exceeds the platform limit');
            const trace = (plot.traces || []).find(item => this._isVisible(item));
            const state = this._ensureFftState(plot);
            const rejected = plot._fftPreflightTooLarge;
            // Refusing and stopping there leaves the previous spectrum on
            // screen under settings that did not produce it — the plot then
            // describes a range and a padding the user is no longer looking
            // at. Recompute from something valid instead, so what is drawn
            // always matches what the controls say.
            //
            // Prefer the largest range that fits over the last one that did:
            // the user asked for more data, and that answers them with as much
            // as the platform can give at the padding they chose, instead of
            // undoing their request back to whatever preceded it.
            const clamped = this._clampFftRangeToLimit(plot, state);
            if (clamped) {
                const warning = this._fftWarningText(trace, 'tooManyPointsClamped', {
                    ...rejected,
                    samples: clamped.samples,
                });
                state.warnings = [warning];
                this._setFftStatus(plot, warning, 'warning');
                this._updateFftSelectionShapes(panelId, plot);
                this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
                this._applyPendingAnalysisFocus(plot, 'fft');
                this._syncFftOptionsPanel(plot);
                this._renderFftOptionsPanel(panelId, plot);
                this._refreshFftSpectrumPlot(panelId, plot).then(() => {
                    if (plot.mode !== 'fft' || plot._fftPreflightTooLarge) return;
                    state.warnings = [warning];
                    this._setFftStatus(plot, warning, 'warning');
                });
                return;
            }
            // Already at the largest fitting range, so the padding is what does
            // not fit: put back the combination that last worked.
            if (this._revertFftToLastAccepted(panelId, plot, state)) {
                const warning = this._fftWarningText(trace, 'tooManyPointsReverted', rejected);
                state.warnings = [warning];
                this._setFftStatus(plot, warning, 'warning');
                this._updateFftSelectionShapes(panelId, plot);
                this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
                this._applyPendingAnalysisFocus(plot, 'fft');
                this._syncFftOptionsPanel(plot);
                this._renderFftOptionsPanel(panelId, plot);
                this._refreshFftSpectrumPlot(panelId, plot).then(() => {
                    // The recompute reports its own success; restate why the
                    // settings moved back, or the revert looks like a glitch.
                    if (plot.mode !== 'fft' || plot._fftPreflightTooLarge) return;
                    state.warnings = [warning];
                    this._setFftStatus(plot, warning, 'warning');
                });
                return;
            }
            // Nothing to fall back to (the very first attempt was already too
            // large): say so and leave the controls where the user put them.
            const warning = this._fftWarningText(trace, 'tooManyPoints', rejected);
            state.warnings = [warning];
            this._setFftStatus(plot, warning, 'warning');
            this._setFftComputing(plot, false);
            this._syncFftOptionsPanel(plot);
            return;
        }
        if (adjusted) {
            // Keep the UI truthful: the green band and numeric controls must
            // show the exact smaller block that will be sent to the FFT, and
            // the view must sit close enough for its edges to be draggable.
            this._updateFftSelectionShapes(panelId, plot);
            this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
            this._applyPendingAnalysisFocus(plot, 'fft');
        }
        this._refreshFftSpectrumPlot(panelId, plot);
    };
    // Even "immediate" recomputes yield one task. This makes close/clear and
    // option buttons responsive and guarantees the loading label is painted.
    plot._fftRecomputeTimer = setTimeout(run, options.immediate ? 0 : 120);
};

proto._prepareFftAutoRange = async function(panelId, plot, token, options = {}) {
    const state = this._ensureFftState(plot);
    const trace = (plot.traces || []).find(item => this._isVisible(item));
    plot._fftPreflightTooLarge = null;
    // Same rule as the shared limiter: rebuilding the pane over a range that is
    // still the automatic preview owes it a focused view, or the selection is
    // drawn a few pixels wide and neither edge can be grabbed.
    if (options.initial === true && state.autoRangeLimited === true) state.autoRangeFocusPending = true;
    if (!trace) return false;
    const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
    const values = this._getTransformedVariableData(trace.fileId, trace.varName);
    const n = Math.min(times?.length || 0, values?.length || 0);
    if (n < 2) return false;

    const lowerBound = value => {
        let lo = 0;
        let hi = n;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (Number(times[mid]) < value) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const upperBound = value => {
        let lo = 0;
        let hi = n;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (Number(times[mid]) <= value) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    let selectionStart = 0;
    let selectionEnd = n;
    if (!state.rangeFull) {
        const activeRange = this._activeFftRange(plot);
        if (Array.isArray(activeRange) && activeRange.length >= 2) {
            const lo = Math.min(Number(activeRange[0]), Number(activeRange[1]));
            const hi = Math.max(Number(activeRange[0]), Number(activeRange[1]));
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
                selectionStart = lowerBound(lo);
                selectionEnd = upperBound(hi);
            }
        }
    }
    const selectedCount = Math.max(0, selectionEnd - selectionStart);
    if (selectedCount < 2) return false;
    const estimatedMs = estimateFftDurationMs(selectedCount, state.zeroPaddingFactor);
    const estimatedNfft = nextPowerOfTwo(selectedCount)
        * normalizeZeroPaddingFactor(state.zeroPaddingFactor);
    if (options.initial !== true) {
        const effectiveMaxNfft = this._canUseFftWorker()
            ? this._fftComputationMaxNfft()
            : this._fftLiveMaxNfft();
        if (estimatedNfft > effectiveMaxNfft) {
            plot._fftPreflightTooLarge = {
                n: selectedCount,
                nfft: estimatedNfft,
                maxNfft: effectiveMaxNfft,
            };
        }
        return false;
    }
    // Keep the automatically selected transform itself around 2^18 NFFT even
    // when zero padding is enabled. The old fixed 262k source points became a
    // 4.2M-point transform at x16.
    const target = Math.min(
        selectedCount,
        Math.max(2, Math.floor(FFT_AUTO_TARGET_POINTS / state.zeroPaddingFactor)),
    );
    const needsInitialLimit = estimatedMs > FFT_AUTO_SLOW_MS;
    const needsTighterPriorLimit = state.autoRangeLimited && selectedCount > target;
    if (!needsInitialLimit && !needsTighterPriorLimit) return false;

    const blockIsClean = start => {
        const end = Math.min(selectionEnd, start + target);
        if (end - start < target) return false;
        let previousTime = NaN;
        let expectedStep = NaN;
        for (let i = start; i < end; i++) {
            if (plot._fftPreparationToken !== token || plot.mode !== 'fft') return null;
            const time = Number(times[i]);
            const value = Number(values[i]);
            if (!Number.isFinite(time) || !Number.isFinite(value)
                || (i > start && !(time > previousTime))) return false;
            if (i > start) {
                const step = time - previousTime;
                if (i === start + 1) expectedStep = step;
                else if (!Number.isFinite(expectedStep)
                    || Math.abs(step - expectedStep) > Math.abs(expectedStep) * 1e-3) return false;
            }
            previousTime = time;
        }
        return true;
    };

    // Check the earliest consecutive blocks first. If the beginning contains
    // missing data, probe later blocks without linearly walking a multi-GB
    // signal. Each candidate is fully validated before it is selected.
    const candidateStarts = [];
    const candidateCount = Math.max(1, Math.ceil(selectedCount / target));
    const sequential = Math.min(candidateCount, 8);
    for (let block = 0; block < sequential; block++) {
        candidateStarts.push(selectionStart + block * target);
    }
    const probes = Math.min(24, candidateCount - sequential);
    for (let probe = 1; probe <= probes; probe++) {
        const block = sequential + Math.floor((probe * (candidateCount - sequential - 1)) / Math.max(1, probes));
        candidateStarts.push(selectionStart + block * target);
    }

    let cleanStart = -1;
    for (const start of [...new Set(candidateStarts)]) {
        const clean = blockIsClean(start);
        if (clean === null) return false;
        if (clean) {
            cleanStart = start;
            break;
        }
        // Failed candidates are uncommon, but a file with many sparse NaNs can
        // require several probes. Yield between candidates, never inside the
        // first bounded block: timer throttling under memory pressure made the
        // otherwise trivial 262k-sample validation take 10–12 seconds.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    const foundCleanBlock = cleanStart >= 0;
    // Never fall back to the enormous range: even a pathological file with no
    // clean candidate must fail quickly and responsively with the normal
    // NaN/non-uniform warning. The generic wording does not claim this fallback
    // block was clean.
    if (!foundCleanBlock) cleanStart = selectionStart;
    state.rangeFull = false;
    state.autoRangeLimited = true;
    // Without this the automatic block is drawn a few pixels wide on the full
    // time axis and neither green edge can be grabbed. See the note on
    // ANALYSIS_FOCUS_PADDING in data-methods.js.
    state.autoRangeFocusPending = true;
    state.x1 = Number(times[cleanStart]);
    state.x2 = Number(times[cleanStart + target - 1]);
    const seconds = Math.max(5, Math.round(estimatedMs / 1000));
    state.autoRangeWarning = i18n.t(foundCleanBlock ? 'fftAutoRangeWarning' : 'analysisAutoRangeWarning')
        .replace('{seconds}', seconds.toLocaleString())
        .replace('{samples}', target.toLocaleString());
    this._syncFftOptionsPanel(plot);
    return true;
};

proto._refreshFftSpectrumPlot = async function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.fftDiv || plot.mode !== 'fft') return;
    const token = (plot._fftToken || 0) + 1;
    plot._fftToken = token;
    this._abortFftWorkerJob(plot);
    const state = this._ensureFftState(plot);
    const range = this._activeFftRange(plot);
    const visible = (plot.traces || []).filter(trace => this._isVisible(trace));
    // Hidden traces must keep a greyed legend entry. An EMPTY legendonly trace
    // produces no legend entry in Plotly, so reuse the trace's PREVIOUS spectrum
    // data (it is hidden anyway; it refreshes when shown again).
    const prevByName = new Map((plot._fftSpectra || []).filter(s => s && s.name).map(s => [s.name, s]));
    const legendPlaceholder = (trace) => {
        const name = this._traceName(trace.varName, trace.fileId);
        const prev = prevByName.get(name);
        if (prev) return { ...prev, visible: 'legendonly' };
        return { x: [], y: [], type: 'scattergl', mode: 'lines', name, visible: 'legendonly', line: { color: trace.color, width: 1.5 } };
    };
    if (!visible.length) {
        this._setFftStatus(plot, i18n.t('fftNoVisibleTraces'), 'muted');
        this._setFftComputing(plot, false);
        await Plotly.react(plot.fftDiv, (plot.traces || []).map(legendPlaceholder), this._buildFftSpectrumLayout(plot), this._getPlotlyConfig());
        return;
    }

    this._setFftStatus(plot, i18n.t('fftCalculating'), 'loading');
    this._setFftComputing(plot, true);
    const spectra = [];
    const fullEntries = [];
    const warnings = state.autoRangeWarning ? [state.autoRangeWarning] : [];
    // Step of the analyzed span, as the uniformity gate measured it. Only worth
    // naming in the status when every plotted trace agrees on it; overlaid files
    // can carry different steps, and picking one of them would be a guess.
    const spanSteps = new Set();
    // How many samples each trace actually transformed. Same rule as the step
    // above: overlaid files can disagree, and naming one of them would be a
    // guess, so the count is only reported when they all match.
    const sampleCounts = new Set();
    for (const trace of visible) {
        if (plot._fftToken !== token) return;
        let series;
        try {
            series = await this._fftSeriesForTrace(trace, range, state);
        } catch (err) {
            console.warn('[fft] failed to fetch series:', err);
            series = { ok: false, reason: 'fetchFailed' };
        }
        if (plot._fftToken !== token) return;
        if (!series?.ok) {
            warnings.push(this._fftWarningText(trace, series?.reason || 'invalid'));
            continue;
        }
        let spectrum;
        try {
            spectrum = await this._computeFftSpectrumForSeries(plot, series, state);
        } catch (err) {
            if (plot._fftToken !== token || err?.name === 'AbortError') return;
            console.warn('[fft] failed to compute spectrum:', err);
            warnings.push(this._fftWarningText(trace, 'invalid'));
            continue;
        }
        if (plot._fftToken !== token) return;
        if (!spectrum.ok) {
            warnings.push(this._fftWarningText(trace, spectrum.reason, spectrum));
            continue;
        }
        if (Number.isFinite(spectrum.sampling?.dt)) spanSteps.add(spectrum.sampling.dt);
        if (Number.isInteger(spectrum.n) && spectrum.n > 0) sampleCounts.add(spectrum.n);
        for (const warning of spectrum.warnings || []) {
            warnings.push(this._fftWarningText(trace, warning, spectrum));
        }
        // Keep the FULL spectrum (all NFFT/2 bins) so a zoom can reveal the fine
        // detail zero-padding buys. The drawn trace is a bounded, windowed
        // downsample built by _buildFftSpectrumTrace and rebuilt on zoom by
        // _refreshFftSpectrumWindow; storing the whole array here is cheap (one
        // typed array), unlike the per-bin period-label + render pass.
        fullEntries.push({
            index: fullEntries.length,
            name: this._traceName(trace.varName, trace.fileId),
            color: trace.color,
            visible: trace.visible ?? true,
            frequencies: spectrum.frequencies,
            amplitudes: spectrum.amplitudes,
            yExtent: this._finiteExtent([spectrum.amplitudes]),
        });
    }

    state.warnings = warnings;
    plot._fftSpectraFull = fullEntries;
    if (plot._fftToken !== token) return;
    // Preserve the user's manual zoom on the spectrum across recomputes:
    // if an axis is not on autorange, keep its current range instead of
    // letting the rebuilt layout fall back to autorange / state limits.
    const view = plot._fftRecomputeView || {};
    plot._fftRecomputeView = null;
    // A panel rebuild (live update, transform change) hands the previous
    // spectrum zoom over via _fftPendingSpectrumView; otherwise fall back
    // to whatever the live spectrum axes currently show.
    const pending = plot._fftPendingSpectrumView || null;
    plot._fftPendingSpectrumView = null;

    // Window the drawn points to the frequency range the pane will actually
    // show, so a preserved zoom renders at full padded detail from the start.
    const liveXAxis = plot.fftDiv?._fullLayout?.xaxis;
    let displayRange = null;
    if (Array.isArray(pending?.xRange)) displayRange = pending.xRange;
    else if (view.preserveX !== false && liveXAxis && liveXAxis.autorange === false && Array.isArray(liveXAxis.range)) {
        displayRange = liveXAxis.range;
    }
    for (const entry of fullEntries) spectra.push(this._buildFftSpectrumTrace(plot, entry, displayRange));
    // Keep hidden traces in the spectrum data as legendonly placeholders so
    // their legend entry persists (greyed) instead of vanishing on toggle.
    for (const trace of plot.traces || []) {
        if (this._isVisible(trace)) continue;
        spectra.push(legendPlaceholder(trace));
    }
    plot._fftSpectra = spectra;

    const layout = this._buildFftSpectrumLayout(plot);
    const keepAxis = (axisKey, preserve, pendingRange) => {
        if (preserve === false) return;
        if (Array.isArray(pendingRange)) {
            layout[axisKey] = { ...layout[axisKey], range: pendingRange.slice(), autorange: false };
            return;
        }
        const axis = plot.fftDiv?._fullLayout?.[axisKey];
        if (!axis || axis.autorange !== false || !Array.isArray(axis.range)) return;
        layout[axisKey] = { ...layout[axisKey], range: axis.range.slice(), autorange: false };
    };
    keepAxis('xaxis', view.preserveX, pending?.xRange);
    keepAxis('yaxis', view.preserveY, pending?.yRange);
    await Plotly.react(plot.fftDiv, spectra, layout, this._getPlotlyConfig());
    if (plot._fftToken !== token) return;
    this._installLegendHoverHint(plot.fftDiv);
    this._syncFftOptionsPanel(plot);
    this._installCursorHandlers(panelId, plot);
    this._syncCursorDisplay(panelId, plot);
    const bandsInRange = this._fftGapsOverlapAnalyzedRange(plot);
    if (warnings.length) {
        // No spectrum. If a band overlaps the span, that band is the actionable
        // part of the failure: another span may well work.
        const base = warnings.join(' | ');
        const note = bandsInRange ? i18n.t('fftGapsWarning') : '';
        this._setFftStatus(plot, note ? `${base} - ${note}` : base, 'warning');
    } else if (bandsInRange) {
        // A spectrum DID come out, so the span passed the uniformity gate and
        // nothing is missing within it. Telling the user to pick a span without
        // bands would be advice they have already followed, about a result that
        // is valid — so explain the bands instead.
        //
        // Typed as a warning for PLACEMENT, not severity: that is the type whose
        // full text goes to the side panel while the topbar points there. A
        // sentence this long does not belong in the topbar, and the panel is
        // where every other FFT explanation already lives.
        const spanDt = spanSteps.size === 1 ? [...spanSteps][0] : NaN;
        this._setFftStatus(plot, this._fftUniformSpanNote(spanDt), 'warning');
    } else if (sampleCounts.size === 1) {
        // The count answers the question the topbar leaves open on a large
        // file — how much of it this spectrum actually describes.
        this._setFftStatus(
            plot,
            i18n.t('fftReadySamples').replace('{samples}', i18n.formatNumber([...sampleCounts][0])),
            'ready',
        );
    } else {
        this._setFftStatus(plot, i18n.t('fftReady'), 'ready');
    }
    // A spectrum came out, so this range and padding are known to fit the
    // platform. That is what a later rejected combination falls back to.
    if (spectra.length) this._rememberAcceptedFftSettings(plot);
    // Terminal for this token (superseding runs manage their own pill on the
    // token-mismatch early returns above, so this only fires for the live run).
    this._setFftComputing(plot, false);
};

// Build one drawn spectrum trace from a full-resolution entry, windowed to the
// frequency range currently shown. `_fftExtent` always reports the FULL span so
// autoscale/axis limits cover the whole spectrum, not just the visible window.
proto._buildFftSpectrumTrace = function(plot, entry, range) {
    let lo = null;
    let hi = null;
    if (Array.isArray(range) && range.length >= 2) {
        lo = this._coerceAxisValue(range[0]);
        hi = this._coerceAxisValue(range[1]);
        if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) { const t = lo; lo = hi; hi = t; }
    }
    const { frequencies: dispFreqs, amplitudes: dispAmps } =
        windowSpectrumForDisplay(entry.frequencies, entry.amplitudes, lo, hi);
    const periodUnit = this._fftCursorPeriodUnit(plot);
    const periodValues = new Float64Array(dispFreqs.length);
    // Dense (filled with '') — a sparse array leaves holes that Plotly renders
    // as "-" in %{text}, so the hover showed e.g. "1.09227 s-" instead of "s".
    const naturalPeriodSuffixes = new Array(dispFreqs.length).fill('');
    for (let i = 0; i < dispFreqs.length; i++) {
        const period = frequencyPeriod(Number(dispFreqs[i]));
        periodValues[i] = period;
        if (periodUnit === 's' && Number.isFinite(period) && period >= 60) {
            naturalPeriodSuffixes[i] = ` (${formatNaturalDuration(period, 2)})`;
        }
    }
    const full = entry.frequencies;
    return {
        x: dispFreqs,
        y: dispAmps,
        customdata: periodValues,
        text: naturalPeriodSuffixes,
        // WebGL keeps the windowed envelope smooth to pan/zoom and is cheap for
        // the bounded point count.
        type: 'scattergl',
        mode: 'lines',
        name: entry.name,
        visible: entry.visible,
        line: { color: entry.color, width: 1.5 },
        hovertemplate: `<b>%{fullData.name}</b><br>${i18n.t('fftFrequency')}${this._fftFrequencyUnitSuffix(plot)} = %{x:.6g}<br>${i18n.t('fftPeriod')} = %{customdata:.6g}${periodUnit ? ` ${periodUnit}` : ''}%{text}<br>${i18n.t('fftAmplitudeShort')}${this._fftAmplitudeUnitSuffix(plot)} = %{y:.6g}<extra></extra>`,
        _fftFullIndex: entry.index,
        _fftExtent: {
            xMin: full.length ? Number(full[0]) : 0,
            xMax: full.length ? Number(full[full.length - 1]) : 1,
            yMin: entry.yExtent?.min,
            yMax: entry.yExtent?.max,
        },
    };
};

// Zoom/pan on the spectrum re-windows each visible trace to the new frequency
// range, so the detail zero-padding computed appears as you zoom in. Restyle
// only touches the point arrays (not the axis range), so it can't loop against
// the relayout listener; legendonly placeholders are left untouched.
proto._refreshFftSpectrumWindow = function(panelId, plot = this.plots.get(panelId), range = null) {
    if (!plot?.fftDiv || !Array.isArray(plot._fftSpectraFull) || !plot._fftSpectraFull.length) return;
    const data = plot.fftDiv.data || [];
    const indices = [];
    const xs = [];
    const ys = [];
    const customs = [];
    const texts = [];
    data.forEach((tr, i) => {
        if (!tr || tr.visible === 'legendonly' || tr._fftFullIndex == null) return;
        const entry = plot._fftSpectraFull[tr._fftFullIndex];
        if (!entry) return;
        const built = this._buildFftSpectrumTrace(plot, entry, range);
        indices.push(i);
        xs.push(built.x);
        ys.push(built.y);
        customs.push(built.customdata);
        texts.push(built.text);
    });
    if (!indices.length) return;
    Plotly.restyle(plot.fftDiv, { x: xs, y: ys, customdata: customs, text: texts }, indices);
};

proto._fftSeriesForTrace = async function(trace, range, state) {
    const fileData = this.files.get(trace.fileId)?.data;
    if (!fileData?.variables?.[trace.varName]) return { ok: false, reason: 'missingVariable' };
    const lazyMeta = fileData._duckdb;
    const source = lazyMeta?.source;
    if (source?.getRawColumnsRange) {
        const timeVar = this._getTimeVar(trace.fileId);
        const sourceRange = this._sourceRangeForDisplayRange(trace.fileId, range, timeVar);
        if (!sourceRange || !sourceRange.every(Number.isFinite)) return { ok: false, reason: 'invalidRange' };
        const maxRows = this._fftMaxRawRowsForState(state);
        const raw = await source.getRawColumnsRange(fileData, [trace.varName], sourceRange[0], sourceRange[1], maxRows);
        if (raw.truncated) return { ok: false, reason: 'tooManyPoints' };
        const transformed = this._transformFetchedPhaseTrajectory(trace.fileId, raw.x, raw.rowIndex, raw.yByVar, [trace.varName]);
        const selected = selectFftRange(transformed.time, transformed.valuesByVar.get(trace.varName), range);
        return {
            ok: true,
            times: selected.times,
            values: selected.values,
            timeKind: this._fftTimeKind(trace.fileId),
        };
    }

    const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
    const values = this._getTransformedVariableData(trace.fileId, trace.varName);
    const selected = selectFftRange(times, values, range);
    return {
        ok: true,
        times: selected.times,
        values: selected.values,
        timeKind: this._fftTimeKind(trace.fileId),
    };
};

proto._computeFftSpectrumForSeries = async function(plot, series, state) {
    const times = series.times instanceof Float64Array ? series.times : Float64Array.from(series.times || []);
    const values = series.values instanceof Float64Array ? series.values : Float64Array.from(series.values || []);
    const zeroPaddingFactor = normalizeZeroPaddingFactor(state.zeroPaddingFactor);
    const n = Math.min(times.length || 0, values.length || 0);
    const estimatedNfft = nextPowerOfTwo(n) * zeroPaddingFactor;
    const input = {
        times,
        values,
        timeKind: series.timeKind,
        removeMean: state.removeMean,
        windowType: state.windowType,
        zeroPaddingFactor,
        amplitudeScale: state.amplitudeScale,
        maxNfft: this._fftComputationMaxNfft(),
    };

    // Small transforms: synchronous is faster than spawning a worker.
    if (estimatedNfft <= this._fftWorkerThresholdNfft()) {
        return computeAmplitudeSpectrum(input);
    }
    // Larger ones go off the main thread so the tab never freezes. Without a
    // worker (e.g. file:// protocol) fall back to the synchronous path capped at
    // the main-thread limit exactly as before — unchanged for those setups.
    if (!this._canUseFftWorker()) {
        return computeAmplitudeSpectrum({ ...input, maxNfft: this._fftLiveMaxNfft() });
    }
    return this._computeFftSpectrumInWorker(plot, input);
};

proto._computeFftSpectrumInWorker = function(plot, input) {
    this._abortFftWorkerJob(plot);
    const id = `fft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let worker;
    try {
        worker = new Worker(new URL('../../workers/fft-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
        const unavailable = new Error(err?.message || 'FFT worker unavailable');
        unavailable.name = 'WorkerUnavailableError';
        throw unavailable;
    }

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            if (plot?._fftWorkerJob?.id === id) plot._fftWorkerJob = null;
            try { worker.terminate(); } catch (_) { /* ignore */ }
        };
        const rejectWith = (err) => {
            cleanup();
            reject(err);
        };
        plot._fftWorkerJob = { id, worker, reject: rejectWith };
        worker.addEventListener('message', (event) => {
            const { id: responseId, ok, spectrum, error } = event.data || {};
            if (responseId !== id) return;
            cleanup();
            if (ok) {
                resolve(spectrum);
                return;
            }
            const err = new Error(error?.message || 'FFT worker failed');
            err.name = error?.name || 'Error';
            err.stack = error?.stack || err.stack;
            reject(err);
        });
        worker.addEventListener('error', (event) => {
            const err = new Error(event?.message || 'FFT worker failed');
            rejectWith(err);
        });
        try {
            worker.postMessage({ id, input }, transferFftInputBuffers(input));
        } catch (err) {
            rejectWith(err);
        }
    });
};

proto._abortFftWorkerJob = function(plot, reason = 'FFT worker job superseded') {
    const job = plot?._fftWorkerJob;
    if (!job) return;
    plot._fftWorkerJob = null;
    try { job.worker?.terminate(); } catch (_) { /* ignore */ }
    const err = new Error(reason);
    err.name = 'AbortError';
    job.reject?.(err);
};

proto._canUseFftWorker = function() {
    return typeof window !== 'undefined'
        && typeof Worker !== 'undefined'
        && window.location?.protocol !== 'file:';
};

proto._fftComputationMaxNfft = function() {
    return this._fftHardMaxNfft();
};

proto._fftLiveMaxNfft = function() {
    return FFT_LIVE_MAX_POINTS;
};

// NFFT above which we prefer the Web Worker over a synchronous compute. Only a
// scheduling switch; when no worker is available we still fall back to the
// synchronous path up to _fftLiveMaxNfft (see _computeFftSpectrumForSeries).
proto._fftWorkerThresholdNfft = function() {
    return FFT_WORKER_THRESHOLD_POINTS;
};

proto._fftHardMaxNfft = function() {
    return globalThis.omvDesktop ? FFT_MAX_POINTS_DESKTOP : FFT_MAX_POINTS_WEB;
};

proto._fftMaxRawRowsForState = function(state = this._defaultFftState()) {
    const padding = normalizeZeroPaddingFactor(state.zeroPaddingFactor);
    return Math.max(2, Math.floor(this._fftComputationMaxNfft() / padding));
};

proto._fftTimeKind = function(fileId) {
    // Delegates to the canonical model (data-methods.js). Behavior-identical to the
    // former inline logic; see scripts/test-time-axis-readers.mjs for the proof.
    return this._canonicalFftKind(fileId);
};

proto._fftUsesCalendarTime = function(plot) {
    const trace = (plot?.traces || []).find(t => this._isVisible(t)) || plot?.traces?.[0];
    return trace ? this._fftTimeKind(trace.fileId) === 'datetime' : false;
};

proto._fftFrequencyAxisTitle = function(plot) {
    const trace = (plot?.traces || []).find(t => this._isVisible(t)) || plot?.traces?.[0];
    if (!trace) return i18n.t('fftFrequency');
    const kind = this._fftTimeKind(trace.fileId);
    if (kind === 'index') return i18n.t('fftFrequencyCycles');
    const timeVar = this._getTimeVar(trace.fileId);
    const mode = this._timeDisplayModeForVar(trace.fileId, timeVar);
    const unit = this._timeUnitLabel(trace.fileId);
    if (kind === 'datetime'
        || mode === 'elapsedDateTime'
        || mode === 'elapsedSeconds'
        || this._isGeneratedDurationTime(trace.fileId, timeVar)
        || unit === 's') {
        return i18n.t('fftFrequencyHz');
    }
    return i18n.t('fftFrequencyGeneric');
};

proto._setFftLayout = function(panelId, layout) {
    const plot = this.plots.get(panelId);
    if (!plot?.fftContainer || !FFT_LAYOUTS.has(layout)) return;
    const state = this._ensureFftState(plot);
    state.layout = layout;
    plot.fftContainer.classList.toggle('fft-layout-horizontal', layout === 'horizontal');
    plot.fftContainer.classList.toggle('fft-layout-vertical', layout === 'vertical');
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.fftDiv);
};

proto._toggleFftTimeSeries = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.fftContainer) return;
    const state = this._ensureFftState(plot);
    state.timeSeriesHidden = !state.timeSeriesHidden;
    plot.fftContainer.classList.toggle('fft-time-series-hidden', state.timeSeriesHidden);
    const button = plot.fftContainer.querySelector('.fft-time-series-btn');
    if (button) {
        button.classList.toggle('active', state.timeSeriesHidden);
        button.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    }
    if (!state.timeSeriesHidden && plot.div) {
        Plotly.Plots.resize(plot.div);
        this._refreshPanelDomOverlays(plot);
    }
    if (plot.fftDiv) Plotly.Plots.resize(plot.fftDiv);
    this._syncCursorDisplay(panelId, plot);
};

proto._toggleFftOptions = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.fftContainer) return;
    const state = this._ensureFftState(plot);
    state.optionsVisible = !state.optionsVisible;
    const options = plot.fftContainer.querySelector('.fft-options');
    if (options) options.hidden = !state.optionsVisible;
    const optionsBtn = plot.fftContainer.querySelector('.fft-options-btn');
    if (optionsBtn) {
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
    }
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.fftDiv);
};

proto._resetFftView = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;
    const state = this._ensureFftState(plot);
    state.fMin = null;
    state.fMax = null;
    state.yMin = null;
    state.yMax = null;
    state.rangeFull = true;
    this._ensureFftRange(plot, { reset: true });
    this._syncFftOptionsPanel(plot);
    this._refreshFftTimePlot(panelId, plot);
    this._autoScalePlot(panelId, plot);
    this._scheduleFftRecompute(panelId, { immediate: true, preserveSpectrumX: false, preserveSpectrumY: false });
};

proto._activeFftRange = function(plot) {
    const state = this._ensureFftState(plot);
    const domain = this._fftDomain(plot);
    if (state.rangeFull) {
        // Whole signal: track the current domain so live-appended data is
        // always included.
        if (domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) {
            return [domain.min, domain.max];
        }
        return [0, 1];
    }
    let lo = hasFiniteFftValue(state.x1) ? Number(state.x1) : NaN;
    let hi = hasFiniteFftValue(state.x2) ? Number(state.x2) : NaN;
    if (!hasFiniteFftValue(lo) || !hasFiniteFftValue(hi)) {
        lo = domain?.min;
        hi = domain?.max;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (lo > hi) [lo, hi] = [hi, lo];
    if (domain) {
        lo = Math.max(domain.min, Math.min(domain.max, lo));
        hi = Math.max(domain.min, Math.min(domain.max, hi));
    }
    return [lo, hi];
};

proto._ensureFftRange = function(plot, options = {}) {
    const state = this._ensureFftState(plot);
    const domain = this._fftDomain(plot);
    if (!domain) return state;
    const domainHasSpan = Number.isFinite(domain.min) && Number.isFinite(domain.max) && domain.min !== domain.max;
    const degenerate = domainHasSpan
        && hasFiniteFftValue(state.x1)
        && hasFiniteFftValue(state.x2)
        && Number(state.x1) === Number(state.x2);
    if (options.reset || !hasFiniteFftValue(state.x1) || !hasFiniteFftValue(state.x2) || degenerate) {
        state.x1 = domain.min;
        state.x2 = domain.max;
    }
    for (const key of ['x1', 'x2']) {
        if (!hasFiniteFftValue(state[key])) continue;
        state[key] = Math.max(domain.min, Math.min(domain.max, Number(state[key])));
    }
    return state;
};

proto._fftDomain = function(plot) {
    let min = Infinity;
    let max = -Infinity;
    for (const trace of plot?.traces || []) {
        const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const n = values?.length || 0;
        if (!n) continue;
        // Imported time axes are ascending. Probe only the edges so opening FFT
        // never performs a full-array extent scan before its UI exists.
        const probe = Math.min(n, 1024);
        for (let i = 0; i < probe; i++) {
            const lo = Number(values[i]);
            if (Number.isFinite(lo)) { min = Math.min(min, lo); break; }
        }
        for (let i = 0; i < probe; i++) {
            const hi = Number(values[n - 1 - i]);
            if (Number.isFinite(hi)) { max = Math.max(max, hi); break; }
        }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
};

// Sampling gaps over the full transformed series of each visible file,
// memoized by a cheap signature so per-drag shape relayouts stay free.
proto._fftGapInfo = function(plot) {
    const visible = (plot?.traces || []).filter(t => this._isVisible(t));
    const seen = new Set();
    const files = [];
    const sigParts = [];
    for (const t of visible) {
        if (seen.has(t.fileId)) continue;
        seen.add(t.fileId);
        const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
        const n = times?.length || 0;
        files.push({ fileId: t.fileId, times, n });
        sigParts.push(`${t.fileId}:${n}:${n ? times[0] : ''}:${n ? times[n - 1] : ''}`);
    }
    const sig = sigParts.join('|');
    if (plot._fftGapsSig === sig && plot._fftGapsCache) return plot._fftGapsCache;

    const perFile = [];
    let count = 0;
    let totalMissing = 0;
    let largest = null;
    for (const file of files) {
        // Skip lazy overview samples — their irregular spacing isn't a real gap.
        if (!this._hasTruthfulGapSeries(file.fileId)) continue;
        const info = detectSamplingGaps(file.times);
        if (!info.gaps.length) continue;
        const timeKind = this._fftTimeKind(file.fileId);
        const timeVar = this._getTimeVar(file.fileId);
        perFile.push({ fileId: file.fileId, timeVar, timeKind, ...info });
        count += info.count;
        totalMissing += info.totalMissing;
        if (info.largest && (!largest || info.largest.dt > largest.dt)) {
            largest = { ...info.largest, timeKind };
        }
    }
    const result = { perFile, count, totalMissing, largest };
    plot._fftGapsSig = sig;
    plot._fftGapsCache = result;
    return result;
};

proto._fftShouldSkipGlobalGapScan = function(plot) {
    if (this._ensureFftState(plot).autoRangeLimited) return true;
    // Missing-data decorations are optional; selected-range validation is not.
    // On very large eager signals, keep the latter and avoid an O(n) full-file
    // pass merely to paint bands. This also keeps a manual range edit or a
    // switch back to "Full" from reviving the multi-second scan.
    return (plot?.traces || []).some(trace => {
        if (!this._isVisible(trace) || !this._hasTruthfulGapSeries(trace.fileId)) return false;
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        return (times?.length || 0) > FFT_LIVE_MAX_POINTS;
    });
};

// Red bands marking missing-data intervals on a time pane. Appearance keys
// off each interval's on-screen width (recomputed on zoom): wide intervals get
// a soft borderless fill that shows their extent; narrow ones — whose fill is
// sub-pixel and would otherwise vanish — get a stronger fill plus a pixel-width
// stroke so they stay visible. `items` are { fileId, timeVar, t0, t1 } in
// transformed-time units. Shared by the FFT pane and the timeseries
// "show missing data" overlay.
// Amber "highlighter" tone for missing-data bands. Deliberately not red: red
// collides with the 2nd trace colour (which is always present), making the
// bands blend into the data. Fill fades soft→strong with width; the stroke
// rescues sub-pixel bands.
proto._gapBandFill = function(alpha) {
    const a = alpha.toFixed(3);
    // Deeper amber in light theme so the faint wide/dense bands stay perceptible
    // on the white plot; bright amber in dark theme. Alpha (and the dense wash
    // cap) is unchanged, so the signal still reads through.
    return this.theme === 'dark' ? `rgba(255, 193, 7, ${a})` : `rgba(217, 119, 6, ${a})`;
};
// Stroke for narrow (sub-pixel) gaps. Theme-aware and fully opaque: the old
// semi-transparent amber all but vanished on the white light-theme plot. Light
// uses a deep amber for contrast against white; dark uses a brighter amber.
proto._gapBandStroke = function() {
    return this.theme === 'dark' ? 'rgba(255, 179, 51, 1)' : 'rgba(184, 96, 0, 1)';
};

// Merge missing-data intervals (per file, in x-order) whose present gap is
// narrower than ~1px at the current zoom. A signal with dense scattered missing
// data — e.g. 6% random NaN over millions of rows — otherwise produces hundreds
// of thousands of sub-pixel bands that pile into a solid wall; coalescing first
// yields a few honest "missing throughout" bands when zoomed out and separates
// them back into individual gaps as the user zooms in. Without axis metrics
// (pxPerUnit not finite) it merges only touching/overlapping intervals.
proto._coalesceGapItems = function(items, pxPerUnit) {
    const minGapData = Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? 1 / pxPerUnit : 0;
    const byFile = new Map(); // one x-mapping per file+timeVar
    for (const it of items) {
        const key = `${it.fileId}\u0000${it.timeVar ?? ''}`;
        let group = byFile.get(key);
        if (!group) { group = []; byFile.set(key, group); }
        group.push(it);
    }
    const out = [];
    for (const group of byFile.values()) {
        group.sort((a, b) => a.t0 - b.t0);
        let cur = null;
        for (const it of group) {
            if (cur && it.t0 - cur.t1 <= minGapData) {
                if (it.t1 > cur.t1) cur.t1 = it.t1;
            } else {
                cur = { fileId: it.fileId, timeVar: it.timeVar, t0: it.t0, t1: it.t1 };
                out.push(cur);
            }
        }
    }
    return out;
};

// Whether the current view holds more missing intervals than there are pixels
// to resolve them (worse than one gap per 2px). Past that point individual
// bands merge into a wall AND per-gap line breaks shred the downsampled trace
// into invisible fragments — so callers fall back to: no bands, no breaks, just
// the clean signal envelope plus a "zoom in" hint. `items` are {t0,t1,...} in
// the transformed-time units that match the axis range.
proto._missingViewIsDense = function(plot, items) {
    if (!items?.length) return false;
    const xa = plot?.div?._fullLayout?.xaxis;
    if (!xa || !Array.isArray(xa.range) || !(xa._length > 0)) return false;
    let lo = this._coerceAxisValue(xa.range[0]);
    let hi = this._coerceAxisValue(xa.range[1]);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    let visible = 0;
    for (const it of items) { if (it.t1 >= lo && it.t0 <= hi) visible++; }
    return visible > xa._length * 0.5;
};

// `denseOverride` lets the lazy path supply its own density verdict (derived
// from DuckDB bucket counts), since its intervals are already coalesced and
// `_missingViewIsDense` — which counts raw intervals — would misjudge them.
proto._adaptiveGapBandShapes = function(plot, items, denseOverride = null) {
    if (!items?.length) return [];
    const MAX_BANDS = 500;

    // Pixels per data unit for the current view, so an interval's screen width
    // is (t1 - t0) * pxPerUnit. NaN until the axis has laid out — treat narrow.
    // lo/hi are the VISIBLE range in the same units the items use (both are the
    // transformed-time values _plotlyTimeValue maps from; _coerceAxisValue turns
    // a date-string range into those ms).
    const xa = plot.div?._fullLayout?.xaxis;
    let pxPerUnit = NaN;
    let lo = -Infinity;
    let hi = Infinity;
    if (xa && Array.isArray(xa.range) && xa._length) {
        lo = this._coerceAxisValue(xa.range[0]);
        hi = this._coerceAxisValue(xa.range[1]);
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        const span = Math.abs(hi - lo);
        if (span > 0) pxPerUnit = xa._length / span;
    }

    // Clip to the visible range BEFORE coalescing/capping. Otherwise coalescing
    // spans off-screen gaps and the "widest N" guard is chosen globally — so a
    // gap right in front of the user (narrow, but the only one on screen) gets
    // dropped, while zoomed out the merges land on off-screen structure. Bands
    // must line up with the discontinuities actually visible in the trace.
    const clipped = [];
    for (const it of items) {
        if (it.t1 < lo || it.t0 > hi) continue;
        const t0 = it.t0 < lo ? lo : it.t0;
        const t1 = it.t1 > hi ? hi : it.t1;
        clipped.push(t0 === it.t0 && t1 === it.t1 ? it : { fileId: it.fileId, timeVar: it.timeVar, t0, t1 });
    }
    if (!clipped.length) return [];

    // Dense (see _missingViewIsDense): individual bands are meaningless — they
    // merge into a wall that buries the signal (SVG shapes sit over a WebGL
    // trace regardless of layer:'below'). The caller also skips per-gap line
    // breaks in this case, so the clean signal envelope stays visible.
    const dense = denseOverride === null ? this._missingViewIsDense(plot, items) : !!denseOverride;
    plot._missingTooDense = dense;

    // Coalesce at pixel resolution, so dense missing data never floods Plotly.
    // If it is STILL pathologically fragmented (sub-2px alternation), keep only
    // the widest merged bands as a final guard.
    const merged = this._coalesceGapItems(clipped, pxPerUnit);
    const list = merged.length > MAX_BANDS
        ? merged.slice().sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0)).slice(0, MAX_BANDS)
        : merged;

    // A dense view still gets a faint wash that reveals WHICH regions hold
    // missing data (and which are clean) — genuinely useful, e.g. region-based
    // gaps. The one exception (timeseries only): if the wash would cover almost
    // the entire view it is a uniform wall carrying no information and only
    // tinting the signal, so suppress it and let the "zoom in" pill speak. The
    // FFT pane has no pill, so it always keeps the wash.
    if (dense && plot.mode === 'timeseries') {
        const span = hi - lo;
        const covered = list.reduce((sum, it) => sum + (it.t1 - it.t0), 0);
        if (!(span > 0) || covered / span >= 0.9) return [];
    }

    const shapes = [];
    for (const it of list) {
        const widthPx = Number.isFinite(pxPerUnit) ? (it.t1 - it.t0) * pxPerUnit : 0;
        // Dense: a faint wash that keeps the signal readable (no stroke).
        // Sparse: fill fades strong(narrow)→soft(wide); narrow gaps get a stroke.
        const fillT = Math.max(0, Math.min(1, (widthPx - 3) / (30 - 3)));
        const denseAlpha = this.theme === 'dark' ? 0.14 : 0.18;
        const fillAlpha = dense ? denseAlpha : 0.8 + (0.28 - 0.8) * fillT;
        const strokeWidth = dense ? 0 : Math.max(0, 2 - widthPx / 1.5);
        shapes.push({
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0: this._plotlyTimeValue(it.fileId, it.t0, it.timeVar),
            x1: this._plotlyTimeValue(it.fileId, it.t1, it.timeVar),
            y0: 0,
            y1: 1,
            fillcolor: this._gapBandFill(fillAlpha),
            line: strokeWidth > 0
                ? { color: this._gapBandStroke(), width: strokeWidth }
                : { width: 0 },
            layer: 'below',
        });
    }
    return shapes;
};

// The time pane draws missing-data bands beneath the Selection rectangle:
// sampling gaps (missing timestamps) AND NaN-value runs. NaN values don't
// break time uniformity, so they don't reach the "not uniform" gap warning,
// but they still block a clean FFT — the fftWarningNaN message tells the user
// to pick a NaN-free span, so the bands must show where those NaN are.
proto._fftTimePaneShapes = function(plot) {
    // _prepareFftAutoRange already verified that the automatically selected
    // span is finite, increasing and uniformly sampled. Running the decorative
    // missing-data detector here would scan (and sort deltas for) the complete
    // multi-GB source again, even though only this small span is displayed.
    // Per-trace FFT validation still reports NaN/non-uniform secondary traces.
    if (this._fftShouldSkipGlobalGapScan(plot)) {
        return this._fftSelectionShapes(plot);
    }
    // Lazy (view-mode) files can't be scanned in JS; their bands come from the
    // DuckDB bucket query cached on the plot by _refreshLazyMissingBands. Eager
    // files use the in-memory detection. Selection rectangle always on top.
    const lazy = (plot?.traces || []).some(t => this.files.get(t.fileId)?.data?._duckdb?.viewMode);
    const missing = lazy ? this._lazyMissingShapes(plot) : this._missingDataBandShapes(plot);
    return [...missing, ...this._fftSelectionShapes(plot)];
};

// (B) Break the plotted line across each missing-data interval so the pane
// never connects two points with a straight segment that pretends data exists
// in between. The break is inserted into the (possibly downsampled) trace by
// matching the numeric source x carried on __srcX against `intervals` (sorted
// ascending by t0). Used for FFT sampling gaps and timeseries gaps + NaN runs.
proto._applyLineBreaks = function(trace, intervals) {
    const srcX = trace.__srcX;
    delete trace.__srcX;
    if (!intervals?.length || !srcX?.length) return;
    const y = trace.y;
    const x = trace.x;
    const custom = Array.isArray(trace.customdata) ? trace.customdata : null;
    const nPts = Math.min(srcX.length, y.length);
    const outX = [];
    const outY = [];
    const outCustom = custom ? [] : null;
    let gi = 0;
    let broke = false;
    for (let i = 0; i < nPts; i++) {
        outX.push(x[i]);
        outY.push(y[i]);
        if (outCustom) outCustom.push(custom[i]);
        if (i + 1 >= nPts) continue;
        const a = srcX[i];
        const b = srcX[i + 1];
        while (gi < intervals.length && intervals[gi].t0 < a - 1e-6) gi++;
        if (gi < intervals.length && intervals[gi].t1 <= b + 1e-6) {
            // A NaN y-value with a duplicated x breaks the connecting segment.
            outX.push(x[i]);
            outY.push(NaN);
            if (outCustom) outCustom.push(null);
            broke = true;
        }
    }
    trace.x = outX;
    trace.y = outY;
    if (outCustom) trace.customdata = outCustom;
    // WebGL scatter does not render NaN gaps reliably; the panes are capped at
    // ~2000 plotted points, so SVG scatter is cheap and shows breaks correctly.
    if (broke && trace.type === 'scattergl') trace.type = 'scatter';
};

// ── Missing-data bands (sampling gaps + NaN runs) ──
// Shared by the FFT time pane (always on) and the timeseries "show missing
// data" overlay (opt-in). The per-trace break-interval map (traceIntervals)
// is only consumed by the timeseries overlay's line-cutting.
// Trace identity for the per-trace break-interval map.
// Sampling-gap and NaN-run detection read the in-memory time/value arrays. For
// a lazy file in view mode those are a RESERVOIR SAMPLE of the rows: the times
// are irregularly spaced by construction and the sampled NaNs are sparse, so
// detectSamplingGaps / detectNaNRuns would fabricate gaps and bands that don't
// exist (a clean uniform signal ends up flagged everywhere). Only trust a
// full-resolution, non-sampled series; truthful gap detection over a lazy file
// would need a dedicated DuckDB scan (future work), not the overview sample.
proto._hasTruthfulGapSeries = function(fileId) {
    return !this.files.get(fileId)?.data?._duckdb?.viewMode;
};

proto._missTraceKey = function(t) {
    return `${t.fileId}\u0000${t.varName}`;
};

// Union of time gaps (per file) and NaN runs (per visible trace), memoized by
// a cheap signature. In FFT mode it runs on the same in-memory / overview
// arrays the time pane already builds; in timeseries mode it is behind the
// opt-in flag so large files pay nothing by default. Either way it is one
// cached O(n) pass — recomputed only when the signature changes.
proto._missingDataInfo = function(plot) {
    const visible = (plot?.traces || []).filter(t => this._isVisible(t));
    const sig = visible.map(t => {
        const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
        const n = times?.length || 0;
        return `${t.fileId}\u0000${t.varName}:${n}:${n ? times[0] : ''}:${n ? times[n - 1] : ''}`;
    }).join('|');
    if (plot._missSig === sig && plot._missCache) return plot._missCache;

    const fileGaps = new Map();       // fileId -> { timeVar, gaps: [{t0,t1}] }
    const traceIntervals = new Map(); // missTraceKey -> sorted [{t0,t1}]
    const bandItems = [];
    // Files whose time vector has no nominal step (irregular or out of order).
    // Their `gaps` come back empty by construction; the reason travels with them
    // so the overlay can say WHY no sampling gaps are marked instead of letting
    // the user read the absence of bands as "nothing is missing".
    const stepIssues = [];
    for (const t of visible) {
        // A reservoir-sampled overview has no truthful time spacing or NaN runs.
        if (!this._hasTruthfulGapSeries(t.fileId)) continue;
        if (!fileGaps.has(t.fileId)) {
            const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
            const timeVar = this._getTimeVar(t.fileId);
            const info = detectSamplingGaps(times);
            const gaps = info.gaps.map(g => ({ t0: g.t0, t1: g.t1 }));
            fileGaps.set(t.fileId, { timeVar, gaps });
            if (!info.hasNominalStep && info.reason && info.reason !== 'tooFewSamples') {
                stepIssues.push({
                    fileId: t.fileId,
                    reason: info.reason,
                    stepAgreement: info.stepAgreement,
                });
            }
            for (const g of gaps) bandItems.push({ fileId: t.fileId, timeVar, t0: g.t0, t1: g.t1 });
        }
        const entry = fileGaps.get(t.fileId);
        const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
        const values = this._getTransformedVariableData(t.fileId, t.varName);
        const nanRuns = detectNaNRuns(times, values);
        for (const r of nanRuns) bandItems.push({ fileId: t.fileId, timeVar: entry.timeVar, t0: r.t0, t1: r.t1 });
        const merged = [...entry.gaps, ...nanRuns.map(r => ({ t0: r.t0, t1: r.t1 }))]
            .sort((p, q) => p.t0 - q.t0);
        traceIntervals.set(this._missTraceKey(t), merged);
    }
    const result = { fileGaps, traceIntervals, bandItems, stepIssues };
    plot._missSig = sig;
    plot._missCache = result;
    return result;
};

// The notice to show instead of the "zoom in" hint when a visible file has no
// nominal step. Out-of-order timestamps outrank an irregular step: they are the
// more fundamental defect, and fixing them may well make the step regular.
proto._missingStepNotice = function(stepIssues) {
    if (!stepIssues?.length) return null;
    const unsorted = stepIssues.find(issue => issue.reason === 'nonMonotonic');
    if (unsorted) return { mode: 'unsorted', label: i18n.t('timeseriesMissingUnsorted') };
    const irregular = stepIssues.find(issue => issue.reason === 'irregularStep');
    if (!irregular) return null;
    const percent = Number.isFinite(irregular.stepAgreement)
        ? Math.round(irregular.stepAgreement * 100)
        : 0;
    return {
        mode: 'irregular',
        label: i18n.t('timeseriesMissingIrregular').replace('{percent}', String(percent)),
    };
};

proto._missingDataBandShapes = function(plot) {
    return this._adaptiveGapBandShapes(plot, this._missingDataInfo(plot).bandItems);
};

// (C) Does a band overlap the span the spectrum was built from? The gaps are
// detected over the WHOLE file, so this is what connects a band on screen to
// the range actually analyzed. What to SAY about it depends on whether the
// spectrum came out, which the caller knows and this does not.
proto._fftGapsOverlapAnalyzedRange = function(plot) {
    // The automatic span passed the strict uniformity check before it was
    // selected. Avoid a redundant full-file gap scan after the spectrum has
    // completed; on a one-hour decoded audio signal that scan dominates FFT.
    if (this._fftShouldSkipGlobalGapScan(plot)) return false;
    const info = this._fftGapInfo(plot);
    if (!info.count) return false;
    const [lo, hi] = this._activeFftRange(plot);
    for (const file of info.perFile) {
        for (const gap of file.gaps) {
            if (gap.t1 > lo && gap.t0 < hi) return true;
        }
    }
    return false;
};

// The note for a span that produced a spectrum despite carrying bands.
//
// Reaching here means the span passed the uniformity gate, and that gate is
// strict: a single dropped sample doubles one interval, which is a 100% error
// against a 0.1% tolerance, and a non-finite value is refused outright. So a
// computed spectrum is proof that nothing is missing RELATIVE TO THIS SPAN'S OWN
// step — the bands come from comparing the file against its own median, not
// from anything wrong inside the analyzed range.
//
// What the note must not do is guess why the spacing differs. A recorder
// switched to a slower rate and a recorder that lost nine of every ten samples
// produce identical data; neither this code nor anything else can separate them.
// So it states the spacing differs, and stops there.
proto._fftUniformSpanNote = function(spanSeconds) {
    return Number.isFinite(spanSeconds) && spanSeconds > 0
        ? i18n.t('fftGapsUniformSpan').replace('{dt}', formatNaturalDuration(spanSeconds))
        : i18n.t('fftGapsUniformSpanNoStep');
};

proto._fftSelectionShapes = function(plot) {
    if (this._ensureFftState(plot).rangeFull) return [];
    const [lo, hi] = this._activeFftRange(plot);
    const firstTrace = plot.traces?.[0];
    const timeVar = firstTrace ? this._getTimeVar(firstTrace.fileId) : null;
    const x0 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, lo, timeVar) : lo;
    const x1 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, hi, timeVar) : hi;
    // Green selection so it never reads as the amber Missing/NaN wash.
    const color = '#43a047';
    return [
        {
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0,
            x1,
            y0: 0,
            y1: 1,
            fillcolor: 'rgba(67, 160, 71, 0.14)',
            line: { width: 0 },
            layer: 'below',
        },
        { type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color, width: 2 } },
        { type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color, width: 2 } },
    ];
};

proto._updateFftSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || plot.mode !== 'fft') return;
    Plotly.relayout(plot.div, { shapes: this._fftTimePaneShapes(plot) });
    this._syncFftOptionsPanel(plot);
};

proto._dismissFftAutoRangeWarning = function(plot) {
    const state = this._ensureFftState(plot);
    // Any range gesture transfers ownership to the user. Subsequent preflights
    // may still reject a true hard-memory overflow, but must never silently
    // restore the initial fast block.
    state.autoRangeLimited = false;
    const warning = state.autoRangeWarning;
    if (!warning) return false;
    state.autoRangeWarning = null;
    if (Array.isArray(state.warnings)) {
        state.warnings = state.warnings.filter(message => message !== warning);
    }
    // The user has taken ownership of the range; remove the explanatory
    // warning immediately rather than leaving it visible until recompute ends.
    if (plot._fftStatusType === 'warning' && String(plot._fftStatusMessage || '').includes(warning)) {
        this._setFftStatus(plot, '', 'muted');
    } else {
        this._syncFftOptionsPanel(plot);
    }
    return true;
};

// The windowed overlay is cut to the analyzed range, so it must be rebuilt
// whenever the selection changes (drag end, inputs, sliders).
proto._refreshFftWindowedOverlayIfNeeded = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot || plot.mode !== 'fft') return;
    if (!this._ensureFftState(plot).showWindowed) return;
    this._refreshFftTimePlot(panelId, plot, { preserveView: true });
};

proto._installFftSelectionHandlers = function(panelId, plot) {
    if (!plot?.div || plot._fftSelectionDiv === plot.div) return;
    plot._fftSelectionDiv = plot.div;
    let dragging = null;
    const hitTest = (event) => {
        if (this._ensureFftState(plot).rangeFull) return null;
        if (!this._eventInsidePlotArea(plot.div, event)) return null;
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x)) return null;
        const domain = this._fftDomain(plot);
        if (!domain) return null;
        const [lo, hi] = this._activeFftRange(plot);
        const xa = plot.div._fullLayout?.xaxis;
        const span = Math.abs(this._coerceAxisValue(xa?.range?.[1]) - this._coerceAxisValue(xa?.range?.[0])) || Math.abs(hi - lo) || 1;
        const tolerance = Math.max((12 / (xa?._length || 1)) * span, span * 1e-6);
        const nearLeft = Math.abs(x - lo) <= tolerance;
        const nearRight = Math.abs(x - hi) <= tolerance;
        if (nearLeft || nearRight) return nearLeft ? 'left' : 'right';
        const domainSpan = Math.abs(domain.max - domain.min) || 1;
        if (x >= lo && x <= hi && Math.abs(hi - lo) < domainSpan - tolerance) return 'move';
        return null;
    };
    // Plotly's drag layer pins its own cursor (crosshair), so a plain
    // style.cursor on the container never shows: toggle classes that
    // override the drag-layer cursor from CSS instead.
    const setCursorHint = (hit) => {
        plot.div.classList.toggle('fft-cursor-ew', hit === 'left' || hit === 'right');
        plot.div.classList.toggle('fft-cursor-grab', hit === 'move');
    };
    plot.div.addEventListener('mousemove', event => {
        if (dragging) return;
        setCursorHint(hitTest(event));
    });
    plot.div.addEventListener('mouseleave', () => {
        if (!dragging && plot.div) setCursorHint(null);
    });
    plot.div.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        const hit = hitTest(event);
        if (!hit) return;
        const x = this._eventToXValue(plot.div, event);
        const [lo, hi] = this._activeFftRange(plot);
        dragging = { hit, startX: x, startLo: lo, startHi: hi };
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        document.body.classList.add('fft-selection-dragging');
        document.body.classList.toggle('fft-selection-moving', hit === 'move');
    }, true);
    const onMove = event => {
        if (!dragging || !plot.div) return;
        const domain = this._fftDomain(plot);
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x) || !domain) return;
        const state = this._ensureFftState(plot);
        let lo = dragging.startLo;
        let hi = dragging.startHi;
        if (dragging.hit === 'left') lo = x;
        else if (dragging.hit === 'right') hi = x;
        else {
            const width = dragging.startHi - dragging.startLo;
            let delta = x - dragging.startX;
            if (dragging.startLo + delta < domain.min) delta = domain.min - dragging.startLo;
            if (dragging.startHi + delta > domain.max) delta = domain.max - dragging.startHi;
            lo = dragging.startLo + delta;
            hi = dragging.startHi + delta;
        }
        if (lo > hi) [lo, hi] = [hi, lo];
        this._dismissFftAutoRangeWarning(plot);
        state.x1 = Math.max(domain.min, Math.min(domain.max, lo));
        state.x2 = Math.max(domain.min, Math.min(domain.max, hi));
        this._updateFftSelectionShapes(panelId, plot);
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('fft-selection-dragging');
        document.body.classList.remove('fft-selection-moving');
        if (plot.div) setCursorHint(null);
        this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
        this._scheduleFftRecompute(panelId);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._fftSelectionDocListeners = { move: onMove, up: onUp };
};

proto._installFftSplitterHandlers = function(panelId, plot) {
    const splitter = plot?.fftContainer?.querySelector('.fft-splitter');
    if (!splitter || splitter._fftBound) return;
    splitter._fftBound = true;
    let dragging = false;
    const apply = (event) => {
        if (!plot.fftContainer) return;
        const state = this._ensureFftState(plot);
        const area = plot.fftContainer.querySelector('.fft-plot-area');
        const rect = area?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const fraction = state.layout === 'vertical'
            ? (event.clientY - rect.top) / rect.height
            : (event.clientX - rect.left) / rect.width;
        state.split = Math.max(0.2, Math.min(0.8, fraction));
        plot.fftContainer.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);
        Plotly.Plots.resize(plot.div);
        Plotly.Plots.resize(plot.fftDiv);
    };
    splitter.addEventListener('mousedown', event => {
        dragging = true;
        event.preventDefault();
        document.body.classList.add('fft-split-dragging');
    });
    const onMove = event => {
        if (dragging) apply(event);
    };
    const onUp = () => {
        dragging = false;
        document.body.classList.remove('fft-split-dragging');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._fftSplitterDocListeners = { move: onMove, up: onUp };
    void panelId;
};

proto._renderFftOptionsPanel = function(panelId, plot) {
    const state = this._ensureFftState(plot);
    const options = plot?.fftContainer?.querySelector('.fft-options');
    if (!options) return;
    const domain = this._fftDomain(plot);
    const fmt = value => Number.isFinite(Number(value)) ? String(Number(Number(value).toPrecision(12))) : '';
    const makeRow = (labelText, control, tooltip = '') => {
        const label = document.createElement('label');
        label.className = 'fft-option-row';
        if (tooltip) label.title = tooltip;
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, control);
        return label;
    };
    const makeInput = (key, className = '') => {
        const isAxisLimit = FFT_AXIS_LIMIT_KEYS.has(key);
        // Datetime axes store x1/x2 as epoch ms: show a date-time picker
        // instead of a meaningless 13-digit number.
        const isCalendarRange = (key === 'x1' || key === 'x2') && this._fftUsesCalendarTime(plot);
        const input = document.createElement('input');
        input.type = isCalendarRange ? 'datetime-local' : 'number';
        input.step = isCalendarRange ? '1' : 'any';
        input.className = `fft-number-input ${className}`.trim();
        input.value = isCalendarRange
            ? fftMsToDatetimeInput(state[key])
            : formatFftInputValue(isAxisLimit ? this._fftAxisLimitDisplayValue(plot, key) : state[key]);
        input.dataset.fftKey = key;
        if (isAxisLimit) input.dataset.fftAxisLimit = 'true';
        if (key === 'x1' || key === 'x2') input.disabled = !!state.rangeFull;
        input.addEventListener('change', () => {
            const state = this._ensureFftState(plot);
            const n = isCalendarRange ? fftDatetimeInputToMs(input.value) : Number(input.value);
            if (key === 'x1' || key === 'x2') this._dismissFftAutoRangeWarning(plot);
            state[key] = Number.isFinite(n) ? n : null;
            if (FFT_AXIS_LIMIT_KEYS.has(key)) {
                this._applyFftAxisLimits(plot);
            } else {
                this._ensureFftRange(plot);
                this._updateFftSelectionShapes(panelId, plot);
                this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
                this._scheduleFftRecompute(panelId);
            }
            this._syncFftOptionsPanel(plot);
        });
        return input;
    };
    const makeRange = (key) => {
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'fft-range-input';
        input.dataset.fftKey = key;
        if (domain) {
            input.min = String(domain.min);
            input.max = String(domain.max);
            input.step = 'any';
        }
        input.value = fmt(state[key]);
        input.disabled = !!state.rangeFull;
        input.addEventListener('input', () => {
            const state = this._ensureFftState(plot);
            const n = Number(input.value);
            this._dismissFftAutoRangeWarning(plot);
            state[key] = Number.isFinite(n) ? n : null;
            this._syncFftOptionsPanel(plot, { skipRangeSliders: true });
            this._updateFftSelectionShapes(panelId, plot);
        });
        input.addEventListener('change', () => {
            this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
            this._scheduleFftRecompute(panelId);
        });
        return input;
    };
    const makeAxisLimitRange = (key) => {
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'fft-range-input fft-axis-limit-slider';
        input.dataset.fftKey = key;
        input.dataset.fftAxisLimit = 'true';
        this._configureFftAxisLimitSlider(input, plot, key);
        input.addEventListener('input', () => {
            const state = this._ensureFftState(plot);
            const n = Number(input.value);
            state[key] = Number.isFinite(n) ? n : null;
            this._applyFftAxisLimits(plot);
            this._syncFftOptionsPanel(plot);
        });
        return input;
    };
    const makeSelect = (key, optionsList) => {
        const select = document.createElement('select');
        select.className = 'fft-select';
        select.dataset.fftKey = key;
        for (const item of optionsList) {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            select.appendChild(option);
        }
        select.value = state[key];
        select.addEventListener('change', () => {
            const state = this._ensureFftState(plot);
            const previous = state[key];
            state[key] = select.value;
            if (key === 'windowType') state[key] = normalizeFftWindow(state[key]);
            if (key === 'amplitudeScale') state[key] = normalizeFftScale(state[key]);
            if (key === 'zeroPaddingFactor') state[key] = normalizeZeroPaddingFactor(state[key]);
            const scaleChanged = key === 'amplitudeScale' && state[key] !== previous;
            if (scaleChanged) {
                state.yMin = null;
                state.yMax = null;
                this._renderFftOptionsPanel(panelId, plot);
            }
            // Only the windowed overlay lives on the time plot; every other
            // option must leave the time traces (view + resolution) alone.
            if (key === 'windowType' && state.showWindowed) {
                this._refreshFftTimePlot(panelId, plot, { preserveView: true, preserveY: false });
            }
            // A scale change swaps the Y units (linear <-> dB): a preserved
            // Y zoom would be meaningless.
            this._scheduleFftRecompute(panelId, scaleChanged ? { preserveSpectrumY: false } : {});
        });
        return select;
    };
    const makeToggle = (key) => {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'fft-checkbox';
        input.checked = !!state[key];
        input.dataset.fftKey = key;
        input.addEventListener('change', () => {
            const state = this._ensureFftState(plot);
            state[key] = !!input.checked;
            if (key === 'showWindowed') {
                this._refreshFftTimePlot(panelId, plot, { preserveView: true, preserveY: !state.showWindowed });
            } else if (key === 'removeMean' && state.showWindowed) {
                this._refreshFftTimePlot(panelId, plot, { preserveView: true });
            }
            this._scheduleFftRecompute(panelId);
        });
        return input;
    };

    options.innerHTML = '';
    const message = document.createElement('div');
    message.className = 'fft-message';
    message.hidden = true;
    options.appendChild(message);

    const segmented = document.createElement('div');
    segmented.className = 'fft-segmented';
    const makeSegment = (labelKey, tooltipKey, isFull) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = i18n.t(labelKey);
        btn.title = i18n.t(tooltipKey);
        btn.dataset.fftRangeFull = String(isFull);
        btn.classList.toggle('active', !!state.rangeFull === isFull);
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            const state = this._ensureFftState(plot);
            if (!!state.rangeFull === isFull) return;
            this._dismissFftAutoRangeWarning(plot);
            state.rangeFull = isFull;
            state.autoRangeLimited = false;
            if (!isFull) {
                // The selection starts as the currently visible time span.
                const domain = this._fftDomain(plot);
                const xa = plot.div?._fullLayout?.xaxis;
                let lo = this._coerceAxisValue(xa?.range?.[0]);
                let hi = this._coerceAxisValue(xa?.range?.[1]);
                if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
                    lo = domain?.min;
                    hi = domain?.max;
                }
                if (Number.isFinite(lo) && Number.isFinite(hi)) {
                    if (lo > hi) [lo, hi] = [hi, lo];
                    if (domain) {
                        lo = Math.max(domain.min, Math.min(domain.max, lo));
                        hi = Math.max(domain.min, Math.min(domain.max, hi));
                    }
                    state.x1 = lo;
                    state.x2 = hi;
                }
                this._ensureFftRange(plot);
            }
            this._updateFftSelectionShapes(panelId, plot);
            this._refreshFftWindowedOverlayIfNeeded(panelId, plot);
            this._scheduleFftRecompute(panelId);
            this._syncFftOptionsPanel(plot);
        });
        return btn;
    };
    segmented.append(
        makeSegment('fftRangeFull', 'analysisRangeFullTooltip', true),
        makeSegment('fftRangeSelection', 'analysisRangeSelectionTooltip', false),
    );
    options.appendChild(makeRow(i18n.t('fftRange'), segmented));

    const rangeGrid = document.createElement('div');
    rangeGrid.className = 'fft-range-grid';
    const makeBound = (labelText, key, tooltip) => {
        const wrap = document.createElement('div');
        wrap.className = 'fft-range-bound';
        if (this._fftUsesCalendarTime(plot)) wrap.classList.add('fft-range-bound-datetime');
        const slider = makeRange(key);
        slider.title = tooltip;
        wrap.append(makeRow(labelText, makeInput(key), tooltip), slider);
        return wrap;
    };
    rangeGrid.append(
        makeBound(i18n.t('fftRangeStart'), 'x1', i18n.t('analysisRangeStartTooltip')),
        makeBound(i18n.t('fftRangeEnd'), 'x2', i18n.t('analysisRangeEndTooltip')),
    );
    options.appendChild(rangeGrid);

    options.appendChild(makeRow(i18n.t('fftWindow'), makeSelect('windowType', [
        { value: 'none', label: i18n.t('fftWindowNone') },
        { value: 'hann', label: 'Hann' },
        { value: 'hamming', label: 'Hamming' },
        { value: 'blackman', label: 'Blackman' },
        { value: 'flattop', label: 'Flat top' },
    ]), i18n.t('fftWindowTooltip')));
    options.appendChild(makeRow(i18n.t('fftShowWindowed'), makeToggle('showWindowed'), i18n.t('fftShowWindowedTooltip')));
    options.appendChild(makeRow(i18n.t('fftRemoveMean'), makeToggle('removeMean'), i18n.t('fftRemoveMeanTooltip')));

    const zeroPaddingWrap = document.createElement('div');
    zeroPaddingWrap.className = 'fft-control-help';
    const zeroPaddingHelpBtn = document.createElement('button');
    zeroPaddingHelpBtn.type = 'button';
    zeroPaddingHelpBtn.className = 'fft-help-btn';
    zeroPaddingHelpBtn.textContent = '?';
    zeroPaddingHelpBtn.title = i18n.t('fftZeroPaddingTooltip');
    zeroPaddingHelpBtn.setAttribute('aria-expanded', 'false');
    const zeroPaddingPopover = document.createElement('div');
    zeroPaddingPopover.className = 'fft-help-popover';
    zeroPaddingPopover.hidden = true;
    zeroPaddingPopover.textContent = i18n.t('fftZeroPaddingHelp');
    zeroPaddingHelpBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const show = zeroPaddingPopover.hidden;
        zeroPaddingPopover.hidden = !show;
        zeroPaddingHelpBtn.setAttribute('aria-expanded', String(show));
    });
    zeroPaddingWrap.append(makeSelect('zeroPaddingFactor', [
        { value: '1', label: 'x1' },
        { value: '2', label: 'x2' },
        { value: '4', label: 'x4' },
        { value: '8', label: 'x8' },
        { value: '16', label: 'x16' },
    ]), zeroPaddingHelpBtn);
    options.appendChild(makeRow(i18n.t('fftZeroPadding'), zeroPaddingWrap, i18n.t('fftZeroPaddingTooltip')));
    options.appendChild(zeroPaddingPopover);
    this._installFftHelpDismissHandlers(plot);

    options.appendChild(makeRow(i18n.t('fftAmplitudeScale'), makeSelect('amplitudeScale', [
        { value: 'normal', label: i18n.t('fftScaleNormal') },
        { value: 'db', label: 'dB' },
        { value: 'dbRelative', label: i18n.t('fftScaleDbRelative') },
    ]), i18n.t('fftAmplitudeScaleTooltip')));

    const axesTitle = document.createElement('div');
    axesTitle.className = 'fft-options-subtitle';
    axesTitle.textContent = i18n.t('fftAxisLimits');
    options.appendChild(axesTitle);
    const axisGrid = document.createElement('div');
    axisGrid.className = 'fft-axis-grid';
    const makeAxisBound = (key) => {
        const wrap = document.createElement('div');
        wrap.className = 'fft-axis-bound';
        const tooltip = this._fftAxisLimitTooltip(key);
        wrap.append(makeRow(this._fftAxisLimitLabel(plot, key), makeInput(key), tooltip), makeAxisLimitRange(key));
        return wrap;
    };
    axisGrid.append(
        makeAxisBound('fMin'),
        makeAxisBound('fMax'),
        makeAxisBound('yMin'),
        makeAxisBound('yMax'),
    );
    options.appendChild(axisGrid);

    const autoAmplitudeBtn = document.createElement('button');
    autoAmplitudeBtn.type = 'button';
    autoAmplitudeBtn.className = 'fft-auto-amplitude-btn';
    autoAmplitudeBtn.textContent = i18n.t('fftAutoAmplitude');
    autoAmplitudeBtn.title = i18n.t('fftAutoAmplitudeTooltip');
    autoAmplitudeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        const state = this._ensureFftState(plot);
        state.yMin = null;
        state.yMax = null;
        // Only the amplitude axis: leave any manual frequency zoom alone.
        if (plot.fftDiv) Plotly.relayout(plot.fftDiv, { 'yaxis.autorange': true });
        this._syncFftOptionsPanel(plot);
    });
    options.appendChild(autoAmplitudeBtn);

    const autoXRangeBtn = document.createElement('button');
    autoXRangeBtn.type = 'button';
    autoXRangeBtn.className = 'fft-auto-xrange-btn';
    autoXRangeBtn.textContent = i18n.t('fftAutoXRange');
    autoXRangeBtn.title = i18n.t('fftAutoXRangeTooltip');
    autoXRangeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        const state = this._ensureFftState(plot);
        state.fMin = null;
        state.fMax = null;
        // Reset to the FULL frequency span. The drawn trace is windowed, so
        // Plotly autorange would only fit the visible slice — use the full
        // extent explicitly (the relayout then re-windows back to full).
        if (plot.fftDiv) {
            const ext = this._fftSpectrumExtent(plot, 'x');
            if (ext && Number.isFinite(ext.min) && Number.isFinite(ext.max) && ext.min !== ext.max) {
                Plotly.relayout(plot.fftDiv, { 'xaxis.range': [ext.min, ext.max], 'xaxis.autorange': false });
            } else {
                Plotly.relayout(plot.fftDiv, { 'xaxis.autorange': true });
            }
        }
        this._syncFftOptionsPanel(plot);
    });
    options.appendChild(autoXRangeBtn);
};

proto._installFftHelpDismissHandlers = function(plot) {
    if (!plot || plot._fftHelpDocListeners) return;
    const closeHelp = () => {
        const popover = plot.fftContainer?.querySelector('.fft-help-popover');
        if (!popover || popover.hidden) return false;
        popover.hidden = true;
        plot.fftContainer?.querySelector('.fft-help-btn')?.setAttribute('aria-expanded', 'false');
        return true;
    };
    const onClick = (event) => {
        if (event.target.closest?.('.fft-help-btn') || event.target.closest?.('.fft-help-popover')) return;
        closeHelp();
    };
    const onKey = (event) => {
        if (event.key === 'Escape') closeHelp();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    plot._fftHelpDocListeners = { click: onClick, key: onKey };
};

proto._fftAxisLimitTooltip = function(key) {
    if (key === 'fMin') return i18n.t('fftFMinTooltip');
    if (key === 'fMax') return i18n.t('fftFMaxTooltip');
    if (key === 'yMin') return i18n.t('fftYMinTooltip');
    if (key === 'yMax') return i18n.t('fftYMaxTooltip');
    return '';
};

proto._syncFftOptionsPanel = function(plot, options = {}) {
    const state = this._ensureFftState(plot);
    const panel = plot?.fftContainer?.querySelector('.fft-options');
    if (!panel) return;
    const fmt = value => Number.isFinite(Number(value)) ? String(Number(Number(value).toPrecision(12))) : '';
    panel.querySelectorAll('[data-fft-range-full]').forEach(btn => {
        btn.classList.toggle('active', String(!!state.rangeFull) === btn.dataset.fftRangeFull);
    });
    panel.querySelectorAll('[data-fft-key]').forEach(input => {
        const key = input.dataset.fftKey;
        if (!key || !(key in state)) return;
        if (key === 'x1' || key === 'x2') input.disabled = !!state.rangeFull;
        const isAxisLimit = input.dataset.fftAxisLimit === 'true';
        if (input.type === 'checkbox') input.checked = !!state[key];
        else if (input.tagName?.toLowerCase() === 'select') input.value = String(state[key]);
        else if (input.type === 'range') {
            if (isAxisLimit) this._configureFftAxisLimitSlider(input, plot, key);
            else if (!options.skipRangeSliders) input.value = fmt(state[key]);
        } else if (isAxisLimit) {
            input.value = formatFftInputValue(this._fftAxisLimitDisplayValue(plot, key));
        } else if (input.type === 'datetime-local') {
            input.value = fftMsToDatetimeInput(state[key]);
        } else input.value = formatFftInputValue(state[key]);
    });
    this._syncFftMessage(plot);
};

// A prominent, non-blocking "computing" pill centered over the spectrum pane.
// Unlike the small topbar status text, it reads at a glance, and because it is
// pointer-events:none and the spectrum is only replaced at the final
// Plotly.react, the user can keep panning/zooming the spectrum already shown
// while a new range recomputes. Reuses the lazy-detail indicator styling.
proto._setFftComputing = function(plot, loading) {
    const pane = plot?.fftDiv?.parentElement; // .fft-spectrum-pane
    if (!pane) return;
    let pill = pane.querySelector('.fft-computing-indicator');
    if (loading) {
        if (!pill) {
            pill = document.createElement('div');
            pill.className = 'lazy-detail-indicator fft-computing-indicator';
            pill.setAttribute('aria-live', 'polite');
            pill.innerHTML = '<span class="lazy-detail-spinner" aria-hidden="true"></span><span class="lazy-detail-text"></span>';
            pane.appendChild(pill);
        }
        const label = i18n.t('fftCalculating');
        const text = pill.querySelector('.lazy-detail-text');
        if (text) text.textContent = label;
        pill.setAttribute('aria-label', label);
        pill.classList.add('active');
    } else if (pill) {
        pill.classList.remove('active');
        pill.remove();
    }
};

proto._setFftStatus = function(plot, message, type = 'muted') {
    const el = plot?.fftContainer?.querySelector('.fft-status');
    if (el) {
        // Warnings show in full only in the side panel; the topbar just
        // points there (the panel may be hidden). The tooltip keeps the
        // full text either way.
        el.textContent = (type === 'warning' && message)
            ? i18n.t('fftWarningSeePanel')
            : (message || '');
        el.className = `fft-status fft-status-${type}`;
        el.title = message || '';
    }
    plot._fftStatusMessage = message || '';
    plot._fftStatusType = type;
    this._syncFftMessage(plot);
};

proto._syncFftMessage = function(plot) {
    const box = plot?.fftContainer?.querySelector('.fft-message');
    if (!box) return;
    const message = plot._fftStatusMessage || '';
    const type = plot._fftStatusType || 'muted';
    const show = !!message && (type === 'warning' || type === 'loading');
    box.hidden = !show;
    box.textContent = show ? message : '';
    box.className = `fft-message fft-message-${type}`;
};

// The last (range, zero padding) combination the platform actually accepted.
// Recorded only after a spectrum came out, so it is always a setting known to
// fit — which is what makes it safe to fall back to.
proto._rememberAcceptedFftSettings = function(plot) {
    const state = this._ensureFftState(plot);
    plot._fftLastAccepted = {
        rangeFull: !!state.rangeFull,
        x1: state.x1,
        x2: state.x2,
        zeroPaddingFactor: normalizeZeroPaddingFactor(state.zeroPaddingFactor),
    };
};

// The largest selection the platform will actually transform at the padding
// the user has chosen, anchored where their selection starts.
//
// This is what a refused range should land on. Falling back to the last
// ACCEPTED range instead answers a different question: on a ten-minute 44.1 kHz
// recording, asking for the whole file was refused and handed back the initial
// 262,144-sample preview — 1% of the signal — while the real ceiling allows
// 16,777,216 samples, 63% of it. The message then reads "narrow the selection"
// to someone who is nowhere near the limit, and who can indeed widen it by
// hand, which is how this was found.
proto._largestFittingFftRange = function(plot, state = this._ensureFftState(plot)) {
    const trace = (plot?.traces || []).find(item => this._isVisible(item));
    if (!trace) return null;
    const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
    const total = times?.length || 0;
    if (total < 2) return null;
    const padding = normalizeZeroPaddingFactor(state.zeroPaddingFactor);
    const maxNfft = this._canUseFftWorker()
        ? this._fftComputationMaxNfft()
        : this._fftLiveMaxNfft();
    // Both are powers of two, so this bound is itself one and survives the
    // preflight's own nextPowerOfTwo rounding without a further margin.
    const maxSamples = Math.floor(maxNfft / padding);
    if (maxSamples < 2) return null;

    let start = 0;
    if (!state.rangeFull) {
        const lo = Math.min(Number(state.x1), Number(state.x2));
        if (Number.isFinite(lo)) start = Math.max(0, Math.min(total - 2, this._lowerBound(times, lo)));
    }
    const end = Math.min(total, start + maxSamples);
    if (end - start < 2) return null;
    const x1 = Number(times[start]);
    const x2 = Number(times[end - 1]);
    if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) return null;
    return { x1, x2, samples: end - start };
};

// Replace a refused selection with the largest one that fits. Returns false
// when the range is already that one, so the caller does not resubmit a request
// the preflight has just refused.
proto._clampFftRangeToLimit = function(plot, state = this._ensureFftState(plot)) {
    const fitting = this._largestFittingFftRange(plot, state);
    if (!fitting) return null;
    if (!state.rangeFull && state.x1 === fitting.x1 && state.x2 === fitting.x2) return null;
    state.rangeFull = false;
    state.x1 = fitting.x1;
    state.x2 = fitting.x2;
    state.autoRangeLimited = false;
    // The clamped window is a fraction of what was asked for, so the view has
    // to move onto it or its edges are undraggable.
    state.autoRangeFocusPending = true;
    plot._fftPreflightTooLarge = null;
    return fitting;
};

proto._revertFftToLastAccepted = function(panelId, plot, state = this._ensureFftState(plot)) {
    const accepted = plot._fftLastAccepted;
    if (!accepted) return false;
    const unchanged = !!state.rangeFull === accepted.rangeFull
        && state.x1 === accepted.x1
        && state.x2 === accepted.x2
        && normalizeZeroPaddingFactor(state.zeroPaddingFactor) === accepted.zeroPaddingFactor;
    // Reverting to what is already set would recompute the same rejected
    // request forever; the caller falls back to the plain refusal instead.
    if (unchanged) return false;
    state.rangeFull = accepted.rangeFull;
    state.x1 = accepted.x1;
    state.x2 = accepted.x2;
    state.zeroPaddingFactor = accepted.zeroPaddingFactor;
    // The restored range may be nothing like the one on screen, so the view has
    // to follow it back too.
    state.autoRangeFocusPending = true;
    plot._fftPreflightTooLarge = null;
    return true;
};

proto._fftWarningText = function(trace, reason, extra = {}) {
    const name = this._traceName(trace?.varName, trace?.fileId);
    const prefix = name ? `${name}: ` : '';
    if (reason === 'nan' || reason === 'invalidTime') return prefix + i18n.t('fftWarningNaN');
    if (reason === 'nonUniform' || reason === 'nonMonotonic') return prefix + i18n.t('fftWarningNonUniform');
    if (reason === 'tooFewSamples') return prefix + i18n.t('fftWarningTooFew');
    if (reason === 'tooManyPoints' || reason === 'tooManyPointsReverted' || reason === 'tooManyPointsClamped') {
        const live = this._fftLiveMaxNfft().toLocaleString();
        const hard = this._fftHardMaxNfft().toLocaleString();
        const key = reason === 'tooManyPointsReverted' ? 'fftWarningTooManyReverted'
            : reason === 'tooManyPointsClamped' ? 'fftWarningTooManyClamped'
            : 'fftWarningTooMany';
        return prefix + i18n.t(key)
            .replace('{live}', live)
            .replace('{hard}', hard)
            .replace('{samples}', Number(extra?.samples || 0).toLocaleString());
    }
    if (reason === 'missingVariable') return prefix + i18n.t('fftWarningMissing');
    if (reason === 'fetchFailed') return prefix + i18n.t('fftWarningFetch');
    if (reason === 'duplicateTimes') return prefix + i18n.t('fftWarningDuplicateTimes');
    if (reason === 'noSpectralContent' || extra?.warnings?.includes('noSpectralContent')) return prefix + i18n.t('fftWarningNoContent');
    return prefix + i18n.t('fftWarningInvalid');
};

// Relayout patch that fits ONE spectrum axis: honour a manual limit (fMin/fMax
// for x, yMin/yMax for y), else reset to the FULL spectrum extent. The drawn
// trace is windowed for display, so Plotly's own autorange would fit only the
// visible slice — hence the explicit full-span extent from each trace's
// _fftExtent, matching the pre-windowing "zoom all the way out" behaviour.
proto._fftAxisLimitUpdate = function(plot, axis) {
    const isX = axis === 'x';
    const axisKey = isX ? 'xaxis' : 'yaxis';
    const manualRange = isX
        ? this._fftResolvedAxisLimitRange(plot, 'fMin', 'fMax')
        : this._fftResolvedAxisLimitRange(plot, 'yMin', 'yMax');
    const update = {};
    if (manualRange) {
        update[`${axisKey}.range`] = manualRange;
        update[`${axisKey}.autorange`] = false;
        return update;
    }
    const ext = this._fftSpectrumExtent(plot, axis);
    if (ext && Number.isFinite(ext.min) && Number.isFinite(ext.max) && ext.min !== ext.max) {
        update[`${axisKey}.range`] = [ext.min, ext.max];
        update[`${axisKey}.autorange`] = false;
    } else {
        update[`${axisKey}.autorange`] = true;
    }
    return update;
};

proto._applyFftAxisLimits = function(plot) {
    if (!plot?.fftDiv) return Promise.resolve();
    return Plotly.relayout(plot.fftDiv, {
        ...this._fftAxisLimitUpdate(plot, 'x'),
        ...this._fftAxisLimitUpdate(plot, 'y'),
    });
};

// Per-axis auto-fit for the spectrum pane (legend/toolbar buttons).
proto._autoScaleFftAxis = function(plot, axis) {
    if (!plot?.fftDiv) return Promise.resolve();
    return Plotly.relayout(plot.fftDiv, this._fftAxisLimitUpdate(plot, axis));
};

// Plotly performs its native double-click autorange in the same event cycle as
// `plotly_doubleclick`. Reapply the configured slider limits on the next task
// so the native reset cannot overwrite fMin/fMax (or yMin/yMax) afterwards.
proto._scheduleFftAxisLimitReset = function(plot) {
    if (!plot?.fftDiv) return;
    clearTimeout(plot._fftAxisLimitResetTimer);
    plot._fftAxisLimitResetTimer = setTimeout(() => {
        plot._fftAxisLimitResetTimer = 0;
        this._applyFftAxisLimits(plot);
    }, 0);
};

proto._autoScaleFftPanel = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || !plot?.fftDiv) return Promise.resolve();
    const timePromise = this._autoScalePlotTimeOnly(plot);
    // Respect manual fMin/fMax/yMin/yMax: autorange only the unset axes.
    const spectrumPromise = this._applyFftAxisLimits(plot);
    return Promise.all([timePromise, spectrumPromise]);
};

proto._autoScalePlotTimeOnly = function(plot) {
    if (!plot?.div) return Promise.resolve();
    const visibleTraces = (plot.traces || []).filter(t => this._isVisible(t));
    // A large FFT time pane shows a cached full-series screen overview. Its
    // full X domain is known from the edge samples, and its Y extent is known
    // from that cached envelope. Autoscale must restore the complete signal,
    // not zoom to the green analyzed block and not rescan 160M source samples.
    const largeFftOverview = plot.mode === 'fft' && this._fftShouldSkipGlobalGapScan(plot);
    let xExtent;
    let yExtent;
    if (largeFftOverview) {
        const domain = this._fftDomain(plot);
        xExtent = domain ? { min: domain.min, max: domain.max } : null;
        const cachedY = visibleTraces
            .map(trace => trace._fullVisualCache?.visual?.y)
            .filter(Boolean);
        yExtent = this._finiteExtent(cachedY.length
            ? cachedY
            : (plot.div.data || [])
                .filter(trace => trace?.visible !== 'legendonly' && !trace?._fftWindowed)
                .map(trace => trace?.y));
    } else {
        const xArrays = [];
        const yArrays = [];
        for (const t of visibleTraces) {
            xArrays.push(this._getTransformedTimeDataForVariable(t.fileId, t.varName));
            yArrays.push(this._getTransformedVariableData(t.fileId, t.varName));
        }
        xExtent = this._finiteExtent(xArrays);
        yExtent = this._finiteExtent(yArrays);
    }
    const update = {};
    if (xExtent) {
        const fileId = visibleTraces[0]?.fileId;
        const timeVar = this._getTimeVar(fileId);
        const isCalendar = this._timeDisplayModeForVar(fileId, timeVar) === 'calendar';
        const range = this._exactRange(xExtent.min, xExtent.max);
        update['xaxis.range'] = isCalendar ? this._plotlyTimeArray(fileId, range, timeVar) : range;
        update['xaxis.autorange'] = false;
    } else update['xaxis.autorange'] = true;
    if (yExtent) update['yaxis.range'] = this._padRange(yExtent.min, yExtent.max);
    else {
        update['yaxis.range'] = [-1, 1];
        update['yaxis.autorange'] = false;
    }
    const tickRange = xExtent ? [xExtent.min, xExtent.max] : null;
    return Plotly.relayout(plot.div, update)
        .then(() => this._refreshElapsedDateTimeAxisTicks(plot, tickRange));
};

}

function transferFftInputBuffers(input) {
    const buffers = new Set();
    for (const key of ['times', 'values']) {
        const buffer = input?.[key]?.buffer;
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) buffers.add(buffer);
    }
    return [...buffers];
}

function hasFiniteFftValue(value) {
    if (value === null || value === undefined || value === '') return false;
    return Number.isFinite(Number(value));
}

// Display-only rounding for the option-panel number inputs: the state (and
// every computation) keeps full precision; only what the user reads is short.
function formatFftInputValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(2);
    return String(Number(n.toFixed(2)));
}

// Calendar time axes store epoch ms rendered as naive UTC (see
// _plotlyTimeValue): the datetime-local inputs must use the same UTC
// convention so they match the axis tick labels.
function fftMsToDatetimeInput(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    const date = new Date(n);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 19);
}

function fftDatetimeInputToMs(text) {
    if (!text) return NaN;
    const ms = Date.parse(`${text}Z`);
    return Number.isFinite(ms) ? ms : NaN;
}
