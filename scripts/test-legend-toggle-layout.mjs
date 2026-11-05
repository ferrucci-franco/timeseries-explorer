// The overlay legend's show/hide button (utils/legend-toggle-layout.js).
import assert from 'node:assert/strict';

import {
    LEGEND_WIDE_SHARE,
    legendStartsCollapsed,
    legendToggleGeometry,
    overlayLegendCorner,
} from '../src/utils/legend-toggle-layout.js';
import { isOverlayLegendPush, keepOverlayLegendsFromPushing } from '../src/utils/overlay-legend-margins.js';

// ── Only a legend inside the plotting area gets a button ────────────────────
assert.deepEqual(overlayLegendCorner({ x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top' }), { left: true, top: true });
assert.deepEqual(overlayLegendCorner({ x: 0.99, y: 0.99, xanchor: 'right', yanchor: 'top' }), { left: false, top: true });
assert.deepEqual(overlayLegendCorner({ x: 0.01, y: 0.01, xanchor: 'left', yanchor: 'bottom' }), { left: true, top: false });
assert.deepEqual(overlayLegendCorner({ x: 0.99, y: 0.01, xanchor: 'right', yanchor: 'bottom' }), { left: false, top: false });
assert.deepEqual(overlayLegendCorner({ x: 0.8, y: 0.2, xanchor: 'auto', yanchor: 'auto' }), { left: false, top: false },
    'Plotly\'s "auto" anchor follows the side the legend is on');
assert.equal(overlayLegendCorner({ x: 0.5, y: 1.02, orientation: 'h', xanchor: 'center', yanchor: 'bottom' }), null, 'a legend above the plot keeps its place');
assert.equal(overlayLegendCorner({ x: 1.02, y: 0.5, xanchor: 'left', yanchor: 'middle' }), null, 'so does one right of it');
assert.equal(overlayLegendCorner({ x: 0.01, y: 0.99, visible: false }), null, 'a hidden legend has no button');
assert.equal(overlayLegendCorner(null), null);

// ── How a legend starts ─────────────────────────────────────────────────────
assert.equal(legendStartsCollapsed({ compact: true, legendWidth: 40, plotWidth: 400 }), true, 'on the phone the button opens it');
assert.equal(legendStartsCollapsed({ legendWidth: 120, plotWidth: 800 }), false, 'a short name stays shown on a desktop');
assert.equal(legendStartsCollapsed({ legendWidth: 800 * LEGEND_WIDE_SHARE + 1, plotWidth: 800 }), true, 'a long one starts minimized');
assert.equal(legendStartsCollapsed({ legendWidth: 120, plotWidth: 0 }), false, 'an unmeasured plot shows it');

// ── The button keeps the corner; the legend moves aside ─────────────────────
const box = { left: 60, top: 15, width: 200, height: 50 };
assert.deepEqual(legendToggleGeometry({ box, corner: { left: true, top: true }, buttonSize: 22, gap: 4 }),
    { button: { left: 60, top: 15 }, shift: { x: 26, y: 0 } }, 'desktop: beside the legend, at its top left');
assert.deepEqual(legendToggleGeometry({ box, corner: { left: false, top: true }, buttonSize: 22, gap: 4 }),
    { button: { left: 238, top: 15 }, shift: { x: -26, y: 0 } }, 'at a right corner the legend moves left');
assert.deepEqual(legendToggleGeometry({ box, corner: { left: true, top: true }, buttonSize: 38, gap: 6, vertical: true }),
    { button: { left: 60, top: 15 }, shift: { x: 0, y: 44 } }, 'phone: the legend opens below the button');
assert.deepEqual(legendToggleGeometry({ box, corner: { left: true, top: false }, buttonSize: 38, gap: 6, vertical: true }),
    { button: { left: 60, top: 27 }, shift: { x: 0, y: -44 } }, 'and above it at a bottom corner');

// ── An overlay legend does not push the plot's margins ──────────────────────
const push = (x, y, r = 300) => ({ l: { val: x, size: 0 }, r: { val: x, size: r }, b: { val: y, size: 0 }, t: { val: y, size: 40 } });
assert.equal(isOverlayLegendPush('legend', push(0.01, 0.99)), true);
assert.equal(isOverlayLegendPush('legend2', push(0.99, 0.01)), true);
assert.equal(isOverlayLegendPush('legend', push(0.5, 1.02)), false, 'a legend above the plot still makes room');
assert.equal(isOverlayLegendPush('legend', push(1.02, 0.5)), false, 'so does one right of it');
assert.equal(isOverlayLegendPush('colorbar', push(0.5, 0.5)), false, 'only legends');
{
    const div = {
        _fullLayout: {
            _pushmargin: { base: { l: { val: 0, size: 55 } }, legend: push(0.01, 0.99), x: push(0.5, 0) },
            _size: { l: 55, r: 300, t: 10, b: 40 },
            margin: { l: 55, r: 15, t: 10, b: 40 },
        },
    };
    assert.equal(keepOverlayLegendsFromPushing(div), true, 'a plot squeezed by its legend is laid out again');
    const pushes = div._fullLayout._pushmargin;
    assert.deepEqual(Object.keys(pushes).sort(), ['base', 'x'], 'the legend\'s push is gone, the others stay');
    pushes.legend = push(0.01, 0.99);
    assert.equal('legend' in pushes, false, 'and is not recorded again');
    pushes.legend = push(0.5, 1.02);
    assert.equal('legend' in pushes, true, 'unless the legend moves out of the plot');
    pushes.legend = push(0.01, 0.99);
    assert.equal('legend' in pushes, false, 'and back in');
    delete pushes.x;
    assert.equal('x' in pushes, false, 'Plotly can still delete what it pushed');
    assert.equal(keepOverlayLegendsFromPushing(div), false, 'the guard goes on once');
}
{
    const div = { _fullLayout: { _pushmargin: { legend: push(0.01, 0.99, 10) }, _size: { l: 55, r: 15 }, margin: { l: 55, r: 15 } } };
    assert.equal(keepOverlayLegendsFromPushing(div), false, 'a legend that fitted needs no second layout');
}
assert.equal(keepOverlayLegendsFromPushing({}), false, 'a div Plotly has not drawn is left alone');

console.log('legend toggle layout: ok');
