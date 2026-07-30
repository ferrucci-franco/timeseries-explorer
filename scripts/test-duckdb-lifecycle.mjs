// DuckDB engine lifecycle: what happens when startup fails, and what happens to
// a lazy dataset that is replaced.
//
// Both were leaks rather than wrong answers, which is why no existing test saw
// them. A failed bootstrap left the spawned worker running and cached the
// rejection, so one bad WASM fetch disabled the engine for the whole session.
// And replacing a file's data — every Reload, every adjust-CSV re-parse of a
// large CSV — abandoned the previous DuckDB view, its registered handle and the
// File snapshot pinned in the worker, accumulating until queries ran it out of
// memory.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;

// ── init() must not cache a rejection ────────────────────────────────────────
{
    const source = Object.create(DuckDbSource.prototype);
    source._db = null;
    source._initPromise = null;
    let attempts = 0;
    source._bootstrap = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('WASM fetch failed');
        source._db = { fake: true };
    };

    await assert.rejects(() => source.init(), /WASM fetch failed/, 'the first failure is reported');
    assert.equal(source._initPromise, null, 'the failed attempt is not kept');
    await source.init();
    assert.equal(attempts, 2, 'the next call really retries instead of rethrowing the stale error');
    assert.deepEqual(source._db, { fake: true }, 'and the engine ends up available');
}

// ── a failed bootstrap terminates the worker it spawned ──────────────────────
// The worker is created from a module-level namespace import that cannot be
// stubbed from here, so this pins the shape of the failure path: everything
// after `new Worker` is inside a try that terminates it.
{
    const source = readFileSync(new URL('../src/data/duckdb-source.js', import.meta.url), 'utf8');
    const bootstrap = source.slice(source.indexOf('async _bootstrap()'));
    const body = bootstrap.slice(0, bootstrap.indexOf('\n    async registerFile'));
    const workerAt = body.indexOf('new Worker(');
    const tryAt = body.indexOf('try {', workerAt);
    const terminateAt = body.indexOf('worker.terminate()', tryAt);
    assert.ok(workerAt >= 0, 'the bootstrap spawns a worker');
    assert.ok(tryAt > workerAt, 'everything after spawning it is guarded');
    assert.ok(terminateAt > tryAt, 'and the guard terminates the worker');
    assert.match(body.slice(tryAt), /catch \(err\)[\s\S]*worker\.terminate\(\)[\s\S]*throw err/,
        'the failure is still reported after cleaning up');
}

// ── replacing a lazy dataset releases the old one ────────────────────────────
// updateFileData is a method on PlotManager, whose module pulls in Plotly, so it
// is sliced out and run against a small mock — the same technique
// test-csv-export-time-columns.mjs uses.
{
    const managerSource = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
    const startMarker = '    updateFileData(fileId, newData, options = {}) {';
    const start = managerSource.indexOf(startMarker);
    assert.ok(start >= 0, 'updateFileData is present');
    const end = managerSource.indexOf('\n    setFileTransform(', start);
    assert.ok(end > start, 'method end located');
    const vm = await import('node:vm');
    const proto = {};
    vm.runInNewContext(
        managerSource.slice(start, end).replace(startMarker, 'proto.updateFileData = function(fileId, newData, options = {}) {'),
        { proto, console },
    );

    const released = [];
    const source = { release: (data) => { released.push(data.tag); return Promise.resolve(); } };
    const makeHarness = () => ({
        files: new Map(),
        plots: new Map(),
        updateFileData: proto.updateFileData,
        setGlobalLiveViewPolicy: () => {},
        _rebuildPanel: () => {},
        _rebuildAllPanels: () => {},
    });

    // Reload / adjust-CSV: a brand-new lazy registration replaces the old one.
    const reload = makeHarness();
    const oldData = { tag: 'old', _duckdb: { source, handle: 'h1' } };
    reload.files.set('f1', { data: oldData });
    reload.updateFileData('f1', { tag: 'new', _duckdb: { source, handle: 'h2' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(released, ['old'], 'the abandoned lazy dataset is released');

    // Live append hands the same object (and the same meta) back. Releasing here
    // would drop the view the app is still reading from.
    released.length = 0;
    const live = makeHarness();
    const liveData = { tag: 'live', _duckdb: { source, handle: 'h3' } };
    live.files.set('f2', { data: liveData });
    live.updateFileData('f2', liveData, { liveAppend: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(released, [], 'a dataset mutated in place is never released');

    // An eager dataset has nothing to release.
    released.length = 0;
    const eager = makeHarness();
    eager.files.set('f3', { data: { tag: 'eager' } });
    eager.updateFileData('f3', { tag: 'eager2' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(released, [], 'an eager dataset needs no release');
}

console.log('DuckDB lifecycle tests passed.');
