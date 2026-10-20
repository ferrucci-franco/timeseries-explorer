// The parts of tabs and of "a view on other files" that need no browser:
// which files of a view the user is asked about, how the tabs off screen are
// written into a view and read back with the file ids of the open files, and
// how Shift+click options reach them. The browser half is
// scripts/e2e-workspace-tabs.mjs.
import assert from 'node:assert/strict';
import { installSessionMethods } from '../src/app/methods/session-methods.js';
import { installTabMethods } from '../src/app/methods/tab-methods.js';

class Harness {
    constructor() {
        this.capabilities = { isDesktop: true };
        this.files = new Map();
        this.plotManager = { files: new Map(), plots: new Map() };
        this.layoutManager = {
            root: { type: 'panel', id: 'p_live' },
            _n: 0,
            _uid() { this._n += 1; return `p_new${this._n}`; },
        };
        this._renderTabs = () => {};
        this._capturePlotSessions = () => [];
    }
    _fileDisplayName(entry) { return `${entry.name}${entry.extension}`; }
    open(fileId, name, variables, contentHash = '') {
        this.files.set(fileId, { name, extension: '.csv', contentHash });
        this.plotManager.files.set(fileId, { data: { variables: Object.fromEntries(variables.map(v => [v, { name: v }])) } });
    }
}
installSessionMethods(Harness);
installTabMethods(Harness);

const trace = (fileId, varName) => ({ fileId, varName });
const session = (files, plots, tabs = null) => ({ files, plots, tabs });
const meta = (id, name, extra = {}) => ({ id, name, extension: '.csv', displayName: `${name}.csv`, contentHash: `h-${name}`, ...extra });

// ── Which files of a view are asked about ──
{
    const app = new Harness();
    app.open('f1', 'run_10h', ['time', 'a', 'b'], 'h-run_10h');
    // The same file (by content): matched silently, nothing to ask.
    let view = session([meta('s1', 'run_10h')], [{ traces: [trace('s1', 'a')] }]);
    let map = app._matchSessionFiles(view);
    assert.equal(map.get('s1'), 'f1');
    assert.deepEqual(app._sessionFilesToConfirm(view, map), []);

    // Another file with the same signals: matched, but asked about, since its
    // CSV parsing has to be the user's call.
    const next = new Harness();
    next.open('f2', 'run_11h', ['time', 'a', 'b'], 'h-run_11h');
    map = next._matchSessionFiles(view);
    assert.equal(map.get('s1'), 'f2', 'the signals still match the next file');
    assert.deepEqual(next._sessionFilesToConfirm(view, map).map(m => m.id), ['s1']);
    assert.deepEqual(next._sessionRemapCandidates(view, map, next._sessionFilesToConfirm(view, map)).map(c => c.fileId), ['f2']);

    // A file without the signals: missing, asked about, the open file offered.
    const other = new Harness();
    other.open('f3', 'other', ['time', 'x']);
    view = session([meta('s1', 'run_10h')], [{ traces: [trace('s1', 'a')] }]);
    map = other._matchSessionFiles(view);
    assert.equal(map.has('s1'), false);
    const asked = other._sessionFilesToConfirm(view, map);
    assert.deepEqual(asked.map(m => m.id), ['s1']);
    assert.deepEqual(other._sessionRemapCandidates(view, map, asked).map(c => c.fileId), ['f3']);
    assert.deepEqual(other._sessionSignalsLeftOut(view, new Map([['s1', 'f3']]), new Set(['f3'])), ['a']);
}

// A file already serving another of the view's files is not offered twice.
{
    const app = new Harness();
    app.open('f1', 'model', ['time', 'x'], 'h-model');
    app.open('f2', 'run_11h', ['time', 'a']);
    const view = session(
        [meta('s1', 'model'), meta('s2', 'run_10h')],
        [{ traces: [trace('s1', 'x'), trace('s2', 'a')] }],
    );
    const map = app._matchSessionFiles(view);
    const asked = app._sessionFilesToConfirm(view, map);
    assert.deepEqual(asked.map(m => m.id), ['s2']);
    assert.deepEqual(app._sessionRemapCandidates(view, map, asked).map(c => c.fileId), ['f2']);
}

// ── Tabs off screen: required signals, written and read back ──
{
    const app = new Harness();
    app.open('f1', 'run_10h', ['time', 'a', 'b'], 'h-run_10h');
    app._ensureTabsState();
    app.tabs.items.push({ id: 'tab_x', number: 2, name: 'Detalle', snapshot: {
        layout: { type: 'panel', id: 'p_hidden' },
        plots: [{ panelId: 'p_hidden', mode: 'timeseries', traces: [trace('f1', 'b')], phaseTraces: [], stateSlots: { fileId: 'f1', x: [], dx: [] } }],
    } });
    const saved = app._captureTabsForSession();
    assert.equal(saved.activeIndex, 0);
    assert.deepEqual(saved.items.map(item => item.name), ['', 'Detalle']);
    assert.equal(saved.items[0].active, true, 'the tab on screen is the view itself');
    assert.equal(saved.items[1].plots[0].traces[0].varName, 'b');

    // A signal plotted only in a tab off screen is still required of its file.
    const view = session([meta('f1', 'run_10h')], [{ traces: [trace('f1', 'a')] }], saved);
    assert.deepEqual(app._sessionRequiredVariables('f1', view).sort(), ['a', 'b']);

    // Read back with the ids of other open files; an unmapped trace is left out.
    const loaded = new Harness();
    saved.items[1].plots[0].traces.push(trace('gone', 'z'));
    loaded._applySessionTabs({ tabs: saved }, new Map([['f1', 'f9']]));
    assert.equal(loaded.tabs.items.length, 2);
    assert.equal(loaded.tabs.activeIndex, 0);
    assert.equal(loaded.tabs.items[1].name, 'Detalle');
    const plot = loaded.tabs.items[1].snapshot.plots[0];
    assert.deepEqual(plot.traces, [trace('f9', 'b')]);
    assert.equal(plot.stateSlots.fileId, 'f9');

    // Where there are no tabs (the web build), a view with tabs is its one tab,
    // and nothing off screen is required of the files.
    const web = new Harness();
    web.capabilities = { isDesktop: false };
    assert.equal(web._captureTabsForSession(), null);
    assert.deepEqual(web._sessionRequiredVariables('f1', view), ['a']);
    web._applySessionTabs({ tabs: saved }, new Map([['f1', 'f9']]));
    assert.equal(web.tabs.items.length, 1);
}

// ── A duplicated tab gets panel ids of its own ──
{
    const app = new Harness();
    const copy = app._withFreshPanelIds({
        layout: { type: 'split', id: 's1', children: [{ type: 'panel', id: 'a' }, { type: 'panel', id: 'b' }] },
        plots: [{ panelId: 'a' }, { panelId: 'b' }],
    });
    const ids = [copy.layout.children[0].id, copy.layout.children[1].id];
    assert.ok(!ids.includes('a') && !ids.includes('b'));
    assert.deepEqual(copy.plots.map(p => p.panelId), ids);
}

// ── Shift+click options and the Live View policy reach the tabs off screen ──
{
    const app = new Harness();
    app._ensureTabsState();
    app.tabs.items.push({ id: 'tab_x', number: 2, name: '', snapshot: { layout: {}, plots: [
        { mode: 'timeseries', showSamples: false, traces: [{ varName: 'a' }, { varName: 'b', lineShape: 'linear' }], liveView: { xMode: 'autoscale' } },
        { mode: 'phase2d', showSamples: false, traces: [], liveView: { viewMode: 'keep' } },
    ] } });
    app._applyPlotPatchToHiddenTabs({ key: 'showSamples', value: true });
    app._applyPlotPatchToHiddenTabs({ lineShape: 'hv' });
    app._applyPlotPatchToHiddenTabs({ liveView: { family: 'timeseries', patch: { xMode: 'sliding', windowSeconds: 10 } } });
    const [ts, phase] = app.tabs.items[1].snapshot.plots;
    assert.equal(ts.showSamples, true);
    assert.equal(phase.showSamples, false, 'only time plots');
    assert.deepEqual(ts.traces.map(t => t.lineShape), ['hv', 'hv']);
    assert.deepEqual(ts.liveView, { xMode: 'sliding', windowSeconds: 10 });
    assert.deepEqual(phase.liveView, { viewMode: 'keep' }, 'the time-series policy is not the phase one');
    app._applyPlotPatchToHiddenTabs({ lineShape: 'auto' });
    assert.deepEqual(ts.traces.map(t => t.lineShape), [undefined, undefined], 'Auto lets each variable decide again');
}

console.log('Workspace tabs and view remapping checks passed.');
