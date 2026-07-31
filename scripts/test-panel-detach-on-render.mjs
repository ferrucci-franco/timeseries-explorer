import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// LayoutManager.render() throws every panel element away and builds new ones.
// The panel *state* survives — that is what separates a re-render from a close
// — but everything the chart hung off the old DOM does not. Without a teardown
// announced before the wipe, panels are rebuilt while still holding references
// to detached nodes: unpurged Plotly divs, observers on elements nobody can
// see, document-level listeners bound to dead panes.

// Flattened at the point of reading, so every needle below stays plain LF —
// the convention test-crlf-assumptions.mjs describes. .gitattributes pins the
// tree to LF, but a checkout that predates the pin can still hand back CRLF.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ─── render() calls the detach hook, for the live panels, before the wipe ────

const layout = read('src/ui/layout-manager.js');
const start = layout.indexOf('    render() {');
assert.ok(start >= 0, 'LayoutManager.render is present');
const end = layout.indexOf('\n    }\n', start);
assert.ok(end > start, 'LayoutManager.render is closed');
const body = layout.slice(layout.indexOf('{', start) + 1, end);

const renderFn = vm.runInNewContext(
    `(function() {${body}})`,
    { requestAnimationFrame: (fn) => fn() },
);

function makeHarness(panelIds) {
    const events = [];
    const harness = {
        events,
        scrollablePlotArea: false,
        _pendingRevealPanelId: null,
        root: { type: 'panel', id: 'root' },
        container: {
            scrollHeight: 0,
            scrollTop: 0,
            querySelectorAll(selector) {
                assert.equal(selector, '.layout-panel', 'detach is driven off the panel elements');
                return panelIds.map(id => ({ dataset: { id } }));
            },
            set innerHTML(value) {
                assert.equal(value, '', 'the container is cleared, not written to');
                events.push('wipe');
            },
            get innerHTML() { return ''; },
        },
        _renderNode() { events.push('rebuild'); },
        _applyScrollableLayout() {},
        _revealPanel() {},
        onPanelDetach: (id) => events.push(`detach:${id}`),
    };
    return harness;
}

{
    const harness = makeHarness(['p_a', 'p_b']);
    renderFn.call(harness);
    assert.deepEqual(
        harness.events,
        ['detach:p_a', 'detach:p_b', 'wipe', 'rebuild'],
        'every live panel is detached, in order, before the container is cleared',
    );
}

// A panel already removed from the tree and unmounted (closePanel) is gone from
// the DOM by now, so it is not detached a second time.
{
    const harness = makeHarness([]);
    renderFn.call(harness);
    assert.deepEqual(harness.events, ['wipe', 'rebuild'], 'nothing to detach when no panel is mounted');
}

// The hook stays optional: LayoutManager is usable without an owner.
{
    const harness = makeHarness(['p_a']);
    harness.onPanelDetach = null;
    renderFn.call(harness);
    assert.deepEqual(harness.events, ['wipe', 'rebuild'], 'render works with no detach hook installed');
}

// ─── the hook is wired all the way through ──────────────────────────────────

assert.match(
    read('src/ui/layout-manager.js'),
    /this\.onPanelDetach\s*=\s*null/,
    'LayoutManager declares the hook',
);
assert.match(
    read('src/app/viewer-app.js'),
    /layoutManager\.onPanelDetach\s*=\s*\(id\)\s*=>\s*this\.plotManager\.onPanelDetach\(id\)/,
    'the viewer connects the layout hook to the plot manager',
);
assert.match(
    read('src/plots/plot-manager.js'),
    /this\.onPanelDetach\s*=\s*\(id\)\s*=>\s*this\._destroyChart\(id\)/,
    'the plot manager tears the chart down on detach',
);

// ─── handler installation is keyed on the divs, never on a boolean ──────────

// A boolean latch only a teardown resets is the failure mode this whole change
// is about: the rebuilt panel gets new divs, the latch still reads "installed",
// and the panes end up with no handlers at all — no relayout recompute, no
// legend clicks — without anything reporting it.
const installGuards = {
    'src/plots/methods/fft-methods.js': ['_fftHandlerTimeDiv', '_fftHandlerSpectrumDiv'],
    'src/plots/methods/histogram-methods.js': ['_histHandlerTimeDiv', '_histHandlerAnalysisDiv'],
    'src/plots/methods/heatmap-methods.js': ['_calendarHeatmapHandlerTimeDiv', '_calendarHeatmapHandlerAnalysisDiv'],
    'src/plots/methods/temporal-profile-methods.js': ['_temporalProfileHandlerTimeDiv', '_temporalProfileHandlerAnalysisDiv'],
};
for (const [path, keys] of Object.entries(installGuards)) {
    const source = read(path);
    for (const key of keys) {
        assert.ok(source.includes(`plot.${key} === plot.`), `${path} compares ${key} against the live div`);
        assert.ok(source.includes(`plot.${key} = plot.`), `${path} records ${key} for the next comparison`);
    }
}

for (const path of [...Object.keys(installGuards), 'src/plots/plot-manager.js']) {
    assert.doesNotMatch(
        read(path),
        /HandlersInstalled/,
        `${path} has no boolean install latch left`,
    );
}

// ─── cursor listeners are cleaned up per view, not by one flat key ──────────

// They are stored as _cursorDocListeners_<viewId>, one per pane. Re-installing
// drops the previous set, but a closed panel never re-installs, so a teardown
// that only knew the flat key left them on document for the session.
const manager = read('src/plots/plot-manager.js');
assert.match(manager, /key\.startsWith\('_cursorDocListeners'\)/, 'teardown sweeps every cursor listener key');
assert.match(manager, /key\.startsWith\('_cursorHandlersDiv'\)/, 'teardown sweeps every cursor guard key');
assert.match(
    read('src/plots/methods/interaction-methods.js'),
    /const docKey = `_cursorDocListeners_\$\{view\.id\}`/,
    'cursor listeners are still keyed per view — the sweep above depends on the prefix',
);

console.log('Panel detach-on-render tests passed.');
