import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    HISTOGRAM_AUTO_MAX_BINS,
    HISTOGRAM_MANUAL_MAX_BINS,
    HISTOGRAM_DEFAULT_MANUAL_BINS,
    HISTOGRAM_DEFAULT_OPACITY,
    HISTOGRAM_RECOMPUTE_DEBOUNCE_MS,
    HISTOGRAM_NORMALIZATIONS,
    HISTOGRAM_BAR_MODES,
    HISTOGRAM_BIN_MODES,
    HISTOGRAM_VALUE_RANGE_MODES,
    histogramFiniteStats,
    resolveHistogramEdges,
    countHistogramBins,
    normalizeHistogramCounts,
    histogramBinGeometry,
} from '../../utils/histogram.js';

const HIST_LAYOUTS = new Set(['horizontal', 'vertical']);

const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};
const hasFinite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

// Phase 1 is eager-only. Lazy DuckDB-backed exact histograms are Phase 2; until
// then a lazy variable is refused rather than silently histogramming its ~10k
// overview reservoir (which would misrepresent modes, tails and percentages).
function isLazyTrace(app, trace) {
    return !!app.files.get(trace.fileId)?.data?._duckdb;
}

export function installPlotHistogramMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._defaultHistogramState = function() {
    return {
        layout: 'vertical',
        split: 0.5,
        timeSeriesHidden: false,
        optionsVisible: true,
        rangeFull: true,
        x1: null,
        x2: null,
        binMode: 'auto',
        binCount: HISTOGRAM_DEFAULT_MANUAL_BINS,
        binWidth: null,
        valueRangeMode: 'auto',
        valueMin: null,
        valueMax: null,
        normalization: 'count',
        barMode: 'overlay',
        yScale: 'linear',
        cumulative: false,
        warnings: [],
        dirty: false,
    };
};

proto._normalizeHistogramState = function(raw = {}) {
    const defaults = this._defaultHistogramState();
    const split = Number(raw.split);
    const binCount = Number(raw.binCount);
    const state = {
        ...defaults,
        ...raw,
        layout: HIST_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        timeSeriesHidden: raw.timeSeriesHidden === true,
        optionsVisible: raw.optionsVisible !== false,
        rangeFull: raw.rangeFull !== undefined
            ? !!raw.rangeFull
            : !(hasFinite(raw.x1) || hasFinite(raw.x2)),
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
        binMode: HISTOGRAM_BIN_MODES.has(raw.binMode) ? raw.binMode : defaults.binMode,
        binCount: Number.isInteger(binCount) && binCount >= 1 ? binCount : defaults.binCount,
        binWidth: finiteOrNull(raw.binWidth),
        valueRangeMode: HISTOGRAM_VALUE_RANGE_MODES.has(raw.valueRangeMode) ? raw.valueRangeMode : defaults.valueRangeMode,
        valueMin: finiteOrNull(raw.valueMin),
        valueMax: finiteOrNull(raw.valueMax),
        normalization: HISTOGRAM_NORMALIZATIONS.has(raw.normalization) ? raw.normalization : defaults.normalization,
        barMode: HISTOGRAM_BAR_MODES.has(raw.barMode) ? raw.barMode : defaults.barMode,
        yScale: raw.yScale === 'log' ? 'log' : 'linear',
        cumulative: raw.cumulative === true,
        warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 10) : [],
        dirty: false,
    };
    // Transient/derived data never persists.
    delete state.edges;
    delete state.counts;
    return state;
};

proto._ensureHistogramState = function(plot) {
    if (!plot) return this._defaultHistogramState();
    if (!plot.histogram) {
        plot.histogram = this._normalizeHistogramState({});
        return plot.histogram;
    }
    Object.assign(plot.histogram, this._normalizeHistogramState(plot.histogram));
    return plot.histogram;
};

// ─── Trace management ──────────────────────────────────────────────

proto._addHistogramTrace = function(panelId, varName, panelEl, plot) {
    if (plot.traces.find(t => t.varName === varName && t.fileId === this.activeFileId)) return;
    if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
    plot.traces.push({
        varName,
        color: this._nextTraceColor(plot.traces),
        fileId: this.activeFileId,
        axis: 'y',
    });
    this._ensureHistogramState(plot);

    if (!plot.div) {
        this._createHistogramChart(panelId, panelEl);
    } else {
        this._refreshHistogramTimePlot(panelId, plot, { preserveView: true });
        // Re-render the drawer so trace-count-dependent controls (e.g. the
        // "Total" toggle, enabled only with 2+ signals) reflect the new trace.
        this._renderHistogramOptionsPanel(panelId, plot);
        this._scheduleHistogramRecompute(panelId, { immediate: true });
    }
};

// ─── Chart creation ────────────────────────────────────────────────

proto._createHistogramChart = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    if (!this._hasContent(plot)) return;
    const state = this._ensureHistogramState(plot);
    const restoreView = plot._pendingViewRestore || null;
    delete plot._pendingViewRestore;
    if (restoreView?.histogramBars) plot._histogramPendingBarView = restoreView.histogramBars;

    const placeholder = panelEl.querySelector('.layout-panel-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    panelEl.querySelector('.hist-container')?.remove();

    const container = document.createElement('div');
    container.className = `hist-container hist-layout-${state.layout}${state.timeSeriesHidden ? ' hist-time-series-hidden' : ''}`;
    container.style.setProperty('--hist-split', `${Math.round(state.split * 1000) / 10}%`);

    // Topbar: H/V, Reset, Show options, status.
    const topbar = document.createElement('div');
    topbar.className = 'hist-topbar';
    const makeButton = (className, text, title, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
        return button;
    };
    const layoutGroup = document.createElement('div');
    layoutGroup.className = 'hist-topbar-group';
    const timeSeriesBtn = makeButton(
        'hist-tool-btn hist-time-series-btn',
        i18n.t('hideTimeSeries'),
        i18n.t('hideTimeSeriesTooltip'),
        () => this._toggleHistogramTimeSeries(panelId),
    );
    timeSeriesBtn.classList.toggle('active', state.timeSeriesHidden);
    timeSeriesBtn.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    layoutGroup.append(
        makeButton('hist-tool-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureHistogramState(plot).layout;
            this._setHistogramLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        }),
        timeSeriesBtn,
    );
    const actionGroup = document.createElement('div');
    actionGroup.className = 'hist-topbar-group';
    const optionsBtn = makeButton('hist-tool-btn hist-options-btn', i18n.t('fftOptionsLabel'), i18n.t('fftOptionsToggle'), () => this._toggleHistogramOptions(panelId));
    optionsBtn.classList.toggle('active', state.optionsVisible);
    optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
    actionGroup.append(
        makeButton('hist-tool-btn', i18n.t('fftResetLabel'), i18n.t('fftResetView'), () => this._resetHistogramView(panelId)),
        optionsBtn,
    );
    const status = document.createElement('span');
    status.className = 'hist-status';
    status.setAttribute('aria-live', 'polite');
    topbar.append(layoutGroup, actionGroup, status);

    // Workspace: plot area (time + splitter + histogram) and options drawer.
    const workspace = document.createElement('div');
    workspace.className = 'hist-workspace';
    const plotArea = document.createElement('div');
    plotArea.className = 'hist-plot-area';
    const timePane = document.createElement('div');
    timePane.className = 'hist-pane hist-time-pane';
    const histPane = document.createElement('div');
    histPane.className = 'hist-pane hist-hist-pane';
    const splitter = document.createElement('div');
    splitter.className = 'hist-splitter';
    splitter.setAttribute('role', 'separator');

    const timeDiv = document.createElement('div');
    timeDiv.className = 'plotly-container plotly-mode-hist-time';
    const histDiv = document.createElement('div');
    histDiv.className = 'plotly-container plotly-mode-hist-bars';
    timePane.appendChild(timeDiv);
    histPane.appendChild(histDiv);
    plotArea.append(timePane, splitter, histPane);

    const options = document.createElement('aside');
    options.className = 'hist-options fft-options';
    options.hidden = !state.optionsVisible;
    workspace.append(plotArea, options);
    container.append(topbar, workspace);
    panelEl.appendChild(container);

    plot.histogramContainer = container;
    plot.histogramDiv = histDiv;
    plot.div = timeDiv;

    this._renderHistogramOptionsPanel(panelId, plot);

    const config = this._getPlotlyConfig();
    Promise.all([
        Plotly.newPlot(timeDiv, this._buildHistogramTimeTraces(plot), this._buildHistogramTimeLayout(plot), config),
        Plotly.newPlot(histDiv, [], this._buildHistogramBarLayout(plot), config),
    ]).then(() => {
        this._refreshActionBtns(panelId);
        const viewPromise = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
        Promise.resolve(viewPromise).then(() => this._refreshTimeseriesVisuals(panelId, plot));
        this._installHistogramPlotHandlers(panelId, plot);
        // Cursor capture handlers before selection handlers, so an enabled
        // cursor over a selection boundary keeps the pointer (as in Heatmap).
        this._installCursorHandlers?.(panelId, plot);
        this._installHistogramSelectionHandlers(panelId, plot);
        this._installHistogramSplitterHandlers(panelId, plot);
        this._installWheelPan(panelId, plot, plot.div, {
            finalize: (xRange) => this._onRelayout(panelId, { 'xaxis.range': xRange }),
        });
        this._installWheelPan(panelId, plot, plot.histogramDiv);
        // Right-button drag pans the same panes (Plotly's native drag ignores
        // button 2, which otherwise snaps to a zoom-box scale on release).
        this._installRightButtonPan(panelId, plot, plot.div, {
            finalize: (xRange) => this._onRelayout(panelId, { 'xaxis.range': xRange }),
        });
        this._installRightButtonPan(panelId, plot, plot.histogramDiv);
        this._syncCursorDisplay?.(panelId, plot);
        this._scheduleHistogramRecompute(panelId, { immediate: true });
        let timer;
        const ro = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                Plotly.Plots.resize(timeDiv);
                Plotly.Plots.resize(histDiv);
            }, 50);
        });
        ro.observe(panelEl);
        plot.resizeObserver = ro;
    });
};

proto._installHistogramPlotHandlers = function(panelId, plot) {
    if (!plot?.div || !plot?.histogramDiv || plot._histHandlersInstalled) return;
    plot._histHandlersInstalled = true;
    const bindLegend = (div, isBars) => {
        let lastShift = false;
        div.addEventListener('mousedown', event => { lastShift = !!event.shiftKey; }, { capture: true });
        div.on('plotly_legendclick', (ed) => {
            const clickedName = ed.data?.[ed.curveNumber]?.name;
            const shiftClick = !!(ed.event?.shiftKey || lastShift);
            lastShift = false;
            this._handleHistogramLegendClick(panelId, plot, clickedName, shiftClick);
            return false;
        });
        div.on('plotly_legenddoubleclick', () => false);
        div.on('plotly_afterplot', () => {
            this._installLegendHoverHint(div);
            if (!isBars) this._refreshPanelDomOverlays(plot);
        });
    };
    bindLegend(plot.div, false);
    bindLegend(plot.histogramDiv, true);
    plot.div.on('plotly_relayout', ed => this._onRelayout(panelId, ed));
    plot.div.on('plotly_doubleclick', () => { this._autoScalePlotTimeOnly(plot); return false; });
    plot.histogramDiv.on('plotly_doubleclick', () => {
        Plotly.relayout(plot.histogramDiv, { 'xaxis.autorange': true, 'yaxis.autorange': true });
        return false;
    });
    this._installLegendHoverHint(plot.div);
    this._installLegendHoverHint(plot.histogramDiv);
};

proto._handleHistogramLegendClick = function(panelId, plot, clickedName, shiftClick = false) {
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
    this._refreshHistogramTimePlot(panelId, plot, { preserveView: true });
    // Visible-trace count changed: refresh the drawer so the "Total" toggle
    // enables/disables correctly.
    this._renderHistogramOptionsPanel(panelId, plot);
    this._scheduleHistogramRecompute(panelId, { immediate: true });
};

// ─── Time plot (top/left pane) ─────────────────────────────────────

proto._buildHistogramTimeTraces = function(plot) {
    return plot.traces
        .map((t, idx) => this._buildTimeTrace(t, null, plot, idx))
        .filter(Boolean);
};

proto._buildHistogramTimeLayout = function(plot) {
    const layout = this._buildTimeLayout(plot);
    layout.shapes = this._histogramSelectionShapes(plot);
    layout.margin = { ...(layout.margin || {}), t: 8 };
    layout.hovermode = false;
    return layout;
};

proto._refreshHistogramTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
    if (!plot?.div || plot.mode !== 'histogram') return Promise.resolve();
    const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
    const yRange = options.preserveView ? plot.div._fullLayout?.yaxis?.range : null;
    const layout = this._buildHistogramTimeLayout(plot);
    if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
    if (Array.isArray(yRange)) layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
    return Plotly.react(plot.div, this._buildHistogramTimeTraces(plot), layout, this._getPlotlyConfig())
        .then(() => {
            this._installLegendHoverHint(plot.div);
            this._installHistogramSelectionHandlers(panelId, plot);
            this._refreshTimeseriesVisuals(panelId, plot);
        });
};

// ─── Histogram bar plot (bottom/right pane) ────────────────────────

// Reuses the shared, FFT-independent time-kind detector so the start/end
// controls show a datetime-local picker (not raw epoch ms) on calendar axes.
proto._histogramUsesCalendarTime = function(plot) {
    const trace = (plot?.traces || []).find(t => this._isVisible(t)) || plot?.traces?.[0];
    return trace ? this._fftTimeKind(trace.fileId) === 'datetime' : false;
};

proto._histogramValueUnit = function(plot) {
    const units = new Set();
    for (const trace of plot?.traces || []) {
        if (!this._isVisible(trace)) continue;
        const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
        const unit = variable ? this._extractUnit(variable.description) : '';
        if (unit) units.add(unit);
    }
    if (units.size === 1) return { unit: [...units][0], mixed: false };
    if (units.size > 1) return { unit: '', mixed: true };
    return { unit: '', mixed: false };
};

proto._buildHistogramBarLayout = function(plot) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const state = this._ensureHistogramState(plot);
    const { unit, mixed } = this._histogramValueUnit(plot);
    const xTitle = mixed
        ? i18n.t('histogramValueMixed')
        : (unit ? `${i18n.t('histogramValue')} [${unit}]` : i18n.t('histogramValue'));
    let yTitle = i18n.t('histogramCount');
    if (state.normalization === 'percent') yTitle = i18n.t('histogramPercent');
    else if (state.normalization === 'density') yTitle = (unit && !mixed) ? `${i18n.t('histogramDensity')} [1/${unit}]` : i18n.t('histogramDensity');
    return {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: this.legendPosition !== 'hidden',
        legend: this._legendConfig(legendBg, gridColor),
        barmode: state.barMode === 'grouped' ? 'group' : state.barMode === 'stacked' ? 'stack' : 'overlay',
        bargap: 0,
        xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false, title: { text: xTitle, font: { size: 10 } } },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false, rangemode: 'tozero', title: { text: yTitle, font: { size: 10 } } },
        margin: { l: 58, r: 16, t: 8, b: 46 },
        autosize: true,
        hovermode: 'closest',
    };
};

proto._buildHistogramBarLayoutForReact = function(plot) {
    const layout = this._buildHistogramBarLayout(plot);
    const pending = plot?._histogramPendingBarView || null;
    plot._histogramPendingBarView = null;
    if (Array.isArray(pending?.xRange)) {
        layout.xaxis = { ...layout.xaxis, range: pending.xRange.slice(), autorange: false };
    }
    if (Array.isArray(pending?.yRange)) {
        layout.yaxis = { ...layout.yaxis, range: pending.yRange.slice(), autorange: false };
    }
    return layout;
};

proto._scheduleHistogramRecompute = function(panelId, options = {}) {
    const plot = this.plots.get(panelId);
    if (!plot?.histogramDiv || plot.mode !== 'histogram') return;
    clearTimeout(plot._histRecomputeTimer);
    const run = () => this._recomputeHistogram(panelId, plot);
    if (options.immediate) run();
    else plot._histRecomputeTimer = setTimeout(run, HISTOGRAM_RECOMPUTE_DEBOUNCE_MS);
};

// Collect the finite-and-invalid value samples of one trace within the active
// temporal range (eager transformed data: crop/gain/offset/data-tools applied).
proto._histogramSamplesForTrace = function(trace, range) {
    const values = this._getTransformedVariableData(trace.fileId, trace.varName);
    if (!values || !values.length) return [];
    if (!range) return values;
    const times = this._getTransformedTimeData(trace.fileId);
    if (!times || times.length !== values.length) return values;
    const [lo, hi] = range;
    const out = [];
    for (let i = 0; i < values.length; i++) {
        const t = times[i];
        if (t >= lo && t <= hi) out.push(values[i]);
    }
    return out;
};

proto._recomputeHistogram = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.histogramDiv || plot.mode !== 'histogram') return;
    const token = (plot._histToken || 0) + 1;
    plot._histToken = token;
    const state = this._ensureHistogramState(plot);
    const range = state.rangeFull ? null : this._activeHistogramRange(plot);
    const allTraces = plot.traces || [];
    const warnings = [];
    const config = this._getPlotlyConfig();

    if (!allTraces.length) {
        this._setHistogramStatus(plot, i18n.t('fftNoVisibleTraces'), 'muted');
        Plotly.react(plot.histogramDiv, [], this._buildHistogramBarLayoutForReact(plot), config);
        return;
    }

    // Phase 1: refuse lazy traces rather than histogramming their overview.
    // Hidden (legendonly) traces are KEPT so their legend entry stays greyed
    // instead of vanishing when the user toggles it.
    const eager = [];
    for (const trace of allTraces) {
        if (isLazyTrace(this, trace)) {
            if (this._isVisible(trace)) warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${i18n.t('histogramLazyUnsupported')}`);
        } else {
            eager.push(trace);
        }
    }
    if (!eager.length) {
        this._setHistogramStatus(plot, warnings.join(' | '), 'warning');
        state.warnings = warnings;
        Plotly.react(plot.histogramDiv, [], this._buildHistogramBarLayoutForReact(plot), config);
        return;
    }

    // Pass 1: per-trace samples + finite stats for every eager trace.
    const perTrace = [];
    for (const trace of eager) {
        const samples = this._histogramSamplesForTrace(trace, range);
        const stat = histogramFiniteStats(samples);
        perTrace.push({ trace, samples, stat, visible: this._isVisible(trace) });
    }

    // Edges come from VISIBLE traces with finite data, so hiding a trace never
    // shifts the others' bins. If everything is hidden, fall back to all finite
    // traces so real (legendonly) bars still render and keep their legend entry
    // — an EMPTY bar produces no legend entry in Plotly.
    const placeholderBar = (p) => ({
        type: 'bar', x: [], y: [],
        name: this._traceName(p.trace.varName, p.trace.fileId),
        visible: p.trace.visible ?? true,
        marker: { color: p.trace.color },
    });
    let statsForEdges = perTrace.filter(p => p.visible && p.stat.nFinite > 0).map(p => p.stat);
    if (!statsForEdges.length) statsForEdges = perTrace.filter(p => p.stat.nFinite > 0).map(p => p.stat);

    if (!statsForEdges.length) {
        // No finite data in any trace at all.
        for (const p of perTrace) warnings.push(`${this._traceName(p.trace.varName, p.trace.fileId)}: ${i18n.t('histogramNoFinite')}`);
        plot._histSummary = [];
        state.warnings = warnings;
        if (plot._histToken !== token) return;
        Plotly.react(plot.histogramDiv, [], this._buildHistogramBarLayoutForReact(plot), config);
        this._setHistogramStatus(plot, i18n.t('histogramNoFinite'), 'warning');
        return;
    }

    // Shared edges for every trace.
    const spec = resolveHistogramEdges(statsForEdges, {
        binMode: state.binMode,
        binCount: state.binCount,
        binWidth: state.binWidth,
        valueRangeMode: state.valueRangeMode,
        valueMin: state.valueMin,
        valueMax: state.valueMax,
        autoMaxBins: HISTOGRAM_AUTO_MAX_BINS,
        manualMaxBins: HISTOGRAM_MANUAL_MAX_BINS,
    });
    if (!spec.ok) {
        this._setHistogramStatus(plot, i18n.t(`histogramErr_${spec.reason}`) || spec.reason, 'error');
        return; // keep previous bars
    }
    if (plot._histToken !== token) return;

    const { centers, widths } = histogramBinGeometry(spec.edges);
    const { unit, mixed } = this._histogramValueUnit(plot);
    if (mixed) warnings.push(i18n.t('histogramMixedUnits'));

    // Pre-pass: count every finite trace and accumulate the combined binned
    // total (needed before normalization so a Stacked view can normalize
    // against the combined population and the stack tops stay coherent).
    let totalBinned = 0;
    for (const p of perTrace) {
        p.counted = p.stat.nFinite > 0 ? countHistogramBins(p.samples, spec) : null;
        if (p.counted && p.visible) totalBinned += p.counted.nBinned;
    }

    // Pass 2: normalization → bars. Every eager trace stays in the data (hidden
    // ones as legendonly) so its legend entry persists. Stacked normalizes each
    // bar against the combined total so the stacked columns sum coherently.
    const stacked = state.barMode === 'stacked';
    const bars = [];
    const summary = [];
    const pickY = (norm) => state.normalization === 'percent' ? norm.percent
        : state.normalization === 'density' ? norm.density
        : norm.count;
    for (const { trace, counted, stat, visible } of perTrace) {
        const name = this._traceName(trace.varName, trace.fileId);
        if (!counted) {
            bars.push(placeholderBar({ trace }));
            if (visible) warnings.push(`${name}: ${i18n.t('histogramNoFinite')}`);
            continue;
        }
        const denom = stacked ? totalBinned : counted.nBinned;
        const norm = normalizeHistogramCounts(counted.counts, spec.edges, counted.nBinned, denom);
        const y = pickY(norm);
        const customdata = [];
        for (let i = 0; i < spec.k; i++) {
            customdata.push([spec.edges[i], spec.edges[i + 1], norm.count[i], norm.percent[i], norm.density[i], i === spec.k - 1]);
        }
        bars.push({
            type: 'bar',
            x: Array.from(centers),
            y: Array.from(y),
            width: Array.from(widths),
            name,
            visible: trace.visible ?? true,
            // Grouped uses solid bars; Overlay and Stacked share the softer
            // semi-transparent look.
            marker: { color: trace.color, opacity: state.barMode === 'grouped' ? 1 : HISTOGRAM_DEFAULT_OPACITY, line: { color: trace.color, width: 1 } },
            customdata,
            hovertemplate: `<b>%{fullData.name}</b><br>[%{customdata[0]:.6g}, %{customdata[1]:.6g})<br>${i18n.t('histogramCount')} = %{customdata[2]}<br>${i18n.t('histogramPercent')} = %{customdata[3]:.3g}%<extra></extra>`,
        });
        if (visible) summary.push({ name, nFinite: stat.nFinite, nInvalid: stat.nInvalid, nBinned: counted.nBinned, underflow: counted.underflow, overflow: counted.overflow });
    }

    // Soft advice: overlay reads better than grouped with many bars.
    if (state.barMode === 'grouped' && spec.k * bars.length > 2000) warnings.push(i18n.t('histogramGroupedManyBars'));

    state.warnings = warnings;
    plot._histSummary = summary;
    plot._histSpec = spec;
    if (plot._histToken !== token) return;

    Plotly.react(plot.histogramDiv, bars, this._buildHistogramBarLayoutForReact(plot), config).then(() => {
        this._installLegendHoverHint(plot.histogramDiv);
        this._syncHistogramSummary(plot, spec, unit);
    });

    const methodLabel = `${i18n.t(`histogramMethod_${spec.method}`) || spec.method} · ${spec.k} ${i18n.t('histogramBinsShort')}`;
    if (warnings.length) this._setHistogramStatus(plot, `${methodLabel} — ${warnings.join(' | ')}`, 'warning');
    else this._setHistogramStatus(plot, methodLabel, 'ready');
};

proto._setHistogramStatus = function(plot, text, kind = 'muted') {
    const status = plot?.histogramContainer?.querySelector('.hist-status');
    if (!status) return;
    status.textContent = text || '';
    status.className = `hist-status hist-status-${kind}`;
};

// ─── Temporal selection (Todo / Selección) — mechanics mirror FFT ──

proto._histogramDomain = function(plot) {
    const arrays = [];
    for (const trace of plot?.traces || []) {
        const values = this._getTransformedTimeData(trace.fileId);
        if (values?.length) arrays.push(values);
    }
    const extent = this._finiteExtent(arrays);
    return extent ? { min: extent.min, max: extent.max } : null;
};

proto._activeHistogramRange = function(plot) {
    const state = this._ensureHistogramState(plot);
    const domain = this._histogramDomain(plot);
    if (state.rangeFull) {
        if (domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) return [domain.min, domain.max];
        return [0, 1];
    }
    let lo = hasFinite(state.x1) ? Number(state.x1) : NaN;
    let hi = hasFinite(state.x2) ? Number(state.x2) : NaN;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (lo > hi) [lo, hi] = [hi, lo];
    if (domain) { lo = Math.max(domain.min, Math.min(domain.max, lo)); hi = Math.max(domain.min, Math.min(domain.max, hi)); }
    return [lo, hi];
};

proto._histogramSelectionShapes = function(plot) {
    if (this._ensureHistogramState(plot).rangeFull) return [];
    const [lo, hi] = this._activeHistogramRange(plot);
    const firstTrace = plot.traces?.[0];
    const timeVar = firstTrace ? this._getTimeVar(firstTrace.fileId) : null;
    const x0 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, lo, timeVar) : lo;
    const x1 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, hi, timeVar) : hi;
    // Green selection so it never reads as the amber Missing/NaN wash.
    const color = '#43a047';
    return [
        { type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(67,160,71,0.14)', line: { width: 0 }, layer: 'below' },
        { type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color, width: 2 } },
        { type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color, width: 2 } },
    ];
};

proto._updateHistogramSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || plot.mode !== 'histogram') return;
    Plotly.relayout(plot.div, { shapes: this._histogramSelectionShapes(plot) });
    this._syncHistogramOptionsPanel(plot);
};

proto._installHistogramSelectionHandlers = function(panelId, plot) {
    if (!plot?.div || plot._histSelectionDiv === plot.div) return;
    plot._histSelectionDiv = plot.div;
    let dragging = null;
    const hitTest = (event) => {
        if (this._ensureHistogramState(plot).rangeFull) return null;
        if (!this._eventInsidePlotArea(plot.div, event)) return null;
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x)) return null;
        const domain = this._histogramDomain(plot);
        if (!domain) return null;
        const [lo, hi] = this._activeHistogramRange(plot);
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
    const setCursorHint = (hit) => {
        plot.div.classList.toggle('fft-cursor-ew', hit === 'left' || hit === 'right');
        plot.div.classList.toggle('fft-cursor-grab', hit === 'move');
    };
    plot.div.addEventListener('mousemove', event => { if (!dragging) setCursorHint(hitTest(event)); });
    plot.div.addEventListener('mouseleave', () => { if (!dragging && plot.div) setCursorHint(null); });
    plot.div.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        const hit = hitTest(event);
        if (!hit) return;
        const x = this._eventToXValue(plot.div, event);
        const [lo, hi] = this._activeHistogramRange(plot);
        dragging = { hit, startX: x, startLo: lo, startHi: hi };
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        document.body.classList.add('fft-selection-dragging');
        document.body.classList.toggle('fft-selection-moving', hit === 'move');
    }, true);
    const onMove = event => {
        if (!dragging || !plot.div) return;
        const domain = this._histogramDomain(plot);
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x) || !domain) return;
        const state = this._ensureHistogramState(plot);
        let lo = dragging.startLo;
        let hi = dragging.startHi;
        if (dragging.hit === 'left') lo = x;
        else if (dragging.hit === 'right') hi = x;
        else {
            let delta = x - dragging.startX;
            if (dragging.startLo + delta < domain.min) delta = domain.min - dragging.startLo;
            if (dragging.startHi + delta > domain.max) delta = domain.max - dragging.startHi;
            lo = dragging.startLo + delta;
            hi = dragging.startHi + delta;
        }
        if (lo > hi) [lo, hi] = [hi, lo];
        state.x1 = Math.max(domain.min, Math.min(domain.max, lo));
        state.x2 = Math.max(domain.min, Math.min(domain.max, hi));
        this._updateHistogramSelectionShapes(panelId, plot);
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('fft-selection-dragging');
        document.body.classList.remove('fft-selection-moving');
        if (plot.div) setCursorHint(null);
        this._scheduleHistogramRecompute(panelId);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._histSelectionDocListeners = { move: onMove, up: onUp };
};

proto._setHistogramRangeMode = function(panelId, full) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const state = this._ensureHistogramState(plot);
    if (state.rangeFull === full) return;
    state.rangeFull = full;
    if (!full) {
        // Initialize the selection from the currently visible time span.
        const xa = plot.div?._fullLayout?.xaxis;
        const domain = this._histogramDomain(plot);
        let lo = this._coerceAxisValue(xa?.range?.[0]);
        let hi = this._coerceAxisValue(xa?.range?.[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
        if (domain) { lo = Math.max(domain.min, Math.min(domain.max, lo)); hi = Math.max(domain.min, Math.min(domain.max, hi)); }
        if (lo > hi) [lo, hi] = [hi, lo];
        state.x1 = lo;
        state.x2 = hi;
    }
    this._updateHistogramSelectionShapes(panelId, plot);
    this._renderHistogramOptionsPanel(panelId, plot);
    this._scheduleHistogramRecompute(panelId, { immediate: true });
};

// ─── Layout / splitter / options toggle (mirror FFT) ───────────────

proto._setHistogramLayout = function(panelId, layout) {
    const plot = this.plots.get(panelId);
    if (!plot?.histogramContainer || !HIST_LAYOUTS.has(layout)) return;
    this._ensureHistogramState(plot).layout = layout;
    plot.histogramContainer.classList.toggle('hist-layout-horizontal', layout === 'horizontal');
    plot.histogramContainer.classList.toggle('hist-layout-vertical', layout === 'vertical');
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.histogramDiv);
};

proto._toggleHistogramTimeSeries = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.histogramContainer) return;
    const state = this._ensureHistogramState(plot);
    state.timeSeriesHidden = !state.timeSeriesHidden;
    plot.histogramContainer.classList.toggle('hist-time-series-hidden', state.timeSeriesHidden);
    const button = plot.histogramContainer.querySelector('.hist-time-series-btn');
    if (button) {
        button.classList.toggle('active', state.timeSeriesHidden);
        button.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    }
    if (!state.timeSeriesHidden && plot.div) {
        Plotly.Plots.resize(plot.div);
        this._refreshPanelDomOverlays(plot);
    }
    if (plot.histogramDiv) Plotly.Plots.resize(plot.histogramDiv);
};

proto._toggleHistogramOptions = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.histogramContainer) return;
    const state = this._ensureHistogramState(plot);
    state.optionsVisible = !state.optionsVisible;
    const options = plot.histogramContainer.querySelector('.hist-options');
    if (options) options.hidden = !state.optionsVisible;
    const optionsBtn = plot.histogramContainer.querySelector('.hist-options-btn');
    if (optionsBtn) {
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
    }
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.histogramDiv);
};

proto._resetHistogramView = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;
    const state = this._ensureHistogramState(plot);
    state.rangeFull = true;
    state.x1 = null;
    state.x2 = null;
    state.valueRangeMode = 'auto';
    state.valueMin = null;
    state.valueMax = null;
    this._updateHistogramSelectionShapes(panelId, plot);
    this._renderHistogramOptionsPanel(panelId, plot);
    this._autoScalePlotTimeOnly(plot);
    if (plot.histogramDiv) Plotly.relayout(plot.histogramDiv, { 'xaxis.autorange': true, 'yaxis.autorange': true });
    this._scheduleHistogramRecompute(panelId, { immediate: true });
};

proto._autoScaleHistogramPanel = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div) return Promise.resolve();
    const timePromise = this._autoScalePlotTimeOnly(plot);
    const histogramPromise = plot.histogramDiv
        ? Plotly.relayout(plot.histogramDiv, { 'xaxis.autorange': true, 'yaxis.autorange': true })
        : Promise.resolve();
    return Promise.all([timePromise, histogramPromise]);
};

proto._installHistogramSplitterHandlers = function(panelId, plot) {
    const splitter = plot?.histogramContainer?.querySelector('.hist-splitter');
    if (!splitter || splitter._histBound) return;
    splitter._histBound = true;
    let dragging = false;
    const apply = (event) => {
        if (!plot.histogramContainer) return;
        const state = this._ensureHistogramState(plot);
        const area = plot.histogramContainer.querySelector('.hist-plot-area');
        const rect = area?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const fraction = state.layout === 'vertical'
            ? (event.clientY - rect.top) / rect.height
            : (event.clientX - rect.left) / rect.width;
        state.split = Math.max(0.2, Math.min(0.8, fraction));
        plot.histogramContainer.style.setProperty('--hist-split', `${Math.round(state.split * 1000) / 10}%`);
        Plotly.Plots.resize(plot.div);
        Plotly.Plots.resize(plot.histogramDiv);
    };
    splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
    const onMove = event => { if (dragging) apply(event); };
    const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._histSplitterDocListeners = { move: onMove, up: onUp };
    void panelId;
};

// ─── Options drawer ────────────────────────────────────────────────

proto._renderHistogramOptionsPanel = function(panelId, plot) {
    const state = this._ensureHistogramState(plot);
    const options = plot?.histogramContainer?.querySelector('.hist-options');
    if (!options) return;
    options.innerHTML = '';

    const section = (titleKey) => {
        const h = document.createElement('div');
        h.className = 'fft-options-subtitle';
        h.textContent = i18n.t(titleKey);
        options.appendChild(h);
    };
    const row = (labelText, control, tooltip) => {
        const label = document.createElement('label');
        label.className = 'fft-option-row hist-option-row';
        if (tooltip) label.title = tooltip;
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, control);
        options.appendChild(label);
        return label;
    };
    // Segmented control that updates its own active button on click (so the
    // highlight follows the selection without a full drawer re-render).
    const segmented = (items, current, onPick) => {
        const wrap = document.createElement('div');
        wrap.className = 'hist-segmented';
        const btns = [];
        for (const item of items) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'hist-seg-btn';
            btn.textContent = item.label;
            if (item.title) btn.title = item.title;
            if (item.disabled) { btn.disabled = true; btn.classList.add('disabled'); }
            const active = item.value === current;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', String(active));
            btn.addEventListener('click', () => {
                if (item.disabled) return;
                btns.forEach(b => { const on = b === btn; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
                onPick(item.value);
            });
            btns.push(btn);
            wrap.appendChild(btn);
        }
        return wrap;
    };
    const numberInput = (value, onChange, opts = {}) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'fft-number-input';
        input.step = 'any';
        if (opts.min != null) input.min = String(opts.min);
        if (value != null && value !== '') input.value = String(value);
        if (opts.disabled) input.disabled = true;
        input.addEventListener('change', () => onChange(input.value));
        return input;
    };

    // Temporal scope — input + slider per bound, calendar-aware, exactly as FFT.
    section('histogramTemporalScope');
    options.appendChild(segmented(
        [{ label: i18n.t('histogramScopeAll'), value: true }, { label: i18n.t('histogramScopeSelection'), value: false }],
        state.rangeFull,
        (full) => this._setHistogramRangeMode(panelId, full),
    ));
    const domain = this._histogramDomain(plot);
    const isCal = this._histogramUsesCalendarTime(plot);
    const boundValue = (key) => this._activeHistogramRange(plot)[key === 'x1' ? 0 : 1];
    const makeBoundInput = (key) => {
        const input = document.createElement('input');
        input.type = isCal ? 'datetime-local' : 'number';
        input.step = isCal ? '1' : 'any';
        input.className = 'fft-number-input';
        input.dataset.histKey = key;
        input.dataset.histRole = 'input';
        input.disabled = !!state.rangeFull;
        const cur = boundValue(key);
        input.value = isCal ? histMsToDatetimeInput(cur) : formatHistInputValue(cur);
        input.addEventListener('change', () => {
            const n = isCal ? histDatetimeInputToMs(input.value) : Number(input.value);
            let v = Number.isFinite(n) ? n : null;
            if (v != null && domain) v = Math.max(domain.min, Math.min(domain.max, v));
            state[key] = v;
            this._updateHistogramSelectionShapes(panelId, plot);
            this._scheduleHistogramRecompute(panelId);
        });
        return input;
    };
    const makeBoundSlider = (key) => {
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'fft-range-input';
        input.dataset.histKey = key;
        input.dataset.histRole = 'slider';
        if (domain) { input.min = String(domain.min); input.max = String(domain.max); input.step = 'any'; }
        const cur = boundValue(key);
        if (Number.isFinite(cur)) input.value = String(cur);
        input.disabled = !!state.rangeFull;
        input.addEventListener('input', () => {
            const n = Number(input.value);
            state[key] = Number.isFinite(n) ? n : null;
            this._updateHistogramSelectionShapes(panelId, plot);
        });
        input.addEventListener('change', () => this._scheduleHistogramRecompute(panelId));
        return input;
    };
    const boundBlock = (labelText, key) => {
        const wrap = document.createElement('div');
        wrap.className = 'hist-range-bound' + (isCal ? ' hist-range-bound-datetime' : '');
        const label = document.createElement('label');
        label.className = 'fft-option-row hist-option-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, makeBoundInput(key));
        wrap.append(label, makeBoundSlider(key));
        options.appendChild(wrap);
    };
    boundBlock(i18n.t('histogramSelStart'), 'x1');
    boundBlock(i18n.t('histogramSelEnd'), 'x2');

    // Bins.
    section('histogramBins');
    options.appendChild(segmented(
        [
            { label: i18n.t('histogramBinAuto'), value: 'auto', title: i18n.t('histogramBinAutoTip') },
            { label: i18n.t('histogramBinCount'), value: 'count', title: i18n.t('histogramBinCountTip') },
            { label: i18n.t('histogramBinWidth'), value: 'width', title: i18n.t('histogramBinWidthTip') },
        ],
        state.binMode,
        (mode) => {
            state.binMode = mode;
            // Seed a sensible bin width from the last resolved edges so the
            // field is never empty (which would read as an error).
            if (mode === 'width' && !(Number(state.binWidth) > 0)) {
                const w = plot._histSpec?.width;
                if (Number.isFinite(w) && w > 0) state.binWidth = w;
            }
            this._renderHistogramOptionsPanel(panelId, plot);
            this._scheduleHistogramRecompute(panelId, { immediate: true });
        },
    ));
    if (state.binMode === 'count') {
        row(i18n.t('histogramBinCount'), numberInput(state.binCount, (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 1 && n <= HISTOGRAM_MANUAL_MAX_BINS) { state.binCount = n; this._scheduleHistogramRecompute(panelId); }
        }, { min: 1 }), i18n.t('histogramBinCountTip'));
    } else if (state.binMode === 'width') {
        row(i18n.t('histogramBinWidth'), numberInput(state.binWidth ?? '', (v) => {
            state.binWidth = finiteOrNull(v);
            this._scheduleHistogramRecompute(panelId);
        }, { min: 0 }), i18n.t('histogramBinWidthTip'));
    }

    // Value range.
    section('histogramValueRange');
    options.appendChild(segmented(
        [
            { label: i18n.t('histogramRangeAuto'), value: 'auto', title: i18n.t('histogramRangeAutoTip') },
            { label: i18n.t('histogramRangeManual'), value: 'manual', title: i18n.t('histogramRangeManualTip') },
        ],
        state.valueRangeMode,
        (mode) => {
            state.valueRangeMode = mode;
            // Pre-fill Manual min/max with the current data range so the fields
            // are never empty (the auto spec's lo/hi are the signals' min/max).
            if (mode === 'manual') {
                const spec = plot._histSpec;
                if (spec && Number.isFinite(spec.lo) && Number.isFinite(spec.hi)) {
                    if (state.valueMin == null) state.valueMin = spec.lo;
                    if (state.valueMax == null) state.valueMax = spec.hi;
                }
            }
            this._renderHistogramOptionsPanel(panelId, plot);
            this._scheduleHistogramRecompute(panelId, { immediate: true });
        },
    ));
    if (state.valueRangeMode === 'manual') {
        row(i18n.t('histogramValueMin'), numberInput(state.valueMin == null ? '' : formatHistInputValue(state.valueMin), (v) => { state.valueMin = finiteOrNull(v); this._scheduleHistogramRecompute(panelId); }));
        row(i18n.t('histogramValueMax'), numberInput(state.valueMax == null ? '' : formatHistInputValue(state.valueMax), (v) => { state.valueMax = finiteOrNull(v); this._scheduleHistogramRecompute(panelId); }));
    }

    // Normalization + bars.
    section('histogramNormalization');
    options.appendChild(segmented(
        [
            { label: i18n.t('histogramCount'), value: 'count' },
            { label: i18n.t('histogramPercentShort'), value: 'percent' },
            { label: i18n.t('histogramDensity'), value: 'density' },
        ],
        state.normalization,
        (mode) => { state.normalization = mode; this._scheduleHistogramRecompute(panelId, { immediate: true }); },
    ));
    // Stacked needs at least two visible signals to mean anything.
    const visibleCount = (plot.traces || []).filter(t => this._isVisible(t)).length;
    options.appendChild(segmented(
        [
            { label: i18n.t('histogramOverlay'), value: 'overlay' },
            { label: i18n.t('histogramGrouped'), value: 'grouped' },
            { label: i18n.t('histogramStacked'), value: 'stacked', title: i18n.t('histogramStackedTip'), disabled: visibleCount < 2 },
        ],
        state.barMode,
        (mode) => { state.barMode = mode; this._renderHistogramOptionsPanel(panelId, plot); this._scheduleHistogramRecompute(panelId, { immediate: true }); },
    ));

    // Sample summary.
    section('histogramSummary');
    const summaryBox = document.createElement('div');
    summaryBox.className = 'hist-summary';
    options.appendChild(summaryBox);
    this._syncHistogramSummary(plot);
};

proto._syncHistogramOptionsPanel = function(plot) {
    const options = plot?.histogramContainer?.querySelector('.hist-options');
    if (!options) return;
    const state = this._ensureHistogramState(plot);
    const isCal = this._histogramUsesCalendarTime(plot);
    const [lo, hi] = this._activeHistogramRange(plot);
    const vals = { x1: lo, x2: hi };
    for (const key of ['x1', 'x2']) {
        const input = options.querySelector(`input[data-hist-role="input"][data-hist-key="${key}"]`);
        const slider = options.querySelector(`input[data-hist-role="slider"][data-hist-key="${key}"]`);
        if (input && document.activeElement !== input) {
            input.value = isCal ? histMsToDatetimeInput(vals[key]) : formatHistInputValue(vals[key]);
        }
        if (slider && document.activeElement !== slider && Number.isFinite(vals[key])) {
            slider.value = String(vals[key]);
        }
    }
};

proto._syncHistogramSummary = function(plot, spec = plot?._histSpec, unit = '') {
    const box = plot?.histogramContainer?.querySelector('.hist-summary');
    if (!box) return;
    const summary = plot?._histSummary || [];
    if (!summary.length) { box.textContent = ''; return; }
    box.innerHTML = summary.map(s => {
        const parts = s.isTotal
            ? [`${i18n.t('histogramSummaryBinned')}: ${s.nBinned}`]
            : [
                `${i18n.t('histogramSummaryFinite')}: ${s.nFinite}`,
                `${i18n.t('histogramSummaryInvalid')}: ${s.nInvalid}`,
                `${i18n.t('histogramSummaryBinned')}: ${s.nBinned}`,
            ];
        if (s.underflow) parts.push(`↤ ${s.underflow}`);
        if (s.overflow) parts.push(`↦ ${s.overflow}`);
        return `<div class="hist-summary-row"><strong>${s.name}</strong><br>${parts.join(' · ')}</div>`;
    }).join('');
    void spec; void unit;
};

}

// Display-only rounding for the option-panel number inputs (full precision is
// kept in state). Mirrors the FFT helpers.
function formatHistInputValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(2);
    return String(Number(n.toFixed(2)));
}

// Calendar axes store epoch ms rendered as naive UTC (see _plotlyTimeValue),
// so the datetime-local inputs use the same UTC convention as the axis ticks.
function histMsToDatetimeInput(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    const date = new Date(n);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 19);
}

function histDatetimeInputToMs(text) {
    if (!text) return NaN;
    const ms = Date.parse(`${text}Z`);
    return Number.isFinite(ms) ? ms : NaN;
}
