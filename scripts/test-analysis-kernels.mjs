// An analysis computes the same numbers wherever it runs.
//
// The analyses of a file in memory used to run their kernels on the main
// thread, over slices of the signal. They now run as analysis jobs
// (src/core/analysis-jobs.js): the rows of the range are handed, a chunk at a
// time, to a job in a compute worker, which runs the kernel
// (src/compute/analysis-kernels.js). The numbers must not have moved — not in
// the last bit.
//
// For every kernel that moved, on signals with holes, non-finite values and
// uneven steps, three computations are compared with assert.deepStrictEqual
// (so -0 is not 0, and a NaN is a NaN):
//
//   1. the kernel function called directly on slices of the arrays, exactly
//      as the analysis called it before;
//   2. the job on the caller's thread (no worker: file://, this test's own
//      Node), fed the same rows;
//   3. the job in a worker — the real worker module (compute-worker.js),
//      driven through the page's own client with messages that are cloned
//      and whose buffers are transferred, the rows fed in many small chunks.
//
// Also: the positions the analyses now hand the job are the rows their own
// slicers cut (the *SeriesForTrace / *Rows methods, read from the sources);
// a column that is not a typed array keeps the job on the caller's thread;
// and an abort stops a job in a worker at once, mid-feed and mid-kernel.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── A worker, in this process ───────────────────────────────────────────────
// The real module, listening as it does in a worker; each FakeWorker is one
// instance of it as far as the page's client can tell: messages are cloned,
// transferred buffers are detached on the sender's side, replies come back
// asynchronously, and terminate() silences it.
let workerHandler = null;
const liveWorkers = new Map();
let currentWorker = null;
globalThis.self = {
    addEventListener: (type, handler) => { if (type === 'message') workerHandler = handler; },
    postMessage: (message, transfer = []) => {
        const worker = currentWorker;
        const copy = structuredClone(message, { transfer });
        setTimeout(() => { if (!worker.terminated) worker.emit('message', { data: copy }); }, 0);
    },
};
await import(new URL('../src/workers/compute-worker.js', import.meta.url));
assert.equal(typeof workerHandler, 'function', 'the compute worker listens for jobs');

let workersSpawned = 0;
let workersTerminated = 0;
let messagesSent = 0;
class FakeWorker {
    constructor() {
        this.listeners = new Map();
        this.terminated = false;
        this.queue = Promise.resolve();
        workersSpawned++;
        liveWorkers.set(this, true);
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this.listeners.get(type)?.delete(handler);
    }

    emit(type, event) {
        for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    }

    postMessage(message, transfer = []) {
        messagesSent++;
        const copy = structuredClone(message, { transfer });
        // One message at a time, in order, each in a task of its own.
        this.queue = this.queue.then(() => new Promise((resolve) => {
            setTimeout(() => {
                if (!this.terminated) {
                    currentWorker = this;
                    workerHandler({ data: copy });
                }
                resolve();
            }, 0);
        }));
    }

    terminate() {
        if (!this.terminated) workersTerminated++;
        this.terminated = true;
        liveWorkers.delete(this);
    }
}
// What makes the client believe it is on a page with workers.
globalThis.window = { location: { protocol: 'http:' } };
globalThis.Worker = FakeWorker;

const jobs = await import(new URL('../src/core/analysis-jobs.js', import.meta.url));
const { openAnalysisJob, feedAnalysisJob, columnsFitWorker, analysisWorkersAvailable, releaseAnalysisWorkers } = jobs;
assert.equal(analysisWorkersAvailable(), true, 'the client sees workers');

const { histogramFiniteStats, countHistogramBins, resolveHistogramEdges } = await import(new URL('../src/utils/histogram.js', import.meta.url));
const { buildCalendarHeatmap } = await import(new URL('../src/utils/calendar-heatmap.js', import.meta.url));
const { buildTemporalProfile } = await import(new URL('../src/utils/temporal-profile.js', import.meta.url));
const { collectMissingDays, computeDefiniteIntegral, calendarPeriodWindows } = await import(new URL('../src/compute/kernels/definite-integral.js', import.meta.url));
const { pearsonCorrelation } = await import(new URL('../src/utils/correlation.js', import.meta.url));
const { fitPair, predict } = await import(new URL('../src/utils/regression.js', import.meta.url));
const { runPassesOnArrays } = await import(new URL('../src/utils/fit-passes.js', import.meta.url));
const { maskTrendValues, trendSteps } = await import(new URL('../src/utils/trend-fit.js', import.meta.url));
const { decimateMinMax, shiftedTime, rangeIndices } = await import(new URL('../src/plots/curve-fit-state.js', import.meta.url));
const { ANALYSIS_KERNELS } = await import(new URL('../src/compute/analysis-kernels.js', import.meta.url));

// ── Signals ─────────────────────────────────────────────────────────────────
const N = 60000;
const DAY = 86400000;
const START = Date.UTC(2023, 2, 1, 0, 0, 0);
// A calendar axis, a row a minute, with a hole of some hours, a day missing
// and a few doubled steps.
const calendar = new Float64Array(N);
// A numeric axis in seconds.
const seconds = new Float64Array(N);
const a = new Float64Array(N);
const b = new Float64Array(N);
let stamp = START;
for (let i = 0; i < N; i++) {
    let step = 60000;
    if (i === 7000) step = 5 * 3600000;
    if (i === 21000) step = 2 * DAY;
    if (i % 977 === 0) step *= 2;
    stamp += step;
    calendar[i] = stamp;
    seconds[i] = i * 0.25 + (i % 13 === 0 ? 0.01 : 0);
    a[i] = 3 * Math.sin(i * 0.0123) + 0.5 * Math.sin(i * 0.31) + ((i * 7919) % 101) / 500 + 4 * Math.exp(-i / 9000);
    b[i] = 10 * Math.cos(i * 0.002) - 2.5 + i * 1e-4;
}
// What a real column holds besides numbers.
for (const i of [5, 1234, 1235, 30001, 59998]) a[i] = NaN;
a[777] = Infinity;
a[40000] = -Infinity;
a[100] = -0;
for (const i of [11, 20000, 45000]) b[i] = NaN;

// The ranges an analysis is asked for, as row positions [start, end).
const RANGES = [[0, N], [1500, 52000], [7000, 7002], [100, 100], [59990, N]];

// ── The three computations ──────────────────────────────────────────────────
// `columns` are the arrays by name, `rows` the positions. `direct(slices)` is
// the analysis' old call; `run(job)` the kernels asked of a job.
const sliceOf = (values, [start, end]) => values.slice(start, end);
async function onThisThread(columns, rows, run) {
    const job = openAnalysisJob({ local: true });
    assert.equal(job.local, true);
    await feedAnalysisJob(job, columns, { start: rows[0], end: rows[1] });
    try {
        return await run(job);
    } finally {
        job.close();
    }
}
async function inWorker(columns, rows, run, chunkRows) {
    assert.ok(columnsFitWorker(columns), 'typed arrays go to a worker');
    const job = openAnalysisJob({});
    assert.equal(job.local, false, 'the job is in a worker');
    await feedAnalysisJob(job, columns, { start: rows[0], end: rows[1], chunkRows });
    try {
        return await run(job);
    } finally {
        job.close();
    }
}
let compared = 0;
async function sameEverywhere(label, columns, rows, direct, run) {
    const slices = Object.fromEntries(Object.entries(columns).map(([name, values]) => [name, sliceOf(values, rows)]));
    const want = direct(slices);
    const here = await onThisThread(columns, rows, run);
    assert.deepStrictEqual(here, want, `${label}: the job on this thread`);
    // Chunks far smaller than the range (many to join), and one that holds it.
    for (const chunkRows of [1777, 1 << 19]) {
        const there = await inWorker(columns, rows, run, chunkRows);
        assert.deepStrictEqual(there, want, `${label}: the job in a worker (chunks of ${chunkRows})`);
    }
    compared++;
}

// The source arrays are never touched by a job (a transfer would detach them).
const untouched = () => {
    assert.equal(a.length, N);
    assert.equal(b.length, N);
    assert.equal(calendar.length, N);
    assert.equal(seconds.length, N);
};

// ── Histogram ───────────────────────────────────────────────────────────────
for (const rows of RANGES) {
    for (const options of [{}, { computeQuartiles: false }]) {
        await sameEverywhere(`histogram statistics ${rows} ${JSON.stringify(options)}`, { values: a }, rows,
            ({ values }) => histogramFiniteStats(values, options),
            job => job.run('histogram:stats', { options }));
    }
    const stat = histogramFiniteStats(sliceOf(a, rows));
    if (!(stat.nFinite > 0)) continue;
    for (const settings of [{ binMode: 'auto' }, { binMode: 'count', binCount: 37 }, { binMode: 'count', binCount: 12, valueRangeMode: 'manual', valueMin: -1, valueMax: 2 }]) {
        const spec = resolveHistogramEdges([stat], { autoMaxBins: 400, manualMaxBins: 2000, ...settings });
        if (!spec.ok) continue;
        await sameEverywhere(`histogram counts ${rows} ${JSON.stringify(settings)}`, { values: a }, rows,
            ({ values }) => countHistogramBins(values, spec),
            job => job.run('histogram:count', { spec }));
    }
}
// Several traces in one job, a column each: both calls on each column.
{
    const job = openAnalysisJob({});
    await feedAnalysisJob(job, { v0: a }, { start: 1500, end: 52000, chunkRows: 4096 });
    await feedAnalysisJob(job, { v1: b }, { start: 0, end: N, chunkRows: 4096 });
    const statA = await job.run('histogram:stats', { column: 'v0' });
    const statB = await job.run('histogram:stats', { column: 'v1' });
    assert.deepStrictEqual(statA, histogramFiniteStats(a.slice(1500, 52000)), 'the first trace of a shared job');
    assert.deepStrictEqual(statB, histogramFiniteStats(b), 'the second trace of a shared job');
    const spec = resolveHistogramEdges([statA, statB], { binMode: 'auto', autoMaxBins: 400, manualMaxBins: 2000 });
    assert.deepStrictEqual(await job.run('histogram:count', { column: 'v1', spec }), countHistogramBins(b, spec), 'and its counts');
    job.close();
    compared++;
}

// ── Calendar heatmap and temporal profile ───────────────────────────────────
for (const rows of [[0, N], [1500, 52000], [20990, 21010]]) {
    const domainStart = calendar[rows[0]];
    const domainEnd = calendar[rows[1] - 1];
    for (const calendarMode of ['week-day', 'day-hour']) {
        for (const aggregation of ['mean', 'integral', 'count']) {
            const options = { calendarMode, aggregation, rangeStart: null, rangeEnd: null, timeShiftMs: 0, domainStart, domainEnd, traceCount: 1, runtime: 'web' };
            await sameEverywhere(`heatmap ${rows} ${calendarMode} ${aggregation}`, { times: calendar, values: a }, rows,
                ({ times, values }) => buildCalendarHeatmap({ times, values, ...options }),
                job => job.run('heatmap:build', { options }));
        }
    }
    for (const options of [
        { period: 'day', resolutionMinutes: 60, resolutionUnit: 'minute', dayGrouping: 'all', combineWeekends: false, rangeStart: domainStart, rangeEnd: domainEnd, discardIncomplete: false },
        { period: 'week', resolutionMinutes: 60, resolutionUnit: 'minute', dayGrouping: 'all', combineWeekends: false, rangeStart: null, rangeEnd: null, discardIncomplete: true },
        { period: 'day', resolutionMinutes: 15, resolutionUnit: 'minute', dayGrouping: 'day-type', combineWeekends: true, rangeStart: domainStart, rangeEnd: domainEnd, discardIncomplete: false },
        { period: 'year', resolutionMinutes: 1440, resolutionUnit: 'month', dayGrouping: 'all', combineWeekends: false, rangeStart: null, rangeEnd: null, discardIncomplete: false },
    ]) {
        await sameEverywhere(`temporal profile ${rows} ${options.period}/${options.resolutionMinutes}`, { times: calendar, values: a }, rows,
            ({ times, values }) => buildTemporalProfile({ times, values, ...options }),
            job => job.run('profile:build', { options }));
    }
}

// ── Integral ────────────────────────────────────────────────────────────────
// The range with one neighbour on each side, as _integralSeriesForTrace cuts
// it; and, grouped, a window per calendar day read the same way.
const lowerBound = (values, target) => {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
};
const upperBound = (values, target) => {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid] <= target) lo = mid + 1; else hi = mid; }
    return lo;
};
const padded = (times, lo, hi) => {
    const start = Math.max(0, Math.min(times.length, lowerBound(times, lo)) - 1);
    const end = Math.max(start, Math.min(times.length, upperBound(times, hi) + 1));
    return [start, end];
};
for (const [timeKind, times] of [['datetime', calendar], ['numeric', seconds], ['index', seconds]]) {
    for (const [from, to] of [[0, N - 1], [1500, 52000], [20990, 21010]]) {
        const range = [times[from] + 0.4 * (times[from + 1] - times[from]), times[to] - 0.3 * (times[to] - times[to - 1])];
        const rows = padded(times, range[0], range[1]);
        for (const base of [
            { method: 'trapezoidal', missingPolicy: 'zero', discardIncompleteEnds: false, extendLastSample: true },
            { method: 'rectangular', missingPolicy: 'interpolate', discardIncompleteEnds: timeKind === 'datetime', extendLastSample: false },
            { method: 'trapezoidal', missingPolicy: timeKind === 'datetime' ? 'discard-day-own' : 'zero', discardIncompleteEnds: false, extendLastSample: true },
        ]) {
            const options = { ...base, rangeStart: range[0], rangeEnd: range[1], excludedDays: null };
            const time = (slice) => (timeKind === 'index' ? { values: null, kind: 'index' } : { values: slice, kind: timeKind });
            if (timeKind === 'datetime') {
                await sameEverywhere(`integral missing days ${from}-${to}`, { times, values: a }, rows,
                    slices => ({ days: collectMissingDays(slices.values, time(slices.times), options).days }),
                    job => job.run('integral:missingDays', { times: 'times', values: 'values', rows: null, timeKind, options }));
            }
            await sameEverywhere(`integral ${timeKind} ${from}-${to} ${base.method}/${base.missingPolicy}`, { times, values: a }, rows,
                slices => ({ result: computeDefiniteIntegral(slices.values, time(slices.times), options), groups: null }),
                job => job.run('integral:compute', { times: 'times', values: 'values', rows: null, timeKind, options, windows: null, groupOptions: null }));
        }
    }
}
// Grouped by day: the job holds the rows of the range and of its windows, and
// cuts each from them by position — the arithmetic _integralEagerGroups had.
{
    const range = [calendar[1500] + 20000, calendar[30000] - 20000];
    const built = calendarPeriodWindows(range[0], range[1], 'day', { clip: true });
    assert.equal(built.ok, true, 'day windows');
    const windows = built.windows;
    assert.ok(windows.length > 15, `${windows.length} windows`);
    const options = { method: 'trapezoidal', missingPolicy: 'zero', rangeStart: range[0], rangeEnd: range[1], discardIncompleteEnds: false, extendLastSample: true, excludedDays: null };
    const groupOptions = { ...options, rangeStart: null, rangeEnd: null };
    // Before: every slice taken from the signal's own arrays.
    const [start, end] = padded(calendar, range[0], range[1]);
    const total = computeDefiniteIntegral(a.slice(start, end), { values: calendar.slice(start, end), kind: 'datetime' }, options);
    const nominalStep = total.hasNominalStep && Number.isFinite(total.medianDt) ? total.medianDt * (total.timeKind === 'datetime' ? 1000 : 1) : null;
    const want = {
        result: total,
        groups: windows.map((periodWindow) => {
            const [from, to] = padded(calendar, periodWindow.startMs, periodWindow.endMs);
            return {
                startMs: periodWindow.periodStartMs,
                endMs: periodWindow.periodEndMs,
                result: computeDefiniteIntegral(a.slice(from, to), { values: calendar.slice(from, to), kind: 'datetime' },
                    { ...groupOptions, rangeStart: periodWindow.startMs, rangeEnd: periodWindow.endMs, nominalStep }),
            };
        }),
    };
    // Now: the job is fed from the first to the last row any of them reads.
    const positions = windows.map(periodWindow => padded(calendar, periodWindow.startMs, periodWindow.endMs));
    const fedFrom = Math.min(start, ...positions.map(p => p[0]));
    const fedTo = Math.max(end, ...positions.map(p => p[1]));
    const params = {
        times: 'times', values: 'values', timeKind: 'datetime', options, groupOptions,
        rows: [start - fedFrom, end - fedFrom],
        windows: windows.map((periodWindow, i) => ({ ...periodWindow, rows: [positions[i][0] - fedFrom, positions[i][1] - fedFrom] })),
    };
    for (const make of [
        () => openAnalysisJob({ local: true }),
        () => openAnalysisJob({}),
    ]) {
        const job = make();
        await feedAnalysisJob(job, { times: calendar, values: a }, { start: fedFrom, end: fedTo, chunkRows: 3001 });
        assert.deepStrictEqual(await job.run('integral:compute', params), want, `integral grouped by day (${job.local ? 'this thread' : 'worker'})`);
        job.close();
    }
    compared++;
}

// ── Correlation of a pair, and its fit ──────────────────────────────────────
for (const rows of RANGES) {
    await sameEverywhere(`pearson ${rows}`, { x: b, y: a }, rows,
        ({ x, y }) => pearsonCorrelation(x, y),
        job => job.run('correlation:pearson', {}));
    for (const model of ['linear', 'quadratic', 'power', 'exponential', 'exponential-offset', 'first-order-offset']) {
        if (rows[1] - rows[0] > 20000 && !['linear', 'exponential'].includes(model)) continue;
        await sameEverywhere(`2D fit ${model} ${rows}`, { x: b, y: a }, rows,
            ({ x, y }) => fitPair(model, x, y),
            job => job.run('fit:pair', { model }));
    }
}

// ── Curve fit and trend of a stretch ────────────────────────────────────────
// What _curveFitFromRows and _trendFromRows computed, spelled out.
const curveFitBefore = (times, values, { model, t0, scale, buckets }) => {
    const tPrime = shiftedTime(times, t0, scale);
    const fit = fitPair(model, tPrime, values);
    let residual = { x: [], y: [] };
    if (fit?.status === 'ok') {
        const r = new Float64Array(tPrime.length);
        for (let i = 0; i < tPrime.length; i++) {
            const y = Number(values[i]);
            r[i] = Number.isFinite(y) && Number.isFinite(tPrime[i]) ? y - predict(fit, tPrime[i]) : NaN;
        }
        residual = decimateMinMax(times, r, buckets);
    }
    return { fit, residual, nScope: times.length };
};
const trendBefore = (times, values, { band, t0, scale, expModel }) => {
    const tPrime = shiftedTime(times, t0, scale);
    const trend = runPassesOnArrays(trendSteps({ band }), tPrime, values);
    const exp = expModel && expModel !== 'none' ? fitPair(expModel, tPrime, maskTrendValues(values, band)) : null;
    return { trend, exp };
};
for (const [times, scale] of [[seconds, 1], [calendar, 1000]]) {
    for (const rows of [[1500, 52000], [0, N], [7000, 7002], [100, 100]]) {
        const t0 = times[rows[0]] ?? 0;
        for (const model of ['linear', 'quadratic', 'exponential', 'first-order']) {
            const params = { model, t0, scale, buckets: 2000 };
            await sameEverywhere(`curve fit ${model} ${rows} scale ${scale}`, { times, values: a }, rows,
                slices => curveFitBefore(slices.times, slices.values, params),
                job => job.run('fit:curve', params));
        }
        for (const [band, expModel] of [[null, 'none'], [{ lower: -1.5, upper: 4 }, 'none'], [{ lower: -1.5, upper: null }, 'exponential-offset'], [null, 'exponential']]) {
            const params = { band, t0, scale, expModel };
            await sameEverywhere(`trend ${rows} band ${JSON.stringify(band)} exp ${expModel} scale ${scale}`, { times, values: a }, rows,
                slices => trendBefore(slices.times, slices.values, params),
                job => job.run('fit:trend', params));
        }
    }
}
untouched();
console.log(`analysis kernels: ${compared} computations give the same bits called directly, as a job on this thread and as a job in a worker`);

// ── Other typed arrays, plain arrays, and columns of unequal length ─────────
{
    // A Float32Array crosses as doubles, value for value.
    const single = Float32Array.from(a);
    assert.ok(columnsFitWorker({ values: single }));
    await sameEverywhere('a Float32Array column', { values: single }, [1500, 52000],
        ({ values }) => histogramFiniteStats(values),
        job => job.run('histogram:stats', {}));
    // A plain Array may hold what a Float64Array cannot (null, which the
    // kernels read as "missing"): it stays on this thread, handed as it is.
    const plain = Array.from(a);
    plain[10] = null;
    assert.equal(columnsFitWorker({ values: plain }), false, 'a plain Array is not handed to a worker');
    const job = openAnalysisJob({ local: !columnsFitWorker({ values: plain }) });
    assert.equal(job.local, true);
    await feedAnalysisJob(job, { values: plain }, { start: 0, end: plain.length });
    assert.deepStrictEqual(await job.run('histogram:stats', {}), histogramFiniteStats(plain), 'a plain Array, on this thread');
    assert.equal(histogramFiniteStats(plain).nInvalid, histogramFiniteStats(a).nInvalid + 1, 'its null counted as missing');
    job.close();
    // Whole columns of different lengths reach the kernel as they are.
    const shortTimes = calendar.slice(0, N - 7);
    for (const local of [true, false]) {
        const uneven = openAnalysisJob({ local });
        await feedAnalysisJob(uneven, { times: shortTimes }, { chunkRows: 5000 });
        await feedAnalysisJob(uneven, { values: a }, { chunkRows: 5000 });
        const options = { calendarMode: 'week-day', aggregation: 'mean', domainStart: calendar[0], domainEnd: calendar[N - 8], traceCount: 1, runtime: 'web' };
        assert.deepStrictEqual(await uneven.run('heatmap:build', { options }),
            buildCalendarHeatmap({ times: shortTimes, values: a, ...options }), `columns of unequal length (${local ? 'this thread' : 'worker'})`);
        uneven.close();
    }
    console.log('analysis kernels: a Float32Array crosses as doubles; a plain Array stays on this thread; unequal columns arrive unequal');
}

// ── The rows the analyses hand the job are the rows their slicers cut ───────
{
    const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const isolate = (source, name, context = {}) => {
        const start = source.search(new RegExp(`\\n[ \\t]*proto\\.${name} = function`));
        assert.ok(start >= 0, `${name} is declared`);
        const indent = /\n([ \t]*)proto\./.exec(source.slice(start))[1];
        const end = source.indexOf(`\n${indent}};`, start);
        assert.ok(end > start, `${name} can be isolated`);
        const proto = {};
        vm.runInNewContext(source.slice(start, end + `\n${indent}};`.length), { proto, Math, Number, ...context });
        return proto[name];
    };
    const data = { time: seconds, a, b };
    const host = {
        _getTransformedTimeDataForVariable: () => data.time,
        _getTransformedVariableData: (fileId, varName) => data[varName],
        _lowerBound: lowerBound,
        _upperBound: upperBound,
        _phase2dFitActiveRange: () => host.range,
        _ensurePhase2dState: () => ({ rangeFull: host.rangeFull }),
        range: [0, 0],
        rangeFull: false,
    };
    const trace = { fileId: 'f', varName: 'a' };
    const pair = { fileId: 'f', x: 'b', y: 'a' };
    const jobMethods = read('src/plots/methods/analysis-job-methods.js');
    const scope = isolate(jobMethods, '_analysisTraceScope');
    const slicers = [
        ['_temporalProfileSeriesForTrace', read('src/plots/methods/temporal-profile-methods.js'), 0],
        ['_calendarHeatmapSeriesForTrace', read('src/plots/methods/heatmap-methods.js'), 0],
        ['_integralSeriesForTrace', read('src/plots/methods/integral-methods.js'), 1],
    ].map(([name, source, pad]) => [name, isolate(source, name), pad]);
    const histogramSource = read('src/plots/methods/histogram-methods.js');
    const histogramSamples = isolate(histogramSource, '_histogramSamplesForTrace');
    const histogramScope = isolate(histogramSource, '_histogramScopeForTrace');
    const correlationSource = read('src/plots/methods/correlation-methods.js');
    const pairSeries = isolate(correlationSource, '_correlationPairSeries');
    const pairScope = isolate(correlationSource, '_correlationPairScope');
    const curveSource = read('src/plots/methods/curve-fit-methods.js');
    const curveRows = isolate(curveSource, '_curveFitEagerRows', { rangeIndices });
    const curveScope = isolate(curveSource, '_curveFitEagerScope', { rangeIndices });
    const trendSource = read('src/plots/methods/trend-lazy-methods.js');
    const trendRows = isolate(trendSource, '_trendEagerRows', { rangeIndices });
    const trendScope = isolate(trendSource, '_trendEagerScope', { rangeIndices });
    const phaseSource = read('src/plots/methods/phase2d-fit-methods.js');
    const phaseSeries = isolate(phaseSource, '_phase2dPairSeries');
    const phaseScope = isolate(phaseSource, '_phase2dPairScope');

    const cut = (values, s) => values.slice(s.start, s.end);
    let checks = 0;
    for (const range of [null, [100.3, 9000.1], [9000, 100], [seconds[500], seconds[700]], [-50, 1e9], [20000, 30000], [1e9, 2e9]]) {
        for (const [name, slicer, pad] of slicers) {
            const want = slicer.call(host, trace, range);
            const got = scope.call(host, trace, range, pad);
            if (got.whole) {
                assert.equal(want.times, got.times, `${name} ${range}: the whole time array`);
                assert.equal(want.values, got.values, `${name} ${range}: the whole value array`);
            } else {
                assert.deepStrictEqual(cut(got.times, got), want.times, `${name} ${range}: times`);
                assert.deepStrictEqual(cut(got.values, got), want.values, `${name} ${range}: values`);
            }
            checks++;
        }
        const samples = histogramSamples.call(host, trace, range);
        const hist = histogramScope.call(host, trace, range);
        assert.deepStrictEqual(cut(hist.values, hist), samples.slice(), `histogram ${range}`);
        if (range) {
            for (const [rows, at] of [[curveRows, curveScope], [trendRows, trendScope]]) {
                const want = rows.call(host, trace, range);
                const got = at.call(host, trace, range);
                assert.deepStrictEqual(cut(got.times, got), want.times, `fit rows ${range}: times`);
                assert.deepStrictEqual(cut(got.values, got), want.values, `fit rows ${range}: values`);
            }
        }
        for (const rangeFull of range ? [false, true] : [true]) {
            const want = pairSeries.call(host, pair, range, rangeFull);
            const got = pairScope.call(host, pair, range, rangeFull);
            assert.deepStrictEqual(cut(got.x, got), want.x, `correlation ${range} ${rangeFull}: x`);
            assert.deepStrictEqual(cut(got.y, got), want.y, `correlation ${range} ${rangeFull}: y`);
            assert.equal(got.nScope, want.nScope, `correlation ${range} ${rangeFull}: the count`);
            host.range = range ? [Math.min(...range), Math.max(...range)] : [0, 0];
            host.rangeFull = rangeFull;
            const wantFit = phaseSeries.call(host, host, pair);
            const gotFit = phaseScope.call(host, host, pair);
            assert.deepStrictEqual(cut(gotFit.x, gotFit), wantFit.x, `2D fit ${range} ${rangeFull}: x`);
            assert.deepStrictEqual(cut(gotFit.y, gotFit), wantFit.y, `2D fit ${range} ${rangeFull}: y`);
            assert.equal(gotFit.nScope, wantFit.nScope, `2D fit ${range} ${rangeFull}: the count`);
            checks++;
        }
        checks++;
    }
    console.log(`analysis kernels: the rows handed to a job are the rows the analyses' slicers cut (${checks} checks)`);
}

// ── Every kernel is known to this test ──────────────────────────────────────
// A kernel added to the registry must be compared here too.
// (The passes of a lazy fit and the lazy histogram's kernels are compared
// with the in-memory results by test-lazy-curve-fit, test-lazy-trend and
// test-lazy-histogram.)
{
    const COMPARED_HERE = ['histogram:stats', 'histogram:count', 'heatmap:build', 'profile:build',
        'integral:missingDays', 'integral:compute', 'correlation:pearson', 'fit:pair', 'fit:curve', 'fit:trend'];
    const COMPARED_ELSEWHERE = ['fit:passes', 'fit:passChunk', 'fit:passEnd', 'fit:residuals', 'fit:residualChunk'];
    for (const name of Object.keys(ANALYSIS_KERNELS)) {
        assert.ok(COMPARED_HERE.includes(name) || COMPARED_ELSEWHERE.includes(name), `kernel "${name}" has a parity check`);
    }
    for (const name of COMPARED_HERE) assert.equal(typeof ANALYSIS_KERNELS[name], 'function', `kernel "${name}" exists`);
}

// ── A job that ends hands its worker back; an abort stops it at once ────────
{
    releaseAnalysisWorkers();
    const spawnedBefore = workersSpawned;
    const first = openAnalysisJob({});
    await feedAnalysisJob(first, { values: a }, { chunkRows: 10000 });
    await first.run('histogram:stats', {});
    first.close();
    const second = openAnalysisJob({});
    await feedAnalysisJob(second, { values: b }, { chunkRows: 10000 });
    assert.deepStrictEqual(await second.run('histogram:stats', {}), histogramFiniteStats(b), 'a worker reused holds only the new job');
    second.close();
    assert.equal(workersSpawned - spawnedBefore, 1, 'the second job reused the first one\'s worker');

    // Aborted while its kernel runs: the call rejects with an AbortError, the
    // worker is terminated, and a later call on the job rejects too.
    const controller = new AbortController();
    const terminatedBefore = workersTerminated;
    const job = openAnalysisJob({ signal: controller.signal });
    await feedAnalysisJob(job, { x: b, y: a }, { chunkRows: 10000, signal: controller.signal });
    const running = job.run('fit:pair', { model: 'exponential' });
    controller.abort();
    await assert.rejects(running, error => error.name === 'AbortError', 'the kernel call is aborted');
    assert.equal(workersTerminated - terminatedBefore, 1, 'and its worker terminated');
    await assert.rejects(job.run('correlation:pearson', {}), error => error.name === 'AbortError', 'the job is over');
    job.close();

    // Aborted while the rows are fed: the feed stops.
    const feeding = new AbortController();
    const fed = openAnalysisJob({ signal: feeding.signal });
    const sentBefore = messagesSent;
    const feed = feedAnalysisJob(fed, { values: a }, { chunkRows: 500, signal: feeding.signal });
    setTimeout(() => feeding.abort(), 0);
    await assert.rejects(feed, error => error.name === 'AbortError', 'the feed is aborted');
    assert.ok(messagesSent - sentBefore < N / 500, `the feed stopped early (${messagesSent - sentBefore} chunks of ${N / 500})`);

    // A signal already aborted: no job at all.
    const dead = new AbortController();
    dead.abort();
    assert.throws(() => openAnalysisJob({ signal: dead.signal }), error => error.name === 'AbortError', 'no job under an aborted signal');

    // A kernel that throws: the call rejects with its error, the job lives on.
    const faulty = openAnalysisJob({});
    await feedAnalysisJob(faulty, { values: a }, {});
    await assert.rejects(faulty.run('no:such:kernel', {}), /Unknown analysis kernel/, 'an unknown kernel is an error');
    assert.deepStrictEqual(await faulty.run('histogram:stats', {}), histogramFiniteStats(a), 'and the job still answers');
    faulty.close();

    // A job times its kernels where they run, and says so after each: what
    // the automatic preview of a range is projected from (_measureAnalysisKernel).
    for (const local of [false, true]) {
        const timed = openAnalysisJob({ local });
        assert.equal(timed.local, local, local ? 'a job on this thread' : 'a job in a worker');
        const reported = [];
        timed.onKernel = ms => reported.push(ms);
        await feedAnalysisJob(timed, { x: b, y: a }, { chunkRows: 10000 });
        assert.equal(timed.kernelMs, 0, 'handing it rows is not kernel time');
        await timed.run('fit:pair', { model: 'exponential' });
        await timed.run('correlation:pearson', {});
        assert.equal(reported.length, 2, 'each kernel reports its time');
        assert.ok(reported.every(ms => Number.isFinite(ms) && ms >= 0), 'in milliseconds');
        assert.ok(timed.kernelMs > 0, 'an exponential fit takes time');
        assert.equal(timed.kernelMs, reported[0] + reported[1], 'and the job adds them up');
        timed.close();
    }

    releaseAnalysisWorkers();
    assert.equal(liveWorkers.size, 0, 'no worker is left running');
    console.log('analysis kernels: a finished job hands its worker back; an abort terminates it, mid-kernel and mid-feed');
}

console.log('analysis kernels: ok');
