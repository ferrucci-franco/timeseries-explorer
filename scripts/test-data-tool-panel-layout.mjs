// Layout guards for the Data Tools panel.
//
// The reason this file exists: the filter's initial-condition fields were
// renamed, the JS kept toggling `collapsed` on the new ids, and the CSS rule
// still named the old one — so every convention's fields showed at once. The
// unit tests passed throughout, because they asserted the CLASS was toggled and
// a class that no rule matches hides nothing. Whether an element can actually be
// hidden is a fact about the stylesheet, so it is checked against the stylesheet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('src/styles/sidebar.css');
const dataTools = read('src/app/methods/data-tools-methods.js');
const filter = read('src/app/methods/filter-methods.js');
const resample = read('src/app/methods/resample-methods.js');
const scripts = `${dataTools}\n${filter}\n${resample}`;

// ── Every wrap the panel collapses must have a rule that collapses it ──────

// Ids the panel toggles `collapsed` on, read out of the source rather than
// listed here, so a future rename cannot silently escape this check.
const toggled = new Set();
for (const match of scripts.matchAll(/getElementById\('([\w-]+)'\)\?\.classList\s*\n?\s*\.?toggle\('collapsed'/g)) {
    toggled.add(match[1]);
}
for (const match of scripts.matchAll(/getElementById\('([\w-]+)'\)\?\.classList\.toggle\('collapsed'/g)) {
    toggled.add(match[1]);
}
assert.ok(toggled.size >= 5, `expected several collapsible wraps, found ${toggled.size}`);

for (const id of toggled) {
    assert.match(
        css,
        new RegExp(`#${id}\\.collapsed\\b`),
        `#${id} is toggled with .collapsed in JS but sidebar.css has no #${id}.collapsed rule, so the class hides nothing`,
    );
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is toggled but does not exist in the markup`);
}

// The class-based collapses (a whole tool's controls, a method's sub-controls)
// need the same guarantee.
for (const selector of ['.data-tool-controls', '.outlier-method-controls', '.resample-grid-controls']) {
    assert.match(
        css,
        new RegExp(`\\${selector}\\.collapsed`),
        `${selector}.collapsed must be a real rule`,
    );
}

// ── Ids referenced by the panel must exist in the markup ──────────────────

for (const match of html.matchAll(/id="(filter-[\w-]+)"/g)) {
    // Every filter control in the markup should be reachable from the code that
    // drives it; an orphan is either dead markup or a rename half-done.
    const id = match[1];
    if (id.endsWith('-popover') || id.endsWith('-title')) continue;
    assert.match(scripts, new RegExp(`['"]${id}['"]`), `#${id} exists in the markup but no code reads it`);
}

// ── The filter's own layout promises ──────────────────────────────────────

// One field group per initial-condition convention, and each one collapsible.
for (const id of ['filter-init-level-wrap', 'filter-init-past-wrap']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="collapsed"|id="${id}" class="collapsed"`),
        `#${id} must start collapsed so nothing shows before a convention is chosen`);
}

// Past inputs and past outputs are separate fields: a single box made their
// order something the user had to be told rather than see.
for (const id of ['filter-init-x', 'filter-init-y']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} must exist as its own field`);
}
assert.doesNotMatch(html, /id="filter-init-state"/, 'the combined state field is gone');

// Group headings carry the hairline; field labels step down. Without the two
// styles every label sat at one weight and nothing said which control belonged
// under which heading.
assert.match(css, /\.data-tool-group-row\s*\{[^}]*border-top:/s, 'group headings need their separator');
assert.match(css, /\.data-tool-sublabel\s*\{[^}]*font-weight:\s*500/s, 'field labels must be lighter than headings');
assert.equal(
    [...html.matchAll(/class="data-tool-label-row data-tool-group-row/g)].length,
    4,
    'the filter panel has four control groups',
);
assert.equal(
    [...html.matchAll(/data-tool-group-row first"/g)].length,
    1,
    'only the first group skips the separator above it',
);

// The ellipsis needs both halves: the CSS, and the rewind that makes it paint.
// Chromium only draws it while the field is scrolled to its start, and typing
// leaves it scrolled to the end — the CSS alone did nothing visible.
assert.match(css, /\.derived-input\s*\{[^}]*text-overflow:\s*ellipsis/s, 'inputs must be able to show an ellipsis');
assert.match(dataTools, /_rewindDataToolInputs/, 'there must be a rewind, or the ellipsis never paints');
assert.match(
    dataTools,
    /_rewindDataToolInputs = function\(\)[\s\S]*?document\.activeElement[\s\S]*?scrollLeft = 0/,
    'the rewind must skip the field being typed in',
);
// A blur is the obvious trigger, but not the only one a value can arrive by.
assert.match(dataTools, /addEventListener\('focusout'/, 'losing focus should rewind immediately');
assert.match(
    dataTools,
    /this\._rewindDataToolInputs\(\);/,
    'and a panel sync should rewind too, for values that arrive without any focus at all',
);

// An invalid configuration must take the preview down, in both of its forms.
assert.match(dataTools, /_abandonDataToolPreview/, 'there must be one way to take a preview down');
assert.match(
    dataTools,
    /_abandonDataToolPreview = function\(\)\s*\{[^}]*_clearDataToolPreview\(\);[^}]*_restoreEditedTraceValues\(\)/s,
    'abandoning must clear a draft trace AND restore an edited one',
);

console.log('data tool panel layout checks passed');
