// When the app switches to its phone layout (docs/phone-web-specification.md §3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    LAYOUT_OVERRIDE_STORAGE_KEY,
    COMPACT_MAX_HEIGHT,
    COMPACT_MAX_WIDTH,
    effectiveViewportSize,
    isLandscapeViewport,
    normalizeLayoutOverride,
    shouldUseCompactLayout,
    viewportWantsCompact,
} from '../src/ui/compact-layout.js';
import { compactPlotLayout, compactPlotRelayout } from '../src/utils/compact-plot-layout.js';

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

console.log('compact layout rules: ok');
