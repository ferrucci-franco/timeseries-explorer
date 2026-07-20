import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import translations from '../src/i18n/translations.js';

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../public/downloads/desktop.json', import.meta.url), 'utf8'));

const translationKeys = [
    'desktopDownloadTitle',
    'desktopDownloadIntro',
    'desktopDownloadBeta',
    'desktopDownloadWindows',
    'desktopDownloadMacos',
    'desktopDownloadLinux',
    'desktopDownloadReady',
    'desktopDownloadPublishing',
    'desktopDownloadComingSoon',
    'desktopDownloadInstaller',
    'desktopDownloadPortable',
    'desktopDownloadPublishingHint',
    'desktopDownloadUnavailableHint',
    'desktopDownloadBetaNote',
    'desktopDownloadUnsignedNote',
    'desktopDownloadReleaseDetails',
];
for (const locale of ['en', 'fr', 'es', 'it']) {
    for (const key of translationKeys) {
        assert.ok(translations[locale]?.[key], `${locale}.${key} should be translated`);
    }
}

assert.match(manifest.releaseApiUrl, /^https:\/\/api\.github\.com\/repos\//);
assert.deepEqual(Object.keys(manifest.platforms), ['windows', 'macos', 'linux']);
assert.equal(manifest.platforms.windows.status, 'available');
assert.deepEqual(manifest.platforms.windows.assets.map(asset => asset.kind), ['installer', 'portable']);
assert.deepEqual(manifest.platforms.macos.assets.map(asset => asset.format), ['DMG', 'ZIP']);
assert.deepEqual(manifest.platforms.linux.assets.map(asset => asset.format), ['DEB', 'AppImage']);

for (const platform of ['windows', 'apple', 'linux']) {
    const svg = readFileSync(new URL(`../public/images/platforms/${platform}.svg`, import.meta.url), 'utf8');
    assert.match(svg, /^<svg[\s\S]*<title>/, `${platform} should have a local accessible SVG`);
}

assert.match(ui, /_showDesktopDownloadDialog/, 'Menu action should open a selector instead of downloading immediately');
assert.match(ui, /releaseApiUrl[\s\S]*publishedAssets = new Map/s, 'Published GitHub assets should be verified before enabling downloads');
assert.match(ui, /replaceAll\(' ', '\.'\)/, 'GitHub-normalized asset names should still be recognized');
assert.match(ui, /releaseResponse\.status === 404[\s\S]*new Map\(\)/s, 'An unpublished release should produce a safe disabled state');
assert.match(ui, /for \(const platformId of \['windows', 'macos', 'linux'\]\)/, 'All three platforms should be rendered');
assert.match(ui, /document\.createElement\(asset\.available \? 'a' : 'button'\)/, 'Unavailable assets should render as disabled buttons');
assert.match(ui, /control\.target = '_blank'/, 'Downloads should open through the regular browser boundary');
assert.match(ui, /control\.disabled = true/, 'Unavailable downloads should not create broken links');
assert.match(ui, /aria-modal/, 'The selector should expose modal dialog semantics');
assert.match(ui, /event\.key !== 'Tab'/, 'Keyboard focus should remain trapped in the selector');
assert.match(ui, /Modal\.close\(overlay, previousActive\)/, 'Closing should restore the previous focus target');

assert.match(css, /\.desktop-download-overlay\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/s, 'The app behind the selector should be blurred');
assert.match(css, /\.desktop-download-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/s, 'Wide screens should show three platform cards');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.desktop-download-grid\s*\{[^}]*grid-template-columns:\s*1fr/s, 'Narrow screens should stack platform cards');
assert.match(css, /\.theme-dark \.desktop-platform-logo-macos/, 'Monochrome platform logos should remain visible in the dark theme');
assert.match(css, /\.desktop-download-action:focus-visible/, 'Download actions should have a visible keyboard focus state');

console.log('Desktop download selector checks passed.');
