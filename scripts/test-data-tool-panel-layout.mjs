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

// ── Overflowing coefficient lists say so ──────────────────────────────────
//
// `text-overflow: ellipsis` was tried first and is not sufficient: Chromium
// refuses to ellipsize a FOCUSED editable field, which is the moment that
// matters most (you have just typed eight coefficients and want to know whether
// they all landed), and it only ever marks the right-hand end while a field
// scrolled to its end hides text on the left. So the marker is drawn here.
assert.match(css, /\.derived-input\s*\{[^}]*text-overflow:\s*ellipsis/s, 'the native ellipsis is still worth having');

// And nothing may move a field's scroll on its behalf. Forcing every unfocused
// field back to its first character is the only way to make the native ellipsis
// paint, and it threw away where the user had scrolled to: clicking back into a
// long list to edit its last coefficient landed at the beginning again. Marking
// the hidden side works at any scroll position, so the rewind is not a trade-off
// worth having — it is simply unnecessary.
assert.doesNotMatch(dataTools, /scrollLeft = 0/, 'the panel must not reset a field’s scroll position');
assert.doesNotMatch(dataTools, /_rewindDataToolInputs/, 'the rewind is gone, not merely unused');

// Each side is marked independently, because either side can be the one hiding
// something — and both can be at once.
for (const side of ['left', 'right']) {
    assert.match(
        css,
        new RegExp(`\\.data-tool-input-overflow\\.overflow-${side}::${side === 'left' ? 'before' : 'after'}`),
        `an overflow on the ${side} must have its own marker`,
    );
}
assert.match(css, /\.data-tool-input-overflow::before,\s*\r?\n\.data-tool-input-overflow::after\s*\{[^}]*content:\s*'…'/s,
    'the marker is an ellipsis character');
assert.match(css, /\.data-tool-input-overflow::before,[\s\S]*?pointer-events:\s*none/s,
    'the marker must never intercept a click meant for the field');
assert.match(css, /\.data-tool-input-overflow\s*\{[^}]*position:\s*relative/s,
    'the wrapper must be a positioning context');

assert.match(dataTools, /_syncDataToolOverflowMarks/, 'the markers need a driver');
assert.match(
    dataTools,
    /overflow-left['"],\s*hidesLeft\)/,
    'the left marker must key off the field being scrolled away from its start',
);
assert.match(
    dataTools,
    /scrollWidth - input\.clientWidth - input\.scrollLeft/,
    'the right marker must key off text remaining beyond the visible end',
);
// Panel syncs alone are not enough: the caret and the field's own scrolling both
// change which side is hidden without the panel being touched. focusin/focusout
// rather than focus/blur, because only the former pair bubbles to the section.
const markerEvents = dataTools.match(
    /for \(const eventName of \[([^\]]+)\]\) \{\s*\r?\n\s*section\?\.addEventListener\(eventName, \(\) => this\._syncDataToolOverflowMarks\(\)\);/,
);
assert.ok(markerEvents, 'the markers must be refreshed from a list of events on the section');
for (const eventName of ['input', 'keyup', 'click', 'focusin', 'focusout']) {
    assert.match(markerEvents[1], new RegExp(`'${eventName}'`), `${eventName} must refresh the markers`);
}
assert.match(
    dataTools,
    /addEventListener\('scroll'[\s\S]*?\{ capture: true \}/,
    'a scroll inside the field only reaches the section with capture',
);
assert.doesNotMatch(
    dataTools,
    /addEventListener\('focus',/,
    'plain focus does not bubble, so it would never fire here',
);

// Every field long enough to need a marker has to be wrapped for one.
for (const id of ['filter-b', 'filter-a', 'filter-init-level', 'filter-init-x', 'filter-init-y']) {
    assert.match(
        html,
        new RegExp(`<div class="data-tool-input-overflow">\\s*\\r?\\n\\s*<input id="${id}"`),
        `#${id} must sit inside an overflow wrapper`,
    );
}

// An invalid configuration must take the preview down, in both of its forms.
assert.match(dataTools, /_abandonDataToolPreview/, 'there must be one way to take a preview down');
assert.match(
    dataTools,
    /_abandonDataToolPreview = function\(\)\s*\{[^}]*_clearDataToolPreview\(\);[^}]*_restoreEditedTraceValues\(\)/s,
    'abandoning must clear a draft trace AND restore an edited one',
);

console.log('data tool panel layout checks passed');
