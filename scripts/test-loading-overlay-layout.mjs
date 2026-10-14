import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
const rule = css.match(/#file-loading-overlay\s+\.example-loading-dialog\s*\{([^}]*)\}/)?.[1] || '';

assert.match(rule, /width\s*:\s*clamp\(22rem,\s*65vw,\s*48rem\)/,
    'file loading dialog uses 65% of the viewport within sensible limits');
assert.match(rule, /max-width\s*:\s*calc\(100vw\s*-\s*2rem\)/,
    'file loading dialog retains a safe margin on narrow screens');

// Only the backdrop fades. Fading the whole overlay left the dialog half
// transparent in Firefox while a load kept the main thread busy, with the
// page behind showing through its text and spinner.
const block = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? null;
};
const overlay = block('.example-loading-overlay');
assert.ok(overlay, 'the overlay has a rule');
assert.doesNotMatch(overlay, /opacity|transition/, 'the overlay itself, dialog included, does not fade');
assert.match(block('.example-loading-overlay::before') || '', /transition:\s*opacity/, 'its backdrop does');
assert.match(css, /\.example-loading-overlay:not\(\.show\) > \.example-loading-dialog[\s\S]{0,120}?visibility:\s*hidden;/,
    'the dialog is either hidden or fully opaque');

console.log('Loading overlay layout tests passed.');
