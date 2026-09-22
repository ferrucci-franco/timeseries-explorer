// Autoscale, answering itself (#167).
//
// An autoscale ends in a relayout, and a relayout that carries
// `autorange: true` is exactly how the app hears "autoscale this" (see
// _onRelayout). While something is visible the second pass writes an explicit
// range and the conversation ends. With every trace hidden there was no range
// to write, so it asked for autorange again — and again. Measured in a
// browser: 31 rounds in 2.5 seconds, each a full relayout, and the page
// stopped answering at all.
//
// Two things hold it now: an autoscale with nothing to scale to does nothing,
// and a run of autorange requests with no pause in it is not a hand.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const interaction = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
const fft = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');

// ── The bound, run ──────────────────────────────────────────────────────────
let clock = 1000;
const context = {
    proto: {},
    performance: { now: () => clock },
    console: { warn() {} },
};
const start = interaction.indexOf('proto._autorangeRequestIsAnEcho = function');
assert.ok(start >= 0, 'the bound is there');
const end = interaction.indexOf('\nproto.', start + 10);
vm.runInNewContext(interaction.slice(start, end), context);
const isEcho = (plot) => context.proto._autorangeRequestIsAnEcho(plot);

const plot = {};
for (let pass = 1; pass <= 8; pass += 1) {
    clock += 80;   // the measured pace of the loop
    assert.equal(isEcho(plot), false, `pass ${pass} is still taken for a request`);
}
clock += 80;
assert.equal(isEcho(plot), true, 'the ninth in a row, with no pause anywhere, is the app talking to itself');
clock += 80;
assert.equal(isEcho(plot), true, 'and so is the tenth');
clock += 500;
assert.equal(isEcho(plot), false, 'a pause is a hand, and it is answered');
clock += 80;
assert.equal(isEcho(plot), false, 'counting from there, not from before the pause');

const other = {};
assert.equal(isEcho(other), false, 'the run is a panel\'s own: another one starts fresh');

// ── Nothing to scale to is nothing to ask for ──────────────────────────────
assert.doesNotMatch(manager, /const update = \{ 'xaxis\.autorange': true, 'yaxis\.autorange': true \};/,
    'the timeseries autoscale no longer asks Plotly to guess when nothing is visible');
assert.match(manager, /if \(!visibleTraces\.length\) \{/, 'it returns instead');
assert.match(fft, /if \(!visibleTraces\.length\) return Promise\.resolve\(\);/,
    'and so does the time pane of every analysis mode');

// The per-axis buttons (Autoscale X, Autoscale Y) went the same way round.
assert.doesNotMatch(manager, /if \(!xExtent\) \{ update\['xaxis\.autorange'\] = true; return update; \}/);
assert.match(manager, /if \(!xExtent\) return update;/, 'an axis with nothing finite to fit is left alone');
assert.match(manager, /if \(!Object\.keys\(update\)\.length\) return Promise\.resolve\(\);/,
    'and an empty update is a relayout that does not happen');

// Nothing in the panes the listener listens to may ask for autorange. (The
// phase and animation modes are not among them — their relayouts are not read
// as a request, so theirs is not an echo to make.)
const axisUpdateStart = manager.indexOf('_autoScaleAxisUpdate(plot, axis');
const axisUpdateEnd = manager.indexOf('\n    _autoScalePlotAxis(', axisUpdateStart);
const timeseriesStart = manager.indexOf("if (plot.mode === 'timeseries') {", manager.indexOf('_autoScalePlot(panelId, plot ='));
const timeseriesEnd = manager.indexOf("if (this._is2D(plot.mode)", timeseriesStart);
for (const [label, text] of [
    ['the per-axis update', manager.slice(axisUpdateStart, axisUpdateEnd)],
    ['the timeseries autoscale', manager.slice(timeseriesStart, timeseriesEnd > 0 ? timeseriesEnd : timeseriesStart + 3000)],
]) {
    assert.ok(text.length > 200, `${label} is there to read`);
    assert.doesNotMatch(text, /autorange'\] = true/, `${label} never asks Plotly to guess`);
}

// ── Wired into the listener ────────────────────────────────────────────────
assert.match(interaction, /if \(autorangeRequested && this\._autorangeRequestIsAnEcho\(plot\)\) \{/,
    'the listener asks before it answers');

console.log('Autoscale echo checks passed.');
