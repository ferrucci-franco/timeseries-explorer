// What the phone layout needs to know about each analysis of the time-series
// family (docs/phone-web-specification.md §5.3 and §11).
//
// §11 asks every new desktop feature to say where it lives on a phone. For an
// analysis that is one entry here, and nothing else in the compact layout
// names an analysis mode: the entry carries the radio in the Analyze sheet,
// whether a tap in Data adds a signal to it, the pane it draws beside its time
// series, the buttons of its own top bar (hidden on a phone) and the options
// panel it lends to the sheet. The sets at the foot are derived from the
// entries, and `scripts/test-compact-layout.mjs` fails when the desktop
// Analysis menu offers an analysis this file does not describe.
//
// Nothing is imported on purpose: a label is a translation key, not a
// translated string, and every action is handed what it works on. That keeps
// this file a description the tests can read without a DOM or a Plotly.
//
// An action's context is `{ pm, panelId, plot, refresh }`: the PlotManager,
// the panel it acts on, its plot, and `refresh()` to rebuild the open sheet so
// a toggle shows its new state.

const flip = (layout) => (layout === 'horizontal' ? 'vertical' : 'horizontal');

// Each analysis's drawing in the Analyze sheet, in the hand of the data tools'
// tiles (compact-tools-methods.js): 24 × 24, stroked, tinted by the sheet.
// "None" draws the plot that is left — a time series, or a 2D plot.
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
    timeseries: svg('<path d="M4 4v16h16"/><path d="M7 13c1.6-5 3.2-5 4.8 0s3.2 5 4.8 0c.8-2.5 1.6-3.7 2.4-3.7"/>'),
    phase2d: svg('<path d="M4 4v16h16"/><ellipse cx="13" cy="11.5" rx="6.2" ry="3" transform="rotate(-35 13 11.5)"/>'),
    fft: svg('<path d="M3 20h18"/><path d="M4 18h2.5l1.5-12 1.5 12h2.5l1.2-6 1.2 6h2.3l.8-3 .8 3H20"/>'),
    histogram: svg('<path d="M3 20h18"/><path d="M5 20v-5h3v-6h3v-4h3v6h3v5h2v4"/><path d="M8 20v-5M11 20v-11M14 20v-9M17 20v-4" stroke-opacity=".5"/>'),
    heatmap: svg('<g stroke="none" fill="currentColor">'
        + [[3.5, 3.5, 0.35], [9.6, 3.5, 1], [15.7, 3.5, 0.6],
            [3.5, 9.6, 0.8], [9.6, 9.6, 0.25], [15.7, 9.6, 1],
            [3.5, 15.7, 1], [9.6, 15.7, 0.55], [15.7, 15.7, 0.3]]
            .map(([x, y, o]) => `<rect x="${x}" y="${y}" width="4.8" height="4.8" rx="1" fill-opacity="${o}"/>`).join('')
        + '</g>'),
    'temporal-profile': svg('<path d="M3 6.5c3.5 0 4.5 6 9 6s5.5-8 9-8M3 13.5c3.5 0 4.5 6 9 6s5.5-8 9-8" stroke-opacity=".45" stroke-dasharray="2 2.2"/><path d="M3 10c3.5 0 4.5 6 9 6s5.5-8 9-8"/>'),
    integral: svg('<path d="M10.5 4.6c-1.9-1-3.4 0-3.6 2.6l-.8 9.6c-.2 2.6-1.7 3.6-3.6 2.6"/><path d="M14 20v-5M17.5 20v-10M21 20v-7"/>'),
    correlation: svg('<path d="M4 19L20 5" stroke-opacity=".5"/><path stroke-width="3.2" d="M5.5 16h.01M9 16.5h.01M10.5 11.5h.01M14 12h.01M15 7.5h.01M18.5 8h.01"/>'),
    'curve-fit': svg('<path d="M4 4v16h16"/><path stroke-dasharray="2.4 2" d="M7 17c2-5 4-8 7-9.5s4.5-1.5 6-1.5"/><path stroke-width="3.2" d="M7.5 15.5h.01M10 11h.01M13 9h.01M16.5 7.5h.01"/>'),
    'phase2d-fit': svg('<path d="M3.5 18.5c5 0 8-1.5 10-5.5s3.5-7 7-8"/><path stroke-width="3.2" d="M6 15.5h.01M10 18.5h.01M12 11h.01M16.5 11.5h.01M17 5h.01"/>'),
    // Two stretches: the mean of one, the slope of the other, and the value
    // band that keeps the outliers out.
    trend: svg('<path d="M4 4v16h16"/>'
        + '<path stroke-opacity=".45" stroke-dasharray="2 2" d="M6 10.5h7M6 17.5h7"/>'
        + '<path d="M6.5 14h6.5"/><path d="M14.5 15.5L20 7"/>'),
    // A mode set up on the full layout, which the sheet only names.
    other: svg('<path d="M4 4v16h16"/><path d="M7 16l4-5 3 3 5-7"/>'),
};
export const COMPACT_ANALYSIS_OTHER_ICON = ICON.other;

export const COMPACT_ANALYSES = [
    {
        mode: 'timeseries',
        icon: ICON.timeseries,
        labelKey: 'compactAnalysisNone',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId }, trace) => pm.removeTrace(panelId, trace.varName, trace.fileId),
    },
    {
        mode: 'fft',
        icon: ICON.fft,
        labelKey: 'analysisItemFft',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeFftTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'spectrum',
            div: 'fftDiv',
            windowZoom: true,
            // The spectrum alone: its own limits (fMin/fMax, yMin/yMax) still
            // hold, as they do for its desktop reset.
            fit: ({ pm, plot, relayout }, axis) => (axis === 'all'
                ? pm._applyFftAxisLimits(plot)
                : relayout(pm._fftAxisLimitUpdate(plot, axis, { visibleOnly: true }))),
        },
        optionsTitleKey: 'compactFftOptions',
        options: ({ pm, plot }) => pm._fftOptionsPanel(plot),
        reset: { labelKey: 'fftResetLabel', titleKey: 'fftResetView', run: ({ pm, panelId }) => pm._resetFftView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => [
            { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setFftLayout(panelId, flip(pm._ensureFftState(plot).layout)) },
            {
                labelKey: 'hideTimeSeries',
                titleKey: 'hideTimeSeriesTooltip',
                pressed: !!pm._ensureFftState(plot).timeSeriesHidden,
                run: () => { pm._toggleFftTimeSeries(panelId); refresh(); },
            },
        ],
    },
    {
        mode: 'histogram',
        icon: ICON.histogram,
        labelKey: 'analysisItemHistogram',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeHistogramTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'bars',
            div: 'histogramDiv',
            windowZoom: true,
            // The bars: values on X, counts (or %, density) on Y.
            fit: ({ pm, plot, relayout }, axis) => (axis === 'all'
                ? relayout({ 'xaxis.autorange': true, 'yaxis.autorange': true })
                : pm._autoScaleHistogramAxis(plot, axis)),
        },
        optionsTitleKey: 'compactHistogramOptions',
        options: ({ pm, plot }) => pm._histogramOptionsPanel(plot),
        reset: { labelKey: 'fftResetLabel', titleKey: 'fftResetView', run: ({ pm, panelId }) => pm._resetHistogramView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => [
            { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setHistogramLayout(panelId, flip(pm._ensureHistogramState(plot).layout)) },
            {
                labelKey: 'hideTimeSeries',
                titleKey: 'hideTimeSeriesTooltip',
                pressed: !!pm._ensureHistogramState(plot).timeSeriesHidden,
                run: () => { pm._toggleHistogramTimeSeries(panelId); refresh(); },
            },
            // On the desktop, in the View menu, which the phone has not.
            {
                labelKey: 'viewLogCounts',
                titleKey: 'viewLogCountsTitle',
                pressed: pm._ensureHistogramState(plot).yScale === 'log',
                run: () => { pm._toggleHistogramLogY(panelId); refresh(); },
            },
        ],
    },
    {
        mode: 'heatmap',
        icon: ICON.heatmap,
        labelKey: 'analysisItemHeatmap',
        signals: true,
        fit: true,
        // Its time pane is a time series, so a finger draws a window on it.
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeCalendarHeatmapTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'calendar',
            div: 'heatmapDiv',
            windowZoom: false,
            // Its rows are a fixed calendar axis (weekday, hour): there is
            // nothing to fit vertically, so the desktop toolbar hides that
            // button too.
            fitY: false,
            fit: ({ pm, plot }, axis) => (axis === 'y' ? undefined : pm._autoScaleHeatmapAxis(plot, 'x')),
        },
        optionsTitleKey: 'compactHeatmapOptions',
        options: ({ pm, plot }) => pm._calendarHeatmapOptionsPanel(plot),
        reset: { labelKey: 'heatmapReset', titleKey: 'heatmapResetView', run: ({ pm, panelId }) => pm._resetCalendarHeatmapView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const state = pm._ensureCalendarHeatmapState(plot);
            const actions = [
                { label: 'V/H', titleKey: 'heatmapLayoutToggle', run: () => pm._setCalendarHeatmapLayout(panelId, flip(state.layout)) },
                {
                    labelKey: 'hideTimeSeries',
                    titleKey: 'hideTimeSeriesTooltip',
                    pressed: !!state.timeSeriesHidden,
                    run: () => { pm._toggleCalendarHeatmapTimeSeries(panelId); refresh(); },
                },
            ];
            // Appended data is not folded into the calendar until it is asked
            // for: on the desktop that button appears in the top bar, which the
            // phone hides, so it appears here while there is something to add.
            if (state.dirty) {
                actions.push({
                    labelKey: 'heatmapRefresh',
                    titleKey: 'heatmapRefreshTooltip',
                    run: () => { pm._refreshDirtyCalendarHeatmap(panelId); refresh(); },
                });
            }
            return actions;
        },
    },
    {
        mode: 'temporal-profile',
        icon: ICON['temporal-profile'],
        labelKey: 'analysisItemProfile',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeTemporalProfileTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'profile',
            div: 'temporalProfileDiv',
            windowZoom: true,
            // X goes back to the whole period (0–24 h, a week…), Y fits.
            fit: ({ pm, plot }, axis) => (axis === 'all'
                ? pm._resetTemporalProfileAnalysisView(plot)
                : pm._autoScaleTemporalProfileAxis(plot, axis)),
        },
        optionsTitleKey: 'compactProfileOptions',
        options: ({ pm, plot }) => pm._temporalProfileOptionsPanel(plot),
        reset: { labelKey: 'temporalProfileReset', titleKey: 'temporalProfileResetTip', run: ({ pm, panelId }) => pm._resetTemporalProfileView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const hidden = !!pm._ensureTemporalProfileState(plot).timeSeriesHidden;
            const timeKey = hidden ? 'temporalProfileShowTime' : 'temporalProfileHideTime';
            return [
                { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setTemporalProfileLayout(panelId, flip(pm._ensureTemporalProfileState(plot).layout)) },
                {
                    labelKey: timeKey,
                    titleKey: timeKey,
                    pressed: hidden,
                    run: () => { pm._toggleTemporalProfileTimeSeries(panelId); refresh(); },
                },
            ];
        },
    },
    {
        mode: 'integral',
        icon: ICON.integral,
        labelKey: 'analysisItemIntegral',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeIntegralTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'integral',
            div: 'integralDiv',
            // Its bars are per period, not a time axis to window.
            windowZoom: false,
            fit: ({ pm, plot }, axis) => (axis === 'all'
                ? pm._resetIntegralAnalysisView(plot)
                : pm._autoScaleIntegralAxis(plot, axis)),
        },
        optionsTitleKey: 'compactIntegralOptions',
        options: ({ pm, plot }) => pm._integralOptionsPanel(plot),
        reset: { labelKey: 'integralReset', titleKey: 'integralResetTip', run: ({ pm, panelId }) => pm._resetIntegralView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const hidden = !!pm._ensureIntegralState(plot).timeSeriesHidden;
            const timeKey = hidden ? 'integralShowTime' : 'integralHideTime';
            return [
                { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setIntegralLayout(panelId, flip(pm._ensureIntegralState(plot).layout)) },
                {
                    labelKey: timeKey,
                    titleKey: timeKey,
                    pressed: hidden,
                    run: () => { pm._toggleIntegralTimeSeries(panelId); refresh(); },
                },
            ];
        },
    },
    {
        mode: 'curve-fit',
        icon: ICON['curve-fit'],
        // The sheet lists the 2D plot's Curve Fit too: this one says it is
        // the one over time.
        labelKey: 'compactAnalysisCurveFitTime',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeCurveFitTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'residuals',
            div: 'curveFitResidualDiv',
            windowZoom: true,
            fit: ({ pm, plot }, axis) => (axis === 'all'
                ? pm._autoScaleCurveFitAxis(plot, 'y')
                : pm._autoScaleCurveFitAxis(plot, axis)),
        },
        optionsTitleKey: 'compactFitOptions',
        options: ({ pm, plot }) => pm._curveFitOptionsPanel(plot),
        reset: { labelKey: 'fftResetLabel', titleKey: 'fftResetView', run: ({ pm, panelId }) => pm._resetCurveFitView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const hidden = !!pm._ensureCurveFitState(plot).residualsHidden;
            const key = hidden ? 'curveFitShowResiduals' : 'curveFitHideResiduals';
            return [
                { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setCurveFitLayout(panelId, flip(pm._ensureCurveFitState(plot).layout)) },
                { labelKey: key, titleKey: 'curveFitResidualsTooltip', pressed: hidden, run: () => { pm._toggleCurveFitResiduals(panelId); refresh(); } },
            ];
        },
    },
    {
        mode: 'trend',
        icon: ICON.trend,
        labelKey: 'analysisItemTrend',
        signals: true,
        fit: true,
        windowZoom: true,
        removeTrace: ({ pm, panelId, plot }, trace) => pm._removeTrendTraceFromLegend(panelId, plot, trace),
        pane: {
            name: 'segments',
            // Its second pane is a table of the segments, not a chart: there
            // are no axes on it to fit and no window to draw.
            div: 'trendTableEl',
            windowZoom: false,
            fit: null,
        },
        optionsTitleKey: 'compactTrendOptions',
        options: ({ pm, plot }) => pm._trendOptionsPanel(plot),
        reset: { labelKey: 'fftResetLabel', titleKey: 'fftResetView', run: ({ pm, panelId }) => pm._resetTrendView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const hidden = !!pm._ensureTrendState(plot).tableHidden;
            const key = hidden ? 'trendShowTable' : 'trendHideTable';
            return [
                { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setTrendLayout(panelId, flip(pm._ensureTrendState(plot).layout)) },
                { labelKey: key, titleKey: 'trendTableTooltip', pressed: hidden, run: () => { pm._toggleTrendTable(panelId); refresh(); } },
            ];
        },
    },
    {
        // The analysis of the 2D family: its signals come in pairs, and an r
        // for each. Shown in the Analyze sheet beside the others, where
        // turning it off leaves the 2D plot the pairs belong to.
        mode: 'correlation',
        icon: ICON.correlation,
        labelKey: 'modeCorrelationLabel',
        pairs: true,
        offMode: 'phase2d',
        offLabelKey: 'compactAnalysisNone2d',
        offIcon: ICON.phase2d,
        pairHintKey: 'compactCorrelationHint',
        fit: true,
        windowZoom: true,
        removePair: ({ pm, panelId, plot }, pair) => pm._removeCorrelationPairFromLegend(panelId, plot, pair),
        pane: {
            name: 'correlation',
            div: 'correlationDiv',
            windowZoom: false,
            // The results pane is r against the pairs: a fixed [-1, 1] and a
            // row per pair, so there is nothing to fit and no buttons on it.
            fit: null,
        },
        // Its time pane draws the pairs, not plot.traces, so the time-pane fit
        // the other analyses share has nothing to read; the desktop's own
        // buttons fit it this way.
        mainFit: ({ pm, plot }, axis) => (axis === 'all'
            ? pm._autoScaleCorrelationTime(plot)
            : pm._autoScaleCorrelationAxis(plot, axis)),
        optionsTitleKey: 'compactCorrelationOptions',
        options: ({ pm, plot }) => pm._correlationOptionsPanel(plot),
        reset: { labelKey: 'fftResetLabel', titleKey: 'fftResetView', run: ({ pm, panelId }) => pm._resetCorrelationView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const state = pm._ensureCorrelationState(plot);
            const actions = [
                { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setCorrelationLayout(panelId, flip(state.layout)) },
                {
                    labelKey: 'hideTimeSeries',
                    titleKey: 'hideTimeSeriesTooltip',
                    pressed: !!state.timeSeriesHidden,
                    run: () => { pm._toggleCorrelationTimeSeries(panelId); refresh(); },
                },
            ];
            // Only while a lazy pair is stale after a live append, as on the
            // desktop top bar the phone hides.
            if (state.dirty) {
                actions.push({
                    labelKey: 'correlationRefresh',
                    titleKey: 'correlationRefreshTooltip',
                    run: () => { pm._refreshDirtyCorrelation(panelId); refresh(); },
                });
            }
            return actions;
        },
    },
    {
        // The one analysis that is not a mode: a 2D plot opens its fit
        // workspace over itself, and its own pairs are what it fits. Which
        // analysis a panel carries is therefore asked of the plot, not of its
        // mode (compactAnalysisFor), and this entry says how it is turned on
        // and off instead of which mode to switch to.
        mode: 'phase2d-fit',
        icon: ICON['phase2d-fit'],
        labelKey: 'phase2dFitToggleLabel',
        onMode: 'phase2d',
        offMode: 'phase2d',
        offLabelKey: 'compactAnalysisNone2d',
        offIcon: ICON.phase2d,
        matches: (plot) => plot?.mode === 'phase2d' && !!plot.phase2d?.fitEnabled,
        // On its own plot it is a toggle; coming from another plot the flag is
        // set first, so the 2D plot is built with the workspace already open.
        turnOn: ({ pm, panelId, plot }) => {
            if (plot.mode === 'phase2d') pm._togglePhase2dFit(panelId);
            else pm._ensurePhase2dState(plot).fitEnabled = true;
        },
        turnOff: ({ pm, panelId }) => pm._togglePhase2dFit(panelId),
        fit: true,
        // Its main pane is the 2D plot: x against y, no window to draw.
        windowZoom: false,
        pane: {
            name: 'fit-time',
            div: 'phase2dFitTimeDiv',
            windowZoom: true,
            fit: ({ pm, plot, relayout }, axis) => (axis === 'all'
                ? pm._autoScalePhase2dFitTime(plot)
                : relayout({ [`${axis}axis.autorange`]: true })),
        },
        // The pane the workspace is built around is the 2D plot itself, which
        // fits the way it does on its own.
        mainFit: ({ pm, panelId, plot }, axis) => (axis === 'all'
            ? pm._autoScalePlot(panelId, plot)
            : pm._autoScalePlotAxis(panelId, plot, axis)),
        optionsTitleKey: 'compactFitOptions',
        options: ({ plot }) => plot?.phase2dFitOptions || null,
        reset: { labelKey: 'fftResetLabel', titleKey: 'fftResetView', run: ({ pm, panelId }) => pm._resetPhase2dFitView(panelId) },
        actions: ({ pm, panelId, plot, refresh }) => {
            const state = pm._ensurePhase2dState(plot);
            const actions = [
                { label: 'V/H', titleKey: 'fftLayoutToggle', run: () => pm._setPhase2dFitLayout(panelId, flip(state.layout)) },
                {
                    labelKey: 'hideTimeSeries',
                    titleKey: 'hideTimeSeriesTooltip',
                    pressed: !!state.timeSeriesHidden,
                    run: () => { pm._togglePhase2dFitTimeSeries(panelId); refresh(); },
                },
            ];
            if (state.dirty) {
                actions.push({
                    labelKey: 'phase2dFitUpdate',
                    titleKey: 'phase2dFitUpdateTooltip',
                    run: () => { pm._refreshDirtyPhase2dFit(panelId); refresh(); },
                });
            }
            return actions;
        },
    },
];

const BY_MODE = new Map(COMPACT_ANALYSES.map(entry => [entry.mode, entry]));

// The entry for a plot's mode, or nothing when the phone layout does not drive
// it: such a panel is still shown, with its controls on the desktop layout.
export const compactAnalysis = (mode) => BY_MODE.get(mode) || null;

// The analysis a plot carries right now. Most are a mode, but one is a
// workspace a plot opens over itself, so the plot — not its mode — is what
// the phone layout asks.
export const compactAnalysisFor = (plot) => {
    if (!plot) return null;
    for (const entry of COMPACT_ANALYSES) {
        if (entry.matches?.(plot)) return entry;
    }
    return BY_MODE.get(plot.mode) || null;
};

// The analyses whose signals the phone layout lists and edits like a time
// series: a tap in Data adds or removes one.
export const COMPACT_SIGNAL_LIST_MODES = new Set(
    COMPACT_ANALYSES.filter(entry => entry.signals).map(entry => entry.mode),
);

// Plot modes whose panes carry the fit buttons — the mode an analysis is, or
// the one it opens over.
export const COMPACT_FIT_MODES = new Set(
    COMPACT_ANALYSES.filter(entry => entry.fit).map(entry => entry.onMode || entry.mode),
);

// An analysis's own pane, next to its time pane: the plot property that holds
// its div, and what the compact layout calls it.
export const COMPACT_ANALYSIS_PANES = COMPACT_ANALYSES
    .filter(entry => entry.pane)
    .map(entry => ({ mode: entry.mode, ...entry.pane }));

// The analyses built from pairs of signals rather than from signals of their
// own: a tap in Data gives one an x, then a y, and the phone lists its pairs
// where it lists a time series' signals.
export const COMPACT_PAIR_MODES = new Set(
    COMPACT_ANALYSES.filter(entry => entry.pairs).map(entry => entry.mode),
);

// Where a slow double tap draws a window: a pane with a time axis. The entry's
// own flag answers for the pane the plot is built on, its pane's for the one
// beside it.
export const compactWindowZoom = (analysis, pane) => (analysis?.pane?.name === pane
    ? !!analysis.pane.windowZoom
    : !!analysis?.windowZoom);
