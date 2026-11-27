// Tick labels that fit the space the axis has.
//
// Plotly thins the labels of an automatic axis by itself, but not of an axis
// given its own `tickvals`/`ticktext` (`tickmode: 'array'`) — there it draws
// every label it is handed, however little room there is, and they run into
// each other. Several axes here must name their own ticks (the hours of a
// Heatmap row, the days of a month, ISO weeks, a duration), so the thinning
// Plotly would have done is done here, once, for all of them.
//
// The rule is the obvious one: work out how many labels fit, keep every nth.
// Striding rather than picking "nice" values keeps the first tick and an even
// spacing, which on a calendar axis is what reads as regular — 00:00, 06:00,
// 12:00, 18:00 rather than four labels at arbitrary hours.

// Room one label needs, including the air around it, at the sizes the plot
// builders use (11 px base font, 12 px in the compact layout).
export const AXIS_TICK_LABEL_HEIGHT_PX = 15;
// A horizontal label is as wide as its text; these cover the two kinds the
// app writes on an X axis of its own making.
export const AXIS_TICK_LABEL_WIDTH_PX = 64;
// Rotated (the Heatmap's dates, at -35 degrees) they overlap far later.
export const AXIS_TICK_LABEL_WIDTH_ROTATED_PX = 30;
// A short label — a day of the month, a year — needs less than a date.
export const AXIS_TICK_LABEL_WIDTH_SHORT_PX = 34;

/**
 * How many labels fit in `sizePx`, never fewer than two: an axis with one
 * label says less than an axis with a crowded pair, and a plot pane can be
 * reported as zero pixels wide before it is laid out.
 */
export function axisTickCapacity(sizePx, labelPx, fallbackCapacity = Infinity) {
    const size = Number(sizePx);
    const label = Number(labelPx);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(label) || label <= 0) {
        // The pane has not been laid out yet (a figure built before it is in
        // the document reports no width). A caller that knows roughly how many
        // labels its axis can take says so; otherwise nothing is dropped,
        // because a thinning that guessed could hide labels that had room.
        return Number.isFinite(fallbackCapacity) ? Math.max(2, Math.floor(fallbackCapacity)) : Infinity;
    }
    return Math.max(2, Math.floor(size / label));
}

/**
 * Keep every nth tick of `values` (and of `labels`, when given) so that no
 * more than fit in `sizePx` are drawn.
 *
 * Returns `{ tickvals, ticktext, stride }`; `ticktext` is null when no labels
 * were given. With no usable size nothing is dropped — a thinning that
 * guessed at the room would hide labels that had room to spare.
 */
export function fitAxisTicks(values, labels = null, options = {}) {
    const list = Array.isArray(values) ? values : [];
    const text = Array.isArray(labels) ? labels : null;
    const capacity = axisTickCapacity(options.sizePx, options.labelPx, options.fallbackCapacity);
    const stride = Number.isFinite(capacity) && list.length > capacity
        ? Math.ceil(list.length / capacity)
        : 1;
    if (stride <= 1) return { tickvals: list, ticktext: text, stride: 1 };
    const tickvals = [];
    const ticktext = text ? [] : null;
    for (let index = 0; index < list.length; index += stride) {
        tickvals.push(list[index]);
        if (ticktext) ticktext.push(text[index]);
    }
    return { tickvals, ticktext, stride };
}
