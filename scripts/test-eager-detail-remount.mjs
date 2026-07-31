import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A layout re-render (language change, panel split, session restore) wipes the
// plot area with innerHTML = '' and remounts every panel, without calling
// _destroyChart. Traces big enough to need the eager-detail deferral therefore
// re-enter _createChart while plot.div still points at the *detached* graph
// div. This exercises that block against a fake DOM: it must rebuild the chart
// into the panel that is on screen now.

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');

const START = `        if (plot.mode === 'timeseries'
            && this._timeseriesNeedsEagerDetailLoading(plot)
            && !plot._eagerInitialDetailReady) {`;
const END = `
            return;
        }
`;
const start = manager.indexOf(START);
assert.ok(start >= 0, 'eager-detail deferral block is present in _createChart');
const end = manager.indexOf(END, start);
assert.ok(end > start, 'eager-detail deferral block is closed');
const block = manager.slice(start, end + END.length);

let liveDocument = null;
const runDeferral = vm.runInNewContext(
    `(function(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        ${block}
        return 'not-deferred';
    })`,
    { document: { querySelector: (selector) => liveDocument?.querySelector(selector) ?? null } },
);

function makePanel(panelId) {
    const panel = { panelId, isConnected: true, indicator: false };
    return panel;
}

function makeHarness(plot, panels) {
    let resolvePaint;
    const harness = {
        plots: new Map([['panel', plot]]),
        created: [],
        paint: () => resolvePaint(),
        _timeseriesNeedsEagerDetailLoading: () => true,
        _setEagerDetailLoading(_plot, loading, panelEl) {
            if (panelEl) panelEl.indicator = loading;
        },
        _yieldForDetailIndicatorPaint() {
            return new Promise(resolve => { resolvePaint = resolve; });
        },
        _createChart(panelId, panelEl) {
            harness.created.push(panelEl);
            plot.div = { isConnected: true };
        },
    };
    liveDocument = {
        // Like the real querySelector: only elements still in the document match.
        querySelector(selector) {
            const match = /\.layout-panel\[data-id="(.+)"\]/.exec(selector);
            if (!match) return null;
            return panels.find(p => p.panelId === match[1] && p.isConnected) || null;
        },
    };
    return harness;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// 1. The reported bug: after a language change the panel element and the graph
//    div are both detached, and the rebuild must still happen.
{
    const stalePanel = makePanel('panel');
    const freshPanel = makePanel('panel');
    const plot = { mode: 'timeseries', div: { isConnected: true } };
    const harness = makeHarness(plot, [stalePanel, freshPanel]);

    // Panel is mounted with a live chart; then the layout re-render detaches both.
    stalePanel.isConnected = false;
    plot.div.isConnected = false;

    assert.equal(runDeferral.call(harness, 'panel', freshPanel), undefined, 'first pass defers');
    assert.equal(freshPanel.indicator, true, 'the progress pill is shown while the rebuild waits');
    harness.paint();
    await settle();

    assert.deepEqual(harness.created, [freshPanel], 'the chart is rebuilt into the remounted panel');
    assert.equal(plot._eagerInitialDetailReady, true);
    assert.equal(plot._eagerInitialDetailDeferred, undefined);
}

// 2. The guard still does its job: a chart that is actually on screen is never
//    rebuilt on top of itself.
{
    const panel = makePanel('panel');
    const plot = { mode: 'timeseries', div: { isConnected: true } };
    const harness = makeHarness(plot, [panel]);

    assert.equal(runDeferral.call(harness, 'panel', panel), undefined, 'first pass defers');
    harness.paint();
    await settle();

    assert.deepEqual(harness.created, [], 'a live chart is left alone');
    assert.equal(panel.indicator, false, 'the pill is cleared when the rebuild is skipped');
    assert.equal(plot._eagerInitialDetailDeferred, undefined);
}

// 3. Two re-renders in a row: the deferral captured the first panel, but by the
//    time it runs a second one is mounted. It must target the live one.
{
    const firstPanel = makePanel('panel');
    const secondPanel = makePanel('panel');
    const plot = { mode: 'timeseries' };
    const harness = makeHarness(plot, [firstPanel, secondPanel]);

    runDeferral.call(harness, 'panel', firstPanel);
    // Second render, while the deferral is still pending.
    firstPanel.isConnected = false;
    assert.equal(
        runDeferral.call(harness, 'panel', secondPanel),
        undefined,
        're-entry while deferred does not start a second pass',
    );
    harness.paint();
    await settle();

    assert.deepEqual(harness.created, [secondPanel], 'the chart lands in the panel that is on screen');
}

// 4. The panel is gone for good (closed): nothing is created, no state is left.
{
    const panel = makePanel('panel');
    const plot = { mode: 'timeseries' };
    const harness = makeHarness(plot, [panel]);

    runDeferral.call(harness, 'panel', panel);
    panel.isConnected = false;
    harness.paint();
    await settle();

    assert.deepEqual(harness.created, [], 'a closed panel gets no chart');
    assert.equal(plot._eagerInitialDetailDeferred, undefined, 'the deferral flag is released');
}

// 5. Mode changed while deferred (the token is reset by _destroyChart): drop it.
{
    const panel = makePanel('panel');
    const plot = { mode: 'timeseries' };
    const harness = makeHarness(plot, [panel]);

    runDeferral.call(harness, 'panel', panel);
    plot.mode = 'fft';
    harness.paint();
    await settle();

    assert.deepEqual(harness.created, [], 'a panel that left timeseries gets no timeseries chart');
    assert.equal(panel.indicator, false);
}

console.log('Eager-detail remount tests passed.');
