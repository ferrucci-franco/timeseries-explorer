// When the app switches to its phone layout (docs/phone-web-specification.md §3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    LAYOUT_OVERRIDE_STORAGE_KEY,
    COMPACT_MAX_HEIGHT,
    COMPACT_MAX_WIDTH,
    effectiveViewportSize,
    isLandscapeViewport,
    layoutOverrideToStore,
    normalizeLayoutOverride,
    shouldUseCompactLayout,
    viewportWantsCompact,
} from '../src/ui/compact-layout.js';
import { compactPlotLayout, compactPlotRelayout } from '../src/utils/compact-plot-layout.js';
import {
    COMPACT_ANALYSES,
    COMPACT_ANALYSIS_PANES,
    COMPACT_FIT_MODES,
    COMPACT_PAIR_MODES,
    COMPACT_SIGNAL_LIST_MODES,
    compactAnalysis,
    compactAnalysisFor,
    compactWindowZoom,
} from '../src/app/methods/compact-analyses.js';

// ── Phones, upright and sideways ────────────────────────────────────────────
for (const [width, height] of [[320, 568], [360, 800], [390, 844], [412, 915]]) {
    assert.equal(viewportWantsCompact(width, height), true, `${width}×${height} upright is a phone`);
    assert.equal(viewportWantsCompact(height, width), true, `${height}×${width} sideways is still a phone: it has no height`);
}

// ── Tablets and desktops keep the desktop layout ────────────────────────────
for (const [width, height] of [[768, 1024], [1024, 768], [820, 1180], [1280, 800], [1920, 1080]]) {
    assert.equal(viewportWantsCompact(width, height), false, `${width}×${height} keeps the desktop layout`);
}

// ── The edges are exclusive ─────────────────────────────────────────────────
assert.equal(viewportWantsCompact(COMPACT_MAX_WIDTH, 900), false);
assert.equal(viewportWantsCompact(COMPACT_MAX_WIDTH - 1, 900), true);
assert.equal(viewportWantsCompact(1200, COMPACT_MAX_HEIGHT), false);
assert.equal(viewportWantsCompact(1200, COMPACT_MAX_HEIGHT - 1), true);

// ── Nonsense never switches anything ────────────────────────────────────────
assert.equal(viewportWantsCompact(0, 0), false);
assert.equal(viewportWantsCompact(NaN, 800), false);

// ── The user's choice wins in both directions ───────────────────────────────
assert.equal(shouldUseCompactLayout({ width: 1400, height: 900, override: 'compact' }), true);
assert.equal(shouldUseCompactLayout({ width: 390, height: 844, override: 'full' }), false);
assert.equal(shouldUseCompactLayout({ width: 390, height: 844, override: 'auto' }), true);
// "Desktop" is only remembered where it differs from the automatic choice:
// kept on a large window, it turned automatic switching off for good.
assert.equal(layoutOverrideToStore('full', 390, 844), 'full');
assert.equal(layoutOverrideToStore('full', 1280, 800), 'auto');
assert.equal(layoutOverrideToStore('compact', 1280, 800), 'compact');
assert.equal(layoutOverrideToStore('auto', 390, 844), 'auto');
assert.equal(normalizeLayoutOverride('nonsense'), 'auto');
assert.equal(normalizeLayoutOverride(null), 'auto');

// ── A zoomed-out mobile page cannot hide the phone ──────────────────────────
// Measured in Chromium's mobile emulation: a 390 px phone showing the desktop
// layout reported innerWidth 810. The screen's own size bounds it.
assert.deepEqual(
    effectiveViewportSize({ innerWidth: 810, innerHeight: 1753, screenWidth: 390, screenHeight: 844 }),
    { width: 390, height: 844 },
);
// iOS reports the screen upright whatever the orientation.
assert.deepEqual(
    effectiveViewportSize({ innerWidth: 844, innerHeight: 390, screenWidth: 390, screenHeight: 844 }),
    { width: 844, height: 390 },
);
// A desktop window smaller than its screen is measured as the window.
assert.deepEqual(
    effectiveViewportSize({ innerWidth: 500, innerHeight: 800, screenWidth: 1920, screenHeight: 1080 }),
    { width: 500, height: 800 },
);
// No screen information: the window alone.
assert.deepEqual(effectiveViewportSize({ innerWidth: 700, innerHeight: 400 }), { width: 700, height: 400 });

assert.equal(isLandscapeViewport(844, 390), true);
assert.equal(isLandscapeViewport(390, 844), false);

// ── The boot script in index.html decides the same way ──────────────────────
// It runs before the first paint, so a phone never sees the desktop layout;
// the app then takes over with the module above. If the two ever disagreed,
// the layout would flip once the app started.
{
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const match = html.match(/<script id="compact-boot">([\s\S]*?)<\/script>/);
    assert.ok(match, 'index.html decides the layout before the first paint');
    assert.ok(match[1].includes(`'${LAYOUT_OVERRIDE_STORAGE_KEY}'`), 'with the same remembered choice');
    const boot = new Function('window', 'document', match[1]);
    const runBoot = ({ innerWidth, innerHeight, screenWidth, screenHeight, override = null }) => {
        const classes = new Set();
        boot(
            {
                innerWidth,
                innerHeight,
                screen: { width: screenWidth, height: screenHeight },
                localStorage: { getItem: () => override },
            },
            { documentElement: { classList: { add: name => classes.add(name) } } },
        );
        return classes;
    };
    const sizes = [
        [390, 844, 390, 844], [844, 390, 390, 844], [810, 1753, 390, 844], [320, 568, 320, 568],
        [412, 915, 412, 915], [915, 412, 412, 915], [768, 1024, 768, 1024], [1024, 768, 768, 1024],
        [1400, 900, 1920, 1080], [500, 800, 1920, 1080], [1200, 450, 1920, 1080], [599, 900, 1920, 1080],
        [600, 900, 1920, 1080], [1200, 499, 1920, 1080], [1200, 500, 1920, 1080],
    ];
    for (const [innerWidth, innerHeight, screenWidth, screenHeight] of sizes) {
        for (const override of [null, 'auto', 'compact', 'full']) {
            const size = effectiveViewportSize({ innerWidth, innerHeight, screenWidth, screenHeight });
            const want = shouldUseCompactLayout({ ...size, override: override || 'auto' });
            const classes = runBoot({ innerWidth, innerHeight, screenWidth, screenHeight, override });
            const label = `${innerWidth}×${innerHeight} on ${screenWidth}×${screenHeight}, ${override}`;
            assert.equal(classes.has('compact'), want, `boot and app agree on ${label}`);
            assert.equal(classes.has('compact-landscape'), want && isLandscapeViewport(size.width, size.height), `and on its orientation, ${label}`);
        }
    }
}

// ── Plot text a little larger on a phone ────────────────────────────────────
{
    const layout = {
        font: { color: '#ddd', size: 11 },
        xaxis: { title: { text: 't [s]', font: { size: 10 } }, gridcolor: '#333' },
        yaxis: { title: { text: '' } },
        yaxis2: { title: { text: 'v', font: { size: 10 } }, tickfont: { size: 9 } },
        scene: { xaxis: { title: { text: 'x', font: { size: 13 } } } },
        legend: { font: { size: 10 } },
    };
    const before = JSON.stringify(layout);
    const big = compactPlotLayout(layout);
    assert.equal(JSON.stringify(layout), before, 'the builder’s layout is left alone, or every redraw would grow it');
    assert.equal(big.font.size, 12, 'tick labels, which inherit the base font, one pixel up');
    assert.equal(big.font.color, '#ddd');
    assert.equal(big.xaxis.title.font.size, 12, 'axis titles two pixels up');
    assert.equal(big.xaxis.gridcolor, '#333');
    assert.equal(big.yaxis2.title.font.size, 12);
    assert.equal(big.yaxis2.tickfont.size, 10);
    assert.deepEqual(big.yaxis.title, { text: '' }, 'a title without a size inherits the bigger base font');
    assert.equal(big.scene, layout.scene, '3D titles are already large');
    assert.equal(big.xaxis.title.standoff, 12, 'the X title keeps a gap below the tick labels');
    assert.equal(big.xaxis.automargin, true, 'with room made for it');
    assert.equal(big.yaxis2.automargin, undefined, 'Y axes keep their margins');
    assert.equal(compactPlotLayout({ xaxis: { title: { text: '' } } }).xaxis.automargin, undefined, 'no title, no gap');
    assert.equal(compactPlotLayout({ xaxis: { title: { text: 't' }, automargin: false } }).xaxis.automargin, false, 'a builder’s own choice stands');
    assert.equal(compactPlotLayout({}).font.size, 13, 'Plotly’s 12 px default, one up');

    const update = { 'xaxis.title': { text: 'a', font: { size: 10 } }, 'xaxis.range': [0, 1], margin: { l: 4 } };
    const bigUpdate = compactPlotRelayout(update);
    assert.equal(update['xaxis.title'].font.size, 10, 'the update is left alone');
    assert.equal(bigUpdate['xaxis.title'].font.size, 12, 'a relayout that resets a title keeps it larger');
    assert.equal(bigUpdate['xaxis.title'].standoff, 12, 'and keeps its gap');
    assert.equal(bigUpdate['xaxis.range'], update['xaxis.range']);
    const plain = { 'xaxis.range': [0, 1] };
    assert.equal(compactPlotRelayout(plain), plain, 'an update with no sizes passes through untouched');
    assert.equal(compactPlotRelayout({ 'yaxis.title.font.size': 10 })['yaxis.title.font.size'], 12);
    assert.equal(compactPlotRelayout({ 'font.size': 11 })['font.size'], 12);
    assert.deepEqual(compactPlotRelayout({ font: { color: '#fff' } }), { font: { color: '#fff' } }, 'a colour change is only a colour change');
}

// ── The analyses the phone layout drives (§5.3, §11) ────────────────────────
// One entry per analysis describes it on a phone, and the sets the layout
// reads are derived from those entries. The guard below is the point of the
// registry: an analysis added to the desktop menu fails this test until it
// says where it lives on a phone.
{
    const modes = COMPACT_ANALYSES.map(entry => entry.mode);
    assert.deepEqual(modes, [...new Set(modes)], 'no mode is described twice');
    assert.equal(modes[0], 'timeseries', 'the plain time series comes first: it is how an analysis is left');

    for (const entry of COMPACT_ANALYSES) {
        assert.ok(entry.labelKey, `${entry.mode} has a label for its radio in the Analyze sheet`);
        assert.equal(compactAnalysis(entry.mode), entry, `${entry.mode} is found by its mode`);
        assert.ok(!(entry.signals && entry.pairs), `${entry.mode} takes signals or pairs, not both`);
        if (entry.signals) {
            assert.equal(typeof entry.removeTrace, 'function', `${entry.mode} says how a tap in Data takes a signal off it`);
        }
        if (entry.pairs) {
            assert.equal(typeof entry.removePair, 'function', `${entry.mode} says how one of its pairs comes off`);
            // Its plot is not a time series, so the sheet needs the mode to go
            // back to, and what to call it, when the analysis is turned off.
            assert.ok(entry.offMode && entry.offLabelKey, `${entry.mode} says what turning it off leaves`);
            assert.ok(entry.pairHintKey, `${entry.mode} says what its pairs are for`);
        }
        if (entry.onMode) {
            // Not a mode of its own: it opens over a plot of another mode, so
            // it says how it is recognised, turned on and turned off, and what
            // that plot is called when it is off.
            assert.equal(typeof entry.matches, 'function', `${entry.mode} says when it is the analysis on a plot`);
            assert.equal(typeof entry.turnOn, 'function', `${entry.mode} says how it is turned on`);
            assert.equal(typeof entry.turnOff, 'function', `${entry.mode} says how it is turned off`);
            assert.ok(entry.offMode && entry.offLabelKey, `${entry.mode} says what turning it off leaves`);
            assert.equal(typeof entry.mainFit, 'function', `${entry.mode} fits the plot it opens over its own way`);
        }
        if (entry.mode === 'timeseries') continue;
        // Every analysis lends an options panel to the sheet, under a title,
        // and offers the reset its own top bar has.
        assert.equal(typeof entry.options, 'function', `${entry.mode} lends an options panel`);
        assert.ok(entry.optionsTitleKey, `${entry.mode} titles it`);
        assert.ok(entry.reset?.labelKey && entry.reset?.titleKey && typeof entry.reset.run === 'function',
            `${entry.mode} has its reset, for the Analyze and the Plot sheet`);
        assert.equal(typeof entry.actions, 'function', `${entry.mode} lists the rest of its top bar`);
        assert.ok(entry.pane?.name && entry.pane?.div, `${entry.mode} names the pane it draws beside its time pane`);
        assert.ok(entry.pane.fit === null || typeof entry.pane.fit === 'function',
            `${entry.pane.name} says how its own axes are fitted, or that nothing on it can be`);
    }

    const paneNames = COMPACT_ANALYSIS_PANES.map(pane => pane.name);
    assert.deepEqual(paneNames, [...new Set(paneNames)], 'two analyses never call their pane the same');
    assert.ok(!paneNames.includes('main'), '"main" is the time pane, which no analysis owns');
    const paneDivs = COMPACT_ANALYSIS_PANES.map(pane => pane.div);
    assert.deepEqual(paneDivs, [...new Set(paneDivs)], 'nor hold their div in the same property');
    assert.equal(COMPACT_ANALYSIS_PANES.find(pane => pane.name === 'calendar')?.mode, 'heatmap');
    assert.equal(COMPACT_ANALYSIS_PANES.find(pane => pane.name === 'spectrum')?.mode, 'fft');

    // Derived, not written twice.
    assert.deepEqual([...COMPACT_SIGNAL_LIST_MODES], COMPACT_ANALYSES.filter(e => e.signals).map(e => e.mode));
    // In plot-mode terms: the fit buttons are drawn on a panel, which knows
    // its mode and not which workspace is open over it.
    assert.deepEqual([...COMPACT_FIT_MODES], COMPACT_ANALYSES.filter(e => e.fit).map(e => e.onMode || e.mode));
    assert.deepEqual([...COMPACT_PAIR_MODES], ['correlation'], 'correlation is the analysis made of pairs');
    // Its results pane is r against a fixed [-1, 1]: no fit buttons there, and
    // its time pane, drawn from the pairs, fits itself.
    assert.equal(compactAnalysis('correlation').pane.fit, null);
    assert.equal(typeof compactAnalysis('correlation').mainFit, 'function');
    assert.equal(compactAnalysis('correlation').offMode, 'phase2d');
    for (const mode of ['fft', 'histogram', 'heatmap', 'temporal-profile', 'integral']) {
        assert.equal(compactAnalysis(mode).offMode, undefined, `${mode} turns off to the time series`);
        assert.equal(compactAnalysis(mode).mainFit, undefined, `${mode} shares the time-pane fit`);
    }
    // The Heatmap's rows are a fixed calendar axis, and its calendar is not a
    // time axis to draw a window across.
    assert.equal(compactAnalysis('heatmap').pane.fitY, false);
    assert.equal(compactAnalysis('heatmap').pane.windowZoom, false);
    assert.equal(compactAnalysis('integral').pane.windowZoom, false, 'the integral’s bars are per period');
    assert.equal(compactAnalysis('fft').pane.windowZoom, true);
    assert.equal(compactAnalysis('phase2d'), null, 'a plot type is not an analysis');

    // A slow double tap draws a window where there is a time axis: the pane an
    // analysis is built on answers with the entry's flag, the pane beside it
    // with its own.
    assert.equal(compactWindowZoom(compactAnalysis('fft'), 'main'), true);
    assert.equal(compactWindowZoom(compactAnalysis('fft'), 'spectrum'), true);
    assert.equal(compactWindowZoom(compactAnalysis('integral'), 'integral'), false);
    assert.equal(compactWindowZoom(compactAnalysis('heatmap'), 'calendar'), false);
    assert.equal(compactWindowZoom(null, 'main'), false, 'a plot with no analysis draws no window');

    // ── The analysis a plot carries ─────────────────────────────────────────
    // A mode answers for itself; the 2D fit is a workspace a 2D plot opens
    // over itself, so the plot's own state is what says it is on.
    const fit = compactAnalysis('phase2d-fit');
    assert.equal(compactAnalysisFor({ mode: 'fft' }), compactAnalysis('fft'));
    assert.equal(compactAnalysisFor({ mode: 'phase2d' }), null, 'a 2D plot without the fit carries no analysis');
    assert.equal(compactAnalysisFor({ mode: 'phase2d', phase2d: { fitEnabled: true } }), fit);
    assert.equal(compactAnalysisFor({ mode: 'correlation', phase2d: { fitEnabled: true } }), compactAnalysis('correlation'),
        'the flag only counts on the plot the fit opens over');
    assert.equal(compactAnalysisFor(null), null);
    assert.equal(fit.onMode, 'phase2d');
    assert.equal(fit.windowZoom, false, 'its main pane is the 2D plot: x against y');
    assert.equal(compactWindowZoom(fit, 'fit-time'), true, 'the pane beside it is the time one');
    assert.ok(COMPACT_FIT_MODES.has('phase2d'), 'a 2D plot under the fit still carries its fit buttons');

    // ── §11: the desktop Analysis menu and the phone agree ──────────────────
    // Read from the menu's own source, so a new analysis there has to declare
    // its phone placement (or be listed below as deliberately desktop-only).
    const desktopOnly = new Set();
    const marks = readFileSync(new URL('../src/plots/methods/marks-methods.js', import.meta.url), 'utf8');
    const menu = marks.slice(marks.indexOf('_analysisModes = function'), marks.indexOf('_analysisMenuModel'));
    const ids = [...menu.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1]);
    assert.ok(ids.length >= 5, 'the desktop Analysis menu was read');
    for (const id of ids) {
        if (desktopOnly.has(id)) continue;
        assert.ok(compactAnalysis(id), `the desktop analysis "${id}" says where it lives on a phone (compact-analyses.js)`);
    }
}

console.log('compact layout rules: ok');
