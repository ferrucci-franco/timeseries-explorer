import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    collectMissingDays,
    computeDefiniteIntegral,
    INTEGRAL_MISSING_POLICIES,
    reduceDailyIntegral,
} from '../../compute/kernels/definite-integral.js';
import {
    axisDuration,
    buildIntegralExportTable,
    describeUnitScaling,
    buildIntegralPresentation,
    defaultIntegralState,
    formatIntegralDuration,
    formatIntegralNumber,
    integralPieAllowed,
    integralResultUnit,
    normalizeIntegralState,
    UNKNOWN_UNIT,
    timeBaseForAxis,
} from '../../utils/integral-presentation.js';

// The Integral analysis: one bar per signal, each bar the definite integral of
// that signal over the selected range. Written for power-grid series — a set of
// generators in MW integrates to energies in MWh that the bars compare directly.
//
// The temporal selection (Full/Selection, the green band, its drag handles) is
// deliberately identical to FFT, Histogram, Heatmap, Correlation and Profile:
// same shapes, same hit tolerance, same cursor classes. A user who learned it
// once has learned it everywhere.

const INTEGRAL_LAYOUTS = new Set(['horizontal', 'vertical']);
const INTEGRAL_RECOMPUTE_DEBOUNCE_MS = 150;

const fallbackText = {
    integralMode: 'Integral (totals per signal)',
    integralModeLabel: 'Integral',
    integralDrop: 'Drop one or more signals to total',
    integralOptions: 'Options',
    integralReset: 'Reset',
    integralResetTip: 'Reset the range and the result view',
    integralHideTime: 'Hide time series',
    integralShowTime: 'Show time series',
    integralIntegration: 'Integration',
    integralMethod: 'Rule',
    integralTrapezoidal: 'Trapezoidal',
    integralRectangular: 'Rectangular',
    integralResultUnit: 'Integral unit',
    integralPerHour: 'per hour ( · h )',
    integralPerSecond: 'per second ( · s )',
    integralScale: 'Scale',
    integralScaleAuto: 'Auto',
    integralDataHandling: 'Data handling',
    integralDiscardEnds: 'Discard incomplete start/end days',
    integralDiscardEndsTip: 'Drop the first and last calendar day (UTC) when the data does not cover them end to end. Only the two ends — an incomplete day in the middle is the Missing values setting.',
    integralMissing: 'Missing values',
    integralMissingZero: 'Assume zero',
    integralMissingInterpolate: 'Interpolate across',
    integralMissingDiscardOwn: 'Discard the whole day (this signal)',
    integralMissingDiscardAll: 'Discard the whole day (all signals)',
    integralMissingTip: 'What to do where the file has no data — an empty cell or a missing row. Discarding a day removes it from the domain of integration; the whole-day options need a calendar axis.',
    integralDisplay: 'Display',
    integralOrientation: 'Bars',
    integralVertical: 'Vertical',
    integralHorizontal: 'Horizontal',
    integralShowPie: 'Show pie chart',
    integralShowValues: 'Show values on bars',
    integralSort: 'Order',
    integralSortPanel: 'As in panel',
    integralSortDesc: 'Largest first',
    integralSortAsc: 'Smallest first',
    integralSummary: 'Summary',
    integralAxisTitle: 'Integral',
    integralCalculating: 'Calculating…',
    integralNoData: 'no data in the range',
    integralAllDiscarded: 'every day was discarded',
    integralUnsorted: 'timestamps are not in chronological order',
    integralIndexAxis: 'no time axis: totals are per sample, not per second',
    integralAssumedSeconds: 'the time axis has no known unit; seconds assumed',
    integralMixedUnits: 'signals have different units — the totals are not comparable',
    integralUnknownUnits: 'some signals carry no unit',
    integralUnequalCoverage: 'signals cover different durations — compare with care',
    integralUncovered: 'missing time in the range: {time}. It contributed nothing, so the totals are lower bounds.',
    integralUncoveredInterpolated: 'missing time in the range: {time}. It was crossed by linear interpolation.',
    integralLazyUnsupported: 'this large (lazy) signal has no exact source column, or its file has no calendar time axis',
    integralPieMixedSigns: 'the pie is hidden: the totals do not all share one sign, and a pie cannot show a sum with cancellations',
    integralPieMixedUnits: 'the pie is hidden: the signals do not share one unit',
    integralCoverage: 'Coverage',
    integralDiscarded: 'discarded',
    integralDays: 'days',
    integralSamples: 'samples',
    integralValue: 'Integral',
    integralSignal: 'Signal',
    integralUnitOverride: 'Unit of the signals',
    integralUnitOverrideTip: 'Many files declare no unit at all — a PyPSA netCDF carries none — and the panel will not invent one: the totals then read [?]·h. Type the unit here and every total, mean, axis and legend in THIS panel reads it: MW gives MW·h, MW·h/d and MW. It is a label, not a conversion — no number changes, only what they are called. It applies to every signal in the panel, replacing whatever the files said, and it lives in this panel alone: other panels and the sidebar are untouched. Leave it empty to go back to reading the files.',
    integralUnitHintScales: 'Totals read {unit} · scaled: {examples}',
    integralUnitHintFlat: 'Totals read {unit} · scaling shown as ×10ⁿ',
    integralUnitDeclared: 'Unit {unit} was typed into this panel, not read from the files.',
    integralNoUnits: 'no signal declares a unit, so the totals are shown as [?]·h — type the unit under Integration to name them',
    integralExtendLast: 'Each sample lasts until the next one',
    integralExtendLastTip: 'Does a timestamp mark an instant, or the stretch of time that follows it? OFF — instants: the signal is only known AT each sample, the area between two of them is a trapezoid, and nothing can be said past the last one. 24 hourly samples then span 23 h. ON — stretches: each sample holds until the next, so the last one holds for one more step. The same 24 samples span 24 h, and a day of quarter-hours totals exactly 24 h. Energy-system tools such as PyPSA write the second kind, where every snapshot stands for a period and carries a weighting; a datalogger recording a temperature usually writes the first. Needs a time axis with a regular step — without one there is no length to give the last sample.',
    integralStatusOne: '1 signal totalled over {time}',
    integralStatusMany: '{count} signals totalled over {time}',
    integralStatusMixed: '{count} signals totalled, each over a different duration — see the summary',
    integralWarningSeePanel: 'Warning: see the message in the Integral side panel',
    integralQuantity: 'Show',
    integralQuantityTotal: 'Total',
    integralQuantityPerDay: 'Per day',
    integralQuantityMean: 'Mean value',
    integralQuantityTip: 'What the bars carry. All three appear in the summary and the hover regardless.',
    integralPerDay: 'Per day',
    integralMean: 'Mean value',
    integralLazyFailed: 'the file could not be queried for this total',
};

function text(key) {
    const translated = i18n.t(key);
    return translated && translated !== key ? translated : (fallbackText[key] || key);
}

function finiteOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function hasFinite(value) {
    return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function utcInputValue(ms) {
    const number = Number(ms);
    if (!Number.isFinite(number)) return '';
    const date = new Date(number);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 19);
}

function utcInputMs(value) {
    if (!value) return NaN;
    const number = Date.parse(`${value}Z`);
    return Number.isFinite(number) ? number : NaN;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

// Formatting adapters: the pure layer takes the locale and the translated word
// for "samples" as data, so it never reaches for i18n itself.
function formatNumber(value, digits = 4) {
    return formatIntegralNumber(value, digits, i18n.currentLang || 'en');
}

function formatDuration(seconds, timeKind) {
    return formatIntegralDuration(seconds, timeKind, {
        locale: i18n.currentLang || 'en',
        samples: text('integralSamples'),
    });
}

// Formats what axisDuration() converted: the pure layer decides the unit, this
// side only renders it in the user's language.
function formatAxisDuration(model, rawTime) {
    const { seconds, kind } = axisDuration(model?.base, model?.result?.timeKind, rawTime);
    return formatDuration(seconds, kind);
}

function traceIsLazy(manager, trace) {
    return !!manager.files.get(trace.fileId)?.data?._duckdb;
}

export function installPlotIntegralMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._defaultIntegralState = function() {
    return defaultIntegralState();
};

proto._normalizeIntegralState = function(raw = {}) {
    return normalizeIntegralState(raw, INTEGRAL_MISSING_POLICIES);
};

proto._ensureIntegralState = function(plot) {
    if (!plot) return this._defaultIntegralState();
    const current = plot.integral;
    const normalized = this._normalizeIntegralState(current || {});
    if (current && typeof current === 'object' && !Array.isArray(current)) {
        // Controls hold a reference to this object; preserving its identity is
        // what lets their handlers keep writing to the live state.
        Object.assign(current, normalized);
        return current;
    }
    plot.integral = normalized;
    return normalized;
};

proto._invalidateIntegralForDataChange = function(plot) {
    if (!plot || plot.mode !== 'integral') return;
    clearTimeout(plot._integralRecomputeTimer);
    plot._integralToken = (plot._integralToken || 0) + 1;
    const state = this._ensureIntegralState(plot);
    state.warnings = [];
    plot._integralModels = [];
    this._setIntegralStatus?.(plot, '', [], 'muted', []);
};

// ─── Time base and units ──────────────────────────────────────────────────

// How a trace's abscissa converts to seconds, and whether that conversion is
// known or merely assumed. `assumed` is what raises the panel warning: an
// integral in "MW·h" over an axis whose unit nobody declared is a guess, and it
// should say so rather than look authoritative.
proto._integralTimeBase = function(trace) {
    const kind = this._fftTimeKind(trace.fileId);
    return timeBaseForAxis(kind, this._timeUnitLabel(trace.fileId));
};

// The unit the FILES declare for the visible signals, as the placeholder to
// show behind an empty override field: it says what is being replaced. Empty
// when nothing declares one, or when they disagree — there is then no single
// thing the field would be overriding.
proto._integralDetectedUnits = function(plot) {
    const units = new Set();
    for (const trace of plot?.traces || []) {
        if (!this._isVisible(trace)) continue;
        const unit = this._integralValueUnit(trace);
        if (unit) units.add(unit);
    }
    return units.size === 1 ? [...units][0] : '';
};

proto._integralValueUnit = function(trace) {
    const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
    return variable ? this._extractUnit(variable.description) : '';
};

// The unit the totals carry: the signal's unit times the chosen time unit. Same
// spelling the calendar heatmap already uses for its per-cell integral, so a
// power in MW reads as MW·h in both places.
proto._integralResultUnit = function(unit, state, timeKind) {
    return integralResultUnit(unit, state.integralUnit, timeKind, text('integralSamples'));
};

// ─── Traces and chart ─────────────────────────────────────────────────────

proto._addIntegralTrace = function(panelId, varName, panelEl, plot) {
    if (plot.traces.find(trace => trace.varName === varName && trace.fileId === this.activeFileId)) return;
    if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
    plot.traces.push({
        varName,
        color: this._nextTraceColor(plot.traces),
        fileId: this.activeFileId,
        axis: 'y',
    });
    this._ensureIntegralState(plot);
    if (!plot.div) this._createIntegralChart(panelId, panelEl);
    else {
        this._refreshIntegralTimePlot(panelId, plot, { preserveView: true });
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }
};

proto._createIntegralChart = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    if (!this._hasContent(plot)) return;
    const state = this._ensureIntegralState(plot);
    this._autoLimitAnalysisRange(plot, state, 'integral');
    const restoreView = plot._pendingViewRestore || null;
    delete plot._pendingViewRestore;

    const placeholder = panelEl.querySelector('.layout-panel-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    panelEl.querySelector('.integral-container')?.remove();

    const container = document.createElement('div');
    container.className = `hist-container integral-container hist-layout-${state.layout}${state.timeSeriesHidden ? ' hist-time-series-hidden' : ''}`;
    container.style.setProperty('--hist-split', `${Math.round(state.split * 1000) / 10}%`);
    const topbar = document.createElement('div');
    topbar.className = 'hist-topbar';
    const makeButton = (className, label, title, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
        return button;
    };
    const layoutGroup = document.createElement('div');
    layoutGroup.className = 'hist-topbar-group';
    const timeButton = makeButton('hist-tool-btn hist-time-series-btn',
        state.timeSeriesHidden ? text('integralShowTime') : text('integralHideTime'),
        state.timeSeriesHidden ? text('integralShowTime') : text('integralHideTime'),
        () => this._toggleIntegralTimeSeries(panelId));
    timeButton.classList.toggle('active', state.timeSeriesHidden);
    timeButton.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    layoutGroup.append(
        makeButton('hist-tool-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureIntegralState(plot).layout;
            this._setIntegralLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        }),
        timeButton,
    );
    const actionGroup = document.createElement('div');
    actionGroup.className = 'hist-topbar-group';
    const optionsButton = makeButton('hist-tool-btn hist-options-btn', text('integralOptions'), text('integralOptions'), () => this._toggleIntegralOptions(panelId));
    optionsButton.classList.toggle('active', state.optionsVisible);
    optionsButton.setAttribute('aria-pressed', String(state.optionsVisible));
    actionGroup.append(
        makeButton('hist-tool-btn', text('integralReset'), text('integralResetTip'), () => this._resetIntegralView(panelId)),
        optionsButton,
    );
    const status = document.createElement('span');
    status.className = 'hist-status';
    status.setAttribute('aria-live', 'polite');
    topbar.append(layoutGroup, actionGroup, status);

    const workspace = document.createElement('div');
    workspace.className = 'hist-workspace';
    const plotArea = document.createElement('div');
    plotArea.className = 'hist-plot-area';
    const timePane = document.createElement('div');
    timePane.className = 'hist-pane hist-time-pane';
    const analysisPane = document.createElement('div');
    analysisPane.className = 'hist-pane hist-hist-pane';
    const splitter = document.createElement('div');
    splitter.className = 'hist-splitter';
    splitter.setAttribute('role', 'separator');
    const timeDiv = document.createElement('div');
    timeDiv.className = 'plotly-container plotly-mode-integral-time';
    // The pie gets its own Plotly div in its own pane behind its own splitter,
    // rather than sharing the bars' axes through domain juggling: a pie squeezed
    // into a corner of the bar chart cannot be resized, and the user already
    // knows how to drag a splitter from the time-series one above.
    //
    // The inner split runs PERPENDICULAR to the outer one, so each pane stays as
    // close to square as the shell allows: rows outside ⇒ columns inside.
    const resultArea = document.createElement('div');
    resultArea.className = 'integral-result-area';
    const barsPane = document.createElement('div');
    barsPane.className = 'integral-pane integral-bars-pane';
    const piePane = document.createElement('div');
    piePane.className = 'integral-pane integral-pie-pane';
    const pieSplitter = document.createElement('div');
    pieSplitter.className = 'integral-splitter';
    pieSplitter.setAttribute('role', 'separator');
    const integralDiv = document.createElement('div');
    integralDiv.className = 'plotly-container plotly-mode-integral-analysis';
    const pieDiv = document.createElement('div');
    pieDiv.className = 'plotly-container plotly-mode-integral-pie';
    timePane.appendChild(timeDiv);
    barsPane.appendChild(integralDiv);
    piePane.appendChild(pieDiv);
    resultArea.append(barsPane, pieSplitter, piePane);
    analysisPane.appendChild(resultArea);
    plotArea.append(timePane, splitter, analysisPane);
    const options = document.createElement('aside');
    options.className = 'hist-options fft-options integral-options';
    options.hidden = !state.optionsVisible;
    workspace.append(plotArea, options);
    container.append(topbar, workspace);
    panelEl.appendChild(container);

    plot.integralContainer = container;
    plot.integralDiv = integralDiv;
    plot.integralPieDiv = pieDiv;
    plot.div = timeDiv;
    container.style.setProperty('--integral-pie-split', `${Math.round(state.pieSplit * 1000) / 10}%`);
    this._applyIntegralPieVisibility(plot, false);
    this._renderIntegralOptionsPanel(panelId, plot);

    const config = this._getPlotlyConfig();
    Promise.all([
        Plotly.newPlot(timeDiv, this._buildIntegralTimeTraces(plot), this._buildIntegralTimeLayout(plot), config),
        Plotly.newPlot(integralDiv, [], this._buildIntegralLayout(plot, { models: [] }), config),
        Plotly.newPlot(pieDiv, [], this._buildIntegralPieLayout(plot), config),
    ]).then(() => {
        this._refreshActionBtns(panelId);
        const viewPromise = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
        Promise.resolve(viewPromise).then(() => this._refreshTimeseriesVisuals(panelId, plot));
        this._installIntegralPlotHandlers(panelId, plot);
        this._installCursorHandlers?.(panelId, plot);
        this._installIntegralSelectionHandlers(panelId, plot);
        this._installIntegralSplitterHandlers(panelId, plot);
        this._installIntegralPieSplitterHandlers(panelId, plot);
        this._installWheelPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
        this._installRightButtonPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
        this._syncCursorDisplay?.(panelId, plot);
        this._scheduleIntegralRecompute(panelId, { immediate: true });
        let timer;
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                Plotly.Plots.resize(timeDiv);
                Plotly.Plots.resize(integralDiv);
                Plotly.Plots.resize(pieDiv);
            }, 50);
        });
        observer.observe(panelEl);
        plot.resizeObserver = observer;
    });
};

proto._buildIntegralTimeTraces = function(plot) {
    const state = this._ensureIntegralState(plot);
    const visualRange = state.autoRangeWarning ? this._activeIntegralRange(plot) : null;
    const built = plot.traces.map((trace, index) => this._buildTimeTrace(trace, visualRange, plot, index)).filter(Boolean);
    return this._applyIntegralLegendUnit(plot, built);
};

// A unit declared in this panel reaches this panel's legend too, but no
// further. The rewrite happens HERE rather than in the shared _traceName
// because the override is panel-local by design: teaching the global name
// builder about it would let any other panel inherit a unit its own file never
// declared. Only runs when the user asked for units in legends at all.
proto._applyIntegralLegendUnit = function(plot, built) {
    const declared = String(this._ensureIntegralState(plot).unitOverride || '').trim();
    if (!declared || !this.legendUnits) return built;
    for (let index = 0; index < built.length; index++) {
        const trace = plot.traces[index];
        if (!trace || !built[index]) continue;
        // _traceName already appended the file's unit when there was one; the
        // bare name is the thing to re-label, so it is rebuilt from scratch.
        built[index].name = `${this._traceName(trace.varName, trace.fileId, { units: false })} [${declared}]`;
    }
    return built;
};

proto._buildIntegralTimeLayout = function(plot) {
    const layout = this._buildTimeLayout(plot);
    layout.shapes = this._integralSelectionShapes(plot);
    layout.margin = { ...(layout.margin || {}), t: 8 };
    layout.hovermode = false;
    return layout;
};

proto._refreshIntegralTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
    if (!plot?.div || plot.mode !== 'integral') return Promise.resolve();
    const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
    const yRange = options.preserveView ? plot.div._fullLayout?.yaxis?.range : null;
    const layout = this._buildIntegralTimeLayout(plot);
    if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
    if (Array.isArray(yRange)) layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
    return Plotly.react(plot.div, this._buildIntegralTimeTraces(plot), layout, this._getPlotlyConfig()).then(() => {
        this._installLegendHoverHint(plot.div);
        this._installIntegralSelectionHandlers(panelId, plot);
        this._refreshTimeseriesVisuals(panelId, plot);
    });
};

proto._installIntegralPlotHandlers = function(panelId, plot) {
    if (!plot?.div || !plot?.integralDiv) return;
    if (plot._integralHandlerTimeDiv === plot.div && plot._integralHandlerAnalysisDiv === plot.integralDiv) return;
    plot._integralHandlerTimeDiv = plot.div;
    plot._integralHandlerAnalysisDiv = plot.integralDiv;
    let lastShift = false;
    plot.div.addEventListener('mousedown', event => { lastShift = !!event.shiftKey; }, { capture: true });
    plot.div.addEventListener('contextmenu', event => {
        if (this._handleIntegralLegendContextMenu(panelId, plot, plot.div, event)) return;
        event.preventDefault();
    });
    plot.div.on('plotly_legendclick', eventData => {
        if (eventData.event?.button !== undefined && eventData.event.button !== 0) {
            lastShift = false;
            return false;
        }
        const name = eventData.data?.[eventData.curveNumber]?.name;
        this._handleIntegralLegendClick(panelId, plot, name, !!(eventData.event?.shiftKey || lastShift));
        lastShift = false;
        return false;
    });
    plot.div.on('plotly_legenddoubleclick', () => false);
    plot.div.on('plotly_afterplot', () => this._installLegendHoverHint(plot.div));
    plot.div.on('plotly_relayout', eventData => this._onRelayout(panelId, eventData));
    plot.div.on('plotly_doubleclick', () => { this._autoScalePlotTimeOnly(plot); return false; });
    plot.integralDiv.on('plotly_doubleclick', () => {
        setTimeout(() => {
            if (this.plots.get(panelId) === plot) this._resetIntegralAnalysisView(plot);
        }, 0);
        return false;
    });
};

proto._handleIntegralLegendClick = function(panelId, plot, name, shiftClick = false) {
    const trace = (plot.traces || []).find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
    if (!trace) return;
    if (shiftClick) {
        this._removeIntegralTraceFromLegend(panelId, plot, trace);
        return;
    }
    trace.visible = trace.visible === 'legendonly' ? true : 'legendonly';
    this._refreshIntegralTimePlot(panelId, plot, { preserveView: true });
    this._scheduleIntegralRecompute(panelId, { immediate: true });
};

proto._handleIntegralLegendContextMenu = function(panelId, plot, div, event) {
    const fullTrace = this._legendFullTraceFromContextEvent?.(div, event);
    const name = fullTrace?.name;
    const trace = (plot.traces || []).find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
    if (!trace) return false;
    event.preventDefault();
    event.stopPropagation();
    this._showLegendTraceMenu(event, trace, {
        onShow: () => this._setIntegralLegendSelection(panelId, plot, trace, 'show'),
        onHide: () => this._setIntegralLegendSelection(panelId, plot, trace, 'hide'),
        onOnly: () => this._setIntegralLegendSelection(panelId, plot, trace, 'only'),
        onRemove: () => this._removeIntegralTraceFromLegend(panelId, plot, trace),
    });
    return true;
};

proto._setIntegralLegendSelection = function(panelId, plot, selectedTrace, action) {
    for (const trace of plot.traces || []) {
        let visible = trace.visible === 'legendonly' || trace.visible === false ? 'legendonly' : true;
        if (action === 'show' && trace === selectedTrace) visible = true;
        if (action === 'hide' && trace === selectedTrace) visible = 'legendonly';
        if (action === 'only') visible = trace === selectedTrace ? true : 'legendonly';
        trace.visible = visible;
    }
    this._refreshIntegralTimePlot(panelId, plot, { preserveView: true });
    this._scheduleIntegralRecompute(panelId, { immediate: true });
};

proto._removeIntegralTraceFromLegend = function(panelId, plot, trace) {
    const index = (plot.traces || []).indexOf(trace);
    if (index >= 0) plot.traces.splice(index, 1);
    if (!plot.traces.length) this._clearPanel(panelId);
    else this._rebuildPanel(panelId, { preserveView: true });
};

// ─── Temporal selection (identical mechanic to FFT / Histogram / Profile) ──

proto._integralDomain = function(plot) {
    const arrays = [];
    for (const trace of plot?.traces || []) {
        const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        if (values?.length) arrays.push(values);
    }
    const extent = this._finiteSortedExtent(arrays);
    return extent ? { min: extent.min, max: extent.max } : null;
};

proto._activeIntegralRange = function(plot) {
    const state = this._ensureIntegralState(plot);
    const domain = this._integralDomain(plot);
    if (state.rangeFull) {
        if (domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) return [domain.min, domain.max];
        return [0, 1];
    }
    let lo = hasFinite(state.x1) ? Number(state.x1) : NaN;
    let hi = hasFinite(state.x2) ? Number(state.x2) : NaN;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (lo > hi) [lo, hi] = [hi, lo];
    if (domain) {
        lo = Math.max(domain.min, Math.min(domain.max, lo));
        hi = Math.max(domain.min, Math.min(domain.max, hi));
    }
    return [lo, hi];
};

proto._integralSelectionShapes = function(plot) {
    if (this._ensureIntegralState(plot).rangeFull) return [];
    const [lo, hi] = this._activeIntegralRange(plot);
    const firstTrace = plot.traces?.[0];
    const timeVar = firstTrace ? this._getTimeVar(firstTrace.fileId) : null;
    const x0 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, lo, timeVar) : lo;
    const x1 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, hi, timeVar) : hi;
    const color = '#43a047';
    return [
        { type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(67,160,71,0.14)', line: { width: 0 }, layer: 'below' },
        { type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color, width: 2 } },
        { type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color, width: 2 } },
    ];
};

proto._updateIntegralSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || plot.mode !== 'integral') return;
    Plotly.relayout(plot.div, { shapes: this._integralSelectionShapes(plot) });
    this._syncIntegralOptionsPanel(plot);
};

proto._installIntegralSelectionHandlers = function(panelId, plot) {
    if (!plot?.div || plot._integralSelectionDiv === plot.div) return;
    plot._integralSelectionDiv = plot.div;
    let dragging = null;
    const hitTest = (event) => {
        if (this._ensureIntegralState(plot).rangeFull) return null;
        if (!this._eventInsidePlotArea(plot.div, event)) return null;
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x)) return null;
        const domain = this._integralDomain(plot);
        if (!domain) return null;
        const [lo, hi] = this._activeIntegralRange(plot);
        const axis = plot.div._fullLayout?.xaxis;
        const span = Math.abs(this._coerceAxisValue(axis?.range?.[1]) - this._coerceAxisValue(axis?.range?.[0])) || Math.abs(hi - lo) || 1;
        const tolerance = Math.max((12 / (axis?._length || 1)) * span, span * 1e-6);
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
        const [lo, hi] = this._activeIntegralRange(plot);
        dragging = { hit, startX: x, startLo: lo, startHi: hi };
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        document.body.classList.add('fft-selection-dragging');
        document.body.classList.toggle('fft-selection-moving', hit === 'move');
    }, true);
    const onMove = (event) => {
        if (!dragging || !plot.div) return;
        const domain = this._integralDomain(plot);
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x) || !domain) return;
        const state = this._ensureIntegralState(plot);
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
        state.autoRangeWarning = null;
        state.autoRangeLimited = false;
        state.x1 = Math.max(domain.min, Math.min(domain.max, lo));
        state.x2 = Math.max(domain.min, Math.min(domain.max, hi));
        this._updateIntegralSelectionShapes(panelId, plot);
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('fft-selection-dragging', 'fft-selection-moving');
        if (plot.div) setCursorHint(null);
        this._scheduleIntegralRecompute(panelId);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._integralSelectionDocListeners = { move: onMove, up: onUp };
};

proto._setIntegralRangeMode = function(panelId, full) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const state = this._ensureIntegralState(plot);
    if (state.rangeFull === full) return;
    state.autoRangeWarning = null;
    state.autoRangeLimited = false;
    state.rangeFull = full;
    if (!full) {
        const axis = plot.div?._fullLayout?.xaxis;
        const domain = this._integralDomain(plot);
        let lo = this._coerceAxisValue(axis?.range?.[0]);
        let hi = this._coerceAxisValue(axis?.range?.[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
        if (domain) {
            lo = Math.max(domain.min, Math.min(domain.max, lo));
            hi = Math.max(domain.min, Math.min(domain.max, hi));
        }
        if (lo > hi) [lo, hi] = [hi, lo];
        state.x1 = lo;
        state.x2 = hi;
    }
    this._updateIntegralSelectionShapes(panelId, plot);
    this._renderIntegralOptionsPanel(panelId, plot);
    this._scheduleIntegralRecompute(panelId, { immediate: true });
};

// ─── Layout controls ──────────────────────────────────────────────────────

proto._setIntegralLayout = function(panelId, layout) {
    const plot = this.plots.get(panelId);
    if (!plot?.integralContainer || !INTEGRAL_LAYOUTS.has(layout)) return;
    this._ensureIntegralState(plot).layout = layout;
    plot.integralContainer.classList.toggle('hist-layout-horizontal', layout === 'horizontal');
    plot.integralContainer.classList.toggle('hist-layout-vertical', layout === 'vertical');
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.integralDiv);
    if (plot.integralPieDiv) Plotly.Plots.resize(plot.integralPieDiv);
};

proto._toggleIntegralTimeSeries = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.integralContainer) return;
    const state = this._ensureIntegralState(plot);
    state.timeSeriesHidden = !state.timeSeriesHidden;
    plot.integralContainer.classList.toggle('hist-time-series-hidden', state.timeSeriesHidden);
    const button = plot.integralContainer.querySelector('.hist-time-series-btn');
    if (button) {
        button.textContent = state.timeSeriesHidden ? text('integralShowTime') : text('integralHideTime');
        button.title = button.textContent;
        button.classList.toggle('active', state.timeSeriesHidden);
        button.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    }
    if (!state.timeSeriesHidden && plot.div) {
        Plotly.Plots.resize(plot.div);
        this._refreshPanelDomOverlays(plot);
    }
    if (plot.integralDiv) Plotly.Plots.resize(plot.integralDiv);
    if (plot.integralPieDiv) Plotly.Plots.resize(plot.integralPieDiv);
};

proto._toggleIntegralOptions = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.integralContainer) return;
    const state = this._ensureIntegralState(plot);
    state.optionsVisible = !state.optionsVisible;
    const options = plot.integralContainer.querySelector('.hist-options');
    if (options) options.hidden = !state.optionsVisible;
    const button = plot.integralContainer.querySelector('.hist-options-btn');
    if (button) {
        button.classList.toggle('active', state.optionsVisible);
        button.setAttribute('aria-pressed', String(state.optionsVisible));
    }
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.integralDiv);
    if (plot.integralPieDiv) Plotly.Plots.resize(plot.integralPieDiv);
};

proto._resetIntegralView = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;
    const state = this._ensureIntegralState(plot);
    state.rangeFull = true;
    state.autoRangeLimited = false;
    state.autoRangeWarning = null;
    state.x1 = null;
    state.x2 = null;
    this._updateIntegralSelectionShapes(panelId, plot);
    this._renderIntegralOptionsPanel(panelId, plot);
    this._autoScalePlotTimeOnly(plot);
    this._resetIntegralAnalysisView(plot);
    this._scheduleIntegralRecompute(panelId, { immediate: true });
};

proto._resetIntegralAnalysisView = function(plot) {
    if (!plot?.integralDiv) return Promise.resolve();
    return Plotly.relayout(plot.integralDiv, { 'xaxis.autorange': true, 'yaxis.autorange': true });
};

proto._autoScaleIntegralPanel = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div) return Promise.resolve();
    return Promise.all([
        this._autoScalePlotTimeOnly(plot),
        this._resetIntegralAnalysisView(plot),
    ]);
};

proto._autoScaleIntegralAxis = function(plot, axis) {
    if (!plot?.integralDiv) return Promise.resolve();
    return Plotly.relayout(plot.integralDiv, axis === 'x' ? { 'xaxis.autorange': true } : { 'yaxis.autorange': true });
};

proto._installIntegralSplitterHandlers = function(panelId, plot) {
    const splitter = plot?.integralContainer?.querySelector('.hist-splitter');
    if (!splitter || splitter._integralBound) return;
    splitter._integralBound = true;
    let dragging = false;
    const apply = (event) => {
        if (!plot.integralContainer) return;
        const state = this._ensureIntegralState(plot);
        const area = plot.integralContainer.querySelector('.hist-plot-area');
        const rect = area?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const fraction = state.layout === 'vertical'
            ? (event.clientY - rect.top) / rect.height
            : (event.clientX - rect.left) / rect.width;
        state.split = Math.max(0.2, Math.min(0.8, fraction));
        plot.integralContainer.style.setProperty('--hist-split', `${Math.round(state.split * 1000) / 10}%`);
        Plotly.Plots.resize(plot.div);
        Plotly.Plots.resize(plot.integralDiv);
        if (plot.integralPieDiv) Plotly.Plots.resize(plot.integralPieDiv);
    };
    splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
    const onMove = event => { if (dragging) apply(event); };
    const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._integralSplitterDocListeners = { move: onMove, up: onUp };
    void panelId;
};

// The bars|pie splitter. Same mechanic as the one above it, on the PERPENDICULAR
// axis: with rows outside the split runs left-right, with columns outside it
// runs top-bottom, so neither pane is ever squeezed into a sliver.
proto._installIntegralPieSplitterHandlers = function(panelId, plot) {
    const splitter = plot?.integralContainer?.querySelector('.integral-splitter');
    if (!splitter || splitter._integralPieBound) return;
    splitter._integralPieBound = true;
    let dragging = false;
    const apply = (event) => {
        if (!plot.integralContainer) return;
        const state = this._ensureIntegralState(plot);
        const area = plot.integralContainer.querySelector('.integral-result-area');
        const rect = area?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const fraction = state.layout === 'vertical'
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - rect.top) / rect.height;
        state.pieSplit = Math.max(0.2, Math.min(0.85, fraction));
        plot.integralContainer.style.setProperty('--integral-pie-split', `${Math.round(state.pieSplit * 1000) / 10}%`);
        Plotly.Plots.resize(plot.integralDiv);
        if (plot.integralPieDiv) Plotly.Plots.resize(plot.integralPieDiv);
    };
    splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
    const onMove = event => { if (dragging) apply(event); };
    const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._integralPieSplitterDocListeners = { move: onMove, up: onUp };
    void panelId;
};

// ─── Computation ──────────────────────────────────────────────────────────

proto._scheduleIntegralRecompute = function(panelId, options = {}) {
    const plot = this.plots.get(panelId);
    if (!plot?.integralDiv || plot.mode !== 'integral') return;
    clearTimeout(plot._integralRecomputeTimer);
    const run = () => {
        const state = this._ensureIntegralState(plot);
        const adjusted = this._autoLimitAnalysisRange(plot, state, 'integral');
        if (adjusted) this._updateIntegralSelectionShapes(panelId, plot);
        this._setIntegralStatus(plot, text('integralCalculating'), [], 'loading', []);
        this._setIntegralComputing(plot, true);
        plot._integralRecomputeTimer = setTimeout(() => {
            if (plot.mode === 'integral' && plot.integralDiv) {
                this._recomputeIntegral(panelId, plot);
            }
        }, 0);
    };
    if (options.immediate) run();
    else plot._integralRecomputeTimer = setTimeout(run, INTEGRAL_RECOMPUTE_DEBOUNCE_MS);
};

proto._integralSeriesForTrace = function(trace, range = null) {
    const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName) || [];
    const values = this._getTransformedVariableData(trace.fileId, trace.varName) || [];
    const length = Math.min(times.length || 0, values.length || 0);
    if (!length || !range) return { times, values };
    let [lower, upper] = range;
    if (lower > upper) [lower, upper] = [upper, lower];
    // Keep one neighbour on each side. The integral kernel clips those edge
    // segments to the exact requested range, preserving interpolation and the
    // nominal-step estimate without scanning the rest of the source.
    const start = Math.max(0, Math.min(length, this._lowerBound(times, lower)) - 1);
    const end = Math.max(start, Math.min(length, this._upperBound(times, upper) + 1));
    return {
        times: times.slice(start, end),
        values: values.slice(start, end),
    };
};

proto._recomputeIntegral = async function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.integralDiv || plot.mode !== 'integral') return;
    const token = (plot._integralToken || 0) + 1;
    plot._integralToken = token;
    const state = this._ensureIntegralState(plot);
    const range = state.rangeFull ? null : this._activeIntegralRange(plot);
    const warnings = state.autoRangeWarning ? [state.autoRangeWarning] : [];
    const notes = [];
    const models = [];

    // Eager traces are read from memory; lazy ones are asked of DuckDB. The two
    // produce the same result shape, so everything downstream is shared.
    const eager = [];
    const lazy = [];
    for (let traceIndex = 0; traceIndex < (plot.traces || []).length; traceIndex++) {
        const trace = plot.traces[traceIndex];
        if (!this._isVisible(trace)) continue;
        const name = this._traceName(trace.varName, trace.fileId);
        const base = this._integralTimeBase(trace);
        if (traceIsLazy(this, trace)) {
            lazy.push({ trace, traceIndex, name, base });
            continue;
        }
        const selected = this._integralSeriesForTrace(trace, range);
        eager.push({
            trace, traceIndex, name, base,
            times: selected.times,
            values: selected.values,
        });
    }

    const lazyByTrace = await this._queryLazyIntegralDays(plot, lazy, state, range, warnings);
    if (plot._integralToken !== token) return;

    // `discard-day-all` needs every signal's holes before any total can be
    // computed, so that all bars end up integrating exactly the same days. The
    // union spans eager and lazy alike — a day missing from a large file must
    // leave the domain of the small one too, or the bars stop being comparable.
    let sharedExcludedDays = null;
    if (state.missingPolicy === 'discard-day-all') {
        const union = new Set();
        for (const candidate of eager) {
            if (candidate.base.kind !== 'datetime') continue;
            const params = this._integralKernelParams(state, candidate, range, null);
            for (const day of collectMissingDays(candidate.values, params.time, params.options).days) union.add(day);
        }
        for (const entry of lazyByTrace.values()) {
            for (const day of entry.days || []) if (day.hasHole) union.add(day.day);
        }
        sharedExcludedDays = [...union];
    }

    let assumedSeconds = false;
    let indexAxis = false;
    for (const candidate of eager) {
        const params = this._integralKernelParams(state, candidate, range, sharedExcludedDays);
        const result = computeDefiniteIntegral(candidate.values, params.time, params.options);
        if (candidate.base.assumed) assumedSeconds = true;
        if (candidate.base.kind === 'index') indexAxis = true;
        models.push({
            trace: candidate.trace,
            traceIndex: candidate.traceIndex,
            name: candidate.name,
            unit: this._integralValueUnit(candidate.trace),
            base: candidate.base,
            result,
        });
    }
    for (const candidate of lazy) {
        const entry = lazyByTrace.get(candidate.trace);
        if (!entry) continue;
        const result = reduceDailyIntegral(entry.days, {
            method: state.method,
            missingPolicy: state.missingPolicy,
            rangeStart: entry.rangeStart,
            rangeEnd: entry.rangeEnd,
            medianDt: entry.medianDt,
            hasNominalStep: entry.hasNominalStep,
            negativeDtCount: entry.negativeDtCount,
            gapCount: entry.gapCount,
            nanSegmentCount: entry.nanSegmentCount,
            discardIncompleteEnds: state.discardIncompleteEnds,
            extendLastSample: state.extendLastSample,
            explicitRangeEnd: !state.rangeFull,
            excludedDays: sharedExcludedDays,
        });
        models.push({
            trace: candidate.trace,
            traceIndex: candidate.traceIndex,
            name: candidate.name,
            unit: this._integralValueUnit(candidate.trace),
            base: candidate.base,
            result,
            lazy: true,
        });
    }
    models.sort((a, b) => a.traceIndex - b.traceIndex);

    if (plot._integralToken !== token) return;
    plot._integralModels = models;

    // Reasons a signal produced no bar are per-signal facts, so they are named.
    for (const model of models) {
        if (model.result.ok) continue;
        const reason = model.result.reason === 'unsorted' ? text('integralUnsorted')
            : model.result.reason === 'allDiscarded' ? text('integralAllDiscarded')
                : text('integralNoData');
        warnings.push(`${model.name}: ${reason}`);
    }

    const ready = models.filter(model => model.result.ok);
    const units = new Set(ready.map(model => model.unit).filter(Boolean));
    const declared = String(state.unitOverride || '').trim();
    if (declared) {
        // Typing a unit is an assertion about every signal in the panel, so it
        // answers the mixed and undeclared questions at once — but it is the
        // user's answer, not the file's, and the panel records which. A note,
        // not a warning: nothing is wrong, something is merely worth knowing.
        notes.push(text('integralUnitDeclared').replace('{unit}', declared));
    } else if (units.size > 1) {
        warnings.push(text('integralMixedUnits'));
    } else if (units.size === 0) {
        // Nothing anywhere declares a unit. This used to say nothing at all —
        // the one case where the panel most needed to speak, because the totals
        // then read as bare hours.
        warnings.push(text('integralNoUnits'));
    } else if (ready.some(model => !model.unit)) {
        warnings.push(text('integralUnknownUnits'));
    }
    if (assumedSeconds) warnings.push(text('integralAssumedSeconds'));
    if (indexAxis) warnings.push(text('integralIndexAxis'));

    // Different integrated durations are what makes bars silently incomparable,
    // so the panel says it out loud rather than leaving it to be noticed.
    let unequalCoverage = false;
    if (ready.length > 1) {
        const covered = ready.map(model => model.result.coveredTime);
        const spread = Math.max(...covered) - Math.min(...covered);
        const reference = Math.max(...covered) || 1;
        unequalCoverage = spread > reference * 1e-6;
        if (spread > reference * 1e-6) warnings.push(text('integralUnequalCoverage'));
    }

    // A pie that silently fails to appear reads as a bug. When the user asked
    // for one and the gate refused, say which condition it failed.
    const view = this._integralPresentation(plot, models);
    if (state.showPie && ready.length && !this._integralPieAllowed(view)) {
        warnings.push(text(view.mixedUnits ? 'integralPieMixedUnits' : 'integralPieMixedSigns'));
    }

    // Summed across signals, so each term has to be in the same unit first:
    // raw x-units from two axes are not addable.
    const missing = ready.reduce((sum, model) => sum
        + axisDuration(model.base, model.result.timeKind, model.result.uncoveredTime || 0).seconds, 0);
    if (missing > 0) {
        const key = state.missingPolicy === 'interpolate' ? 'integralUncoveredInterpolated' : 'integralUncovered';
        const timeKind = ready[0]?.result.timeKind === 'index' ? 'index' : 'datetime';
        warnings.push(text(key).replace('{time}', formatDuration(missing, timeKind)));
    }

    state.warnings = warnings;
    const built = this._buildIntegralTraces(plot, models);
    // The pane must appear before Plotly measures it, or the pie is drawn into a
    // zero-height box and stays invisible until the next resize.
    this._applyIntegralPieVisibility(plot, built.pieVisible);
    const config = this._getPlotlyConfig();
    Plotly.react(plot.integralDiv, built.traces, built.layout, config).then(() => {
        this._installLegendHoverHint(plot.integralDiv);
    });
    if (plot.integralPieDiv) {
        Plotly.react(plot.integralPieDiv, built.pieTraces, built.pieLayout, config);
    }
    this._renderIntegralSummary(plot, models);
    // Says what it is, not just two numbers with a dot between them: how many
    // signals were totalled and over how much time they were integrated. When
    // the signals did NOT cover the same duration, naming one of them would
    // state something false about the other two, so it points at the summary.
    const summary = !ready.length
        ? ''
        : unequalCoverage
            ? text('integralStatusMixed').replace('{count}', String(ready.length))
            : text(ready.length === 1 ? 'integralStatusOne' : 'integralStatusMany')
                .replace('{count}', String(ready.length))
                .replace('{time}', formatAxisDuration(ready[0], ready[0].result.coveredTime));
    this._setIntegralComputing(plot, false);
    this._setIntegralStatus(plot, summary, warnings, 'ready', notes);
};

// Per-day integral partials for the lazy traces, one query per file. The SQL
// answers only "how much, where"; every whole-day policy is decided afterwards
// by reduceDailyIntegral, against the same rules the eager kernel applies.
//
// Anything the query cannot answer degrades to a named warning and no bar —
// never to a number that looks exact and is not.
proto._queryLazyIntegralDays = async function(plot, lazy, state, range, warnings) {
    const byTrace = new Map();
    if (!lazy.length) return byTrace;
    const byFile = new Map();
    for (const candidate of lazy) {
        if (!byFile.has(candidate.trace.fileId)) byFile.set(candidate.trace.fileId, []);
        byFile.get(candidate.trace.fileId).push(candidate);
    }
    for (const [fileId, candidates] of byFile) {
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getDefiniteIntegralByDay) {
            for (const candidate of candidates) warnings.push(`${candidate.name}: ${text('integralLazyUnsupported')}`);
            continue;
        }
        const transform = this._fileTransform(fileId);
        const timeShiftMs = this._parseTimeShift(fileId, transform.timeShift) || 0;
        const cropStart = this._parseTimeBoundary(fileId, transform.cropStart);
        const cropEnd = this._parseTimeBoundary(fileId, transform.cropEnd);
        const cropRange = (cropStart != null || cropEnd != null)
            ? [cropStart ?? -Infinity, cropEnd ?? Infinity]
            : null;
        const transforms = {};
        for (const candidate of candidates) {
            const sign = this.isVariableSignInverted?.(fileId, candidate.trace.varName) ? -1 : 1;
            transforms[candidate.trace.varName] = { gain: transform.gain * sign, yOffset: transform.yOffset };
        }
        try {
            const result = await source.getDefiniteIntegralByDay(data, candidates.map(c => c.trace.varName), {
                timeShiftMs,
                cropRange,
                range,
                missingPolicy: state.missingPolicy,
                transforms,
            });
            if (!result?.ok) {
                for (const candidate of candidates) warnings.push(`${candidate.name}: ${text('integralLazyUnsupported')}`);
                continue;
            }
            for (const blockedName of result.blocked || []) {
                warnings.push(`${this._traceName(blockedName, fileId)}: ${text('integralLazyUnsupported')}`);
            }
            const entryByVar = new Map(result.traces.map(entry => [entry.varName, entry]));
            for (const candidate of candidates) {
                const entry = entryByVar.get(candidate.trace.varName);
                if (entry) byTrace.set(candidate.trace, entry);
            }
        } catch (error) {
            for (const candidate of candidates) {
                warnings.push(`${candidate.name}: ${text('integralLazyFailed')}`);
            }
            console.warn('Integral: lazy query failed', error);
        }
    }
    return byTrace;
};

// The same non-blocking pill the lazy FFT and Profile use: it sits above the
// analysis pane with pointer-events:none, so the previous bars stay readable
// and pannable while the replacement is being queried.
proto._setIntegralComputing = function(plot, loading) {
    const pane = plot?.integralDiv?.parentElement;
    if (!pane) return;
    let pill = pane.querySelector('.integral-computing-indicator');
    if (loading) {
        if (!pill) {
            pill = document.createElement('div');
            pill.className = 'lazy-detail-indicator integral-computing-indicator';
            pill.setAttribute('aria-live', 'polite');
            pill.innerHTML = '<span class="lazy-detail-spinner" aria-hidden="true"></span><span class="lazy-detail-text"></span>';
            pane.appendChild(pill);
        }
        const label = text('integralCalculating');
        const labelElement = pill.querySelector('.lazy-detail-text');
        if (labelElement) labelElement.textContent = label;
        pill.setAttribute('aria-label', label);
        pill.classList.add('active');
    } else if (pill) {
        pill.classList.remove('active');
        pill.remove();
    }
};

// The kernel's inputs for one candidate: the time context in raw abscissa units
// (epoch ms on a calendar axis) plus the policy options from the panel.
proto._integralKernelParams = function(state, candidate, range, sharedExcludedDays) {
    const kind = candidate.base.kind;
    const time = kind === 'index'
        ? { values: null, kind: 'index' }
        : { values: candidate.times, kind: kind === 'datetime' ? 'datetime' : 'numeric' };
    // Day policies are calendar-only. On any other axis they fall back to
    // 'zero', which is also what the disabled controls in the panel show.
    const dayPolicy = state.missingPolicy === 'discard-day-own' || state.missingPolicy === 'discard-day-all';
    return {
        time,
        options: {
            method: state.method,
            missingPolicy: dayPolicy && kind !== 'datetime' ? 'zero' : state.missingPolicy,
            rangeStart: range?.[0] ?? null,
            rangeEnd: range?.[1] ?? null,
            discardIncompleteEnds: kind === 'datetime' && state.discardIncompleteEnds,
            extendLastSample: state.extendLastSample,
            excludedDays: sharedExcludedDays,
        },
    };
};

// ─── Result presentation ──────────────────────────────────────────────────

// Everything the bar chart, the pie, the summary table and the CSV export need,
// derived once so the four cannot disagree: the converted values, the shared
// exponent and the unit label that goes with it.
proto._integralPresentation = function(plot, models = []) {
    return buildIntegralPresentation(models, this._ensureIntegralState(plot), {
        samplesLabel: text('integralSamples'),
    });
};

proto._buildIntegralTraces = function(plot, models = []) {
    const view = this._integralPresentation(plot, models);
    const state = view.state;
    const traces = [];
    if (!view.rows.length) {
        return {
            traces,
            layout: this._buildIntegralLayout(plot, { models, view }),
            pieTraces: [],
            pieLayout: this._buildIntegralPieLayout(plot),
            pieVisible: false,
        };
    }

    const names = view.rows.map(row => row.model.name);
    const values = view.rows.map(row => row.scaled);
    const colors = view.rows.map(row => row.model.trace.color);
    const unitSuffix = view.axisUnit ? ` ${view.axisUnit}` : '';
    // The hover always shows all three quantities, whichever one the bars are
    // plotting: a total is only readable next to the duration it spans, and the
    // mean is that comparison made explicit.
    const withUnit = (value, unit) => (value == null ? '—' : `${formatNumber(value, 6)}${unit ? ` ${unit}` : ''}`);
    const customdata = view.rows.map(row => [
        withUnit(row.value, view.resultUnit),
        withUnit(row.perDay, view.perDayUnit),
        withUnit(row.mean, view.meanUnit),
        formatAxisDuration(row.model, row.model.result.coveredTime),
        row.model.result.discardedDayCount,
        row.model.result.sampleCount,
        // The name travels in customdata rather than as %{x}: the category axis
        // swaps sides between the two orientations, the customdata does not.
        row.model.name,
    ]);
    const hovertemplate = `<b>%{customdata[6]}</b><br>`
        + `${escapeHtml(text('integralValue'))} = %{customdata[0]}<br>`
        + `${escapeHtml(text('integralPerDay'))} = %{customdata[1]}<br>`
        + `${escapeHtml(text('integralMean'))} = %{customdata[2]}<br>`
        + `${escapeHtml(text('integralCoverage'))} = %{customdata[3]}<br>`
        + `${escapeHtml(text('integralDiscarded'))} = %{customdata[4]} ${escapeHtml(text('integralDays'))}<br>`
        + `${escapeHtml(text('integralSamples'))} = %{customdata[5]}<extra></extra>`;

    const horizontal = state.orientation === 'horizontal';
    traces.push({
        type: 'bar',
        orientation: horizontal ? 'h' : 'v',
        x: horizontal ? values : names,
        y: horizontal ? names : values,
        marker: {
            color: colors,
            line: { color: colors, width: 1 },
        },
        text: state.showValues ? values.map(value => `${formatNumber(value, 4)}${unitSuffix}`) : undefined,
        textposition: state.showValues ? 'auto' : 'none',
        cliponaxis: false,
        showlegend: false,
        customdata,
        hovertemplate,
        xaxis: 'x',
        yaxis: 'y',
    });

    const pieVisible = this._integralPieAllowed(view);
    const pieTraces = pieVisible ? [{
        type: 'pie',
        labels: names,
        // A pie shows shares of a whole; with one sign throughout, the
        // magnitudes ARE the shares. The sign check upstream is what makes
        // this legitimate.
        values: view.rows.map(row => Math.abs(row.scaled)),
        marker: { colors },
        textinfo: 'percent',
        hovertemplate: `<b>%{label}</b><br>%{value:.4g} ${escapeHtml(view.axisUnit)}<br>%{percent}<extra></extra>`,
        // Its own pane now, so it takes the whole plotting area rather than a
        // reserved slice of the bar chart's.
        domain: { x: [0, 1], y: [0, 1] },
        sort: false,
        showlegend: false,
    }] : [];

    return {
        traces,
        layout: this._buildIntegralLayout(plot, { models, view }),
        pieTraces,
        pieLayout: this._buildIntegralPieLayout(plot),
        pieVisible,
    };
};

proto._integralPieAllowed = function(view) {
    return integralPieAllowed(view);
};

// The pie pane and its splitter only exist while there IS a pie. Hiding them
// collapses the inner grid to a single cell, so the bars get the whole pane
// back rather than sitting next to a blank rectangle.
proto._applyIntegralPieVisibility = function(plot, visible) {
    const container = plot?.integralContainer;
    if (!container) return;
    const next = !!visible;
    if (plot._integralPieVisible === next) return;
    plot._integralPieVisible = next;
    container.classList.toggle('integral-pie-visible', next);
    Plotly.Plots.resize(plot.integralDiv);
    if (next && plot.integralPieDiv) Plotly.Plots.resize(plot.integralPieDiv);
};

proto._buildIntegralPieLayout = function(plot) {
    const { bg, fontColor, legendBg, gridColor } = this._colors();
    void plot;
    return {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: false,
        legend: this._legendConfig(legendBg, gridColor),
        margin: { l: 8, r: 8, t: 8, b: 8 },
        autosize: true,
        uirevision: 'integral-pie',
    };
};

proto._buildIntegralLayout = function(plot, { models = [], view = null } = {}) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const state = this._ensureIntegralState(plot);
    const resolved = view || this._integralPresentation(plot, models);
    const horizontal = state.orientation === 'horizontal';
    // Axis titles wrap the unit in brackets, but the undeclared-unit marker
    // already carries its own: "Integral [[?]·h]" reads as a typo.
    const unitSuffix = !resolved.axisUnit
        ? ''
        : resolved.axisUnit.startsWith(UNKNOWN_UNIT)
            ? ` ${resolved.axisUnit}`
            : ` [${resolved.axisUnit}]`;
    const valueAxis = {
        gridcolor: gridColor,
        linecolor: gridColor,
        tickcolor: gridColor,
        zeroline: true,
        zerolinecolor: gridColor,
        zerolinewidth: 1,
        // The axis names what it carries. Leaving it at "Integral" while the
        // bars plot a mean would be a label that contradicts the numbers.
        title: {
            text: `${text(resolved.quantity === 'mean' ? 'integralMean'
                : resolved.quantity === 'per-day' ? 'integralPerDay'
                    : 'integralAxisTitle')}${unitSuffix}`,
            font: { size: 10 },
        },
    };
    const categoryAxis = {
        gridcolor: gridColor,
        linecolor: gridColor,
        tickcolor: gridColor,
        zeroline: false,
        type: 'category',
        automargin: true,
    };
    return {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: false,
        legend: this._legendConfig(legendBg, gridColor),
        bargap: 0.32,
        xaxis: horizontal ? valueAxis : categoryAxis,
        yaxis: horizontal ? categoryAxis : valueAxis,
        margin: { l: 62, r: 18, t: 12, b: 52 },
        autosize: true,
        hovermode: 'closest',
        // Switching quantity changes the axis by orders of magnitude, so the
        // view must not be preserved across it.
        uirevision: `integral-${state.orientation}-${state.integralUnit}-${state.scale}-${state.quantity}`,
    };
};

// ─── Status and summary ───────────────────────────────────────────────────

// The topbar carries the SUMMARY; warning text belongs in the side panel, the
// way FFT and Profile already split it. A warning only leaves a short pointer
// here (the panel can be closed) plus the full text in the tooltip — a topbar
// that reads like a log of concatenated sentences tells the user nothing.
proto._setIntegralStatus = function(plot, summary, warnings = [], kind = 'muted', notes = []) {
    const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    const noteList = Array.isArray(notes) ? notes.filter(Boolean) : [];
    plot._integralWarningMessage = list.join(' | ');
    plot._integralNoteMessage = noteList.join(' | ');
    plot._integralStatusKind = list.length ? 'warning' : kind;
    const status = plot?.integralContainer?.querySelector('.hist-status');
    if (status) {
        // Only a real warning pulls the topbar out of its summary. A note lives
        // in the panel and nowhere else — it is a fact about the reading, not a
        // problem with it, and amber on every recompute would train the user to
        // stop looking at amber.
        const pointer = list.length ? text('integralWarningSeePanel') : '';
        status.textContent = [summary, pointer].filter(Boolean).join(' · ');
        status.className = `hist-status hist-status-${list.length ? 'warning' : kind}`;
        status.title = [plot._integralWarningMessage, plot._integralNoteMessage].filter(Boolean).join(' | ')
            || summary || '';
    }
    this._syncIntegralMessage(plot);
};

proto._syncIntegralMessage = function(plot) {
    const box = plot?.integralContainer?.querySelector('.integral-message');
    if (!box) return;
    const warning = plot._integralWarningMessage || '';
    const note = plot._integralNoteMessage || '';
    const kind = plot._integralStatusKind || 'muted';
    const showWarning = !!warning && kind === 'warning';
    box.hidden = !showWarning && !note;
    box.innerHTML = '';
    if (showWarning) {
        const line = document.createElement('div');
        line.textContent = warning;
        box.appendChild(line);
    }
    if (note) {
        const line = document.createElement('div');
        line.className = 'integral-note';
        line.textContent = note;
        box.appendChild(line);
    }
    box.className = `fft-message integral-message fft-message-${showWarning ? kind : 'muted'}`;
};

proto._renderIntegralSummary = function(plot, models = []) {
    const host = plot?.integralContainer?.querySelector('.integral-summary');
    if (!host) return;
    const view = this._integralPresentation(plot, models);
    if (!view.rows.length) {
        host.innerHTML = '';
        return;
    }
    // All three quantities are listed side by side rather than only the plotted
    // one: the total answers "how much", the mean answers "at what level", and
    // reading either without the other invites the wrong conclusion.
    // A number and its unit are ONE column split in two cells (right-aligned
    // digits, left-aligned unit), so the rule goes after the unit — never
    // between "2,988" and "MW·h/d", which would read as two separate figures.
    const cell = (value, unit) => (value == null
        ? '<td class="integral-num">—</td><td class="integral-group-end"></td>'
        : `<td class="integral-num">${escapeHtml(formatNumber(value, 5))}</td>`
            + `<td class="integral-group-end">${escapeHtml(unit)}</td>`);
    const rows = view.rows.map(({ model, unit, value, perDay, mean }) => {
        const result = model.result;
        const coverage = result.timeKind === 'datetime' && result.dayCount
            ? `${result.dayCount - result.discardedDayCount}/${result.dayCount} ${escapeHtml(text('integralDays'))}`
            : formatAxisDuration(model, result.coveredTime);
        const totalUnit = this._integralResultUnit(unit, view.state, result.timeKind);
        return `<tr>
            <td class="integral-group-end"><span class="integral-swatch" style="background:${escapeHtml(model.trace.color)}"></span>${escapeHtml(model.name)}</td>
            ${cell(value, totalUnit)}
            ${cell(perDay, `${totalUnit}/d`)}
            ${cell(mean, unit || UNKNOWN_UNIT)}
            <td>${coverage}</td>
        </tr>`;
    }).join('');
    host.innerHTML = `<table class="integral-summary-table"><thead><tr>
        <th class="integral-group-end">${escapeHtml(text('integralSignal'))}</th>
        <th class="integral-num integral-group-end" colspan="2">${escapeHtml(text('integralValue'))}</th>
        <th class="integral-num integral-group-end" colspan="2">${escapeHtml(text('integralPerDay'))}</th>
        <th class="integral-num integral-group-end" colspan="2">${escapeHtml(text('integralMean'))}</th>
        <th>${escapeHtml(text('integralCoverage'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
};

// Rows for the CSV export. The unscaled value is exported, with the unit spelt
// out: a spreadsheet has no use for the panel's display prefix.
proto._integralExportTable = function(plot) {
    return buildIntegralExportTable(this._integralPresentation(plot, plot?._integralModels || []), {
        fileNameFor: (fileId) => this.files.get(fileId)?.name || '',
        samplesLabel: text('integralSamples'),
    });
};

// ─── Options panel ────────────────────────────────────────────────────────

proto._renderIntegralOptionsPanel = function(panelId, plot) {
    const state = this._ensureIntegralState(plot);
    const options = plot?.integralContainer?.querySelector('.hist-options');
    if (!options) return;
    options.innerHTML = '';
    const message = document.createElement('div');
    message.className = 'fft-message integral-message';
    message.hidden = true;
    options.appendChild(message);

    const section = (label) => {
        const title = document.createElement('div');
        title.className = 'fft-options-subtitle';
        title.textContent = label;
        options.appendChild(title);
    };
    const row = (labelText, control, tooltip = '', className = 'fft-option-row hist-option-row') => {
        const label = document.createElement('label');
        label.className = className;
        if (tooltip) label.title = tooltip;
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, control);
        options.appendChild(label);
        return label;
    };
    const segmented = (items, current, onPick, classes = {}) => {
        const { wrapperClass = 'hist-segmented', buttonClass = 'hist-seg-btn' } = classes;
        const wrap = document.createElement('div');
        wrap.className = wrapperClass;
        const buttons = [];
        for (const item of items) {
            const button = document.createElement('button');
            button.type = 'button';
            if (buttonClass) button.className = buttonClass;
            button.textContent = item.label;
            if (item.title) button.title = item.title;
            const active = item.value === current;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
            button.addEventListener('click', () => {
                buttons.forEach(candidate => {
                    const enabled = candidate === button;
                    candidate.classList.toggle('active', enabled);
                    candidate.setAttribute('aria-pressed', String(enabled));
                });
                onPick(item.value);
            });
            buttons.push(button);
            wrap.appendChild(button);
        }
        return wrap;
    };
    const checkbox = (checked, onChange, disabled = false) => {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'fft-checkbox';
        input.checked = checked;
        input.disabled = disabled;
        input.addEventListener('change', () => onChange(input.checked));
        return input;
    };
    const select = (items, current, onChange, disabledValues = new Set()) => {
        const element = document.createElement('select');
        element.className = 'fft-select';
        for (const item of items) {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            if (disabledValues.has(item.value)) option.disabled = true;
            element.appendChild(option);
        }
        element.value = current;
        element.addEventListener('change', () => onChange(element.value));
        return element;
    };

    // ── Range: the exact block every other analysis mode uses ──
    row(i18n.t('fftRange'), segmented([
        { label: i18n.t('fftRangeFull'), value: true, title: i18n.t('analysisRangeFullTooltip') },
        { label: i18n.t('fftRangeSelection'), value: false, title: i18n.t('analysisRangeSelectionTooltip') },
    ], state.rangeFull, full => this._setIntegralRangeMode(panelId, full), { wrapperClass: 'fft-segmented', buttonClass: '' }), '', 'fft-option-row');

    const domain = this._integralDomain(plot);
    const activeRange = this._activeIntegralRange(plot);
    const calendar = this._integralHasCalendarAxis(plot);
    const boundBlock = (labelText, key, index) => {
        const wrap = document.createElement('div');
        wrap.className = `fft-range-bound${calendar ? ' fft-range-bound-datetime' : ''}`;
        const label = document.createElement('label');
        label.className = 'fft-option-row';
        label.title = key === 'x1' ? i18n.t('analysisRangeStartTooltip') : i18n.t('analysisRangeEndTooltip');
        const span = document.createElement('span');
        span.textContent = labelText;
        const input = document.createElement('input');
        input.type = calendar ? 'datetime-local' : 'number';
        if (calendar) input.step = '1';
        input.className = 'fft-number-input';
        input.dataset.integralKey = key;
        input.dataset.integralRole = 'input';
        input.disabled = state.rangeFull;
        input.value = calendar ? utcInputValue(activeRange[index]) : String(activeRange[index] ?? '');
        input.addEventListener('change', () => {
            let value = calendar ? utcInputMs(input.value) : Number(input.value);
            if (Number.isFinite(value) && domain) value = Math.max(domain.min, Math.min(domain.max, value));
            state.autoRangeWarning = null;
            state.autoRangeLimited = false;
            state[key] = Number.isFinite(value) ? value : null;
            this._updateIntegralSelectionShapes(panelId, plot);
            this._scheduleIntegralRecompute(panelId);
        });
        label.append(span, input);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'fft-range-input';
        slider.title = key === 'x1' ? i18n.t('analysisRangeStartTooltip') : i18n.t('analysisRangeEndTooltip');
        slider.dataset.integralKey = key;
        slider.dataset.integralRole = 'slider';
        slider.disabled = state.rangeFull;
        if (domain) { slider.min = String(domain.min); slider.max = String(domain.max); slider.step = 'any'; }
        if (Number.isFinite(activeRange[index])) slider.value = String(activeRange[index]);
        slider.addEventListener('input', () => {
            const number = Number(slider.value);
            state.autoRangeWarning = null;
            state.autoRangeLimited = false;
            state[key] = Number.isFinite(number) ? number : null;
            this._updateIntegralSelectionShapes(panelId, plot);
        });
        slider.addEventListener('change', () => this._scheduleIntegralRecompute(panelId));
        wrap.append(label, slider);
        return wrap;
    };
    const rangeGrid = document.createElement('div');
    rangeGrid.className = 'fft-range-grid';
    rangeGrid.append(
        boundBlock(i18n.t('fftRangeStart'), 'x1', 0),
        boundBlock(i18n.t('fftRangeEnd'), 'x2', 1),
    );
    options.appendChild(rangeGrid);

    // ── Integration ──
    section(text('integralIntegration'));
    row(text('integralMethod'), select([
        { value: 'trapezoidal', label: text('integralTrapezoidal') },
        { value: 'rectangular', label: text('integralRectangular') },
    ], state.method, value => {
        state.method = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));
    // Declaring the signal's unit. Free text, because the space of units is
    // infinite and a dropdown of them could only ever be wrong — but free text
    // the panel then reads back, so the user sees what it understood before
    // trusting the axis. Placed with the other two unit controls: the signal's
    // unit, the time unit and the scale tell one story together.
    const detected = this._integralDetectedUnits(plot);
    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.className = 'fft-number-input integral-unit-input';
    unitInput.value = state.unitOverride || '';
    unitInput.maxLength = 24;
    unitInput.spellcheck = false;
    unitInput.placeholder = detected || UNKNOWN_UNIT;
    unitInput.setAttribute('aria-label', text('integralUnitOverride'));
    const unitHint = document.createElement('div');
    unitHint.className = 'integral-unit-hint';
    const renderUnitHint = () => {
        const value = unitInput.value.trim();
        const scaling = describeUnitScaling(value || detected, state.integralUnit,
            this._integralHasCalendarAxis(plot) ? 'datetime' : 'numeric', text('integralSamples'));
        unitHint.textContent = scaling.prefixable
            ? text('integralUnitHintScales')
                .replace('{unit}', scaling.resultUnit)
                .replace('{examples}', scaling.examples.join(' / '))
            : text('integralUnitHintFlat').replace('{unit}', scaling.resultUnit);
    };
    renderUnitHint();
    unitInput.addEventListener('input', renderUnitHint);
    const commitUnit = () => {
        const value = unitInput.value.trim().slice(0, 24);
        if (value === state.unitOverride) return;
        state.unitOverride = value;
        this._refreshIntegralTimePlot(panelId, plot, { preserveView: true });
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    };
    unitInput.addEventListener('change', commitUnit);
    unitInput.addEventListener('blur', commitUnit);
    unitInput.addEventListener('keydown', event => { if (event.key === 'Enter') commitUnit(); });
    row(text('integralUnitOverride'), unitInput, text('integralUnitOverrideTip'));
    options.appendChild(unitHint);

    row(text('integralResultUnit'), select([
        { value: 'hour', label: text('integralPerHour') },
        { value: 'second', label: text('integralPerSecond') },
    ], state.integralUnit, value => {
        state.integralUnit = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));
    row(text('integralScale'), select([
        { value: 'auto', label: text('integralScaleAuto') },
        { value: '1', label: '×1' },
        { value: 'k', label: 'k (10³)' },
        { value: 'M', label: 'M (10⁶)' },
        { value: 'G', label: 'G (10⁹)' },
        { value: 'T', label: 'T (10¹²)' },
        { value: 'm', label: 'm (10⁻³)' },
        { value: 'u', label: 'µ (10⁻⁶)' },
    ], state.scale, value => {
        state.scale = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));

    // ── Data handling ──
    section(text('integralDataHandling'));
    // Points or periods. This is an assertion about what the timestamps MEAN, so
    // it sits with the other data-reading choices rather than under Display.
    row(text('integralExtendLast'), checkbox(state.extendLastSample, checked => {
        state.extendLastSample = checked;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }), text('integralExtendLastTip'));
    row(text('integralDiscardEnds'), checkbox(state.discardIncompleteEnds && calendar, checked => {
        state.discardIncompleteEnds = checked;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }, !calendar), calendar ? text('integralDiscardEndsTip') : `${text('integralDiscardEndsTip')} — ${i18n.t('temporalProfileCalendarRequired')}`);
    row(text('integralMissing'), select([
        { value: 'zero', label: text('integralMissingZero') },
        { value: 'interpolate', label: text('integralMissingInterpolate') },
        { value: 'discard-day-own', label: text('integralMissingDiscardOwn') },
        { value: 'discard-day-all', label: text('integralMissingDiscardAll') },
    ], state.missingPolicy, value => {
        state.missingPolicy = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }, calendar ? new Set() : new Set(['discard-day-own', 'discard-day-all'])), text('integralMissingTip'));

    // ── Display ──
    section(text('integralDisplay'));
    // Which of the three readings the bars carry. All three appear in the
    // summary and the hover regardless; this only decides what is drawn.
    row(text('integralQuantity'), select([
        { value: 'total', label: text('integralQuantityTotal') },
        { value: 'per-day', label: text('integralQuantityPerDay') },
        { value: 'mean', label: text('integralQuantityMean') },
    ], state.quantity, value => {
        state.quantity = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }, calendar ? new Set() : new Set(['per-day'])), text('integralQuantityTip'));
    row(text('integralOrientation'), segmented([
        { label: text('integralVertical'), value: 'vertical' },
        { label: text('integralHorizontal'), value: 'horizontal' },
    ], state.orientation, value => {
        state.orientation = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));
    row(text('integralSort'), select([
        { value: 'panel', label: text('integralSortPanel') },
        { value: 'desc', label: text('integralSortDesc') },
        { value: 'asc', label: text('integralSortAsc') },
    ], state.sort, value => {
        state.sort = value;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));
    row(text('integralShowPie'), checkbox(state.showPie, checked => {
        state.showPie = checked;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));
    row(text('integralShowValues'), checkbox(state.showValues, checked => {
        state.showValues = checked;
        this._scheduleIntegralRecompute(panelId, { immediate: true });
    }));

    section(text('integralSummary'));
    const summary = document.createElement('div');
    summary.className = 'integral-summary';
    options.appendChild(summary);
    this._renderIntegralSummary(plot, plot._integralModels || []);
    this._syncIntegralMessage(plot);
};

proto._integralHasCalendarAxis = function(plot) {
    const traces = (plot?.traces || []).filter(trace => this._isVisible(trace));
    const pool = traces.length ? traces : (plot?.traces || []);
    return pool.length > 0 && pool.every(trace => this._fftTimeKind(trace.fileId) === 'datetime');
};

proto._syncIntegralOptionsPanel = function(plot) {
    const options = plot?.integralContainer?.querySelector('.hist-options');
    if (!options) return;
    const state = this._ensureIntegralState(plot);
    const calendar = this._integralHasCalendarAxis(plot);
    const range = this._activeIntegralRange(plot);
    options.querySelectorAll('[data-integral-key]').forEach(input => {
        const index = input.dataset.integralKey === 'x1' ? 0 : 1;
        input.disabled = !!state.rangeFull;
        if (document.activeElement === input) return;
        if (input.dataset.integralRole === 'slider') {
            if (Number.isFinite(range[index])) input.value = String(range[index]);
        } else {
            input.value = calendar ? utcInputValue(range[index]) : String(range[index] ?? '');
        }
    });
    options.querySelectorAll('.fft-segmented button').forEach((button, index) => {
        const isFull = index === 0;
        button.classList.toggle('active', !!state.rangeFull === isFull);
        button.setAttribute('aria-pressed', String(!!state.rangeFull === isFull));
    });
};

}
