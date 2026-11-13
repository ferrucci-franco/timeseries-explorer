// Every analysis has the computing pill and its Cancel button, and a new one
// cannot be added without them.
//
//   node scripts/test-analysis-cancel.mjs
//
// Source-level checks (the behaviour itself is driven in Chromium by
// scripts/e2e-analysis-cancel.mjs):
//
//   · every analysis the Analysis menus offer (_analysisModes) has a pane for
//     the pill in _analysisComputingTarget and a status line in
//     _cancelAnalysisComputation — a new analysis fails here until it does;
//   · every analysis shows the shared pill (directly, or from its status
//     setter while 'loading'), and the old private pills are gone;
//   · its DuckDB queries carry the panel's analysis signal, and the
//     DuckDbSource methods pass it to the query;
//   · _dropAnalysisRuns stops every analysis' token, timer and paint wait,
//     and _cancelPanelAnalysis uses it;
//   · the texts exist in every language; the button takes the pointer and the
//     pill does not.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Matched without printing the whole source on a failure.
const has = (text, pattern, message) => assert.ok(pattern.test(text), message);
const hasNot = (text, pattern, message) => assert.ok(!pattern.test(text), message);
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const busy = read('src/plots/methods/analysis-busy-methods.js');
const marks = read('src/plots/methods/marks-methods.js');

// ── Every analysis on offer is known to the pill and to Cancel ──
const modesBlock = marks.slice(marks.indexOf('proto._analysisModes = function(plot) {'), marks.indexOf('proto._activeAnalysisId'));
const offered = [...modesBlock.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map(match => match[1]);
assert.ok(offered.length >= 8, `the analyses on offer (${offered.join(', ')})`);
const targetBlock = busy.slice(busy.indexOf('proto._analysisComputingTarget'), busy.indexOf('proto._setAnalysisComputing'));
const cancelBlock = busy.slice(busy.indexOf('proto._cancelAnalysisComputation'), busy.indexOf('proto._isForeignAbort'));
for (const id of offered) {
    // The 2D fit is the 'phase2d' mode with its workspace open.
    const mode = id === 'phase2d-fit' ? 'phase2d' : id;
    has(targetBlock, new RegExp(`case '${mode}':`), `${id}: the pill knows its pane`);
    has(cancelBlock, new RegExp(`case '${mode}':`), `${id}: Cancel sets its status line`);
}

// ── Every analysis shows the shared pill ──
const statusNotes = (fn, kindVar, pill) => new RegExp(`proto\\.${fn} = function[^{]*\\{\\s*(//[^\\n]*\\n\\s*)*this\\._noteAnalysisStatus\\?\\.\\(plot, ${kindVar}, \\{ ${pill ? 'label' : 'pill: false'}`);
const showsPill = {
    fft: ['src/plots/methods/fft-methods.js', /proto\._setFftComputing = function\(plot, loading\) \{[\s\S]*?this\._setAnalysisComputing\(plot, loading/],
    'temporal-profile': ['src/plots/methods/temporal-profile-methods.js', /proto\._setTemporalProfileComputing = function\(plot, loading\) \{[\s\S]*?this\._setAnalysisComputing\(plot, loading/],
    integral: ['src/plots/methods/integral-methods.js', /proto\._setIntegralComputing = function\(plot, loading\) \{[\s\S]*?this\._setAnalysisComputing\(plot, loading/],
    histogram: ['src/plots/methods/histogram-methods.js', statusNotes('_setHistogramStatus', 'kind', true)],
    heatmap: ['src/plots/methods/heatmap-methods.js', statusNotes('_setCalendarHeatmapStatus', 'kind', true)],
    'curve-fit': ['src/plots/methods/curve-fit-methods.js', statusNotes('_setCurveFitStatus', 'type', true)],
    correlation: ['src/plots/methods/correlation-methods.js', statusNotes('_setCorrelationStatus', 'type', true)],
    'phase2d-fit': ['src/plots/methods/phase2d-fit-methods.js', statusNotes('_setPhase2dFitStatus', 'type', true)],
};
// Every status line notes the settings of the result it reports, for Cancel
// to put back; the three with their own pill function too.
for (const [file, fn, kindVar] of [
    ['src/plots/methods/fft-methods.js', '_setFftStatus', 'type'],
    ['src/plots/methods/temporal-profile-methods.js', '_setTemporalProfileStatus', 'kind'],
    ['src/plots/methods/integral-methods.js', '_setIntegralStatus', 'kind'],
]) {
    has(read(file), statusNotes(fn, kindVar, false), `${fn} notes the settings of its result`);
}
for (const id of offered) assert.ok(showsPill[id], `${id}: listed here, with how it shows the pill`);
for (const [id, [file, pattern]] of Object.entries(showsPill)) {
    const source = read(file);
    has(source, pattern, `${id} shows the shared pill`);
    hasNot(source, /pill\.innerHTML = '<span class="lazy-detail-spinner"/, `${id}: no private pill without a Cancel button`);
}

// ── The queries carry the signal ──
const queries = {
    'src/plots/methods/fft-methods.js': /_fftSeriesForTrace\(trace, range, state, this\._analysisSignal\(plot\)\)/,
    'src/plots/methods/heatmap-methods.js': /const signal = this\._analysisSignal\(plot\);[\s\S]*?getCalendarHeatmapAggregates\([\s\S]*?signal,\n/,
    'src/plots/methods/temporal-profile-methods.js': /const signal = this\._analysisSignal\(plot\);[\s\S]*?getTemporalProfileAggregates\([\s\S]*?signal,\n/,
    'src/plots/methods/integral-methods.js': /const signal = this\._analysisSignal\(plot\);[\s\S]*?getDefiniteIntegralByDay\([\s\S]*?signal,\n/,
    'src/plots/methods/correlation-methods.js': /const signal = this\._analysisSignal\(plot\);[\s\S]*?getPairCorrelations\([\s\S]*?signal \}/,
    'src/plots/methods/phase2d-fit-methods.js': /getPhaseRegressionStats\([\s\S]*?signal \}/,
    'src/plots/methods/fit-lazy-methods.js': /getRawColumnsRange\([^\n]*\{ signal \}\)/,
};
for (const [file, pattern] of Object.entries(queries)) has(read(file), pattern, `${file}: its queries carry the signal`);
const source = read('src/data/duckdb-source.js');
has(source, /async getRawColumnsRange\([^)]*\{ signal = null \} = \{\}\)[\s\S]*?this\._interactiveQuery\(sql, \{ signal \}\)/, 'getRawColumnsRange passes it on');
for (const method of ['getCalendarHeatmapAggregates', 'getDefiniteIntegralByDay', 'getTemporalProfileAggregates', 'getPairCorrelations', 'getPhaseRegressionStats']) {
    has(source, new RegExp(`async ${method}\\([^)]*\\) \\{\\n[^\\n]*\\n\\s*const signal = options\\?\\.signal \\|\\| null;`), `${method} reads the signal`);
}
has(source, /pairExprs, active, signal\);/, 'the regression queries get it');
has(source, /_interactiveQuery\(sql, \{ signal: opts\?\.signal \|\| null \}\)[\s\S]*_interactiveQuery\(sql, \{ signal: opts\?\.signal \|\| null \}\)/, 'both heatmap queries get it');

// ── One stop for everything ──
for (const key of [
    '_fftToken', '_fftPreparationToken', '_histToken', '_calendarHeatmapToken', '_temporalProfileToken',
    '_integralToken', '_correlationToken', '_phase2dLazyToken',
    '_curveFitRecomputeTimer', '_curveFitRecomputeRun', '_histRecomputeRun', '_phase2dFitRecomputeRun',
]) {
    assert.ok(busy.includes(`'${key}'`), `_dropAnalysisRuns covers ${key}`);
}
has(busy, /plot\._analysisAbort\?\.abort\(\);[\s\S]*?plot\._histAbort\?\.abort\(\);[\s\S]*?this\._stopLazyFits\?\.\(plot\);[\s\S]*?this\._abortFftWorkerJob\?\.\(plot, reason\);/, 'and stops the work itself');
const manager = read('src/plots/plot-manager.js');
has(manager, /\n    _cancelPanelAnalysis\(panelId[\s\S]*?this\._dropAnalysisRuns\(plot, reason\);\s*this\._setAnalysisComputing\(plot, false\);/, 'closing a panel uses the same stop and hides the pill');
has(manager, /installPlotAnalysisBusyMethods\(PlotManager\);/);

// ── Cancel puts the settings of the result on screen back ──
const stateBlock = busy.slice(busy.indexOf('const STATE_KEY = {'), busy.indexOf('};', busy.indexOf('const STATE_KEY = {')));
const restoreBlock = busy.slice(busy.indexOf('proto._restoreAnalysisSettings'), busy.indexOf('proto._cancelAnalysisComputation'));
for (const id of offered) {
    const mode = id === 'phase2d-fit' ? 'phase2d' : id;
    has(stateBlock, new RegExp(`(^|\\s)'?${mode}'?: '`), `${id}: where its settings live is known`);
    has(restoreBlock, new RegExp(`case '${mode}':`), `${id}: its controls and range are refreshed after a restore`);
}
has(busy, /if \(kind !== 'loading'\) this\._rememberAnalysisSettings\(plot\);/, 'a settled result notes its settings');
has(busy, /if \(!plot \|\| plot\._analysisCancelling\) return;/, 'but not the status Cancel writes');
has(busy, /const restored = this\._restoreAnalysisSettings\(panelId, plot\);[\s\S]*?'analysisCancelledRestored'/, 'Cancel restores and says so');
has(read('src/plots/methods/curve-fit-methods.js'), /proto\._rekeyCurveFitsAfterRestore = function/, 'a restored curve fit is current again');
has(read('src/plots/methods/phase2d-fit-methods.js'), /proto\._rekeyPhase2dFitsAfterRestore = function/, 'and a restored 2D fit');

// ── Picking the analysis that is on, from the menu, changes nothing ──
has(marks, /if \(id === 'timeseries'\) \{[\s\S]*?\}\n\s*\/\/[^\n]*\n\s*if \(id === mode\) return;/, 'time series: the active card is inert');
has(marks, /if \(id === 'phase2d'\) return backTo2d\(\);\n\s*if \(id === active\) return;/, '2D: the active card is inert, None goes back');

// ── Words and pointer ──
const translations = read('src/i18n/translations.js');
for (const key of ['analysisCalculating', 'analysisCancel', 'analysisCancelTitle', 'analysisCancelled', 'analysisCancelledKept', 'analysisCancelledRestored']) {
    assert.equal((translations.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 5, `${key} in every language`);
}
const css = read('src/styles/content.css');
has(css, /\.lazy-detail-indicator \{[\s\S]*?pointer-events: none;/, 'the pill lets the pointer through');
has(css, /\.analysis-cancel-btn \{[\s\S]*?pointer-events: auto;/, 'its button takes it');
hasNot(css, /var\(--accent-color\)/, 'no colour from a variable the themes do not define');
has(css, /\.analysis-cancel-btn:hover \{[\s\S]*?background: var\(--primary-color\);/, 'its hover is the theme\'s primary colour');
has(busy, /cancel\.addEventListener\('click'[\s\S]*?this\._cancelAnalysisComputation\(/, 'the button cancels');

// ── The rule is written where it is read ──
has(read('CLAUDE.md'), /computing pill with a Cancel button/, 'CLAUDE.md states the rule');
has(read('CONTRIBUTING.md'), /computing pill with a Cancel button/, 'CONTRIBUTING.md too');

console.log(`analysis cancel: ${offered.length} analyses with the pill and its Cancel`);
