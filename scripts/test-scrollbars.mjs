// Every scrollbar in the app is the app's, in both engines.
//
//   node scripts/test-scrollbars.mjs
//
// Firefox drew wide grey system scrollbars everywhere, because only a handful
// of boxes named `scrollbar-width`/`scrollbar-color` and the rest fell back to
// the system's; and a pressed thumb went almost invisible, because nobody had
// said what a HELD thumb looks like. Both are now settled in one place —
// `html { scrollbar-* }` and the `*::-webkit-scrollbar` rules in base.css —
// and this test keeps it that way:
//
//   · the shared skin exists, with the three thumb states and a colour per
//     theme, and the colours are solid rather than mixed with `transparent`
//     (a see-through thumb takes the colour of whatever it lies on);
//   · no stylesheet names scrollbar colours of its own again: a box may still
//     choose its WIDTH, hide its bar, or sit its thumb on its own background,
//     but not repaint it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const has = (text, pattern, message) => assert.ok(pattern.test(text), message);

const base = read('src/styles/base.css');

// ── One skin, for both engines ────────────────────────────────────
has(base, /^html \{\n(?:.*\n)*?\s+scrollbar-width: thin;/m, 'Firefox: the whole app is dressed from html');
has(base, /scrollbar-color: var\(--scrollbar-thumb\) var\(--scrollbar-track\);/, 'with the app\'s colours');
has(base, /^\*::-webkit-scrollbar \{/m, 'Chromium: the bar');
has(base, /^\*::-webkit-scrollbar-track \{/m, 'its track');
has(base, /^\*::-webkit-scrollbar-thumb \{/m, 'its thumb');
has(base, /^\*::-webkit-scrollbar-thumb:hover \{/m, 'the thumb under the pointer');
has(base, /^\*::-webkit-scrollbar-thumb:active \{/m, 'and the thumb being HELD — the state that used to vanish');
has(base, /^\*::-webkit-scrollbar-corner \{/m, 'and the corner where two bars meet');

// A colour per theme, and none of them see-through.
for (const theme of ['.theme-light', '.theme-dark']) {
    const start = base.indexOf(`${theme} {`);
    assert.ok(start >= 0, `${theme} exists`);
    const block = base.slice(start, base.indexOf('}', start));
    for (const token of ['--scrollbar-track', '--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-thumb-active']) {
        const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
        assert.ok(match, `${theme}: ${token}`);
        assert.ok(!/transparent/.test(match[1]), `${theme}: ${token} is solid (${match[1].trim()})`);
    }
}

// ── Nobody repaints a scrollbar on their own ──────────────────────
const dir = new URL('../src/styles/', import.meta.url);
const offenders = [];
for (const name of readdirSync(dir)) {
    if (!name.endsWith('.css')) continue;
    const source = read(`src/styles/${name}`);
    const lines = source.split('\n');
    let selector = '';
    lines.forEach((line, index) => {
        if (/\{\s*$/.test(line) || /\{/.test(line)) selector = line;
        if (name === 'base.css' && /^\s*(\*|html)/.test(selector)) return;
        // `scrollbar-color` anywhere but the shared skin.
        if (/^\s*scrollbar-color:/.test(line)) {
            offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
        // A thumb or track given a background of its own. Sitting the thumb's
        // border on the box's own background is fine — that is the gap around
        // it, not its colour.
        if (/^\s*background(-color)?:/.test(line) && /::-webkit-scrollbar-(thumb|track)/.test(selector)) {
            if (/--sidebar-bg|transparent/.test(line)) return;
            offenders.push(`${name}:${index + 1}: ${selector.trim()} ${line.trim()}`);
        }
    });
}
assert.deepEqual(offenders, [], `scrollbar colours live in base.css alone:\n${offenders.join('\n')}`);

console.log('every scrollbar is the app\'s, in both engines: ok');
