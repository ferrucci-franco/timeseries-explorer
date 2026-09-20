// The histogram's bar modes: Overlay and Stacked.
//
// "Grouped" drew the bins side by side. It answered no question the other two
// do not — Overlay compares shapes, Stacked compares composition — and past a
// handful of bins the slivers were too narrow to read, which is why the mode
// carried its own "many bars: Overlay reads better" warning. A mode that has to
// warn you away from itself is one mode too many.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { HISTOGRAM_BAR_MODES, normalizeHistogramOptions } from '../src/utils/histogram.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ─── What is left ──────────────────────────────────────────────────
assert.deepEqual([...HISTOGRAM_BAR_MODES].sort(), ['overlay', 'stacked'], 'two modes');

// ─── A saved view that still names the old one ─────────────────────
// Both normalizers fall back to 'overlay' for anything they do not know, so a
// view or session saved before this opens on the mode Grouped was closest to
// rather than on an empty chart.
assert.equal(normalizeHistogramOptions({ barMode: 'grouped' }).barMode, 'overlay',
    'a saved "grouped" opens as Overlay');
assert.equal(normalizeHistogramOptions({ barMode: 'stacked' }).barMode, 'stacked', 'stacked still works');
assert.equal(normalizeHistogramOptions({ barMode: 'overlay' }).barMode, 'overlay');
assert.equal(normalizeHistogramOptions({}).barMode, 'overlay', 'and the default is unchanged');
assert.equal(normalizeHistogramOptions({ barMode: 'nonsense' }).barMode, 'overlay');

// ─── Nothing left in the panel ─────────────────────────────────────
const histogram = read('src/plots/methods/histogram-methods.js');
assert.doesNotMatch(histogram, /grouped/i, 'no grouped anywhere in the histogram panel');
assert.match(histogram, /barmode: state\.barMode === 'stacked' \? 'stack' : 'overlay',/,
    'Plotly is told stack or overlay, with no third branch');
assert.match(histogram, /marker: \{ color: trace\.color, opacity: HISTOGRAM_DEFAULT_OPACITY,/,
    'bars are semi-transparent in both modes, which is what Grouped used to opt out of');

// The chooser offers exactly the two.
const chooser = histogram.slice(histogram.indexOf("{ label: i18n.t('histogramOverlay')"), histogram.indexOf("state.barMode,"));
assert.equal([...chooser.matchAll(/\{ label: i18n\.t\(/g)].length, 2, 'two buttons in the segmented control');
assert.match(chooser, /histogramStacked'\), value: 'stacked'/, 'and Stacked keeps its "needs two signals" guard');

// ─── Nothing left in the strings ───────────────────────────────────
const translations = read('src/i18n/translations.js');
assert.equal([...translations.matchAll(/histogramGrouped/g)].length, 0,
    'the label and the many-bars warning are gone from all four languages');
// The help section lists what the Histogram can do; it must not name a mode
// that is not there.
const helpSections = [...translations.matchAll(/helpSec6Body: "([\s\S]*?)",\s*$/gm)].map(m => m[1]);
assert.equal(helpSections.length, 4, 'four help sections');
for (const section of helpSections) {
    assert.doesNotMatch(section, /grouped|group[ée]|agrupada|raggruppata/i,
        `the help no longer offers Grouped: ${section.slice(0, 80)}…`);
}

console.log('Histogram bar-mode checks passed.');
