import '../../node_modules/plotly.js-dist-min/plotly.min.js';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';
import { installTouchPlotGestures } from '../ui/plot-touch-gestures.js';

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
const withTouchGestures = (drawn, div) => {
    installTouchPlotGestures(drawn || div, Plotly);
    return drawn;
};
const nativeNewPlot = Plotly.newPlot.bind(Plotly);
Plotly.newPlot = (div, ...rest) => nativeNewPlot(div, ...rest).then(drawn => withTouchGestures(drawn, div));
const nativeReact = Plotly.react.bind(Plotly);
Plotly.react = (div, ...rest) => nativeReact(div, ...rest).then(drawn => withTouchGestures(drawn, div));

export default Plotly;
