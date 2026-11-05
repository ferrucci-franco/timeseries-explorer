// Where the legend's show/hide button goes, and where the legend goes while
// it is shown. Pure geometry, so it can be tested without a browser; the DOM
// side is ui/legend-toggle.js.
//
// The button stays at the legend's own corner whether the legend is shown or
// not, so it is always found in the same place. While the legend is shown it
// is moved aside by the button's size: down (or up, at a bottom corner) on the
// phone, where the button opens it like a menu; sideways on a desktop, where
// the plot is wider than it is tall and the legend loses less of it that way.

// A legend wider than this share of the plotting area starts hidden on a
// desktop: a long name, and the curve under it, matter more than the legend.
export const LEGEND_WIDE_SHARE = 0.4;

/**
 * The corner an overlay legend is anchored to, or null when the legend sits
 * outside the plotting area (above it, right of it) or is not shown at all.
 *
 * @param {object|null|undefined} legend Plotly's resolved `_fullLayout.legend`
 * @returns {{ left: boolean, top: boolean }|null}
 */
export function overlayLegendCorner(legend) {
    if (!legend || legend.visible === false) return null;
    const x = Number(legend.x);
    const y = Number(legend.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    if (legend.orientation === 'h') return null;
    const left = legend.xanchor === 'right' ? false : legend.xanchor === 'left' ? true : x < 0.5;
    const top = legend.yanchor === 'bottom' ? false : legend.yanchor === 'top' ? true : y >= 0.5;
    return { left, top };
}

/**
 * Whether a legend nobody has opened or closed yet starts hidden. On the
 * phone it always does: the button is how it is reached. On a desktop it is
 * shown unless it would cover too much of the plot.
 */
export function legendStartsCollapsed({ compact = false, legendWidth = 0, plotWidth = 0 } = {}) {
    if (compact) return true;
    const width = Number(legendWidth);
    const area = Number(plotWidth);
    if (!(width > 0) || !(area > 0)) return false;
    return width > LEGEND_WIDE_SHARE * area;
}

/**
 * Where the button goes, and how far the shown legend is moved to clear it.
 *
 * @param {object} options
 * @param {{ left: number, top: number, width: number, height: number }} options.box
 *        the legend's box where Plotly put it, in the plot div's pixels
 * @param {{ left: boolean, top: boolean }} options.corner
 * @param {number} options.buttonSize
 * @param {number} [options.gap]
 * @param {boolean} [options.vertical] move the legend down/up rather than sideways
 * @returns {{ button: { left: number, top: number }, shift: { x: number, y: number } }}
 */
export function legendToggleGeometry({ box, corner, buttonSize, gap = 4, vertical = false }) {
    const size = Math.max(0, Number(buttonSize) || 0);
    const left = corner.left ? box.left : box.left + box.width - size;
    const top = corner.top ? box.top : box.top + box.height - size;
    const step = size + gap;
    const shift = vertical
        ? { x: 0, y: corner.top ? step : -step }
        : { x: corner.left ? step : -step, y: 0 };
    return { button: { left, top }, shift };
}
