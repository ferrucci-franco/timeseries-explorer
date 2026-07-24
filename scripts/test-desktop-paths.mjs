// Desktop (Electron) OpenModelica/Dymola "copy path" helpers. In the browser the
// path was inferred from the URL and fell back to a USERNAME placeholder; in the
// desktop app the preload exposes the real os.homedir()/tmpdir()/username, so the
// helpers build an exact, per-platform path. This test drives the path builders
// with a mocked window.omvDesktop and also guards the wiring (preload exposure,
// desktop message keys, and the project-example replace warning).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import translations from '../src/i18n/translations.js';
import { installUiMethods } from '../src/app/methods/ui-methods.js';

class Harness {}
installUiMethods(Harness);
const h = new Harness();

function withDesktop(env, fn) {
    const previous = globalThis.window;
    globalThis.window = { omvDesktop: env };
    try { return fn(); } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
}

// ── Windows: real temp dir + Documents\Dymola ────────────────────────────────
withDesktop({ platform: 'win32', homedir: 'C:\\Users\\jane', tmpdir: 'C:\\Users\\jane\\AppData\\Local\\Temp', username: 'jane' }, () => {
    assert.deepEqual(h._getOpenModelicaTempCandidates(), [
        'C:\\Users\\jane\\AppData\\Local\\Temp\\OpenModelica\\OMEdit',
        'C:\\Users\\jane\\AppData\\Local\\Temp\\OpenModelica',
    ], 'win32 OpenModelica temp uses the real temp dir (no USERNAME placeholder)');
    assert.deepEqual(h._getDymolaDirectoryCandidates(), ['C:\\Users\\jane\\Documents\\Dymola\\'],
        'win32 Dymola dir under the real home');
});

// ── Linux: OpenModelica appends the username under /tmp ───────────────────────
withDesktop({ platform: 'linux', homedir: '/home/jane', tmpdir: '/tmp', username: 'jane' }, () => {
    assert.deepEqual(h._getOpenModelicaTempCandidates(), ['/tmp/OpenModelicajane/OMEdit', '/tmp/OpenModelicajane'],
        'linux OpenModelica temp appends the username');
    assert.deepEqual(h._getDymolaDirectoryCandidates(), ['/home/jane/Documents/Dymola/'], 'linux Dymola dir');
});

// ── macOS: per-user temp dir already isolates by user ────────────────────────
withDesktop({ platform: 'darwin', homedir: '/Users/jane', tmpdir: '/var/folders/x1/T', username: 'jane' }, () => {
    assert.deepEqual(h._getOpenModelicaTempCandidates(), ['/var/folders/x1/T/OpenModelica/OMEdit', '/var/folders/x1/T/OpenModelica'],
        'darwin OpenModelica temp under the per-user temp dir');
    assert.deepEqual(h._getDymolaDirectoryCandidates(), ['/Users/jane/Documents/Dymola/'], 'darwin Dymola dir');
});

// ── Wiring guards ─────────────────────────────────────────────────────────────
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
assert.match(preload, /homedir: os\.homedir\(\)/, 'preload exposes the real home dir');
assert.match(preload, /tmpdir: os\.tmpdir\(\)/, 'preload exposes the real temp dir');
assert.match(preload, /username/, 'preload exposes the real username');

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
// Desktop shows the browser-free message variants (no Firefox / address-bar text).
assert.match(ui, /window\.omvDesktop\)\s*\n?\s*\?\s*'openModelicaTempPathCopiedDesktop'/, 'desktop uses the OM desktop message');
assert.match(ui, /window\.omvDesktop\)\s*\n?\s*\?\s*'dymolaDirectoryPathCopiedDesktop'/, 'desktop uses the Dymola desktop message');
// Project examples confirm on any loaded files (not just plotted traces).
assert.match(ui, /isProjectExample\s*\n?\s*\?\s*\(this\.files\.size > 0 \|\| this\.plotManager\.hasAnyTraces\(\)\)/,
    'a project example confirms whenever files are loaded');
assert.match(ui, /loadProjectExampleWarning/, 'a project example uses the workspace-replace warning');

// The desktop messages must NOT carry the browser-only guidance.
for (const locale of ['en', 'fr', 'es', 'it']) {
    for (const key of ['openModelicaTempPathCopiedDesktop', 'dymolaDirectoryPathCopiedDesktop', 'loadProjectExampleWarning']) {
        assert.ok(translations[locale]?.[key], `${locale}.${key} is translated`);
    }
    const omDesktop = translations[locale].openModelicaTempPathCopiedDesktop;
    assert.ok(!/Firefox/i.test(omDesktop), `${locale}: desktop OM message drops the Firefox guidance`);
    assert.ok(!/USERNAME/.test(omDesktop), `${locale}: desktop OM message has no USERNAME placeholder`);
}

console.log('Desktop path-helper tests passed.');
