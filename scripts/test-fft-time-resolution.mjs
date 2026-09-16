// The FFT time pane must redraw at the resolution of what is ON SCREEN.
//
//   node scripts/test-fft-time-resolution.mjs
//
// Reported from an audio file: zoom the time pane in, then hide or show a curve
// from the legend, and the remaining curves come back coarse — the full-signal
// decimation drawn inside a narrow window, which for audio is an aliased mess.
// Panning or double-clicking fixed it, because those go through the relayout
// path that rebuilds traces for the visible range.
//
// The cause is that the legend rebuild called _buildFftTimeTraces(plot) with no
// range at all, so every curve was decimated over the whole signal while the
// axis stayed zoomed. Nine call sites share that rebuild (legend click, the
// legend menu, closing a curve, adding one, the windowed overlay), so they were
// all affected.
//
// The fix must not cost a second draw: the rebuild has to ask for the right
// points the first time rather than redraw and then restyle. That is what the
// "one react, no follow-up restyle" checks below are for — and the reason a
// full-domain view must still build with `null`, which is what lets each trace
// reuse its cached full-series overview instead of rescanning the source.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');

const isolate = (name, context = {}) => {
    const start = source.indexOf(`proto.${name} = function`);
    assert.ok(start >= 0, `${name} is declared`);
    const end = source.indexOf('\n};', start);
    assert.ok(end > start, `${name} can be isolated`);
    const proto = {};
    vm.runInNewContext(source.slice(start, end + '\n};'.length), { proto, ...context });
    return proto[name];
};

let checks = 0;

const DOMAIN = { min: 0, max: 24 };

// A panel in FFT mode whose time pane is currently showing `range`.
function makePlot(range, { lazy = false } = {}) {
    return {
        mode: 'fft',
        traces: [
            { varName: 'left', fileId: 'f1', visible: true },
            { varName: 'right', fileId: 'f1', visible: 'legendonly' },
        ],
        div: { _fullLayout: { xaxis: { range: range ? range.slice() : undefined, autorange: !range } } },
        fftDiv: {},
        _lazy: lazy,
    };
}

// The host object, with every collaborator of _refreshFftTimePlot stubbed and a
// log of what the rebuild asked for.
function makeHost(plot) {
    const calls = { buildRanges: [], reacts: 0, viewportRefreshes: 0 };
    const host = {
        plots: new Map([['p1', plot]]),
        files: new Map([['f1', { data: plot._lazy ? { _duckdb: {} } : {} }]]),
        _fftDomain: () => DOMAIN,
        _coerceAxisValue: (value) => Number(value),
        _buildFftTimeLayout: () => ({}),
        _getPlotlyConfig: () => ({}),
        _buildFftTimeTraces: (_plot, visibleRange = null) => {
            calls.buildRanges.push(visibleRange === null || visibleRange === undefined
                ? null
                : Array.from(visibleRange));
            return [{ x: [], y: [] }];
        },
        _installLegendHoverHint: () => {},
        _installCursorHandlers: () => {},
        _installFftSelectionHandlers: () => {},
        _syncCursorDisplay: () => {},
        _refreshTimeseriesVisuals: () => { calls.viewportRefreshes++; },
    };
    const Plotly = { react: () => { calls.reacts++; return Promise.resolve(); } };
    host._refreshFftTimePlot = isolate('_refreshFftTimePlot', { Plotly });
    host._fftNormalizeBuildRange = isolate('_fftNormalizeBuildRange', { Plotly });
    return { host, calls };
}

// ─── Zoomed in: the rebuild must ask for the visible window ─────────────────
//
// This is the reported bug. Before the fix the recorded range was `null`, so the
// curve drawn into a 1-second window held the ~2000 points chosen for 24
// seconds — a few dozen of which actually landed in view.
{
    const plot = makePlot([5, 6]);
    const { host, calls } = makeHost(plot);
    await host._refreshFftTimePlot('p1', plot, { preserveView: true });

    assert.deepEqual(calls.buildRanges, [[5, 6]], 'the rebuild must decimate for the visible window');
    assert.equal(calls.reacts, 1, 'exactly one draw');
    assert.equal(calls.viewportRefreshes, 0, 'an eager panel needs no follow-up restyle');
    checks++;
}

// Any zoom, not just that one, and a reversed range is still the same window.
for (const range of [[0, 1], [11.5, 11.75], [23, 24], [6, 5]]) {
    const plot = makePlot(range);
    const { host, calls } = makeHost(plot);
    await host._refreshFftTimePlot('p1', plot, { preserveView: true });
    assert.deepEqual(calls.buildRanges, [range], `zoom ${JSON.stringify(range)} must reach the trace builder`);
    checks++;
}

// ─── The whole signal must still build from the cached overview ────────────
//
// The cheap path, and the reason this is not simply "always pass the range":
// a window that happens to contain every sample would make _buildTimeTrace
// rescan the source instead of reusing the overview it already has.
{
    for (const range of [[0, 24], [-0.000000001, 24.000000001], [-3, 30]]) {
        const plot = makePlot(range);
        const { host, calls } = makeHost(plot);
        await host._refreshFftTimePlot('p1', plot, { preserveView: true });
        assert.deepEqual(calls.buildRanges, [null], `a full-domain view (${JSON.stringify(range)}) builds from the overview`);
        checks++;
    }

    // A window one part in 1e9 narrower than the domain is still the full view:
    // that is float noise from an autoscale, not a zoom anybody performed.
    const plot = makePlot([1e-12, 24 - 1e-12]);
    const { host, calls } = makeHost(plot);
    await host._refreshFftTimePlot('p1', plot, { preserveView: true });
    assert.deepEqual(calls.buildRanges, [null], 'autoscale float noise is not a zoom');
    checks++;
}

// A rebuild that does NOT preserve the view resets the axis to the full domain,
// so it must build for the full domain too.
{
    const plot = makePlot([5, 6]);
    const { host, calls } = makeHost(plot);
    await host._refreshFftTimePlot('p1', plot);
    assert.deepEqual(calls.buildRanges, [null], 'a view-resetting rebuild builds the whole signal');
    checks++;
}

// preserveX: false means the x range is not kept, so it must not steer the
// resolution either.
{
    const plot = makePlot([5, 6]);
    const { host, calls } = makeHost(plot);
    await host._refreshFftTimePlot('p1', plot, { preserveView: true, preserveX: false });
    assert.deepEqual(calls.buildRanges, [null], 'preserveX:false drops the window');
    checks++;
}

// ─── Lazy files keep their exact viewport query ─────────────────────────────
//
// The windowed overview is the right first frame; the DuckDB query that follows
// replaces it with real samples. Both still happen.
{
    const plot = makePlot([5, 6], { lazy: true });
    const { host, calls } = makeHost(plot);
    await host._refreshFftTimePlot('p1', plot, { preserveView: true });
    assert.deepEqual(calls.buildRanges, [[5, 6]], 'a lazy panel also gets the windowed first frame');
    assert.equal(calls.viewportRefreshes, 1, 'and still runs its viewport query');
    checks++;
}

// ─── The range normalizer, on its own ──────────────────────────────────────
//
// Shared with _refreshTimeseriesVisuals, which had this rule inline: both paths
// have to agree on what "the whole signal" means or the same view would build
// two different ways depending on how it was reached.
{
    const normalize = isolate('_fftNormalizeBuildRange');
    const host = {
        _fftDomain: () => DOMAIN,
        _coerceAxisValue: (value) => Number(value),
        _fftNormalizeBuildRange: normalize,
    };
    assert.equal(host._fftNormalizeBuildRange(null, null), null, 'no range stays no range');
    assert.equal(host._fftNormalizeBuildRange(null, [0, 24]), null, 'the full domain collapses to null');
    assert.deepEqual(host._fftNormalizeBuildRange(null, [5, 6]), [5, 6], 'a window is passed through');
    assert.deepEqual(host._fftNormalizeBuildRange(null, [0, 12]), [0, 12], 'half the signal is a window');
    assert.deepEqual(host._fftNormalizeBuildRange(null, [12, 24]), [12, 24], 'the far half too');

    // Without a domain there is nothing to compare against, so the range stands.
    const domainless = {
        _fftDomain: () => null,
        _coerceAxisValue: (value) => Number(value),
        _fftNormalizeBuildRange: normalize,
    };
    assert.deepEqual(domainless._fftNormalizeBuildRange(null, [5, 6]), [5, 6], 'no domain, no normalization');

    // A date axis arrives as strings; _coerceAxisValue is what makes them
    // comparable, and a range it cannot read must not be silently widened.
    const unreadable = {
        _fftDomain: () => DOMAIN,
        _coerceAxisValue: () => NaN,
        _fftNormalizeBuildRange: normalize,
    };
    assert.deepEqual(unreadable._fftNormalizeBuildRange(null, [5, 6]), [5, 6], 'an unreadable range stands');
    checks++;
}

// ─── Gap decorations survive a windowed rebuild ────────────────────────────
//
// _buildFftTimeTraces used to read its range parameter as "this is a viewport
// refresh, skip the O(n) gap scan". Now that the parameter carries the window on
// every rebuild, that reading would have silently dropped the missing-data line
// breaks from every legend click on a zoomed pane. The scan is governed by
// _fftShouldSkipGlobalGapScan alone, which is the guard that exists for it.
{
    const buildTraces = isolate('_buildFftTimeTraces');
    const gaps = [{ from: 3, to: 4 }];
    const make = (skipScan) => {
        const applied = [];
        const host = {
            _buildFftTimeTraces: buildTraces,
            _fftShouldSkipGlobalGapScan: () => skipScan,
            _fftGapInfo: () => ({ perFile: [{ fileId: 'f1', gaps }] }),
            _buildTimeTrace: () => ({ x: [], y: [] }),
            _applyLineBreaks: (_trace, g) => applied.push(g ?? null),
            _ensureFftState: () => ({ showWindowed: false }),
            _fftCurrentVisibleRange: () => null,
            _buildFftWindowedTimeTraces: () => [],
        };
        return { host, applied };
    };

    for (const range of [null, [5, 6]]) {
        const { host, applied } = make(false);
        host._buildFftTimeTraces({ traces: [{ fileId: 'f1', varName: 'left' }] }, range);
        assert.deepEqual(applied, [gaps], `gap breaks are applied with range ${JSON.stringify(range)}`);
    }

    // The large-signal guard still turns the scan off, windowed or not.
    for (const range of [null, [5, 6]]) {
        const { host, applied } = make(true);
        host._buildFftTimeTraces({ traces: [{ fileId: 'f1', varName: 'left' }] }, range);
        assert.deepEqual(applied, [null], `the scan guard still holds with range ${JSON.stringify(range)}`);
    }
    checks++;
}

// ─── Entering FFT on a restored zoom ───────────────────────────────────────
//
// The same staleness by another route: the panes are created with the whole
// signal, then a saved session's view is applied on top. When that view is a
// zoom, the curves already drawn are the full-signal ones. Only a lazy file used
// to get a follow-up refresh, so an eager file restored into a zoom opened
// coarse and stayed that way until the first pan.
{
    const creationSource = source.slice(source.indexOf('proto._createFftChart = function'));
    const body = creationSource.slice(0, creationSource.indexOf('\n};'));
    const guard = body.match(/const zoomed = this\._fftNormalizeBuildRange\([^;]+;\s*\n\s*if \(hasLazyTrace \|\| zoomed\) this\._refreshTimeseriesVisuals\(/);
    assert.ok(guard, 'a restored zoom must trigger the viewport refresh, not just a lazy file');

    // And it must stay conditional: an unzoomed entry is the common case, where
    // the freshly drawn overview is already right and a restyle is wasted work.
    assert.ok(!/\n\s*this\._refreshTimeseriesVisuals\(panelId, plot\);\s*\n\s*\/\/ After any restored view/.test(body),
        'the refresh on creation stays conditional');
    checks++;
}

// ─── Every rebuild path goes through the one function ──────────────────────
//
// The fix lives in _refreshFftTimePlot because all nine rebuilds funnel through
// it. If a future change rebuilds the pane by calling Plotly.react directly, it
// would reintroduce the bug for that path alone — which is exactly how this one
// survived: the range parameter existed and no caller ever passed it.
{
    const reactCalls = [...source.matchAll(/Plotly\.react\(\s*plot\.div/g)];
    assert.equal(reactCalls.length, 1, 'the time pane is rebuilt in exactly one place');

    const refreshCalls = [...source.matchAll(/this\._refreshFftTimePlot\(/g)];
    assert.ok(refreshCalls.length >= 8, `every rebuild path uses it (found ${refreshCalls.length})`);
    checks++;
}

console.log(`FFT time-pane resolution: ${checks} checks passed`);
