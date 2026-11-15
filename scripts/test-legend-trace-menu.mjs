// The legend's context menu (plot-manager.js, _showLegendTraceMenu): every
// action has an icon of the app's style (#372).
//
// Run with `npm run test:legend-trace-menu`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGEND_MENU_ICONS, legendMenuIcon } from '../src/ui/legend-menu-icons.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plotManagerSource = read('src/plots/plot-manager.js');
const contentCss = read('src/styles/content.css');

// ── Icons ────────────────────────────────────────────────────────────────────
{
    const names = ['show', 'hide', 'only', 'remove', 'axisRight', 'axisLeft', 'stairs', 'linear'];
    for (const name of names) {
        const icon = LEGEND_MENU_ICONS[name];
        assert.ok(icon, `there is an icon for "${name}"`);
        assert.match(icon, /^<svg [^>]*viewBox="0 0 24 24"/, `${name}: a 24×24 drawing like the app's other icons`);
        assert.match(icon, /aria-hidden="true"/, `${name}: decorative, hidden from assistive technology`);
        assert.match(icon, /stroke="currentColor"/, `${name}: takes the text colour, so it works in both themes`);
        assert.doesNotMatch(icon, /#[0-9a-f]{3,6}\b/i, `${name}: no fixed colour`);
        assert.match(icon, /<\/svg>$/, `${name}: a complete element`);
    }
    assert.equal(legendMenuIcon('no-such-icon'), '', 'an unknown icon draws nothing rather than failing');
}

// ── The menu puts one before every label ─────────────────────────────────────
{
    const start = plotManagerSource.indexOf('_showLegendTraceMenu(event, trace, actions, extraActions = []) {');
    const end = plotManagerSource.indexOf('\n    _showTimeseriesAxisMenu(', start);
    assert.ok(start >= 0 && end > start, 'the legend menu builder is present');
    const menu = plotManagerSource.slice(start, end);
    assert.match(menu, /legend-menu-icon/, 'each action has an icon cell');
    assert.match(menu, /setAttribute\('aria-hidden', 'true'\)/, 'the icon cell is hidden from assistive technology');
    assert.match(menu, /legend-menu-label[\s\S]{0,80}textContent = i18n\.t\(labelKey\)/, 'the label stays text');
    assert.match(menu, /hidden \? 'show' : 'hide'/, 'show/hide swap their eye with the state');
    assert.match(menu, /'legend-menu-danger', 'remove'/, 'remove is drawn as a danger action');
    assert.match(menu, /item\.icon/, 'the extra actions of a mode carry their own icon');

    const axisStart = plotManagerSource.indexOf('_showTimeseriesAxisMenu(panelId, plot, trace, event) {');
    const axisMenu = plotManagerSource.slice(axisStart, plotManagerSource.indexOf('\n    _traceIsStepped(', axisStart));
    assert.match(axisMenu, /icon: moveRight \? 'axisRight' : 'axisLeft'/, 'the Y-axis move has its arrow');
    assert.match(axisMenu, /icon: stepped \? 'linear' : 'stairs'/, 'the line shape shows the shape it switches to');

    assert.match(contentCss, /\.legend-menu-item\s*\{[^}]*grid-template-columns\s*:\s*16px max-content/,
        'icons sit in a fixed-width column so the labels line up');
    assert.match(contentCss, /\.legend-menu-danger[^{]*\.legend-menu-icon[^{]*\{[^}]*var\(--danger-color\)/,
        'the remove icon takes the theme\'s danger colour');
}

console.log('legend trace menu tests passed');
