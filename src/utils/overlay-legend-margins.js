// An overlay legend lies on the plot: it should not move the plot.
//
// Plotly pushes the margins out until a legend fits inside the figure, so a
// long variable name squeezed the plotting area down to a sliver on a phone,
// with the fit buttons pushed onto the legend. It keeps those pushes in
// `_fullLayout._pushmargin`, one object that lives as long as the plot (react
// and relayout carry it over; newPlot makes a new one). It is wrapped here so
// the push of a legend placed inside the plotting area (x and y both in 0…1)
// is never recorded. A legend above or right of the plot keeps the room it
// needs. vendor/plotly.js applies this to every plot as it is drawn; the
// legend's show/hide button is ui/legend-toggle.js.

const insidePaper = v => Number.isFinite(v) && v >= 0 && v <= 1;

/** Whether this entry of `_pushmargin` is an overlay legend's. */
export function isOverlayLegendPush(key, push) {
    return typeof key === 'string' && /^legend\d*$/.test(key)
        && insidePaper(Number(push?.l?.val)) && insidePaper(Number(push?.b?.val));
}

const guarded = new WeakSet();

/**
 * Put the guard on a drawn plot, once per `_pushmargin` object.
 *
 * @returns {boolean} true when the plot was drawn squeezed by an overlay
 *          legend and has to be laid out again
 */
export function keepOverlayLegendsFromPushing(div) {
    const fullLayout = div?._fullLayout;
    const pushes = fullLayout?._pushmargin;
    if (!pushes || typeof pushes !== 'object' || guarded.has(pushes)) return false;
    let dropped = false;
    for (const key of Object.keys(pushes)) {
        if (isOverlayLegendPush(key, pushes[key])) {
            delete pushes[key];
            dropped = true;
        }
    }
    const proxy = new Proxy(pushes, {
        set(target, key, value) {
            if (isOverlayLegendPush(key, value)) delete target[key];
            else target[key] = value;
            return true;
        },
    });
    guarded.add(proxy);
    fullLayout._pushmargin = proxy;
    const size = fullLayout._size;
    const margin = fullLayout.margin;
    return dropped && !!size && !!margin && size.l + size.r > margin.l + margin.r + 1;
}
