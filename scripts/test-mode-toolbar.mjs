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
const histogramMethodsSource = readFileSync(
    new URL('../src/plots/methods/histogram-methods.js', import.meta.url),
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

const methodAssignment = (name) => {
    const marker = `proto.${name} = function`;
    const start = interactionSource.indexOf(marker);
    assert.ok(start >= 0, `${name} method is present`);
    const next = interactionSource.indexOf('\nproto.', start + marker.length);
    return interactionSource.slice(start, next >= 0 ? next : interactionSource.length);
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
            cursors: { enabled: false },
        };
        this.plots = new Map([['panel', this.plot]]);
    }

    _hasContent() { return true; }
    _is3D(mode) { return mode === 'phase2dt' || mode === 'phase3d'; }
    _isStateAnim3D(plot) { return plot?.mode === 'state-anim' && (plot.stateAnimDim || 2) >= 3; }
    _supportsEqualAspect2D(plot) { return plot?.mode === 'phase2d' || (plot?.mode === 'state-anim' && (plot.stateAnimDim || 2) === 2); }
    _plotSupportsCursors() { return true; }
    _autoScalePlot(panelId, plot) { this.autoscaleCalls.push({ panelId, plot }); }
    _dismissModeChangeWarning() {}
    _showModeChangeWarning(panelId, mode) { this.warnings.push({ panelId, mode }); }
    _setMode(panelId, mode, stateAnimDim, options) {
        this.modeChanges.push({ panelId, mode, stateAnimDim, options });
        this.plot.mode = mode;
    }
}

const sandbox = {
    proto: ToolbarHarness.prototype,
    document: { createElement: tagName => new FakeElement(tagName) },
    i18n: { t: key => key },
};

vm.runInNewContext([
    methodAssignment('_injectModeButtons'),
    methodAssignment('_toggleTimeseriesAnalysisMode'),
    methodAssignment('_requestModeChange'),
].join('\n'), sandbox);

const renderToolbar = (mode, stateAnimDim = 2) => {
    const manager = new ToolbarHarness(mode, stateAnimDim);
    const panel = new FakeElement('section');
    const toolbar = new FakeElement('div');
    toolbar.className = 'layout-panel-toolbar';
    panel.appendChild(toolbar);
    manager._injectModeButtons('panel', panel, mode);
    return { manager, toolbar };
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

// Fourier and Histogram are contextual actions of the time-series family,
// not primary plot types alongside 2D/3D/state animation.
for (const mode of ['timeseries', 'fft', 'histogram']) {
    const { manager, toolbar } = renderToolbar(mode);
    const primaryModes = toolbar
        .querySelector('.mode-btn-group')
        .querySelectorAll('.mode-btn')
        .map(button => button.dataset.mode);
    assert.ok(!primaryModes.includes('fft'), `${mode}: Fourier is absent from the primary plot-mode group`);
    assert.ok(!primaryModes.includes('histogram'), `${mode}: Histogram is absent from the primary plot-mode group`);

    const timeseriesPrimary = findModeButton(toolbar, 'timeseries', 'mode-btn');
    assert.ok(timeseriesPrimary?.classList.contains('active'), `${mode}: time-series family keeps its primary mode pressed`);

    const tools = toolbar.querySelector('.timeseries-tools-group');
    assert.ok(tools, `${mode}: time-series family exposes its contextual options group`);
    const autoscaleBtn = tools.querySelector('.panel-autoscale-btn');
    const stackBtn = tools.querySelector('.timeseries-stack-btn');
    assert.ok(autoscaleBtn, `${mode}: Autoscale shares the contextual group`);
    assert.equal(toolbar.querySelectorAll('.panel-autoscale-btn').length, 1, `${mode}: toolbar has one Autoscale action`);
    assert.equal(tools.children[0], autoscaleBtn, `${mode}: Autoscale is the first contextual action`);
    assert.equal(tools.children[1], stackBtn, `${mode}: Stack appears immediately to the right of Autoscale`);
    assert.equal(autoscaleBtn.textContent, globalAutoscaleIcon, `${mode}: contextual Autoscale reuses the global icon`);
    autoscaleBtn.click();
    assert.equal(manager.autoscaleCalls.length, 1, `${mode}: contextual Autoscale triggers one autoscale`);
    assert.equal(manager.autoscaleCalls[0].panelId, 'panel', `${mode}: contextual Autoscale targets its panel`);
    assert.equal(manager.autoscaleCalls[0].plot, manager.plot, `${mode}: contextual Autoscale passes the current plot`);
    assert.ok(stackBtn, `${mode}: Stack shares the contextual group`);
    assert.ok(tools.querySelector('.timeseries-y2-btn'), `${mode}: Y shares the contextual group`);

    const analysisButtons = tools.querySelectorAll('.timeseries-analysis-btn');
    assert.deepEqual(
        analysisButtons.map(button => button.dataset.mode).sort(),
        ['fft', 'histogram'],
        `${mode}: Fourier and Histogram share the contextual group beside Stack/Y`,
    );
    for (const button of analysisButtons) {
        const expectedPressed = button.dataset.mode === mode;
        assert.equal(
            button.classList.contains('active'),
            expectedPressed,
            `${mode}: ${button.dataset.mode} active class reflects the selected analysis`,
        );
        assert.equal(
            button.getAttribute('aria-pressed'),
            String(expectedPressed),
            `${mode}: ${button.dataset.mode} exposes its sticky state to assistive technology`,
        );
    }
}

{
    const { toolbar } = renderToolbar('phase2d');
    assert.equal(toolbar.querySelector('.timeseries-tools-group'), null, 'non-time-series plots hide the contextual options group');
    assert.equal(findModeButton(toolbar, 'fft'), undefined, 'non-time-series plots do not expose Fourier');
    assert.equal(findModeButton(toolbar, 'histogram'), undefined, 'non-time-series plots do not expose Histogram');
}

// Phase/state views use the same contextual Autoscale action. In 2D it owns
// the first position and 1:1 sits immediately to its right; in 3D/2D+t it
// replaces the old home glyph ahead of the camera presets.
for (const { mode, stateAnimDim = 2, expectsEqualAspect } of [
    { mode: 'phase2d', expectsEqualAspect: true },
    { mode: 'phase2dt', expectsEqualAspect: false },
    { mode: 'phase3d', expectsEqualAspect: false },
    { mode: 'state-anim', stateAnimDim: 2, expectsEqualAspect: true },
    { mode: 'state-anim', stateAnimDim: 3, expectsEqualAspect: false },
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

    const equalAspectBtn = viewGroup.querySelector('.equal-aspect-btn');
    if (expectsEqualAspect) {
        assert.ok(equalAspectBtn, `${label}: 1:1 is available for the 2D view`);
        assert.equal(viewGroup.children[1], equalAspectBtn, `${label}: 1:1 sits immediately to the right of Autoscale`);
        assert.equal(equalAspectBtn.textContent, '1:1', `${label}: equal-aspect label remains unchanged`);
    } else {
        assert.equal(equalAspectBtn, null, `${label}: 3D views do not expose the 2D-only 1:1 action`);
    }

    autoscaleBtn.click();
    assert.equal(manager.autoscaleCalls.length, 1, `${label}: contextual Autoscale triggers one autoscale`);
    assert.equal(manager.autoscaleCalls[0].plot, manager.plot, `${label}: contextual Autoscale targets the current plot`);
}

// Chart creation calls _refreshActionBtns after injecting the toolbar. Keep
// that later refresh from deleting the contextual group in Fourier/Histogram.
{
    const refreshStart = plotManagerSource.indexOf('    _refreshActionBtns(panelId) {');
    const refreshEnd = plotManagerSource.indexOf('\n    _exportCSV(', refreshStart + 1);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'toolbar action refresher is present');
    const refreshSource = plotManagerSource.slice(refreshStart, refreshEnd);
    assert.match(
        refreshSource,
        /\['timeseries',\s*'fft',\s*'histogram'\]\.includes\(plot\?\.mode\)/,
        'toolbar refresh recognizes every member of the time-series family',
    );
    assert.match(
        refreshSource,
        /if \(!isTimeseriesFamily\)\s*\{\s*panelEl\.querySelector\('\.timeseries-tools-group'\)\?\.remove\(\);\s*\}/,
        'toolbar refresh removes contextual options only outside the time-series family',
    );
    assert.match(
        refreshSource,
        /querySelectorAll\('\.timeseries-analysis-btn'\)[\s\S]*?btn\.dataset\.mode === plot\?\.mode[\s\S]*?aria-pressed/,
        'toolbar refresh keeps sticky analysis state synchronized after redraws',
    );
}

// A pressed analysis button returns to the original time-series view. The
// other analysis button switches directly, and every family transition keeps
// using the established preserveTimeTraces path.
for (const [from, clicked, expected] of [
    ['timeseries', 'fft', 'fft'],
    ['timeseries', 'histogram', 'histogram'],
    ['fft', 'fft', 'timeseries'],
    ['histogram', 'histogram', 'timeseries'],
    ['fft', 'histogram', 'histogram'],
    ['histogram', 'fft', 'fft'],
]) {
    const { manager, toolbar } = renderToolbar(from);
    const fftConfig = manager.plot.fft;
    const histogramConfig = manager.plot.histogram;
    findModeButton(toolbar, clicked).click();
    assert.equal(manager.modeChanges.length, 1, `${from} -> ${clicked}: exactly one mode change is requested`);
    assert.equal(manager.modeChanges[0].mode, expected, `${from} -> ${clicked}: resolves to ${expected}`);
    assert.equal(
        manager.modeChanges[0].options?.preserveTimeTraces,
        true,
        `${from} -> ${clicked}: transition uses the existing configuration-preserving architecture`,
    );
    assert.equal(manager.plot.fft, fftConfig, `${from} -> ${clicked}: Fourier config object is retained`);
    assert.equal(manager.plot.histogram, histogramConfig, `${from} -> ${clicked}: Histogram config object is retained`);
    assert.equal(manager.warnings.length, 0, `${from} -> ${clicked}: family transition needs no destructive-change warning`);
}

{
    const setModeStart = plotManagerSource.indexOf('    _setMode(panelId, mode');
    const setModeEnd = plotManagerSource.indexOf('\n    _bindDropHandlers(', setModeStart + 1);
    assert.ok(setModeStart >= 0 && setModeEnd > setModeStart, 'central mode-switch implementation is present');
    const setModeSource = plotManagerSource.slice(setModeStart, setModeEnd);
    assert.match(setModeSource, /plot\.fft\s*=\s*plot\.fft\s*\|\|/, 'family mode switches retain an existing Fourier configuration');
    assert.match(setModeSource, /plot\.histogram\s*=\s*plot\.histogram\s*\|\|/, 'family mode switches retain an existing Histogram configuration');
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
}

// The contextual option family needs a clearly visible divider from the
// primary plot modes; the previous one-pixel shared border was too subtle.
{
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

console.log('Mode toolbar tests passed');
