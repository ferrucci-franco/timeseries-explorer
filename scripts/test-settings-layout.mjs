import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');

for (const key of ['visualSettingsTitle', 'fileLoadingSettingsTitle']) {
    assert.equal(
        [...translations.matchAll(new RegExp(`\\b${key}:`, 'g'))].length,
        4,
        `${key} should be translated in all four languages`,
    );
}

assert.match(ui, /plot-settings-visual-tab/, 'Settings should expose the Visual settings topic');
assert.match(ui, /plot-settings-file-tab/, 'Settings should expose the File loading topic');
assert.match(ui, /role', 'tablist'/, 'Settings topic navigation should use tab semantics');
assert.match(ui, /role', 'tabpanel'/, 'Settings content should use tab-panel semantics');
assert.match(ui, /ArrowDown.*ArrowRight/, 'Settings topic navigation should support arrow keys');
assert.match(ui, /previousActive/, 'Closing Settings should restore the previous focus target');

for (const controlId of [
    'timeseries-downsampling',
    'phase-downsampling',
    'pan-zoom-refresh-mode',
    'csvFullLoadMb',
    'parquetFullLoadMb',
    'matlabFullLoadMb',
    'excelFullLoadMb',
    'pickleFullLoadMb',
    'pypsaNetcdfFullLoadMb',
    'csvCompactHintMb',
]) {
    assert.match(ui, new RegExp(`['\"]${controlId}['\"]`), `${controlId} should remain available`);
}

assert.match(css, /\.plot-settings-dialog\s*\{[^}]*width:\s*min\(1180px/s, 'Settings should use the wide desktop layout');
assert.match(css, /\.plot-settings-sidebar\s*\{[^}]*width:\s*270px/s, 'Settings should have a desktop sidebar');
assert.match(css, /\.plot-settings-panel\[hidden\]/, 'Only the selected settings panel should be visible');
assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.plot-settings-sidebar\s*\{[^}]*flex-direction:\s*row/s, 'Narrow Settings should use horizontal topic navigation');
assert.match(css, /\.plot-settings-buttons\s*\{[^}]*flex:\s*0 0 auto/s, 'Reset and Close should stay in a fixed footer');

console.log('Settings center layout and control-preservation checks passed.');
