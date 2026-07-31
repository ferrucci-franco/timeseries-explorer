import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);

// Nothing here is checked in with CRLF, but nothing stops a Windows checkout
// from materialising it that way — .gitattributes pins eol only for .bat and
// .sh. The assertions below are written against LF, so the endings are
// flattened once at the door instead of sprinkling \r? through every pattern.
const readText = async path => (await readFile(new URL(path, root), 'utf8')).replace(/\r\n/g, '\n');

const pkg = JSON.parse(await readText('package.json'));
const constants = await readText('src/app/constants.js');
const workflow = await readText('.github/workflows/desktop-release.yml');
const builderRunner = await readText('scripts/run-electron-builder.mjs');
const manifest = JSON.parse(await readText('public/downloads/desktop.json'));

// The version is read from package.json, never spelt out. It used to be written
// here thirteen times, so every release bump failed this gate until each one was
// edited — which taught nothing, because the real invariant is that the manifest,
// the constants, the asset names and the release notes all agree with package.json.
const version = pkg.version;
const dotted = version.replace(/\./g, '\\.');
const releaseNotes = await readText(`docs/releases/v${version}.md`);

assert.match(constants, new RegExp(`APP_VERSION = '${dotted}'`), 'the in-app version matches package.json');
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
assert.match(manifest.downloadUrl, new RegExp(`v${dotted}/Time\\.Series\\.Explorer-${dotted}-setup-x64\\.exe$`));
assert.match(manifest.portableUrl, new RegExp(`v${dotted}/Time\\.Series\\.Explorer-${dotted}-portable-x64\\.exe$`));
assert.equal(manifest.platforms.macos.status, 'available');
assert.deepEqual(
  manifest.platforms.macos.assets.map(asset => asset.fileName),
  [
    `Time.Series.Explorer-${version}-mac-x64.dmg`,
    `Time.Series.Explorer-${version}-mac-x64.zip`,
    `Time.Series.Explorer-${version}-mac-arm64.dmg`,
    `Time.Series.Explorer-${version}-mac-arm64.zip`
  ]
);
assert.equal(manifest.platforms.linux.status, 'available');
assert.deepEqual(
  manifest.platforms.linux.assets.map(asset => asset.fileName),
  [
    `Time.Series.Explorer-${version}-linux-amd64.deb`,
    `Time.Series.Explorer-${version}-linux-x86_64.AppImage`
  ]
);

assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
// Both release paths read the same Node floor, so the web bundle and the desktop
// build cannot drift onto different majors.
assert.match(workflow, /node-version-file:\s*\.nvmrc/);
assert.equal((await readText('.nvmrc')).trim(), '22.12.0');
assert.match(pkg.engines?.node ?? '', /^>=22\./, 'package.json declares the same Node floor');
// The token is read-only for every job that runs dependency code; only the
// publish job — which creates the release — is granted write.
assert.match(workflow, /^permissions:\n\s+contents: read$/m, 'the workflow default is read-only');
assert.match(
  workflow,
  /publish:[\s\S]*?permissions:\n\s+contents: write/,
  'write access is granted per-job on publish',
);
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
// docs/desktop-release.md permits an unsigned beta only if the notes disclose
// BOTH warnings users will hit. They named SmartScreen and said nothing about
// Gatekeeper, so macOS users met "cannot be opened" with no guidance anywhere.
assert.match(releaseNotes, /SmartScreen/i, 'the notes disclose the Windows warning');
assert.match(releaseNotes, /Gatekeeper/i, 'the notes disclose the macOS warning');
assert.match(releaseNotes, /Open Anyway/i, 'and say how to get past it');

console.log('Desktop release configuration checks passed.');
