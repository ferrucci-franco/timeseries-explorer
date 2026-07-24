import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import translations from '../src/i18n/translations.js';

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/content.css', import.meta.url), 'utf8');
const translationsSource = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
const projectLicense = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
const publication = readFileSync(new URL('../PUBLICATION.md', import.meta.url), 'utf8');
const thirdPartyLicenses = readFileSync(new URL('../THIRD_PARTY_LICENSES.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const topicSections = [...ui.matchAll(/\{ section: '(\d+)', icon: '(\w+)', color: '#[0-9a-f]+' \}/gi)];
assert.equal(topicSections.length, 15, 'Help should expose all fifteen topics in its navigation');
// Section 15 (Align and reindex files) sits right after Time-series plots (5).
assert.deepEqual(topicSections.map(match => Number(match[1])), [1, 2, 3, 4, 5, 15, 6, 7, 8, 9, 10, 11, 12, 13, 14], 'Help topics should follow the user workflow');
assert.equal(new Set(topicSections.map(match => match[1])).size, 15, 'Help topic ids must be unique');
assert.equal(new Set(topicSections.map(match => match[2])).size, 15, 'Each Help topic should have a distinct icon');

for (const section of topicSections.map(match => match[1])) {
    assert.equal(
        [...translationsSource.matchAll(new RegExp(`\\bhelpSec${section}Title:`, 'g'))].length,
        4,
        `Help topic ${section} should have a title in all four languages`,
    );
    assert.equal(
        [...translationsSource.matchAll(new RegExp(`\\bhelpSec${section}Body:`, 'g'))].length,
        4,
        `Help topic ${section} should have content in all four languages`,
    );
}

for (const locale of ['en', 'fr', 'es', 'it']) {
    const guide = topicSections.map(match => match[1]).map(section =>
        `${translations[locale][`helpSec${section}Title`]} ${translations[locale][`helpSec${section}Body`]}`
    ).join(' ');
    assert.ok(guide.length > 7000, `${locale} Help should be a substantial product guide`);
    for (const capability of [
        /MATLAB MAT/i,
        /CSV\/TXT/i,
        /Parquet/i,
        /netCDF/i,
        /XLSX/i,
        /FFT/i,
        /Pearson/i,
        /Phase|Fase/i,
        /Live Update/i,
        /\.json/i,
        /\.zip/i,
    ]) {
        assert.match(guide, capability, `${locale} Help should document ${capability}`);
    }
    assert.ok((guide.match(/<h4>/g) || []).length >= 8, `${locale} Help should use scannable subheadings`);
    assert.ok((guide.match(/help-callout/g) || []).length >= 2, `${locale} Help should highlight important limits and advice`);
    assert.match(translations[locale].helpSec3Body, /OpenModelica/i, `${locale} Help should give Modelica its own workflow section`);
    assert.match(translations[locale].helpSec3Body, /Dymola/i, `${locale} Modelica section should cover Dymola results`);
    assert.match(translations[locale].helpSec3Body, /der\(\.\.\.\)/i, `${locale} Modelica section should hint at derivative-aware state animation`);
    assert.match(translations[locale].helpSec7Body, /Modelica/i, `${locale} state animation should identify its Modelica workflow`);
    assert.match(translations[locale].helpSec7Body, /dx\/dt/i, `${locale} state animation should explain the state derivative`);
    assert.match(translations[locale].helpSec10Body, /IQR/i, `${locale} data tools should explain outlier processing`);
    assert.match(translations[locale].helpSec10Body, /NaN/i, `${locale} data tools should explain replacement behavior`);
    assert.doesNotMatch(translations[locale].helpSec11Body, /Live Update/i, `${locale} large-file guidance should not mix in live monitoring`);
    assert.match(translations[locale].helpSec12Body, /Live Update/i, `${locale} reload guidance should cover Live Update`);
    assert.match(translations[locale].helpSec13Body, /\.json[\s\S]*\.zip/i, `${locale} save guidance should distinguish view and project files`);
    assert.match(translations[locale].helpSec14Body, /Franco Ferrucci/i, `${locale} About section should identify the creator`);
    assert.match(translations[locale].helpSec14Body, /github\.com\/ferrucci-franco\/timeseries-explorer/i, `${locale} About section should link to the source repository`);
    assert.match(translations[locale].helpSec14Body, /PUBLICATION\.md/i, `${locale} About section should link to publication status`);
    assert.match(translations[locale].helpSec14Body, /MIT/i, `${locale} About section should explain the project license`);
    assert.match(translations[locale].helpSec14Body, /THIRD_PARTY_LICENSES\.md/i, `${locale} About section should link to third-party licensing details`);
    assert.match(translations[locale].helpSec14Body, /target="_blank" rel="noopener noreferrer"/i, `${locale} external Help links should open safely`);
    for (const mention of guide.match(/.{0,24}Desktop.{0,24}/g) || []) {
        assert.match(mention, /Full Desktop version|versi(?:on|ón|one) Full Desktop/i, `${locale} Help should make clear that Desktop means the Full Desktop version`);
    }
}

assert.match(projectLicense, /^MIT License/m, 'The repository should contain the selected MIT license text');
assert.equal(packageJson.license, 'MIT', 'Package metadata should declare the MIT license');
assert.match(publication, /in preparation/i, 'Publication status should be honest while the paper is unfinished');
assert.match(thirdPartyLicenses, /Plotly\.js[\s\S]*DuckDB[\s\S]*SheetJS[\s\S]*h5wasm/i, 'Principal runtime libraries and licenses should be documented');

assert.match(ui, /role', 'dialog'/, 'Help should identify itself as a dialog');
assert.match(ui, /aria-modal/, 'Help should be announced as modal');
assert.match(ui, /role', 'tablist'/, 'Topic navigation should use tab semantics');
assert.match(ui, /role', 'tabpanel'/, 'Topic content should use tab-panel semantics');
assert.match(ui, /ArrowDown.*ArrowRight/, 'Topic navigation should support arrow keys');
assert.match(ui, /previouslyFocused\?\.focus/, 'Closing Help should restore keyboard focus');
assert.match(css, /width:\s*min\(1180px/, 'Desktop Help should use the wide layout');
assert.match(css, /\.help-topic-sidebar\s*\{[^}]*width:\s*286px/s, 'Desktop Help should have a topic sidebar');
assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.help-topic-sidebar\s*\{[^}]*flex-direction:\s*row/s, 'Narrow Help should use horizontal topic navigation');
assert.match(css, /\.help-section\[hidden\]/, 'Inactive topic panels must remain hidden');
assert.match(css, /\.help-section-content h4/, 'Help content should style task-oriented subheadings');
assert.match(css, /\.help-callout/, 'Help content should style important notes');
assert.match(css, /\.help-section-content a/, 'Help content should style publication and project links');

console.log('Help center content, layout, and accessibility checks passed.');
