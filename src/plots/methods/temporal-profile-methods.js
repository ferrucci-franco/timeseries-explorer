import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    buildTemporalProfile,
    inferTemporalProfileStepMs,
    TEMPORAL_PROFILE_DEFAULT_RESOLUTION_MINUTES,
    TEMPORAL_PROFILE_MAX_BINS,
    TEMPORAL_PROFILE_PERIODS,
} from '../../utils/temporal-profile.js';

const PROFILE_LAYOUTS = new Set(['horizontal', 'vertical']);
const PROFILE_RENDER_MODES = new Set(['columns', 'line', 'line-band']);
const PROFILE_CATEGORIES = ['workday', 'saturday', 'sunday'];
const PROFILE_RECOMPUTE_DEBOUNCE_MS = 150;
const PROFILE_BAR_OPACITY = 0.68;
const PROFILE_RESOLUTION_PRESETS = [1440, 60, 30, 15, 5, 1];

const fallbackText = {
    temporalProfileMode: 'Temporal profile',
    temporalProfileModeLabel: 'Profile',
    temporalProfileDrop: 'Drop one or more calendar signals for the temporal profile',
    temporalProfileCalendarRequired: 'Temporal Profile requires Calendar time mode.',
    temporalProfileLazyUnsupported: 'large/lazy files are not supported yet',
    temporalProfileNoFinite: 'no finite values in range',
    temporalProfileTimeScope: 'Range',
    temporalProfileAll: 'All',
    temporalProfileSelection: 'Selection',
    temporalProfileStart: 'Start',
    temporalProfileEnd: 'End',
    temporalProfilePeriod: 'Period',
    temporalProfileDay: 'Day',
    temporalProfileWeek: 'Week',
    temporalProfileMonth: 'Month',
    temporalProfileCategories: 'Day categories',
    temporalProfileWorkdays: 'Workdays',
    temporalProfileSaturdays: 'Saturdays',
    temporalProfileSundays: 'Sundays',
    temporalProfileResolution: 'Resolution',
    temporalProfileDataStep: 'Data timestep',
    temporalProfileCustom: 'Custom',
    temporalProfileMinutes: 'minutes',
    temporalProfileTooManyBins: `Resolution produces too many bins (maximum ${TEMPORAL_PROFILE_MAX_BINS})`,
    temporalProfileDisplay: 'Display',
    temporalProfileColumns: 'Columns',
    temporalProfileLine: 'Mean line',
    temporalProfileLineBand: 'Mean + standard deviation',
    temporalProfileDiscardDay: 'Discard incomplete days',
    temporalProfileDiscardWeek: 'Discard incomplete weeks',
    temporalProfileDiscardMonth: 'Discard incomplete months',
    temporalProfileDiscardTip: 'Discard a whole period when it contains NaN, a detected time gap, or is cut by the selected range.',
    temporalProfileMean: 'Mean',
    temporalProfileStd: 'Standard deviation',
    temporalProfileCoverage: 'Coverage',
    temporalProfilePeriods: 'periods',
    temporalProfileInvalid: 'invalid',
    temporalProfileGaps: 'periods with gaps',
    temporalProfileDiscarded: 'discarded',
    temporalProfilePartial: 'partial',
    temporalProfileSummary: 'Coverage summary',
    temporalProfileNoCategories: 'Enable at least one day category.',
    temporalProfileMixedUnits: 'traces have different units',
    temporalProfileReset: 'Reset',
    temporalProfileResetTip: 'Reset time scope and temporal-profile view',
    temporalProfileOptions: 'Options',
    temporalProfileHideTime: 'Hide time series',
    temporalProfileShowTime: 'Show time series',
    temporalProfileXAxisDay: 'Time of day [UTC]',
    temporalProfileXAxisWeek: 'Time of week [UTC]',
    temporalProfileXAxisMonth: 'Day of month [UTC]',
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

function rgba(color, alpha) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!match) return `rgba(100,116,139,${alpha})`;
    const value = Number.parseInt(match[1], 16);
    return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function profileTraceKey(trace) {
    return `${trace.fileId}\u0000${trace.varName}`;
}

function profileCategoryLabel(id) {
    if (id === 'workday') return text('temporalProfileWorkdays');
    if (id === 'saturday') return text('temporalProfileSaturdays');
    if (id === 'sunday') return text('temporalProfileSundays');
    return '';
}

function localizedWeekdays() {
    if (i18n.currentLang === 'es') return ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
    if (i18n.currentLang === 'fr') return ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
    if (i18n.currentLang === 'it') return ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
}

function resolutionLabel(minutes) {
    const rounded = Math.round(Number(minutes) * 1e6) / 1e6;
    if (rounded === 1440) return `1 ${text('temporalProfileDay').toLowerCase()}`;
    if (rounded === 60) return '1 h';
    return `${rounded} min`;
}

function resolutionBelowStep(resolutionMinutes, stepMinutes) {
    if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) return false;
    const tolerance = Math.max(1e-9, stepMinutes * 1e-6);
    return Number(resolutionMinutes) < stepMinutes - tolerance;
}

function traceIsLazy(manager, trace) {
    return !!manager.files.get(trace.fileId)?.data?._duckdb;
}

export function installPlotTemporalProfileMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._defaultTemporalProfileState = function() {
    return {
        layout: 'vertical',
        split: 0.5,
        timeSeriesHidden: false,
        optionsVisible: true,
        rangeFull: true,
        x1: null,
        x2: null,
        period: 'day',
        resolutionByPeriod: { ...TEMPORAL_PROFILE_DEFAULT_RESOLUTION_MINUTES },
        customResolutionByPeriod: { day: false, week: false, month: false },
        renderMode: 'line-band',
        workdays: true,
        saturdays: true,
        sundays: true,
        discardIncomplete: false,
        warnings: [],
    };
};

proto._normalizeTemporalProfileState = function(raw = {}) {
    const defaults = this._defaultTemporalProfileState();
    const split = Number(raw.split);
    const sourceResolutions = raw.resolutionByPeriod || {};
    const resolutionByPeriod = {};
    const customResolutionByPeriod = {};
    for (const period of TEMPORAL_PROFILE_PERIODS) {
        const number = Number(sourceResolutions[period]);
        resolutionByPeriod[period] = Number.isFinite(number) && number > 0
            ? number
            : defaults.resolutionByPeriod[period];
        customResolutionByPeriod[period] = raw.customResolutionByPeriod?.[period] === true;
    }
    return {
        ...defaults,
        ...raw,
        layout: PROFILE_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        timeSeriesHidden: raw.timeSeriesHidden === true,
        optionsVisible: raw.optionsVisible !== false,
        rangeFull: raw.rangeFull !== undefined ? !!raw.rangeFull : !(hasFinite(raw.x1) || hasFinite(raw.x2)),
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
        period: TEMPORAL_PROFILE_PERIODS.has(raw.period) ? raw.period : defaults.period,
        resolutionByPeriod,
        customResolutionByPeriod,
        renderMode: PROFILE_RENDER_MODES.has(raw.renderMode) ? raw.renderMode : defaults.renderMode,
        workdays: raw.workdays !== false,
        saturdays: raw.saturdays !== false,
        sundays: raw.sundays !== false,
        discardIncomplete: raw.discardIncomplete === true,
        warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 20) : [],
    };
};

proto._ensureTemporalProfileState = function(plot) {
    if (!plot) return this._defaultTemporalProfileState();
    const current = plot.temporalProfile;
    const normalized = this._normalizeTemporalProfileState(current || {});
    if (current && typeof current === 'object' && !Array.isArray(current)) {
        // Controls keep a reference to this object. Preserve its identity across
        // recomputes so their event handlers always update the live state.
        Object.assign(current, normalized);
        return current;
    }
    plot.temporalProfile = normalized;
    return normalized;
};

proto._addTemporalProfileTrace = function(panelId, varName, panelEl, plot) {
    if (plot.traces.find(trace => trace.varName === varName && trace.fileId === this.activeFileId)) return;
    if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
    plot.traces.push({
        varName,
        color: this._nextTraceColor(plot.traces),
        fileId: this.activeFileId,
        axis: 'y',
    });
    this._ensureTemporalProfileState(plot);
    if (!plot.div) this._createTemporalProfileChart(panelId, panelEl);
    else {
        this._refreshTemporalProfileTimePlot(panelId, plot, { preserveView: true });
        this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
    }
};

proto._createTemporalProfileChart = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    if (!this._hasContent(plot)) return;
    const state = this._ensureTemporalProfileState(plot);
    const restoreView = plot._pendingViewRestore || null;
    delete plot._pendingViewRestore;
    if (restoreView?.temporalProfileView) plot._temporalProfilePendingView = restoreView.temporalProfileView;

    const placeholder = panelEl.querySelector('.layout-panel-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    panelEl.querySelector('.temporal-profile-container')?.remove();

    const container = document.createElement('div');
    container.className = `hist-container temporal-profile-container hist-layout-${state.layout}${state.timeSeriesHidden ? ' hist-time-series-hidden' : ''}`;
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
        state.timeSeriesHidden ? text('temporalProfileShowTime') : text('temporalProfileHideTime'),
        state.timeSeriesHidden ? text('temporalProfileShowTime') : text('temporalProfileHideTime'),
        () => this._toggleTemporalProfileTimeSeries(panelId));
    timeButton.classList.toggle('active', state.timeSeriesHidden);
    timeButton.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    layoutGroup.append(
        makeButton('hist-tool-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureTemporalProfileState(plot).layout;
            this._setTemporalProfileLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        }),
        timeButton,
    );
    const actionGroup = document.createElement('div');
    actionGroup.className = 'hist-topbar-group';
    const optionsButton = makeButton('hist-tool-btn hist-options-btn', text('temporalProfileOptions'), text('temporalProfileOptions'), () => this._toggleTemporalProfileOptions(panelId));
    optionsButton.classList.toggle('active', state.optionsVisible);
    optionsButton.setAttribute('aria-pressed', String(state.optionsVisible));
    actionGroup.append(
        makeButton('hist-tool-btn', text('temporalProfileReset'), text('temporalProfileResetTip'), () => this._resetTemporalProfileView(panelId)),
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
    timeDiv.className = 'plotly-container plotly-mode-profile-time';
    const profileDiv = document.createElement('div');
    profileDiv.className = 'plotly-container plotly-mode-profile-analysis';
    timePane.appendChild(timeDiv);
    analysisPane.appendChild(profileDiv);
    plotArea.append(timePane, splitter, analysisPane);
    const options = document.createElement('aside');
    options.className = 'hist-options fft-options temporal-profile-options';
    options.hidden = !state.optionsVisible;
    workspace.append(plotArea, options);
    container.append(topbar, workspace);
    panelEl.appendChild(container);

    plot.temporalProfileContainer = container;
    plot.temporalProfileDiv = profileDiv;
    plot.div = timeDiv;
    this._renderTemporalProfileOptionsPanel(panelId, plot);
    const config = this._getPlotlyConfig();
    Promise.all([
        Plotly.newPlot(timeDiv, this._buildTemporalProfileTimeTraces(plot), this._buildTemporalProfileTimeLayout(plot), config),
        Plotly.newPlot(profileDiv, [], this._buildTemporalProfileLayout(plot), config),
    ]).then(() => {
        this._refreshActionBtns(panelId);
        const viewPromise = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
        Promise.resolve(viewPromise).then(() => this._refreshTimeseriesVisuals(panelId, plot));
        this._installTemporalProfilePlotHandlers(panelId, plot);
        this._installCursorHandlers?.(panelId, plot);
        this._installTemporalProfileSelectionHandlers(panelId, plot);
        this._installTemporalProfileSplitterHandlers(panelId, plot);
        this._installWheelPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
        this._installWheelPan(panelId, plot, profileDiv);
        this._installRightButtonPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
        this._installRightButtonPan(panelId, plot, profileDiv);
        this._syncCursorDisplay?.(panelId, plot);
        this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
        let timer;
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { Plotly.Plots.resize(timeDiv); Plotly.Plots.resize(profileDiv); }, 50);
        });
        observer.observe(panelEl);
        plot.resizeObserver = observer;
    });
};

proto._buildTemporalProfileTimeTraces = function(plot) {
    return plot.traces.map((trace, index) => this._buildTimeTrace(trace, null, plot, index)).filter(Boolean);
};

proto._buildTemporalProfileTimeLayout = function(plot) {
    const layout = this._buildTimeLayout(plot);
    layout.shapes = this._temporalProfileSelectionShapes(plot);
    layout.margin = { ...(layout.margin || {}), t: 8 };
    layout.hovermode = false;
    return layout;
};

proto._refreshTemporalProfileTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
    if (!plot?.div || plot.mode !== 'temporal-profile') return Promise.resolve();
    const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
    const yRange = options.preserveView ? plot.div._fullLayout?.yaxis?.range : null;
    const layout = this._buildTemporalProfileTimeLayout(plot);
    if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
    if (Array.isArray(yRange)) layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
    return Plotly.react(plot.div, this._buildTemporalProfileTimeTraces(plot), layout, this._getPlotlyConfig()).then(() => {
        this._installLegendHoverHint(plot.div);
        this._installTemporalProfileSelectionHandlers(panelId, plot);
        this._refreshTimeseriesVisuals(panelId, plot);
    });
};

proto._installTemporalProfilePlotHandlers = function(panelId, plot) {
    if (!plot?.div || !plot?.temporalProfileDiv) return;
    if (plot._temporalProfileHandlerTimeDiv === plot.div
        && plot._temporalProfileHandlerAnalysisDiv === plot.temporalProfileDiv) return;
    plot._temporalProfileHandlerTimeDiv = plot.div;
    plot._temporalProfileHandlerAnalysisDiv = plot.temporalProfileDiv;
    const bindLegend = (div) => {
        let lastShift = false;
        div.addEventListener('mousedown', event => { lastShift = !!event.shiftKey; }, { capture: true });
        div.on('plotly_legendclick', eventData => {
            const data = eventData.data?.[eventData.curveNumber];
            const key = data?.meta?.temporalProfileTraceKey;
            const name = data?.name;
            this._handleTemporalProfileLegendClick(panelId, plot, key, name, !!(eventData.event?.shiftKey || lastShift));
            lastShift = false;
            return false;
        });
        div.on('plotly_legenddoubleclick', () => false);
        div.on('plotly_afterplot', () => this._installLegendHoverHint(div));
    };
    bindLegend(plot.div);
    bindLegend(plot.temporalProfileDiv);
    plot.div.on('plotly_relayout', eventData => this._onRelayout(panelId, eventData));
    plot.div.on('plotly_doubleclick', () => { this._autoScalePlotTimeOnly(plot); return false; });
    plot.temporalProfileDiv.on('plotly_doubleclick', () => {
        // Let Plotly finish dispatching its double-click before applying our
        // fixed calendar-domain reset. Relayout inside this callback can race
        // Plotly's own double-click autorange transaction.
        setTimeout(() => {
            if (this.plots.get(panelId) === plot) this._resetTemporalProfileAnalysisView(plot);
        }, 0);
        return false;
    });
};

proto._handleTemporalProfileLegendClick = function(panelId, plot, key, name, shiftClick = false) {
    let trace = key
        ? plot.traces.find(candidate => profileTraceKey(candidate) === key)
        : plot.traces.find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
    if (!trace) return;
    if (shiftClick) {
        const index = plot.traces.indexOf(trace);
        if (index >= 0) plot.traces.splice(index, 1);
        if (!plot.traces.length) this._clearPanel(panelId);
        else this._rebuildPanel(panelId, { preserveView: true });
        return;
    }
    trace.visible = trace.visible === 'legendonly' ? true : 'legendonly';
    this._refreshTemporalProfileTimePlot(panelId, plot, { preserveView: true });
    this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
};

proto._temporalProfileUnit = function(trace) {
    const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
    return variable ? this._extractUnit(variable.description) : '';
};

proto._temporalProfileCategoryEnabled = function(state, categoryId) {
    if (categoryId === 'workday') return state.workdays;
    if (categoryId === 'saturday') return state.saturdays;
    if (categoryId === 'sunday') return state.sundays;
    return true;
};

proto._temporalProfileMinimumResolutionMinutes = function(plot) {
    let minimum = null;
    for (const trace of plot?.traces || []) {
        if (!this._isVisible(trace) || traceIsLazy(this, trace) || this._fftTimeKind(trace.fileId) !== 'datetime') continue;
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName) || [];
        const stepMs = inferTemporalProfileStepMs(times);
        if (!Number.isFinite(stepMs) || stepMs <= 0) continue;
        const stepMinutes = stepMs / 60_000;
        minimum = minimum == null ? stepMinutes : Math.max(minimum, stepMinutes);
    }
    return minimum == null ? null : Math.round(minimum * 1e6) / 1e6;
};

proto._scheduleTemporalProfileRecompute = function(panelId, options = {}) {
    const plot = this.plots.get(panelId);
    if (!plot?.temporalProfileDiv || plot.mode !== 'temporal-profile') return;
    clearTimeout(plot._temporalProfileRecomputeTimer);
    const run = () => this._recomputeTemporalProfile(panelId, plot);
    if (options.immediate) run();
    else plot._temporalProfileRecomputeTimer = setTimeout(run, PROFILE_RECOMPUTE_DEBOUNCE_MS);
};

proto._recomputeTemporalProfile = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.temporalProfileDiv || plot.mode !== 'temporal-profile') return;
    const token = (plot._temporalProfileToken || 0) + 1;
    plot._temporalProfileToken = token;
    const state = this._ensureTemporalProfileState(plot);
    const range = state.rangeFull ? null : this._activeTemporalProfileRange(plot);
    const minimumResolution = this._temporalProfileMinimumResolutionMinutes(plot);
    plot._temporalProfileMinimumResolutionMinutes = minimumResolution;
    if (resolutionBelowStep(state.resolutionByPeriod[state.period], minimumResolution)) {
        const matchingPreset = PROFILE_RESOLUTION_PRESETS.find(value => !resolutionBelowStep(value, minimumResolution)
            && Math.abs(value - minimumResolution) <= Math.max(1e-9, minimumResolution * 1e-6));
        state.resolutionByPeriod[state.period] = matchingPreset ?? minimumResolution;
        state.customResolutionByPeriod[state.period] = matchingPreset == null;
        this._renderTemporalProfileOptionsPanel(panelId, plot);
    }
    const warnings = [];
    const models = [];
    const visibleDayCategories = PROFILE_CATEGORIES.filter(id => this._temporalProfileCategoryEnabled(state, id));
    if (state.period === 'day' && !visibleDayCategories.length) warnings.push(text('temporalProfileNoCategories'));

    for (let traceIndex = 0; traceIndex < (plot.traces || []).length; traceIndex++) {
        const trace = plot.traces[traceIndex];
        const name = this._traceName(trace.varName, trace.fileId);
        if (this._fftTimeKind(trace.fileId) !== 'datetime') {
            if (this._isVisible(trace)) warnings.push(`${name}: ${text('temporalProfileCalendarRequired')}`);
            continue;
        }
        if (traceIsLazy(this, trace)) {
            if (this._isVisible(trace)) warnings.push(`${name}: ${text('temporalProfileLazyUnsupported')}`);
            continue;
        }
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName) || [];
        const values = this._getTransformedVariableData(trace.fileId, trace.varName) || [];
        const result = buildTemporalProfile({
            times,
            values,
            period: state.period,
            resolutionMinutes: state.resolutionByPeriod[state.period],
            rangeStart: range?.[0] ?? null,
            rangeEnd: range?.[1] ?? null,
            discardIncomplete: state.discardIncomplete,
        });
        if (!result.ok) {
            const message = result.reason === 'tooManyBins' ? text('temporalProfileTooManyBins') : result.reason;
            warnings.push(`${name}: ${message}`);
            continue;
        }
        if (!result.stats.nFinite && this._isVisible(trace)) warnings.push(`${name}: ${text('temporalProfileNoFinite')}`);
        models.push({ trace, traceIndex, name, unit: this._temporalProfileUnit(trace), result });
    }
    if (plot._temporalProfileToken !== token) return;
    const visibleUnits = new Set(models.filter(model => this._isVisible(model.trace)).map(model => model.unit).filter(Boolean));
    if (visibleUnits.size > 1) warnings.push(text('temporalProfileMixedUnits'));
    plot._temporalProfileModels = models;
    state.warnings = warnings;
    const built = this._buildTemporalProfileTraces(plot, models);
    Plotly.react(plot.temporalProfileDiv, built.traces, built.layout, this._getPlotlyConfig()).then(() => {
        this._installLegendHoverHint(plot.temporalProfileDiv);
        this._syncTemporalProfileSummary(plot);
    });
    const bins = models[0]?.result?.binCount;
    const ready = bins ? `${bins} bins · UTC` : '';
    this._setTemporalProfileStatus(plot, warnings.length ? `${ready}${ready ? ' — ' : ''}${warnings.join(' | ')}` : ready, warnings.length ? 'warning' : 'ready');
};

proto._temporalProfileSeriesColor = function(model, categoryIndex) {
    if (model.result.period !== 'day') return model.trace.color;
    return this._nextColor(model.traceIndex * 3 + categoryIndex);
};

proto._buildTemporalProfileTraces = function(plot, models = []) {
    const state = this._ensureTemporalProfileState(plot);
    const traces = [];
    const visibleUnits = new Set(models.filter(model => this._isVisible(model.trace)).map(model => model.unit).filter(Boolean));
    const mixedUnits = visibleUnits.size > 1;
    for (const model of models) {
        const categories = model.result.categories.filter(category => this._temporalProfileCategoryEnabled(state, category.id));
        categories.forEach((category) => {
            const categoryIndex = state.period === 'day' ? PROFILE_CATEGORIES.indexOf(category.id) : 0;
            const color = this._temporalProfileSeriesColor(model, categoryIndex);
            const categoryLabel = profileCategoryLabel(category.id);
            const name = categoryLabel ? `${model.name} · ${categoryLabel}` : model.name;
            const x = category.bins.map(bin => bin.centerHours);
            const y = category.bins.map(bin => bin.mean);
            const customdata = category.bins.map(bin => [bin.std, bin.nPeriods, bin.nExpectedPeriods, bin.coverage, bin.nInvalidSamples, bin.nGapPeriods]);
            const meta = { temporalProfileTraceKey: profileTraceKey(model.trace) };
            const visible = model.trace.visible ?? true;
            const hovertemplate = `<b>%{fullData.name}</b><br>x = %{x:.4g}<br>${text('temporalProfileMean')} = %{y:.6g}<br>${text('temporalProfileStd')} = %{customdata[0]:.6g}<br>${text('temporalProfileCoverage')} = %{customdata[1]}/%{customdata[2]} (%{customdata[3]:.1%})<br>${text('temporalProfileInvalid')} = %{customdata[4]}<br>${text('temporalProfileGaps')} = %{customdata[5]}<extra></extra>`;
            if (state.renderMode === 'columns') {
                traces.push({
                    type: 'bar', x, y,
                    width: category.bins.map(bin => bin.endHours - bin.startHours),
                    name, visible, meta,
                    marker: {
                        color,
                        opacity: PROFILE_BAR_OPACITY,
                        line: { color, width: 1 },
                    },
                    customdata, hovertemplate,
                });
                return;
            }
            if (state.renderMode === 'line-band') {
                const lower = category.bins.map(bin => bin.mean == null || bin.std == null ? null : bin.mean - bin.std);
                const upper = category.bins.map(bin => bin.mean == null || bin.std == null ? null : bin.mean + bin.std);
                traces.push({ type: 'scatter', mode: 'lines', x, y: lower, line: { width: 0 }, hoverinfo: 'skip', showlegend: false, visible, meta });
                traces.push({ type: 'scatter', mode: 'lines', x, y: upper, line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(color, 0.18), hoverinfo: 'skip', showlegend: false, visible, meta });
            }
            traces.push({
                type: 'scatter', mode: 'lines', x, y,
                name, visible, meta,
                line: { color, width: 2 },
                customdata, hovertemplate,
                connectgaps: false,
            });
        });
    }
    const layout = this._buildTemporalProfileLayout(plot, { mixedUnits, unit: mixedUnits ? '' : [...visibleUnits][0] || '' });
    return { traces, layout };
};

proto._buildTemporalProfileLayout = function(plot, units = {}) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const state = this._ensureTemporalProfileState(plot);
    const unitSuffix = units.unit ? ` [${units.unit}]` : '';
    const layout = {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: this.legendPosition !== 'hidden',
        legend: this._legendConfig(legendBg, gridColor),
        barmode: 'overlay',
        bargap: 0,
        xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false, title: { text: `${text('temporalProfileMean')}${unitSuffix}`, font: { size: 10 } } },
        margin: { l: 62, r: 18, t: 8, b: 52 },
        autosize: true,
        hovermode: 'closest',
        uirevision: `temporal-profile-${state.period}-${state.resolutionByPeriod[state.period]}`,
    };
    if (state.period === 'day') {
        const ticks = Array.from({ length: 13 }, (_, index) => index * 2);
        Object.assign(layout.xaxis, { range: [0, 24], tickmode: 'array', tickvals: ticks, ticktext: ticks.map(hour => `${String(hour).padStart(2, '0')}:00`), title: { text: text('temporalProfileXAxisDay'), font: { size: 10 } } });
    } else if (state.period === 'week') {
        const weekdays = localizedWeekdays();
        Object.assign(layout.xaxis, { range: [0, 168], tickmode: 'array', tickvals: weekdays.map((_, index) => index * 24 + 12), ticktext: weekdays, title: { text: text('temporalProfileXAxisWeek'), font: { size: 10 } } });
    } else {
        const days = Array.from({ length: 31 }, (_, index) => index + 1);
        Object.assign(layout.xaxis, { range: [0, 31 * 24], tickmode: 'array', tickvals: days.map(day => (day - 0.5) * 24), ticktext: days.map(String), title: { text: text('temporalProfileXAxisMonth'), font: { size: 10 } } });
    }
    const pending = plot?._temporalProfilePendingView;
    plot._temporalProfilePendingView = null;
    if (Array.isArray(pending?.xRange)) layout.xaxis = { ...layout.xaxis, range: pending.xRange.slice(), autorange: false };
    if (Array.isArray(pending?.yRange)) layout.yaxis = { ...layout.yaxis, range: pending.yRange.slice(), autorange: false };
    return layout;
};

proto._setTemporalProfileStatus = function(plot, message, kind = 'muted') {
    const status = plot?.temporalProfileContainer?.querySelector('.hist-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = `hist-status hist-status-${kind}`;
};

// Temporal selection intentionally mirrors FFT, Heatmap and Histogram: the
// same green region, draggable handles, All/Selection control and UTC inputs.
proto._temporalProfileDomain = function(plot) {
    const arrays = [];
    for (const trace of plot?.traces || []) {
        const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        if (values?.length) arrays.push(values);
    }
    const extent = this._finiteExtent(arrays);
    return extent ? { min: extent.min, max: extent.max } : null;
};

proto._activeTemporalProfileRange = function(plot) {
    const state = this._ensureTemporalProfileState(plot);
    const domain = this._temporalProfileDomain(plot);
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

proto._temporalProfileSelectionShapes = function(plot) {
    if (this._ensureTemporalProfileState(plot).rangeFull) return [];
    const [lo, hi] = this._activeTemporalProfileRange(plot);
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

proto._updateTemporalProfileSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || plot.mode !== 'temporal-profile') return;
    Plotly.relayout(plot.div, { shapes: this._temporalProfileSelectionShapes(plot) });
    this._syncTemporalProfileOptionsPanel(plot);
};

proto._installTemporalProfileSelectionHandlers = function(panelId, plot) {
    if (!plot?.div || plot._temporalProfileSelectionDiv === plot.div) return;
    plot._temporalProfileSelectionDiv = plot.div;
    let dragging = null;
    const hitTest = (event) => {
        if (this._ensureTemporalProfileState(plot).rangeFull) return null;
        if (!this._eventInsidePlotArea(plot.div, event)) return null;
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x)) return null;
        const domain = this._temporalProfileDomain(plot);
        if (!domain) return null;
        const [lo, hi] = this._activeTemporalProfileRange(plot);
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
        const [lo, hi] = this._activeTemporalProfileRange(plot);
        dragging = { hit, startX: x, startLo: lo, startHi: hi };
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        document.body.classList.add('fft-selection-dragging');
        document.body.classList.toggle('fft-selection-moving', hit === 'move');
    }, true);
    const onMove = (event) => {
        if (!dragging || !plot.div) return;
        const domain = this._temporalProfileDomain(plot);
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x) || !domain) return;
        const state = this._ensureTemporalProfileState(plot);
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
        this._updateTemporalProfileSelectionShapes(panelId, plot);
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('fft-selection-dragging', 'fft-selection-moving');
        if (plot.div) setCursorHint(null);
        this._scheduleTemporalProfileRecompute(panelId);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._temporalProfileSelectionDocListeners = { move: onMove, up: onUp };
};

proto._setTemporalProfileRangeMode = function(panelId, full) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const state = this._ensureTemporalProfileState(plot);
    if (state.rangeFull === full) return;
    state.rangeFull = full;
    if (!full) {
        const axis = plot.div?._fullLayout?.xaxis;
        const domain = this._temporalProfileDomain(plot);
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
    this._updateTemporalProfileSelectionShapes(panelId, plot);
    this._renderTemporalProfileOptionsPanel(panelId, plot);
    this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
};

proto._setTemporalProfileLayout = function(panelId, layout) {
    const plot = this.plots.get(panelId);
    if (!plot?.temporalProfileContainer || !PROFILE_LAYOUTS.has(layout)) return;
    this._ensureTemporalProfileState(plot).layout = layout;
    plot.temporalProfileContainer.classList.toggle('hist-layout-horizontal', layout === 'horizontal');
    plot.temporalProfileContainer.classList.toggle('hist-layout-vertical', layout === 'vertical');
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.temporalProfileDiv);
};

proto._toggleTemporalProfileTimeSeries = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.temporalProfileContainer) return;
    const state = this._ensureTemporalProfileState(plot);
    state.timeSeriesHidden = !state.timeSeriesHidden;
    plot.temporalProfileContainer.classList.toggle('hist-time-series-hidden', state.timeSeriesHidden);
    const button = plot.temporalProfileContainer.querySelector('.hist-time-series-btn');
    if (button) {
        button.textContent = state.timeSeriesHidden ? text('temporalProfileShowTime') : text('temporalProfileHideTime');
        button.title = button.textContent;
        button.classList.toggle('active', state.timeSeriesHidden);
        button.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    }
    if (!state.timeSeriesHidden && plot.div) {
        Plotly.Plots.resize(plot.div);
        this._refreshPanelDomOverlays(plot);
    }
    if (plot.temporalProfileDiv) Plotly.Plots.resize(plot.temporalProfileDiv);
};

proto._toggleTemporalProfileOptions = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.temporalProfileContainer) return;
    const state = this._ensureTemporalProfileState(plot);
    state.optionsVisible = !state.optionsVisible;
    const options = plot.temporalProfileContainer.querySelector('.hist-options');
    if (options) options.hidden = !state.optionsVisible;
    const button = plot.temporalProfileContainer.querySelector('.hist-options-btn');
    if (button) {
        button.classList.toggle('active', state.optionsVisible);
        button.setAttribute('aria-pressed', String(state.optionsVisible));
    }
    Plotly.Plots.resize(plot.div);
    Plotly.Plots.resize(plot.temporalProfileDiv);
};

proto._resetTemporalProfileView = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;
    const state = this._ensureTemporalProfileState(plot);
    state.rangeFull = true;
    state.x1 = null;
    state.x2 = null;
    this._updateTemporalProfileSelectionShapes(panelId, plot);
    this._renderTemporalProfileOptionsPanel(panelId, plot);
    this._autoScalePlotTimeOnly(plot);
    this._resetTemporalProfileAnalysisView(plot);
    this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
};

proto._resetTemporalProfileAnalysisView = function(plot) {
    if (!plot?.temporalProfileDiv) return Promise.resolve();
    const period = this._ensureTemporalProfileState(plot).period;
    const xMax = period === 'day' ? 24 : period === 'week' ? 168 : 31 * 24;
    return Plotly.relayout(plot.temporalProfileDiv, {
        'xaxis.range': [0, xMax],
        'xaxis.autorange': false,
        'yaxis.autorange': true,
    });
};

proto._autoScaleTemporalProfilePanel = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div) return Promise.resolve();
    return Promise.all([
        this._autoScalePlotTimeOnly(plot),
        this._resetTemporalProfileAnalysisView(plot),
    ]);
};

proto._installTemporalProfileSplitterHandlers = function(panelId, plot) {
    const splitter = plot?.temporalProfileContainer?.querySelector('.hist-splitter');
    if (!splitter || splitter._temporalProfileBound) return;
    splitter._temporalProfileBound = true;
    let dragging = false;
    const apply = (event) => {
        if (!plot.temporalProfileContainer) return;
        const state = this._ensureTemporalProfileState(plot);
        const area = plot.temporalProfileContainer.querySelector('.hist-plot-area');
        const rect = area?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const fraction = state.layout === 'vertical'
            ? (event.clientY - rect.top) / rect.height
            : (event.clientX - rect.left) / rect.width;
        state.split = Math.max(0.2, Math.min(0.8, fraction));
        plot.temporalProfileContainer.style.setProperty('--hist-split', `${Math.round(state.split * 1000) / 10}%`);
        Plotly.Plots.resize(plot.div);
        Plotly.Plots.resize(plot.temporalProfileDiv);
    };
    splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
    const onMove = event => { if (dragging) apply(event); };
    const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._temporalProfileSplitterDocListeners = { move: onMove, up: onUp };
    void panelId;
};

proto._renderTemporalProfileOptionsPanel = function(panelId, plot) {
    const state = this._ensureTemporalProfileState(plot);
    const options = plot?.temporalProfileContainer?.querySelector('.hist-options');
    if (!options) return;
    options.innerHTML = '';
    const section = (label) => {
        const title = document.createElement('div');
        title.className = 'fft-options-subtitle';
        title.textContent = label;
        options.appendChild(title);
    };
    const row = (labelText, control, tooltip = '') => {
        const label = document.createElement('label');
        label.className = 'fft-option-row hist-option-row';
        if (tooltip) label.title = tooltip;
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, control);
        options.appendChild(label);
        return label;
    };
    const segmented = (items, current, onPick) => {
        const wrap = document.createElement('div');
        wrap.className = 'hist-segmented';
        const buttons = [];
        for (const item of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'hist-seg-btn';
            button.textContent = item.label;
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
    const checkbox = (checked, onChange) => {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'fft-checkbox';
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        return input;
    };

    section(text('temporalProfileTimeScope'));
    options.appendChild(segmented([
        { label: text('temporalProfileAll'), value: true },
        { label: text('temporalProfileSelection'), value: false },
    ], state.rangeFull, full => this._setTemporalProfileRangeMode(panelId, full)));
    const domain = this._temporalProfileDomain(plot);
    const activeRange = this._activeTemporalProfileRange(plot);
    const boundBlock = (labelText, key, index) => {
        const wrap = document.createElement('div');
        wrap.className = 'hist-range-bound hist-range-bound-datetime';
        const label = document.createElement('label');
        label.className = 'fft-option-row hist-option-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'datetime-local';
        input.step = '1';
        input.className = 'fft-number-input';
        input.dataset.profileKey = key;
        input.dataset.profileRole = 'input';
        input.disabled = state.rangeFull;
        input.value = utcInputValue(activeRange[index]);
        input.addEventListener('change', () => {
            let value = utcInputMs(input.value);
            if (Number.isFinite(value) && domain) value = Math.max(domain.min, Math.min(domain.max, value));
            state[key] = Number.isFinite(value) ? value : null;
            this._updateTemporalProfileSelectionShapes(panelId, plot);
            this._scheduleTemporalProfileRecompute(panelId);
        });
        label.append(span, input);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'fft-range-input';
        slider.dataset.profileKey = key;
        slider.dataset.profileRole = 'slider';
        slider.disabled = state.rangeFull;
        if (domain) { slider.min = String(domain.min); slider.max = String(domain.max); slider.step = 'any'; }
        if (Number.isFinite(activeRange[index])) slider.value = String(activeRange[index]);
        slider.addEventListener('input', () => {
            const number = Number(slider.value);
            state[key] = Number.isFinite(number) ? number : null;
            this._updateTemporalProfileSelectionShapes(panelId, plot);
        });
        slider.addEventListener('change', () => this._scheduleTemporalProfileRecompute(panelId));
        wrap.append(label, slider);
        options.appendChild(wrap);
    };
    boundBlock(text('temporalProfileStart'), 'x1', 0);
    boundBlock(text('temporalProfileEnd'), 'x2', 1);

    section(text('temporalProfilePeriod'));
    options.appendChild(segmented([
        { label: text('temporalProfileDay'), value: 'day' },
        { label: text('temporalProfileWeek'), value: 'week' },
        { label: text('temporalProfileMonth'), value: 'month' },
    ], state.period, period => {
        state.period = period;
        this._renderTemporalProfileOptionsPanel(panelId, plot);
        this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
    }));
    if (state.period === 'day') {
        section(text('temporalProfileCategories'));
        row(text('temporalProfileWorkdays'), checkbox(state.workdays, checked => { state.workdays = checked; this._scheduleTemporalProfileRecompute(panelId, { immediate: true }); }));
        row(text('temporalProfileSaturdays'), checkbox(state.saturdays, checked => { state.saturdays = checked; this._scheduleTemporalProfileRecompute(panelId, { immediate: true }); }));
        row(text('temporalProfileSundays'), checkbox(state.sundays, checked => { state.sundays = checked; this._scheduleTemporalProfileRecompute(panelId, { immediate: true }); }));
    }

    section(text('temporalProfileResolution'));
    const currentResolution = state.resolutionByPeriod[state.period];
    const minimumResolution = this._temporalProfileMinimumResolutionMinutes(plot);
    if (Number.isFinite(minimumResolution) && minimumResolution > 0) {
        const stepValue = document.createElement('span');
        stepValue.className = 'hist-option-value';
        stepValue.textContent = resolutionLabel(minimumResolution);
        row(text('temporalProfileDataStep'), stepValue);
    }
    const select = document.createElement('select');
    select.className = 'fft-select';
    for (const minutes of PROFILE_RESOLUTION_PRESETS) {
        const option = document.createElement('option');
        option.value = String(minutes);
        option.textContent = resolutionLabel(minutes);
        option.disabled = resolutionBelowStep(minutes, minimumResolution);
        select.appendChild(option);
    }
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = text('temporalProfileCustom');
    select.appendChild(customOption);
    select.value = state.customResolutionByPeriod[state.period]
        ? 'custom'
        : (PROFILE_RESOLUTION_PRESETS.includes(currentResolution) ? String(currentResolution) : 'custom');
    select.addEventListener('change', () => {
        state.customResolutionByPeriod[state.period] = select.value === 'custom';
        if (select.value !== 'custom') state.resolutionByPeriod[state.period] = Number(select.value);
        this._renderTemporalProfileOptionsPanel(panelId, plot);
        this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
    });
    row(text('temporalProfileResolution'), select);
    if (select.value === 'custom') {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'fft-number-input';
        input.min = String(Number.isFinite(minimumResolution) && minimumResolution > 0 ? minimumResolution : 0.000001);
        input.step = 'any';
        input.value = String(currentResolution);
        input.addEventListener('change', () => {
            const number = Number(input.value);
            if (Number.isFinite(number) && number > 0) {
                const resolution = resolutionBelowStep(number, minimumResolution) ? minimumResolution : number;
                state.resolutionByPeriod[state.period] = resolution;
                input.value = String(resolution);
                this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
            }
        });
        row(text('temporalProfileMinutes'), input);
    }

    section(text('temporalProfileDisplay'));
    options.appendChild(segmented([
        { label: text('temporalProfileColumns'), value: 'columns' },
        { label: text('temporalProfileLine'), value: 'line' },
        { label: `±1σ`, value: 'line-band' },
    ], state.renderMode, renderMode => {
        state.renderMode = renderMode;
        this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
    }));
    const discardKey = state.period === 'day' ? 'temporalProfileDiscardDay'
        : state.period === 'week' ? 'temporalProfileDiscardWeek'
            : 'temporalProfileDiscardMonth';
    row(text(discardKey), checkbox(state.discardIncomplete, checked => {
        state.discardIncomplete = checked;
        this._scheduleTemporalProfileRecompute(panelId, { immediate: true });
    }), text('temporalProfileDiscardTip'));

    section(text('temporalProfileSummary'));
    const summary = document.createElement('div');
    summary.className = 'hist-summary temporal-profile-summary';
    options.appendChild(summary);
    this._syncTemporalProfileSummary(plot);
};

proto._syncTemporalProfileOptionsPanel = function(plot) {
    const options = plot?.temporalProfileContainer?.querySelector('.hist-options');
    if (!options) return;
    const [lo, hi] = this._activeTemporalProfileRange(plot);
    const values = { x1: lo, x2: hi };
    for (const key of ['x1', 'x2']) {
        const input = options.querySelector(`input[data-profile-role="input"][data-profile-key="${key}"]`);
        const slider = options.querySelector(`input[data-profile-role="slider"][data-profile-key="${key}"]`);
        if (input && document.activeElement !== input) input.value = utcInputValue(values[key]);
        if (slider && document.activeElement !== slider && Number.isFinite(values[key])) slider.value = String(values[key]);
    }
};

proto._syncTemporalProfileSummary = function(plot) {
    const box = plot?.temporalProfileContainer?.querySelector('.temporal-profile-summary');
    if (!box) return;
    const state = this._ensureTemporalProfileState(plot);
    const rows = [];
    for (const model of plot._temporalProfileModels || []) {
        if (!this._isVisible(model.trace)) continue;
        const categories = model.result.categories.filter(category => this._temporalProfileCategoryEnabled(state, category.id));
        for (const category of categories) {
            const expectedBins = category.bins.filter(bin => bin.nExpectedPeriods > 0);
            const coverages = expectedBins.map(bin => bin.coverage).filter(Number.isFinite);
            const minimumCoverage = coverages.length ? Math.min(...coverages) : null;
            const incompleteBins = expectedBins.filter(bin => (bin.coverage != null && bin.coverage < 1) || bin.nInvalidSamples || bin.nGapPeriods).length;
            const label = profileCategoryLabel(category.id);
            const title = label ? `${model.name} · ${label}` : model.name;
            const parts = [
                `${category.included}/${category.total} ${text('temporalProfilePeriods')}`,
                `${category.discarded} ${text('temporalProfileDiscarded')}`,
                `${category.partial} ${text('temporalProfilePartial')}`,
            ];
            if (minimumCoverage != null) parts.push(`${text('temporalProfileCoverage')}: ${(minimumCoverage * 100).toFixed(1)}% · ${incompleteBins} bins`);
            rows.push(`<div class="hist-summary-row"><strong>${escapeHtml(title)}</strong><br>${parts.join(' · ')}</div>`);
        }
    }
    box.innerHTML = rows.join('');
};

}
