import '../../node_modules/plotly.js-dist-min/plotly.min.js';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';
import chineseLocale from 'plotly.js-locales/zh-cn.js';
import { installTouchPlotGestures } from '../ui/plot-touch-gestures.js';
import { install3DSceneGestures } from '../ui/plot-3d-gestures.js';
import { compactPlotLayout, compactPlotRelayout } from '../utils/compact-plot-layout.js';
import { keepOverlayLegendsFromPushing } from '../utils/overlay-legend-margins.js';
import { fillHoverReadout, hoverReadoutRestyle } from '../utils/hover-readout.js';
import {
    fitLayoutTitles,
    fitRelayoutTitles,
    fitRestyleHoverTemplates,
    fitTraceHoverTemplate,
    hoverCharsFor,
} from '../utils/plot-text-fit.js';

const Plotly = globalThis.Plotly;

for (const locale of [spanishLocale, frenchLocale, italianLocale, chineseLocale]) {
    Plotly.register(locale);
}

// Every plot this app makes is drawn here, through one of seventeen `newPlot`
// calls and the `react` calls the analysis panes redraw with. What a finger
// does on a plot is the same question in all of them, and a layout builder is
// the wrong place to keep asking it — so the touch gestures are installed on
// the way past, once per plot, and `react` is wrapped too because a pane that
// is only ever reacted into existence needs them just as much.
//
// See ui/plot-touch-gestures.js for what they are.
// A 3D scene gets its own pinch and wheel zoom (ui/plot-3d-gestures.js); it
// looks for a scene under the pointer on every event, so a plot that only
// later switches to 3D is covered too.
// Anything else that has to follow every plot as it is drawn — the phone
// layout's fit buttons — listens here rather than in each of those calls.
const drawnListeners = new Set();
export function onPlotDrawn(listener) {
    drawnListeners.add(listener);
    return () => drawnListeners.delete(listener);
}

const withTouchGestures = (drawn, div) => {
    installTouchPlotGestures(drawn || div, Plotly);
    install3DSceneGestures(drawn || div);
    for (const listener of drawnListeners) {
        try { listener(drawn || div); } catch (error) { console.error(error); }
    }
    return drawn;
};

// The phone layout draws plot text a little larger, with the X title clear of
// the tick labels (utils/compact-plot-layout.js).
// It says whether it is on; the sizes themselves are bumped on the way past,
// for every layout and every relayout that carries a size.
let largerFonts = () => false;
export function setLargerPlotFonts(isOn) {
    largerFonts = typeof isOn === 'function' ? isOn : () => false;
}
// How Plotly punctuates the numbers it writes itself — tick labels, hovers.
// `layout.separators` is decimal first, grouping second, and it overrides the
// registered locale, so the axis agrees with the panel beside it even when
// Settings has overridden a separator. Injected here, like the fonts above,
// because the alternative is remembering it in seventeen layout builders.
let plotSeparators = () => '';
export function setPlotNumberSeparators(value) {
    plotSeparators = typeof value === 'function' ? value : () => String(value || '');
}

const withSeparators = (layout) => {
    const separators = plotSeparators();
    if (!separators) return layout;
    // A layout that already names its own separators has a reason to; and a
    // non-object (undefined) layout is Plotly's own default, left alone.
    if (!layout || typeof layout !== 'object' || layout.separators !== undefined) return layout;
    return { ...layout, separators };
};

// Long names fitted to the plot's room (utils/plot-text-fit.js): a hover
// label's lines wrap, an axis title is shortened. The room is the div's, as
// it is when the plot is drawn.
const plotSize = div => ({ width: div?.clientWidth || 0, height: div?.clientHeight || 0 });
const hoverChars = div => hoverCharsFor(div?.clientWidth || 0);

const layoutFor = (layout, div) => fitLayoutTitles(
    withSeparators(largerFonts() ? compactPlotLayout(layout) : layout),
    plotSize(div),
);

// Hover readouts (utils/hover-readout.js): a trace that declares
// `_hoverReadout` gets its `hovertext` written here from the x/y/z it is drawn
// with, by every call that hands Plotly new data. Kept out of the trace
// builders because a time series reaches Plotly by half a dozen restyle paths,
// and one of them forgetting would show the previous window's numbers.
const readoutFormat = div => ({ decimal: plotSeparators()[0] || '.', maxChars: hoverChars(div) });
const fillTrace = (trace, div) => (trace?._hoverReadout
    ? fillHoverReadout(trace, readoutFormat(div))
    : fitTraceHoverTemplate(trace, hoverChars(div)));
const fillReadouts = (data, div) => {
    if (Array.isArray(data)) data.forEach(trace => fillTrace(trace, div));
    else if (data && typeof data === 'object') fillTrace(data, div);
    return data;
};
const withReadoutRestyle = (div, update, traces) => fitRestyleHoverTemplates(
    hoverReadoutRestyle(div?.data, update, traces, readoutFormat(div)),
    hoverChars(div),
);

const nativeNewPlot = Plotly.newPlot.bind(Plotly);
const nativeRelayout = Plotly.relayout.bind(Plotly);
// An overlay legend must not squeeze the plot (utils/overlay-legend-margins.js).
// The first draw of a plot with a wide one has already pushed the margins out
// before the guard is in place; touching a margin setting has Plotly work them
// out again, without the legend's push.
const unsqueeze = (drawn, div) => (keepOverlayLegendsFromPushing(drawn || div)
    ? nativeRelayout(drawn || div, { 'margin.autoexpand': true }).then(() => drawn, () => drawn)
    : drawn);
Plotly.newPlot = (div, data, layout, ...rest) => nativeNewPlot(div, fillReadouts(data, div), layoutFor(layout, div), ...rest)
    .then(drawn => unsqueeze(drawn, div))
    .then(drawn => withTouchGestures(drawn, div));
const nativeReact = Plotly.react.bind(Plotly);
Plotly.react = (div, data, layout, ...rest) => nativeReact(div, fillReadouts(data, div), layoutFor(layout, div), ...rest)
    .then(drawn => unsqueeze(drawn, div))
    .then(drawn => withTouchGestures(drawn, div));
const nativeRestyle = Plotly.restyle.bind(Plotly);
Plotly.restyle = (div, update, ...rest) => {
    // The (div, 'attr', value, traces) form never carries a readout's data in
    // this app; only the object form is rewritten.
    if (!update || typeof update !== 'object') return nativeRestyle(div, update, ...rest);
    return nativeRestyle(div, withReadoutRestyle(div, update, rest[0]), ...rest);
};
const nativeUpdate = Plotly.update.bind(Plotly);
Plotly.update = (div, traceUpdate, layoutUpdate, traces, ...rest) => nativeUpdate(div,
    withReadoutRestyle(div, traceUpdate, traces), fitRelayoutTitles(layoutUpdate, plotSize(div)), traces, ...rest);
const nativeAddTraces = Plotly.addTraces.bind(Plotly);
Plotly.addTraces = (div, traces, ...rest) => nativeAddTraces(div, fillReadouts(traces, div), ...rest);
Plotly.relayout = (div, update, ...rest) => nativeRelayout(div,
    fitRelayoutTitles(largerFonts() && update && typeof update === 'object' ? compactPlotRelayout(update) : update, plotSize(div)), ...rest);

export default Plotly;
