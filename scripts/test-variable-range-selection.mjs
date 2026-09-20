// Shift+click selects a range of variables (#148).
//
// The tree already had Ctrl+click multi-selection, but Shift was not read at
// all — so a Shift+click fell into the plain-click branch and CLEARED the
// selection being built. Twenty contiguous variables meant twenty Ctrl+clicks,
// and one slip started over.
//
// Two halves: the slicing, which is pure, and the anchor behaviour, which runs
// the real method against a harness whose list of visible names is stubbed
// (the real one reads the DOM, and what it reads was checked in a browser).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { namesBetween } from '../src/utils/selection-range.js';
import { installTreeMethods } from '../src/app/methods/tree-methods.js';

const LIST = ['a', 'b', 'c', 'd', 'e'];

// ── The slice ───────────────────────────────────────────────────────────────
assert.deepEqual(namesBetween(LIST, 'b', 'd'), ['b', 'c', 'd']);
assert.deepEqual(namesBetween(LIST, 'd', 'b'), ['b', 'c', 'd'], 'either way round, in list order');
assert.deepEqual(namesBetween(LIST, 'c', 'c'), ['c'], 'a range of one is the one');
assert.deepEqual(namesBetween(LIST, 'a', 'e'), LIST, 'end to end');

// A stale anchor degrades to a plain click, not to the whole list: selecting
// everything because the starting point scrolled out of view is the kind of
// surprise that costs a re-plot.
assert.deepEqual(namesBetween(LIST, null, 'c'), ['c'], 'no anchor');
assert.deepEqual(namesBetween(LIST, undefined, 'c'), ['c']);
assert.deepEqual(namesBetween(LIST, 'gone', 'c'), ['c'], 'an anchor no longer in the list');

// Clicking something the list does not contain selects nothing: it is not a
// range of one, it is a question about an entry that is not there.
assert.deepEqual(namesBetween(LIST, 'a', 'gone'), []);
assert.deepEqual(namesBetween([], 'a', 'b'), []);
assert.deepEqual(namesBetween(null, 'a', 'b'), [], 'no list at all');

// ── The anchor ──────────────────────────────────────────────────────────────
class Harness {
    constructor(visible) {
        this.selectedVariables = new Set();
        this._selectionAnchor = null;
        this.syncs = 0;
        this._visibleSelectableVariableNames = () => visible;
        this._syncVariableSelectionUI = () => { this.syncs++; };
    }
    get selection() { return [...this.selectedVariables]; }
}
installTreeMethods(Harness);

// A click, then a Shift+click: the range, and the anchor stays where it was.
{
    const app = new Harness(['m', 'n', 'o', 'p']);
    app._toggleVariableSelection('m');
    assert.deepEqual(app.selection, ['m']);
    assert.equal(app._selectionAnchor, 'm', 'a non-Shift click sets where the next range starts');

    app._selectVariableRange('p');
    assert.deepEqual(app.selection, ['m', 'n', 'o', 'p']);
    assert.equal(app._selectionAnchor, 'm', 'the anchor does not walk with the range');

    // The point of not moving it: a second Shift+click re-ranges from the same
    // place rather than from wherever the first one landed.
    app._selectVariableRange('n');
    assert.deepEqual(app.selection, ['m', 'n'], 'shrinking the range, not extending from p');
    app._selectVariableRange('m');
    assert.deepEqual(app.selection, ['m'], 'back to the anchor alone');
}

// Replacing against adding.
{
    const app = new Harness(['a', 'b', 'c', 'd', 'e']);
    app._toggleVariableSelection('a');
    app._selectVariableRange('b');
    assert.deepEqual(app.selection, ['a', 'b']);
    app._toggleVariableSelection('d');
    assert.deepEqual(app.selection, ['a', 'b', 'd'], 'Ctrl+click still toggles');
    assert.equal(app._selectionAnchor, 'd', 'and moves the anchor');
    app._selectVariableRange('e', { add: true });
    assert.deepEqual(app.selection, ['a', 'b', 'd', 'e'], 'Ctrl+Shift adds the range');
    app._selectVariableRange('e');
    assert.deepEqual(app.selection, ['d', 'e'], 'Shift alone replaces it');
}

// A Shift+click out of nowhere selects that one and becomes the anchor, so the
// next Shift+click has somewhere to range from.
{
    const app = new Harness(['a', 'b', 'c']);
    app._selectVariableRange('b');
    assert.deepEqual(app.selection, ['b']);
    assert.equal(app._selectionAnchor, 'b');
    app._selectVariableRange('c');
    assert.deepEqual(app.selection, ['b', 'c']);
}

// A range that resolves to nothing changes nothing — not even the selection it
// would have replaced.
{
    const app = new Harness(['a', 'b']);
    app._toggleVariableSelection('a');
    const syncs = app.syncs;
    app._selectVariableRange('hidden');
    assert.deepEqual(app.selection, ['a'], 'the existing selection survives');
    assert.equal(app.syncs, syncs, 'and nothing is re-rendered');
}

// ── Forgetting the anchor ───────────────────────────────────────────────────
// It outlives a cleared selection otherwise, and a range starting from a
// variable last touched three files ago is not a range anyone asked for.
{
    const app = new Harness(['a', 'b']);
    app._toggleVariableSelection('a');
    app._clearVariableSelection();
    assert.equal(app._selectionAnchor, null, 'clearing forgets it');
}
{
    const app = new Harness(['a', 'b']);
    app._selectionAnchor = 'a';
    // Already empty: the early return must not skip the anchor.
    app._clearVariableSelection();
    assert.equal(app._selectionAnchor, null, 'even when the set was already empty');
}
// A reload that drops the anchor's variable drops the anchor with it.
{
    const app = new Harness(['a', 'b']);
    app._toggleVariableSelection('b');
    app._toggleVariableSelection('a');   // 'a' is now the anchor
    app._retainVariableSelectionForData({ variables: { b: {} } });
    assert.deepEqual(app.selection, ['b'], 'the vanished variable leaves the selection');
    assert.equal(app._selectionAnchor, null, 'and the anchor it was goes with it');
}
{
    const app = new Harness(['a', 'b']);
    app._toggleVariableSelection('a');
    app._retainVariableSelectionForData({ variables: { a: {}, b: {} } });
    assert.equal(app._selectionAnchor, 'a', 'an anchor that is still there stays');
}

// ── What the DOM read has to be ─────────────────────────────────────────────
const tree = readFileSync(new URL('../src/app/methods/tree-methods.js', import.meta.url), 'utf8');
const reader = tree.slice(tree.indexOf('proto._visibleSelectableVariableNames'));
const readerBody = reader.slice(0, reader.indexOf('\n};'));
// "Contiguous" is a question about what the user is looking at.
assert.match(readerBody, /item\.offsetParent !== null/,
    'a collapsed group is display:none, and its leaves are not in the range');
assert.match(readerBody, /:not\(\[data-file-id\]\)/,
    'foreign leaves stay out, as they already do everywhere else');
// Exactly what Ctrl+click would take — including the time axis, which carries
// no such class and IS selectable today.
assert.match(readerBody, /:not\(\.tree-item-nonplottable\)/,
    'and a leaf Ctrl+click would refuse is refused here too');

const handler = tree.slice(tree.indexOf("itemDiv.addEventListener('click'"));
const handlerBody = handler.slice(0, handler.indexOf("itemDiv.addEventListener('dragstart'"));
assert.match(handlerBody, /if \(e\.shiftKey\) \{[\s\S]{0,400}?_selectVariableRange\(variable\.name, \{ add: e\.ctrlKey \|\| e\.metaKey \}\)/,
    'Shift ranges, and Ctrl+Shift adds');
// Shift+click extends the browser's own text selection, which would streak the
// sidebar blue behind the range.
assert.match(handlerBody, /if \(e\.shiftKey\) \{[\s\S]{0,200}?e\.preventDefault\(\);/, 'the text selection is suppressed');
assert.match(handlerBody, /window\.getSelection\?\.\(\)\?\.removeAllRanges\(\)/, 'and any already made is dropped');
// Shift must be read BEFORE Ctrl, or Ctrl+Shift would toggle instead of range.
assert.ok(handlerBody.indexOf('e.shiftKey') < handlerBody.indexOf('e.ctrlKey || e.metaKey'),
    'Shift is tested first, so Ctrl+Shift is a range and not a toggle');
// A plain click on an empty selection still arms the next range.
assert.match(handlerBody, /\} else \{[\s\S]{0,220}?this\._selectionAnchor = variable\.name;/,
    'a plain click on nothing still sets the anchor');

console.log('Variable range-selection checks passed.');
