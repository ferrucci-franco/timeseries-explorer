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

// The anchors appear only once a non-causal filter is asked for; a causal one
// is the panel it always was.
assert.match(html, /id="filter-anchor-wrap"[^>]*class="collapsed"/,
    '#filter-anchor-wrap must start collapsed so Da and Db show only when they mean something');
for (const id of ['filter-advance-a', 'filter-advance-b']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*type="number"`), `#${id} must be a number field, so it carries a stepper`);
}
// The equation box is never collapsed: it describes the filter in the boxes
// above whether or not anything about causality has been chosen.
assert.match(html, /id="filter-equation"/, 'the equation box must exist');
assert.doesNotMatch(html, /id="filter-equation"[^>]*class="[^"]*collapsed/, 'the equation box is always shown');

// "Forward (causal)" stopped being true the moment an advance became possible:
// forward with Db > Da runs forward and is not causal.
assert.doesNotMatch(read('src/i18n/translations.js'), /dataToolFilterForward: '[^']*causal/i,
    'the direction option must not claim causality, which is now its own control');

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

// Counted per panel, not across the file: the hierarchy is a promise each tool
// makes on its own, and a global count would drift with every tool added.
const panels = new Map();
for (const match of html.matchAll(/data-tool-kind="(\w+)"/g)) {
    const rest = html.slice(match.index);
    const end = rest.indexOf('data-tool-kind="', match[0].length);
    panels.set(match[1], end < 0 ? rest : rest.slice(0, end));
}

for (const [kind, groups] of [['filter', 5], ['resample', 3]]) {
    const panel = panels.get(kind);
    assert.ok(panel, `the ${kind} panel must exist`);
    assert.equal(
        [...panel.matchAll(/class="data-tool-label-row data-tool-group-row/g)].length,
        groups,
        `the ${kind} panel has ${groups} control groups`,
    );
    assert.equal(
        [...panel.matchAll(/data-tool-group-row first"/g)].length,
        1,
        `in the ${kind} panel only the first group skips the separator above it`,
    );
}

// The gap policy heads its own control group; it spent a commit styled as a
// field label under Method, which read as if it belonged to the method.
assert.doesNotMatch(
    panels.get('resample'),
    /data-tool-sublabel"? for="resample-gap-policy"/,
    'the gap policy is a group heading, not a field of the one above it',
);

// The summary writes one fact per line with textContent, so the newlines only
// show if the stylesheet preserves them — asserting the JS emits '\n' would
// prove nothing about what is painted.
assert.match(
    resample,
    /lines\.join\('\\n'\)/,
    'the resample summary is assembled as separate lines',
);
assert.match(
    css,
    /\.data-tool-resample-info\s*\{[^}]*white-space:\s*pre-line/s,
    'the summary box must preserve the newlines it is given',
);

// ── Overflowing coefficient lists say so ──────────────────────────────────
//
// `text-overflow: ellipsis` was tried first and is not sufficient: Chromium
// refuses to ellipsize a FOCUSED editable field, which is the moment that
// matters most (you have just typed eight coefficients and want to know whether
// they all landed), and it only ever marks the right-hand end while a field
// scrolled to its end hides text on the left. So the marker is drawn here.
assert.match(css, /\.derived-input\s*\{[^}]*text-overflow:\s*ellipsis/s, 'the native ellipsis is still worth having');
// ...but not on the coefficient fields: on an UNFOCUSED input Chromium paints the
// ellipsized line from the current scroll offset and drops the rest, so a field
// scrolled by its arrows showed "ros(5000), 0…" and looked as if nothing had moved.
assert.match(css, /\.data-tool-coefficients\s*\{[^}]*text-overflow:\s*clip/s, 'coefficient fields must not ellipsize');

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
// The marker is in two layers: a click-through fade under the text, and an
// arrow button on the same side that scrolls towards what is hidden. An
// ellipsis alone told the reader something they could not act on — a list of
// 2400 coefficients that says "…" at both ends still cannot be read.
assert.match(css, /\.data-tool-input-overflow::before,[\s\S]*?pointer-events:\s*none/s,
    'the fade must never intercept a click meant for the field');
assert.match(css, /\.data-tool-input-overflow\s*\{[^}]*position:\s*relative/s,
    'the wrapper must be a positioning context');
// NOTHING beside the field may appear or disappear. Adding or removing a box
// next to a text input — a pseudo-element switching from display: none, an
// arrow showing up — makes Gecko rebuild the input's frame, and a rebuilt text
// control is scrolled back to 0; with the marks refreshed on every keystroke and
// scroll, Firefox could not be scrolled past the first screen of a long list at
// all. So both arrows are always in the row (an idle one is disabled) and both
// fades are always present (an idle one is transparent): style, not structure.
assert.match(css, /\.data-tool-scroll\s*\{[^}]*display:\s*inline-flex/s, 'the arrows are always in the row');
assert.doesNotMatch(css, /\.data-tool-scroll[^{]*\{[^}]*display:\s*none/s, 'no arrow is ever display: none');
assert.match(css, /\.data-tool-scroll:disabled\s*\{[^}]*opacity/s, 'an idle arrow is greyed, not removed');
assert.doesNotMatch(css, /\.data-tool-input-overflow::before,\s*\r?\n\.data-tool-input-overflow::after\s*\{[^}]*display:\s*none/s,
    'the fades are never display: none');
assert.match(css, /\.data-tool-input-overflow\.overflow-left::before,\s*\r?\n\.data-tool-input-overflow\.overflow-right::after\s*\{[^}]*opacity:\s*1/s,
    'a fade is shown by opacity');
assert.match(dataTools, /left\.disabled = !hidesLeft/, 'the left arrow is disabled, not hidden, when idle');
assert.match(dataTools, /right\.disabled = !hidesRight/, 'the right arrow is disabled, not hidden, when idle');
// Beside the field, not over it: a button laid over the text hides the very
// characters the reader scrolled to see. The wrapper is a flex row, the field
// shrinks to make room (a text input's intrinsic minimum width would otherwise
// push the arrows out of the sidebar), and the left arrow is ordered in front.
assert.match(css, /\.data-tool-input-overflow\s*\{[^}]*display:\s*flex/s, 'the wrapper is a flex row');
assert.match(css, /\.data-tool-input-overflow > \.data-tool-coefficients\s*\{[^}]*min-width:\s*0/s, 'the field must be allowed to shrink');
assert.match(css, /\.data-tool-scroll-left\s*\{[^}]*order:\s*-1/s, 'the left arrow goes before the field');
assert.doesNotMatch(css, /\.data-tool-scroll\s*\{[^}]*position:\s*absolute/s, 'the arrows take their own space');
// With the row's shape constant there is nothing to re-measure and no scroll to
// restore: the sync reads once and never writes the field's scroll.
assert.doesNotMatch(
    dataTools.match(/proto\._syncDataToolOverflowMarks = function[\s\S]*?\n\};/)[0],
    /scrollLeft\s*=[^=]/,
    'the marks never move the field',
);
assert.match(dataTools, /_scrollDataToolInput/, 'the arrows need a driver');
assert.match(
    dataTools,
    /addEventListener\('mousedown', \(event\) => \{\s*\r?\n\s*if \(event\.target\?\.closest\?\.\('\.data-tool-scroll'\)\) event\.preventDefault\(\);/,
    'pressing an arrow must not pull focus out of the field',
);
// Not scrollBy({ behavior: 'smooth' }): Chromium drops a smooth scroll on a
// text input and the field does not move at all.
assert.match(dataTools, /input\.scrollLeft \+= step/, 'a click pages the field');
assert.doesNotMatch(dataTools, /input\.scrollBy\(/, 'no smooth scroll on a text input');

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

// Every field long enough to need a marker has to be wrapped for one, with
// its two arrows beside it — one per side, in the wrapper, after the field.
for (const id of ['filter-b', 'filter-a', 'filter-init-level', 'filter-init-x', 'filter-init-y']) {
    assert.match(
        html,
        new RegExp(`<div class="data-tool-input-overflow">\\s*\\r?\\n\\s*<input id="${id}"`),
        `#${id} must sit inside an overflow wrapper`,
    );
    for (const side of ['left', 'right']) {
        assert.match(
            html,
            new RegExp(`<input id="${id}"[^>]*>[\\s\\S]{0,1200}?<button class="data-tool-scroll data-tool-scroll-${side}" type="button" tabindex="-1"`),
            `#${id} must have a ${side} arrow, out of the tab order`,
        );
    }
}

// Editing a transformation fills a form that sits ABOVE the pencil that was
// pressed, out of view: the form has to be brought up, or nothing visibly
// happens (#117). Same courtesy as the derived-dataset edit.
const enterEditing = dataTools.match(/proto\._enterDataToolEditing = function[\s\S]*?\n\};/);
assert.ok(enterEditing, '_enterDataToolEditing must exist');
assert.match(
    enterEditing[0],
    /\.data-tools-section'\)\?\.scrollIntoView\?\.\(\{ block: 'start', behavior: 'smooth' \}\)/,
    'editing a transformation must scroll the Data Tools form into view',
);

// An invalid configuration must take the preview down, in both of its forms.
assert.match(dataTools, /_abandonDataToolPreview/, 'there must be one way to take a preview down');
assert.match(
    dataTools,
    /_abandonDataToolPreview = function\(\)\s*\{[^}]*_clearDataToolPreview\(\);[^}]*_restoreEditedTraceValues\(\)/s,
    'abandoning must clear a draft trace AND restore an edited one',
);

console.log('data tool panel layout checks passed');
