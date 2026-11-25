// Every switch in the sidebar's Options says what it does.
//
//   node scripts/test-options-tooltips.mjs
//
// Four of them had no explanation at all — link the time axes, hover by
// proximity, run parameters in hover, synchronized hover — and the most
// useful of the four (the run parameters, which name what tells two runs
// apart) was the one nobody understood. A switch whose only description is
// its own name is a switch nobody turns on, so:
//
//   · every checkbox in the Options section carries a `data-i18n-title`, and
//     the text it names exists in every language;
//   · the one option people could not find, "Scrollable plot area", is also a
//     button in the top bar, with the other layout buttons, kept in step with
//     the checkbox.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const translations = read('src/i18n/translations.js');
const LANGS = 5;

const start = html.indexOf('<div class="sidebar-section sidebar-options-section">');
assert.ok(start > 0, 'the Options section is in the page');
const end = html.indexOf('<div class="sidebar-section', start + 10);
const options = html.slice(start, end > 0 ? end : undefined);

// Every checkbox of the section, with the label that holds it. (A radio of a
// named group is one choice of a group that has its own label, so the group
// is what would carry an explanation, not each radio.)
const labels = [...options.matchAll(/<label class="(?:checkbox-label)[^"]*"([^>]*)>\s*<input([^>]*type="checkbox"[^>]*)>\s*<span[^>]*data-i18n="([^"]+)"/g)];
assert.ok(labels.length >= 8, `the switches of the Options section (${labels.length})`);

const missing = [];
const keys = [];
for (const [, attrs, , labelKey] of labels) {
    const tip = /data-i18n-title="([^"]+)"/.exec(attrs);
    if (!tip) missing.push(labelKey);
    else keys.push(tip[1]);
    assert.ok(/title="/.test(attrs), `${labelKey}: a title to show before the language loads`);
}
assert.deepEqual(missing, [], `every switch says what it does: ${missing.join(', ')}`);

for (const key of keys) {
    const count = [...translations.matchAll(new RegExp(`^\\s+${key}:`, 'gm'))].length;
    assert.ok(count >= LANGS, `${key}: in all ${LANGS} languages (found ${count})`);
}

// The four that had none, by name, so they cannot quietly lose them again.
for (const key of ['linkTimeAxesTooltip', 'hoverProximityTooltip', 'hoverRunParametersTooltip', 'syncHoverTooltip']) {
    assert.ok(keys.includes(key), `${key} is on its switch`);
}
// The run parameters are the ones nobody understood: its text says what they
// are for, with an example.
const english = translations.slice(0, translations.indexOf('fr: {'));
const runTip = /hoverRunParametersTooltip: '([^']*(?:\\'[^']*)*)'/.exec(english)?.[1] || '';
assert.ok(runTip.length > 120, 'the run parameters are explained, not named again');
assert.ok(/Kp=/.test(runTip), 'with an example of what lands in the hover');

// Findable: the same choice as a button in the top bar.
assert.ok(/id="scrollable-plot-area-btn"/.test(html), 'the top bar carries the scrollable-plot-area switch');
assert.ok(/data-i18n-title="scrollablePlotAreaTooltip"/.test(html.slice(html.indexOf('id="scrollable-plot-area-btn"') - 400,
    html.indexOf('id="scrollable-plot-area-btn"') + 400)), 'with the same explanation');
const ui = read('src/app/methods/ui-methods.js');
assert.ok(/getElementById\('scrollable-plot-area-btn'\)\?\.addEventListener/.test(ui), 'the button is wired');
assert.ok(/scrollable-plot-area-btn[\s\S]{0,400}aria-pressed/.test(ui), 'and says whether it is on');

// A switch of the top bar that stays pressed shows it with its background,
// not with a border alone.
const baseCss = read('src/styles/base.css');
assert.match(baseCss, /\.icon-btn\[aria-pressed="true"\]:not\(:disabled\) \{[^}]*background-color:/, 'a pressed top-bar switch changes its background');

// The run parameters also have a help button: pressed, it opens a box with the
// tooltip's own text (a tooltip is slow to come, and never comes on touch).
assert.match(options, /class="fft-help-btn option-help-btn" data-option-help="hoverRunParametersTooltip"[^>]*aria-controls="hover-run-parameters-help"/,
    'the run parameters have a help button');
assert.match(options, /id="hover-run-parameters-help" class="fft-help-popover option-help-popover" hidden/, 'and the box it opens');
assert.match(ui, /popover\.textContent = i18n\.t\(button\.dataset\.optionHelp\)/, 'the box holds the tooltip\'s text');
assert.doesNotMatch(english, /hoverRunParameters: 'Run parameters in hover'/, 'and a name that says what it shows');

// Full screen: the app's own, with its button in the top bar, an icon that is
// not the four corners of Auto-fit, and texts in every language.
assert.ok(/id="fullscreen-btn"/.test(html), 'the top bar carries the full-screen button');
assert.match(ui, /installAppFullscreen\(\{\s*button: document\.getElementById\('fullscreen-btn'\)/, 'wired to the full-screen module');
const fullscreen = read('src/ui/app-fullscreen.js');
assert.match(fullscreen, /requestFullscreen\(\{ navigationUI: 'hide' \}\)/, 'through the page\'s Fullscreen API');
assert.match(fullscreen, /<rect x="3" y="3\.5" width="18" height="13" rx="2"\/>/, 'its icon is a screen');
assert.match(fullscreen, /event\.key !== 'F11'/, 'F11 enters it where the browser allows');
assert.match(baseCss, /\.app-fullscreen-pill \{/, 'the exit pill is styled');
for (const key of ['fullscreen', 'exitFullscreen', 'exitFullscreenPill', 'optionHelpTitle']) {
    const count = [...translations.matchAll(new RegExp(`^\\s+${key}:`, 'gm'))].length;
    assert.ok(count >= LANGS, `${key}: in all ${LANGS} languages (found ${count})`);
}

console.log('every option says what it does, and the hidden one is findable: ok');
