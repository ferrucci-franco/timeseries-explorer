// A lazy query that a newer request supersedes is stopped, unless someone else
// still waits for it; and an interrupt reaches the caller as an AbortError.
//
//   node scripts/test-lazy-superseded-query.mjs
//
// On a lazy file the heatmap, the temporal profile and the pair correlation
// each run a DuckDB query per recompute, shared through the source's cache
// with any panel that asks the same (#384). Checked:
//
//   · DuckDbSource._sharedQuery: a caller's signal lets go of that caller at
//     once (an AbortError), while another caller of the same query still gets
//     its result and the query is not interrupted; when the last caller lets
//     go, the query's own signal is aborted and the key is forgotten, so the
//     next ask starts afresh; a caller without a signal holds the query; a
//     result is kept under its key, a failure is not;
//   · _interactiveQuery: DuckDB's own interrupt error (the one cancelSent
//     makes a pending query throw), or a reader that trips on being
//     cancelled, comes back as an AbortError — by the caller's signal and by
//     cancelActiveQuery alike — and an error of a query nobody stopped is
//     passed on as it is;
//   · on a real DuckDB-WASM engine (the Node build), the three lazy queries of
//     a lazy CSV: two callers asking the same, one lets go and the other gets
//     the very result an unshared call gives; both let go, and the query is
//     gone from the cache.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;

const isAbort = (error) => error?.name === 'AbortError';
const settle = (promise) => promise.then(value => ({ value }), error => ({ error }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// ── _sharedQuery ────────────────────────────────────────────────────────────
{
    const source = new DuckDbSource();
    const cache = new Map();
    // A query that answers when told to, and records whether it was stopped.
    const controllable = () => {
        const query = { started: 0, signal: null, resolve: null, reject: null };
        query.start = (signal) => {
            query.started += 1;
            query.signal = signal;
            return new Promise((resolve, reject) => { query.resolve = resolve; query.reject = reject; });
        };
        return query;
    };

    // Two callers, one lets go: the other gets the result, the query runs on.
    let q = controllable();
    const first = new AbortController();
    const second = new AbortController();
    const a = settle(source._sharedQuery(cache, 'k', first.signal, q.start));
    const b = settle(source._sharedQuery(cache, 'k', second.signal, q.start));
    assert.equal(q.started, 1, 'the same key runs one query');
    first.abort();
    const left = await a;
    assert.ok(isAbort(left.error), 'the caller that let go gets an AbortError at once');
    assert.equal(q.signal.aborted, false, 'the query is not stopped while someone waits for it');
    assert.ok(cache.get('k') instanceof Promise, 'and it stays shared');
    q.resolve({ answer: 42 });
    assert.deepEqual((await b).value, { answer: 42 }, 'the other caller gets its result');
    await tick();
    assert.deepEqual(cache.get('k'), { answer: 42 }, 'the result is kept under its key');
    assert.deepEqual(await source._sharedQuery(cache, 'k', null, q.start), { answer: 42 }, 'and answers the next ask');
    assert.equal(q.started, 1, 'without running it again');

    // Every caller lets go: the query is stopped and forgotten.
    q = controllable();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = settle(source._sharedQuery(cache, 'stop', c1.signal, q.start));
    const p2 = settle(source._sharedQuery(cache, 'stop', c2.signal, q.start));
    c1.abort();
    assert.equal(q.signal.aborted, false, 'one caller left, one waits');
    c2.abort();
    assert.equal(q.signal.aborted, true, 'the last caller to let go stops the query');
    assert.equal(cache.has('stop'), false, 'and it is forgotten at once');
    assert.ok(isAbort((await p1).error) && isAbort((await p2).error), 'both callers hear an AbortError');
    q.reject(source._queryAbortError());
    const fresh = controllable();
    const p3 = settle(source._sharedQuery(cache, 'stop', null, fresh.start));
    assert.equal(fresh.started, 1, 'the next ask with the key starts afresh');
    fresh.resolve('again');
    assert.equal((await p3).value, 'again');

    // A caller without a signal holds the query.
    q = controllable();
    const c3 = new AbortController();
    const held = settle(source._sharedQuery(cache, 'held', null, q.start));
    const leaving = settle(source._sharedQuery(cache, 'held', c3.signal, q.start));
    c3.abort();
    assert.ok(isAbort((await leaving).error));
    assert.equal(q.signal.aborted, false, 'a caller with no signal keeps it running');
    q.resolve('kept');
    assert.equal((await held).value, 'kept');

    // A failure reaches every caller and is not kept.
    q = controllable();
    const f1 = settle(source._sharedQuery(cache, 'fail', null, q.start));
    const f2 = settle(source._sharedQuery(cache, 'fail', new AbortController().signal, q.start));
    q.reject(new Error('boom'));
    assert.equal((await f1).error?.message, 'boom');
    assert.equal((await f2).error?.message, 'boom');
    await tick();
    assert.equal(cache.has('fail'), false, 'a failed query is not kept');

    // A signal already aborted never starts it; no key shares nothing.
    q = controllable();
    const gone = new AbortController();
    gone.abort();
    assert.ok(isAbort((await settle(source._sharedQuery(cache, 'never', gone.signal, q.start))).error));
    assert.equal(q.started, 0, 'an aborted caller starts nothing');
    const own = new AbortController();
    const unshared = source._sharedQuery(cache, null, own.signal, q.start);
    await tick();
    assert.equal(q.signal, own.signal, 'with no key, the query carries the caller\'s signal');
    q.resolve('alone');
    assert.equal(await unshared, 'alone');

    // The cache keeps no more than its limit.
    const small = new Map();
    for (const key of ['x', 'y', 'z']) {
        const one = controllable();
        void source._sharedQuery(small, key, null, one.start, { limit: 2 });
        one.resolve(key);
    }
    await tick();
    assert.deepEqual([...small.keys()], ['y', 'z'], 'the oldest key goes past the limit');
    console.log('ok  _sharedQuery');
}

// ── _interactiveQuery: an interrupt is an AbortError ─────────────────────────
{
    // A connection whose query runs until cancelSent interrupts it, as
    // DuckDB-WASM's does: the pending send (or read) fails with DuckDB's own
    // error, not an AbortError.
    const interruptError = () => new Error('INTERRUPT Error: Interrupted!');
    const fakeSource = ({ stage }) => {
        const source = new DuckDbSource();
        source.init = async () => {};
        let fail = null;
        const pending = new Promise((_, reject) => { fail = reject; });
        pending.catch(() => null);
        source._conn = {
            send: async () => {
                if (stage === 'send') return pending;
                return { readAll: () => pending, cancel: async () => {} };
            },
            cancelSent: async () => { fail(interruptError()); return true; },
        };
        return source;
    };
    for (const stage of ['send', 'read']) {
        const source = fakeSource({ stage });
        const controller = new AbortController();
        const query = settle(source._interactiveQuery('SELECT 1', { signal: controller.signal }));
        await tick();
        controller.abort();
        const { error } = await query;
        assert.ok(isAbort(error), `interrupted while it ${stage === 'send' ? 'is sent' : 'is read'}: an AbortError (${error?.name}: ${error?.message})`);

        const other = fakeSource({ stage });
        const unsignalled = settle(other._interactiveQuery('SELECT 1'));
        await tick();
        await other.cancelActiveQuery();
        const stopped = await unsignalled;
        assert.ok(isAbort(stopped.error), `cancelActiveQuery, while it ${stage === 'send' ? 'is sent' : 'is read'}: an AbortError too`);
    }
    // An error of a query nobody stopped is the query's own.
    const failing = new DuckDbSource();
    failing.init = async () => {};
    failing._conn = { send: async () => { throw new Error('Binder Error: no such column'); } };
    const failed = await settle(failing._interactiveQuery('SELECT nope', { signal: new AbortController().signal }));
    assert.equal(failed.error?.name, 'Error');
    assert.match(failed.error.message, /Binder Error/, 'a real failure is passed on as it is');
    console.log('ok  an interrupt is an AbortError');
}

// ── The three lazy queries, shared on a real engine ──────────────────────────
{
    const require = createRequire(import.meta.url);
    const esmArrow = await import('apache-arrow');
    const arrowPath = require.resolve('apache-arrow');
    require.cache[arrowPath] = { id: arrowPath, filename: arrowPath, loaded: true, exports: esmArrow };
    const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
    const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
    const db = await duckdb.createDuckDB({
        mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
        eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
    }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({});
    const START = Date.UTC(2024, 0, 1);
    const lines = ['time,a,b'];
    for (let i = 0; i < 20000; i++) {
        const a = Math.sin(i / 300) * 4 + (i % 11) / 10;
        lines.push(`${new Date(START + i * 600000).toISOString()},${a.toFixed(6)},${(i / 1000 + Math.cos(i / 50)).toFixed(6)}`);
    }
    db.registerFileText('shared.csv', lines.join('\n') + '\n');
    const duck = new DuckDbSource();
    duck._db = db;
    duck._conn = db.connect();
    const lazy = await duck._loadIntoLegacy('shared.csv', 'omv_shared_0', { lazy: true, overviewPoints: 300, format: 'csv' });
    assert.ok(lazy?._duckdb, 'the CSV is open lazily');

    const transforms = { a: { gain: 1, yOffset: 0 }, b: { gain: 1, yOffset: 0 } };
    const asks = [
        ['heatmap', '_heatmapCache', (signal) => duck.getCalendarHeatmapAggregates(lazy, ['a', 'b'], { calendarMode: 'week-day', aggregation: 'mean', transforms, signal })],
        ['temporal profile', '_temporalProfileCache', (signal) => duck.getTemporalProfileAggregates(lazy, ['a'], {
            period: 'day', resolutionMinutes: 60, resolutionUnit: 'minute', dayGrouping: 'all',
            combineWeekends: false, discardIncomplete: false, transforms, signal,
        })],
        ['pair correlation', '_correlationCache', (signal) => duck.getPairCorrelations(lazy, [{ x: 'b', y: 'a' }], { signal })],
    ];
    // The Node build answers a query as soon as it has the connection: hold
    // the connection, as a query running before them would, while both
    // callers ask and one of them lets go.
    const holdConnection = () => {
        let release;
        duck._connectionQueue = new Promise(resolve => { release = resolve; });
        return release;
    };
    for (const [name, cacheName, ask] of asks) {
        const cache = duck[cacheName];
        cache.clear();
        const reference = await ask(null);
        cache.clear();
        let release = holdConnection();
        const leaver = new AbortController();
        const stayer = new AbortController();
        const left = settle(ask(leaver.signal));
        const stayed = settle(ask(stayer.signal));
        await tick();
        assert.equal(cache.size, 1, `${name}: one query for both`);
        leaver.abort();
        assert.ok(isAbort((await left).error), `${name}: the caller that moves on hears an AbortError`);
        release();
        const kept = await stayed;
        assert.equal(kept.error, undefined, `${name}: the other caller is not stopped (${kept.error?.message})`);
        assert.deepEqual(kept.value, reference, `${name}: and gets the very result of an unshared query`);

        cache.clear();
        release = holdConnection();
        const one = new AbortController();
        const two = new AbortController();
        const r1 = settle(ask(one.signal));
        const r2 = settle(ask(two.signal));
        await tick();
        one.abort();
        two.abort();
        assert.ok(isAbort((await r1).error) && isAbort((await r2).error), `${name}: both let go`);
        assert.equal(cache.size, 0, `${name}: nobody waits, the query is forgotten`);
        release();
        assert.deepEqual(await ask(new AbortController().signal), reference, `${name}: and the next ask computes it afresh`);
        console.log(`ok  ${name}: shared, and stopped only when nobody waits`);
    }
    await duck.release(lazy);
}

console.log('lazy superseded query: ok');
