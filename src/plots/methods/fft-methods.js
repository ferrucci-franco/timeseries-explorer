import i18n from '../../i18n/index.js';
import {
    computeAmplitudeSpectrum,
    detectSamplingGaps,
    detectNaNRuns,
    fftWindowCoefficients,
    formatNaturalDuration,
    frequencyPeriod,
    nextPowerOfTwo,
    normalizeFftScale,
    normalizeFftWindow,
    normalizeZeroPaddingFactor,
    selectFftRange,
    FFT_LIVE_MAX_POINTS,
    FFT_MAX_POINTS_DESKTOP,
    FFT_MAX_POINTS_WEB,
} from '../../utils/fft.js';
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

    const config = this._getPlotlyConfig();
    Promise.all([
        Plotly.newPlot(timeDiv, this._buildFftTimeTraces(plot), this._buildFftTimeLayout(plot), config),
        Plotly.newPlot(spectrumDiv, [], this._buildFftSpectrumLayout(plot), config),
    ]).then(() => {
        this._refreshActionBtns(panelId);
        const viewPromise = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
        Promise.resolve(viewPromise).then(() => this._refreshTimeseriesVisuals(panelId, plot));
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
        this._scheduleFftRecompute(panelId, { immediate: true });
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
    });
};

proto._installFftPlotHandlers = function(panelId, plot) {
    if (!plot?.div || !plot?.fftDiv || plot._fftHandlersInstalled) return;
    plot._fftHandlersInstalled = true;
    const bindLegend = (div) => {
        let lastMouseDownHadShift = false;
        div.addEventListener('mousedown', event => {
            lastMouseDownHadShift = !!event.shiftKey;
        }, { capture: true });
        div.on('plotly_legendclick', (ed) => {
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
    plot.div.on('plotly_doubleclick', () => {
        this._autoScalePlotTimeOnly(plot);
        return false;
    });
    plot.fftDiv.on('plotly_doubleclick', () => {
        this._applyFftAxisLimits(plot);
        return false;
    });
    // Keep the spectrum-pane cursors glued to their frequencies when the
    // user zooms or pans the spectrum.
    plot.fftDiv.on('plotly_relayout', () => {
        if (plot.cursorsSpectrum?.enabled) this._syncCursorDisplay(panelId, plot);
    });
    this._installLegendHoverHint(plot.div);
    this._installLegendHoverHint(plot.fftDiv);
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

proto._buildFftTimeTraces = function(plot) {
    const gapInfo = this._fftGapInfo(plot);
    const gapsByFile = new Map(gapInfo.perFile.map(f => [f.fileId, f]));
    const traces = plot.traces
        .map((t, idx) => {
            const built = this._buildTimeTrace(t, null, plot, idx, { attachSourceX: true });
            if (built) this._applyLineBreaks(built, gapsByFile.get(t.fileId)?.gaps);
            return built;
        })
        .filter(Boolean);
    if (this._ensureFftState(plot).showWindowed) {
        traces.push(...this._buildFftWindowedTimeTraces(plot));
    }
    return traces;
};

proto._buildFftWindowedTimeTraces = function(plot) {
    const state = this._ensureFftState(plot);
    const range = this._activeFftRange(plot);
    const out = [];
    for (const trace of plot.traces || []) {
        if (!this._isVisible(trace)) continue;
        const times = this._getTransformedTimeData(trace.fileId);
        const values = this._getTransformedVariableData(trace.fileId, trace.varName);
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
        const visual = this._buildTimeseriesVisualData(selected.times, y, null, false);
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
        });
    }
    return out;
};

proto._buildFftTimeLayout = function(plot) {
    const layout = this._buildTimeLayout(plot);
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
    const layout = this._buildFftTimeLayout(plot);
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
            // The react above rebuilt traces from the base arrays (full-range
            // downsample / lazy overview); restore the resolution that matches
            // the preserved view, refetching raw detail for lazy files.
            this._refreshTimeseriesVisuals(panelId, plot);
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
    const run = () => this._refreshFftSpectrumPlot(panelId, plot);
    if (options.immediate) run();
    else plot._fftRecomputeTimer = setTimeout(run, 120);
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
        return { x: [], y: [], type: 'scatter', mode: 'lines', name, visible: 'legendonly', line: { color: trace.color, width: 1.5 } };
    };
    if (!visible.length) {
        this._setFftStatus(plot, i18n.t('fftNoVisibleTraces'), 'muted');
        await Plotly.react(plot.fftDiv, (plot.traces || []).map(legendPlaceholder), this._buildFftSpectrumLayout(plot), this._getPlotlyConfig());
        return;
    }

    this._setFftStatus(plot, i18n.t('fftCalculating'), 'loading');
    const spectra = [];
    const warnings = [];
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
        for (const warning of spectrum.warnings || []) {
            warnings.push(this._fftWarningText(trace, warning, spectrum));
        }
        const amplitudeExtent = this._finiteExtent([spectrum.amplitudes]);
        const periodUnit = this._fftCursorPeriodUnit(plot);
        const periodValues = new Float64Array(spectrum.frequencies.length);
        const naturalPeriodSuffixes = [];
        for (let i = 0; i < spectrum.frequencies.length; i++) {
            const period = frequencyPeriod(Number(spectrum.frequencies[i]));
            periodValues[i] = period;
            if (periodUnit === 's' && Number.isFinite(period) && period >= 60) {
                naturalPeriodSuffixes[i] = ` (${formatNaturalDuration(period, 2)})`;
            }
        }
        spectra.push({
            x: spectrum.frequencies,
            y: spectrum.amplitudes,
            customdata: periodValues,
            text: naturalPeriodSuffixes,
            type: 'scatter',
            mode: 'lines',
            name: this._traceName(trace.varName, trace.fileId),
            visible: trace.visible ?? true,
            line: { color: trace.color, width: 1.5 },
            hovertemplate: `<b>%{fullData.name}</b><br>${i18n.t('fftFrequency')}${this._fftFrequencyUnitSuffix(plot)} = %{x:.6g}<br>${i18n.t('fftPeriod')} = %{customdata:.6g}${periodUnit ? ` ${periodUnit}` : ''}%{text}<br>${i18n.t('fftAmplitudeShort')}${this._fftAmplitudeUnitSuffix(plot)} = %{y:.6g}<extra></extra>`,
            _fftExtent: {
                xMin: spectrum.frequencies.length ? Number(spectrum.frequencies[0]) : 0,
                xMax: spectrum.frequencies.length ? Number(spectrum.frequencies[spectrum.frequencies.length - 1]) : 1,
                yMin: amplitudeExtent?.min,
                yMax: amplitudeExtent?.max,
            },
        });
    }

    // Keep hidden traces in the spectrum data as legendonly placeholders so
    // their legend entry persists (greyed) instead of vanishing on toggle.
    for (const trace of plot.traces || []) {
        if (this._isVisible(trace)) continue;
        spectra.push(legendPlaceholder(trace));
    }

    state.warnings = warnings;
    plot._fftSpectra = spectra;
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
    const gapNote = this._fftGapsSummaryText(plot);
    if (warnings.length) {
        const base = warnings.join(' | ');
        this._setFftStatus(plot, gapNote ? `${base} - ${gapNote}` : base, 'warning');
    } else if (gapNote) {
        // Spectrum computed, but the analyzed span still straddles gaps worth
        // flagging (e.g. a lone dropped sample the tolerance happened to allow).
        this._setFftStatus(plot, gapNote, 'warning');
    } else {
        this._setFftStatus(plot, i18n.t('fftReady'), 'ready');
    }
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

    const times = this._getTransformedTimeData(trace.fileId);
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

    if (estimatedNfft <= this._fftLiveMaxNfft()) {
        return computeAmplitudeSpectrum(input);
    }
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

proto._fftHardMaxNfft = function() {
    return globalThis.omvDesktop ? FFT_MAX_POINTS_DESKTOP : FFT_MAX_POINTS_WEB;
};

proto._fftMaxRawRowsForState = function(state = this._defaultFftState()) {
    const padding = normalizeZeroPaddingFactor(state.zeroPaddingFactor);
    return Math.max(2, Math.floor(this._fftComputationMaxNfft() / padding));
};

proto._fftTimeKind = function(fileId) {
    const timeVar = this._getTimeVar(fileId);
    if (this._isGeneratedIndexTime(fileId, timeVar) && this._indexTimeStepMode(fileId) === 'index') return 'index';
    if (this._timeDisplayModeForVar(fileId, timeVar) === 'calendar'
        && !this._isHighResolutionGeneratedCalendarTime(fileId, timeVar)) return 'datetime';
    return 'numeric';
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
    const arrays = [];
    for (const trace of plot?.traces || []) {
        const values = this._getTransformedTimeData(trace.fileId);
        if (values?.length) arrays.push(values);
    }
    const extent = this._finiteExtent(arrays);
    return extent ? { min: extent.min, max: extent.max } : null;
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
        const times = this._getTransformedTimeData(t.fileId);
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

// Red bands marking missing-data intervals on a time pane. Appearance keys
// off each interval's on-screen width (recomputed on zoom): wide intervals get
// a soft borderless fill that shows their extent; narrow ones — whose fill is
// sub-pixel and would otherwise vanish — get a stronger fill plus a pixel-width
// stroke so they stay visible. `items` are { fileId, timeVar, t0, t1 } in
// transformed-time units. Shared by the FFT pane and the timeseries
// "show missing data" overlay.
proto._adaptiveGapBandShapes = function(plot, items) {
    if (!items?.length) return [];
    const MAX_BANDS = 500;

    // Pixels per data unit for the current view, so an interval's screen width
    // is (t1 - t0) * pxPerUnit. NaN until the axis has laid out — treat narrow.
    const xa = plot.div?._fullLayout?.xaxis;
    let pxPerUnit = NaN;
    if (xa && Array.isArray(xa.range) && xa._length) {
        const span = Math.abs(this._coerceAxisValue(xa.range[1]) - this._coerceAxisValue(xa.range[0]));
        if (span > 0) pxPerUnit = xa._length / span;
    }

    // With pathologically many intervals the series is effectively irregular;
    // keep only the widest so we never flood Plotly with shapes.
    const list = items.length > MAX_BANDS
        ? items.slice().sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0)).slice(0, MAX_BANDS)
        : items;

    const shapes = [];
    for (const it of list) {
        const widthPx = Number.isFinite(pxPerUnit) ? (it.t1 - it.t0) * pxPerUnit : 0;
        // Fill fades from strong (narrow) to soft (wide) as the band grows.
        const fillT = Math.max(0, Math.min(1, (widthPx - 3) / (30 - 3)));
        const fillAlpha = 0.8 + (0.28 - 0.8) * fillT;
        // Stroke only rescues truly narrow gaps; it is gone by ~3px, so wide
        // bands never get the outline the user disliked.
        const strokeWidth = Math.max(0, 2 - widthPx / 1.5);
        shapes.push({
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0: this._plotlyTimeValue(it.fileId, it.t0, it.timeVar),
            x1: this._plotlyTimeValue(it.fileId, it.t1, it.timeVar),
            y0: 0,
            y1: 1,
            fillcolor: `rgba(229, 57, 53, ${fillAlpha.toFixed(3)})`,
            line: strokeWidth > 0
                ? { color: 'rgba(229, 57, 53, 0.9)', width: strokeWidth }
                : { width: 0 },
            layer: 'below',
        });
    }
    return shapes;
};

// (A) FFT time pane: bands over the sampling gaps of every visible file.
proto._fftGapBandShapes = function(plot) {
    const info = this._fftGapInfo(plot);
    if (!info.count) return [];
    const items = [];
    for (const file of info.perFile) {
        for (const gap of file.gaps) {
            items.push({ fileId: file.fileId, timeVar: file.timeVar, t0: gap.t0, t1: gap.t1 });
        }
    }
    return this._adaptiveGapBandShapes(plot, items);
};

// The time pane draws gap bands beneath the Selection rectangle.
proto._fftTimePaneShapes = function(plot) {
    return [...this._fftGapBandShapes(plot), ...this._fftSelectionShapes(plot)];
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

// ── Timeseries "show missing data" overlay (opt-in) ──
// Trace identity for the per-trace break-interval map.
proto._missTraceKey = function(t) {
    return `${t.fileId} ${t.varName}`;
};

// Union of time gaps (per file) and NaN runs (per visible trace), memoized by
// a cheap signature. Only called when the opt-in flag is on, so large files
// pay nothing by default; even then it is one cached O(n) pass over the same
// in-memory / overview arrays the plot already holds.
proto._missingDataInfo = function(plot) {
    const visible = (plot?.traces || []).filter(t => this._isVisible(t));
    const sig = visible.map(t => {
        const times = this._getTransformedTimeData(t.fileId);
        const n = times?.length || 0;
        return `${t.fileId} ${t.varName}:${n}:${n ? times[0] : ''}:${n ? times[n - 1] : ''}`;
    }).join('|');
    if (plot._missSig === sig && plot._missCache) return plot._missCache;

    const fileGaps = new Map();       // fileId -> { timeVar, gaps: [{t0,t1}] }
    const traceIntervals = new Map(); // missTraceKey -> sorted [{t0,t1}]
    const bandItems = [];
    for (const t of visible) {
        if (!fileGaps.has(t.fileId)) {
            const times = this._getTransformedTimeData(t.fileId);
            const timeVar = this._getTimeVar(t.fileId);
            const gaps = detectSamplingGaps(times).gaps.map(g => ({ t0: g.t0, t1: g.t1 }));
            fileGaps.set(t.fileId, { timeVar, gaps });
            for (const g of gaps) bandItems.push({ fileId: t.fileId, timeVar, t0: g.t0, t1: g.t1 });
        }
        const entry = fileGaps.get(t.fileId);
        const times = this._getTransformedTimeData(t.fileId);
        const values = this._getTransformedVariableData(t.fileId, t.varName);
        const nanRuns = detectNaNRuns(times, values);
        for (const r of nanRuns) bandItems.push({ fileId: t.fileId, timeVar: entry.timeVar, t0: r.t0, t1: r.t1 });
        const merged = [...entry.gaps, ...nanRuns.map(r => ({ t0: r.t0, t1: r.t1 }))]
            .sort((p, q) => p.t0 - q.t0);
        traceIntervals.set(this._missTraceKey(t), merged);
    }
    const result = { fileGaps, traceIntervals, bandItems };
    plot._missSig = sig;
    plot._missCache = result;
    return result;
};

proto._missingDataBandShapes = function(plot) {
    return this._adaptiveGapBandShapes(plot, this._missingDataInfo(plot).bandItems);
};

// (C) When gaps fall inside the analyzed range, explain what the red bands
// mean and how to act — that is what makes the "not uniform" failure
// actionable. Static text (no counts): the bands already convey the extent.
proto._fftGapsSummaryText = function(plot) {
    const info = this._fftGapInfo(plot);
    if (!info.count) return '';
    const [lo, hi] = this._activeFftRange(plot);
    for (const file of info.perFile) {
        for (const gap of file.gaps) {
            if (gap.t1 > lo && gap.t0 < hi) return i18n.t('fftGapsWarning');
        }
    }
    return '';
};

proto._fftSelectionShapes = function(plot) {
    if (this._ensureFftState(plot).rangeFull) return [];
    const [lo, hi] = this._activeFftRange(plot);
    const firstTrace = plot.traces?.[0];
    const timeVar = firstTrace ? this._getTimeVar(firstTrace.fileId) : null;
    const x0 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, lo, timeVar) : lo;
    const x1 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, hi, timeVar) : hi;
    const color = '#ff9800';
    return [
        {
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0,
            x1,
            y0: 0,
            y1: 1,
            fillcolor: 'rgba(255, 152, 0, 0.12)',
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
    const title = document.createElement('div');
    title.className = 'fft-options-title';
    title.textContent = i18n.t('fftOptions');
    options.appendChild(title);

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
            state.rangeFull = isFull;
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
        makeSegment('fftRangeFull', 'fftRangeFullTooltip', true),
        makeSegment('fftRangeSelection', 'fftRangeSelectionTooltip', false),
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
        makeBound(i18n.t('fftRangeStart'), 'x1', i18n.t('fftRangeStartTooltip')),
        makeBound(i18n.t('fftRangeEnd'), 'x2', i18n.t('fftRangeEndTooltip')),
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

proto._fftWarningText = function(trace, reason, extra = {}) {
    const name = this._traceName(trace?.varName, trace?.fileId);
    const prefix = name ? `${name}: ` : '';
    if (reason === 'nan' || reason === 'invalidTime') return prefix + i18n.t('fftWarningNaN');
    if (reason === 'nonUniform' || reason === 'nonMonotonic') return prefix + i18n.t('fftWarningNonUniform');
    if (reason === 'tooFewSamples') return prefix + i18n.t('fftWarningTooFew');
    if (reason === 'tooManyPoints') {
        const live = this._fftLiveMaxNfft().toLocaleString();
        const hard = this._fftHardMaxNfft().toLocaleString();
        return prefix + i18n.t('fftWarningTooMany').replace('{live}', live).replace('{hard}', hard);
    }
    if (reason === 'missingVariable') return prefix + i18n.t('fftWarningMissing');
    if (reason === 'fetchFailed') return prefix + i18n.t('fftWarningFetch');
    if (reason === 'duplicateTimes') return prefix + i18n.t('fftWarningDuplicateTimes');
    if (reason === 'noSpectralContent' || extra?.warnings?.includes('noSpectralContent')) return prefix + i18n.t('fftWarningNoContent');
    return prefix + i18n.t('fftWarningInvalid');
};

proto._applyFftAxisLimits = function(plot) {
    if (!plot?.fftDiv) return Promise.resolve();
    const xRange = this._fftResolvedAxisLimitRange(plot, 'fMin', 'fMax');
    const yRange = this._fftResolvedAxisLimitRange(plot, 'yMin', 'yMax');
    const update = {};
    if (xRange) {
        update['xaxis.range'] = xRange;
        update['xaxis.autorange'] = false;
    } else {
        update['xaxis.autorange'] = true;
    }
    if (yRange) {
        update['yaxis.range'] = yRange;
        update['yaxis.autorange'] = false;
    } else {
        update['yaxis.autorange'] = true;
    }
    return Plotly.relayout(plot.fftDiv, update);
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
    const xArrays = [];
    const yArrays = [];
    for (const t of visibleTraces) {
        xArrays.push(this._getTransformedTimeData(t.fileId));
        yArrays.push(this._getTransformedVariableData(t.fileId, t.varName));
    }
    const xExtent = this._finiteExtent(xArrays);
    const yExtent = this._finiteExtent(yArrays);
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
    else update['yaxis.autorange'] = true;
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
