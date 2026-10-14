// A 14" laptop at 125 % scaling, or a window snapped to half the screen, is
// narrower than the desktop layout was drawn for, yet too big for the phone
// layout. Three things went wrong there in class:
//   - the top bar's row of buttons kept its width and pushed the last ones
//     (theme, menu) out of the window, out of reach;
//   - below 768 px the sidebar floated over the content, hiding half of the
//     drop zone and its notice;
//   - the sidebar's pill stayed in the layout, at the window's left border,
//     instead of on the sidebar's edge.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [base, content, overlays, ui, live, scroll] = await Promise.all([
    read('src/styles/base.css'),
    read('src/styles/content.css'),
    read('src/styles/overlays.css'),
    read('src/app/methods/ui-methods.js'),
    read('src/app/methods/live-update-methods.js'),
    read('src/ui/top-bar-scroll.js'),
]);

const rule = (css, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${selector} has a rule`);
    return match[1];
};

// The row scrolls instead of overflowing the window.
const row = rule(base, '.top-bar-right');
assert.match(row, /min-width:\s*0/, 'the row may shrink below its content');
assert.match(row, /overflow-x:\s*auto/, 'the row scrolls sideways');
assert.match(rule(base, '.top-bar-right > *'), /flex-shrink:\s*0/, 'the buttons keep their size');
assert.match(rule(base, '.top-bar-left'), /overflow:\s*hidden/, 'a squeezed brand is clipped, not drawn under the buttons');
assert.match(ui, /initTopBarScroll\(topBar\.querySelector\('\.top-bar-right'\)\)/, 'the scrolling row is set up at startup');

// Its menus escape the scroller's clipping.
assert.match(scroll, /menu\.style\.position = 'fixed'/, 'top bar menus are placed with fixed coordinates');
assert.equal(ui.match(/placeTopBarMenu\(menu, /g)?.length, 2, 'the example and extra menus are placed under their button');
assert.match(live, /placeTopBarMenu\(menu, /, 'the live update menu is placed under its button');
assert.doesNotMatch(scroll, /mask-image/, 'no mask: it would hide the menus too');
assert.doesNotMatch(base, /\.top-bar-right[^{]*\{[^}]*mask-image/, 'no mask on the row');

// The sidebar stays beside the content on a narrow window.
const narrow = overlays.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/);
assert.ok(narrow, 'the narrow-window block exists');
assert.doesNotMatch(narrow[1], /\.sidebar\s*\{[^}]*position:\s*absolute/, 'the sidebar does not float over the content');

// The drop zone's content fits the drop zone, not the window.
assert.match(rule(content, '.drop-zone-content'), /max-width:\s*min\(1040px, 100%\)/, 'the drop zone content fits beside the sidebar');
assert.match(rule(content, '.light-version-notice'), /max-width:\s*min\(920px, 100%\)/, 'the notice fits beside the sidebar');

console.log('Narrow window layout regression tests passed.');
