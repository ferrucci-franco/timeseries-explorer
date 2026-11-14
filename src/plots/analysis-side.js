// The side panel of an analysis: its own buttons, and under them its options.
//
// Every analysis used to open with a bar across the whole panel — V/H, hide
// the time series, Reset, Options, and the status line — above the plots. A
// strip of height, the full width of the panel, for four buttons that are
// pressed once in a while; and when the panel was short (two analyses stacked
// on a laptop screen) that strip was the difference between a plot one could
// read and one that was a sliver.
//
// So the bar is now the HEADER OF THE SIDE PANEL, and the plots have that
// height back. The buttons still sit together, still in the same order, and
// still look the same — they are simply at the top of the drawer they belong
// with, beside the options they go with.
//
// The one thing it costs: with the drawer closed there are no buttons, only
// the edge pill that opens it again (and Plotly's own modebar, which resets
// the axes by itself). That is the trade — a closed drawer means "show me the
// plot and nothing else", which is exactly when the strip was worth least.
//
// The drawer is hidden by `aside[hidden]`, as it always was, and in the phone
// layout it is lent to a sheet and is not a child here at all. CSS hides this
// column whenever it holds no visible drawer, so neither case leaves an empty
// strip of buttons beside the plot (see `.analysis-side` in content.css).

/**
 * @param {HTMLElement} topbar  the analysis' own bar of buttons and status
 * @param {HTMLElement} options the analysis' options drawer (an `aside`)
 */
export function createAnalysisSide(topbar, options) {
    const side = document.createElement('div');
    side.className = 'analysis-side';
    side.append(topbar, options);
    return side;
}
