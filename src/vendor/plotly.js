import '../../node_modules/plotly.js-dist-min/plotly.min.js';
import spanishLocale from 'plotly.js-locales/es.js';
import frenchLocale from 'plotly.js-locales/fr.js';
import italianLocale from 'plotly.js-locales/it.js';

const Plotly = globalThis.Plotly;

for (const locale of [spanishLocale, frenchLocale, italianLocale]) {
    Plotly.register(locale);
}

export default Plotly;
