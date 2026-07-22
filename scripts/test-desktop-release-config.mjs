import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const constants = await readFile(new URL('src/app/constants.js', root), 'utf8');
const workflow = await readFile(new URL('.github/workflows/desktop-release.yml', root), 'utf8');
const builderRunner = await readFile(new URL('scripts/run-electron-builder.mjs', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('public/downloads/desktop.json', root), 'utf8'));
const releaseNotes = await readFile(new URL('docs/releases/v0.1.0-beta.3.md', root), 'utf8');

assert.equal(pkg.version, '0.1.0-beta.3');
assert.match(constants, /APP_VERSION = '0\.1\.0-beta\.3'/);
assert.deepEqual(pkg.build.win.target, ['nsis', 'portable']);
assert.equal(pkg.build.nsis.oneClick, false);
assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
assert.match(pkg.scripts['desktop:dist:x64'], /--x64/);
assert.match(pkg.scripts['desktop:verify-package'], /verify-packaged-desktop/);
assert.match(builderRunner, /['"]--publish['"],\s*['"]never['"]/, 'electron-builder publishing must stay disabled');
for (const excluded of ['node-gyp', 'cacache', 'make-fetch-happen', 'tar']) {
  assert.ok(pkg.build.files.includes(`!node_modules/${excluded}{,/**/*}`), `${excluded} is excluded from the packaged runtime`);
  assert.ok(pkg.build.files.includes(`!node_modules/**/${excluded}{,/**/*}`), `nested ${excluded} is excluded from the packaged runtime`);
}

assert.equal(manifest.version, pkg.version);
assert.equal(manifest.platform, 'windows');
assert.equal(manifest.architecture, 'x64');
assert.match(manifest.downloadUrl, /v0\.1\.0-beta\.3\/Time\.Series\.Explorer-0\.1\.0-beta\.3-setup-x64\.exe$/);
assert.match(manifest.portableUrl, /v0\.1\.0-beta\.3\/Time\.Series\.Explorer-0\.1\.0-beta\.3-portable-x64\.exe$/);

assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
assert.match(workflow, /node-version:\s*22/);
assert.match(workflow, /npm\.cmd run test:release/);
assert.match(workflow, /npm\.cmd audit --omit=dev --audit-level=critical/);
assert.match(workflow, /npm\.cmd run desktop:dist:x64/);
assert.match(workflow, /npm\.cmd run desktop:verify-package/);
assert.match(workflow, /npm\.cmd run desktop:checksums/);
assert.match(workflow, /['"]release['"], ['"]create['"]/);
assert.match(workflow, /& gh @arguments/);
assert.doesNotMatch(workflow, /electron-builder[^\n]*--publish/i, 'Only the explicit gh release step should publish');
assert.match(releaseNotes, /Windows 10\/11 x64/);
assert.match(releaseNotes, /unsigned/i);

console.log('Desktop release configuration checks passed.');
