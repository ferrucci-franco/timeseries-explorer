import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const interactionSource = readFileSync(
    new URL('../src/plots/methods/interaction-methods.js', import.meta.url),
    'utf8',
);
const plotManagerSource = readFileSync(
    new URL('../src/plots/plot-manager.js', import.meta.url),
    'utf8',
);
const translationsSource = readFileSync(
    new URL('../src/i18n/translations.js', import.meta.url),
    'utf8',
);
const histogramMethodsSource = readFileSync(
    new URL('../src/plots/methods/histogram-methods.js', import.meta.url),
    'utf8',
);
const heatmapMethodsSource = readFileSync(
    new URL('../src/plots/methods/heatmap-methods.js', import.meta.url),
    'utf8',
);
const temporalProfileMethodsSource = readFileSync(
    new URL('../src/plots/methods/temporal-profile-methods.js', import.meta.url),
    'utf8',
);
const duckDbSource = readFileSync(
    new URL('../src/data/duckdb-source.js', import.meta.url),
    'utf8',
);
const contentCss = readFileSync(
    new URL('../src/styles/content.css', import.meta.url),
    'utf8',
);
const indexHtml = readFileSync(
    new URL('../index.html', import.meta.url),
    'utf8',
);

const marksMethodsSource = readFileSync(
    new URL('../src/plots/methods/marks-methods.js', import.meta.url),
    'utf8',
);

// marks-methods.js defines its methods inside an installer function, indented
// one level; a method runs until the next one.
const marksMethodAssignment = (name) => {
    const marker = `    proto.${name} = function`;
    const start = marksMethodsSource.indexOf(marker);
    assert.ok(start >= 0, `${name} marks method is present`);
    const next = marksMethodsSource.indexOf('\n    proto.', start + marker.length);
    return marksMethodsSource.slice(start, next >= 0 ? next : marksMethodsSource.length);
};

const methodAssignment = (name) => {
    const marker = `proto.${name} = function`;
    const start = interactionSource.indexOf(marker);
    assert.ok(start >= 0, `${name} method is present`);
    const next = interactionSource.indexOf('\nproto.', start + marker.length);
    return interactionSource.slice(start, next >= 0 ? next : interactionSource.length);
};

const temporalMethodAssignment = (name) => {
    const plainMarker = `proto.${name} = function`;
    const asyncMarker = `proto.${name} = async function`;
    const asyncStart = temporalProfileMethodsSource.indexOf(asyncMarker);
    const marker = asyncStart >= 0 ? asyncMarker : plainMarker;
    const start = asyncStart >= 0 ? asyncStart : temporalProfileMethodsSource.indexOf(plainMarker);
    assert.ok(start >= 0, `${name} temporal-profile method is present`);
    const next = temporalProfileMethodsSource.indexOf('\nproto.', start + marker.length);
    return temporalProfileMethodsSource.slice(start, next >= 0 ? next : temporalProfileMethodsSource.length);
};

const heatmapMethodAssignment = (name) => {
    const plainMarker = `proto.${name} = function`;
    const asyncMarker = `proto.${name} = async function`;
    const asyncStart = heatmapMethodsSource.indexOf(asyncMarker);
    const marker = asyncStart >= 0 ? asyncMarker : plainMarker;
    const start = asyncStart >= 0 ? asyncStart : heatmapMethodsSource.indexOf(plainMarker);
    assert.ok(start >= 0, `${name} heatmap method is present`);
    const next = heatmapMethodsSource.indexOf('\nproto.', start + marker.length);
    return heatmapMethodsSource.slice(start, next >= 0 ? next : heatmapMethodsSource.length);
};

class FakeClassList {
    constructor(element) {
        this.element = element;
    }

    _values() {
        return this.element.className.trim().split(/\s+/).filter(Boolean);
    }

    contains(name) {
        return this._values().includes(name);
    }

    toggle(name, force) {
        const values = new Set(this._values());
        const enabled = force === undefined ? !values.has(name) : !!force;
        if (enabled) values.add(name);
        else values.delete(name);
        this.element.className = [...values].join(' ');
        return enabled;
    }
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.disabled = false;
        this.textContent = '';
        this.title = '';
    }

    appendChild(child) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    append(...children) {
        children.forEach(child => this.appendChild(child));
    }

    remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        const index = siblings.indexOf(this);
        if (index >= 0) siblings.splice(index, 1);
        this.parentElement = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    replaceChildren(...children) {
        for (const child of [...this.children]) child.remove();
        children.forEach(child => this.appendChild(child));
    }

    addEventListener(type, handler) {
        const handlers = this.listeners.get(type) || [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
    }

    click() {
        for (const handler of this.listeners.get('click') || []) {
            handler({ stopPropagation() {} });
        }
    }

    _descendants() {
        return this.children.flatMap(child => [child, ...child._descendants()]);
    }

    querySelectorAll(selector) {
        const classes = selector
            .split(',')
            .map(part => part.trim())
            .filter(part => part.startsWith('.'))
            .map(part => part.slice(1));
        return this._descendants().filter(element => (
            classes.some(className => element.classList.contains(className))
        ));
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
}

class ToolbarHarness {
    constructor(mode, stateAnimDim = 2) {
        this.modeChanges = [];
        this.warnings = [];
        this.autoscaleCalls = [];
        this.files = new Map();
        this.plot = {
            mode,
            stateAnimDim,
            stateSlots: { x: stateAnimDim >= 3 ? ['x', 'y', 'z'] : ['x', 'y'] },
            timeseriesStacked: false,
            timeseriesY2Enabled: false,
            fft: { window: 'hann', zeroPadding: 4 },
            histogram: { binMode: 'width', binWidth: 0.25 },
            heatmap: { calendarMode: 'day-hour', aggregation: 'max' },
            temporalProfile: { period: 'week', renderMode: 'line-band' },
            cursors: { enabled: false },
        };
        this.plots = new Map([['panel', this.plot]]);
    }

    _hasContent() { return true; }
    // Which of the panel's files repeat an instant is the repeated-methods
    // mixin's business; the toolbar only reads the verdict.
    _repeatedAvailability(plot) { return plot?._testRepeatedAvailability || 'some'; }
    _ensureFftState(plot) { return plot.fft; }
    _ensurePhase2dState(plot) {
        plot.phase2d = { displayMode: 'lines', markerSize: 4, markerOpacity: 0.65, ...(plot.phase2d || {}) };
        return plot.phase2d;
    }
    _phase2dShowsMarkers(state) { return state.displayMode !== 'lines'; }
    _equalAspectAllowed(plot) { return plot?.mode !== 'phase2d' || !!plot.phase2dXLog === !!plot.phase2dYLog; }
    _ensureHistogramState(plot) { return plot.histogram; }
    _is3D(mode) { return mode === 'phase2dt' || mode === 'phase3d'; }
    _isStateAnim3D(plot) { return plot?.mode === 'state-anim' && (plot.stateAnimDim || 2) >= 3; }
    _supportsEqualAspect2D(plot) { return plot?.mode === 'phase2d' || (plot?.mode === 'state-anim' && (plot.stateAnimDim || 2) === 2); }
    _plotSupportsCursors() { return true; }
    _anyCursorEnabled(plot) { return !!(plot?.cursors?.enabled || (plot?.mode === 'fft' && plot?.cursorsSpectrum?.enabled)); }
    _autoScalePlot(panelId, plot) { this.autoscaleCalls.push({ panelId, plot }); }
    _runWithEagerDetailLoading(_panelId, work) { return work(); }
    _dismissModeChangeWarning() {}
    _closeMarksMenu() {}
    _showModeChangeWarning(panelId, mode) { this.warnings.push({ panelId, mode }); }
    _setMode(panelId, mode, stateAnimDim, options) {
        this.modeChanges.push({ panelId, mode, stateAnimDim, options });
        this.plot.mode = mode;
    }
}

const sandbox = {
    proto: ToolbarHarness.prototype,
    MARKER_SIZE_MIN: 1,
    MARKER_SIZE_MAX: 20,
    MARKER_OPACITY_MIN: 0.05,
    MARKER_OPACITY_MAX: 1,
    document: { createElement: tagName => new FakeElement(tagName) },
    i18n: { t: key => key },
};

vm.runInNewContext([
    methodAssignment('_injectModeButtons'),
    methodAssignment('_toggleTimeseriesAnalysisMode'),
    methodAssignment('_requestModeChange'),
    marksMethodAssignment('_createMarksButton'),
    marksMethodAssignment('_applyMarksButtonState'),
    marksMethodAssignment('_marksActiveCount'),
    marksMethodAssignment('_marksMenuModel'),
    marksMethodAssignment('_renderMarksMenu'),
    marksMethodAssignment('_renderPanelMenuItems'),
    marksMethodAssignment('_panelLineShapeState'),
    marksMethodAssignment('_viewMenuModel'),
    marksMethodAssignment('_createViewButton'),
    marksMethodAssignment('_applyViewButtonState'),
    marksMethodAssignment('_renderViewMenu'),
    marksMethodAssignment('_analysisModes'),
    marksMethodAssignment('_analysisMenuModel'),
    marksMethodAssignment('_createAnalysisButton'),
    marksMethodAssignment('_applyAnalysisButtonState'),
    marksMethodAssignment('_renderAnalysisMenu'),
].join('\n'), sandbox);

// The Analysis menu of a rendered toolbar, and a pick in it.
const renderAnalysisMenu = (manager) => {
    const menu = new FakeElement('div');
    manager._renderAnalysisMenu('panel', menu);
    return menu;
};
const pickAnalysis = (manager, mode) => marksItem(renderAnalysisMenu(manager), mode).click();

// The Marks menu of a rendered toolbar, rendered into a detached element the
// way _openMarksMenu does it (minus positioning, which needs a real layout).
const renderMarksMenu = (manager) => {
    const menu = new FakeElement('div');
    manager._renderMarksMenu('panel', menu);
    return menu;
};
const marksItem = (menu, key) => menu.querySelector(`.marks-item-${key}`);
// The View menu, the same way.
const renderViewMenu = (manager) => {
    const menu = new FakeElement('div');
    manager._renderViewMenu('panel', menu);
    return menu;
};

class TemporalStateHarness {}

vm.runInNewContext([
    temporalMethodAssignment('_defaultTemporalProfileState'),
    temporalMethodAssignment('_normalizeTemporalProfileState'),
    temporalMethodAssignment('_ensureTemporalProfileState'),
].join('\n'), {
    proto: TemporalStateHarness.prototype,
    TEMPORAL_PROFILE_DEFAULT_RESOLUTION_MINUTES: { day: 60, week: 60, month: 1440, year: 1440 },
    TEMPORAL_PROFILE_PERIODS: new Set(['day', 'week', 'month', 'year']),
    PROFILE_LAYOUTS: new Set(['horizontal', 'vertical']),
    PROFILE_RENDER_MODES: new Set(['columns', 'line', 'line-band']),
    finiteOrNull(value) {
        if (value === '' || value === null || value === undefined) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    },
    hasFinite(value) {
        return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
    },
});

// Option controls close over the state object that existed when their DOM was
// rendered. A normalization/recompute cycle must not replace that object.
{
    const manager = new TemporalStateHarness();
    const plot = { temporalProfile: { period: 'day', renderMode: 'line-band' } };
    const controlState = manager._ensureTemporalProfileState(plot);
    assert.equal(controlState.dayGrouping, 'all', 'All days is the default Day grouping');
    const recomputedState = manager._ensureTemporalProfileState(plot);
    assert.equal(recomputedState, controlState, 'Temporal Profile preserves state identity across recomputes');
    controlState.period = 'week';
    controlState.renderMode = 'columns';
    controlState.groupedBars = true;
    controlState.saturdays = false;
    controlState.resolutionByPeriod.week = 15;
    controlState.dayGrouping = 'all';
    controlState.yearResolution = 'month';
    const liveState = manager._ensureTemporalProfileState(plot);
    assert.equal(liveState.period, 'week', 'Period control updates the live state');
    assert.equal(liveState.renderMode, 'columns', 'Display control updates the live state');
    assert.equal(liveState.groupedBars, true, 'Side-by-side bar control updates the live state');
    assert.equal(liveState.saturdays, false, 'Day-category controls update the live state');
    assert.equal(liveState.resolutionByPeriod.week, 15, 'Resolution control updates the live state');
    assert.equal(liveState.dayGrouping, 'all', 'Day grouping control updates the live state');
    assert.equal(liveState.yearResolution, 'month', 'Year resolution control updates the live state');

    const migrated = manager._ensureTemporalProfileState({
        temporalProfile: {
            period: 'day',
            resolutionByPeriod: { day: 1440, week: 60, month: 1440, year: 1440 },
            customResolutionByPeriod: { day: false, week: false, month: false, year: false },
        },
    });
    assert.equal(migrated.resolutionByPeriod.day, 60, 'obsolete one-day preset migrates to the hourly Day default');
}

assert.doesNotMatch(temporalProfileMethodsSource, /legendgroup\s*:/, 'Temporal Profile legend entries use standard plot spacing');
assert.match(temporalProfileMethodsSource, /barmode:\s*state\.groupedBars \? 'group' : 'overlay'/, 'Temporal Profile columns switch between overlay and side-by-side groups');
assert.match(
    temporalProfileMethodsSource,
    /if \(!state\.groupedBars\) barTrace\.width =/,
    'Side-by-side bars delegate width and offsets to Plotly automatic grouping',
);
assert.match(temporalProfileMethodsSource, /opacity:\s*PROFILE_BAR_OPACITY/, 'Temporal Profile overlay columns are translucent');
assert.doesNotMatch(temporalProfileMethodsSource, /pattern:\s*\{/, 'Temporal Profile columns use one consistent fill style');
assert.doesNotMatch(temporalProfileMethodsSource, /circle-open|lines\+markers/, 'Temporal Profile lines do not mix point marker styles');
assert.match(
    temporalMethodAssignment('_installTemporalProfilePlotHandlers'),
    /plotly_doubleclick[\s\S]*?setTimeout[\s\S]*?_resetTemporalProfileAnalysisView/,
    'Temporal Profile defers its double-click reset until Plotly finishes dispatching',
);
assert.match(
    temporalMethodAssignment('_resetTemporalProfileAnalysisView'),
    /period === 'day' \? 24 : period === 'week' \? 168 : period === 'month' \? 31 \* 24 : 366 \* 24/,
    'Temporal Profile double-click restores the complete calendar domain',
);
assert.match(
    temporalProfileMethodsSource,
    /option\.disabled\s*=\s*resolutionBelowStep\(minutes, minimumResolution\)/,
    'Temporal Profile disables preset resolutions below the detected data timestep',
);
assert.match(
    temporalProfileMethodsSource,
    /period === 'day'[\s\S]*?PROFILE_RESOLUTION_PRESETS\.filter\(minutes => minutes < 1440\)/,
    'Day profiles omit the one-day resolution preset',
);
assert.match(
    temporalMethodAssignment('_recomputeTemporalProfile'),
    /resolutionBelowStep\(state\.resolutionByPeriod\[state\.period\], minimumResolution\)[\s\S]*?state\.resolutionByPeriod\[state\.period\]/,
    'Temporal Profile corrects an existing resolution that becomes too fine',
);
assert.match(temporalProfileMethodsSource, /temporalProfileYear/, 'Temporal Profile exposes the Year period');
assert.match(temporalProfileMethodsSource, /temporalProfileAllDays/, 'Day profiles expose the All days grouping');
assert.match(temporalProfileMethodsSource, /temporalProfileSideBySide/, 'Column display exposes the side-by-side checkbox');
assert.match(
    temporalMethodAssignment('_recomputeTemporalProfile'),
    /source\.getTemporalProfileAggregates\([\s\S]*?selectionRange:[\s\S]*?transforms/,
    'Temporal Profile sends lazy traces to the exact DuckDB aggregation path',
);
assert.match(
    duckDbSource,
    /async getTemporalProfileAggregates\([\s\S]*?temporalProfilesFromFinalRows/,
    'DuckDB exposes the compact lazy temporal-profile query API',
);
assert.match(
    temporalMethodAssignment('_setTemporalProfileComputing'),
    /lazy-detail-indicator temporal-profile-computing-indicator/,
    'Temporal Profile reuses the non-blocking FFT calculation pill',
);
assert.match(contentCss, /\.lazy-detail-indicator[\s\S]*?pointer-events:\s*none/, 'Calculation pills do not intercept plot pan/zoom');
assert.match(
    interactionSource,
    /querySelector\('\.lazy-data-detail-indicator'\)[\s\S]*?lazy-detail-indicator lazy-data-detail-indicator/,
    'Lazy detail loading uses its own non-blocking search pill',
);
assert.match(
    interactionSource,
    /querySelector\('\.missing-dense-indicator'\)[\s\S]*?lazy-detail-indicator missing-dense-indicator/,
    'Missing/NaN search uses its own non-blocking search pill',
);
assert.match(
    plotManagerSource,
    /initialLazyMissingSearch[\s\S]*?_setMissingDensityNotice\?\.\(plot, 'loading'\)[\s\S]*?_buildPlotData/,
    'Missing/NaN shows its search pill before the rebuilt Plotly frame initializes',
);
assert.match(
    temporalMethodAssignment('_recomputeTemporalProfile'),
    /_setTemporalProfileComputing\(plot, true\)[\s\S]*?await Promise\.all\(jobs\)[\s\S]*?_setTemporalProfileComputing\(plot, false\)/,
    'Temporal Profile keeps the previous plot in place while the lazy query runs',
);
assert.match(
    temporalMethodAssignment('_createTemporalProfileChart'),
    /initialLazyProfile[\s\S]*?_setTemporalProfileComputing\(plot, true\)[\s\S]*?Plotly\.newPlot/,
    'Temporal Profile shows its calculation pill before the first empty Plotly frame initializes',
);
assert.match(
    temporalMethodAssignment('_renderTemporalProfileOptionsPanel'),
    /!this\._temporalProfileHasCalendarTrace\(plot\)[\s\S]*?querySelectorAll\('button, input, select'\)[\s\S]*?control\.disabled = true/,
    'Temporal Profile disables every analysis control when no trace has calendar time',
);
assert.match(
    temporalMethodAssignment('_setTemporalProfileStatus'),
    /kind === 'warning'[\s\S]*?temporalProfileWarningSeePanel[\s\S]*?_syncTemporalProfileMessage/,
    'Temporal Profile topbar points warning users to the side panel',
);
assert.match(
    temporalMethodAssignment('_syncTemporalProfileMessage'),
    /temporal-profile-message[\s\S]*?kind === 'warning'/,
    'Temporal Profile side panel contains the full warning message',
);
assert.match(
    heatmapMethodAssignment('_calendarHeatmapTraceEligibility'),
    /_isGeneratedIndexTime[\s\S]*?!generatedCalendar[\s\S]*?_timeKind[\s\S]*?_fftTimeKind[\s\S]*?heatmapDatetimeRequired[\s\S]*?_timeDisplayModeForVar[\s\S]*?heatmapCalendarRequired/,
    'Heatmap accepts generated calendar time while preserving DateTime vs Calendar validation',
);
assert.match(
    heatmapMethodAssignment('_setCalendarHeatmapStatus'),
    /kind === 'blocked' \? 'warning'[\s\S]*?heatmapWarningSeePanel[\s\S]*?_syncCalendarHeatmapMessage/,
    'Heatmap topbar points warning users to the side panel',
);
assert.match(
    heatmapMethodAssignment('_syncCalendarHeatmapMessage'),
    /heatmap-message[\s\S]*?kind === 'warning'/,
    'Heatmap side panel contains the full warning message',
);
assert.match(
    temporalMethodAssignment('_recomputeTemporalProfile'),
    /resolutionUnit:\s*state\.period === 'year' && state\.yearResolution === 'month' \? 'month' : 'minute'/,
    'Year Month resolution is sent to the calendar-aware kernel',
);
assert.match(
    temporalMethodAssignment('_temporalProfileMinimumResolutionMinutes'),
    /PROFILE_PERIOD_DURATION_MINUTES\[period\] \/ TEMPORAL_PROFILE_MAX_BINS/,
    'Temporal Profile disables resolutions that exceed the bin limit for a period',
);

const renderToolbar = (mode, stateAnimDim = 2, plotState = {}) => {
    const manager = new ToolbarHarness(mode, stateAnimDim);
    Object.assign(manager.plot, plotState);
    const panel = new FakeElement('section');
    const toolbar = new FakeElement('div');
    toolbar.className = 'layout-panel-toolbar';
    panel.appendChild(toolbar);
    manager._injectModeButtons('panel', panel, mode);
    return { manager, toolbar };
};

const cssRuleBody = (selector) => {
    const bodies = [...contentCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(match => match[1]
            .split(',')
            .map(value => value.trim())
            .some(value => value === selector || value.endsWith(selector)))
        .map(match => match[2]);
    assert.ok(bodies.length > 0, `${selector} CSS rule is present`);
    return bodies.join('\n');
};

const findModeButton = (toolbar, mode, className = 'timeseries-analysis-btn') => (
    toolbar.querySelectorAll(`.${className}`).find(button => button.dataset.mode === mode)
);

const globalAutoscaleIconMatch = indexHtml.match(
    /<button[^>]*id=["']auto-zoom["'][\s\S]*?<span[^>]*class=["']icon["'][^>]*>([^<]+)<\/span>/,
);
assert.ok(globalAutoscaleIconMatch, 'global autoscale button icon is present');
const globalAutoscaleIcon = globalAutoscaleIconMatch[1].trim();
assert.equal(globalAutoscaleIcon, '⛶', 'global autoscale uses the expected icon');

// Fourier, Histogram and Heatmap are contextual actions of the time-series family,
// not primary plot types alongside 2D/3D/state animation.
for (const mode of ['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile', 'integral']) {
    const { manager, toolbar } = renderToolbar(mode);
    const primaryModes = toolbar
        .querySelector('.mode-btn-group')
        .querySelectorAll('.mode-btn')
        .map(button => button.dataset.mode);
    assert.ok(!primaryModes.includes('fft'), `${mode}: Fourier is absent from the primary plot-mode group`);
    assert.ok(!primaryModes.includes('histogram'), `${mode}: Histogram is absent from the primary plot-mode group`);
    assert.ok(!primaryModes.includes('heatmap'), `${mode}: Heatmap is absent from the primary plot-mode group`);
    assert.ok(!primaryModes.includes('temporal-profile'), `${mode}: Temporal Profile is absent from the primary plot-mode group`);
    assert.ok(!primaryModes.includes('integral'), `${mode}: Integral is absent from the primary plot-mode group`);

    const timeseriesPrimary = findModeButton(toolbar, 'timeseries', 'mode-btn');
    assert.ok(timeseriesPrimary?.classList.contains('active'), `${mode}: time-series family keeps its primary mode pressed`);

    const tools = toolbar.querySelector('.timeseries-tools-group');
    assert.ok(tools, `${mode}: time-series family exposes its contextual options group`);
    const autoscaleBtn = tools.querySelector('.panel-autoscale-btn');
    const marksBtn = tools.querySelector('.timeseries-marks-btn');
    assert.ok(autoscaleBtn, `${mode}: Autoscale shares the contextual group`);
    assert.equal(toolbar.querySelectorAll('.panel-autoscale-btn').length, 1, `${mode}: toolbar has one Autoscale action`);
    assert.equal(tools.children[0], autoscaleBtn, `${mode}: Autoscale is the first contextual action`);
    // The whole time-series family adds per-axis Fit X / Fit Y right after the
    // fit-both Autoscale (the analysis modes fit their analysis pane). Heatmap is
    // the exception: its vertical axis is a fixed categorical axis, so it gets
    // Fit X only.
    const axisFitBtns = tools.querySelectorAll('.panel-autoscale-axis-btn');
    if (mode === 'heatmap') {
        assert.equal(axisFitBtns.length, 1, `${mode}: heatmap gets Fit X only (fixed categorical Y)`);
        assert.equal(tools.children[1], axisFitBtns[0], `${mode}: Fit X follows Autoscale`);
        assert.equal(tools.children[2], marksBtn, `${mode}: Marks follows the single per-axis fit`);
    } else {
        assert.equal(axisFitBtns.length, 2, `${mode}: Fit X and Fit Y sit next to Autoscale`);
        assert.equal(tools.children[1], axisFitBtns[0], `${mode}: Fit X follows Autoscale`);
        assert.equal(tools.children[2], axisFitBtns[1], `${mode}: Fit Y follows Fit X`);
        assert.equal(tools.children[3], marksBtn, `${mode}: Marks follows the per-axis fits`);
    }
    // View (log axes, Stack, Y2, line shape) sits right after Marks.
    const viewBtn = tools.querySelector('.panel-view-btn');
    assert.ok(viewBtn, `${mode}: the View dropdown shares the contextual group`);
    assert.equal(tools.children[tools.children.indexOf(marksBtn) + 1], viewBtn, `${mode}: View follows Marks`);
    assert.equal(viewBtn.getAttribute('aria-haspopup'), 'menu', `${mode}: View announces its popup`);
    assert.equal(viewBtn.textContent, 'viewMenuLabel ▾', `${mode}: nothing on, no count`);
    assert.equal(viewBtn.disabled, !['timeseries', 'histogram'].includes(mode),
        `${mode}: View is enabled where it has something to offer`);
    assert.equal(autoscaleBtn.textContent, globalAutoscaleIcon, `${mode}: contextual Autoscale reuses the global icon`);
    autoscaleBtn.click();
    assert.equal(manager.autoscaleCalls.length, 1, `${mode}: contextual Autoscale triggers one autoscale`);
    assert.equal(manager.autoscaleCalls[0].panelId, 'panel', `${mode}: contextual Autoscale targets its panel`);
    assert.equal(manager.autoscaleCalls[0].plot, manager.plot, `${mode}: contextual Autoscale passes the current plot`);
    // Stack, Y2, NaN/Inf, Gaps, Samples and Repeated moved into the Marks menu.
    assert.ok(marksBtn, `${mode}: the Marks dropdown shares the contextual group`);
    for (const gone of ['.timeseries-stack-btn', '.timeseries-y2-btn', '.timeseries-missing-btn', '.timeseries-samples-btn', '.timeseries-repeated-btn']) {
        assert.equal(toolbar.querySelector(gone), null, `${mode}: ${gone} is no longer a toolbar button`);
    }
    assert.equal(marksBtn.getAttribute('aria-haspopup'), 'menu', `${mode}: Marks announces its popup`);
    assert.equal(marksBtn.textContent, 'marksMenuLabel ▾', `${mode}: nothing on, no count`);
    assert.equal(marksBtn.classList.contains('active'), false, `${mode}: nothing on, not active`);
    assert.equal(marksBtn.disabled, mode !== 'timeseries', `${mode}: Marks is for the time-series view`);

    // Fourier, Histogram, Heatmap, Profile and Integral: one Analysis dropdown
    // after View, whose button names the analysis that is on.
    assert.equal(tools.querySelectorAll('.timeseries-analysis-btn').length, 0, `${mode}: no separate analysis buttons`);
    const analysisBtn = tools.querySelector('.timeseries-analysis-menu-btn');
    assert.ok(analysisBtn, `${mode}: the Analysis dropdown shares the contextual group`);
    assert.equal(tools.children[tools.children.indexOf(tools.querySelector('.panel-view-btn')) + 1], analysisBtn, `${mode}: Analysis follows View`);
    assert.equal(tools.children[tools.children.length - 1], analysisBtn, `${mode}: and closes the group`);
    assert.equal(analysisBtn.getAttribute('aria-haspopup'), 'menu', `${mode}: Analysis announces its popup`);
    const on = mode !== 'timeseries';
    assert.equal(analysisBtn.classList.contains('active'), on, `${mode}: pressed while an analysis is on`);
    assert.equal(analysisBtn.getAttribute('aria-pressed'), String(on), `${mode}: and says so`);
    assert.equal(analysisBtn.dataset.mode, mode, `${mode}: the button knows which analysis is on`);
    const expectedLabel = {
        timeseries: 'analysisMenuLabel', fft: 'Fourier', histogram: 'analysisItemHistogram',
        heatmap: 'modeHeatmapLabel', 'temporal-profile': 'temporalProfileModeLabel', integral: 'integralModeLabel',
    }[mode];
    assert.equal(analysisBtn.textContent, `${expectedLabel} ▾`, `${mode}: the button names it`);
    const menu = renderAnalysisMenu(manager);
    const items = menu.querySelectorAll('.marks-menu-item');
    assert.deepEqual(items.map(item => item.dataset.mark),
        ['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile', 'integral'],
        `${mode}: None, then every analysis of the family`);
    for (const item of items) {
        assert.equal(item.getAttribute('role'), 'menuitemradio', `${mode}: ${item.dataset.mark} is a radio item`);
        assert.equal(item.getAttribute('aria-checked'), String(item.dataset.mark === mode), `${mode}: ${item.dataset.mark} checked only when on`);
    }
}

// The Marks menu: every toggle of the time-series panel, checked from the plot
// state, with a count on the button so a closed menu still says something is on.
{
    const { manager, toolbar } = renderToolbar('timeseries', 2, {
        timeseriesStacked: true,
        timeseriesY2Enabled: true,
        showNaN: true,
        showGaps: true,
        showSamples: true,
        showRepeated: true,
    });
    const button = toolbar.querySelector('.timeseries-marks-btn');
    assert.equal(button.textContent, 'marksMenuLabel (4) ▾', 'the button counts the marks that are on');
    assert.ok(button.classList.contains('active'), 'and reads as active');
    const menu = renderMarksMenu(manager);
    const keys = menu.querySelectorAll('.marks-menu-item').map(item => item.dataset.mark);
    assert.deepEqual(keys, ['nan', 'gaps', 'repeated', 'samples'],
        'Marks holds what is drawn on the data: NaN/Inf, Gaps, Repeated, Samples');
    for (const key of keys) {
        const item = marksItem(menu, key);
        assert.equal(item.getAttribute('role'), 'menuitemcheckbox', `${key}: a checkbox item`);
        assert.equal(item.getAttribute('aria-checked'), 'true', `${key}: enabled option renders checked`);
        assert.ok(item.classList.contains('checked'), `${key}: and styled so`);
    }
    assert.equal(menu.querySelectorAll('.marks-menu-divider').length, 0, 'one group');
    assert.equal(menu.querySelector('.marks-menu-radio'), null, 'the line shape moved to View');
    assert.ok(menu.querySelector('.marks-menu-settings'), 'Gaps carries its settings button');

    const viewButton = toolbar.querySelector('.panel-view-btn');
    assert.equal(viewButton.textContent, 'viewMenuLabel (2) ▾', 'View counts Stack and Y2');
    const view = renderViewMenu(manager);
    assert.deepEqual(view.querySelectorAll('.marks-menu-item').map(item => item.dataset.mark),
        ['lastview', 'ylog', 'y2log', 'stack', 'y2'], 'View: Last view, log Y, log Y2, then Stack and Y2');
    const lastView = marksItem(view, 'lastview');
    assert.equal(lastView.getAttribute('role'), 'menuitem', 'Last view is an action, not a checkbox');
    assert.equal(lastView.disabled, true, 'Last view waits for a zoom/pan to go back from');
    assert.match(lastView.querySelector('.marks-menu-shortcut')?.textContent || '', /Ctrl\+Z|⌘Z/, 'Last view shows its keyboard shortcut');
    assert.equal(marksItem(view, 'stack').getAttribute('aria-checked'), 'true', 'Stack renders checked');
    assert.equal(marksItem(view, 'y2').getAttribute('aria-checked'), 'true', 'Y2 renders checked');
    assert.equal(marksItem(view, 'y2log').disabled, false, 'log Y2 is available with the right axis on');
    assert.equal(view.querySelectorAll('.marks-menu-divider').length, 3, 'last view, log scales, layout, line shape');
}
{
    const { manager } = renderToolbar('timeseries', 2, {});
    const menu = renderMarksMenu(manager);
    for (const key of ['nan', 'gaps', 'repeated', 'samples']) {
        assert.equal(marksItem(menu, key).getAttribute('aria-checked'), 'false', `${key}: off by default`);
    }
    const view = renderViewMenu(manager);
    for (const key of ['ylog', 'y2log', 'stack', 'y2']) {
        assert.equal(marksItem(view, key).getAttribute('aria-checked'), 'false', `${key}: off by default`);
    }
    assert.equal(marksItem(view, 'y2log').disabled, true, 'log Y2 waits for the right axis');
    assert.equal(marksItem(view, 'y2log').title, 'viewLogY2Off', 'and says so');
    // Clicking an item runs its toggle; the menu stays (it is re-rendered from
    // the state by the toggle, see _syncMarksControls).
    const calls = [];
    for (const name of ['_toggleNaN', '_toggleGaps', '_toggleRepeated', '_toggleSamples', '_toggleTimeseriesStack', '_toggleTimeseriesY2', '_toggleTimeseriesLogAxis']) {
        manager[name] = (panelId, arg) => calls.push([name, panelId, arg]);
    }
    for (const key of ['nan', 'gaps', 'repeated', 'samples']) marksItem(menu, key).click();
    for (const key of ['ylog', 'stack', 'y2']) marksItem(view, key).click();
    assert.deepEqual(calls.map(([name]) => name),
        ['_toggleNaN', '_toggleGaps', '_toggleRepeated', '_toggleSamples', '_toggleTimeseriesLogAxis', '_toggleTimeseriesStack', '_toggleTimeseriesY2'],
        'each item runs its own toggle');
    assert.ok(calls.every(([, panelId]) => panelId === 'panel'), 'on its panel');
    assert.equal(calls[4][2], 'y', 'log Y toggles the primary axis');
}
{
    const { manager, toolbar } = renderToolbar('timeseries', 2, { timeseriesY2Enabled: true, timeseriesYLog: true, timeseriesY2Log: true });
    assert.equal(toolbar.querySelector('.panel-view-btn').textContent, 'viewMenuLabel (3) ▾', 'log Y, log Y2 and Y2 count');
    const view = renderViewMenu(manager);
    assert.equal(marksItem(view, 'ylog').getAttribute('aria-checked'), 'true', 'log Y renders checked');
    assert.equal(marksItem(view, 'stack').title, 'timeseriesStackLogTitle',
        'on a log axis, Stack says its bands no longer read as their signals');
    assert.equal(marksItem(view, 'y2log').getAttribute('aria-checked'), 'true', 'log Y2 renders checked');
}

// View in the analysis modes: what each has to offer. Fourier's log frequency
// sits in its own options panel, beside the X axis reading, not here.
{
    const { manager, toolbar } = renderToolbar('fft', 2, {});
    manager.plot.fft = { xAxisMode: 'frequency', freqLog: true };
    assert.equal(renderViewMenu(manager).querySelectorAll('.marks-menu-item').length, 0, 'Fourier: nothing in View');
    assert.equal(toolbar.querySelector('.panel-view-btn').disabled, true, 'so its View button is disabled');
}
{
    const { manager } = renderToolbar('histogram', 2, {});
    manager.plot.histogram = { yScale: 'log' };
    const view = renderViewMenu(manager);
    assert.deepEqual(view.querySelectorAll('.marks-menu-item').map(item => item.dataset.mark), ['countlog'], 'Histogram: log counts');
    assert.equal(marksItem(view, 'countlog').getAttribute('aria-checked'), 'true');
}
{
    const { manager, toolbar } = renderToolbar('phase2d', 2, { phase2dYLog: true });
    const viewBtn = toolbar.querySelector('.view-btn-group').querySelector('.panel-view-btn');
    assert.ok(viewBtn, '2D: View sits in the view group');
    assert.equal(viewBtn.textContent, 'viewMenuLabel (1) ▾');
    const view = renderViewMenu(manager);
    assert.deepEqual(view.querySelectorAll('.marks-menu-item').map(item => item.dataset.mark), ['lastview', 'aspect', 'xlog', 'ylog'], '2D: Last view, 1:1, log X and log Y');
    const calls = [];
    manager._togglePhase2dLogAxis = (panelId, axis) => calls.push(axis);
    marksItem(view, 'xlog').click();
    marksItem(view, 'ylog').click();
    assert.deepEqual(calls, ['x', 'y'], 'each toggles its own axis');
}
{
    // Correlation's axes are fixed by what it shows (r from -1 to 1, pairs).
    const { toolbar } = renderToolbar('correlation');
    assert.equal(toolbar.querySelector('.panel-view-btn'), null, 'correlation: no View menu');
}

// Line shape: a panel-level radio derived from the traces' overrides.
{
    const { manager } = renderToolbar('timeseries', 2, {});
    const radios = (plotTraces) => {
        manager.plot.traces = plotTraces;
        const menu = renderViewMenu(manager);
        return menu.querySelectorAll('.marks-menu-radio')
            .filter(r => r.getAttribute('aria-checked') === 'true')
            .map(r => r.className.match(/marks-line-(\w+)/)[1]);
    };
    assert.deepEqual(radios([{ varName: 'a' }, { varName: 'b' }]), ['auto'], 'no overrides: Auto');
    assert.deepEqual(radios([{ lineShape: 'hv' }, { lineShape: 'hv' }]), ['hv'], 'all stairs: Stairs');
    assert.deepEqual(radios([{ lineShape: 'linear' }]), ['linear'], 'all linear: Linear');
    assert.deepEqual(radios([{ lineShape: 'hv' }, {}]), [], 'mixed overrides: none checked');
    const calls = [];
    manager._setPanelLineShape = (panelId, shape) => calls.push(shape);
    manager.plot.traces = [];
    const menu = renderViewMenu(manager);
    menu.querySelectorAll('.marks-menu-radio').forEach(r => r.click());
    assert.deepEqual(calls, ['auto', 'linear', 'hv'], 'each radio sets its shape');
}

// Repeated: disabled when no file on the panel repeats an instant (the item
// answers "are there any?"), waiting when only memory-saving files could hold them.
{
    const { manager } = renderToolbar('timeseries', 2, { _testRepeatedAvailability: 'none' });
    const item = marksItem(renderMarksMenu(manager), 'repeated');
    assert.equal(item.disabled, true, 'no repeats anywhere: Repeated is disabled');
    assert.equal(item.title, 'timeseriesRepeatedNone', 'and says why');
}
{
    const { manager } = renderToolbar('timeseries', 2, { showRepeated: true, _testRepeatedAvailability: 'lazy' });
    const item = marksItem(renderMarksMenu(manager), 'repeated');
    assert.equal(item.disabled, false, 'a memory-saving file does not disable it');
    assert.ok(item.classList.contains('marks-waiting'), 'but it waits');
    assert.equal(item.title, 'timeseriesRepeatedLazy');
}
{
    const { manager } = renderToolbar('timeseries', 2, { showRepeated: true, _repeatedWaiting: null });
    const item = marksItem(renderMarksMenu(manager), 'repeated');
    assert.equal(item.classList.contains('marks-waiting'), false, 'marks on screen: not waiting');
    assert.equal(item.title, 'timeseriesRepeatedToggle');
}

// Samples switched on with nothing on screen to dot: the item stays checked
// but reads as waiting, and its tooltip says why — no pill over the plot.
{
    const { manager } = renderToolbar('timeseries', 2, { showSamples: true, _samplesWaiting: 'zoom' });
    const item = marksItem(renderMarksMenu(manager), 'samples');
    assert.equal(item.getAttribute('aria-checked'), 'true', 'waiting Samples is still checked');
    assert.ok(item.classList.contains('marks-waiting'), 'and marked as waiting');
    assert.equal(item.title, 'timeseriesSamplesZoomIn', 'its tooltip asks to zoom in');
}
{
    const { manager } = renderToolbar('timeseries', 2, { showSamples: true, _samplesWaiting: 'lazy' });
    assert.equal(marksItem(renderMarksMenu(manager), 'samples').title, 'timeseriesSamplesLazy',
        'a memory-saving file gets its own reason');
}
{
    const { manager } = renderToolbar('timeseries', 2, { showSamples: true, _samplesWaiting: null });
    const item = marksItem(renderMarksMenu(manager), 'samples');
    assert.equal(item.classList.contains('marks-waiting'), false, 'dots on screen: not waiting');
    assert.equal(item.title, 'timeseriesSamplesToggle');
}
{
    const { manager } = renderToolbar('timeseries', 2, { showSamples: false, _samplesWaiting: 'zoom' });
    assert.equal(marksItem(renderMarksMenu(manager), 'samples').classList.contains('marks-waiting'), false,
        'switched off: never waiting, whatever was left behind');
}
{
    const { manager } = renderToolbar('timeseries', 2, { timeseriesStacked: true });
    assert.equal(marksItem(renderMarksMenu(manager), 'samples').disabled, true,
        'stacked: Samples is disabled (a dot would not be the sample)');
}

{
    const { toolbar } = renderToolbar('phase2d');
    assert.equal(toolbar.querySelector('.timeseries-tools-group'), null, 'non-time-series plots hide the contextual options group');
    assert.equal(toolbar.querySelector('.timeseries-analysis-menu-btn'), null, 'non-time-series plots do not expose the Analysis menu (Fourier, Histogram, Heatmap, Profile, Integral)');
}

// Phase/state views use the same contextual Autoscale action, first in the
// view group. How the view reads the data (2D display, 1:1, log axes; 3D
// projection, cameras, rotations) is in the View menu after it, not in
// buttons of its own.
for (const { mode, stateAnimDim = 2 } of [
    { mode: 'phase2d' },
    { mode: 'phase2dt' },
    { mode: 'phase3d' },
    { mode: 'state-anim', stateAnimDim: 2 },
    { mode: 'state-anim', stateAnimDim: 3 },
]) {
    const label = mode === 'state-anim' ? `${mode}-${stateAnimDim}d` : mode;
    const { manager, toolbar } = renderToolbar(mode, stateAnimDim);
    const viewGroup = toolbar.querySelector('.view-btn-group');
    assert.ok(viewGroup, `${label}: contextual view group is present`);
    if (mode !== 'state-anim') {
        assert.notEqual(viewGroup.style.display, 'none', `${label}: contextual view group is visible`);
    }
    const autoscaleBtn = viewGroup.querySelector('.panel-autoscale-btn');
    assert.ok(autoscaleBtn, `${label}: contextual Autoscale is present`);
    assert.equal(toolbar.querySelectorAll('.panel-autoscale-btn').length, 1, `${label}: toolbar has one Autoscale action`);
    assert.equal(viewGroup.children[0], autoscaleBtn, `${label}: Autoscale is the first contextual view action`);
    assert.equal(autoscaleBtn.textContent, globalAutoscaleIcon, `${label}: Autoscale reuses the global icon`);
    assert.notEqual(autoscaleBtn.textContent, '⌂', `${label}: legacy home glyph is not used`);

    // Only 2D scatter (phase2d) gets the per-axis Fit X / Fit Y buttons.
    const viewAxisFitBtns = viewGroup.querySelectorAll('.panel-autoscale-axis-btn');
    if (mode === 'phase2d') {
        assert.equal(viewAxisFitBtns.length, 2, `${label}: 2D scatter adds Fit X / Fit Y after Autoscale`);
        assert.equal(viewGroup.children[1], viewAxisFitBtns[0], `${label}: Fit X follows Autoscale`);
        assert.equal(viewGroup.children[2], viewAxisFitBtns[1], `${label}: Fit Y follows Fit X`);
    } else {
        assert.equal(viewAxisFitBtns.length, 0, `${label}: per-axis Fit buttons are 2D-scatter only`);
    }
    for (const gone of ['.equal-aspect-btn', '.proj-btn', '.rot-btn', '.view-btn-3d-only', '.phase2d-display-select', '.phase2d-marker-controls']) {
        assert.equal(toolbar.querySelector(gone), null, `${label}: ${gone} moved into the View menu`);
    }
    const viewBtn = viewGroup.querySelector('.panel-view-btn');
    assert.ok(viewBtn, `${label}: View sits in the view group`);
    assert.equal(viewGroup.children[viewGroup.children.length - 1], viewBtn, `${label}: after Autoscale (and the fits)`);

    autoscaleBtn.click();
    assert.equal(manager.autoscaleCalls.length, 1, `${label}: contextual Autoscale triggers one autoscale`);
    assert.equal(manager.autoscaleCalls[0].plot, manager.plot, `${label}: contextual Autoscale targets the current plot`);
}

// 2D View: display, marker settings while points are drawn, 1:1, log axes.
{
    const { manager } = renderToolbar('phase2d', 2, { equalAspect2D: true });
    let view = renderViewMenu(manager);
    const checked = (menu, cls) => menu.querySelectorAll(cls)
        .filter(el => el.getAttribute('aria-checked') === 'true').map(el => el.className);
    assert.deepEqual(checked(view, '.marks-menu-radio'), ['marks-menu-radio marks-display-lines checked'], 'Lines is the default display');
    assert.equal(view.querySelector('.marks-menu-number'), null, 'lines only: no marker settings');
    assert.equal(marksItem(view, 'aspect').getAttribute('aria-checked'), 'true', '1:1 renders checked');
    assert.deepEqual(view.querySelectorAll('.marks-menu-item').map(item => item.dataset.mark), ['lastview', 'aspect', 'xlog', 'ylog']);
    const calls = [];
    manager._setPhase2dDisplayMode = (panelId, value) => calls.push(['display', value]);
    manager._toggleEqualAspect2D = (panelId) => calls.push(['aspect', panelId]);
    view.querySelector('.marks-display-markers').click();
    marksItem(view, 'aspect').click();
    assert.deepEqual(calls, [['display', 'markers'], ['aspect', 'panel']], 'each control runs its own setter');

    manager.plot.phase2d.displayMode = 'lines+markers';
    view = renderViewMenu(manager);
    const numbers = view.querySelectorAll('.marks-menu-number');
    assert.equal(numbers.length, 2, 'points drawn: size and opacity');
    assert.equal(numbers[0].value, '4', 'size from the state');
    manager._setPhase2dMarkerSetting = (panelId, key, value) => calls.push([key, value]);
    numbers[1].value = '0.4';
    for (const handler of numbers[1].listeners.get('change') || []) handler({});
    assert.deepEqual(calls.at(-1), ['markerOpacity', '0.4'], 'opacity applies on change');

    manager.plot.phase2dYLog = true;
    view = renderViewMenu(manager);
    assert.equal(marksItem(view, 'aspect').disabled, true, 'mixed log / linear: 1:1 unavailable');
    assert.equal(marksItem(view, 'aspect').title, 'equalAspect2DMixedLog', 'and says why');
}
// 2D state animation: 1:1 only.
{
    const { manager } = renderToolbar('state-anim', 2, {});
    assert.deepEqual(renderViewMenu(manager).querySelectorAll('.marks-menu-item').map(item => item.dataset.mark), ['aspect']);
}
// 3D: projection, cameras, rotations.
for (const [mode, dim, cameras] of [['phase3d', 2, ['XY', 'XZ', 'YZ']], ['phase2dt', 2, ['x vs t', 'y vs t', 'y vs x']], ['state-anim', 3, ['XY', 'XZ', 'YZ']]]) {
    const { manager } = renderToolbar(mode, dim, { projection: 'orthographic' });
    const view = renderViewMenu(manager);
    assert.ok(view.querySelector('.marks-proj-orthographic').classList.contains('checked'), `${mode}: Iso checked`);
    assert.deepEqual(view.querySelectorAll('.marks-menu-action').map(b => b.textContent), [...cameras, '⟳Z', '⟳X', '⟳Y'], `${mode}: cameras and rotations`);
    const calls = [];
    manager._setCamera = (panelId, preset) => calls.push(['camera', preset]);
    manager._animateRotation = (panelId, axis) => calls.push(['rotate', axis]);
    manager._toggleProjection = (panelId) => calls.push(['projection', panelId]);
    view.querySelector('.marks-action-camera-front').click();
    view.querySelector('.marks-action-rotate-x').click();
    view.querySelector('.marks-proj-orthographic').click();
    view.querySelector('.marks-proj-perspective').click();
    assert.deepEqual(calls, [['camera', 'front'], ['rotate', 'x'], ['projection', 'panel']],
        `${mode}: cameras and rotations act; projection toggles only when it changes`);
}

// Chart creation calls _refreshActionBtns after injecting the toolbar. Keep
// that later refresh from deleting the contextual group in Fourier/Histogram/Heatmap.
{
    const refreshStart = plotManagerSource.indexOf('    _refreshActionBtns(panelId) {');
    const refreshEnd = plotManagerSource.indexOf('\n    _exportCSV(', refreshStart + 1);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'toolbar action refresher is present');
    const refreshSource = plotManagerSource.slice(refreshStart, refreshEnd);
    assert.match(
        refreshSource,
        /\['timeseries',\s*'fft',\s*'histogram',\s*'heatmap',\s*'temporal-profile',\s*'integral'\]\.includes\(plot\?\.mode\)/,
        'toolbar refresh recognizes every member of the time-series family',
    );
    assert.match(
        refreshSource,
        /if \(!isTimeseriesFamily\)\s*\{\s*panelEl\.querySelector\('\.timeseries-tools-group'\)\?\.remove\(\);\s*\}/,
        'toolbar refresh removes contextual options only outside the time-series family',
    );
    assert.match(
        refreshSource,
        /_applyAnalysisButtonState\?\.\(plot, panelEl\.querySelector\('\.timeseries-analysis-menu-btn'\)\)/,
        'toolbar refresh keeps the Analysis button (which analysis is on) synchronized after redraws',
    );
    assert.match(
        refreshSource,
        /this\._syncMarksControls\?\.\(panelId\)/,
        'toolbar refresh keeps the Marks and View menus (1:1 among them) synchronized after redraws',
    );
}

{
    const equalAspectToggleSource = methodAssignment('_toggleEqualAspect2D');
    assert.match(
        equalAspectToggleSource,
        /plot\.equalAspect2D = !plot\.equalAspect2D;[\s\S]*?this\._syncMarksControls\?\.\(panelId\)/,
        'clicking 1:1 re-renders the View menu and its count from the new state',
    );
}

// Picking the analysis that is on (or None) returns to the original
// time-series view. Another analysis switches directly, and every family
// transition keeps using the established preserveTimeTraces path.
for (const [from, clicked, expected] of [
    ['timeseries', 'fft', 'fft'],
    ['timeseries', 'histogram', 'histogram'],
    ['timeseries', 'heatmap', 'heatmap'],
    ['timeseries', 'temporal-profile', 'temporal-profile'],
    ['fft', 'fft', 'timeseries'],
    ['histogram', 'histogram', 'timeseries'],
    ['heatmap', 'heatmap', 'timeseries'],
    ['temporal-profile', 'temporal-profile', 'timeseries'],
    ['fft', 'histogram', 'histogram'],
    ['histogram', 'fft', 'fft'],
    ['fft', 'heatmap', 'heatmap'],
    ['histogram', 'heatmap', 'heatmap'],
    ['heatmap', 'fft', 'fft'],
    ['heatmap', 'histogram', 'histogram'],
    ['histogram', 'temporal-profile', 'temporal-profile'],
    ['temporal-profile', 'fft', 'fft'],
    ['timeseries', 'integral', 'integral'],
    ['integral', 'integral', 'timeseries'],
    ['integral', 'temporal-profile', 'temporal-profile'],
    ['temporal-profile', 'integral', 'integral'],
    ['fft', 'integral', 'integral'],
    ['fft', 'timeseries', 'timeseries'],
    ['heatmap', 'timeseries', 'timeseries'],
]) {
    const { manager, toolbar } = renderToolbar(from);
    const fftConfig = manager.plot.fft;
    const histogramConfig = manager.plot.histogram;
    const heatmapConfig = manager.plot.heatmap;
    const temporalProfileConfig = manager.plot.temporalProfile;
    pickAnalysis(manager, clicked);
    assert.equal(manager.modeChanges.length, 1, `${from} -> ${clicked}: exactly one mode change is requested`);
    assert.equal(manager.modeChanges[0].mode, expected, `${from} -> ${clicked}: resolves to ${expected}`);
    assert.equal(
        manager.modeChanges[0].options?.preserveTimeTraces,
        true,
        `${from} -> ${clicked}: transition uses the existing configuration-preserving architecture`,
    );
    assert.equal(manager.plot.fft, fftConfig, `${from} -> ${clicked}: Fourier config object is retained`);
    assert.equal(manager.plot.histogram, histogramConfig, `${from} -> ${clicked}: Histogram config object is retained`);
    assert.equal(manager.plot.heatmap, heatmapConfig, `${from} -> ${clicked}: Heatmap config object is retained`);
    assert.equal(manager.plot.temporalProfile, temporalProfileConfig, `${from} -> ${clicked}: Temporal Profile config object is retained`);
    assert.equal(manager.warnings.length, 0, `${from} -> ${clicked}: family transition needs no destructive-change warning`);
}

{
    const setModeStart = plotManagerSource.indexOf('    _setMode(panelId, mode');
    const setModeEnd = plotManagerSource.indexOf('\n    _bindDropHandlers(', setModeStart + 1);
    assert.ok(setModeStart >= 0 && setModeEnd > setModeStart, 'central mode-switch implementation is present');
    const setModeSource = plotManagerSource.slice(setModeStart, setModeEnd);
    assert.match(setModeSource, /plot\.fft\s*=\s*plot\.fft\s*\|\|/, 'family mode switches retain an existing Fourier configuration');
    assert.match(setModeSource, /plot\.histogram\s*=\s*plot\.histogram\s*\|\|/, 'family mode switches retain an existing Histogram configuration');
    assert.match(setModeSource, /plot\.heatmap\s*=\s*plot\.heatmap\s*\|\|/, 'family mode switches retain an existing Heatmap configuration');
    assert.match(setModeSource, /plot\.temporalProfile\s*=\s*plot\.temporalProfile\s*\|\|/, 'family mode switches retain an existing Temporal Profile configuration');
}

// The common toolbar action must reach the correct autoscale implementation
// in every time-series-family mode. Histogram has a dedicated non-destructive
// path: it resets the visible axes of both panes without resetting selection,
// bins, ranges, normalization, or other Histogram options.
{
    const autoscaleStart = plotManagerSource.indexOf('    _autoScalePlot(panelId, plot');
    const autoscaleEnd = plotManagerSource.indexOf('\n    _rebuildPanel(', autoscaleStart + 1);
    assert.ok(autoscaleStart >= 0 && autoscaleEnd > autoscaleStart, 'central Autoscale dispatcher is present');
    const autoscaleSource = plotManagerSource.slice(autoscaleStart, autoscaleEnd);
    assert.match(
        autoscaleSource,
        /plot\.mode === 'fft'[\s\S]*?return this\._autoScaleFftPanel\(panelId, plot\)/,
        'central Autoscale dispatches Fourier to its two-pane implementation',
    );
    assert.match(
        autoscaleSource,
        /plot\.mode === 'histogram'[\s\S]*?return this\._autoScaleHistogramPanel\(panelId, plot\)/,
        'central Autoscale dispatches Histogram to its non-destructive two-pane implementation',
    );
    assert.match(
        autoscaleSource,
        /plot\.mode === 'heatmap'[\s\S]*?return this\._autoScaleHeatmapPanel\(panelId, plot\)/,
        'central Autoscale dispatches Heatmap to its two-pane implementation',
    );
    assert.match(
        autoscaleSource,
        /plot\.mode === 'temporal-profile'[\s\S]*?return this\._autoScaleTemporalProfilePanel\(panelId, plot\)/,
        'central Autoscale dispatches Temporal Profile to its two-pane implementation',
    );
    assert.doesNotMatch(
        autoscaleSource,
        /v\.kind\s*===\s*'parameter'/,
        'time-series Autoscale includes visible constant parameters in its Y range',
    );

    const liveViewStart = plotManagerSource.indexOf('    _timeseriesLiveAppendView(plot');
    const liveViewEnd = plotManagerSource.indexOf('\n    _finiteYExtentInXRange(', liveViewStart + 1);
    const liveViewSource = plotManagerSource.slice(liveViewStart, liveViewEnd);
    assert.doesNotMatch(
        liveViewSource,
        /variable\.kind\s*===\s*'parameter'/,
        'live time-series Y expansion includes visible constant parameters',
    );

    const helperStart = histogramMethodsSource.indexOf('proto._autoScaleHistogramPanel = function');
    const helperEnd = histogramMethodsSource.indexOf('\nproto.', helperStart + 1);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Histogram two-pane Autoscale helper is present');
    const helperSource = histogramMethodsSource.slice(helperStart, helperEnd);
    assert.match(helperSource, /this\._autoScalePlotTimeOnly\(plot\)/, 'Histogram Autoscale resets the time-series pane');
    assert.match(
        helperSource,
        /Plotly\.relayout\(plot\.histogramDiv,\s*\{\s*'xaxis\.autorange': true,\s*'yaxis\.autorange': true\s*\}\)/,
        'Histogram Autoscale resets both axes of the bars pane',
    );
    assert.match(helperSource, /Promise\.all\(/, 'Histogram Autoscale waits for both pane updates');
    assert.doesNotMatch(helperSource, /_resetHistogramView/, 'Histogram Autoscale does not reset analysis configuration or selection');

    const heatmapHelperStart = heatmapMethodsSource.indexOf('proto._autoScaleHeatmapPanel = function');
    const heatmapHelperEnd = heatmapMethodsSource.indexOf('\nproto.', heatmapHelperStart + 1);
    assert.ok(heatmapHelperStart >= 0 && heatmapHelperEnd > heatmapHelperStart, 'Heatmap two-pane Autoscale helper is present');
    const heatmapHelperSource = heatmapMethodsSource.slice(heatmapHelperStart, heatmapHelperEnd);
    assert.match(heatmapHelperSource, /this\._autoScalePlotTimeOnly\(plot\)/, 'Heatmap Autoscale resets the time-series pane');
    assert.match(heatmapHelperSource, /Plotly\.relayout\(plot\.heatmapDiv/, 'Heatmap Autoscale resets the calendar pane');

    const profileHelperStart = temporalProfileMethodsSource.indexOf('proto._autoScaleTemporalProfilePanel = function');
    const profileHelperEnd = temporalProfileMethodsSource.indexOf('\nproto.', profileHelperStart + 1);
    assert.ok(profileHelperStart >= 0 && profileHelperEnd > profileHelperStart, 'Temporal Profile two-pane Autoscale helper is present');
    const profileHelperSource = temporalProfileMethodsSource.slice(profileHelperStart, profileHelperEnd);
    assert.match(profileHelperSource, /this\._autoScalePlotTimeOnly\(plot\)/, 'Temporal Profile Autoscale resets the time-series pane');
    assert.match(profileHelperSource, /this\._resetTemporalProfileAnalysisView\(plot\)/, 'Temporal Profile Autoscale safely resets the folded profile pane');
}

// Moving a legend trace between Y axes is normally an in-place Plotly update.
// Turning off the last right-axis trace rebuilds once with a captured view so
// Plotly's autoscale state is reset cleanly.
{
    const contextMenuCss = cssRuleBody('.timeseries-axis-menu');
    assert.match(contextMenuCss, /grid-template-columns\s*:\s*max-content\b/,
        'legend context menu sizes itself from the active-language labels');
    assert.match(contextMenuCss, /max-width\s*:\s*calc\(100vw\s*-\s*16px\)/,
        'legend context menu stays within narrow viewports');

    const legendClickStart = plotManagerSource.indexOf("div.on('plotly_legendclick'");
    const legendClickEnd = plotManagerSource.indexOf("div.on('plotly_legenddoubleclick'", legendClickStart);
    const legendClickSource = plotManagerSource.slice(legendClickStart, legendClickEnd);
    assert.match(legendClickSource, /ed\.event\?\.button[^\n]*!== 0/,
        'right-clicking a legend item is ignored by the visibility handler');

    const menuStart = plotManagerSource.indexOf('_showTimeseriesAxisMenu(');
    const menuEnd = plotManagerSource.indexOf('\n    async _setTimeseriesLegendSelection', menuStart);
    const menuSource = plotManagerSource.slice(menuStart, menuEnd);
    assert.doesNotMatch(menuSource, /if \(plot\.timeseriesY2Enabled\)/,
        'the move-to-Y-axis action is always present in the legend menu');

    const moveStart = plotManagerSource.indexOf('async _moveTimeseriesTraceToAxis');
    const moveEnd = plotManagerSource.indexOf('\n    _destroyChart(', moveStart);
    assert.ok(moveStart >= 0 && moveEnd > moveStart, 'in-place Y-axis move helper is present');
    const moveSource = plotManagerSource.slice(moveStart, moveEnd);
    assert.match(moveSource, /Plotly\.restyle\(plot\.div,\s*\{\s*yaxis:\s*axis\s*\}/,
        'legend Y-axis move restyles the existing trace');
    assert.match(moveSource, /_expandTimeseriesYAxisForAddedTrace\(plot, builtTrace, axis\)/,
        'legend Y-axis move expands only the destination Y range when needed');
    assert.match(moveSource, /axis === 'y' && !y2StillUsed[\s\S]*?_rebuildPanel\(panelId, \{ restoreView \}\)/,
        'moving the last right-axis trace back rebuilds once with a captured view');
    assert.doesNotMatch(moveSource, /xaxis\./,
        'legend Y-axis move never relayouts the X axis');
    assert.match(moveSource, /plot\.timeseriesY2Enabled = true/,
        'moving to the right Y axis enables dual-axis mode');
    assert.match(moveSource, /this\._refreshActionBtns\(panelId\)/,
        'moving to the right Y axis activates its toolbar button');

    for (const key of ['legendMenuHideTrace', 'legendMenuSelectOnlyTrace', 'legendMenuRemoveTrace']) {
        assert.equal([...translationsSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4,
            `${key} is translated in every supported language`);
    }
}

// The contextual option family needs a clearly visible divider from the
// primary plot modes; the previous one-pixel shared border was too subtle.
{
    const modeSeparatorBlock = cssRuleBody('.mode-btn-group');
    assert.match(modeSeparatorBlock, /border-left\s*:\s*3px\s+solid\b/, 'plot modes have a pronounced divider from panel arrows');
    assert.match(modeSeparatorBlock, /color-mix\([^)]*var\(--success-color\)/, 'plot-mode divider uses the theme-aware success color');

    const separatorBlock = [...contentCss.matchAll(/([^{}]*\.timeseries-tools-group[^{}]*)\{([^{}]*)\}/g)]
        .map(match => match[2])
        .find(body => /border-left\s*:/.test(body));
    assert.ok(separatorBlock, 'time-series contextual group defines an explicit divider');
    assert.match(separatorBlock, /border-left\s*:\s*3px\s+solid\b/, 'contextual divider is a pronounced 3px line');
    assert.match(separatorBlock, /color-mix\([^)]*var\(--primary-color\)/, 'contextual divider uses a visible primary-color mix');

    const viewSeparatorBlock = [...contentCss.matchAll(/([^{}]*\.view-btn-group[^{}]*)\{([^{}]*)\}/g)]
        .map(match => match[2])
        .find(body => /border-left\s*:/.test(body));
    assert.ok(viewSeparatorBlock, 'phase/state contextual view group defines an explicit divider');
    assert.match(viewSeparatorBlock, /border-left\s*:\s*3px\s+solid\b/, 'phase/state divider is a pronounced 3px line');
    assert.match(viewSeparatorBlock, /color-mix\([^)]*var\(--primary-color\)/, 'phase/state divider uses the same visible primary-color mix');
}

// Stack, Y2, Fourier, Histogram and 1:1 intentionally look like toggles:
// released is a normal outlined button, while pressed uses the softer accent
// treatment already established by Show options / Hide time-series. Keep the
// toolbar labels regular-weight even though the internal FFT buttons are bold.
{
    const baseToggleCss = cssRuleBody('.panel-toggle-btn');
    assert.match(baseToggleCss, /font-weight\s*:\s*(?:400|normal)\b/, 'shared toggle labels are not bold');

    const hoverToggleCss = cssRuleBody('.panel-toggle-btn:hover:not(:disabled)');
    assert.match(
        hoverToggleCss,
        /background(?:-color)?\s*:\s*color-mix\([^)]*var\(--primary-color\)/,
        'toggle hover uses a soft primary tint',
    );
    assert.doesNotMatch(
        hoverToggleCss,
        /background(?:-color)?\s*:\s*var\(--primary-color\)\s*;/,
        'toggle hover does not become a solid primary fill',
    );

    const activeToggleCss = cssRuleBody('.panel-toggle-btn.active');
    assert.match(
        activeToggleCss,
        /background(?:-color)?\s*:\s*color-mix\([^)]*var\(--primary-color\)/,
        'pressed toggles use a soft primary tint',
    );
    assert.match(activeToggleCss, /border-color\s*:\s*var\(--primary-color\)/, 'pressed toggles use a primary border');
    assert.match(activeToggleCss, /color\s*:\s*var\(--primary-color\)/, 'pressed toggles use primary text');
    assert.doesNotMatch(
        activeToggleCss,
        /font-weight\s*:\s*(?:[6-9]00|bold(?:er)?)\b/,
        'pressed toggles remain regular-weight',
    );
}

console.log('Mode toolbar tests passed');
