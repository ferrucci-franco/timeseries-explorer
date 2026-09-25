import '../../node_modules/plotly.js-dist-min/plotly.min.js';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';
import { installTouchPlotGestures } from '../ui/plot-touch-gestures.js';
import { install3DSceneGestures } from '../ui/plot-3d-gestures.js';

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
const withTouchGestures = (drawn, div) => {
    installTouchPlotGestures(drawn || div, Plotly);
    install3DSceneGestures(drawn || div);
    return drawn;
};
const nativeNewPlot = Plotly.newPlot.bind(Plotly);
Plotly.newPlot = (div, ...rest) => nativeNewPlot(div, ...rest).then(drawn => withTouchGestures(drawn, div));
const nativeReact = Plotly.react.bind(Plotly);
Plotly.react = (div, ...rest) => nativeReact(div, ...rest).then(drawn => withTouchGestures(drawn, div));

export default Plotly;
