import i18n from '../../i18n/index.js';
import {
    computeAmplitudeSpectrum,
    fftWindowCoefficients,
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
        optionsVisible: true,
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
        optionsVisible: raw.optionsVisible !== false,
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
    container.className = `fft-container fft-layout-${state.layout}`;
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
    layoutGroup.append(
        makeButton('fft-tool-btn fft-layout-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureFftState(plot).layout;
            this._setFftLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        }),
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
        if (restoreView) this._restorePlotView(plot, restoreView);
        this._refreshTimeseriesVisuals(panelId, plot);
        this._installFftPlotHandlers(panelId, plot);
        this._installFftSelectionHandlers(panelId, plot);
        this._installFftSplitterHandlers(panelId, plot);
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
        div.on('plotly_afterplot', () => this._installLegendHoverHint(div));
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
    const traces = plot.traces
        .map((t, idx) => this._buildTimeTrace(t, null, plot, idx))
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
    layout.shapes = this._fftSelectionShapes(plot);
    layout.margin = { ...(layout.margin || {}), t: 8 };
    layout.hovermode = this.hoverProximity ? 'closest' : 'x';
    // Keep hover out of the way of the selection handles: only show the
    // tooltip when the pointer is really close to a trace (px, default 20).
    layout.hoverdistance = 8;
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
            this._installFftSelectionHandlers(panelId, plot);
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
    if (!visible.length) {
        this._setFftStatus(plot, i18n.t('fftNoVisibleTraces'), 'muted');
        await Plotly.react(plot.fftDiv, [], this._buildFftSpectrumLayout(plot), this._getPlotlyConfig());
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
        spectra.push({
            x: spectrum.frequencies,
            y: spectrum.amplitudes,
            type: 'scatter',
            mode: 'lines',
            name: this._traceName(trace.varName, trace.fileId),
            visible: trace.visible ?? true,
            line: { color: trace.color, width: 1.5 },
            hovertemplate: `<b>%{fullData.name}</b><br>${i18n.t('fftFrequency')} = %{x:.6g}<br>${i18n.t('fftAmplitudeShort')} = %{y:.6g}<extra></extra>`,
            _fftExtent: {
                xMin: spectrum.frequencies.length ? Number(spectrum.frequencies[0]) : 0,
                xMax: spectrum.frequencies.length ? Number(spectrum.frequencies[spectrum.frequencies.length - 1]) : 1,
                yMin: amplitudeExtent?.min,
                yMax: amplitudeExtent?.max,
            },
        });
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
    if (warnings.length) this._setFftStatus(plot, warnings.join(' | '), 'warning');
    else this._setFftStatus(plot, i18n.t('fftReady'), 'ready');
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
    this._ensureFftRange(plot, { reset: true });
    this._syncFftOptionsPanel(plot);
    this._refreshFftTimePlot(panelId, plot);
    this._autoScalePlot(panelId, plot);
    this._scheduleFftRecompute(panelId, { immediate: true, preserveSpectrumX: false, preserveSpectrumY: false });
};

proto._activeFftRange = function(plot) {
    const state = this._ensureFftState(plot);
    const domain = this._fftDomain(plot);
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

proto._fftSelectionShapes = function(plot) {
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
    Plotly.relayout(plot.div, { shapes: this._fftSelectionShapes(plot) });
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
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.className = `fft-number-input ${className}`.trim();
        input.value = formatFftInputValue(isAxisLimit ? this._fftAxisLimitDisplayValue(plot, key) : state[key]);
        input.dataset.fftKey = key;
        if (isAxisLimit) input.dataset.fftAxisLimit = 'true';
        input.addEventListener('change', () => {
            const state = this._ensureFftState(plot);
            const n = Number(input.value);
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

    const rangeGrid = document.createElement('div');
    rangeGrid.className = 'fft-range-grid';
    const makeBound = (labelText, key, tooltip) => {
        const wrap = document.createElement('div');
        wrap.className = 'fft-range-bound';
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
    panel.querySelectorAll('[data-fft-key]').forEach(input => {
        const key = input.dataset.fftKey;
        if (!key || !(key in state)) return;
        const isAxisLimit = input.dataset.fftAxisLimit === 'true';
        if (input.type === 'checkbox') input.checked = !!state[key];
        else if (input.tagName?.toLowerCase() === 'select') input.value = String(state[key]);
        else if (input.type === 'range') {
            if (isAxisLimit) this._configureFftAxisLimitSlider(input, plot, key);
            else if (!options.skipRangeSliders) input.value = fmt(state[key]);
        } else if (isAxisLimit) {
            input.value = formatFftInputValue(this._fftAxisLimitDisplayValue(plot, key));
        } else input.value = formatFftInputValue(state[key]);
    });
    this._syncFftMessage(plot);
};

proto._setFftStatus = function(plot, message, type = 'muted') {
    const el = plot?.fftContainer?.querySelector('.fft-status');
    if (el) {
        el.textContent = message || '';
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
    return Plotly.relayout(plot.div, update);
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
