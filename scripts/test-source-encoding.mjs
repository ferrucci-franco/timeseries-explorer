// No source file may contain a raw NUL byte.
//
// This is not pedantry about encodings. `file-methods.js` carried one for a
// while — someone meant to write a six-character escape as a join separator and a
// literal 0x00 landed in the file instead. It runs identically, which is why it
// survived: what it breaks is *searching*. ripgrep classifies any file holding a
// NUL as binary and reports "Binary file ... matches" with no line numbers, so
// every grep for every symbol in those 3600 lines came back empty-handed. A
// defect you cannot search for is a defect you cannot find.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-web', 'dist-desktop', 'release', '.claude']);
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md'];

const offenders = [];
let scanned = 0;

const walk = (dir) => {
    for (const name of readdirSync(dir)) {
        if (SKIP.has(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            walk(path);
            continue;
        }
        if (!EXTENSIONS.some(ext => name.endsWith(ext))) continue;
        const bytes = readFileSync(path);
        scanned++;
        const at = bytes.indexOf(0);
        if (at < 0) continue;
        // Report the line, since that is what has to be edited.
        const line = bytes.subarray(0, at).toString('utf8').split(/\r?\n/).length;
        offenders.push(`${relative(root, path).replace(/\\/g, '/')}:${line}`);
    }
};

walk(root);

assert.ok(scanned > 200, `expected to scan the tree, only saw ${scanned} files`);
assert.deepEqual(
    offenders,
    [],
    `raw NUL bytes make these files invisible to ripgrep — write the escape \\u0000 instead:\n  ${offenders.join('\n  ')}`,
);

console.log(`Source encoding tests passed (${scanned} files, no raw NUL bytes).`);
