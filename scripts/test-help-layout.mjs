import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/content.css', import.meta.url), 'utf8');
const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');

const topicSections = [...ui.matchAll(/\{ section: '(\d+)', icon: '(\w+)', color: '#[0-9a-f]+' \}/gi)];
assert.equal(topicSections.length, 11, 'Help should expose all eleven topics in its navigation');
assert.equal(new Set(topicSections.map(match => match[1])).size, 11, 'Help topic ids must be unique');
assert.equal(new Set(topicSections.map(match => match[2])).size, 11, 'Each Help topic should have a distinct icon');

for (const section of topicSections.map(match => match[1])) {
    assert.equal(
        [...translations.matchAll(new RegExp(`\\bhelpSec${section}Title:`, 'g'))].length,
        4,
        `Help topic ${section} should have a title in all four languages`,
    );
    assert.equal(
        [...translations.matchAll(new RegExp(`\\bhelpSec${section}Body:`, 'g'))].length,
        4,
        `Help topic ${section} should have content in all four languages`,
    );
}

assert.match(ui, /role', 'dialog'/, 'Help should identify itself as a dialog');
assert.match(ui, /aria-modal/, 'Help should be announced as modal');
assert.match(ui, /role', 'tablist'/, 'Topic navigation should use tab semantics');
assert.match(ui, /role', 'tabpanel'/, 'Topic content should use tab-panel semantics');
assert.match(ui, /ArrowDown.*ArrowRight/, 'Topic navigation should support arrow keys');
assert.match(ui, /previouslyFocused\?\.focus/, 'Closing Help should restore keyboard focus');
assert.match(css, /width:\s*min\(1180px/, 'Desktop Help should use the wide layout');
assert.match(css, /\.help-topic-sidebar\s*\{[^}]*width:\s*286px/s, 'Desktop Help should have a topic sidebar');
assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.help-topic-sidebar\s*\{[^}]*flex-direction:\s*row/s, 'Narrow Help should use horizontal topic navigation');
assert.match(css, /\.help-section\[hidden\]/, 'Inactive topic panels must remain hidden');

console.log('Help center layout and accessibility checks passed.');
