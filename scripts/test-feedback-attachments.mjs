// A screenshot dropped on the feedback form has to be visibly received (#44).
//
// The form is taller than its own scroll box and the attachment list sits at
// the bottom of it, so a dropped screenshot landed out of sight: "we drag a
// screenshot and it seems that nothing happens". It was being attached all
// along — just below the fold.
//
// The same drop also reached the app's own document-level drop handler, which
// tried to load the PNG as a data file. So the gesture attached the file AND
// raised a load failure nobody asked for.
//
// showFeedbackForm builds its DOM with Modal and document, so it cannot be
// imported here; the behaviour is asserted against the source, and was checked
// in a real browser (scrollTop 0 -> 194 on a 700 px window, no page errors).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const ui = read('src/app/methods/ui-methods.js');
const css = read('src/styles/overlays.css');

// ── The new rows are brought into view ──────────────────────────────────────
assert.match(ui, /const renderFiles = \(\{ highlightFrom = -1 \} = \{\}\) =>/,
    'renderFiles is told where the new attachments start');
assert.match(ui, /firstNewRow\?\.scrollIntoView\(\{ block: 'nearest', behavior: 'smooth' \}\)/,
    'the first new row is scrolled into view');
// `nearest` rather than `start`/`center`: the others scroll the page behind the
// dialog as well, and `nearest` does nothing when the row is already visible.
assert.doesNotMatch(ui, /scrollIntoView\(\{ block: '(start|center|end)'/,
    'the scroll must not reach past the form');

// ── And marked, for when nothing had to move ────────────────────────────────
assert.match(ui, /if \(highlightFrom >= 0 && index >= highlightFrom\) \{[\s\S]{0,140}?row\.classList\.add\('is-new'\)/,
    'rows from the new index on are marked');
assert.match(css, /\.feedback-file-list li\.is-new \{[\s\S]{0,120}?animation: feedback-file-added/,
    'and the marker is visible');
assert.match(css, /@keyframes feedback-file-added \{/, 'the animation exists');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?\.feedback-file-list li\.is-new/,
    'someone who asked for no motion still gets the colour');

// ── Only a real addition highlights ─────────────────────────────────────────
// renderFiles() with no argument is what the remove button and Clear call:
// re-rendering after a removal must not flash the rows that stayed.
assert.match(ui, /renderFiles\(\{ highlightFrom: attachedFiles\.length > firstNew \? firstNew : -1 \}\)/,
    'a drop that added nothing highlights nothing');
assert.match(ui, /const addFiles = \(files, source = 'file'\) => \{\s*\n\s*const firstNew = attachedFiles\.length;/,
    'the index is taken before the files are added');
for (const caller of ['releasePreview\\(removed\\);\\s*\\n\\s*renderFiles\\(\\)', 'this\\._feedbackDraft = null;\\s*\\n\\s*renderFiles\\(\\)']) {
    assert.match(ui, new RegExp(caller), 'removing and clearing re-render without highlighting');
}

// ── The drop stays inside the dialog ────────────────────────────────────────
const zone = ui.slice(ui.indexOf("pasteZone.addEventListener('paste'"));
const dropHandler = zone.slice(zone.indexOf("pasteZone.addEventListener('drop'"), zone.indexOf('emailButton'));
assert.match(dropHandler, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);/,
    'the drop must not also reach the app’s own file loader');
const dragoverHandler = zone.slice(zone.indexOf("pasteZone.addEventListener('dragover'"), zone.indexOf("pasteZone.addEventListener('dragleave'"));
assert.match(dragoverHandler, /event\.stopPropagation\(\);/,
    'nor should the dragover raise the app’s drop target over the dialog');

// The handler it is being kept away from: if this ever stops loading files,
// the stopPropagation above needs revisiting rather than silently doing nothing.
assert.match(ui, /document\.addEventListener\('drop'[\s\S]{0,400}?await this\.loadFiles\(files\)/,
    'the document-level drop handler still loads what reaches it');

console.log('Feedback attachment checks passed.');
