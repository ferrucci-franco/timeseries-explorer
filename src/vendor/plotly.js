import '../../node_modules/plotly.js-dist-min/plotly.min.js';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';
import { installTouchPlotGestures } from '../ui/plot-touch-gestures.js';
import { install3DSceneGestures } from '../ui/plot-3d-gestures.js';
import { enlargeLayoutFonts, enlargeRelayoutFonts } from '../utils/compact-plot-fonts.js';

const Plotly = globalThis.Plotly;

for (const locale of [spanishLocale, frenchLocale, italianLocale]) {
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

// The phone layout draws plot text a little larger (utils/compact-plot-fonts.js).
// It says whether it is on; the sizes themselves are bumped on the way past,
// for every layout and every relayout that carries a size.
let largerFonts = () => false;
export function setLargerPlotFonts(isOn) {
    largerFonts = typeof isOn === 'function' ? isOn : () => false;
}
const layoutFor = layout => (largerFonts() ? enlargeLayoutFonts(layout) : layout);

const nativeNewPlot = Plotly.newPlot.bind(Plotly);
Plotly.newPlot = (div, data, layout, ...rest) => nativeNewPlot(div, data, layoutFor(layout), ...rest)
    .then(drawn => withTouchGestures(drawn, div));
const nativeReact = Plotly.react.bind(Plotly);
Plotly.react = (div, data, layout, ...rest) => nativeReact(div, data, layoutFor(layout), ...rest)
    .then(drawn => withTouchGestures(drawn, div));
const nativeRelayout = Plotly.relayout.bind(Plotly);
Plotly.relayout = (div, update, ...rest) => nativeRelayout(div,
    largerFonts() && update && typeof update === 'object' ? enlargeRelayoutFonts(update) : update, ...rest);

export default Plotly;
