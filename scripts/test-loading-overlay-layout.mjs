import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
const rule = css.match(/#file-loading-overlay\s+\.example-loading-dialog\s*\{([^}]*)\}/)?.[1] || '';

assert.match(rule, /width\s*:\s*clamp\(22rem,\s*65vw,\s*48rem\)/,
    'file loading dialog uses 65% of the viewport within sensible limits');
assert.match(rule, /max-width\s*:\s*calc\(100vw\s*-\s*2rem\)/,
    'file loading dialog retains a safe margin on narrow screens');

console.log('Loading overlay layout tests passed.');
