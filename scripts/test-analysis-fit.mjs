// Whose are Fit X, Fit Y and Fit all — in the sources.
//
//   node scripts/test-analysis-fit.mjs
//
// An analysis panel shows two plots and the toolbar has one set of fit
// buttons. They belong to the pane the panel is BUILT ON — the time series,
// for every analysis but the 2D fit — while it is on screen; the pane beside
// it carries three floating buttons of its own. Fold the first away and the
// toolbar fits what is left.
//
// This reads the sources so a new analysis cannot be added without saying
// which pane is which:
//
//   · every analysis with a second pane says what its own plot is
//     (`mainPane`) and which pane can be folded away (`hidden`);
//   · the toolbar's two entry points ask `_analysisFitPlan` before dispatching
//     to the per-analysis fits;
//   · the floating group is refreshed when a result is drawn, when the panel
//     is laid out again, and by every toggle that folds a pane away;
//   · it is styled, and it is not drawn in the phone layout, which has its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const has = (text, pattern, message) => assert.ok(pattern.test(text), message);

const table = read('src/app/methods/compact-analyses.js');
const fit = read('src/plots/methods/analysis-fit-methods.js');
const manager = read('src/plots/plot-manager.js');
const css = read('src/styles/content.css');

// ── Each analysis says which pane is which ────────────────────────
const entries = table.split(/\n    \{\n/).filter(block => /\n        pane: \{/.test(block));
assert.ok(entries.length >= 9, `the analyses with a second pane (${entries.length})`);
for (const block of entries) {
    const mode = /mode: '([a-z0-9-]+)'/.exec(block)?.[1] ?? '?';
    has(block, /mainPane: '(time|result)',/, `${mode}: says what its own plot is`);
    has(block, /hidden: \{/, `${mode}: says which pane can be folded away`);
}
// Only the 2D fit is built on its result.
const resultBuilt = [...table.matchAll(/mode: '([a-z0-9-]+)'[\s\S]{0,900}?mainPane: 'result'/g)].map(m => m[1]);
assert.deepEqual(resultBuilt, ['phase2d-fit'], 'the 2D fit is the one built on its result');

// ── The plan, and the two entry points that ask for it ────────────
has(fit, /_analysisFitPlan = function/, 'the plan says who owns what');
has(fit, /_fitAnalysisPane = function/, 'and how the analysis\' own pane is fitted');
has(fit, /_refreshAnalysisFitButtons = function/, 'and the floating buttons follow it');
has(fit, /toolbarOwnsMain: entry\.mainPane === 'time' && !mainHidden/, 'the toolbar owns the time series while it is shown');
has(fit, /compactAnalysisFor/, 'which pane is which is read from the one description, not copied');
has(fit, /classList\.contains\('compact'\)/, 'the phone layout draws its own, so these stay away');

const axisStart = manager.indexOf('    _autoScalePlotAxis(panelId');
const allStart = manager.indexOf('    _autoScalePlot(panelId', axisStart);
const axisBlock = manager.slice(axisStart, allStart);
has(axisBlock, /_analysisFitPlan\?\.\(plot\)/, 'Fit X / Fit Y ask the plan');
has(axisBlock, /toolbarOwnsMain/, 'and fit the time series when it owns them');
const allBlock = manager.slice(allStart, allStart + 1200);
has(allBlock, /toolbarOwnsMain/, 'Fit all asks the same question');
has(manager, /_refreshAnalysisFitButtons\?\.\(plot\)/, 'and the panel keeps the buttons in step when it is laid out again');

// ── Every fold-away toggle refreshes them ─────────────────────────
const TOGGLES = [
    ['fft-methods.js', '_toggleFftTimeSeries'],
    ['histogram-methods.js', '_toggleHistogramTimeSeries'],
    ['heatmap-methods.js', '_toggleCalendarHeatmapTimeSeries'],
    ['temporal-profile-methods.js', '_toggleTemporalProfileTimeSeries'],
    ['integral-methods.js', '_toggleIntegralTimeSeries'],
    ['correlation-methods.js', '_toggleCorrelationTimeSeries'],
    ['curve-fit-methods.js', '_toggleCurveFitResiduals'],
    ['phase2d-fit-methods.js', '_togglePhase2dFitTimeSeries'],
];
for (const [file, name] of TOGGLES) {
    const source = read(`src/plots/methods/${file}`);
    const start = source.indexOf(`proto.${name} = function`);
    assert.ok(start > 0, `${file}: ${name} exists`);
    const body = source.slice(start, source.indexOf('\n    };', start) + 1 || source.indexOf('\n};', start) + 1);
    has(body, /_refreshAnalysisFitButtons\(plot\)/, `${name}: the floating buttons follow the fold`);
}
has(read('src/plots/methods/analysis-busy-methods.js'), /_refreshAnalysisFitButtons\?\.\(plot\)/,
    'a drawn result makes them the first time');

// ── Styled, and out of the way ────────────────────────────────────
has(css, /^\.analysis-fit-group \{/m, 'the group is styled');
has(css, /^\.analysis-fit-btn \{/m, 'and its buttons');
has(css, /\.analysis-fit-btn:hover,/, 'faint until the pointer is on them');

console.log('the fit buttons belong to one pane each, and say so: ok');
