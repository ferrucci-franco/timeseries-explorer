// The parts of the Dashboard mode that need no browser: which sample a card
// shows for an instant, how a value is written, the colour of the text on a
// card's background, how a unit goes into a variable's description, and how
// a saved dashboard is read back. The browser half is scripts/e2e-dashboard.mjs.
import assert from 'node:assert/strict';
import {
    describeWithUnit,
    formatDashboardValue,
    lastIndexAtOrBefore,
    normalizeCardSettings,
    normalizeDashboardState,
    readableTextColor,
    installPlotDashboardMethods,
} from '../src/plots/methods/dashboard-methods.js';

// The last sample at or before the instant: a value holds until the next one.
{
    const times = new Float64Array([0, 1, 2, 3]);
    assert.equal(lastIndexAtOrBefore(times, -0.5), -1, 'before the first sample: none');
    assert.equal(lastIndexAtOrBefore(times, 0), 0);
    assert.equal(lastIndexAtOrBefore(times, 1.99), 1);
    assert.equal(lastIndexAtOrBefore(times, 2), 2, 'exactly on a sample: that one');
    assert.equal(lastIndexAtOrBefore(times, 99), 3, 'past the end: the last');
    assert.equal(lastIndexAtOrBefore([], 1), -1);
    assert.equal(lastIndexAtOrBefore(times, NaN), -1);
    // Repeated instants: the last row written at that instant.
    assert.equal(lastIndexAtOrBefore([0, 1, 1, 1, 2], 1), 3);
}

{
    assert.equal(formatDashboardValue(22.987654321), '22.9877', 'auto: six significant digits');
    assert.equal(formatDashboardValue(1042.9), '1042.9', 'without padded zeros');
    assert.equal(formatDashboardValue(5), '5');
    assert.equal(formatDashboardValue(0), '0');
    assert.equal(formatDashboardValue(0.00001234), '1.234e-5', 'very small: exponent');
    assert.equal(formatDashboardValue(123456789), '1.235e+8', 'very large: exponent');
    assert.equal(formatDashboardValue(22.99, '1'), '23.0', 'fixed decimals');
    assert.equal(formatDashboardValue(3, '2'), '3.00');
    assert.equal(formatDashboardValue(NaN), 'NaN');
    assert.equal(formatDashboardValue(Infinity), '∞');
    assert.equal(formatDashboardValue(-Infinity), '−∞');
    assert.equal(formatDashboardValue(null), '—', 'no sample');
    assert.equal(formatDashboardValue('ON'), 'ON', 'a text signal shows its text');
    assert.equal(formatDashboardValue(true), 'true');
}

{
    assert.equal(readableTextColor('#ffeb3b'), '#1a1a1a', 'dark text on yellow');
    assert.equal(readableTextColor('#ff9800'), '#1a1a1a', 'dark text on orange');
    assert.equal(readableTextColor('#2196f3'), '#ffffff', 'white text on blue');
    assert.equal(readableTextColor('#000000'), '#ffffff');
    assert.equal(readableTextColor(''), '', 'no colour: the theme decides');
}

// The unit goes where every reader takes it from: "[unit]" in the description.
{
    assert.equal(describeWithUnit('', '°C'), '[°C]');
    assert.equal(describeWithUnit('Reactor temperature', '°C'), 'Reactor temperature [°C]');
    assert.equal(describeWithUnit('Reactor temperature [K]', '°C'), 'Reactor temperature [°C]', 'replaces the file\'s');
    assert.equal(describeWithUnit('Mass [kg|g]', 'lb'), 'Mass [lb]');
    assert.equal(describeWithUnit('Reactor temperature [K]', ''), 'Reactor temperature [K]', 'no unit: the file\'s description');
}

// Saved state read back: anything unknown falls back to the defaults.
{
    assert.deepEqual(normalizeDashboardState({}), { follow: true, time: null, size: 'm', separators: [] });
    assert.deepEqual(normalizeDashboardState({ follow: false, time: 12.5, size: 'l' }), { follow: false, time: 12.5, size: 'l', separators: [] });
    assert.deepEqual(normalizeDashboardState({ follow: 'x', time: 'soon', size: 'xxl' }), { follow: true, time: null, size: 'm', separators: [] });
    assert.deepEqual(
        normalizeDashboardState({ separators: [{ id: 's1', title: 'Reactor', bg: '#FB8C00', at: 2.7 }, { at: -3 }] }).separators.map(({ id, ...rest }) => rest),
        [{ title: 'Reactor', bg: '#fb8c00', at: 2 }, { title: '', bg: '', at: 0 }],
        'a separator: its title, colour and the cards before it',
    );
    assert.equal(normalizeDashboardState({ separators: [{ id: 's1' }] }).separators[0].id, 's1', 'its id kept');
    assert.ok(normalizeDashboardState({ separators: [{}] }).separators[0].id, 'or given one');
    assert.deepEqual(
        normalizeCardSettings({ title: 'T', description: 'Reactor inlet', bg: '#FF9800', decimals: 2, span: 2 }),
        { title: 'T', description: 'Reactor inlet', bg: '#ff9800', decimals: '2', span: 2 },
    );
    assert.deepEqual(
        normalizeCardSettings({ bg: 'red', decimals: 9, span: 7 }),
        { title: '', description: '', bg: '', decimals: 'auto', span: 1 },
        'only #rrggbb, only 0–6 decimals, only 1–3 columns',
    );
}

// Cards and separators as one sequence: a separator is kept by the number of
// cards before it, and moving any item counts them again.
{
    class Harness {
        constructor() { this.plots = new Map(); }
    }
    installPlotDashboardMethods(Harness);
    const pm = new Harness();
    // No DOM here: what draws is left out.
    for (const name of ['_renderDashboardCards', '_closeDashboardCardEditor', '_rebuildPanel', '_refreshActionBtns']) pm[name] = () => {};
    const trace = name => ({ varName: name, fileId: 'f1' });
    const plot = {
        traces: ['a', 'b', 'c', 'd'].map(trace),
        dashboard: normalizeDashboardState({ separators: [{ id: 'top', at: 0 }, { id: 'mid', at: 2 }, { id: 'end', at: 9 }] }),
    };
    pm.plots.set('p', plot);
    const order = () => pm._dashboardItems(plot).map(item => item.type === 'card' ? item.trace.varName : item.sep.id);
    assert.deepEqual(order(), ['top', 'a', 'b', 'mid', 'c', 'd', 'end'], 'a separator past the last card goes at the end');

    // A card dragged over the separator: it joins the section below.
    pm._moveDashboardItem('p', 1, 4); // a, dropped before c
    assert.deepEqual(order(), ['top', 'b', 'mid', 'a', 'c', 'd', 'end']);
    assert.deepEqual(plot.traces.map(t => t.varName), ['b', 'a', 'c', 'd'], 'the cards in their new order');
    assert.deepEqual(plot.dashboard.separators.map(sep => [sep.id, sep.at]), [['top', 0], ['mid', 1], ['end', 4]]);

    // A separator moved takes no card with it.
    pm._moveDashboardItem('p', 2, 0); // mid, before top
    assert.deepEqual(order(), ['mid', 'top', 'b', 'a', 'c', 'd', 'end']);

    // A card removed: the separators after it keep their place among the others.
    pm._removeDashboardCard('p', 0); // b
    assert.deepEqual(order(), ['mid', 'top', 'a', 'c', 'd', 'end']);

    // Added where asked; a card added later goes after the last separator.
    pm._addDashboardSeparator('p', 4, { title: 'Pressures' });
    assert.deepEqual(order().map(id => (id.startsWith('sep_') ? 'new' : id)), ['mid', 'top', 'a', 'c', 'new', 'd', 'end']);
    pm._removeDashboardSeparator('p', 'end');
    assert.ok(!order().includes('end'));
}

console.log('Dashboard checks passed.');
