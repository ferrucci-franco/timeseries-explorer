// The Integral analysis mode: state normalisation, unit and scale arithmetic,
// the pie gate, the export table, and the wiring that has to exist in the
// shared files for the mode to be reachable at all.
//
// Everything behavioural lives in src/utils/integral-presentation.js, which is
// pure — no Plotly, no DOM — so it can be exercised directly here. The mode
// module is checked at source level, the way test-mode-toolbar.mjs does it.
//
//   node scripts/test-integral-analysis.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeDefiniteIntegral } from '../src/compute/kernels/definite-integral.js';
import { INTEGRAL_MISSING_POLICIES } from '../src/compute/kernels/definite-integral.js';
import {
    buildIntegralExportTable,
    buildIntegralPresentation,
    defaultIntegralState,
    integralPieAllowed,
    integralResultUnit,
    normalizeIntegralState,
    timeBaseForAxis,
} from '../src/utils/integral-presentation.js';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const close = (actual, expected, message, tolerance = 1e-9) => {
    const scale = Math.max(1, Math.abs(expected));
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * scale,
        `${message}: expected ${expected}, got ${actual}`);
    checks++;
};

const HOUR = 3600000;
const day0 = Date.UTC(2030, 0, 1);
const state = (overrides = {}) => normalizeIntegralState(overrides, INTEGRAL_MISSING_POLICIES);

// One model per signal, shaped as `_recomputeIntegral` produces them.
function makeModels(signals, options = {}) {
    return signals.map((signal, index) => {
        const count = signal.values.length;
        const time = { values: Float64Array.from({ length: count }, (_, i) => day0 + i * HOUR), kind: 'datetime' };
        return {
            trace: { varName: signal.name, fileId: 'f1', color: signal.color || '#4287f5' },
            traceIndex: index,
            name: signal.name,
            unit: signal.unit || '',
            base: timeBaseForAxis('datetime', 'datetime'),
            result: computeDefiniteIntegral(signal.values, time, options),
        };
    });
}

const flat = (name, unit, value, count = 25) => ({ name, unit, values: new Array(count).fill(value) });

// ─── 1. State normalisation ───────────────────────────────────────────────
{
    const defaults = defaultIntegralState();
    eq(defaults.method, 'trapezoidal', 'the default rule matches Data Tools');
    eq(defaults.missingPolicy, 'zero', 'missing data contributes nothing by default');
    eq(defaults.integralUnit, 'hour', 'per-hour is the default reading');
    eq(defaults.scale, 'auto', 'the scale is chosen automatically by default');
    eq(defaults.showPie, false, 'the pie is opt-in');
    eq(defaults.discardIncompleteEnds, false, 'and so is discarding the ragged ends');
    eq(defaults.rangeFull, true, 'the range starts at Full');

    const junk = state({
        method: 'simpson', missingPolicy: 'nonsense', integralUnit: 'fortnight',
        scale: 'zetta', orientation: 'diagonal', sort: 'random', split: 12, layout: 'oblique',
    });
    eq(junk.method, 'trapezoidal', 'an unknown rule falls back');
    eq(junk.missingPolicy, 'zero', 'an unknown policy falls back');
    eq(junk.integralUnit, 'hour', 'an unknown unit falls back');
    eq(junk.scale, 'auto', 'an unknown scale falls back');
    eq(junk.orientation, 'vertical', 'an unknown orientation falls back');
    eq(junk.sort, 'panel', 'an unknown order falls back');
    eq(junk.split, 0.8, 'the split is clamped');
    eq(junk.layout, 'vertical', 'an unknown layout falls back');

    for (const policy of INTEGRAL_MISSING_POLICIES) {
        eq(state({ missingPolicy: policy }).missingPolicy, policy, `${policy} survives normalisation`);
    }

    // A session predating rangeFull that carries a window keeps the window.
    const legacy = state({ x1: 10, x2: 20 });
    eq(legacy.rangeFull, false, 'a saved window implies Selection');
    eq([legacy.x1, legacy.x2], [10, 20], 'and the window survives');
}

// ─── 2. Units: the signal's unit times the chosen time unit ───────────────
{
    eq(integralResultUnit('MW', 'hour', 'datetime'), 'MW·h', 'a power integrates to an energy');
    eq(integralResultUnit('', 'hour', 'datetime'), 'h', 'a unitless signal integrates to hours');
    eq(integralResultUnit('MW', 'second', 'datetime'), 'MW·s', 'per-second is spelled the same way');
    eq(integralResultUnit('MW', 'hour', 'index', 'samples'), 'MW·samples',
        'without a time axis the total is per sample, and says so');
}

// ─── 3. Time bases: known, converted, and honestly assumed ────────────────
{
    eq(timeBaseForAxis('datetime', 'datetime').secondsPerUnit, 1, 'a calendar axis is already seconds');
    eq(timeBaseForAxis('datetime', 'datetime').assumed, false, 'and nothing is assumed');
    eq(timeBaseForAxis('numeric', 's').secondsPerUnit, 1, 'a seconds axis needs no conversion');
    eq(timeBaseForAxis('numeric', 'h').secondsPerUnit, 3600, 'an hours axis is converted, not guessed');
    eq(timeBaseForAxis('numeric', 'min').secondsPerUnit, 60, 'so is a minutes axis');
    ok(timeBaseForAxis('numeric', 'furlong').assumed,
        'an unrecognised axis unit is flagged as assumed rather than silently taken as seconds');
    eq(timeBaseForAxis('numeric', 'furlong').secondsPerUnit, 1, 'while still producing a number to show');
}

// ─── 4. The per-hour conversion and the shared scale ──────────────────────
{
    // 100 MW held over 25 hourly samples = 24 h of trapezoids = 2400 MWh.
    const models = makeModels([flat('gen', 'MW', 100)]);
    const view = buildIntegralPresentation(models, state());
    close(view.rows[0].value, 2400, 'the total reads in MW·h, not MW·s');
    eq(view.exponent, 3, 'auto picks a kilo step so the bar reads 2.4');
    eq(view.axisUnit, 'GW·h', 'and folds it into the unit prefix rather than writing GMW·h');
    close(view.rows[0].scaled, 2.4, 'the plotted number is the scaled one');

    const perSecond = buildIntegralPresentation(models, state({ integralUnit: 'second', scale: '1' }));
    close(perSecond.rows[0].value, 2400 * 3600, 'per-second is 3600x the per-hour reading');
    eq(perSecond.axisUnit, 'MW·s', 'with the matching unit');

    const manual = buildIntegralPresentation(models, state({ scale: 'k' }));
    close(manual.rows[0].scaled, 2.4, 'a manual prefix scales the same way');
    eq(manual.axisUnit, 'GW·h', 'and combines with the unit the same way');

    // A unit with no recognised prefix cannot absorb the factor, so the decade
    // is stated instead of silently dropped.
    const noPrefix = buildIntegralPresentation(makeModels([flat('flow', 'p.u.', 100)]), state());
    ok(noPrefix.axisUnit.includes('p.u.·h'), 'the unprefixable unit is kept');
    ok(/×10/.test(noPrefix.axisUnit), 'and the leftover decade is stated, not hidden');
}

// ─── 5. One exponent for the whole panel ──────────────────────────────────
// A per-signal prefix would make the bars incomparable, which is the single
// thing a bar chart must not do.
{
    const view = buildIntegralPresentation(
        makeModels([flat('big', 'MW', 1000), flat('small', 'MW', 0.01)]), state());
    eq(view.rows.length, 2, 'both signals are presented');
    close(view.rows[0].scaled / view.rows[1].scaled, 100000, 'the ratio between bars is preserved exactly');
    close(view.rows[0].value / view.rows[0].scaled, view.factor, 'every bar uses the same factor');
    close(view.rows[1].value / view.rows[1].scaled, view.factor, 'including the small one');
}

// ─── 6. Sorting ───────────────────────────────────────────────────────────
{
    const models = makeModels([flat('a', 'MW', 10), flat('b', 'MW', 50)]);
    eq(buildIntegralPresentation(models, state({ sort: 'panel' })).rows.map(r => r.model.name),
        ['a', 'b'], 'panel order is the drop order');
    eq(buildIntegralPresentation(models, state({ sort: 'desc' })).rows.map(r => r.model.name),
        ['b', 'a'], 'largest first');
    eq(buildIntegralPresentation(models, state({ sort: 'asc' })).rows.map(r => r.model.name),
        ['a', 'b'], 'smallest first');
}

// ─── 7. The pie gate ──────────────────────────────────────────────────────
{
    const same = makeModels([flat('gen', 'MW', 100), flat('load', 'MW', 60)]);
    ok(integralPieAllowed(buildIntegralPresentation(same, state({ showPie: true }))),
        'one unit and one sign: the pie is legitimate');
    ok(!integralPieAllowed(buildIntegralPresentation(same, state({ showPie: false }))),
        'and it stays opt-in');

    // A storage unit that charges and discharges: the totals cancel, and a pie
    // cannot show a sum with cancellations.
    const mixedSigns = makeModels([flat('gen', 'MW', 100), flat('storage', 'MW', -60)]);
    ok(!integralPieAllowed(buildIntegralPresentation(mixedSigns, state({ showPie: true }))),
        'mixed signs hide the pie');

    const mixedUnits = buildIntegralPresentation(
        makeModels([flat('gen', 'MW', 100), flat('price', 'EUR', 60)]), state({ showPie: true }));
    ok(mixedUnits.mixedUnits, 'mixed units are detected');
    ok(!integralPieAllowed(mixedUnits), 'and hide the pie too');
    eq(mixedUnits.axisUnit, '', 'the value axis drops the unit rather than picking one of them');
}

// ─── 8. The export table ──────────────────────────────────────────────────
{
    const view = buildIntegralPresentation(makeModels([flat('gen', 'MW', 100)]), state());
    const table = buildIntegralExportTable(view, { fileNameFor: () => 'grid.csv' });
    eq(table.rows.length, 1, 'one row per signal — the totals are the analysis');
    const row = Object.fromEntries(table.headers.map((header, i) => [header, table.rows[0][i]]));
    eq(row.signal, 'gen', 'the signal is named');
    eq(row.file, 'grid.csv', 'with its file');
    close(row.integral, 2400, 'the exported value is UNSCALED — a spreadsheet has no use for a display prefix');
    eq(row.integral_unit, 'MW·h', 'and carries its unit');
    eq(row.method, 'trapezoidal', 'the rule is recorded');
    eq(row.missing_policy, 'zero', 'so is the policy');
    ok(String(row.range_start).startsWith('2030-01-01'), 'calendar bounds export as ISO timestamps');
    close(row.covered, 24 * 3600, 'covered time travels with the number');

    // Scaling the display must not move the exported number.
    const scaled = buildIntegralExportTable(
        buildIntegralPresentation(makeModels([flat('gen', 'MW', 100)]), state({ scale: 'G' })),
        { fileNameFor: () => 'grid.csv' });
    close(scaled.rows[0][3], 2400, 'a display prefix leaves the export untouched');
}

// ─── 9. Coverage is what keeps the bars honest ────────────────────────────
{
    const holey = new Array(25).fill(100);
    holey[10] = NaN;
    const models = makeModels([flat('clean', 'MW', 100), { name: 'holey', unit: 'MW', values: holey }]);
    ok(models[0].result.coveredTime !== models[1].result.coveredTime,
        'a hole shortens the integrated duration');
    ok(models[1].result.uncoveredTime > 0, 'and the shortfall is reported, not swallowed');
    ok(models[1].result.value < models[0].result.value,
        'so the polluted signal reads lower — which is why the panel warns');

    // Discarding the day for ALL signals is what restores comparability.
    const time = { values: Float64Array.from({ length: 25 }, (_, i) => day0 + i * HOUR), kind: 'datetime' };
    const sharedDay = [Math.floor(day0 / 86400000)];
    const [a, b] = [new Array(25).fill(100), holey].map(values =>
        computeDefiniteIntegral(values, time, { missingPolicy: 'discard-day-all', excludedDays: sharedDay }));
    eq(a.coveredTime, b.coveredTime, 'with the union applied, every signal integrates the same duration');
}

// ─── 10. Signals with no result never reach the chart ─────────────────────
{
    const time = { values: Float64Array.from([0, 2, 1, 3].map(h => day0 + h * HOUR)), kind: 'datetime' };
    const broken = {
        trace: { varName: 'bad', fileId: 'f1', color: '#000000' },
        traceIndex: 0,
        name: 'bad',
        unit: 'MW',
        base: timeBaseForAxis('datetime', 'datetime'),
        result: computeDefiniteIntegral([1, 1, 1, 1], time, {}),
    };
    eq(broken.result.ok, false, 'disordered timestamps produce no total');
    const view = buildIntegralPresentation([broken, ...makeModels([flat('good', 'MW', 100)])], state());
    eq(view.rows.map(r => r.model.name), ['good'], 'and the signal is left out of the bars entirely');
}

// ─── 11. The mode has to be reachable ─────────────────────────────────────
// A mode that computes correctly but is not registered everywhere breaks on
// panel switches, teardown and session reload.
{
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const plotManager = read('src/plots/plot-manager.js');
    const interaction = read('src/plots/methods/interaction-methods.js');
    const methods = read('src/plots/methods/integral-methods.js');
    const css = read('src/styles/content.css');
    const html = read('index.html');
    const session = read('src/app/methods/session-methods.js');

    ok(plotManager.includes('import { installPlotIntegralMethods }'), 'plot-manager imports the mode');
    ok(plotManager.includes('installPlotIntegralMethods(PlotManager);'), 'and installs it');
    ok(plotManager.includes('this._createIntegralChart(panelId, panelEl);'), 'chart creation is dispatched');
    ok(plotManager.includes('this._addIntegralTrace(panelId, varName, panelEl, plot);'), 'trace adding is dispatched');
    ok(plotManager.includes('integralContainer.remove();'), 'teardown removes the container');
    ok(plotManager.includes('plot._integralSelectionDocListeners'), 'and detaches the document listeners');
    ok(plotManager.includes('integral: this._defaultIntegralState?.() || null,'), 'new panels carry the state');
    ok(plotManager.includes("plot.mode === 'integral'"), 'the mode is dispatched on');
    ok(plotManager.includes('this._integralExportTable?.(plot)'), 'CSV export goes through the result table');

    ok(interaction.includes("{ id: 'integral', label: i18n.t('integralModeLabel')"),
        'the toolbar offers the analysis button');
    ok(/_toggleTimeseriesAnalysisMode[\s\S]{0,240}'integral'/.test(interaction),
        'and the analysis toggle accepts it');

    // The selection band is the same mechanic as every other analysis, so the
    // same cursor rules must name the new pane — otherwise the resize/grab
    // affordances silently disappear.
    for (const selector of [
        '.plotly-mode-integral-time.fft-cursor-ew .nsewdrag',
        '.plotly-mode-integral-time.fft-cursor-grab .nsewdrag',
        'body.fft-selection-dragging.fft-selection-moving .plotly-mode-integral-time .nsewdrag',
    ]) {
        ok(css.includes(selector), `the selection cursor rule covers ${selector}`);
    }
    ok(methods.includes("plot.div.classList.toggle('fft-cursor-ew'"), 'the pane sets the resize cursor class');
    ok(methods.includes("plot.div.classList.toggle('fft-cursor-grab'"), 'and the grab cursor class');
    ok(methods.includes("fillcolor: 'rgba(67,160,71,0.14)'"), 'the selection band keeps the shared green');
    ok(methods.includes("i18n.t('fftRangeFull')") && methods.includes("i18n.t('fftRangeSelection')"),
        'Full/Selection reuse the shared labels rather than new ones');

    ok(html.includes('id="legend-units"'), 'the sidebar carries the legend-units checkbox');
    ok(html.indexOf('id="legend-units"') > html.indexOf('id="mouse-wheel-zoom"'),
        'placed under Mouse wheel zoom, as specified');
    ok(session.includes('legendUnits: !!this.legendUnits,'), 'the setting is saved with the session');
    ok(session.includes('plot.integral = this.plotManager._normalizeIntegralState'), 'and so is the panel state');

    // The methods module must stay free of raw NUL bytes: two older modules
    // carry them as key separators and are invisible to grep as a result.
    ok(!methods.includes(String.fromCharCode(0)), 'the mode module stays greppable (no NUL bytes)');
}

console.log(`integral analysis: ${checks} checks passed`);
