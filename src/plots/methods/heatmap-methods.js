import i18n from '../../i18n/index.js';
import {
    buildCalendarHeatmap,
    calendarHeatmapCellValue,
    densifyCalendarHeatmap,
} from '../../utils/calendar-heatmap.js';
import Plotly from '../../vendor/plotly.js';

const HEATMAP_LAYOUTS = new Set(['horizontal', 'vertical']);
const HEATMAP_CALENDAR_MODES = new Set(['week-day', 'day-hour']);
const HEATMAP_AGGREGATIONS = new Set(['mean', 'min', 'max', 'sum', 'count', 'integral']);
const HEATMAP_COLOR_SCALES = new Set(['Viridis', 'Cividis', 'RdBu']);
// Cells whose integral is broken by missing data are painted in a color that
// belongs to no part of the chosen palette, so they cannot be mistaken for a
// value: warm red over the blue-to-yellow scales, green over the red-blue one.
const HEATMAP_GAP_COLORS = { Viridis: '#e03131', Cividis: '#e03131', RdBu: '#2f9e44' };
const HEATMAP_COLOR_RANGE_MODES = new Set(['auto', 'manual']);
const HEATMAP_RECOMPUTE_DEBOUNCE_MS = 150;
const HEATMAP_MANY_TRACES_WARNING = 6;
// Height each small multiple gets when the pane is too short for all of them
// (scrolling), and the height below which a subplot stops being readable.
const HEATMAP_PREFERRED_PLOT_HEIGHT_DAY_HOUR = 360;
const HEATMAP_PREFERRED_PLOT_HEIGHT_WEEK_DAY = 180;
const HEATMAP_MIN_PLOT_HEIGHT_DAY_HOUR = 230;
const HEATMAP_MIN_PLOT_HEIGHT_WEEK_DAY = 110;
// Half of the vertical room left between two stacked small multiples: the title
// of the lower one is drawn inside that room.
const HEATMAP_SUBPLOT_GAP_PX = 20;

const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const hasFinite = (value) => value !== ''
    && value !== null
    && value !== undefined
    && Number.isFinite(Number(value));

const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const fallbackText = {
    heatmapLayoutToggle: 'Switch vertical / horizontal layout',
    heatmapReset: 'Reset',
    heatmapResetView: 'Reset time scope, color range and both views',
    heatmapShowOptions: 'Show options',
    heatmapHideOptions: 'Hide options',
    heatmapRefresh: 'Update Heatmap',
    heatmapRefreshTooltip: 'Recompute the Heatmap with the newly appended data',
    heatmapTemporalScope: 'Time scope',
    heatmapTemporalScopeTooltip: 'Choose which part of the time-series feeds the Heatmap cells',
    heatmapScopeAll: 'All',
    heatmapScopeAllTooltip: 'Use the whole time range of the signals; zooming the time-series does not change the Heatmap',
    heatmapScopeSelection: 'Selection',
    heatmapScopeSelectionTooltip: 'Use only the highlighted interval; drag its edges on the time-series or type the bounds below',
    heatmapSelectionStart: 'Start',
    heatmapSelectionStartTooltip: 'First instant of the selection (UTC). Cells at the edge may be only partially covered',
    heatmapSelectionEnd: 'End',
    heatmapSelectionEndTooltip: 'Last instant of the selection (UTC). Cells at the edge may be only partially covered',
    heatmapGeometry: 'Geometry',
    heatmapGeometryTooltip: 'Calendar grid used to lay out the cells',
    heatmapWeekDay: 'Week × day',
    heatmapWeekDayTooltip: 'Columns are ISO weeks, rows are Monday to Sunday. Each cell aggregates one calendar day. Good for weekly patterns',
    heatmapDayHour: 'Day × hour',
    heatmapDayHourTooltip: 'Columns are calendar days, rows are hours 00:00 to 23:00. Each cell aggregates one hour. Good for daily patterns',
    heatmapAggregation: 'Aggregation',
    heatmapAggregationTooltip: 'How the samples inside each cell are reduced to a single color value. Switching it reuses the computed cells and does not re-read the data',
    heatmapMean: 'Mean',
    heatmapMeanTooltip: 'Mean: average of the finite samples in the cell. Default; best for comparing typical levels',
    heatmapMin: 'Minimum',
    heatmapMinTooltip: 'Minimum: smallest finite sample in the cell. Useful for dips and lower bounds',
    heatmapMax: 'Maximum',
    heatmapMaxTooltip: 'Maximum: largest finite sample in the cell. Useful for peaks',
    heatmapSum: 'Sample sum',
    heatmapSumTooltip: 'Sample sum: adds the finite samples of the cell. It is not a time integral (energy). With regular sampling it is just the mean times a constant sample count, so the map can look nearly uniform',
    heatmapCount: 'Finite count',
    heatmapCountTooltip: 'Finite count: how many finite samples fall in the cell, ignoring their value. With regular sampling every full cell holds the same number of samples, so a nearly flat map is expected; it mainly reveals gaps, partial cells and missing data',
    heatmapIntegral: 'Integral',
    heatmapIntegralTooltip: 'Integral: area of the signal over time inside the cell (trapezoidal, split at the cell boundaries), reported in unit x hours — a power in MW gives energy in MWh. Cells whose data has holes are painted in the gap color instead of an untrustworthy value',
    heatmapGapCell: 'Missing data: no integral for this cell',
    heatmapGapMissing: 'time not covered',
    heatmapGapLegend: 'Gap (missing data)',
    heatmapIntegralUnsorted: 'The integral needs timestamps in chronological order.',
    heatmapDataGaps: 'Some cells have missing data and carry no integral.',
    heatmapMedianStep: 'Sampling step',
    heatmapTimeZone: 'Time zone',
    heatmapTimeZoneTooltip: 'Cell boundaries are always computed in UTC so the same file gives the same cells on any machine',
    heatmapColor: 'Color',
    heatmapPalette: 'Palette',
    heatmapPaletteTooltip: 'Color scale of the cells. Viridis and Cividis are colorblind-friendly; RdBu is diverging and suits values crossing zero',
    heatmapReversePalette: 'Reverse palette',
    heatmapReversePaletteTooltip: 'Flip the direction of the color scale',
    heatmapColorRange: 'Color range',
    heatmapColorRangeTooltip: 'Range of values mapped to the palette',
    heatmapRangeAuto: 'Auto',
    heatmapRangeAutoTooltip: 'Fit the color range to the values actually present',
    heatmapRangeManual: 'Manual',
    heatmapRangeManualTooltip: 'Fix the color range yourself; needed to compare Heatmaps across sessions',
    heatmapColorMin: 'Minimum',
    heatmapColorMinTooltip: 'Value mapped to the low end of the palette',
    heatmapColorMax: 'Maximum',
    heatmapColorMaxTooltip: 'Value mapped to the high end of the palette',
    heatmapSharedRange: 'Shared range',
    heatmapSharedRangeTooltip: 'Use one common color range for every Heatmap so they can be compared directly. Only meaningful with signals of compatible units',
    heatmapSharedRangeDisabled: 'Only available with two or more signals',
    heatmapSharedUnitsWarning: 'A shared color range is comparing signals with different units.',
    heatmapSamplingHelp: 'The Heatmap aggregates recorded samples. With irregular sampling, more densely sampled periods have more weight. Sum is not a time integral.',
    heatmapIntegralHelp: 'The Integral weighs samples by the time between them (trapezoidal), so it does not depend on sampling density. Cells with data gaps show the gap color instead of a value.',
    heatmapNoTraces: 'Drop a numeric signal with a calendar DateTime index.',
    heatmapNoVisibleTraces: 'No visible signals.',
    heatmapCalendarRequired: 'Heatmap requires Calendar time mode.',
    heatmapDatetimeRequired: 'Heatmap requires a DateTime index.',
    heatmapGeneratedTimeUnsupported: 'Heatmap cannot use a generated numeric time index.',
    heatmapLazyUnsupported: 'Exact Heatmaps for lazy files are not available yet; the overview was not used.',
    heatmapLazyIntegralUnsupported: 'The Integral is not available for lazy files yet; use All/Selection with another aggregation.',
    heatmapLazyDerivedUnsupported: 'This overview-derived signal has no exact lazy aggregate.',
    heatmapNoRows: 'No rows in the selected time scope.',
    heatmapLoading: 'Building Heatmap…',
    heatmapReady: 'Heatmap ready',
    heatmapDirty: 'New data is available.',
    heatmapManualRangeInvalid: 'Manual color range requires finite minimum < maximum.',
    heatmapManyTraces: 'Many small multiples may require scrolling.',
    heatmapPartial: 'partial selection cell',
    heatmapSamples: 'samples',
    heatmapFinite: 'finite',
    heatmapInvalid: 'invalid',
    heatmapInterval: 'UTC interval',
};

const aggregationLabelKey = {
    mean: 'heatmapMean',
    min: 'heatmapMin',
    max: 'heatmapMax',
    sum: 'heatmapSum',
    count: 'heatmapCount',
    integral: 'heatmapIntegral',
};

const aggregationTooltipKey = {
    mean: 'heatmapMeanTooltip',
    min: 'heatmapMinTooltip',
    max: 'heatmapMaxTooltip',
    sum: 'heatmapSumTooltip',
    count: 'heatmapCountTooltip',
    integral: 'heatmapIntegralTooltip',
};

// The integral of a value sampled over time carries the value's unit times
// hours: a power in MW integrates to energy in MW·h.
function unitForAggregation(unit, aggregation) {
    if (aggregation === 'count') return '';
    if (aggregation !== 'integral') return unit || '';
    return unit ? `${unit}·h` : 'h';
}

function formatDurationMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '';
    const hours = value / 3600000;
    if (hours >= 1) return `${Number(hours.toFixed(2))} h`;
    const minutes = value / 60000;
    if (minutes >= 1) return `${Number(minutes.toFixed(1))} min`;
    return `${Math.round(value / 1000)} s`;
}

function text(key) {
    const translated = i18n.t(key);
    return translated && translated !== key ? translated : (fallbackText[key] || key);
}

function utcInputValue(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 19);
}

function utcInputMs(value) {
    if (!value) return NaN;
    return Date.parse(`${value}Z`);
}

function utcIso(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function utcDateLabel(ms) {
    return utcIso(ms).slice(0, 10);
}

function isoWeekLabel(ms) {
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return '';
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const day = new Date(midnight).getUTCDay() || 7;
    const thursday = new Date(midnight + (4 - day) * 86400000);
    const year = thursday.getUTCFullYear();
    const first = Date.UTC(year, 0, 1);
    const week = Math.ceil((((thursday.getTime() - first) / 86400000) + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

function localizedWeekdays() {
    const language = i18n.currentLang;
    if (language === 'es') return ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
    if (language === 'fr') return ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    if (language === 'it') return ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
    return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
}

function cellValue(cell, key, fallback = null) {
    if (!cell) return fallback;
    if (!Array.isArray(cell)) return cell[key] ?? fallback;
    // Kernel array contract: [cellStartMs, cellEndMs, nScope, nFinite,
    // nInvalid, sum, mean, min, max, partial]. Objects are also accepted so
    // this renderer remains tolerant of sparse/lazy results in later phases.
    const index = {
        cellStartMs: 0,
        cellEndMs: 1,
        nScope: 2,
        nFinite: 3,
        nInvalid: 4,
        sum: 5,
        mean: 6,
        min: 7,
        max: 8,
        partial: 9,
    }[key];
    return index === undefined ? fallback : (cell[index] ?? fallback);
}

function zForAggregation(grid, aggregation) {
    if (grid?.zByAggregation?.[aggregation]) return grid.zByAggregation[aggregation];
    if (grid?.aggregations?.[aggregation]) return grid.aggregations[aggregation];
    if (grid?.meta?.aggregation === aggregation || grid?.aggregation === aggregation) return grid.z;
    const cells = grid?.customdata || grid?.cells;
    if (!Array.isArray(cells)) return grid?.z || [];
    return cells.map(row => (Array.isArray(row) ? row.map((cell) => {
        if (!cell) return null;
        const value = calendarHeatmapCellValue(cell, aggregation);
        return Number.isFinite(value) ? value : null;
    }) : []));
}

function gridCellCount(grid) {
    const rows = Array.isArray(grid?.z) ? grid.z.length : 0;
    const columns = rows && Array.isArray(grid.z[0]) ? grid.z[0].length : (grid?.x?.length || 0);
    return rows * columns;
}

function traceIsLazy(manager, trace) {
    return !!manager.files.get(trace.fileId)?.data?._duckdb;
}

export function installPlotCalendarHeatmapMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._defaultCalendarHeatmapState = function() {
    return {
        layout: 'vertical',
        // The Heatmap area needs more room than the time-series it is derived
        // from, especially day x hour with its 24 rows.
        split: 0.4,
        optionsVisible: true,
        timeSeriesHidden: false,
        rangeFull: true,
        x1: null,
        x2: null,
        calendarMode: 'week-day',
        aggregation: 'mean',
        timeZone: 'UTC',
        colorScale: 'Viridis',
        reverseColorScale: false,
        colorRangeMode: 'auto',
        colorMin: null,
        colorMax: null,
        sharedColorRange: false,
        warnings: [],
        dirty: false,
    };
};

proto._normalizeCalendarHeatmapState = function(raw = {}) {
    const defaults = this._defaultCalendarHeatmapState();
    const split = Number(raw.split);
    const state = {
        ...defaults,
        ...raw,
        layout: HEATMAP_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout,
        split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
        optionsVisible: raw.optionsVisible !== false,
        timeSeriesHidden: raw.timeSeriesHidden === true,
        rangeFull: raw.rangeFull !== undefined
            ? !!raw.rangeFull
            : !(hasFinite(raw.x1) || hasFinite(raw.x2)),
        x1: finiteOrNull(raw.x1),
        x2: finiteOrNull(raw.x2),
        calendarMode: HEATMAP_CALENDAR_MODES.has(raw.calendarMode) ? raw.calendarMode : defaults.calendarMode,
        aggregation: HEATMAP_AGGREGATIONS.has(raw.aggregation) ? raw.aggregation : defaults.aggregation,
        timeZone: 'UTC',
        colorScale: HEATMAP_COLOR_SCALES.has(raw.colorScale) ? raw.colorScale : defaults.colorScale,
        reverseColorScale: raw.reverseColorScale === true,
        colorRangeMode: HEATMAP_COLOR_RANGE_MODES.has(raw.colorRangeMode) ? raw.colorRangeMode : defaults.colorRangeMode,
        colorMin: finiteOrNull(raw.colorMin),
        colorMax: finiteOrNull(raw.colorMax),
        sharedColorRange: raw.sharedColorRange === true,
        warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 20) : [],
        dirty: raw.dirty === true,
    };
    // Derived grids and DOM/query state never belong in a saved session.
    delete state.models;
    delete state.accumulators;
    delete state.promise;
    delete state.token;
    return state;
};

proto._ensureCalendarHeatmapState = function(plot) {
    if (!plot) return this._defaultCalendarHeatmapState();
    if (!plot.heatmap) {
        plot.heatmap = this._normalizeCalendarHeatmapState({});
        return plot.heatmap;
    }
    Object.assign(plot.heatmap, this._normalizeCalendarHeatmapState(plot.heatmap));
    return plot.heatmap;
};

proto._calendarHeatmapTraceEligibility = function(trace) {
    if (!trace?.fileId) return { ok: false, reason: text('heatmapDatetimeRequired') };
    const entry = this.files.get(trace.fileId);
    const variable = entry?.data?.variables?.[trace.varName];
    const valueType = String(variable?.dataType || '').toLowerCase();
    if (!variable
        || variable.plottable === false
        || variable.kind === 'abscissa'
        || variable.kind === 'parameter'
        || variable.timeKind === 'datetime'
        || /(string|date|time|duration|categorical|object)/.test(valueType)) {
        return { ok: false, reason: text('heatmapNoTraces') };
    }
    const timeVariable = this._getTimeVar(trace.fileId);
    if (entry?.data?.metadata?.timeKind !== 'datetime' || timeVariable?.timeKind !== 'datetime') {
        return { ok: false, reason: text('heatmapDatetimeRequired') };
    }
    if (this._isGeneratedIndexTime?.(trace.fileId, timeVariable)) {
        return { ok: false, reason: text('heatmapGeneratedTimeUnsupported') };
    }
    if (this._timeDisplayModeForVar(trace.fileId, timeVariable) !== 'calendar') {
        return { ok: false, reason: text('heatmapCalendarRequired') };
    }
    return { ok: true };
};

proto._addCalendarHeatmapTrace = function(panelId, varName, panelEl, plot) {
    if (plot.traces.find(trace => trace.varName === varName && trace.fileId === this.activeFileId)) return;
    const candidate = { varName, fileId: this.activeFileId };
    const eligibility = this._calendarHeatmapTraceEligibility(candidate);
    if (!eligibility.ok) {
        this._setCalendarHeatmapStatus(plot, eligibility.reason, 'blocked');
        const placeholder = panelEl?.querySelector('.layout-panel-placeholder');
        if (placeholder && !plot.div) {
            placeholder.textContent = eligibility.reason;
            placeholder.style.display = '';
        }
        return;
    }
    if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
    plot.traces.push({
        ...candidate,
        color: this._nextTraceColor(plot.traces),
        axis: 'y',
    });
    this._ensureCalendarHeatmapState(plot);
    if (!plot.div) this._createCalendarHeatmapChart(panelId, panelEl);
    else {
        this._refreshCalendarHeatmapTimePlot(panelId, plot, { preserveView: true });
        this._renderCalendarHeatmapOptionsPanel(panelId, plot);
        this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
    }
};

proto._createCalendarHeatmapChart = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    if (!this._hasContent(plot)) return;
    const state = this._ensureCalendarHeatmapState(plot);
    const restoreView = plot._pendingViewRestore || null;
    delete plot._pendingViewRestore;

    const placeholder = panelEl.querySelector('.layout-panel-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    panelEl.querySelector('.heatmap-container')?.remove();

    const container = document.createElement('div');
    container.className = `heatmap-container heatmap-layout-${state.layout}${state.timeSeriesHidden ? ' heatmap-time-series-hidden' : ''}`;
    container.style.setProperty('--heatmap-split', `${Math.round(state.split * 1000) / 10}%`);

    const makeButton = (className, label, title, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    };

    const topbar = document.createElement('div');
    topbar.className = 'heatmap-topbar';
    const layoutGroup = document.createElement('div');
    layoutGroup.className = 'heatmap-topbar-group';
    const timeSeriesButton = makeButton(
        'heatmap-tool-btn heatmap-time-series-btn',
        text('hideTimeSeries'),
        text('hideTimeSeriesTooltip'),
        () => this._toggleCalendarHeatmapTimeSeries(panelId),
    );
    timeSeriesButton.classList.toggle('active', state.timeSeriesHidden);
    timeSeriesButton.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    layoutGroup.append(
        makeButton('heatmap-tool-btn heatmap-layout-btn', 'V/H', text('heatmapLayoutToggle'), () => {
            const current = this._ensureCalendarHeatmapState(plot).layout;
            this._setCalendarHeatmapLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        }),
        timeSeriesButton,
    );

    const actionGroup = document.createElement('div');
    actionGroup.className = 'heatmap-topbar-group';
    const refreshButton = makeButton('heatmap-tool-btn heatmap-refresh-btn', text('heatmapRefresh'), text('heatmapRefreshTooltip'), () => {
        this._refreshDirtyCalendarHeatmap(panelId);
    });
    refreshButton.hidden = !state.dirty;
    const optionsButton = makeButton(
        'heatmap-tool-btn heatmap-options-btn',
        state.optionsVisible ? text('heatmapHideOptions') : text('heatmapShowOptions'),
        state.optionsVisible ? text('heatmapHideOptions') : text('heatmapShowOptions'),
        () => this._toggleCalendarHeatmapOptions(panelId),
    );
    optionsButton.classList.toggle('active', state.optionsVisible);
    optionsButton.setAttribute('aria-pressed', String(state.optionsVisible));
    actionGroup.append(
        makeButton('heatmap-tool-btn heatmap-reset-btn', text('heatmapReset'), text('heatmapResetView'), () => this._resetCalendarHeatmapView(panelId)),
        refreshButton,
        optionsButton,
    );

    const status = document.createElement('span');
    status.className = 'heatmap-status heatmap-status-muted';
    status.setAttribute('aria-live', 'polite');
    topbar.append(layoutGroup, actionGroup, status);

    const workspace = document.createElement('div');
    workspace.className = 'heatmap-workspace';
    const plotArea = document.createElement('div');
    plotArea.className = 'heatmap-plot-area';
    const timePane = document.createElement('div');
    timePane.className = 'heatmap-pane heatmap-time-pane';
    const analysisPane = document.createElement('div');
    analysisPane.className = 'heatmap-pane heatmap-analysis-pane';
    const splitter = document.createElement('div');
    splitter.className = 'heatmap-splitter';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', state.layout === 'vertical' ? 'horizontal' : 'vertical');
    splitter.tabIndex = 0;

    const timeDiv = document.createElement('div');
    timeDiv.className = 'plotly-container plotly-mode-heatmap-time';
    const heatmapDiv = document.createElement('div');
    heatmapDiv.className = 'plotly-container plotly-mode-calendar-heatmap';
    timePane.appendChild(timeDiv);
    analysisPane.appendChild(heatmapDiv);
    plotArea.append(timePane, splitter, analysisPane);

    const options = document.createElement('aside');
    options.className = 'heatmap-options';
    options.hidden = !state.optionsVisible;
    workspace.append(plotArea, options);
    container.append(topbar, workspace);
    panelEl.appendChild(container);

    plot.div = timeDiv;
    plot.heatmapDiv = heatmapDiv;
    plot.heatmapContainer = container;
    plot._calendarHeatmapModels = [];
    this._renderCalendarHeatmapOptionsPanel(panelId, plot);

    const config = this._getPlotlyConfig();
    Promise.all([
        Plotly.newPlot(timeDiv, this._buildCalendarHeatmapTimeTraces(plot), this._buildCalendarHeatmapTimeLayout(plot), config),
        Plotly.newPlot(heatmapDiv, [], this._buildCalendarHeatmapLayout(plot, []), config),
    ]).then(() => {
        if (this.plots.get(panelId) !== plot || plot.mode !== 'heatmap' || plot.div !== timeDiv) return;
        this._refreshActionBtns(panelId);
        const restoredTime = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
        Promise.resolve(restoredTime).then(() => {
            if (restoreView?.heatmapCalendar?.xRange && plot.heatmapDiv) {
                Plotly.relayout(plot.heatmapDiv, {
                    'xaxis.range': restoreView.heatmapCalendar.xRange,
                    'xaxis.autorange': false,
                });
            }
            this._refreshTimeseriesVisuals(panelId, plot);
        });
        this._installCalendarHeatmapPlotHandlers(panelId, plot);
        // Cursor capture handlers must be registered before selection handlers,
        // otherwise an enabled cursor that overlaps a selection boundary loses
        // the pointer event to the selection layer.
        this._installCursorHandlers?.(panelId, plot);
        this._installCalendarHeatmapSelectionHandlers(panelId, plot);
        this._installCalendarHeatmapSplitterHandlers(panelId, plot);
        this._installWheelPan(panelId, plot, plot.div, {
            finalize: (range) => this._onRelayout(panelId, { 'xaxis.range': range }),
        });
        this._installWheelPan(panelId, plot, plot.heatmapDiv);
        // Right-button drag pans the same panes, matching FFT/Histogram (Plotly's
        // native drag ignores button 2, which otherwise snaps to a zoom-box).
        this._installRightButtonPan(panelId, plot, plot.div, {
            finalize: (range) => this._onRelayout(panelId, { 'xaxis.range': range }),
        });
        this._installRightButtonPan(panelId, plot, plot.heatmapDiv);
        this._syncCursorDisplay?.(panelId, plot);
        this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });

        if (typeof ResizeObserver === 'function') {
            let timer;
            const observer = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    this._applyCalendarHeatmapMinHeight(plot);
                    if (plot.div) Plotly.Plots.resize(plot.div);
                    if (plot.heatmapDiv) Plotly.Plots.resize(plot.heatmapDiv);
                }, 50);
            });
            observer.observe(panelEl);
            plot.resizeObserver = observer;
        }
    }).catch((error) => {
        if (this.plots.get(panelId) === plot) this._setCalendarHeatmapStatus(plot, error?.message || String(error), 'error');
    });
};

proto._buildCalendarHeatmapTimeTraces = function(plot) {
    return (plot?.traces || [])
        .map((trace, index) => this._buildTimeTrace(trace, null, plot, index))
        .filter(Boolean);
};

proto._buildCalendarHeatmapTimeLayout = function(plot) {
    const layout = this._buildTimeLayout(plot);
    layout.shapes = this._calendarHeatmapSelectionShapes(plot);
    layout.margin = { ...(layout.margin || {}), t: 8 };
    layout.hovermode = false;
    return layout;
};

proto._refreshCalendarHeatmapTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
    if (!plot?.div || plot.mode !== 'heatmap') return Promise.resolve();
    const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
    const yRange = options.preserveView ? plot.div._fullLayout?.yaxis?.range : null;
    const layout = this._buildCalendarHeatmapTimeLayout(plot);
    if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
    if (Array.isArray(yRange)) layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
    return Plotly.react(plot.div, this._buildCalendarHeatmapTimeTraces(plot), layout, this._getPlotlyConfig())
        .then(() => {
            this._installLegendHoverHint(plot.div);
            this._installCalendarHeatmapSelectionHandlers(panelId, plot);
            this._refreshTimeseriesVisuals(panelId, plot);
        });
};

proto._installCalendarHeatmapPlotHandlers = function(panelId, plot) {
    if (!plot?.div || !plot?.heatmapDiv || plot._calendarHeatmapHandlersInstalled) return;
    plot._calendarHeatmapHandlersInstalled = true;
    let lastShift = false;
    plot.div.addEventListener('mousedown', event => { lastShift = !!event.shiftKey; }, { capture: true });
    plot.div.on('plotly_legendclick', (eventData) => {
        const name = eventData.data?.[eventData.curveNumber]?.name;
        const shift = !!(eventData.event?.shiftKey || lastShift);
        lastShift = false;
        this._handleCalendarHeatmapLegendClick(panelId, plot, name, shift);
        return false;
    });
    plot.div.on('plotly_legenddoubleclick', () => false);
    plot.div.on('plotly_afterplot', () => {
        this._installLegendHoverHint(plot.div);
        this._refreshPanelDomOverlays(plot);
    });
    plot.div.on('plotly_relayout', eventData => this._onRelayout(panelId, eventData));
    plot.div.on('plotly_doubleclick', () => {
        this._autoScalePlotTimeOnly(plot);
        return false;
    });
    this._installCalendarHeatmapAnalysisHandlers(plot);
    this._installLegendHoverHint(plot.div);
};

// Re-plotting the analysis div drops its Plotly listeners, so registration is
// kept idempotent and callable again after a rebuild.
proto._installCalendarHeatmapAnalysisHandlers = function(plot) {
    if (!plot?.heatmapDiv?.on) return;
    plot.heatmapDiv.removeAllListeners?.('plotly_doubleclick');
    plot.heatmapDiv.on('plotly_doubleclick', () => {
        Plotly.relayout(plot.heatmapDiv, { 'xaxis.autorange': true });
        return false;
    });
};

proto._handleCalendarHeatmapLegendClick = function(panelId, plot, clickedName, shiftClick = false) {
    if (!clickedName) return;
    const trace = (plot.traces || []).find(item => this._traceName(item.varName, item.fileId) === clickedName);
    if (!trace) return;
    if (shiftClick) {
        const index = plot.traces.indexOf(trace);
        if (index >= 0) plot.traces.splice(index, 1);
        if (!plot.traces.length) this._clearPanel(panelId);
        else this._rebuildPanel(panelId, { preserveView: true });
        return;
    }
    trace.visible = trace.visible === 'legendonly' ? true : 'legendonly';
    this._refreshCalendarHeatmapTimePlot(panelId, plot, { preserveView: true });
    this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
    this._renderCalendarHeatmapOptionsPanel(panelId, plot);
};

proto._calendarHeatmapDomain = function(plot) {
    const arrays = [];
    for (const trace of plot?.traces || []) {
        if (!this._calendarHeatmapTraceEligibility(trace).ok) continue;
        // Lazy files expose a downsampled overview whose first/last rows are the
        // exact time endpoints, so the x-axis extent is correct without a query.
        // The overview is never used as the heatmap result.
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        if (times?.length) arrays.push(times);
    }
    const extent = this._finiteExtent(arrays);
    return extent ? { min: extent.min, max: extent.max } : null;
};

proto._activeCalendarHeatmapRange = function(plot) {
    const state = this._ensureCalendarHeatmapState(plot);
    const domain = this._calendarHeatmapDomain(plot);
    if (state.rangeFull) {
        if (domain) return [domain.min, domain.max];
        return [0, 1];
    }
    let lower = hasFinite(state.x1) ? Number(state.x1) : NaN;
    let upper = hasFinite(state.x2) ? Number(state.x2) : NaN;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
        lower = domain?.min;
        upper = domain?.max;
    }
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return [0, 1];
    if (lower > upper) [lower, upper] = [upper, lower];
    if (domain) {
        lower = Math.max(domain.min, Math.min(domain.max, lower));
        upper = Math.max(domain.min, Math.min(domain.max, upper));
    }
    return [lower, upper];
};

proto._calendarHeatmapSelectionShapes = function(plot) {
    if (this._ensureCalendarHeatmapState(plot).rangeFull) return [];
    const [lower, upper] = this._activeCalendarHeatmapRange(plot);
    const firstTrace = (plot.traces || []).find(trace => this._calendarHeatmapTraceEligibility(trace).ok);
    if (!firstTrace) return [];
    const timeVariable = firstTrace ? this._getTimeVar(firstTrace.fileId) : null;
    const x0 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, lower, timeVariable) : lower;
    const x1 = firstTrace ? this._plotlyTimeValue(firstTrace.fileId, upper, timeVariable) : upper;
    // Green selection so it never reads as the amber Missing/NaN wash.
    const green = '#43a047';
    return [
        { type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(67,160,71,0.14)', line: { width: 0 }, layer: 'below' },
        { type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color: green, width: 2 } },
        { type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color: green, width: 2 } },
    ];
};

proto._updateCalendarHeatmapSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || plot.mode !== 'heatmap') return;
    Plotly.relayout(plot.div, { shapes: this._calendarHeatmapSelectionShapes(plot) });
    this._syncCalendarHeatmapOptionsPanel(plot);
};

proto._installCalendarHeatmapSelectionHandlers = function(panelId, plot) {
    if (!plot?.div || plot._calendarHeatmapSelectionDiv === plot.div) return;
    plot._calendarHeatmapSelectionDiv = plot.div;
    let dragging = null;
    const hitTest = (event) => {
        if (this._ensureCalendarHeatmapState(plot).rangeFull) return null;
        if (!this._eventInsidePlotArea(plot.div, event)) return null;
        const x = this._eventToXValue(plot.div, event);
        const domain = this._calendarHeatmapDomain(plot);
        if (!Number.isFinite(x) || !domain) return null;
        const [lower, upper] = this._activeCalendarHeatmapRange(plot);
        const xaxis = plot.div._fullLayout?.xaxis;
        const visibleSpan = Math.abs(
            this._coerceAxisValue(xaxis?.range?.[1]) - this._coerceAxisValue(xaxis?.range?.[0]),
        ) || Math.abs(upper - lower) || 1;
        const tolerance = Math.max((12 / (xaxis?._length || 1)) * visibleSpan, visibleSpan * 1e-6);
        const nearLower = Math.abs(x - lower) <= tolerance;
        const nearUpper = Math.abs(x - upper) <= tolerance;
        if (nearLower || nearUpper) return nearLower ? 'left' : 'right';
        const domainSpan = Math.abs(domain.max - domain.min) || 1;
        if (x >= lower && x <= upper && Math.abs(upper - lower) < domainSpan - tolerance) return 'move';
        return null;
    };
    const setCursor = (hit) => {
        plot.div.classList.toggle('heatmap-cursor-ew', hit === 'left' || hit === 'right');
        plot.div.classList.toggle('heatmap-cursor-grab', hit === 'move');
    };
    plot.div.addEventListener('mousemove', event => { if (!dragging) setCursor(hitTest(event)); });
    plot.div.addEventListener('mouseleave', () => { if (!dragging && plot.div) setCursor(null); });
    plot.div.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const hit = hitTest(event);
        if (!hit) return;
        const x = this._eventToXValue(plot.div, event);
        const [lower, upper] = this._activeCalendarHeatmapRange(plot);
        dragging = { hit, startX: x, startLower: lower, startUpper: upper };
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        document.body.classList.add('heatmap-selection-dragging');
        document.body.classList.toggle('heatmap-selection-moving', hit === 'move');
    }, true);
    const onMove = (event) => {
        if (!dragging || !plot.div) return;
        const domain = this._calendarHeatmapDomain(plot);
        const x = this._eventToXValue(plot.div, event);
        if (!domain || !Number.isFinite(x)) return;
        const state = this._ensureCalendarHeatmapState(plot);
        let lower = dragging.startLower;
        let upper = dragging.startUpper;
        if (dragging.hit === 'left') lower = x;
        else if (dragging.hit === 'right') upper = x;
        else {
            let delta = x - dragging.startX;
            if (dragging.startLower + delta < domain.min) delta = domain.min - dragging.startLower;
            if (dragging.startUpper + delta > domain.max) delta = domain.max - dragging.startUpper;
            lower = dragging.startLower + delta;
            upper = dragging.startUpper + delta;
        }
        if (lower > upper) [lower, upper] = [upper, lower];
        state.x1 = Math.max(domain.min, Math.min(domain.max, lower));
        state.x2 = Math.max(domain.min, Math.min(domain.max, upper));
        this._updateCalendarHeatmapSelectionShapes(panelId, plot);
        // Eager data can update after a short debounce while the selection is
        // moving. Lazy mode never enters this path in the first delivery.
        this._scheduleCalendarHeatmapRecompute(panelId);
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('heatmap-selection-dragging', 'heatmap-selection-moving');
        if (plot.div) setCursor(null);
        this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._calendarHeatmapSelectionDocListeners = { move: onMove, up: onUp };
};

proto._setCalendarHeatmapRangeMode = function(panelId, full) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const state = this._ensureCalendarHeatmapState(plot);
    if (state.rangeFull === full) return;
    state.rangeFull = full;
    if (!full) {
        const xaxis = plot.div?._fullLayout?.xaxis;
        const domain = this._calendarHeatmapDomain(plot);
        let lower = this._coerceAxisValue(xaxis?.range?.[0]);
        let upper = this._coerceAxisValue(xaxis?.range?.[1]);
        if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
            lower = domain?.min;
            upper = domain?.max;
        }
        if (domain) {
            lower = Math.max(domain.min, Math.min(domain.max, lower));
            upper = Math.max(domain.min, Math.min(domain.max, upper));
        }
        if (lower > upper) [lower, upper] = [upper, lower];
        state.x1 = lower;
        state.x2 = upper;
    }
    this._updateCalendarHeatmapSelectionShapes(panelId, plot);
    this._renderCalendarHeatmapOptionsPanel(panelId, plot);
    this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
};

proto._scheduleCalendarHeatmapRecompute = function(panelId, options = {}) {
    const plot = this.plots.get(panelId);
    if (!plot?.heatmapDiv || plot.mode !== 'heatmap') return;
    clearTimeout(plot._calendarHeatmapRecomputeTimer);
    const run = () => this._recomputeCalendarHeatmap(panelId, plot);
    if (options.immediate) run();
    else plot._calendarHeatmapRecomputeTimer = setTimeout(run, HEATMAP_RECOMPUTE_DEBOUNCE_MS);
};

proto._recomputeCalendarHeatmap = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.heatmapDiv || plot.mode !== 'heatmap') return;
    const token = (plot._calendarHeatmapToken || 0) + 1;
    plot._calendarHeatmapToken = token;
    const state = this._ensureCalendarHeatmapState(plot);
    const warnings = [];
    const eager = [];
    const allTraces = plot.traces || [];

    state.dirty = false;
    this._syncCalendarHeatmapDirtyUi(plot);
    this._setCalendarHeatmapStatus(plot, text('heatmapLoading'), 'loading');
    plot.heatmapContainer?.setAttribute('aria-busy', 'true');

    const lazyTraces = [];
    for (const trace of allTraces) {
        const name = this._traceName(trace.varName, trace.fileId);
        const eligibility = this._calendarHeatmapTraceEligibility(trace);
        if (!eligibility.ok) {
            warnings.push(`${name}: ${eligibility.reason}`);
            continue;
        }
        if (traceIsLazy(this, trace)) {
            lazyTraces.push(trace);
            continue;
        }
        eager.push(trace);
    }

    if (!eager.length && !lazyTraces.length) {
        plot._calendarHeatmapModels = [];
        state.warnings = warnings;
        Plotly.react(plot.heatmapDiv, [], this._buildCalendarHeatmapLayout(plot, []), this._getPlotlyConfig());
        this._setCalendarHeatmapStatus(
            plot,
            warnings.join(' | ') || text('heatmapNoTraces'),
            warnings.length ? 'blocked' : 'muted',
        );
        plot.heatmapContainer?.setAttribute('aria-busy', 'false');
        this._syncCalendarHeatmapSummary(plot);
        return;
    }

    const domain = this._calendarHeatmapDomain(plot);
    if (!domain) {
        plot._calendarHeatmapModels = [];
        state.warnings = [text('heatmapNoRows')];
        Plotly.react(plot.heatmapDiv, [], this._buildCalendarHeatmapLayout(plot, []), this._getPlotlyConfig());
        this._setCalendarHeatmapStatus(plot, text('heatmapNoRows'), 'warning');
        plot.heatmapContainer?.setAttribute('aria-busy', 'false');
        return;
    }

    const [rangeStart, rangeEnd] = this._activeCalendarHeatmapRange(plot);
    // Every eligible trace (eager or lazy) is retained so legend hide/show can
    // expose its subplot without recomputing. Count those retained dense grids
    // for the hard memory limit, including temporarily hidden ones.
    const retainedTraceCount = (eager.length + lazyTraces.length) || 1;
    const runtime = globalThis.electronAPI ? 'desktop' : 'web';
    const densifyOptions = {
        calendarMode: state.calendarMode,
        aggregation: state.aggregation,
        domainStart: state.rangeFull ? domain.min : rangeStart,
        domainEnd: state.rangeFull ? domain.max : rangeEnd,
        traceCount: retainedTraceCount,
        runtime,
    };
    const modelByTrace = new Map();
    const noteGridWarnings = (trace, grid) => {
        if (!Array.isArray(grid?.warnings)) return;
        for (const item of grid.warnings) {
            if ((item === 'dataGaps' || item === 'integralUnavailable') && state.aggregation !== 'integral') continue;
            const message = { dataGaps: text('heatmapDataGaps'), integralUnavailable: text('heatmapIntegralUnsorted') }[item] || item;
            warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${message}`);
        }
    };
    const noteGridFailure = (trace, grid) => {
        const reason = grid?.reason === 'cellLimit'
            ? `cell limit (${grid?.limit?.gridCells ?? grid?.meta?.gridCells ?? '?'})`
            : (grid?.reason || text('heatmapNoRows'));
        warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${reason}`);
    };

    for (const trace of eager) {
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const values = this._getTransformedVariableData(trace.fileId, trace.varName);
        if (!times?.length || !values?.length) {
            warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${text('heatmapNoRows')}`);
            continue;
        }
        if (times.length !== values.length) {
            warnings.push(`${this._traceName(trace.varName, trace.fileId)}: time/value length mismatch`);
        }
        try {
            const grid = buildCalendarHeatmap({
                times,
                values,
                calendarMode: state.calendarMode,
                aggregation: state.aggregation,
                rangeStart: state.rangeFull ? null : rangeStart,
                rangeEnd: state.rangeFull ? null : rangeEnd,
                // Transformed arrays already include crop and timeShift.
                timeShiftMs: 0,
                domainStart: densifyOptions.domainStart,
                domainEnd: densifyOptions.domainEnd,
                traceCount: retainedTraceCount,
                runtime,
            });
            if (!grid?.ok) { noteGridFailure(trace, grid); continue; }
            noteGridWarnings(trace, grid);
            modelByTrace.set(trace, { trace, grid });
        } catch (error) {
            warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${error?.message || String(error)}`);
        }
    }

    // Lazy traces are aggregated exactly in DuckDB (never the overview), then
    // densified through the same kernel path as eager. Group by file so each
    // file is scanned once for all of its requested vars.
    const lazyPromise = lazyTraces.length
        ? this._runLazyCalendarHeatmap(panelId, plot, token, lazyTraces, densifyOptions, {
            rangeFull: state.rangeFull, rangeStart, rangeEnd, warnings, noteGridWarnings, noteGridFailure, modelByTrace,
        })
        : Promise.resolve();

    lazyPromise.then(() => {
        if (plot._calendarHeatmapToken !== token || this.plots.get(panelId) !== plot || plot.mode !== 'heatmap') return;
        // Preserve original trace order across the eager/lazy split.
        const models = allTraces.map(trace => modelByTrace.get(trace)).filter(Boolean);
        if (models.filter(model => this._isVisible(model.trace)).length > HEATMAP_MANY_TRACES_WARNING) {
            warnings.push(text('heatmapManyTraces'));
        }
        if (state.sharedColorRange && state.aggregation !== 'count') {
            const units = new Set(models
                .filter(model => this._isVisible(model.trace))
                .map(model => this._varUnit(model.trace.varName, model.trace.fileId) || ''));
            if (units.size > 1) warnings.push(text('heatmapSharedUnitsWarning'));
        }
        plot._calendarHeatmapModels = models;
        state.warnings = warnings.slice(0, 20);
        if (!models.length) {
            Plotly.react(plot.heatmapDiv, [], this._buildCalendarHeatmapLayout(plot, []), this._getPlotlyConfig());
            this._setCalendarHeatmapStatus(plot, warnings.join(' | ') || text('heatmapNoRows'), warnings.length ? 'warning' : 'muted');
            plot.heatmapContainer?.setAttribute('aria-busy', 'false');
            this._syncCalendarHeatmapSummary(plot);
            return;
        }
        this._renderCalendarHeatmapModels(panelId, plot, { preserveView: false }).then((rendered) => {
            if (!rendered) return;
            if (plot._calendarHeatmapToken !== token || this.plots.get(panelId) !== plot || plot.mode !== 'heatmap') return;
            plot.heatmapContainer?.setAttribute('aria-busy', 'false');
            const cells = models.reduce((total, model) => total + gridCellCount(model.grid), 0);
            const ready = `${text('heatmapReady')} · ${models.length} × ${cells.toLocaleString()} cells`;
            this._setCalendarHeatmapStatus(plot, warnings.length ? `${ready} — ${warnings.join(' | ')}` : ready, warnings.length ? 'warning' : 'ready');
            this._syncCalendarHeatmapSummary(plot);
        });
    }).catch((error) => {
        if (plot._calendarHeatmapToken !== token || this.plots.get(panelId) !== plot || plot.mode !== 'heatmap') return;
        plot.heatmapContainer?.setAttribute('aria-busy', 'false');
        this._setCalendarHeatmapStatus(plot, error?.message || String(error), 'error');
    });
};

// Query DuckDB for the lazy traces (grouped per file, one scan each), densify
// each returned sparse trace through the shared kernel, and fill modelByTrace.
proto._runLazyCalendarHeatmap = async function(panelId, plot, token, lazyTraces, densifyOptions, ctx) {
    const byFile = new Map();
    for (const trace of lazyTraces) {
        if (!byFile.has(trace.fileId)) byFile.set(trace.fileId, []);
        byFile.get(trace.fileId).push(trace);
    }
    for (const [fileId, traces] of byFile) {
        if (plot._calendarHeatmapToken !== token) return;
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getCalendarHeatmapAggregates) {
            for (const trace of traces) ctx.warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${text('heatmapLazyUnsupported')}`);
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
        for (const trace of traces) {
            const sign = this.isVariableSignInverted?.(fileId, trace.varName) ? -1 : 1;
            transforms[trace.varName] = { gain: transform.gain * sign, yOffset: transform.yOffset };
        }
        try {
            const result = await source.getCalendarHeatmapAggregates(data, traces.map(t => t.varName), {
                calendarMode: densifyOptions.calendarMode,
                aggregation: densifyOptions.aggregation,
                timeShiftMs,
                cropRange,
                selectionRange: ctx.rangeFull ? null : [ctx.rangeStart, ctx.rangeEnd],
                transforms,
            });
            if (plot._calendarHeatmapToken !== token) return;
            if (!result?.ok) {
                for (const trace of traces) ctx.warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${text('heatmapLazyUnsupported')}`);
                continue;
            }
            for (const blockedName of result.blocked || []) {
                ctx.warnings.push(`${this._traceName(blockedName, fileId)}: ${text('heatmapLazyDerivedUnsupported')}`);
            }
            const entryByVar = new Map(result.traces.map(entry => [entry.varName, entry]));
            for (const trace of traces) {
                const entry = entryByVar.get(trace.varName);
                const cells = entry?.cells;
                if (!cells) continue;
                if (densifyOptions.aggregation === 'integral' && entry.integralAvailable === false) {
                    ctx.warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${text('heatmapIntegralUnsorted')}`);
                }
                const dense = densifyCalendarHeatmap(
                    {
                        accumulators: cells,
                        calendarMode: densifyOptions.calendarMode,
                        rangeActive: !ctx.rangeFull,
                        rangeStartMs: ctx.rangeFull ? null : ctx.rangeStart,
                        rangeEndMs: ctx.rangeFull ? null : ctx.rangeEnd,
                        domainStartMs: densifyOptions.domainStart,
                        domainEndMs: densifyOptions.domainEnd,
                    },
                    densifyOptions,
                );
                if (!dense?.ok) { ctx.noteGridFailure(trace, dense); continue; }
                if (!dense.stats) dense.stats = this._calendarHeatmapStatsFromCells(cells);
                ctx.noteGridWarnings(trace, dense);
                ctx.modelByTrace.set(trace, { trace, grid: dense });
            }
        } catch (error) {
            for (const trace of traces) ctx.warnings.push(`${this._traceName(trace.varName, trace.fileId)}: ${error?.message || String(error)}`);
        }
    }
};

// Total-sample counts for the drawer summary, matching the eager stats shape.
proto._calendarHeatmapStatsFromCells = function(cells) {
    let nScope = 0;
    let nFinite = 0;
    for (const cell of cells || []) {
        nScope += Number(cell.nScope) || 0;
        nFinite += Number(cell.nFinite) || 0;
    }
    return { nScope, nFinite, nInvalid: Math.max(0, nScope - nFinite) };
};

proto._calendarHeatmapGridHoverText = function(grid, trace, z, aggregation) {
    const customdata = grid?.customdata || [];
    const x = grid?.x || [];
    const y = grid?.y || [];
    const name = escapeHtml(this._traceName(trace.varName, trace.fileId));
    const unit = escapeHtml(unitForAggregation(this._varUnit(trace.varName, trace.fileId), aggregation));
    const aggregationLabel = escapeHtml(text(aggregationLabelKey[aggregation] || aggregation));
    return z.map((row, rowIndex) => row.map((value, columnIndex) => {
        const cell = customdata?.[rowIndex]?.[columnIndex];
        const fallbackStart = grid?.meta?.calendarMode === 'day-hour'
            ? Number(x[columnIndex]) + Number(y[rowIndex]) * 3600000
            : Number(x[columnIndex]) + (Number(y[rowIndex]) - 1) * 86400000;
        const start = Number(cellValue(cell, 'cellStartMs', fallbackStart));
        const duration = grid?.meta?.calendarMode === 'day-hour' ? 3600000 : 86400000;
        const end = Number(cellValue(cell, 'cellEndMs', start + duration));
        const nScope = Number(cellValue(cell, 'nScope', 0));
        const nFinite = Number(cellValue(cell, 'nFinite', 0));
        const nInvalid = Number(cellValue(cell, 'nInvalid', Math.max(0, nScope - nFinite)));
        const partial = !!cellValue(cell, 'partial', false);
        const displayValue = Number.isFinite(value)
            ? Number(value).toPrecision(6)
                .replace(/(\.\d*?[1-9])0+(e|$)/, '$1$2')
                .replace(/\.0+(e|$)/, '$1')
            : '—';
        const title = unit ? `<b>${name}</b> [${unit}]` : `<b>${name}</b>`;
        const calendarLabel = grid?.meta?.calendarMode === 'day-hour'
            ? `${utcDateLabel(x[columnIndex])} · ${String(y[rowIndex]).padStart(2, '0')}:00 UTC`
            : `${isoWeekLabel(x[columnIndex])} · ${escapeHtml(localizedWeekdays()[Math.max(0, Number(y[rowIndex]) - 1)] || '')} · ${utcDateLabel(start)} (week starts ${utcDateLabel(x[columnIndex])})`;
        return [
            title,
            calendarLabel,
            `${text('heatmapInterval')}: ${escapeHtml(utcIso(start))} → ${escapeHtml(utcIso(end))}`,
            `${aggregationLabel}: ${displayValue}`,
            `${text('heatmapSamples')}: ${nScope} · ${text('heatmapFinite')}: ${nFinite} · ${text('heatmapInvalid')}: ${nInvalid}`,
            partial ? text('heatmapPartial') : '',
        ].filter(Boolean).join('<br>');
    }));
};

proto._calendarHeatmapColorBounds = function(state, zMatrices) {
    if (state.colorRangeMode === 'manual'
        && Number.isFinite(state.colorMin)
        && Number.isFinite(state.colorMax)
        && state.colorMin < state.colorMax) {
        return [state.colorMin, state.colorMax];
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const matrix of zMatrices) {
        for (const row of matrix || []) {
            for (const value of row || []) {
                if (!Number.isFinite(value)) continue;
                minimum = Math.min(minimum, value);
                maximum = Math.max(maximum, value);
            }
        }
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [null, null];
    // Plotly rejects a degenerate zmin === zmax and silently keeps whatever
    // range the trace had before, so a constant map (Finite count with regular
    // sampling, a constant signal) would otherwise freeze the previous scale.
    if (minimum === maximum) return [minimum - 0.5, maximum + 0.5];
    return [minimum, maximum];
};

// Gap cells hold no integral, so the main trace leaves them empty and this
// overlay paints them in the palette's gap color. It is drawn after the trace it
// belongs to, and only under the integral, where a hole in the data actually
// invalidates the value.
proto._buildCalendarHeatmapGapTrace = function(plot, model, axisSuffix) {
    const state = this._ensureCalendarHeatmapState(plot);
    if (state.aggregation !== 'integral') return null;
    const grid = model.grid;
    const customdata = grid?.customdata;
    if (!Array.isArray(customdata)) return null;

    let gapCount = 0;
    const z = customdata.map(row => (Array.isArray(row) ? row.map((cell) => {
        if (!cell?.hasGap) return null;
        gapCount++;
        return 1;
    }) : []));
    if (!gapCount) return null;

    const name = escapeHtml(this._traceName(model.trace.varName, model.trace.fileId));
    const hoverText = customdata.map(row => (Array.isArray(row) ? row.map((cell) => {
        if (!cell?.hasGap) return '';
        const missing = formatDurationMs(cell.missingMs);
        return [
            `<b>${name}</b>`,
            `${text('heatmapInterval')}: ${escapeHtml(utcIso(cell.cellStartMs))} → ${escapeHtml(utcIso(cell.cellEndMs))}`,
            text('heatmapGapCell'),
            missing ? `${text('heatmapGapMissing')}: ${missing}` : '',
        ].filter(Boolean).join('<br>');
    }) : []));

    const color = HEATMAP_GAP_COLORS[state.colorScale] || HEATMAP_GAP_COLORS.Viridis;
    return {
        type: 'heatmap',
        x: (grid.x || []).map(utcIso),
        y: grid.y || [],
        z,
        text: hoverText,
        hovertemplate: '%{text}<extra></extra>',
        hoverongaps: false,
        colorscale: [[0, color], [1, color]],
        zmin: 0,
        zmax: 1,
        showscale: false,
        zsmooth: false,
        name: text('heatmapGapLegend'),
        xaxis: 'x',
        yaxis: `y${axisSuffix}`,
    };
};

proto._buildCalendarHeatmapPlot = function(plot, models) {
    const state = this._ensureCalendarHeatmapState(plot);
    const visibleModels = (models || []).filter(model => this._isVisible(model.trace));
    const matrices = visibleModels.map(model => zForAggregation(model.grid, state.aggregation));
    const sharedBounds = this._calendarHeatmapColorBounds(state, matrices);
    const sharedColor = state.sharedColorRange;
    const traces = [];

    visibleModels.forEach((model, index) => {
        const grid = model.grid;
        const z = matrices[index];
        const axisSuffix = index === 0 ? '' : String(index + 1);
        const ownBounds = sharedColor ? sharedBounds : this._calendarHeatmapColorBounds(state, [z]);
        const heatmapTrace = {
            type: 'heatmap',
            x: (grid.x || []).map(utcIso),
            y: grid.y || [],
            z,
            customdata: grid.customdata,
            text: this._calendarHeatmapGridHoverText(grid, model.trace, z, state.aggregation),
            hovertemplate: '%{text}<extra></extra>',
            hoverongaps: false,
            connectgaps: false,
            zsmooth: false,
            name: this._traceName(model.trace.varName, model.trace.fileId),
            xaxis: 'x',
            yaxis: `y${axisSuffix}`,
            showscale: true,
        };
        if (sharedColor) {
            heatmapTrace.coloraxis = 'coloraxis';
            heatmapTrace.showscale = index === 0;
        } else {
            heatmapTrace.colorscale = state.colorScale;
            heatmapTrace.reversescale = state.reverseColorScale;
            if (ownBounds[0] != null) heatmapTrace.zmin = ownBounds[0];
            if (ownBounds[1] != null) heatmapTrace.zmax = ownBounds[1];
            heatmapTrace.colorbar = {
                x: 1.01,
                y: 1 - (index + 0.5) / Math.max(1, visibleModels.length),
                len: Math.max(0.12, 0.82 / Math.max(1, visibleModels.length)),
                thickness: 10,
                title: {
                    text: unitForAggregation(this._varUnit(model.trace.varName, model.trace.fileId), state.aggregation),
                    side: 'right',
                },
            };
        }
        traces.push(heatmapTrace);
        const gapTrace = this._buildCalendarHeatmapGapTrace(plot, model, axisSuffix);
        if (gapTrace) traces.push(gapTrace);
    });
    return { traces, layout: this._buildCalendarHeatmapLayout(plot, visibleModels, matrices, sharedBounds) };
};

proto._buildCalendarHeatmapLayout = function(plot, models = [], matrices = [], sharedBounds = [null, null]) {
    const { bg, gridColor, fontColor } = this._colors();
    const state = this._ensureCalendarHeatmapState(plot);
    const count = models.length;
    const layout = {
        paper_bgcolor: bg,
        plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        margin: { l: 94, r: state.sharedColorRange ? 76 : 96, t: 20, b: 64 },
        autosize: true,
        hovermode: 'closest',
        showlegend: false,
        uirevision: `calendar-heatmap-${state.calendarMode}`,
        annotations: [],
    };
    if (!count) {
        layout.xaxis = { visible: false };
        layout.yaxis = { visible: false };
        layout.annotations.push({
            xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
            text: text('heatmapNoTraces'), showarrow: false,
            font: { color: fontColor, size: 12 },
        });
        return layout;
    }

    const firstGrid = models[0].grid;
    const xValues = (firstGrid.x || []).map(utcIso);
    const stride = Math.max(1, Math.ceil(xValues.length / 12));
    const tickValues = [];
    const tickText = [];
    for (let index = 0; index < xValues.length; index += stride) {
        tickValues.push(xValues[index]);
        tickText.push(state.calendarMode === 'week-day'
            ? isoWeekLabel(firstGrid.x[index])
            : utcDateLabel(firstGrid.x[index]));
    }
    layout.xaxis = {
        type: 'date',
        domain: [0, 1],
        anchor: count === 1 ? 'y' : `y${count}`,
        tickmode: 'array',
        tickvals: tickValues,
        ticktext: tickText,
        tickangle: xValues.length > 8 ? -35 : 0,
        gridcolor: gridColor,
        linecolor: gridColor,
        tickcolor: gridColor,
        zeroline: false,
        title: { text: state.calendarMode === 'week-day' ? text('heatmapWeekDay') : text('heatmapDayHour'), font: { size: 10 } },
    };

    const weekdays = localizedWeekdays();
    const hourLabels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
    // The title of each small multiple sits in the gap above its own plot, so the
    // gap has to clear both the label and some air below the previous heatmap.
    // Expressed in pixels: a paper fraction would shrink the gap in the shorter
    // week x day figure and widen it in the taller day x hour one.
    const figureHeight = plot?.heatmapDiv?.clientHeight || 420;
    const gap = Math.min(0.12 / Math.max(1, count), Math.max(0.008, HEATMAP_SUBPLOT_GAP_PX / figureHeight));
    models.forEach((model, index) => {
        const number = index + 1;
        const suffix = number === 1 ? '' : String(number);
        const top = 1 - index / count - gap;
        const bottom = 1 - (index + 1) / count + gap;
        // An explicit reversed range, not autorange: uirevision keeps whatever
        // range an axis first resolved to, and the panel is created before any
        // trace exists, so 'reversed' would never reach the first subplot and it
        // would show Sunday (or 23:00) on top.
        const rows = model.grid.y || [];
        const firstRow = rows.length ? Math.min(...rows) : 0;
        const lastRow = rows.length ? Math.max(...rows) : 1;
        layout[`yaxis${suffix}`] = {
            domain: [bottom, top],
            anchor: 'x',
            range: [lastRow + 0.5, firstRow - 0.5],
            tickmode: 'array',
            tickvals: rows,
            ticktext: state.calendarMode === 'week-day' ? weekdays : hourLabels,
            gridcolor: gridColor,
            linecolor: gridColor,
            tickcolor: gridColor,
            zeroline: false,
            fixedrange: true,
        };
        layout.annotations.push({
            xref: 'paper', yref: 'paper', x: 0, y: top,
            xanchor: 'left', yanchor: 'bottom', yshift: 3,
            text: escapeHtml(this._traceName(model.trace.varName, model.trace.fileId)),
            showarrow: false,
            font: { color: model.trace.color || fontColor, size: 11 },
        });
    });
    if (state.sharedColorRange) {
        layout.coloraxis = {
            colorscale: state.colorScale,
            reversescale: state.reverseColorScale,
            colorbar: { x: 1.01, thickness: 12 },
        };
        if (sharedBounds[0] != null) layout.coloraxis.cmin = sharedBounds[0];
        if (sharedBounds[1] != null) layout.coloraxis.cmax = sharedBounds[1];
    }
    void matrices;
    return layout;
};

// Scrolling is a last resort: the small multiples only get a per-plot floor
// (and therefore a scrollbar) when the pane is too short to show them at a
// legible height. Whenever they fit — a single signal, or two with the
// time-series hidden — the div follows the pane and no scrollbar appears.
proto._applyCalendarHeatmapMinHeight = function(plot) {
    if (!plot?.heatmapDiv) return;
    const visibleCount = (plot._calendarHeatmapModels || []).filter(model => this._isVisible(model.trace)).length;
    if (visibleCount <= 1) {
        plot.heatmapDiv.style.minHeight = '';
        return;
    }
    const dayHour = this._ensureCalendarHeatmapState(plot).calendarMode === 'day-hour';
    const preferred = dayHour ? HEATMAP_PREFERRED_PLOT_HEIGHT_DAY_HOUR : HEATMAP_PREFERRED_PLOT_HEIGHT_WEEK_DAY;
    const legible = dayHour ? HEATMAP_MIN_PLOT_HEIGHT_DAY_HOUR : HEATMAP_MIN_PLOT_HEIGHT_WEEK_DAY;
    const paneHeight = plot.heatmapDiv.parentElement?.clientHeight || 0;
    const fits = paneHeight > 0 && paneHeight / visibleCount >= legible;
    plot.heatmapDiv.style.minHeight = fits ? '' : `${visibleCount * preferred}px`;
};

proto._renderCalendarHeatmapModels = function(panelId, plot = this.plots.get(panelId), options = {}) {
    if (!plot?.heatmapDiv || plot.mode !== 'heatmap') return Promise.resolve();
    const previousRange = options.preserveView ? plot.heatmapDiv._fullLayout?.xaxis?.range : null;
    // Sized before building: the layout turns the subplot gaps into paper
    // fractions, which needs the height the div is about to have.
    this._applyCalendarHeatmapMinHeight(plot);
    const built = this._buildCalendarHeatmapPlot(plot, plot._calendarHeatmapModels || []);
    if (Array.isArray(previousRange)) {
        built.layout.xaxis = { ...(built.layout.xaxis || {}), range: previousRange, autorange: false };
    }
    // Moving a trace between the shared coloraxis and its own color scale leaves
    // the cells painted with the previous scale: Plotly.react applies the new
    // zmin/zmax (and even Plotly.redraw keeps the stale bitmap), so that switch
    // needs a full re-plot.
    const shared = this._ensureCalendarHeatmapState(plot).sharedColorRange;
    const colorModeChanged = plot._calendarHeatmapSharedApplied !== undefined
        && plot._calendarHeatmapSharedApplied !== shared;
    plot._calendarHeatmapSharedApplied = shared;
    const config = this._getPlotlyConfig();
    const drawn = colorModeChanged
        ? Plotly.newPlot(plot.heatmapDiv, built.traces, built.layout, config)
            .then(() => this._installCalendarHeatmapAnalysisHandlers(plot))
        : Plotly.react(plot.heatmapDiv, built.traces, built.layout, config);
    return drawn
        .then(() => {
            this._syncCalendarHeatmapSummary(plot);
            return true;
        })
        .catch((error) => {
            if (this.plots.get(panelId) === plot && plot.mode === 'heatmap') {
                this._setCalendarHeatmapStatus(plot, error?.message || String(error), 'error');
            }
            return false;
        });
};

proto._setCalendarHeatmapStatus = function(plot, message, kind = 'muted') {
    const status = plot?.heatmapContainer?.querySelector('.heatmap-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = `heatmap-status heatmap-status-${kind}`;
};

proto._setCalendarHeatmapLayout = function(panelId, layout) {
    const plot = this.plots.get(panelId);
    if (!plot?.heatmapContainer || !HEATMAP_LAYOUTS.has(layout)) return;
    const state = this._ensureCalendarHeatmapState(plot);
    state.layout = layout;
    plot.heatmapContainer.classList.toggle('heatmap-layout-horizontal', layout === 'horizontal');
    plot.heatmapContainer.classList.toggle('heatmap-layout-vertical', layout === 'vertical');
    const splitter = plot.heatmapContainer.querySelector('.heatmap-splitter');
    splitter?.setAttribute('aria-orientation', layout === 'vertical' ? 'horizontal' : 'vertical');
    this._applyCalendarHeatmapMinHeight(plot);
    if (plot.div) Plotly.Plots.resize(plot.div);
    if (plot.heatmapDiv) Plotly.Plots.resize(plot.heatmapDiv);
};

proto._toggleCalendarHeatmapTimeSeries = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.heatmapContainer) return;
    const state = this._ensureCalendarHeatmapState(plot);
    state.timeSeriesHidden = !state.timeSeriesHidden;
    plot.heatmapContainer.classList.toggle('heatmap-time-series-hidden', state.timeSeriesHidden);
    const button = plot.heatmapContainer.querySelector('.heatmap-time-series-btn');
    if (button) {
        button.classList.toggle('active', state.timeSeriesHidden);
        button.setAttribute('aria-pressed', String(state.timeSeriesHidden));
    }
    if (!state.timeSeriesHidden && plot.div) {
        Plotly.Plots.resize(plot.div);
        this._refreshPanelDomOverlays?.(plot);
    }
    this._applyCalendarHeatmapMinHeight(plot);
    if (plot.heatmapDiv) Plotly.Plots.resize(plot.heatmapDiv);
    this._syncCursorDisplay?.(panelId, plot);
};

proto._toggleCalendarHeatmapOptions = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.heatmapContainer) return;
    const state = this._ensureCalendarHeatmapState(plot);
    state.optionsVisible = !state.optionsVisible;
    const options = plot.heatmapContainer.querySelector('.heatmap-options');
    if (options) options.hidden = !state.optionsVisible;
    const button = plot.heatmapContainer.querySelector('.heatmap-options-btn');
    if (button) {
        button.classList.toggle('active', state.optionsVisible);
        button.setAttribute('aria-pressed', String(state.optionsVisible));
        button.textContent = state.optionsVisible ? text('heatmapHideOptions') : text('heatmapShowOptions');
        button.title = button.textContent;
    }
    if (plot.div) Plotly.Plots.resize(plot.div);
    if (plot.heatmapDiv) Plotly.Plots.resize(plot.heatmapDiv);
};

proto._resetCalendarHeatmapView = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;
    const state = this._ensureCalendarHeatmapState(plot);
    state.rangeFull = true;
    state.x1 = null;
    state.x2 = null;
    state.colorRangeMode = 'auto';
    state.colorMin = null;
    state.colorMax = null;
    this._updateCalendarHeatmapSelectionShapes(panelId, plot);
    this._renderCalendarHeatmapOptionsPanel(panelId, plot);
    this._autoScalePlotTimeOnly(plot);
    if (plot.heatmapDiv) Plotly.relayout(plot.heatmapDiv, { 'xaxis.autorange': true });
    this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
};

proto._autoScaleCalendarHeatmapPanel = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div) return Promise.resolve();
    const timePromise = this._autoScalePlotTimeOnly(plot);
    const heatmapPromise = plot.heatmapDiv
        ? Plotly.relayout(plot.heatmapDiv, { 'xaxis.autorange': true })
        : Promise.resolve();
    return Promise.all([timePromise, heatmapPromise]);
};

proto._installCalendarHeatmapSplitterHandlers = function(panelId, plot) {
    const splitter = plot?.heatmapContainer?.querySelector('.heatmap-splitter');
    if (!splitter || splitter._heatmapBound) return;
    splitter._heatmapBound = true;
    let dragging = false;
    const applyFraction = (fraction) => {
        if (!plot.heatmapContainer) return;
        const state = this._ensureCalendarHeatmapState(plot);
        state.split = Math.max(0.2, Math.min(0.8, fraction));
        plot.heatmapContainer.style.setProperty('--heatmap-split', `${Math.round(state.split * 1000) / 10}%`);
        splitter.setAttribute('aria-valuemin', '20');
        splitter.setAttribute('aria-valuemax', '80');
        splitter.setAttribute('aria-valuenow', String(Math.round(state.split * 100)));
        this._applyCalendarHeatmapMinHeight(plot);
        if (plot.div) Plotly.Plots.resize(plot.div);
        if (plot.heatmapDiv) Plotly.Plots.resize(plot.heatmapDiv);
    };
    const applyPointer = (event) => {
        const state = this._ensureCalendarHeatmapState(plot);
        const area = plot.heatmapContainer?.querySelector('.heatmap-plot-area');
        const rect = area?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const fraction = state.layout === 'vertical'
            ? (event.clientY - rect.top) / rect.height
            : (event.clientX - rect.left) / rect.width;
        applyFraction(fraction);
    };
    splitter.addEventListener('mousedown', (event) => {
        dragging = true;
        event.preventDefault();
        document.body.classList.add('heatmap-split-dragging');
    });
    splitter.addEventListener('keydown', (event) => {
        const state = this._ensureCalendarHeatmapState(plot);
        const lowerKey = state.layout === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
        const upperKey = state.layout === 'vertical' ? 'ArrowDown' : 'ArrowRight';
        let next = state.split;
        if (event.key === lowerKey) next -= 0.02;
        else if (event.key === upperKey) next += 0.02;
        else if (event.key === 'Home') next = 0.2;
        else if (event.key === 'End') next = 0.8;
        else return;
        event.preventDefault();
        applyFraction(next);
    });
    const onMove = event => { if (dragging) applyPointer(event); };
    const onUp = () => {
        dragging = false;
        document.body.classList.remove('heatmap-split-dragging');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    plot._calendarHeatmapSplitterDocListeners = { move: onMove, up: onUp };
    applyFraction(this._ensureCalendarHeatmapState(plot).split);
    void panelId;
};

proto._markCalendarHeatmapDirty = function(panelId, message = text('heatmapDirty')) {
    const plot = this.plots.get(panelId);
    if (!plot || plot.mode !== 'heatmap') return;
    this._ensureCalendarHeatmapState(plot).dirty = true;
    this._syncCalendarHeatmapDirtyUi(plot);
    this._setCalendarHeatmapStatus(plot, message, 'dirty');
};

proto._syncCalendarHeatmapDirtyUi = function(plot) {
    const state = this._ensureCalendarHeatmapState(plot);
    const button = plot?.heatmapContainer?.querySelector('.heatmap-refresh-btn');
    if (button) {
        button.hidden = !state.dirty;
        button.disabled = !state.dirty;
    }
};

proto._refreshDirtyCalendarHeatmap = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    this._ensureCalendarHeatmapState(plot).dirty = false;
    this._syncCalendarHeatmapDirtyUi(plot);
    this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
};

proto._renderCalendarHeatmapOptionsPanel = function(panelId, plot) {
    const state = this._ensureCalendarHeatmapState(plot);
    const options = plot?.heatmapContainer?.querySelector('.heatmap-options');
    if (!options) return;
    options.innerHTML = '';

    const section = (label, tooltip = '') => {
        const heading = document.createElement('div');
        heading.className = 'heatmap-options-subtitle';
        heading.textContent = label;
        if (tooltip) heading.title = tooltip;
        options.appendChild(heading);
    };
    const row = (labelText, control, tooltip = '') => {
        const label = document.createElement('label');
        label.className = 'heatmap-option-row';
        if (tooltip) label.title = tooltip;
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, control);
        options.appendChild(label);
        return label;
    };
    const segmented = (items, current, onPick) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'heatmap-segmented';
        const buttons = [];
        for (const item of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'heatmap-segmented-btn';
            button.textContent = item.label;
            if (item.title) button.title = item.title;
            const active = item.value === current;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
            button.addEventListener('click', () => {
                buttons.forEach(candidate => {
                    const selected = candidate === button;
                    candidate.classList.toggle('active', selected);
                    candidate.setAttribute('aria-pressed', String(selected));
                });
                onPick(item.value);
            });
            buttons.push(button);
            wrapper.appendChild(button);
        }
        return wrapper;
    };
    const numberInput = (value, onChange) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.className = 'heatmap-number-input';
        input.value = value == null ? '' : String(value);
        input.addEventListener('change', () => onChange(input.value));
        return input;
    };
    const checkbox = (checked, onChange, { disabled = false } = {}) => {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!checked;
        input.disabled = disabled;
        input.addEventListener('change', () => onChange(input.checked));
        return input;
    };
    const select = (items, current, onChange) => {
        const element = document.createElement('select');
        element.className = 'heatmap-select';
        for (const item of items) {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            if (item.title) option.title = item.title;
            option.selected = item.value === current;
            element.appendChild(option);
        }
        element.addEventListener('change', () => onChange(element.value));
        return element;
    };

    section(text('heatmapTemporalScope'), text('heatmapTemporalScopeTooltip'));
    options.appendChild(segmented([
        { value: true, label: text('heatmapScopeAll'), title: text('heatmapScopeAllTooltip') },
        { value: false, label: text('heatmapScopeSelection'), title: text('heatmapScopeSelectionTooltip') },
    ], state.rangeFull, full => this._setCalendarHeatmapRangeMode(panelId, full)));

    const domain = this._calendarHeatmapDomain(plot);
    const makeBound = (key, labelText, index, tooltip = '') => {
        const wrapper = document.createElement('div');
        wrapper.className = 'heatmap-range-bound';
        if (tooltip) wrapper.title = tooltip;
        const input = document.createElement('input');
        input.type = 'datetime-local';
        input.step = '1';
        input.className = 'heatmap-datetime-input';
        input.dataset.heatmapKey = key;
        input.dataset.heatmapRole = 'input';
        input.disabled = state.rangeFull;
        input.value = utcInputValue(this._activeCalendarHeatmapRange(plot)[index]);
        input.addEventListener('change', () => {
            const value = utcInputMs(input.value);
            state[key] = Number.isFinite(value) ? value : null;
            this._updateCalendarHeatmapSelectionShapes(panelId, plot);
            this._scheduleCalendarHeatmapRecompute(panelId);
        });
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'heatmap-range-input';
        slider.dataset.heatmapKey = key;
        slider.dataset.heatmapRole = 'slider';
        slider.disabled = state.rangeFull;
        if (domain) {
            slider.min = String(domain.min);
            slider.max = String(domain.max);
            slider.step = 'any';
            slider.value = String(this._activeCalendarHeatmapRange(plot)[index]);
        }
        slider.addEventListener('input', () => {
            const value = Number(slider.value);
            state[key] = Number.isFinite(value) ? value : null;
            this._updateCalendarHeatmapSelectionShapes(panelId, plot);
        });
        slider.addEventListener('change', () => this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true }));
        const label = document.createElement('label');
        label.className = 'heatmap-option-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, input);
        wrapper.append(label, slider);
        options.appendChild(wrapper);
    };
    makeBound('x1', text('heatmapSelectionStart'), 0, text('heatmapSelectionStartTooltip'));
    makeBound('x2', text('heatmapSelectionEnd'), 1, text('heatmapSelectionEndTooltip'));

    section(text('heatmapGeometry'), text('heatmapGeometryTooltip'));
    options.appendChild(segmented([
        { value: 'week-day', label: text('heatmapWeekDay'), title: text('heatmapWeekDayTooltip') },
        { value: 'day-hour', label: text('heatmapDayHour'), title: text('heatmapDayHourTooltip') },
    ], state.calendarMode, (mode) => {
        if (!HEATMAP_CALENDAR_MODES.has(mode)) return;
        state.calendarMode = mode;
        this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
    }));

    section(text('heatmapAggregation'), text('heatmapAggregationTooltip'));
    const aggregationHint = document.createElement('p');
    aggregationHint.className = 'heatmap-help heatmap-aggregation-hint';
    aggregationHint.textContent = text(aggregationTooltipKey[state.aggregation]);
    row(text('heatmapAggregation'), select([
        { value: 'mean', label: text('heatmapMean'), title: text('heatmapMeanTooltip') },
        { value: 'min', label: text('heatmapMin'), title: text('heatmapMinTooltip') },
        { value: 'max', label: text('heatmapMax'), title: text('heatmapMaxTooltip') },
        { value: 'sum', label: text('heatmapSum'), title: text('heatmapSumTooltip') },
        { value: 'count', label: text('heatmapCount'), title: text('heatmapCountTooltip') },
        { value: 'integral', label: text('heatmapIntegral'), title: text('heatmapIntegralTooltip') },
    ], state.aggregation, (aggregation) => {
        if (!HEATMAP_AGGREGATIONS.has(aggregation)) return;
        const previous = state.aggregation;
        state.aggregation = aggregation;
        aggregationHint.textContent = text(aggregationTooltipKey[aggregation]);
        // The bottom help is not re-rendered on a restyle, so refresh it here.
        const samplingHelp = options.querySelector('.heatmap-sampling-help');
        if (samplingHelp) samplingHelp.textContent = text(aggregation === 'integral' ? 'heatmapIntegralHelp' : 'heatmapSamplingHelp');
        // Eager keeps every accumulator, so any switch is a restyle. Lazy caches
        // one aggregate shape: switching to or from the Integral (a different SQL
        // pipeline and cell shape) needs a re-query; among the sample-weighted
        // aggregations the cached cells already carry sum/mean/min/max/count.
        const hasLazy = (plot.traces || []).some(trace => traceIsLazy(this, trace));
        if (hasLazy && (aggregation === 'integral' || previous === 'integral')) {
            this._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
        } else {
            // z is derived from the retained per-cell accumulators/customdata; no
            // transformed source array is read again here.
            this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
            this._syncCalendarHeatmapSummary(plot);
        }
    }), text('heatmapAggregationTooltip'));
    options.appendChild(aggregationHint);
    const zone = document.createElement('input');
    zone.type = 'text';
    zone.className = 'heatmap-text-input';
    zone.value = 'UTC';
    zone.disabled = true;
    row(text('heatmapTimeZone'), zone, text('heatmapTimeZoneTooltip'));

    section(text('heatmapColor'));
    row(text('heatmapPalette'), select([
        { value: 'Viridis', label: 'Viridis' },
        { value: 'Cividis', label: 'Cividis' },
        { value: 'RdBu', label: 'RdBu' },
    ], state.colorScale, (colorScale) => {
        if (!HEATMAP_COLOR_SCALES.has(colorScale)) return;
        state.colorScale = colorScale;
        this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
    }), text('heatmapPaletteTooltip'));
    row(text('heatmapReversePalette'), checkbox(state.reverseColorScale, (checked) => {
        state.reverseColorScale = checked;
        this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
    }), text('heatmapReversePaletteTooltip'));
    // A shared color range only means something when there is a second Heatmap
    // to compare against, so the control is inert with a single visible signal.
    const sharedRangeAvailable = (plot?.traces || []).filter(trace => this._isVisible(trace)).length > 1;
    if (!sharedRangeAvailable && state.sharedColorRange) state.sharedColorRange = false;
    const sharedRangeRow = row(text('heatmapSharedRange'), checkbox(state.sharedColorRange, (checked) => {
        state.sharedColorRange = checked;
        if (checked && state.aggregation !== 'count') {
            const units = new Set((plot._calendarHeatmapModels || [])
                .filter(model => this._isVisible(model.trace))
                .map(model => this._varUnit(model.trace.varName, model.trace.fileId) || ''));
            if (units.size > 1) this._setCalendarHeatmapStatus(plot, text('heatmapSharedUnitsWarning'), 'warning');
        }
        this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
    }, { disabled: !sharedRangeAvailable }), sharedRangeAvailable
        ? text('heatmapSharedRangeTooltip')
        : text('heatmapSharedRangeDisabled'));
    sharedRangeRow.classList.toggle('heatmap-option-row-disabled', !sharedRangeAvailable);

    section(text('heatmapColorRange'), text('heatmapColorRangeTooltip'));
    options.appendChild(segmented([
        { value: 'auto', label: text('heatmapRangeAuto'), title: text('heatmapRangeAutoTooltip') },
        { value: 'manual', label: text('heatmapRangeManual'), title: text('heatmapRangeManualTooltip') },
    ], state.colorRangeMode, (mode) => {
        state.colorRangeMode = mode;
        if (mode === 'manual' && !(Number.isFinite(state.colorMin) && Number.isFinite(state.colorMax) && state.colorMin < state.colorMax)) {
            const matrices = (plot._calendarHeatmapModels || []).map(model => zForAggregation(model.grid, state.aggregation));
            const bounds = this._calendarHeatmapColorBounds({ ...state, colorRangeMode: 'auto' }, matrices);
            state.colorMin = bounds[0];
            state.colorMax = bounds[1];
        }
        this._renderCalendarHeatmapOptionsPanel(panelId, plot);
        this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
    }));
    if (state.colorRangeMode === 'manual') {
        const updateManual = () => {
            if (Number.isFinite(state.colorMin) && Number.isFinite(state.colorMax) && state.colorMin < state.colorMax) {
                this._renderCalendarHeatmapModels(panelId, plot, { preserveView: true });
            } else {
                this._setCalendarHeatmapStatus(plot, text('heatmapManualRangeInvalid'), 'warning');
            }
        };
        row(text('heatmapColorMin'), numberInput(state.colorMin, (value) => { state.colorMin = finiteOrNull(value); updateManual(); }), text('heatmapColorMinTooltip'));
        row(text('heatmapColorMax'), numberInput(state.colorMax, (value) => { state.colorMax = finiteOrNull(value); updateManual(); }), text('heatmapColorMaxTooltip'));
    }

    const help = document.createElement('p');
    help.className = 'heatmap-help heatmap-sampling-help';
    // The Integral weighs by time, not by sample count, so the sample-weight
    // note would contradict it; show the integral-specific help instead.
    help.textContent = text(state.aggregation === 'integral' ? 'heatmapIntegralHelp' : 'heatmapSamplingHelp');
    options.appendChild(help);
    const summary = document.createElement('div');
    summary.className = 'heatmap-summary';
    summary.setAttribute('aria-live', 'polite');
    options.appendChild(summary);
    this._syncCalendarHeatmapSummary(plot);
};

proto._syncCalendarHeatmapOptionsPanel = function(plot) {
    const options = plot?.heatmapContainer?.querySelector('.heatmap-options');
    if (!options) return;
    const [lower, upper] = this._activeCalendarHeatmapRange(plot);
    const values = { x1: lower, x2: upper };
    for (const key of ['x1', 'x2']) {
        const input = options.querySelector(`input[data-heatmap-role="input"][data-heatmap-key="${key}"]`);
        const slider = options.querySelector(`input[data-heatmap-role="slider"][data-heatmap-key="${key}"]`);
        if (input && document.activeElement !== input) input.value = utcInputValue(values[key]);
        if (slider && document.activeElement !== slider && Number.isFinite(values[key])) slider.value = String(values[key]);
    }
};

proto._syncCalendarHeatmapSummary = function(plot) {
    const summary = plot?.heatmapContainer?.querySelector('.heatmap-summary');
    if (!summary) return;
    const models = plot._calendarHeatmapModels || [];
    if (!models.length) {
        summary.textContent = '';
        return;
    }
    summary.textContent = models.map(({ trace, grid }) => {
        const stats = grid.stats || {};
        const nScope = stats.nScope ?? grid.accumulators?.reduce((total, cell) => total + (cell.nScope || 0), 0) ?? 0;
        const nFinite = stats.nFinite ?? grid.accumulators?.reduce((total, cell) => total + (cell.nFinite || 0), 0) ?? 0;
        const nInvalid = stats.nInvalid ?? Math.max(0, nScope - nFinite);
        return `${this._traceName(trace.varName, trace.fileId)}: ${nFinite} ${text('heatmapFinite')}, ${nInvalid} ${text('heatmapInvalid')}`;
    }).join('\n');
};

proto._cleanupCalendarHeatmapChart = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot) return;
    if (plot._calendarHeatmapSelectionDocListeners) {
        document.removeEventListener('mousemove', plot._calendarHeatmapSelectionDocListeners.move);
        document.removeEventListener('mouseup', plot._calendarHeatmapSelectionDocListeners.up);
        plot._calendarHeatmapSelectionDocListeners = null;
    }
    if (plot._calendarHeatmapSplitterDocListeners) {
        document.removeEventListener('mousemove', plot._calendarHeatmapSplitterDocListeners.move);
        document.removeEventListener('mouseup', plot._calendarHeatmapSplitterDocListeners.up);
        plot._calendarHeatmapSplitterDocListeners = null;
    }
    clearTimeout(plot._calendarHeatmapRecomputeTimer);
    plot._calendarHeatmapRecomputeTimer = null;
    plot._calendarHeatmapToken = (plot._calendarHeatmapToken || 0) + 1;
    plot._calendarHeatmapHandlersInstalled = false;
    plot._calendarHeatmapSelectionDiv = null;
    plot._calendarHeatmapModels = [];
    document.body.classList.remove(
        'heatmap-selection-dragging',
        'heatmap-selection-moving',
        'heatmap-split-dragging',
    );
    void panelId;
};

// PlotManager's public integration contract intentionally uses short Heatmap
// names. Keep the longer calendar-prefixed implementations private aliases so
// future calendar visualizations do not collide with Plotly's trace type name.
proto._defaultHeatmapState = function() {
    return this._defaultCalendarHeatmapState();
};
proto._normalizeHeatmapState = function(raw = {}) {
    return this._normalizeCalendarHeatmapState(raw);
};
proto._ensureHeatmapState = function(plot) {
    return this._ensureCalendarHeatmapState(plot);
};
proto._addHeatmapTrace = function(panelId, varName, panelEl, plot) {
    return this._addCalendarHeatmapTrace(panelId, varName, panelEl, plot);
};
proto._createHeatmapChart = function(panelId, panelEl) {
    return this._createCalendarHeatmapChart(panelId, panelEl);
};
proto._autoScaleHeatmapPanel = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div) return Promise.resolve();
    const timePromise = this._autoScalePlotTimeOnly(plot);
    const heatmapPromise = plot.heatmapDiv
        ? Plotly.relayout(plot.heatmapDiv, { 'xaxis.autorange': true })
        : Promise.resolve();
    return Promise.all([timePromise, heatmapPromise]);
};
proto._cleanupHeatmapChart = function(panelId, plot = this.plots.get(panelId)) {
    return this._cleanupCalendarHeatmapChart(panelId, plot);
};
proto._updateHeatmapSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
    return this._updateCalendarHeatmapSelectionShapes(panelId, plot);
};

}
