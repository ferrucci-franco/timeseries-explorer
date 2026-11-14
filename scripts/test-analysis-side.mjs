// Every analysis keeps its buttons at the top of its side panel, and none of
// them puts a bar back across the whole panel.
//
//   node scripts/test-analysis-side.mjs
//
// The bar — V/H, hide the time series, Reset, Options, and the status line —
// used to run above the plots, full width, for buttons pressed once in a
// while. It is now the header of the options column (src/plots/analysis-side.js),
// and the plots keep that strip of height. This reads the sources so a new
// analysis cannot quietly go back to the old shape:
//
//   · every analysis builds its column with createAnalysisSide(topbar, options)
//     and appends only the workspace to its container;
//   · the column's CSS exists, and hides itself when it holds no open drawer
//     (closed, or lent to the phone layout's sheet).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const has = (text, pattern, message) => assert.ok(pattern.test(text), message);

const PANELS = [
    'fft-methods.js',
    'histogram-methods.js',
    'heatmap-methods.js',
    'temporal-profile-methods.js',
    'integral-methods.js',
    'correlation-methods.js',
    'phase2d-fit-methods.js',
    'curve-fit-methods.js',
    'trend-methods.js',
];

const side = read('src/plots/analysis-side.js');
has(side, /export function createAnalysisSide/, 'the column has one builder');
has(side, /className = 'analysis-side'/, 'with one class');

for (const file of PANELS) {
    const source = read(`src/plots/methods/${file}`);
    has(source, /createAnalysisSide\(topbar, options\)/, `${file}: its bar is the header of its side panel`);
    has(source, /container\.append\(workspace\)/, `${file}: and the container holds the workspace alone`);
    assert.ok(!/container\.append\(topbar/.test(source), `${file}: no bar across the whole panel`);
}

const css = read('src/styles/content.css');
has(css, /^\.analysis-side \{/m, 'the column is styled');
has(css, /\.analysis-side:not\(:has\(> aside:not\(\[hidden\]\)\)\) \{/, 'and disappears when it holds no open drawer');
has(css, /\.analysis-side > aside \{/, 'the drawer fills what is left of it');

console.log('the analyses keep their buttons at the top of their side panel: ok');
