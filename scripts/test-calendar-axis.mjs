import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';
import { installFileMethods } from '../src/app/methods/file-methods.js';
import {
    getCalendarTimeFormats,
    installPlotDataMethods,
} from '../src/plots/methods/data-methods.js';
import {
    getCalendarDateTickFormat,
    getPlotlyLocale,
    normalizeAppLanguage,
} from '../src/plots/plotly-locale.js';

const FILE_ID = 'calendar-fixture';
const HOURS = [0, 3, 12, 15, 18];
const TIMES = [
    ...HOURS.map(hour => Date.UTC(2025, 0, 1, hour)),
    Date.UTC(2025, 0, 2, 0),
];

class Harness {
    static GL_POINT_THRESHOLD = 50000;

    constructor(calendarTimeFormat = 'ampm', timeVariableFormat = null, language = 'en') {
        this.activeFileId = FILE_ID;
        this.language = language;
        this.hoverProximity = true;
        this.timeseriesVisualMaxPoints = null;
        this.phaseVisualMaxPoints = null;
        this.files = new Map([[FILE_ID, {
            name: 'calendar-fixture.csv',
            transform: {
                timeDisplayMode: 'calendar',
                calendarTimeFormat,
            },
            data: {
                metadata: { timeName: 'time' },
                variables: {
                    time: {
                        name: 'time',
                        kind: 'abscissa',
                        timeKind: 'datetime',
                        timeDisplayMode: 'calendar',
                        calendarTimeFormat: timeVariableFormat,
                        data: TIMES,
                    },
                    signal: {
                        name: 'signal',
                        kind: 'variable',
                        dataType: 'real',
                        description: '[V]',
                        data: TIMES.map((_, index) => index + 1),
                    },
                },
            },
        }]]);
    }

    _getTimeVar(fileId = this.activeFileId) {
        const data = this.files.get(fileId)?.data;
        return data?.variables?.[data.metadata.timeName] ?? null;
    }

    _colors() {
        return {
            bg: '#fff',
            gridColor: '#ccc',
            fontColor: '#111',
            legendBg: '#fff',
        };
    }

    _marginConfig() {
        return { l: 60, r: 15, t: 10, b: 50 };
    }

    _legendConfig() {
        return {};
    }

    _isVisible(trace) {
        return trace?.visible !== false && trace?.visible !== 'legendonly';
    }

    _finiteExtent(arrays) {
        let min = Infinity;
        let max = -Infinity;
        for (const array of arrays || []) {
            for (const raw of array || []) {
                const value = Number(raw);
                if (!Number.isFinite(value)) continue;
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }
        return Number.isFinite(min) ? { min, max } : null;
    }

    _exactRange(min, max) {
        return [min, max];
    }

    _rangeIncluding0(arrays) {
        const extent = this._finiteExtent(arrays);
        return extent ? [Math.min(0, extent.min), Math.max(0, extent.max)] : [-1, 1];
    }

    _varUnit() {
        return '';
    }

    _extractUnit(description = '') {
        return /\[([^\]]+)\]/.exec(description)?.[1] || '';
    }

    _traceName(name) {
        return name;
    }

    _escapeHTML(value) {
        return String(value);
    }

    _formatHTMLNumber(value) {
        return String(value);
    }
}

installPlotDataMethods(Harness);

class AppHarness {}
installFileMethods(AppHarness);

const plotFor = (fileId = FILE_ID) => ({
    mode: 'timeseries',
    traces: [{
        fileId,
        varName: 'signal',
        color: '#123456',
    }],
    timeseriesY2Enabled: false,
    timeseriesStacked: false,
});

const assertAmPmAxis = (axis, label, dateFormat = '%b %d, %Y') => {
    assert.equal(axis.type, 'date', `${label}: calendar axis uses Plotly date type`);
    assert.equal(axis.tickformat, `%-I:%M %p\n${dateFormat}`, `${label}: AM/PM tick format is explicit`);
    assert.equal(axis.hoverformat, '%-I:%M:%S %p', `${label}: AM/PM axis hover format is explicit`);
    assert.ok(!axis.tickformat.includes('%H'), `${label}: no 24-hour directive remains in AM/PM ticks`);
};

const assert24HourAxis = (axis, label, dateFormat = '%b %d, %Y') => {
    assert.equal(axis.type, 'date', `${label}: calendar axis uses Plotly date type`);
    assert.equal(axis.tickformat, `%H:%M\n${dateFormat}`, `${label}: 24-hour tick format is explicit`);
    assert.equal(axis.hoverformat, '%H:%M:%S', `${label}: 24-hour axis hover format is explicit`);
    assert.ok(!/%-?I|%p/.test(axis.tickformat), `${label}: no AM/PM directive remains in 24-hour ticks`);
};

// A single helper is the source of truth for every calendar clock format.
assert.deepEqual(getCalendarTimeFormats('calendar-ampm'), {
    tickformat: '%-I:%M %p',
    tickformatWithDate: '%-I:%M %p\n%b %d, %Y',
    hoverformat: '%-I:%M:%S %p',
    traceHoverformat: '%Y-%m-%d %-I:%M:%S %p',
});
assert.deepEqual(getCalendarTimeFormats('calendar-24h'), {
    tickformat: '%H:%M',
    tickformatWithDate: '%H:%M\n%b %d, %Y',
    hoverformat: '%H:%M:%S',
    traceHoverformat: '%Y-%m-%d %H:%M:%S',
});

assert.deepEqual(
    ['en', 'fr', 'es', 'it'].map(language => getPlotlyLocale(language)),
    ['en-US', 'fr', 'es', 'it'],
    'each app language maps to an explicit Plotly locale',
);
assert.equal(normalizeAppLanguage('unknown'), 'en', 'unknown app languages fall back to English');
assert.equal(getPlotlyLocale('unknown'), 'en-US', 'unknown Plotly locales fall back to en-US');
assert.equal(getCalendarDateTickFormat('en'), '%b %d, %Y', 'English retains month-first dates');
for (const language of ['fr', 'es', 'it']) {
    assert.equal(getCalendarDateTickFormat(language), '%d %b %Y', `${language} uses day-first dates`);
    assert.equal(
        getCalendarTimeFormats('calendar-ampm', language).tickformatWithDate,
        '%-I:%M %p\n%d %b %Y',
        `${language} keeps AM/PM independent from the date language`,
    );
    assert.equal(
        getCalendarTimeFormats('calendar-24h', language).tickformatWithDate,
        '%H:%M\n%d %b %Y',
        `${language} keeps 24-hour time independent from the date language`,
    );
}

for (const [locale, name, monthIndex, shortMonth] of [
    [spanishLocale, 'es', 0, 'Ene'],
    [frenchLocale, 'fr', 1, 'Fév'],
    [italianLocale, 'it', 0, 'Gen'],
]) {
    assert.equal(locale.moduleType, 'locale', `${name} payload is a Plotly locale`);
    assert.equal(locale.name, name, `${name} payload has the expected locale name`);
    assert.equal(locale.format.shortMonths[monthIndex], shortMonth, `${name} provides translated month names`);
}

assert.equal(
    new AppHarness()._normalizeFileTransform({ calendarTimeFormat: '24h' }).calendarTimeFormat,
    '24h',
    'the app-side transform normalizer preserves an explicit 24-hour selection',
);

const [
    dataMethodsSource,
    fileMethodsSource,
    interactionMethodsSource,
    plotManagerSource,
    fftMethodsSource,
    histogramMethodsSource,
    plotlyLocaleSource,
    vendorPlotlySource,
    viewerAppSource,
] = await Promise.all([
    readFile(new URL('../src/plots/methods/data-methods.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/plots/methods/histogram-methods.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/plots/plotly-locale.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/vendor/plotly.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8'),
]);
assert.doesNotMatch(
    [dataMethodsSource, fileMethodsSource, plotlyLocaleSource].join('\n'),
    /navigator\.language|toLocaleTimeString\s*\(|Intl\.DateTimeFormat\s*\(/,
    'calendar clock selection does not depend on browser or operating-system locale APIs',
);
assert.ok(
    plotManagerSource.includes('locale: getPlotlyLocale(this.language)'),
    'every central Plotly config carries the selected app locale',
);
assert.ok(
    ['es.js', 'fr.js', 'it.js'].every(file => vendorPlotlySource.includes(`plotly.js-locales/${file}`))
        && vendorPlotlySource.includes('Plotly.register(locale)'),
    'the three non-default locales are bundled and registered locally',
);
const setLanguageStart = viewerAppSource.indexOf('    setLanguage(lang) {');
const setLanguageEnd = viewerAppSource.indexOf('\n    toggleTheme()', setLanguageStart);
const setLanguageSource = viewerAppSource.slice(setLanguageStart, setLanguageEnd);
assert.ok(
    setLanguageSource.indexOf('this.plotManager.preserveViewsForNextRender()')
        < setLanguageSource.indexOf('i18n.setLanguage(lang)')
        && setLanguageSource.indexOf('this.plotManager.setLanguage(this.language)')
        < setLanguageSource.indexOf('this.layoutManager.render()'),
    'language changes queue the current views before visible charts are reconstructed',
);
assert.doesNotMatch(
    setLanguageSource,
    /autoScale|autorange/,
    'changing language never invokes an autoscale path',
);
const preserveViewsStart = plotManagerSource.indexOf('    preserveViewsForNextRender() {');
const preserveViewsEnd = plotManagerSource.indexOf('\n    setSyncAxes(', preserveViewsStart);
const preserveViewsSource = plotManagerSource.slice(preserveViewsStart, preserveViewsEnd);
assert.ok(
    preserveViewsSource.includes('this._capturePlotView(plot, { manualRangesOnly: true })')
        && preserveViewsSource.includes('plot._pendingViewRestore = view'),
    'the language remount reuses the central capture/restore channel for every plot',
);
assert.ok(
    plotManagerSource.includes('view.histogramBars = {')
        && histogramMethodsSource.includes('restoreView?.histogramBars')
        && histogramMethodsSource.includes('_buildHistogramBarLayoutForReact(plot)'),
    'histogram bar zoom is preserved as well as its time-series pane',
);
assert.ok(
    fileMethodsSource.includes("selected === 'calendar-ampm' ? 'ampm' : '24h'")
        && fileMethodsSource.includes('this._updateFileTransform(fileId, patch, { rerender: true })'),
    'the selector maps both calendar options into the existing transform/rebuild path',
);
assert.ok(fftMethodsSource.includes('const layout = this._buildTimeLayout(plot)'), 'Fourier redraws reuse the central time layout');
assert.ok(histogramMethodsSource.includes('const layout = this._buildTimeLayout(plot)'), 'Histogram redraws reuse the central time layout');
assert.ok(
    interactionMethodsSource.includes("this._timeAxisRelayoutUpdate(layout.scene.xaxis, 'scene.xaxis')"),
    'phase2dt lazy relayout reapplies the central time-axis format fields',
);
assert.ok(
    plotManagerSource.includes("Object.assign(update, this._timeAxisRelayoutUpdate(layout.scene.xaxis, 'scene.xaxis'))"),
    'phase2dt reset reapplies the central time-axis format fields',
);

const harness = new Harness('ampm');
const timeVar = harness._getTimeVar(FILE_ID);
const plot = plotFor();

assertAmPmAxis(harness._calendarAxisConfig(FILE_ID, timeVar, TIMES), 'axis builder');

for (const language of ['fr', 'es', 'it']) {
    const localizedHarness = new Harness('ampm', null, language);
    assertAmPmAxis(
        localizedHarness._calendarAxisConfig(FILE_ID, localizedHarness._getTimeVar(FILE_ID), TIMES),
        `${language} standard calendar axis`,
        '%d %b %Y',
    );
}
const ampmLayout = harness._buildTimeLayout(plot);
assertAmPmAxis(ampmLayout.xaxis, 'initial layout');
assert.match(ampmLayout.xaxis.title.text, /AM\/PM/, 'axis title and tick clock both use AM/PM');

const ampmTrace = harness._buildTimeTrace(plot.traces[0], null, plot);
assert.ok(
    ampmTrace.hovertemplate.includes('%{x|%Y-%m-%d %-I:%M:%S %p}'),
    'trace hover uses the same AM/PM clock as the axis',
);
assert.ok(!ampmTrace.hovertemplate.includes('%H'), 'AM/PM trace hover has no 24-hour directive');

// Simulate the transform state emitted by the selector. The existing rebuild
// path must replace both axis and hover formats from that state.
harness.files.get(FILE_ID).transform.calendarTimeFormat = '24h';
const twentyFourLayout = harness._buildTimeLayout(plot);
assert24HourAxis(twentyFourLayout.xaxis, 'selector rebuild');
assert.match(twentyFourLayout.xaxis.title.text, /24h/, 'axis title and tick clock both use 24 hours');

const twentyFourTrace = harness._buildTimeTrace(plot.traces[0], null, plot);
assert.ok(
    twentyFourTrace.hovertemplate.includes('%{x|%Y-%m-%d %H:%M:%S}'),
    'trace hover changes to the same 24-hour clock as the axis',
);
assert.ok(!/%-?I|%p/.test(twentyFourTrace.hovertemplate), '24-hour trace hover has no AM/PM directive');

// An explicit user choice of 24h must override AM/PM metadata from the file.
const metadataHarness = new Harness('24h', 'ampm');
assert.equal(
    metadataHarness._calendarTimeFormat(FILE_ID, metadataHarness._getTimeVar(FILE_ID)),
    '24h',
    'the selected option, not file metadata or locale, is the source of truth',
);
assert24HourAxis(
    metadataHarness._buildTimeLayout(plotFor()).xaxis,
    'explicit 24-hour override',
);

// A Plotly panel has one shared X axis. If overlaid files carry different
// preferences, every trace hover must follow the primary trace/axis clock.
const overlayHarness = new Harness('24h');
const secondaryId = 'secondary-calendar-fixture';
const secondaryEntry = structuredClone(overlayHarness.files.get(FILE_ID));
secondaryEntry.transform.calendarTimeFormat = 'ampm';
overlayHarness.files.set(secondaryId, secondaryEntry);
const overlayPlot = {
    ...plotFor(),
    traces: [
        { fileId: FILE_ID, varName: 'signal', color: '#123456' },
        { fileId: secondaryId, varName: 'signal', color: '#654321' },
    ],
};
assert24HourAxis(overlayHarness._buildTimeLayout(overlayPlot).xaxis, 'overlay primary axis');
const secondaryTrace = overlayHarness._buildTimeTrace(overlayPlot.traces[1], null, overlayPlot, 1);
assert.ok(
    secondaryTrace.hovertemplate.includes('%{x|%Y-%m-%d %H:%M:%S}'),
    'secondary overlay hover follows the primary 24-hour axis',
);
assert.equal(
    overlayHarness._primaryTimeFileId({ mode: 'histogram', traces: overlayPlot.traces }),
    FILE_ID,
    'histogram redraws obtain calendar settings from their primary time trace',
);

// High-resolution generated calendars use custom tickvals/ticktext. Exercise
// their precision-safe branch, including nested typed arrays used by phase2dt.
const generatedHarness = new Harness('ampm');
generatedHarness._isHighResolutionGeneratedCalendarTime = () => true;
generatedHarness._timeOriginMsForVar = () => Date.UTC(2025, 0, 1, 0);
generatedHarness._calendarFractionDigits = () => 6;

const generatedAmPmLabels = HOURS.map(hour => generatedHarness._formatGeneratedCalendarDateTime(
    FILE_ID,
    hour * 60 * 60,
    generatedHarness._getTimeVar(FILE_ID),
));
assert.ok(generatedAmPmLabels[0].includes(' 12:00:00.000000 AM '), 'midnight is 12:00 AM');
assert.ok(generatedAmPmLabels[1].includes(' 3:00:00.000000 AM '), '03:00 is 3:00 AM');
assert.ok(generatedAmPmLabels[2].includes(' 12:00:00.000000 PM '), 'noon is 12:00 PM');
assert.ok(generatedAmPmLabels[3].includes(' 3:00:00.000000 PM '), '15:00 is 3:00 PM');
assert.ok(generatedAmPmLabels[4].includes(' 6:00:00.000000 PM '), '18:00 is 6:00 PM');
assert.ok(
    generatedAmPmLabels.every(text => !/\s(?:00|1[3-9]|2[0-3]):\d/.test(text)),
    'custom AM/PM labels contain no 00:00 or 13:00-23:00 clock values',
);

const fullHighResolutionRange = [
    new Float64Array([0, 3 * 60 * 60]),
    new Float64Array([12 * 60 * 60, 18 * 60 * 60]),
];
const generatedAmPm = generatedHarness._calendarAxisConfig(
    FILE_ID,
    generatedHarness._getTimeVar(FILE_ID),
    fullHighResolutionRange,
);
assert.equal(generatedAmPm.type, 'linear', 'high-resolution calendar keeps its precision-safe linear axis');
assert.equal(generatedAmPm.tickmode, 'array', 'high-resolution typed arrays generate custom ticks');
assert.ok(generatedAmPm.ticktext.every(text => /\b(?:AM|PM)\b/.test(text)), 'all AM/PM custom ticks carry a meridiem');

const localizedGeneratedHarness = new Harness('ampm', null, 'es');
localizedGeneratedHarness._isHighResolutionGeneratedCalendarTime = () => true;
localizedGeneratedHarness._timeOriginMsForVar = () => Date.UTC(2025, 0, 1, 0);
localizedGeneratedHarness._calendarFractionDigits = () => 6;
const localizedGeneratedAxis = localizedGeneratedHarness._calendarAxisConfig(
    FILE_ID,
    localizedGeneratedHarness._getTimeVar(FILE_ID),
    fullHighResolutionRange,
);
assert.deepEqual(
    localizedGeneratedAxis.ticktext,
    generatedAmPm.ticktext,
    'native Plotly locale leaves the manual high-resolution ticktext branch unchanged',
);

const zoomTicks = generatedHarness._calendarAxisConfig(
    FILE_ID,
    generatedHarness._getTimeVar(FILE_ID),
    [3 * 60 * 60, 6 * 60 * 60],
);
assert.ok(
    zoomTicks.tickvals.every(value => value >= 3 * 60 * 60 && value <= 6 * 60 * 60),
    'zoom tick regeneration stays inside the visible range',
);
const resetTicks = generatedHarness._calendarAxisConfig(
    FILE_ID,
    generatedHarness._getTimeVar(FILE_ID),
    fullHighResolutionRange,
);
assert.ok(resetTicks.tickvals[0] <= 0, 'reset tick regeneration returns to the full range');
assert.ok(resetTicks.tickvals.at(-1) >= 18 * 60 * 60, 'reset ticks cover the full afternoon range');

generatedHarness.files.get(FILE_ID).transform.calendarTimeFormat = '24h';
const generated24HourLabels = HOURS.map(hour => generatedHarness._formatGeneratedCalendarDateTime(
    FILE_ID,
    hour * 60 * 60,
    generatedHarness._getTimeVar(FILE_ID),
));
assert.ok(generated24HourLabels[0].includes(' 00:00:00.000000 '), '24-hour midnight remains 00:00');
assert.ok(generated24HourLabels[3].includes(' 15:00:00.000000 '), '24-hour afternoon remains 15:00');
assert.ok(generated24HourLabels.every(text => !/\b(?:AM|PM)\b/.test(text)), 'custom 24-hour labels have no AM/PM');
const generated24h = generatedHarness._calendarAxisConfig(
    FILE_ID,
    generatedHarness._getTimeVar(FILE_ID),
    fullHighResolutionRange,
);
assert.ok(generated24h.ticktext.every(text => !/\b(?:AM|PM)\b/.test(text)), 'custom 24-hour ticktext has no AM/PM');

const phaseAxisUpdate = generatedHarness._timeAxisRelayoutUpdate(generated24h, 'scene.xaxis');
assert.deepEqual(phaseAxisUpdate['scene.xaxis.tickvals'], generated24h.tickvals, 'phase2dt lazy/reset reapplies tickvals');
assert.deepEqual(phaseAxisUpdate['scene.xaxis.ticktext'], generated24h.ticktext, 'phase2dt lazy/reset reapplies ticktext');

// High-resolution overlays also use the primary axis preference in customdata
// hover labels, while retaining each trace's own time origin.
const highResolutionOverlay = new Harness('24h');
const highResolutionSecondary = structuredClone(highResolutionOverlay.files.get(FILE_ID));
highResolutionSecondary.transform.calendarTimeFormat = 'ampm';
highResolutionOverlay.files.set(secondaryId, highResolutionSecondary);
highResolutionOverlay._isHighResolutionGeneratedCalendarTime = () => true;
highResolutionOverlay._timeOriginMsForVar = fileId => Date.UTC(2025, 0, fileId === secondaryId ? 2 : 1, 0);
highResolutionOverlay._calendarFractionDigits = () => 6;
highResolutionOverlay._getTransformedTimeDataForVariable = () => Float64Array.from(HOURS, hour => hour * 60 * 60);
highResolutionOverlay._getTransformedVariableData = () => Float64Array.from([1, 2, 3, 4, 5]);
const highResolutionOverlayTrace = highResolutionOverlay._buildTimeTrace(
    overlayPlot.traces[1],
    null,
    overlayPlot,
    1,
);
assert.ok(highResolutionOverlayTrace.customdata.some(text => text.includes(' 15:00:00.000000 ')), 'secondary customdata follows primary 24h');
assert.ok(highResolutionOverlayTrace.customdata.every(text => text.startsWith('2025-01-02 ')), 'secondary customdata retains its own time origin');
assert.ok(highResolutionOverlayTrace.customdata.every(text => !/\b(?:AM|PM)\b/.test(text)), 'secondary high-resolution hover has no AM/PM on a 24-hour axis');

const phasePlot = {
    mode: 'phase2dt',
    phaseTraces: [
        { fileId: FILE_ID, x: 'signal', y: 'signal', color: '#123456' },
        { fileId: secondaryId, x: 'signal', y: 'signal', color: '#654321' },
    ],
};
const phaseTraces24h = highResolutionOverlay._buildPhase2DtTraces(phasePlot);
assert.ok(phaseTraces24h[1].hovertemplate.includes('%{customdata}'), 'phase2dt high-resolution hover uses formatted calendar customdata');
assert.ok(phaseTraces24h[1].customdata.every(text => text.startsWith('2025-01-02 ')), 'phase2dt secondary hover retains its own origin');
assert.ok(phaseTraces24h[1].customdata.every(text => !/\b(?:AM|PM)\b/.test(text)), 'phase2dt secondary hover follows its primary 24-hour axis');
const phaseLayout24h = highResolutionOverlay._buildPhase3DLayout(phasePlot, true);
assert.equal(phaseLayout24h.scene.xaxis.tickmode, 'array', 'phase2dt layout wires typed-array custom ticks into scene.xaxis');
assert.ok(phaseLayout24h.scene.xaxis.ticktext.every(text => !/\b(?:AM|PM)\b/.test(text)), 'phase2dt 24-hour axis has no AM/PM');

highResolutionOverlay.files.get(FILE_ID).transform.calendarTimeFormat = 'ampm';
const phaseTracesAmPm = highResolutionOverlay._buildPhase2DtTraces(phasePlot);
assert.ok(phaseTracesAmPm[1].customdata.every(text => /\b(?:AM|PM)\b/.test(text)), 'phase2dt secondary hover follows its primary AM/PM axis');
assert.ok(
    phaseTracesAmPm[1].customdata.every(text => !/\s(?:00|1[3-9]|2[0-3]):\d/.test(text)),
    'phase2dt AM/PM hover contains no 24-hour clock values',
);
const phaseLayoutAmPm = highResolutionOverlay._buildPhase3DLayout(phasePlot, true);
assert.ok(phaseLayoutAmPm.scene.xaxis.ticktext.every(text => /\b(?:AM|PM)\b/.test(text)), 'phase2dt AM/PM axis carries a meridiem on every tick');

console.log('calendar axis format tests passed');
