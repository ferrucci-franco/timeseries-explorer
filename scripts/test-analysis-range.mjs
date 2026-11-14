// Every analysis asks for its time range with the SAME block, and a new one
// cannot be added with a block of its own.
//
//   node scripts/test-analysis-range.mjs
//
// The block — Full / Selection, then Start and End, each a field with a slider
// under it — lives in src/plots/methods/analysis-range-methods.js. It was
// copied nine times before that, and the copies drifted: two analyses had no
// sliders at all, the tooltips did not match, one rounded the number in the
// field and another did not. So this test reads the sources and fails if an
// analysis builds the block itself:
//
//   · every analysis the Analysis menus offer builds its range with
//     _buildAnalysisRangeSection and syncs it with _syncAnalysisRangeSection;
//   · nobody else creates a `.fft-range-grid`, a `.fft-range-bound` or a
//     `.fft-segmented` for a range, nor an `input type="range"` of class
//     `fft-range-input` (the FFT axis limits are the one exception: they are
//     not a time range);
//   · the builder gives both bounds a slider, the generic tooltips, and the
//     same data attributes the panels look their controls up by;
//   · the labels and tooltips it uses exist in every language.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const has = (text, pattern, message) => assert.ok(pattern.test(text), message);

const shared = read('src/plots/methods/analysis-range-methods.js');
const marks = read('src/plots/methods/marks-methods.js');

// ── The shared block itself ───────────────────────────────────────
has(shared, /_buildAnalysisRangeSection = function/, 'the builder exists');
has(shared, /_syncAnalysisRangeSection = function/, 'and the sync');
has(shared, /ANALYSIS_RANGE_BOUNDS = \[/, 'the two bounds are listed in one place');
for (const key of ['fftRangeFull', 'fftRangeSelection', 'fftRangeStart', 'fftRangeEnd', 'fftRange']) {
    has(shared, new RegExp(`'${key}'`), `the block uses the ${key} label`);
}
for (const key of ['analysisRangeFullTooltip', 'analysisRangeSelectionTooltip', 'analysisRangeStartTooltip', 'analysisRangeEndTooltip']) {
    has(shared, new RegExp(key), `and the ${key} tooltip`);
}
// Both bounds get a slider: the point of the exercise.
has(shared, /type = 'range'/, 'each bound has a slider');
has(shared, /className = 'fft-range-input'/, 'with the shared slider class');
has(shared, /className = 'fft-range-grid analysis-range-grid'/, 'in the shared grid');
has(shared, /className = 'fft-segmented analysis-range-segmented'/, 'under the shared Full / Selection buttons');
has(shared, /dataset\.analysisRangeKey = key/, 'the controls carry which bound they are');
has(shared, /dataset\.analysisRangeRole = 'input'/, 'and whether they are the field');
has(shared, /dataset\.analysisRangeRole = 'slider'/, 'or the slider');
has(shared, /dataset\[`\$\{prefix\}Key`\] = key/, "and the panel's own key, so its code finds them");
has(shared, /fft-range-bound-datetime/, 'a calendar axis gets the wider bound');

// ── Every analysis uses it, and nobody rolls their own ────────────
const modesBlock = marks.slice(marks.indexOf('proto._analysisModes = function(plot) {'), marks.indexOf('proto._activeAnalysisId'));
const offered = [...modesBlock.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map(match => match[1]);
assert.ok(offered.length >= 9, `the analyses on offer (${offered.join(', ')})`);

// Which file holds each analysis' panel. A new analysis adds its own line.
const PANEL_FILE = {
    fft: 'fft-methods.js',
    histogram: 'histogram-methods.js',
    heatmap: 'heatmap-methods.js',
    'temporal-profile': 'temporal-profile-methods.js',
    integral: 'integral-methods.js',
    correlation: 'correlation-methods.js',
    'phase2d-fit': 'phase2d-fit-methods.js',
    'curve-fit': 'curve-fit-methods.js',
    trend: 'trend-methods.js',
};
for (const id of offered) {
    const file = PANEL_FILE[id];
    assert.ok(file, `${id}: this test must know which file holds its panel (add it to PANEL_FILE)`);
    const source = read(`src/plots/methods/${file}`);
    has(source, /_buildAnalysisRangeSection\(\{/, `${id}: builds its range with the shared block`);
    has(source, /_syncAnalysisRangeSection\(/, `${id}: and syncs it with the shared one`);
    has(source, /prefix: '[a-zA-Z0-9]+'/, `${id}: naming the data attributes its own code uses`);
}

// Nothing else may build the block. Read every methods file: the only place
// these classes are created is the shared module.
const methodsDir = new URL('../src/plots/methods/', import.meta.url);
const offenders = [];
for (const name of readdirSync(methodsDir)) {
    if (!name.endsWith('.js') || name === 'analysis-range-methods.js') continue;
    const source = read(`src/plots/methods/${name}`);
    const lines = source.split('\n');
    lines.forEach((line, index) => {
        // `fft-range-input` on an axis-limit slider is not a time range.
        if (/fft-axis-limit-slider/.test(line)) return;
        // The Trend band's two value bounds borrow the same two-up layout,
        // and say so in their class; they are not a time range.
        if (/'fft-range-grid|"fft-range-grid|'fft-range-bound|"fft-range-bound|'fft-segmented|"fft-segmented/.test(line)
            && !/trend-band/.test(line)) {
            offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
    });
}
assert.deepEqual(offenders, [], `the range block is built only in analysis-range-methods.js:\n${offenders.join('\n')}`);

// The old per-analysis formatting helpers are gone with the copies.
for (const name of ['curve-fit-methods.js', 'trend-methods.js', 'correlation-methods.js', 'phase2d-fit-methods.js']) {
    const source = read(`src/plots/methods/${name}`);
    assert.ok(!/MsToDatetimeInput = |msToDatetimeInput = \(/.test(source),
        `${name}: no private datetime-input helper beside the shared block's`);
}

// ── The texts, in every language ──────────────────────────────────
const translations = read('src/i18n/translations.js');
const LANGS = ['en', 'fr', 'es', 'it', 'zh'];
for (const key of ['fftRange', 'fftRangeFull', 'fftRangeSelection', 'fftRangeStart', 'fftRangeEnd',
    'analysisRangeFullTooltip', 'analysisRangeSelectionTooltip', 'analysisRangeStartTooltip', 'analysisRangeEndTooltip']) {
    const count = [...translations.matchAll(new RegExp(`^\\s+${key}:`, 'gm'))].length;
    assert.ok(count >= LANGS.length, `${key}: in all ${LANGS.length} languages (found ${count})`);
}

console.log('the analyses all ask for their range with the same block: ok');
