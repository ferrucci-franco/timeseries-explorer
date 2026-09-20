// The unit of a column, said and settable (#43).
//
// A CSV whose time column declares no unit was read as elapsed seconds
// everywhere it mattered — _timeAxisModel calls such an axis 'elapsed', which
// is what lets it overlay a datetime file — and then said so nowhere: the
// parsing dialog's units row read "[numeric]", naming the storage rather than
// the quantity, and the FFT fell back to "Frequency [1/x-unit]" on a file that
// is plainly in seconds.
//
// Saying it is only safe if it can be corrected, so the three parts of the
// report stand together: show the unit, use it, and let it be set per column.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyzeSampling } from '../src/utils/fft.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const dialog = read('src/ui/csv-parsing-preview-dialog.js');
const fftMethods = read('src/plots/methods/fft-methods.js');
const translations = read('src/i18n/translations.js');

// ── The spectrum of a numeric axis is in hertz ──────────────────────────────
// Both kinds reach this in seconds: a datetime axis stores milliseconds and is
// scaled before it gets here, and a numeric one IS elapsed seconds.
const seconds = Float64Array.from({ length: 64 }, (_, i) => i * 0.01);
assert.equal(analyzeSampling(seconds, { timeKind: 'numeric' }).frequencyUnit, 'Hz',
    'a numeric axis is read as seconds, so its spectrum is in hertz');
assert.equal(analyzeSampling(seconds, { timeKind: 'datetime' }).frequencyUnit, 'Hz',
    'and so is a datetime one');

// ── The axis title agrees, and can be told otherwise ────────────────────────
const title = fftMethods.slice(fftMethods.indexOf('proto._fftFrequencyAxisTitle'));
const titleBody = title.slice(0, title.indexOf('\n};'));
assert.match(titleBody, /\|\| \(kind === 'numeric' && !unit\)\) \{\s*\n\s*return i18n\.t\('fftFrequencyHz'\);/,
    'a numeric axis that declares no unit is hertz, not the generic fallback');
// A column that says it is in minutes must NOT be called hertz — that is the
// whole point of being able to set the unit.
assert.match(titleBody, /return i18n\.t\('fftFrequencyGeneric'\);/,
    'a declared unit that is not seconds still falls back to the generic');
assert.ok(titleBody.indexOf("unit === 's'") < titleBody.indexOf("kind === 'numeric' && !unit"),
    'a declared "s" is matched before the no-unit inference, not by it');

// ── The units row names the quantity, not the storage ───────────────────────
assert.match(dialog, /if \(timeSource\?\.kind === 'numeric'\) return '\[s\]';/,
    'a numeric time column reads as seconds in the units row');
assert.doesNotMatch(dialog, /return '\[numeric\]';/, 'and no longer as "[numeric]"');
// Once a unit is set on that column the row shows it instead, or the parsed
// cell would go on saying seconds under a header just corrected to minutes.
assert.match(dialog, /_buildDetectedUnitsRow[\s\S]{0,900}?timeSource\?\.description[\s\S]{0,300}?parsedColumnFormatLabel/,
    'the parsed cell prefers the unit the time source carries');

// ── A unit box per column ───────────────────────────────────────────────────
const tools = dialog.slice(dialog.indexOf('const unit = document.createElement'));
const toolsBody = tools.slice(0, tools.indexOf('const raw = document.createElement'));
assert.match(toolsBody, /unit\.value = unitTextFromDescription\(header\.description\)/,
    'pre-filled with whatever was detected, so correcting one is an edit');
assert.match(toolsBody, /description: value \? `\[\$\{value\}\]` : ''/,
    'stored as the bracketed description every reader of a variable expects');
// Empty means "this column has no unit", not "use the detected one": the
// reader cleared the box on purpose.
assert.doesNotMatch(toolsBody, /description: value \|\|/, 'clearing the box clears the unit');
assert.match(dialog, /row\.append\(useColumn, name, unit, raw\)/, 'it sits beside the rename box');

// ── And it reaches the time column ──────────────────────────────────────────
// Without this the inference above would be unfixable: the override changed
// the source column and the time axis went on being read as seconds.
const applyFn = dialog.slice(dialog.indexOf('function applyHeaderNamesToTimeSource'));
const applyBody = applyFn.slice(0, applyFn.indexOf('\n}'));
assert.match(applyBody, /if \(!namedIndexes\.length && !unit\) return timeSource;/,
    'a unit reaches the time source even when the column was not renamed');
assert.match(applyBody, /if \(unit && timeSource\.kind === 'numeric'\) next\.description = `\[\$\{unit\}\]`;/,
    'and becomes its description');
// A datetime axis measures instants, not a quantity with a unit, and its
// description is the marker readers key off.
assert.match(applyBody, /timeSource\.kind === 'numeric'/, 'only a numeric axis takes one');

// ── Strings ─────────────────────────────────────────────────────────────────
for (const key of ['csvPreviewColumnUnitPlaceholder', 'csvPreviewColumnUnitTitle']) {
    assert.equal((translations.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 4,
        `${key} is translated in all four languages`);
}
// The help under the checkbox described one box; there are two now.
for (const match of translations.matchAll(/csvPreviewColumnsHelp: '([^']*)'/g)) {
    assert.doesNotMatch(match[1], /text box|le texte|el texto|il testo/i,
        `the help no longer speaks of a single box: "${match[1].slice(0, 60)}…"`);
}

console.log('Column-unit checks passed.');
