// The loading overlay needs a visible way out (#47).
//
// It only ever offered "Press Escape to cancel" — a hint for a key the user has
// no reason to guess applies. The Parquet conversion overlay in the same file
// has had a real button since it was written, and the reason it gives applies
// word for word here: work that runs for tens of seconds behind a modal with
// no exit reads as a hang.
//
// The overlay needs a document, so the behaviour is asserted against the
// source and was checked in a browser (button present with a token, absent
// without one, one click only, and a late progress report that does not
// overwrite the "Cancelling…" notice).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const files = read('src/app/methods/file-methods.js');
const css = read('src/styles/overlays.css');
const translations = read('src/i18n/translations.js');

// ── One button, built in one place ──────────────────────────────────────────
// Two overlays offered a way out and only one had a button. Sharing the
// builder is what keeps them from drifting apart again.
assert.match(files, /proto\._buildOverlayCancelButton = function\(onCancel\) \{/,
    'the cancel button has a single builder');
const builder = files.slice(files.indexOf('proto._buildOverlayCancelButton'));
const builderBody = builder.slice(0, builder.indexOf('\n};'));
assert.match(builderBody, /button\.className = 'modal-btn modal-btn-cancel example-loading-cancel';/,
    'it looks like the app’s other cancel buttons');
// A second click would cancel something already cancelled, and the label has
// to keep saying the first one was heard.
assert.match(builderBody, /if \(fired\) return;[\s\S]{0,120}?button\.disabled = true;/,
    'a second click does nothing');
assert.match(builderBody, /button\.textContent = i18n\.t\('cancellingConversion'\);/,
    'and the label says the request was heard');

const users = [...files.matchAll(/this\._buildOverlayCancelButton\(/g)];
assert.equal(users.length, 3,
    'every overlay calls it — file loading, Parquet conversion, and the busy overlay (#132)');

// ── The file-loading overlay uses it ────────────────────────────────────────
assert.match(files, /_showFileLoadingOverlay = function[\s\S]*?_syncFileLoadingCancelButton\(overlay, loadToken\)/,
    'a fresh overlay gets the button');
// A reused overlay may carry a button belonging to work that has finished.
assert.match(files, /_showFileLoadingOverlay = function[\s\S]*?_syncFileLoadingCancelButton\(existing, loadToken\)/,
    'and so does a reused one');
const sync = files.slice(files.indexOf('proto._syncFileLoadingCancelButton'));
const syncBody = sync.slice(0, sync.indexOf('\n};'));
assert.match(syncBody, /overlay\.querySelector\('#file-loading-cancel'\)\?\.remove\(\);/,
    'the old button goes before a new one arrives');
// A button that cannot cancel anything invites a second click, and a third.
assert.match(syncBody, /if \(!loadToken\) return;/, 'uncancellable work gets no button');
assert.match(syncBody, /loadToken\.cancelled = true;/, 'clicking it cancels');
// Escape takes the overlay down; the button must not, or the file still being
// parsed would run on behind a window with nothing on it.
assert.doesNotMatch(syncBody, /_hideFileLoadingOverlay/,
    'the button leaves the overlay up until the loop stops');
assert.match(syncBody, /_updateFileLoadingOverlayCancelling\(\)/, 'and says so in its place');

// ── A cancelled load stops being narrated ───────────────────────────────────
// The loop reports progress for the file it was already on; without this the
// count would be painted back over the notice.
assert.match(files, /_updateFileLoadingOverlay = function[\s\S]{0,260}?if \(this\._fileLoadingToken\?\.cancelled\) return;/,
    'a late progress report does not overwrite the cancelling notice');

// ── Escape still works, and agrees with the button ──────────────────────────
assert.match(files, /_installFileLoadingCancellation = function[\s\S]*?event\.key !== 'Escape'[\s\S]{0,200}?loadToken\.cancelled = true;/,
    'Escape still cancels');
// In the Parquet overlay Escape routes THROUGH the button, so one press cannot
// fire the callback while leaving the label saying "Cancel".
assert.match(files, /const onKey = \(event\) => \{ if \(event\.key === 'Escape'\) cancel\.click\(\); \};/,
    'Escape and the button are the same action there');

// ── The hint became a footnote ──────────────────────────────────────────────
assert.match(files, /const hint = dialog\.querySelector\('#file-loading-cancel-hint'\);[\s\S]{0,200}?insertBefore\(node, hint\)/,
    'the button sits above the Escape hint, not below it');
assert.match(css, /\.example-loading-cancel \+ #file-loading-cancel-hint \{/,
    'and is styled as one thing with it');
for (const match of translations.matchAll(/loadingFilesCancelHint: '([^']*)'/g)) {
    assert.ok(/^(or|ou|o) /i.test(match[1]),
        `the hint now reads as a footnote to the button, not as the only way out: "${match[1]}"`);
}
assert.equal((translations.match(/loadingFilesCancelHint:/g) || []).length, 4,
    'in all four languages');

console.log('Loading cancel-button checks passed.');
