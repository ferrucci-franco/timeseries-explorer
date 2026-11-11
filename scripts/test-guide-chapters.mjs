// The demos of the animated guide (src/ui/guide-chapters.js), checked without a
// browser: every chapter is complete, and every text exists in the five
// languages the app speaks.
//
// A caption is only ever read when its step plays, so a missing translation
// would otherwise show up as an English sentence in the middle of a Chinese
// demo, some day, to someone. Run with `npm run test:guide-chapters`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { GUIDE_CHAPTERS, GUIDE_GROUPS } from '../src/ui/guide-chapters.js';
import translations from '../src/i18n/translations.js';

const LANGUAGES = Object.keys(translations).sort();
assert.deepEqual(LANGUAGES, ['en', 'es', 'fr', 'it', 'zh'], 'the languages this check was written for');

const complete = (text, where) => {
    assert.equal(typeof text, 'object', `${where}: a text in every language`);
    for (const lang of LANGUAGES) {
        assert.equal(typeof text[lang], 'string', `${where}: missing ${lang}`);
        assert.ok(text[lang].trim().length > 0, `${where}: empty ${lang}`);
    }
};

// ── The chapters ──
assert.ok(GUIDE_CHAPTERS.length > 0);
const ids = new Set();
for (const chapter of GUIDE_CHAPTERS) {
    assert.match(chapter.id, /^[a-z][a-z0-9-]*$/, `id ${chapter.id}`);
    assert.ok(!ids.has(chapter.id), `id ${chapter.id} is used twice`);
    ids.add(chapter.id);
    assert.ok(GUIDE_GROUPS[chapter.g], `${chapter.id}: unknown group ${chapter.g}`);
    complete(chapter.t, `${chapter.id}: title`);
    complete(chapter.d, `${chapter.id}: description`);
    assert.equal(typeof chapter.run, 'function', `${chapter.id}: run`);
    assert.ok(chapter.est > 0, `${chapter.id}: estimated duration`);
}
for (const [key, text] of Object.entries(GUIDE_GROUPS)) complete(text, `group ${key}`);

// Chapters of a group are listed together: the list prints a heading each time
// the group changes.
const order = GUIDE_CHAPTERS.map(chapter => chapter.g);
assert.deepEqual(order.filter((g, i) => g !== order[i - 1]), [...new Set(order)], 'the chapters of a group are listed together');

// ── Every caption: say('en', 'fr', 'es', 'it', 'zh') ──
// Read from the source, because a caption is built only when its step plays.
const source = await readFile(new URL('../src/ui/guide-chapters.js', import.meta.url), 'utf8');

function readArguments(text, start) {
    // `start` is just past "say(". Returns the string literals up to the closing parenthesis.
    const args = [];
    let i = start;
    for (;;) {
        while (/[\s,]/.test(text[i])) i++;
        if (text[i] === ')') return args;
        assert.equal(text[i], "'", `a caption argument that is not a plain '…' string, at offset ${i}: ${text.slice(i, i + 40)}`);
        let value = '';
        i++;
        while (text[i] !== "'") {
            if (text[i] === '\\') i++;
            value += text[i++];
        }
        i++;
        args.push(value);
    }
}

let captions = 0;
for (const match of source.matchAll(/\bsay\(/g)) {
    const after = match.index + match[0].length;
    // The definition and the method call `d.say(` take something else.
    const before = source.slice(Math.max(0, match.index - 12), match.index);
    if (/const $/.test(before) || /\.$/.test(before)) continue;
    const args = readArguments(source, after);
    const line = source.slice(0, match.index).split('\n').length;
    assert.equal(args.length, LANGUAGES.length, `line ${line}: say() takes en, fr, es, it, zh`);
    args.forEach((value, n) => assert.ok(value.trim(), `line ${line}: empty text ${n + 1}`));
    captions++;
}
assert.ok(captions > GUIDE_CHAPTERS.length * 3, `captions found: ${captions}`);

// ── The menu entry ──
for (const lang of LANGUAGES) {
    for (const key of ['extraGuide', 'extraGuideTooltip']) {
        assert.equal(typeof translations[lang][key], 'string', `${lang}.${key}`);
    }
}

console.log(`guide chapters: ${GUIDE_CHAPTERS.length} demos, ${captions} texts, ${LANGUAGES.length} languages — ok`);
