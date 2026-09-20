// The data-tool preview updates the curve where it is drawn (#39, #48).
//
// Every preview refresh used to go through updateFileData, which DESTROYS and
// recreates every panel drawing the file. Three costs, all of them visible:
// the chart blanks and re-plots on each slider tick; the panel is rebuilt a
// second time just to apply the preview's dashed/markers style; and the purge
// lands on a graph div Plotly may still have a redraw queued for, whose
// auto-margin pass then throws on the `_fullLayout` that is no longer there —
// taking its redraw with it. Measured in the browser on a 300-row file: two
// panel rebuilds and three uncaught Plotly TypeErrors for a single preview,
// and one more of each per toggle.
//
// The contract that replaces it: values change → restyle in place; a style is
// handed to addTrace rather than applied afterwards; a curve comes off with
// deleteTraces. A rebuild only for the shapes none of that can answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/app/methods/data-tools-methods.js', import.meta.url), 'utf8');

// ── refreshTraceValues decides what it can answer for ───────────────────────
// Sliced out of the class and run against doubles: what matters here is which
// panel shapes it refuses, and that it drops the caches before restyling.
const marker = '    refreshTraceValues(fileId, varName) {';
const start = manager.indexOf(marker);
assert.ok(start >= 0, 'refreshTraceValues is present');
const endMarker = '\n    }';
const end = manager.indexOf(endMarker, start);
const body = manager.slice(start + marker.length, end);
const sandbox = { out: {} };
vm.runInNewContext(`out.refreshTraceValues = function(fileId, varName) {${body}\n};`, sandbox);
const refreshTraceValues = sandbox.out.refreshTraceValues;

const timeseriesPanel = (traces) => ({
    mode: 'timeseries', div: { _fullLayout: {} }, traces, phaseTraces: [], stateSlots: null,
});
const harness = (plots, variables = { v: {} }) => {
    const refreshed = [];
    const entry = { data: { variables }, _transformCache: { stale: true } };
    return {
        refreshed,
        entry,
        self: {
            files: new Map([['f1', entry]]),
            plots: new Map(plots),
            refreshTraceValues,
            _refreshTimeseriesVisuals(panelId) { refreshed.push(panelId); },
        },
    };
};

{
    const h = harness([['p1', timeseriesPanel([{ fileId: 'f1', varName: 'v' }])]]);
    assert.equal(h.self.refreshTraceValues('f1', 'v'), true, 'a timeseries panel can be restyled');
    assert.deepEqual(h.refreshed, ['p1'], 'and is');
    assert.equal(h.entry._transformCache, null, 'the cache the values are read through is dropped first');
    assert.equal(h.self.plots.get('p1')._missSig, null, 'and so are the missing-data caches');
}
{
    // Two panels drawing it, both restyled; one that does not, left alone.
    const h = harness([
        ['p1', timeseriesPanel([{ fileId: 'f1', varName: 'v' }])],
        ['p2', timeseriesPanel([{ fileId: 'f1', varName: 'other' }])],
        ['p3', timeseriesPanel([{ fileId: 'f1', varName: 'v' }, { fileId: 'f2', varName: 'v' }])],
    ]);
    assert.equal(h.self.refreshTraceValues('f1', 'v'), true);
    assert.deepEqual(h.refreshed, ['p1', 'p3']);
}
{
    const h = harness([['p1', timeseriesPanel([{ fileId: 'f2', varName: 'v' }])]]);
    assert.equal(h.self.refreshTraceValues('f1', 'v'), false, 'nothing draws it: nothing to refresh');
    assert.deepEqual(h.refreshed, []);
    assert.deepEqual(h.entry._transformCache, { stale: true }, 'and nothing is dropped either');
}
{
    const h = harness([['p1', timeseriesPanel([{ fileId: 'f1', varName: 'v' }])]], {});
    assert.equal(h.self.refreshTraceValues('f1', 'v'), false, 'a variable the file does not have');
}
// The shapes this cannot answer for — the caller still owes them a rebuild.
for (const [label, plot] of [
    ['an FFT panel', { mode: 'fft', div: { _fullLayout: {} }, traces: [{ fileId: 'f1', varName: 'v' }], phaseTraces: [] }],
    ['a panel with no chart yet', { mode: 'timeseries', div: null, traces: [{ fileId: 'f1', varName: 'v' }], phaseTraces: [] }],
    ['a purged div', { mode: 'timeseries', div: {}, traces: [{ fileId: 'f1', varName: 'v' }], phaseTraces: [] }],
    ['a phase pair', { mode: 'timeseries', div: { _fullLayout: {} }, traces: [], phaseTraces: [{ fileId: 'f1', x: 'v', y: 'w' }] }],
    ['a state animation', {
        mode: 'timeseries', div: { _fullLayout: {} }, traces: [], phaseTraces: [],
        stateSlots: { fileId: 'f1', x: ['v'], y: [], z: [] },
    }],
]) {
    const h = harness([['p1', plot]]);
    assert.equal(h.self.refreshTraceValues('f1', 'v'), false, `${label}: refused`);
    assert.deepEqual(h.refreshed, [], `${label}: and nothing was touched`);
    assert.deepEqual(h.entry._transformCache, { stale: true }, `${label}: including the caches`);
}
{
    // A refusal anywhere is a refusal everywhere: a half-updated file would
    // leave one panel showing the new values and another the old.
    const h = harness([
        ['p1', timeseriesPanel([{ fileId: 'f1', varName: 'v' }])],
        ['p2', { mode: 'fft', div: { _fullLayout: {} }, traces: [{ fileId: 'f1', varName: 'v' }], phaseTraces: [] }],
    ]);
    assert.equal(h.self.refreshTraceValues('f1', 'v'), false);
    assert.deepEqual(h.refreshed, [], 'nothing is restyled when the answer is no');
}

// ── How the preview uses it ─────────────────────────────────────────────────
assert.match(tools, /if \(!this\.plotManager\.refreshTraceValues\(fileId, name\)\) \{\s*\n\s*this\.plotManager\.updateFileData\(fileId, data\);/,
    'an existing preview trace is restyled, with updateFileData as the fallback');
assert.match(tools, /this\.plotManager\.addTrace\(panelId, name, panelEl, \{\s*\n\s*traceStyle: addedOnly \? \{ markersOnly: true \} : \{ dash: 'dot' \},/,
    'a new one is drawn in its own style from the start, not restyled by a rebuild');
assert.doesNotMatch(tools.slice(tools.indexOf('proto._drawDataToolPreviewTrace')),
    /_rebuildPanel\(panelId, \{ preserveView: true \}\)/,
    'so the second rebuild is gone');
assert.match(tools, /if \(inPlace\) this\.plotManager\.invalidateTransformCache\(preview\.fileId\);/,
    'and taking the preview down needs no rebuild either when the curve came off in place');
assert.match(tools, /const names = \[editing\.name, \.\.\.\(dependents \|\| \[\]\)\];/,
    'the edit preview covers the variables that ride along with it');

// ── The manager's side ──────────────────────────────────────────────────────
assert.match(manager, /removeTrace\(panelId, varName, fileId = null\) \{/,
    'removeTrace can be told which file it means');
assert.match(manager, /const index = plot\.traces\.findIndex\(t => t\.varName === varName\s*\n\s*&& \(fileId === null \|\| t\.fileId === fileId\)\);/,
    'so two files sharing a variable name cannot lose the wrong curve');
assert.match(manager, /\.\.\.\(options\.traceStyle \|\| \{\}\),/, 'a trace can be born with its style');
assert.match(manager, /invalidateTransformCache\(fileId\) \{/, 'and a file can drop its caches without a rebuild');

console.log('Data-tool preview in-place checks passed.');
