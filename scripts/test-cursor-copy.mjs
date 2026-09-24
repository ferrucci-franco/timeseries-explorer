// Copying the measurement cursors' readout to the clipboard (#178).
//
// The text is read off the rendered values area, so what lands on the
// clipboard is what the box shows: the same rows, the same formatting, the
// same units. These checks pin down what is kept and what is left out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cursorReadoutText } from '../src/utils/clipboard.js';

// Enough of an element for the extraction: children, a text, a selector test.
const el = (text, className = '') => ({
    textContent: text,
    matches: (selector) => selector.split(',').some(s => className && s.trim() === `.${className}`),
});
const values = (...children) => ({ children });

// ── Time pane ───────────────────────────────────────────────────────────────
assert.equal(
    cursorReadoutText(values(
        el('\n            A x=1.25 s y=4.5 V'),
        el('B x=2 s   y=3.1 V\n'),
        el('ΔX=0.75 s'),
        el('ΔY=-1.4 V'),
        el('ΔY/ΔX=-1.867'),
        el('1/ΔX=1.333 Hz'),
    ), ['A: [run1] v_out', 'B: [run1] v_in']),
    [
        'A: [run1] v_out',
        'B: [run1] v_in',
        'A x=1.25 s y=4.5 V',
        'B x=2 s y=3.1 V',
        'ΔX=0.75 s',
        'ΔY=-1.4 V',
        'ΔY/ΔX=-1.867',
        '1/ΔX=1.333 Hz',
    ].join('\n'),
    'one line per row, whitespace from the template collapsed, trace names first',
);

// ── Spectrum pane: the note and its help explain a row, they are not one ───
assert.equal(
    cursorReadoutText(values(
        el('A f=50 Hz y=0.7 V'),
        el('T=20 ms'),
        el('B f=60 Hz y=0.2 V'),
        el('T=16.67 ms'),
        el('Δf=10 Hz'),
        el('ΔY=-0.5 V'),
        el('1/Δf=100 ms'),
        el('Inverse frequency spacing ?', 'cursor-inverse-spacing-note'),
        el('Only a beat period when…', 'cursor-help-popover'),
    )),
    'A f=50 Hz y=0.7 V\nT=20 ms\nB f=60 Hz y=0.2 V\nT=16.67 ms\nΔf=10 Hz\nΔY=-0.5 V\n1/Δf=100 ms',
);

// ── Nothing to copy ─────────────────────────────────────────────────────────
assert.equal(cursorReadoutText(null), '');
assert.equal(cursorReadoutText(values(el('  ')), ['', '  ']), '');

// ── Where the button sits: never on a row of its own ────────────────────────
const interaction = readFileSync(new URL('../src/plots/methods/interaction-methods.js', import.meta.url), 'utf8');
assert.match(interaction, /`<div class="cursor-options-row">\$\{secantHTML\}\$\{copyBtnHTML\}<\/div>\$\{hintHTML\}`/,
    'time pane: after the A-B checkbox, on its row');
assert.match(interaction, /`<div class="cursor-options-row cursor-options-row-hint">\$\{hintHTML\}\$\{copyBtnHTML\}<\/div>`/,
    'spectrum pane (no A-B line): beside the hints, so the box does not grow');
assert.ok(!/<label class="cursor-secant-toggle">[^]*cursor-copy-btn[^]*<\/label>/.test(interaction.slice(
    interaction.indexOf('const secantHTML'), interaction.indexOf('const optionsHTML'))),
    'outside the checkbox label, so a click on it never toggles the line');

// Every language names the button and both outcomes.
const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['cursorCopy', 'cursorCopied', 'cursorCopyFailed']) {
    assert.equal(translations.match(new RegExp(`\\b${key}:`, 'g'))?.length, 4, `${key} in all four languages`);
}

console.log('cursor copy: ok');
