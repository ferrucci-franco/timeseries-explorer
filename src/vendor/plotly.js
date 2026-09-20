import '../../node_modules/plotly.js-dist-min/plotly.min.js';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';
import { withTouchDragMode } from '../utils/touch-plot-gestures.js';
import { installPinchZoom } from '../ui/plot-pinch-zoom.js';

const Plotly = globalThis.Plotly;

for (const locale of [spanishLocale, frenchLocale, italianLocale]) {
    Plotly.register(locale);
}

// Every plot this app makes is created here, through one of seventeen
// `newPlot` calls across the analysis modes. The drag mode a finger needs is
// the same in all of them, and a layout builder is the wrong place to keep
// asking the question — so it is answered once, on the way past.
//
// See touch-plot-gestures.js for what the answer is and who gets it; a layout
// that names its own drag mode keeps it.
const nativeNewPlot = Plotly.newPlot.bind(Plotly);
Plotly.newPlot = (div, traces, layout, config) => nativeNewPlot(div, traces, withTouchDragMode(layout), config)
    .then((graphDiv) => {
        // Pan is Plotly's, in that drag mode; the pinch that zooms is the
        // app's, because Plotly has none to offer while panning.
        installPinchZoom(graphDiv || div, Plotly);
        return graphDiv;
    });

export default Plotly;
