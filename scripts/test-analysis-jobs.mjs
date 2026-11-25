// The workers the in-memory analyses compute on: a pool whose tasks really
// stop (src/core/worker-pool.js, ExclusiveWorkerPool), and the ops they run
// (src/workers/compute-worker.js), which give the bits the main thread gives.
//
//   node scripts/test-analysis-jobs.mjs
//
// The pool, with workers stood in for by objects that record what they are
// sent:
//   · one task per worker at a time; past the pool's size, tasks wait in order;
//   · a finished worker is reused, not respawned;
//   · aborting a running task terminates its worker and rejects with an
//     AbortError; the next task gets a fresh worker;
//   · aborting a waiting task removes it and starts nothing;
//   · a signal already aborted starts nothing;
//   · a worker that dies rejects its task with WorkerDiedError and is dropped;
//   · a worker's own error (a kernel that throws) keeps the worker;
//   · where workers cannot start, WorkerUnavailableError.
// The ops, by loading the real worker script and sending it messages:
//   · `analysis:curveFit` for every model equals curveFitRows on the main
//     thread bit for bit, once through structured clone — fit, residuals, row
//     count — with holes and ±inf in the rows.
import assert from 'node:assert/strict';

// ── A browser-like place for the pool to start workers in ─────────
class FakeWorker {
    constructor() {
        FakeWorker.all.push(this);
        this.sent = [];
        this.terminated = false;
    }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.terminated = true; }
    reply(result) { this.onmessage?.({ data: { id: this.sent.at(-1).id, ok: true, result } }); }
    fail(error) { this.onmessage?.({ data: { id: this.sent.at(-1).id, ok: false, error } }); }
    die(message) { this.onerror?.({ message }); }
}
FakeWorker.all = [];
globalThis.Worker = FakeWorker;
globalThis.window = { location: { protocol: 'http:' } };

const { ExclusiveWorkerPool } = await import(new URL('../src/core/worker-pool.js', import.meta.url));
const settled = async (promise) => promise.then(value => ({ value }), error => ({ error }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

{
    const pool = new ExclusiveWorkerPool(() => new FakeWorker(), { size: 2, name: 'compute' });
    assert.equal(pool.available, true);
    const a = pool.run('op', { n: 1 });
    const b = pool.run('op', { n: 2 });
    const c = pool.run('op', { n: 3 });
    assert.equal(FakeWorker.all.length, 2, 'two workers for a pool of two');
    assert.deepEqual(FakeWorker.all.map(w => w.sent.length), [1, 1], 'one task each');
    assert.equal(pool.pending, 3, 'the third waits');
    FakeWorker.all[0].reply('first');
    assert.equal((await a), 'first');
    assert.equal(FakeWorker.all.length, 2, 'no new worker');
    assert.deepEqual(FakeWorker.all[0].sent.map(m => m.payload.n), [1, 3], 'the freed worker takes the task that waited');
    FakeWorker.all[1].reply('second');
    FakeWorker.all[0].reply('third');
    assert.deepEqual([await b, await c], ['second', 'third']);
    assert.equal(pool.pending, 0);
    assert.ok(FakeWorker.all.every(w => !w.terminated), 'finished workers are kept');

    // Abort a running task: its worker is terminated, the next gets a new one.
    const controller = new AbortController();
    const running = settled(pool.run('op', { n: 4 }, { signal: controller.signal }));
    const busy = FakeWorker.all.find(w => w.sent.at(-1).payload.n === 4);
    controller.abort();
    assert.equal((await running).error?.name, 'AbortError', 'an aborted task rejects with an AbortError');
    assert.equal(busy.terminated, true, 'and its worker is terminated: the work stops');
    busy.reply('late');   // a reply from a worker already let go changes nothing
    const next = pool.run('op', { n: 5 });
    const other = pool.run('op', { n: 6 });
    assert.equal(FakeWorker.all.length, 3, 'a fresh worker replaces the terminated one');
    assert.ok(!FakeWorker.all.filter(w => !w.terminated).some(w => w === busy));
    for (const w of FakeWorker.all.filter(w => !w.terminated)) w.reply(w.sent.at(-1).payload.n);
    assert.deepEqual([await next, await other].sort(), [5, 6]);

    // Abort a waiting task: nothing was started for it.
    const first = pool.run('op', { n: 7 });
    const second = pool.run('op', { n: 8 });
    const waitingController = new AbortController();
    const waiting = settled(pool.run('op', { n: 9 }, { signal: waitingController.signal }));
    waitingController.abort();
    assert.equal((await waiting).error?.name, 'AbortError');
    assert.ok(!FakeWorker.all.some(w => w.sent.some(m => m.payload?.n === 9)), 'a task aborted while waiting is never sent');
    assert.ok(FakeWorker.all.filter(w => !w.terminated).length === 2, 'and no worker is lost for it');
    for (const w of FakeWorker.all.filter(w => !w.terminated)) w.reply('done');
    await Promise.all([first, second]);

    // Already aborted: nothing happens at all.
    const sentBefore = FakeWorker.all.reduce((n, w) => n + w.sent.length, 0);
    const gone = new AbortController();
    gone.abort();
    assert.equal((await settled(pool.run('op', {}, { signal: gone.signal }))).error?.name, 'AbortError');
    assert.equal(FakeWorker.all.reduce((n, w) => n + w.sent.length, 0), sentBefore);

    // A kernel that throws: the error comes back, the worker stays.
    const thrown = settled(pool.run('op', { n: 10 }));
    const thrower = FakeWorker.all.find(w => w.sent.at(-1).payload?.n === 10);
    thrower.fail({ name: 'DataToolError', message: 'bad input', code: 'tooFew' });
    const failure = (await thrown).error;
    assert.equal(failure.name, 'DataToolError');
    assert.equal(failure.code, 'tooFew', 'with its code');
    assert.equal(thrower.terminated, false);

    // A worker that dies.
    const dying = settled(pool.run('analysis:curveFit', { n: 11 }));
    const dead = FakeWorker.all.find(w => w.sent.at(-1).payload?.n === 11);
    dead.die('out of memory');
    const death = (await dying).error;
    assert.equal(death.workerCrashed, true, 'a dead worker is reported as such');
    assert.match(death.message, /analysis:curveFit/, 'naming what it was doing');
    assert.equal(dead.terminated, true);
    const after = pool.run('op', { n: 12 });
    FakeWorker.all.filter(w => !w.terminated).find(w => w.sent.at(-1).payload?.n === 12).reply('alive');
    assert.equal(await after, 'alive', 'and the pool carries on');

    // terminate(): everything in flight is aborted.
    const last = settled(pool.run('op', { n: 13 }));
    pool.terminate();
    assert.equal((await last).error?.name, 'AbortError');
    assert.ok(FakeWorker.all.every(w => w.terminated), 'no worker left running');
}

// Where workers cannot be started.
{
    const pool = new ExclusiveWorkerPool(() => { throw new Error('blocked by policy'); }, { size: 1, name: 'compute' });
    const failed = (await settled(pool.run('op', {}))).error;
    assert.equal(failed.workerUnavailable, true);
    assert.equal(pool.available, false, 'and it stops trying');
    assert.equal((await settled(pool.run('op', {}))).error.workerUnavailable, true);
    globalThis.window.location.protocol = 'file:';
    const fromFile = new ExclusiveWorkerPool(() => new FakeWorker(), { name: 'compute' });
    assert.equal(fromFile.available, false, 'a page opened from file:// has no workers');
    assert.equal((await settled(fromFile.run('op', {}))).error.workerUnavailable, true);
    globalThis.window.location.protocol = 'http:';
}
console.log('analysis jobs: one task per worker, in order; abort terminates; a dead worker is reported');

// ── The ops, on the real worker script ────────────────────────────
const posted = [];
let listener = null;
globalThis.self = {
    addEventListener: (type, handler) => { if (type === 'message') listener = handler; },
    postMessage: (message) => posted.push(structuredClone(message)),
};
await import(new URL('../src/workers/compute-worker.js', import.meta.url));
assert.equal(typeof listener, 'function', 'the worker script listens');
const onWorker = (op, payload) => {
    posted.length = 0;
    listener({ data: { id: 'job', op, payload: structuredClone(payload) } });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].ok, true, posted[0].error?.message);
    return posted[0].result;
};
const sameBits = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertSame(got, want, path) {
    if (typeof want === 'number' || typeof got === 'number') {
        assert.ok(sameBits(got, want), `${path}: ${got} vs ${want}`);
        return;
    }
    if (want === null || typeof want !== 'object') {
        assert.equal(got, want, path);
        return;
    }
    const keys = ArrayBuffer.isView(want) || Array.isArray(want) ? [...want.keys()] : Object.keys(want);
    assert.equal(ArrayBuffer.isView(got) || Array.isArray(got) ? got.length : Object.keys(got).length, keys.length, `${path}: size`);
    for (const key of keys) assertSame(got[key], want[key], `${path}.${key}`);
}

const { curveFitRows } = await import(new URL('../src/compute/analysis/curve-fit.js', import.meta.url));
const { FIT_MODELS } = await import(new URL('../src/utils/fit-models.js', import.meta.url));
{
    let seed = 11;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const N = 30011;
    const times = new Float64Array(N);
    const values = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        times[i] = 1000 + i * 0.25;
        values[i] = 4 * Math.exp(-i / 9000) + 0.002 * i + 1 + (random() - 0.5) * 0.3;
        if (i % 977 === 3) values[i] = NaN;
        if (i === 12345) values[i] = Infinity;
    }
    const models = [...FIT_MODELS].filter(model => model !== 'none');
    assert.ok(models.length >= 6, `the models on offer (${models.join(', ')})`);
    let fitted = 0;
    for (const model of models) {
        const payload = { model, times, values, t0: 1000, scale: 60, buckets: 2000 };
        const main = curveFitRows(payload);
        const worker = onWorker('analysis:curveFit', payload);
        assertSame(worker, structuredClone(main), `curve fit, ${model}`);
        assertSame(worker.fit, main.fit, `curve fit, ${model}: the fit`);
        assert.equal(worker.nScope, N);
        if (main.fit?.status === 'ok') {
            fitted += 1;
            assert.ok(worker.residual.y.length > 0 && worker.residual.y.length <= 4000, `${model}: decimated residuals`);
        }
    }
    assert.ok(fitted >= 5, `fits that converged (${fitted})`);
    // A range with too few rows: the same refusal.
    const few = { model: models[0], times: times.slice(0, 1), values: values.slice(0, 1), t0: 1000, scale: 1, buckets: 2000 };
    assertSame(onWorker('analysis:curveFit', few), structuredClone(curveFitRows(few)), 'too few rows');
    console.log(`analysis jobs: analysis:curveFit, ${models.length} models, the main thread's bits`);
}

// ── analysis:trend and analysis:pairFit ───────────────────────────
const { trendRows } = await import(new URL('../src/compute/analysis/trend.js', import.meta.url));
const { pairFitRows } = await import(new URL('../src/compute/analysis/pair-fit.js', import.meta.url));
{
    let seed = 23;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const N = 25013;
    const times = new Float64Array(N);
    const values = new Float64Array(N);
    const other = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        times[i] = 50 + i * 0.5;
        values[i] = 3 * (1 - Math.exp(-i / 6000)) + 0.0004 * i + (random() - 0.5) * 0.2;
        other[i] = 1 + i / 500 + (random() - 0.5) * 0.05;
        if (i % 811 === 9) values[i] = NaN;
        if (i === 777) values[i] = -Infinity;
    }
    let cases = 0;
    for (const band of [null, { lower: 0.5, upper: 2.5 }, { lower: null, upper: 2 }]) {
        for (const expModel of ['none', 'exponential', 'exponential-offset', 'first-order', 'first-order-offset']) {
            const payload = { times, values, t0: 50, scale: 3600, band, expModel };
            const main = trendRows(payload);
            const worker = onWorker('analysis:trend', payload);
            assertSame(worker, structuredClone(main), `trend, band ${JSON.stringify(band)}, ${expModel}`);
            assertSame(worker.trend, main.trend, 'trend: the sums');
            assert.equal(worker.exp === null, expModel === 'none', 'an exponential only when asked for');
            cases += 1;
        }
    }
    console.log(`analysis jobs: analysis:trend, ${cases} cases, the main thread's bits`);
    const models = [...FIT_MODELS].filter(model => model !== 'none');
    for (const model of models) {
        const payload = { model, x: other, y: values };
        const main = pairFitRows(payload);
        assertSame(onWorker('analysis:pairFit', payload), structuredClone(main), `pair fit, ${model}`);
        assert.equal(main.nScope, N);
    }
    console.log(`analysis jobs: analysis:pairFit, ${models.length} models, the main thread's bits`);
}

// ── analysis:histogramStats and analysis:histogramCounts ──────────
const { histogramStatsOf, histogramCountsOf } = await import(new URL('../src/compute/analysis/histogram.js', import.meta.url));
const { resolveHistogramEdges, HISTOGRAM_AUTO_MAX_BINS, HISTOGRAM_MANUAL_MAX_BINS } = await import(new URL('../src/utils/histogram.js', import.meta.url));
{
    let seed = 5;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const N = 40009;
    const values = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        values[i] = Math.exp(random() * 2) + Math.sin(i / 300);
        if (i % 131 === 7) values[i] = NaN;
        if (i % 4999 === 11) values[i] = Infinity;
    }
    for (const computeQuartiles of [true, false]) {
        const main = histogramStatsOf({ values, computeQuartiles });
        const worker = onWorker('analysis:histogramStats', { values, computeQuartiles });
        assertSame(worker.stat, main, `histogram stats, quartiles ${computeQuartiles}`);
        assertSame(worker.values, values, 'the values come back with their stats, the same numbers');
        assert.equal(Number.isNaN(main.q1), !computeQuartiles, 'quartiles only when asked for');
    }
    const stat = histogramStatsOf({ values });
    for (const options of [{ binMode: 'auto' }, { binMode: 'count', binCount: 37 }, { binMode: 'width', binWidth: 0.25 },
        { binMode: 'count', binCount: 20, valueRangeMode: 'manual', valueMin: 1, valueMax: 4 }]) {
        const spec = resolveHistogramEdges([stat], { ...options, autoMaxBins: HISTOGRAM_AUTO_MAX_BINS, manualMaxBins: HISTOGRAM_MANUAL_MAX_BINS });
        assert.equal(spec.ok, true);
        const main = histogramCountsOf({ values, spec });
        assertSame(onWorker('analysis:histogramCounts', { values, spec }), structuredClone(main), `histogram counts, ${JSON.stringify(options)}`);
        assert.ok(main.nBinned > 0);
    }
    console.log("analysis jobs: analysis:histogramStats and analysis:histogramCounts, the main thread's bits");
}

// ── The kernels that were already functions of plain data, and the integral ──
const { buildCalendarHeatmap } = await import(new URL('../src/utils/calendar-heatmap.js', import.meta.url));
const { buildTemporalProfile } = await import(new URL('../src/utils/temporal-profile.js', import.meta.url));
const { pairCorrelationRows } = await import(new URL('../src/compute/analysis/correlation.js', import.meta.url));
const { integralRows, integralMissingDays } = await import(new URL('../src/compute/analysis/integral.js', import.meta.url));
const { calendarPeriodWindows, collectMissingDays, computeDefiniteIntegral } = await import(new URL('../src/compute/kernels/definite-integral.js', import.meta.url));
{
    let seed = 41;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const N = 30000;                                  // 20.8 days, a row a minute
    const start = Date.UTC(2024, 1, 27, 6, 30);       // across a leap day
    const times = new Float64Array(N);
    const values = new Float64Array(N);
    const other = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        times[i] = start + i * 60000;
        values[i] = 2 + Math.sin(i / 229) + (random() - 0.5) * 0.4;
        other[i] = 0.5 * values[i] + random();
        if (i % 1777 === 40) values[i] = NaN;
        if (i > 9000 && i < 9060) values[i] = NaN;    // an hour missing
    }
    let cases = 0;
    for (const calendarMode of ['week-day', 'day-hour']) {
        for (const aggregation of ['mean', 'max', 'sum', 'count', 'integral']) {
            const payload = { times, values, calendarMode, aggregation, rangeStart: null, rangeEnd: null, timeShiftMs: 0,
                domainStart: times[0], domainEnd: times[N - 1], traceCount: 1, runtime: 'web' };
            const main = buildCalendarHeatmap(payload);
            assertSame(onWorker('analysis:heatmap', payload), structuredClone(main), `heatmap, ${calendarMode}, ${aggregation}`);
            cases += 1;
        }
    }
    for (const [period, resolutionMinutes] of [['day', 60], ['day', 15], ['week', 60], ['month', 360]]) {
        for (const dayGrouping of ['all', 'day-type']) {
            const payload = { times, values, period, resolutionMinutes, resolutionUnit: 'minute', dayGrouping, combineWeekends: false,
                rangeStart: times[100], rangeEnd: times[N - 200], discardIncomplete: true };
            const main = buildTemporalProfile(payload);
            assertSame(onWorker('analysis:temporalProfile', payload), structuredClone(main), `temporal profile, ${period}/${resolutionMinutes}, ${dayGrouping}`);
            cases += 1;
        }
    }
    assertSame(onWorker('analysis:correlation', { x: other, y: values }), structuredClone(pairCorrelationRows({ x: other, y: values })), 'correlation');
    console.log(`analysis jobs: heatmap, temporal profile and correlation, ${cases + 1} cases, the main thread's bits`);

    // The integral: the worker is handed the rows of the range with a
    // neighbour on each side and selects each period's rows inside them. Held
    // against the main thread's own way — _integralSeriesForTrace and
    // _integralEagerGroups, written out here: slices of the whole arrays.
    const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
    const upperBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };
    const seriesFor = (range) => {
        if (!range) return { times, values };
        const a = Math.max(0, Math.min(N, lowerBound(times, range[0])) - 1);
        const b = Math.max(a, Math.min(N, upperBound(times, range[1]) + 1));
        return { times: times.slice(a, b), values: values.slice(a, b), a, b };
    };
    let integrals = 0;
    for (const range of [null, [times[1300] + 20000, times[N - 4000] - 20000], [times[0], times[N - 1]]]) {
        for (const method of ['trapezoidal', 'rectangular']) {
            for (const missingPolicy of ['zero', 'discard-day-own', 'discard-day-all']) {
                for (const kind of ['datetime', 'numeric']) {
                    const whole = seriesFor(range);
                    const dayPolicy = missingPolicy !== 'zero';
                    const options = {
                        method, missingPolicy: dayPolicy && kind !== 'datetime' ? 'zero' : missingPolicy,
                        rangeStart: range?.[0] ?? null, rangeEnd: range?.[1] ?? null,
                        discardIncompleteEnds: kind === 'datetime', extendLastSample: false,
                        excludedDays: missingPolicy === 'discard-day-all' && kind === 'datetime'
                            ? [...collectMissingDays(whole.values, { values: whole.times, kind }, { method, missingPolicy, rangeStart: range?.[0] ?? null, rangeEnd: range?.[1] ?? null }).days]
                            : null,
                    };
                    const built = kind === 'datetime'
                        ? calendarPeriodWindows(range ? range[0] : times[0], range ? range[1] : times[N - 1], 'day', { clip: !!range })
                        : { ok: false };
                    const windows = built.ok ? built.windows : null;
                    // The main thread's way.
                    const result = computeDefiniteIntegral(whole.values, { values: whole.times, kind }, options);
                    const nominalStep = result?.hasNominalStep && Number.isFinite(result.medianDt)
                        ? result.medianDt * (result.timeKind === 'datetime' ? 1000 : 1) : null;
                    const groups = windows ? windows.map((w) => {
                        const selected = seriesFor([w.startMs, w.endMs]);
                        return {
                            startMs: w.periodStartMs, endMs: w.periodEndMs,
                            result: computeDefiniteIntegral(selected.values, { values: selected.times, kind }, { ...options, rangeStart: w.startMs, rangeEnd: w.endMs, nominalStep }),
                        };
                    }) : null;
                    // The worker's: only the rows of the range, with their neighbours.
                    const span = range ? { a: whole.a, b: whole.b } : { a: 0, b: N };
                    const payload = { times: times.slice(span.a, span.b), values: values.slice(span.a, span.b), kind, range, options, windows };
                    const worker = onWorker('analysis:integral', payload);
                    assertSame(worker, structuredClone({ result, groups }), `integral, range ${range ? 'set' : 'full'}, ${method}, ${missingPolicy}, ${kind}`);
                    assertSame(integralRows(payload), { result, groups }, 'integral: the function itself');
                    if (windows) assert.ok(groups.length >= 15 && groups.some(group => group.result.ok), 'one integral per day');
                    if (kind === 'datetime') {
                        const days = [...collectMissingDays(whole.values, { values: whole.times, kind }, options).days];
                        assertSame(onWorker('analysis:integralMissingDays', payload).days, days, 'the days with holes');
                        assertSame(integralMissingDays(payload).days, days, 'the days with holes: the function itself');
                        assert.ok(days.length >= 1, 'the fixture has days with holes');
                    }
                    integrals += 1;
                }
            }
        }
    }
    console.log(`analysis jobs: analysis:integral, ${integrals} cases with their daily groups, the main thread's bits`);
}
process.exit(0);
