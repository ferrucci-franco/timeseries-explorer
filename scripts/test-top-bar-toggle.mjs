import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [ui, app, session, edge, css, translations] = await Promise.all([
    read('src/app/methods/ui-methods.js'),
    read('src/app/viewer-app.js'),
    read('src/app/methods/session-methods.js'),
    read('src/ui/edge-toggle.js'),
    read('src/styles/base.css'),
    read('src/i18n/translations.js'),
]);

assert.match(app, /this\.initTopBarToggle\(\)/, 'the top bar pill is created at startup');
assert.match(app, /this\._syncTopBarEdgeToggle\?\.\(\)/, 'the pill label follows a language change');
assert.match(ui, /side: 'top'/, 'the top bar reuses the shared edge toggle');
assert.match(ui, /toggleAttribute\('inert', hidden\)/, 'hidden top bar controls leave the Tab order');
assert.match(edge, /side === 'top'/, 'the edge toggle knows a horizontal rail');
assert.match(session, /topBarHidden:/, 'the top bar state is saved with the session');
assert.match(session, /_sessionTopBarHidden/, 'the top bar state is restored with the session');
assert.match(css, /\.top-bar\.hidden\s*\{[^}]*margin-top:\s*-60px/, 'the hidden top bar slides out of the window');
assert.match(css, /\.edge-toggle-rail-top\s*\{[^}]*z-index:\s*1310/, 'the pill sits above the top bar layer');
for (const key of ['edgeHideTopBar', 'edgeShowTopBar']) {
    assert.equal(translations.match(new RegExp(`\\b${key}:`, 'g'))?.length, 4, `${key} exists in all four languages`);
}

console.log('Top bar toggle regression tests passed.');
