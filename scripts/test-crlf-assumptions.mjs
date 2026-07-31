// No test script may assume the file it reads off disk ends its lines with LF.
//
// .gitattributes now pins the working tree to LF, so this should never fire.
// It exists because the failure it guards is not always a failure. When
// test-desktop-release-config.mjs matched /^permissions:\n\s+contents: read$/m
// against a CRLF checkout it threw, and that was the good case — it also hid a
// second broken assertion behind it, since assert stops at the first throw.
//
// The bad case was test-lazy-phase-logic.mjs. It slices one method out of
// duckdb-source.js with an indexOf for a two-line needle. A needle that cannot
// match returns -1, and slice(start, -1) means "one from the end", so its four
// assertions ran against the remaining 154k characters of the file instead of
// the method's 6k. Every one of them passed. A test that cannot fail is worse
// than a test that does, and nothing about it looked wrong.
//
// A pattern is fragile when a literal character sits immediately before a \n:
// nothing is left to absorb the \r. A quantifier, a group or a character class
// in front (\s*\n, [\s\S]*?\n, \r?\n) absorbs it, and a \n inside a class
// ([^\n]) never had to match a newline at all. Scripts that flatten CRLF at the
// point of reading are exempt — that is the convention here, and it keeps the
// assertions themselves written in plain LF.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
const SUPPRESS = /\/\/\s*crlf-ok:/;

// Quantifiers, groups and classes can all soak up a \r; a literal cannot.
const ABSORBING = new Set(['*', '+', '?', ')', ']', '}']);

/** Walk a regex body and report the offsets of every \n that must match a real newline. */
const newlineAtoms = (body) => {
    const found = [];
    let inClass = false;
    for (let i = 0; i < body.length; i++) {
        const char = body[i];
        if (char === '\\') {
            // A \n inside [...] is excluded from a set, not matched against text.
            if (body[i + 1] === 'n' && !inClass) found.push(i);
            i++; // consume the escaped character, so \\n reads as backslash + n
            continue;
        }
        if (char === '[' && !inClass) inClass = true;
        else if (char === ']' && inClass) inClass = false;
    }
    return found;
};

/** Regex literals on a line. Deliberately conservative: a missed literal is a missed check, not a false alarm. */
const regexLiterals = (line) =>
    [...line.matchAll(/(?<![\w)\]}]\s?)\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+)\/[dgimsuvy]*/g)];

const offenders = [];
let scanned = 0;

for (const name of readdirSync(dir).filter(file => file.startsWith('test-') && file.endsWith('.mjs')).sort()) {
    if (name === 'test-crlf-assumptions.mjs') continue;
    const text = readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');

    // Only scripts that read a repo file can be fooled by how it is checked out,
    // and one that flattens CRLF on the way in has already dealt with this.
    if (!/\breadFile(Sync)?\s*\(/.test(text)) continue;
    if (/\.replace\(\/\\r\\n\/g/.test(text)) continue;
    scanned++;

    const lines = text.split('\n');
    lines.forEach((line, index) => {
        // The waiver may sit on the line itself or on the one above it, which is
        // where this codebase puts the reason for anything surprising.
        if (SUPPRESS.test(line) || SUPPRESS.test(lines[index - 1] ?? '')) return;
        const at = `${name}:${index + 1}`;

        for (const [, body] of regexLiterals(line)) {
            for (const offset of newlineAtoms(body)) {
                const before = body[offset - 1];
                if (before === undefined || ABSORBING.has(before)) continue;
                offenders.push(`${at}  /${body}/  — '${before}' before \\n leaves nothing to absorb the \\r`);
            }
        }

        // A needle is searched for verbatim. A leading \n still matches inside
        // CRLF text; anything further in cannot.
        for (const match of line.matchAll(/\.(indexOf|lastIndexOf|includes)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g)) {
            const needle = match[3];
            if ([...needle.matchAll(/\\n/g)].some(hit => hit.index !== 0)) {
                offenders.push(`${at}  ${JSON.stringify(needle).slice(0, 60)}  — a \\n past the start cannot match CRLF text`);
            }
        }
    });
}

assert.ok(scanned > 20, `expected to scan the file-reading test scripts, only saw ${scanned}`);
assert.deepEqual(
    offenders,
    [],
    `these patterns break on a CRLF checkout — flatten the text where it is read, \
or mark the line "// crlf-ok: <why>" if it never touches a checked-out file:\n  ${offenders.join('\n  ')}`,
);

console.log(`CRLF assumption checks passed (${scanned} file-reading test scripts).`);
