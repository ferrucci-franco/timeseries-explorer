// When the app switches to its phone layout (docs/phone-web-specification.md §3).
import assert from 'node:assert/strict';

import {
    COMPACT_MAX_HEIGHT,
    COMPACT_MAX_WIDTH,
    effectiveViewportSize,
    isLandscapeViewport,
    normalizeLayoutOverride,
    shouldUseCompactLayout,
    viewportWantsCompact,
} from '../src/ui/compact-layout.js';

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

console.log('compact layout rules: ok');
