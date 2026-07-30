// The top bar slides when its controls do not fit.
//
// The one thing this must never become is `overflow-x: auto`. CSS cannot scroll
// one axis while staying visible on the other, so any overflow on this bar would
// also clip the dropdown menus that hang below it — verified in the browser: the
// extra menu opens 363px tall out of a 60px bar. Translating the two halves
// keeps the menus anchored to their buttons and travelling with them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');

const topBarRule = css.match(/\n\.top-bar \{[^}]*\}/g)?.join('\n') ?? '';
assert.ok(topBarRule, 'the .top-bar rule is present');
assert.doesNotMatch(topBarRule, /overflow(-x)?:\s*(auto|scroll)/,
    'the bar never scrolls: overflow here would clip the dropdown menus below it');
assert.match(topBarRule, /--top-bar-shift:\s*0px/, 'the slide offset starts at rest');

assert.match(css, /\.top-bar-left,\s*\n\.top-bar-right \{\s*\n\s*transform: translateX\(var\(--top-bar-shift\)\)/,
    'both halves shift together, so the layout between them never distorts');
assert.match(css, /\.top-bar\.top-bar-more-right::after \{\s*\n\s*opacity: 1/,
    'a soft edge — not a scrollbar — is the only hint that there is more to reach');
assert.match(css, /\.top-bar::after \{[^}]*pointer-events: none/,
    'the hint never swallows a click meant for a button under it');

const slide = js.slice(js.indexOf('proto.initTopBarSlide'), js.indexOf('proto.initSidebarResize'));
assert.ok(slide.length > 200, 'the slide implementation is present');

// Layout pixels, not screen pixels: offsetLeft/offsetWidth are free of both the
// slide's own transform and the phone stage's scale and quarter turn.
assert.match(slide, /right\.offsetLeft \+ right\.offsetWidth/,
    'what fits is measured in layout pixels, immune to the transforms in play');
assert.doesNotMatch(slide.match(/const overflowAmount[\s\S]*?\};/)?.[0] ?? '', /getBoundingClientRect/,
    'the overflow measurement does not mix screen pixels into a layout-pixel sum');

// A finger drag on an upright phone runs down the screen, not across it.
assert.match(slide, /screenDeltaToStage\(/,
    'finger movement is converted through the stage transform, which swaps the axes when rotated');
assert.match(js, /import \{ screenDeltaToStage \} from '\.\.\/\.\.\/ui\/viewport-transform\.js'/,
    'the converter is imported');

assert.match(slide, /pointers\.size > 1/,
    'two fingers on the bar are the page pinch, not a slide');
// The live-update menu carries a range slider, inside the bar.
assert.match(slide, /OWNS_ITS_DRAG = 'input, select, textarea, \[contenteditable\], \.example-menu'/,
    'a control with its own drag keeps it — sliding a slider must not slide the bar');
assert.match(slide, /event\.target\.closest\?\.\(OWNS_ITS_DRAG\) \) return|closest\?\.\(OWNS_ITS_DRAG\)\) return/,
    'that exclusion is applied before a drag starts');
assert.match(slide, /suppressClick = drag\.moved/,
    'a drag that started on a button must not also press it');
assert.match(slide, /\{ capture: true \}/,
    'the suppressed click is caught before it reaches the button');
assert.match(slide, /new ResizeObserver/,
    're-measured as controls come and go, rather than measured once at startup');

console.log('Top bar slide tests passed.');
