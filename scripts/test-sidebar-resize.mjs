import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const start = source.indexOf('proto.initSidebarResize = function');
const end = source.indexOf('\n// ─── Variables tree', start);
assert.ok(start >= 0 && end > start, 'sidebar resize implementation is present');
const resizeSource = source.slice(start, end);

assert.match(resizeSource, /proxy\.style\.left\s*=\s*`\$\{rect\.right\}px`/,
    'the resize proxy starts outside the scrollable sidebar');
assert.doesNotMatch(resizeSource, /sidebar\.addEventListener\('pointerdown'/,
    'native sidebar and scrollbar pointer presses never start resizing');
assert.match(resizeSource, /proxy\.addEventListener\('pointerdown', startResize\)/,
    'the explicit resize proxy still starts resizing');

console.log('Sidebar resize regression tests passed.');
