// The legend's context menu (plot-manager.js, _showLegendTraceMenu): every
// action has an icon of the app's style (#372), and a trace's colour and
// place among the others can be changed from it (#371, trace-style.js and
// methods/trace-style-methods.js).
//
// Run with `npm run test:legend-trace-menu`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGEND_MENU_ICONS, legendMenuIcon } from '../src/ui/legend-menu-icons.js';
import {
    TRACE_COLOR_SWATCHES,
    TRACE_MOVES,
    moveTraceInList,
    setTraceColor,
    traceColorHex,
    traceMoveTarget,
    traceMovesAvailable,
} from '../src/plots/trace-style.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plotManagerSource = read('src/plots/plot-manager.js');
const traceStyleMethodsSource = read('src/plots/methods/trace-style-methods.js');
const compactSource = read('src/app/methods/compact-methods.js');
const sessionSource = read('src/app/methods/session-methods.js');
const contentCss = read('src/styles/content.css');
const translationsSource = read('src/i18n/translations.js');

// ── Icons (#372) ─────────────────────────────────────────────────────────────
{
    const names = ['show', 'hide', 'only', 'remove', 'axisRight', 'axisLeft', 'stairs', 'linear',
        'color', 'moveUp', 'moveDown', 'moveFirst', 'moveLast'];
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
    assert.match(menu, /icon: hidden \? 'show' : 'hide'/, 'show/hide swap their eye with the state');
    assert.match(menu, /className: 'legend-menu-danger', icon: 'remove'/, 'remove is drawn as a danger action');
    assert.match(menu, /\.\.\.extraActions,/, 'the extra actions of a mode go through the same builder, icon included');
    assert.match(menu, /_traceStyleMenuItems\?\.\(trace/, 'every mode gets the colour and order actions');
    assert.match(menu, /actionButton\.disabled = !!disabled/, 'a move that does nothing is offered disabled');

    const axisStart = plotManagerSource.indexOf('_showTimeseriesAxisMenu(panelId, plot, trace, event) {');
    const axisMenu = plotManagerSource.slice(axisStart, plotManagerSource.indexOf('\n    _traceIsStepped(', axisStart));
    assert.match(axisMenu, /icon: moveRight \? 'axisRight' : 'axisLeft'/, 'the Y-axis move has its arrow');
    assert.match(axisMenu, /icon: stepped \? 'linear' : 'stairs'/, 'the line shape shows the shape it switches to');

    assert.match(contentCss, /\.legend-menu-item\s*\{[^}]*grid-template-columns\s*:\s*16px max-content/,
        'icons sit in a fixed-width column so the labels line up');
    assert.match(contentCss, /\.legend-menu-danger[^{]*\.legend-menu-icon[^{]*\{[^}]*var\(--danger-color\)/,
        'the remove icon takes the theme\'s danger colour');
}

// ── Colour (#371) ────────────────────────────────────────────────────────────
{
    assert.equal(traceColorHex('#2196F3'), '#2196f3', 'a palette colour, as the colour input takes it');
    assert.equal(traceColorHex('#abc'), '#aabbcc', 'short hex');
    assert.equal(traceColorHex('rgb(255, 0, 128)'), '#ff0080', 'rgb()');
    assert.equal(traceColorHex('hsl(0, 100%, 50%)'), '#ff0000', 'the hsl() of a trace past the palette');
    assert.equal(traceColorHex('hsl(120, 100%, 25%)'), '#008000');
    assert.equal(traceColorHex('hsl(240, 70%, 45%)'), '#2222c3');
    assert.equal(traceColorHex('not a colour'), null);
    assert.equal(traceColorHex(undefined), null);

    assert.equal(TRACE_COLOR_SWATCHES.length, 16, 'two rows of eight');
    assert.equal(new Set(TRACE_COLOR_SWATCHES).size, 16, 'no colour twice');
    for (const color of TRACE_COLOR_SWATCHES) assert.equal(traceColorHex(color), color, `${color} is a plain hex`);
    const plotManagerColors = /static COLORS = \[([^\]]*)\]/.exec(plotManagerSource)[1].match(/#[0-9A-Fa-f]{6}/g);
    assert.deepEqual(TRACE_COLOR_SWATCHES.slice(0, plotManagerColors.length), plotManagerColors.map(c => c.toLowerCase()),
        'the palette starts with the colours new traces get');

    const trace = { varName: 'v', fileId: 'f', color: '#2196F3' };
    assert.equal(setTraceColor(trace, '#2196f3'), false, 'the same colour in another case is no change');
    assert.equal(setTraceColor(trace, 'nonsense'), false, 'a colour that cannot be drawn is refused');
    assert.equal(trace.color, '#2196F3', 'and leaves the trace as it was');
    assert.equal(setTraceColor(trace, '#FF0080'), true);
    assert.equal(trace.color, '#ff0080', 'stored as the hex a session saves and the input reads back');
    assert.equal(setTraceColor(null, '#000000'), false);
}

// ── Order (#371) ─────────────────────────────────────────────────────────────
{
    assert.deepEqual(TRACE_MOVES, ['up', 'down', 'first', 'last']);
    assert.equal(traceMoveTarget(3, 0, 'up'), -1, 'the first cannot go up');
    assert.equal(traceMoveTarget(3, 0, 'first'), -1, 'nor to first');
    assert.equal(traceMoveTarget(3, 0, 'down'), 1);
    assert.equal(traceMoveTarget(3, 0, 'last'), 2);
    assert.equal(traceMoveTarget(3, 2, 'down'), -1, 'the last cannot go down');
    assert.equal(traceMoveTarget(3, 2, 'last'), -1, 'nor to last');
    assert.equal(traceMoveTarget(3, 1, 'up'), 0);
    assert.equal(traceMoveTarget(1, 0, 'down'), -1, 'one trace has nowhere to go');
    assert.equal(traceMoveTarget(3, 5, 'up'), -1, 'an index outside the list');
    assert.equal(traceMoveTarget(3, 1, 'sideways'), -1, 'an unknown move');

    const a = { n: 'a' }, b = { n: 'b' }, c = { n: 'c' }, d = { n: 'd' };
    assert.deepEqual(traceMovesAvailable([a, b, c], a), { up: false, down: true, first: false, last: true });
    assert.deepEqual(traceMovesAvailable([a, b, c], b), { up: true, down: true, first: true, last: true });
    assert.deepEqual(traceMovesAvailable([a, b, c], c), { up: true, down: false, first: true, last: false });
    assert.deepEqual(traceMovesAvailable([a], a), { up: false, down: false, first: false, last: false });
    assert.deepEqual(traceMovesAvailable([a, b], d), { up: false, down: false, first: false, last: false }, 'not in the list');

    const list = [a, b, c, d];
    const names = () => list.map(item => item.n).join('');
    assert.equal(moveTraceInList(list, c, 'up'), true); assert.equal(names(), 'acbd');
    assert.equal(moveTraceInList(list, c, 'down'), true); assert.equal(names(), 'abcd');
    assert.equal(moveTraceInList(list, d, 'first'), true); assert.equal(names(), 'dabc');
    assert.equal(moveTraceInList(list, d, 'last'), true); assert.equal(names(), 'abcd');
    assert.equal(moveTraceInList(list, b, 'last'), true); assert.equal(names(), 'acdb');
    assert.equal(moveTraceInList(list, a, 'up'), false, 'a move that does nothing says so');
    assert.equal(names(), 'acdb', 'and leaves the order alone');
    assert.equal(list.includes(b) && list.length === 4, true, 'the same objects, none lost');
    assert.equal(moveTraceInList(null, a, 'up'), false);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
{
    assert.match(traceStyleMethodsSource, /for \(const key of \['traces', 'phaseTraces'\]\)/,
        'the colour and order are the trace state\'s, for series and for pairs alike');
    assert.match(traceStyleMethodsSource, /_rebuildPanel\(panelId, \{ preserveView: true \}\)/,
        'a change rebuilds the panel with its view, so every analysis drawn from the series follows');
    assert.match(traceStyleMethodsSource, /queueMicrotask/, 'changes made in one go make one rebuild');
    assert.match(traceStyleMethodsSource, /input\.type = 'color'/, 'a colour of one\'s own through the browser\'s picker');
    assert.match(traceStyleMethodsSource, /addEventListener\('change'/, 'applied once picked, not on every move of the picker');
    assert.match(traceStyleMethodsSource, /owner\.list\.length > 1/, 'one trace has nothing to order');
    assert.match(traceStyleMethodsSource, /activePairIndex = index/, 'the 2D fit drawer keeps the pair it showed');
    assert.match(sessionSource, /traces: plot\.traces\.map\(t => this\._cloneSerializable\(t\)\)/,
        'a saved view keeps every trace state as it is, colour and order included');
    assert.match(compactSource, /_compactTraceStyleButtons\(trace, label\)/, 'the phone\'s trace rows offer them');
    assert.match(compactSource, /_compactTraceStyleButtons\(pair, label\)/, 'and its pair rows');

    for (const key of ['legendMenuColor', 'legendMenuMoveUp', 'legendMenuMoveDown', 'legendMenuMoveFirst',
        'legendMenuMoveLast', 'traceColorTitle', 'traceColorSwatch', 'traceColorCustom', 'compactTraceStyle',
        'compactTraceColor']) {
        assert.equal([...translationsSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 5,
            `${key} is translated in every supported language`);
    }
}

console.log('legend trace menu tests passed');
