// Long names fitted to a plot's room (src/utils/text-fit.js,
// src/utils/plot-text-fit.js): a hover label's lines wrap between words,
// keeping Plotly's markup whole; an axis title too long for its side is cut
// with "…"; on a wide plot nothing changes.
import assert from 'node:assert/strict';
import { fitMarkup, markupLength, wrapMarkup } from '../src/utils/text-fit.js';
import {
    fitLayoutTitles,
    fitRelayoutTitles,
    fitRestyleHoverTemplates,
    fitTraceHoverTemplate,
    hoverCharsFor,
} from '../src/utils/plot-text-fit.js';
import { buildHoverReadoutText, fillHoverReadout } from '../src/utils/hover-readout.js';

const name = 'R1 · 2 metre dewpoint temperature (d2m) · mean [33.44°S–31.01°S, 64.99°W–61.24°W]';
const shown = markup => markup.replace(/<[^>]*>/g, '');
const lines = markup => markup.split(/<br>/);

// ── Wrapping ──
assert.equal(wrapMarkup('<b>Time</b> = %{x}', 40), '<b>Time</b> = %{x}', 'a short line is left as it is');
const template = `<b>Time</b> = %{x}<br><b>${name}</b> = %{y:.4~g} K<extra></extra>`;
const wrapped = wrapMarkup(template, 40);
assert.ok(lines(wrapped).every(line => markupLength(line) <= 40), `no line longer than the room:\n${wrapped}`);
assert.equal(shown(wrapped).replace(/\s+/g, ' '), shown(template).replace(/\s+/g, ' '), 'nothing lost');
for (const line of lines(wrapped)) {
    const opened = (line.match(/<b>/g) || []).length;
    const closed = (line.match(/<\/b>/g) || []).length;
    assert.equal(opened, closed, `each line closes its own bold (${line})`);
}
assert.ok(wrapped.endsWith('= %{y:.4~g} K<extra></extra>'), 'the value stays at the end of the last line');
assert.equal(wrapMarkup(template, Infinity), template, 'no room given, nothing wrapped');

// ── Shortening ──
assert.equal(fitMarkup('power [kW]', 30), 'power [kW]');
const cut = fitMarkup(`<b>${name}</b> [K]`, 30);
assert.ok(markupLength(cut) <= 30 && cut.includes('…') && cut.endsWith('</b>'), `cut, with its bold closed (${cut})`);

// ── For every plot ──
assert.equal(hoverCharsFor(0), Infinity, 'a plot not laid out yet is left alone');
assert.equal(hoverCharsFor(1200), 152);
assert.equal(hoverCharsFor(390), 44, 'a phone: 44 characters a line');
const trace = { hovertemplate: template };
fitTraceHoverTemplate(trace, 40);
assert.ok(lines(trace.hovertemplate).length > 2, 'a trace\'s template wraps');
fitTraceHoverTemplate(trace, 200);
assert.equal(trace.hovertemplate, template, 'and comes back whole on a wider plot');
trace.hovertemplate = '<b>new</b> = %{y}';
fitTraceHoverTemplate(trace, 40);
assert.equal(trace.hovertemplate, '<b>new</b> = %{y}', 'a template set anew is the one fitted');
assert.deepEqual(fitRestyleHoverTemplates({ hovertemplate: [template, 'short'] }, 40).hovertemplate.map(t => lines(t).length > 2), [true, false]);

const layout = { yaxis: { title: { text: name } }, xaxis: { title: 'time [s]' } };
const fitted = fitLayoutTitles(layout, { width: 390, height: 300 });
assert.ok(markupLength(fitted.yaxis.title.text) <= 31 && fitted.yaxis.title.text.endsWith('…'), `a Y title to the height (${fitted.yaxis.title.text})`);
assert.equal(fitted.xaxis.title, 'time [s]', 'a short X title stays');
assert.equal(layout.yaxis.title.text, name, 'the layout given is left as it is');
assert.equal(fitLayoutTitles(layout, { width: 1500, height: 900 }), layout, 'a tall plot keeps the whole title');
assert.ok(fitRelayoutTitles({ 'yaxis.title.text': name }, { width: 390, height: 300 })['yaxis.title.text'].endsWith('…'));

// ── Hover readouts (the time series') ──
const spec = { lines: [{ label: '<b>Time</b>', source: 'x', unit: 's' }, { label: `<b>${name}</b>`, source: 'y', unit: 'K' }] };
const [text] = buildHoverReadoutText(spec, { x: [1], y: [277.8] }, { decimal: '.', maxChars: 44 });
assert.ok(lines(text).every(line => markupLength(line) <= 44), `the readout's label wraps, with its value:\n${text}`);
assert.ok(/= 277\.8 K$/.test(text), 'the value at the end');
const [wide] = buildHoverReadoutText(spec, { x: [1], y: [277.8] }, { decimal: '.' });
assert.equal(lines(wide).length, 2, 'without a width, the label stays on one line');
const readoutTrace = { x: [1], y: [2], hovertemplate: `<b>${name}</b><br>%{hovertext}<extra></extra>`, _hoverReadout: { lines: [{ source: 'y', unit: 'K' }] } };
fillHoverReadout(readoutTrace, { decimal: '.', maxChars: 44 });
assert.ok(lines(readoutTrace.hovertemplate).length > 2, 'a readout trace\'s own template wraps too');
console.log('text fit: ok');
