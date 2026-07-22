import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const constants = await readFile(new URL('src/app/constants.js', root), 'utf8');
const workflow = await readFile(new URL('.github/workflows/desktop-release.yml', root), 'utf8');
const builderRunner = await readFile(new URL('scripts/run-electron-builder.mjs', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('public/downloads/desktop.json', root), 'utf8'));
const releaseNotes = await readFile(new URL('docs/releases/v0.1.0-beta.9.md', root), 'utf8');

assert.equal(pkg.version, '0.1.0-beta.9');
assert.match(constants, /APP_VERSION = '0\.1\.0-beta\.9'/);
assert.deepEqual(pkg.build.win.target, ['nsis', 'portable']);
assert.equal(pkg.build.nsis.oneClick, false);
assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
assert.deepEqual(pkg.build.mac.target, ['dmg', 'zip']);
assert.deepEqual(pkg.build.linux.target, ['deb', 'AppImage']);
assert.match(pkg.scripts['desktop:dist:windows:x64'], /--win nsis portable --x64/);
assert.match(pkg.scripts['desktop:dist:macos:x64'], /--mac dmg zip --x64/);
assert.match(pkg.scripts['desktop:dist:macos:arm64'], /--mac dmg zip --arm64/);
assert.match(pkg.scripts['desktop:dist:linux:x64'], /--linux deb AppImage --x64/);
assert.match(pkg.scripts['desktop:verify-package'], /verify-packaged-desktop/);
assert.match(builderRunner, /['"]--publish['"],\s*['"]never['"]/, 'electron-builder publishing must stay disabled');
for (const excluded of ['node-gyp', 'cacache', 'make-fetch-happen', 'tar']) {
  assert.ok(pkg.build.files.includes(`!node_modules/${excluded}{,/**/*}`), `${excluded} is excluded from the packaged runtime`);
  assert.ok(pkg.build.files.includes(`!node_modules/**/${excluded}{,/**/*}`), `nested ${excluded} is excluded from the packaged runtime`);
}

assert.equal(manifest.version, pkg.version);
assert.equal(manifest.platform, 'windows');
assert.equal(manifest.architecture, 'x64');
assert.match(manifest.downloadUrl, /v0\.1\.0-beta\.9\/Time%20Series%20Explorer-0\.1\.0-beta\.9-setup-x64\.exe$/);
assert.match(manifest.portableUrl, /v0\.1\.0-beta\.9\/Time%20Series%20Explorer-0\.1\.0-beta\.9-portable-x64\.exe$/);
assert.equal(manifest.platforms.macos.status, 'available');
assert.deepEqual(
  manifest.platforms.macos.assets.map(asset => asset.fileName),
  [
    'Time Series Explorer-0.1.0-beta.9-mac-x64.dmg',
    'Time Series Explorer-0.1.0-beta.9-mac-x64.zip',
    'Time Series Explorer-0.1.0-beta.9-mac-arm64.dmg',
    'Time Series Explorer-0.1.0-beta.9-mac-arm64.zip'
  ]
);
assert.equal(manifest.platforms.linux.status, 'available');
assert.deepEqual(
  manifest.platforms.linux.assets.map(asset => asset.fileName),
  [
    'Time Series Explorer-0.1.0-beta.9-linux-amd64.deb',
    'Time Series Explorer-0.1.0-beta.9-linux-x86_64.AppImage'
  ]
);

assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
assert.match(workflow, /node-version:\s*22/);
assert.match(workflow, /run: npm run test:release/);
assert.match(workflow, /run: npm audit --omit=dev --audit-level=critical/);
assert.match(workflow, /build_script: desktop:dist:windows:x64/);
assert.match(workflow, /build_script: desktop:dist:macos:x64/);
assert.match(workflow, /build_script: desktop:dist:macos:arm64/);
assert.match(workflow, /build_script: desktop:dist:linux:x64/);
assert.match(workflow, /runner: macos-15-intel/);
assert.match(workflow, /runner: macos-14/);
assert.match(workflow, /runner: ubuntu-24\.04/);
assert.match(workflow, /OMV_RELEASE_PLATFORM/);
assert.match(workflow, /OMV_CHECKSUMS_FILE/);
assert.match(workflow, /release create/);
assert.match(workflow, /gh \"\$\{release_args\[@\]\}\" \"\$\{assets\[@\]\}\"/);
assert.doesNotMatch(workflow, /electron-builder[^\n]*--publish/i, 'Only the explicit gh release step should publish');
assert.match(releaseNotes, /Windows 10\/11 x64/);
assert.match(releaseNotes, /unsigned/i);

console.log('Desktop release configuration checks passed.');
