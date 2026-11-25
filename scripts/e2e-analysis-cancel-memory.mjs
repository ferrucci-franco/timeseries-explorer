// The analyses of a file held in memory compute on the compute worker, and
// their Cancel button works while they do (#381).
//
// A kernel that runs on the main thread cannot be stopped: the pill is drawn,
// but the page takes no click until the result is there. On the worker
// (src/core/analysis-pool.js) the page stays free, and the run's signal
// terminates the worker. For every analysis but the FFT (which has had its own
// worker all along) — Curve fit, Trend, Histogram, Heatmap, Temporal profile
// and Integral on a time series; Curve fit and Correlation on a 2D plot — over
// a CSV of 150 000 rows open in memory:
//
//   1. the first result comes from a worker job, and is the result the kernel
//      gives on the main thread, bit for bit;
//   2. the jobs are made to hang until their signal is aborted (which proves
//      the analysis hands them its signal), and a setting is changed;
//   3. the pill shows with its Cancel button, over the previous result;
//   4. Cancel: the job is aborted, the pill goes, the previous result is still
//      drawn and the setting is back to the one of that result;
//   5. a newer request made while a job hangs aborts it at once;
//   6. with jobs answering again, the analysis computes — and a job really
//      running is stopped by Cancel, its worker gone, the next one computing
//      on a fresh worker.
//
// The lazy twin of this check is scripts/e2e-analysis-cancel.mjs.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:analysis-cancel-memory`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 150000;
// A calendar axis, one row a minute (104 days): the heatmap, the temporal
// profile and the integral by day need one.
const START = Date.UTC(2023, 4, 1, 0, 0, 0);
const lines = ['time,a,b'];
for (let i = 0; i < ROWS; i++) {
    const a = 5 * Math.exp(-i / 40000) + Math.sin(i / 700) * 0.2 + 1;
    // A hole now and then, for the integral's policies.
    const cell = i % 9973 === 17 ? '' : a.toFixed(6);
    lines.push(`${new Date(START + i * 60000).toISOString()},${cell},${(1 + i / 1000).toFixed(6)}`);
}
const file = { name: 'memory-cancel.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error.stack || error.message)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 4000 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => !![...window.app.plotManager.files.values()][0].data._duckdb), false, 'the file is in memory');

    // The jobs of the analysis pool: counted, and while __jobs.hang, held
    // until their signal is aborted.
    await page.evaluate(() => {
        const pm = window.app.plotManager;
        const pool = pm._analysisPool();
        if (!pool) throw new Error('no analysis pool in this browser');
        window.__jobs = { hang: false, ran: [], started: 0, aborted: 0, noSignal: 0 };
        const run = pool.run.bind(pool);
        pool.run = (op, payload, options = {}) => {
            window.__jobs.ran.push(op);
            if (!window.__jobs.hang) return run(op, payload, options);
            if (!options.signal) { window.__jobs.noSignal++; return run(op, payload, options); }
            window.__jobs.started++;
            return new Promise((resolve, reject) => {
                const fail = () => {
                    window.__jobs.aborted++;
                    reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
                };
                if (options.signal.aborted) fail();
                else options.signal.addEventListener('abort', fail, { once: true });
            });
        };
        window.__pool = pool;
    });

    const panelId = await page.evaluate(() => {
        const app = window.app;
        const el = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(el.dataset.id, 'a', el);
        return el.dataset.id;
    });
    await page.waitForTimeout(800);
    const pill = page.locator(`.layout-panel[data-id="${panelId}"] .analysis-computing-indicator.active`);
    const jobs = () => page.evaluate(() => ({ ...window.__jobs, ran: [...window.__jobs.ran] }));

    // ── Curve fit ─────────────────────────────────────────────────
    await page.locator('.timeseries-analysis-menu-btn').first().click();
    await page.locator('.panel-analysis-menu .analysis-card[data-mark="curve-fit"]').click();
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.curveFitResidualDiv?._fullLayout, panelId, { timeout: 30000 });
    const fitState = () => page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const r = plot._curveFitResults?.[0];
        return {
            model: plot.curveFit.fits[0].model,
            status: r?.result?.fit?.status || null,
            resultModel: r?.result?.fit?.model || null,
            rows: r?.result?.nScope ?? null,
            pending: !!r && r.lazy && !r.result && r.lazyStatus === 'pending',
            curves: (plot.div.data || []).filter(t => t.meta?.curveFitIndex !== undefined).reduce((n, t) => n + (t.x?.length || 0), 0),
            text: plot.div.closest('.layout-panel').querySelector('.curve-fit-status, .fft-status')?.textContent || '',
        };
    }, panelId);
    const setModel = (model) => page.evaluate(({ id, model }) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        // The whole file, so the range holds every row.
        plot.curveFit.fits[0].rangeFull = true;
        pm._updateCurveFitEntry(id, { model });
    }, { id: panelId, model });
    const fitted = (model) => page.waitForFunction(({ id, model }) => {
        const r = window.app.plotManager.plots.get(id)?._curveFitResults?.[0];
        return r?.result?.fit?.status === 'ok' && r.result.fit.model === model;
    }, { id: panelId, model }, { timeout: 120000 });

    // 1. The first result: a worker job, with the main thread's bits.
    await setModel('linear');
    await fitted('linear');
    let s = await fitState();
    assert.equal(s.rows, ROWS, 'the fit is over every row of the range');
    assert.ok((await jobs()).ran.includes('analysis:curveFit'), 'it was computed by a worker job');
    assert.ok(s.curves > 0, 'and its curve is drawn');
    const same = await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const r = plot._curveFitResults[0];
        const range = pm._curveFitRange(plot, r.entry);
        const rows = pm._curveFitEagerRows(r.trace, range);
        const main = pm._curveFitFromRows(plot, r.entry, r.trace, range, pm._curveFitTimeInfo(plot, r.trace), rows.times, rows.values);
        const text = value => JSON.stringify(value, (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? `#${v}` : v));
        return { fit: text(main.fit) === text(r.result.fit), residual: text(main.residual) === text(r.result.residual), curve: text(main.curve) === text(r.result.curve) };
    }, panelId);
    assert.deepEqual(same, { fit: true, residual: true, curve: true }, 'the worker gives what the main thread gives');

    // 2–4. A job that hangs, and Cancel.
    await page.evaluate(() => { window.__jobs.hang = true; window.__jobs.started = 0; window.__jobs.aborted = 0; });
    const before = await fitState();
    await setModel('exponential-offset');
    await pill.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => window.__jobs.started === 1, null, { timeout: 15000 });
    s = await fitState();
    assert.equal(s.pending, true, 'the new fit is being computed');
    assert.equal(s.curves, before.curves, 'the previous curve stays drawn meanwhile');
    assert.equal((await jobs()).noSignal, 0, 'every job carries the analysis\' signal');
    // The page is free: the Cancel button takes a real click.
    await pill.locator('.analysis-cancel-btn').click();
    await page.waitForFunction(() => window.__jobs.aborted === 1, null, { timeout: 15000 });
    await pill.waitFor({ state: 'detached', timeout: 15000 });
    s = await fitState();
    assert.equal(s.model, 'linear', 'the setting is back to the one of the result on screen');
    assert.equal(s.resultModel, 'linear', 'which is the current result again');
    assert.equal(s.curves, before.curves, 'still drawn');
    assert.match(s.text, /cancelled/i, `the status says so (${s.text})`);
    await page.waitForTimeout(600);
    assert.equal((await jobs()).started, 1, 'nothing starts the cancelled computation again');

    // 5. A newer request aborts the job it supersedes.
    await page.evaluate(() => { window.__jobs.started = 0; window.__jobs.aborted = 0; });
    await setModel('exponential');
    await page.waitForFunction(() => window.__jobs.started === 1, null, { timeout: 15000 });
    await setModel('quadratic');
    await page.waitForFunction(() => window.__jobs.started === 2 && window.__jobs.aborted === 1, null, { timeout: 15000 });
    s = await fitState();
    assert.equal(s.curves, before.curves, 'the previous result stays until the newest answers');

    // 6. Jobs answering again: the newest request computes.
    await page.evaluate(() => { window.__jobs.hang = false; });
    await setModel('exponential-offset');
    await fitted('exponential-offset');
    s = await fitState();
    assert.equal(s.rows, ROWS);
    assert.equal(await pill.count(), 0, 'and the pill is gone');

    // A job really running: Cancel terminates its worker, and the next fit
    // computes on a fresh one.
    const stopped = await page.evaluate(async (id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const workers = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); workers.push(this); this.wasTerminated = false; }
            terminate() { this.wasTerminated = true; return super.terminate(); }
        };
        try {
            // Use up the idle workers, so the next job starts one we can see.
            window.__pool.terminate();
            pm._updateCurveFitEntry(id, { model: 'first-order-offset' });
            // Cancel as soon as the job is on a worker.
            let running = 0;
            for (let i = 0; i < 400 && !running; i++) {
                await new Promise(resolve => setTimeout(resolve, 5));
                running = window.__pool.pending;
            }
            pm._cancelAnalysisComputation(id, plot);
            await new Promise(resolve => setTimeout(resolve, 50));
            return { running, spawned: workers.length, terminated: workers.filter(w => w.wasTerminated).length, pending: window.__pool.pending };
        } finally {
            window.Worker = NativeWorker;
        }
    }, panelId);
    assert.equal(stopped.running, 1, 'the job was running on a worker');
    assert.equal(stopped.spawned, 1, 'one worker was started for it');
    assert.equal(stopped.terminated, 1, 'and Cancel terminated it');
    assert.equal(stopped.pending, 0, 'nothing is left running');
    s = await fitState();
    assert.equal(s.model, 'exponential-offset', 'the setting is back again');
    await setModel('first-order-offset');
    await fitted('first-order-offset');
    assert.equal((await fitState()).rows, ROWS, 'the next fit computes');

    // ── The same five steps for the other analyses moved to the worker ──
    const text = `value => JSON.stringify(value, (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? '#' + v : v))`;
    async function check({ name, id, op, open, change, values, setting, result, mainThread }) {
        const panelPill = page.locator(`.layout-panel[data-id="${id}"] .analysis-computing-indicator.active`);
        const ready = (value) => page.waitForFunction(({ fn, value }) => (0, eval)(`(${fn})`)(value), { fn: result.ready, value }, { timeout: 120000 });
        await page.evaluate(() => { window.__jobs.hang = false; window.__jobs.ran.length = 0; });
        await open();
        await change(values[0]);
        await ready(values[0]);
        assert.ok((await jobs()).ran.includes(op), `${name}: computed by a worker job (${op})`);
        // Read the answer only once nothing is recomputing. While a run is in
        // flight a segment carries `staleResult` and no `result` — the
        // previous numbers stay on screen, which is the rule — so a sample
        // taken in that window reads null, or an answer about to be replaced.
        // That is how this check failed in CI ("Trend: the worker gives what
        // the main thread gives") without anything being wrong.
        await panelPill.waitFor({ state: 'hidden', timeout: 60000 });
        await ready(values[0]);
        // The main thread's answer to the same question: with no pool, the
        // analysis computes where it is.
        const same = await page.evaluate(async ({ read, main, text }) => {
            const pm = window.app.plotManager;
            const toText = (0, eval)(`(${text})`);
            const fromWorker = toText((0, eval)(`(${read})`)());
            const pool = pm._analysisPool;
            pm._analysisPool = () => null;
            try {
                return fromWorker === toText(await (0, eval)(`(${main})`)()) && fromWorker.length > 20;
            } finally {
                pm._analysisPool = pool;
            }
        }, { read: result.read, main: mainThread, text });
        assert.equal(same, true, `${name}: the worker gives what the main thread gives`);

        // Hang, change, Cancel.
        await page.evaluate(() => { window.__jobs.hang = true; window.__jobs.started = 0; window.__jobs.aborted = 0; });
        const settingBefore = await setting();
        await change(values[1]);
        await panelPill.waitFor({ timeout: 15000 });
        await page.waitForFunction(() => window.__jobs.started >= 1, null, { timeout: 15000 });
        assert.equal((await jobs()).noSignal, 0, `${name}: its jobs carry the analysis' signal`);
        await panelPill.locator('.analysis-cancel-btn').click();
        await page.waitForFunction(() => window.__jobs.aborted >= 1 && window.__jobs.aborted === window.__jobs.started, null, { timeout: 15000 });
        await panelPill.waitFor({ state: 'detached', timeout: 15000 });
        assert.deepEqual(await setting(), settingBefore, `${name}: the setting is back to the one of the result on screen`);
        const startedAtCancel = (await jobs()).started;
        await page.waitForTimeout(600);
        assert.equal((await jobs()).started, startedAtCancel, `${name}: nothing starts the cancelled computation again`);

        // A newer request aborts the one it supersedes.
        await page.evaluate(() => { window.__jobs.started = 0; window.__jobs.aborted = 0; });
        await change(values[1]);
        await page.waitForFunction(() => window.__jobs.started >= 1, null, { timeout: 15000 });
        const firstWave = (await jobs()).started;
        await change(values[2]);
        await page.waitForFunction(first => window.__jobs.aborted >= first && window.__jobs.started > first, firstWave, { timeout: 15000 });

        // Answering again.
        await page.evaluate(() => { window.__jobs.hang = false; });
        await change(values[1]);
        await ready(values[1]);
        assert.equal(await panelPill.count(), 0, `${name}: the pill is gone`);
        console.log(`  ${name}: worker job, the main thread's bits, Cancel and supersede`);
    }

    // Trend: the numbers of a segment over the whole signal; the exponential
    // asked for is what a recompute changes.
    await check({
        name: 'Trend', id: panelId, op: 'analysis:trend',
        open: async () => {
            await page.locator('.timeseries-analysis-menu-btn').first().click();
            await page.locator('.panel-analysis-menu .analysis-card[data-mark="trend"]').click();
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.trendTableEl, panelId, { timeout: 30000 });
        },
        values: ['none', 'exponential-offset', 'first-order-offset'],
        change: (expModel) => page.evaluate(({ id, expModel }) => window.app.plotManager._updateTrendSegment(id, { rangeFull: true, expModel }), { id: panelId, expModel }),
        setting: () => page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments.map(segment => [segment.rangeFull, segment.expModel || 'none']), panelId),
        result: {
            ready: `(expModel) => { const p = window.app.plotManager.plots.get(${JSON.stringify(panelId)}); const r = p?._trendResults?.[0];
                return !!r?.result?.trend && (r.segment.expModel || 'none') === expModel && (expModel === 'none' ? !r.result.exp : !!r.result.exp); }`,
            read: `() => { const r = window.app.plotManager.plots.get(${JSON.stringify(panelId)})._trendResults[0].result; return { trend: r.trend, exp: r.exp, curves: r.curves, delta: r.delta }; }`,
        },
        mainThread: `() => { const pm = window.app.plotManager; const p = pm.plots.get(${JSON.stringify(panelId)}); p._trendCache.clear();
            const r = pm._computeTrends(p)[0].result; return { trend: r.trend, exp: r.exp, curves: r.curves, delta: r.delta }; }`,
    });

    // Histogram: the stats and the counts of every sample; the number of bins
    // is what a recompute changes.
    const histogramRead = `() => { const p = window.app.plotManager.plots.get(${JSON.stringify(panelId)});
        return { summary: p._histSummary, k: p._histSpec.k, edges: Array.from(p._histSpec.edges), bars: p.histogramDiv.data.map(t => Array.from(t.y)) }; }`;
    await check({
        name: 'Histogram', id: panelId, op: 'analysis:histogramStats',
        open: async () => {
            await page.locator('.timeseries-analysis-menu-btn').first().click();
            await page.locator('.panel-analysis-menu .analysis-card[data-mark="histogram"]').click();
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.histogramDiv?._fullLayout, panelId, { timeout: 30000 });
        },
        values: [24, 60, 35],
        change: (binCount) => page.evaluate(({ id, binCount }) => {
            const pm = window.app.plotManager;
            const state = pm.plots.get(id).histogram;
            Object.assign(state, { rangeFull: true, binMode: 'count', binCount });
            pm._scheduleHistogramRecompute(id, { immediate: true });
        }, { id: panelId, binCount }),
        setting: () => page.evaluate(id => { const state = window.app.plotManager.plots.get(id).histogram; return [state.rangeFull, state.binMode, state.binCount]; }, panelId),
        result: {
            ready: `(k) => { const p = window.app.plotManager.plots.get(${JSON.stringify(panelId)});
                return p?._histSpec?.k === k && p.histogramDiv?.data?.[0]?.y?.length === k && !p._analysisPill && (p._histSummary?.[0]?.nFinite || 0) > 100000; }`,
            read: histogramRead,
        },
        mainThread: `async () => { const pm = window.app.plotManager; const p = pm.plots.get(${JSON.stringify(panelId)});
            await pm._recomputeHistogram(${JSON.stringify(panelId)}, p); await new Promise(resolve => setTimeout(resolve, 300)); return (${histogramRead})(); }`,
    });
    assert.ok((await jobs()).ran.includes('analysis:histogramCounts'), 'Histogram: counted by a worker job too');

    // The analyses that redraw a pane of their own: each recompute replaces
    // the array of results the pane is drawn from, which is how "the new
    // result is in" is told here.
    const paneCheck = ({ name, mode, op, stateKey, resultsKey, schedule, recompute, values, patch, pick }) => {
        const id = JSON.stringify(panelId);
        const read = `() => { const p = window.app.plotManager.plots.get(${id}); return (${pick})(p.${resultsKey}); }`;
        return check({
            name, id: panelId, op,
            open: async () => {
                await page.locator('.timeseries-analysis-menu-btn').first().click();
                await page.locator(`.panel-analysis-menu .analysis-card[data-mark="${mode}"]`).click();
                await page.waitForFunction(({ id, mode }) => window.app.plotManager.plots.get(id)?.mode === mode, { id: panelId, mode }, { timeout: 30000 });
                await page.waitForTimeout(600);
            },
            values,
            change: (value) => page.evaluate(({ id, stateKey, resultsKey, schedule, patch, value }) => {
                const pm = window.app.plotManager;
                const plot = pm.plots.get(id);
                plot.__before = plot[resultsKey];
                plot.__asked = JSON.stringify(value);
                Object.assign(plot[stateKey], { rangeFull: true }, (0, eval)(`(${patch})`)(value));
                pm[schedule](id, { immediate: true });
            }, { id: panelId, stateKey, resultsKey, schedule, patch, value }),
            setting: () => page.evaluate(({ id, stateKey, patch, values }) => {
                const state = window.app.plotManager.plots.get(id)[stateKey];
                return Object.keys((0, eval)(`(${patch})`)(values[0])).map(key => state[key]).concat(state.rangeFull);
            }, { id: panelId, stateKey, patch, values }),
            result: {
                ready: `(value) => { const p = window.app.plotManager.plots.get(${id});
                    return p.__asked === JSON.stringify(value) && p.${resultsKey} !== p.__before && (p.${resultsKey} || []).length > 0 && !p._analysisPill; }`,
                read,
            },
            mainThread: `async () => { const pm = window.app.plotManager; const p = pm.plots.get(${id});
                const before = p.${resultsKey};
                pm.${recompute}(${id}, p);
                for (let i = 0; i < 400 && (p.${resultsKey} === before || p._analysisPill); i++) await new Promise(resolve => setTimeout(resolve, 50));
                return (${read})(); }`,
        });
    };

    // Heatmap: every row aggregated into calendar cells; the aggregation is
    // what a recompute changes.
    await paneCheck({
        name: 'Heatmap', mode: 'heatmap', op: 'analysis:heatmap',
        stateKey: 'heatmap', resultsKey: '_calendarHeatmapModels',
        schedule: '_scheduleCalendarHeatmapRecompute', recompute: '_recomputeCalendarHeatmap',
        values: ['mean', 'max', 'min'],
        patch: `(aggregation) => ({ aggregation })`,
        pick: `(models) => models.map(model => model.grid)`,
    });

    // Temporal profile: every row binned over the period; the period is what
    // a recompute changes.
    await paneCheck({
        name: 'Temporal profile', mode: 'temporal-profile', op: 'analysis:temporalProfile',
        stateKey: 'temporalProfile', resultsKey: '_temporalProfileModels',
        schedule: '_scheduleTemporalProfileRecompute', recompute: '_recomputeTemporalProfile',
        values: ['day', 'week', 'month'],
        patch: `(period) => ({ period })`,
        pick: `(models) => models.map(model => model.result)`,
    });

    // Integral: the total and one integral per day, with the days that have
    // a hole discarded for every signal (which is its own pass); the method
    // is what a recompute changes.
    await paneCheck({
        name: 'Integral', mode: 'integral', op: 'analysis:integral',
        stateKey: 'integral', resultsKey: '_integralModels',
        schedule: '_scheduleIntegralRecompute', recompute: '_recomputeIntegral',
        values: ['trapezoidal', 'rectangular', 'trapezoidal'],
        patch: `(method) => ({ method, groupBy: 'day', missingPolicy: 'discard-day-all' })`,
        pick: `(models) => models.map(model => ({ result: model.result, groups: model.groups }))`,
    });
    {
        const ran = (await jobs()).ran;
        assert.ok(ran.includes('analysis:integralMissingDays'), 'Integral: the days with holes are found by a worker job too');
        const groups = await page.evaluate(id => window.app.plotManager.plots.get(id)._integralModels[0].groups?.length || 0, panelId);
        assert.ok(groups > 100, `Integral: one integral per day (${groups})`);
    }

    // The 2D curve fit: a against b, in a second panel; the model is what a
    // recompute changes.
    const twoDId = await page.evaluate((first) => {
        window.app.layoutManager.splitPanel(first, 'h', false);
        return [...document.querySelectorAll('.layout-panel')].map(panel => panel.dataset.id).find(id => id !== first);
    }, panelId);
    await page.waitForFunction(() => document.querySelectorAll('.layout-panel').length === 2);
    await page.evaluate(id => window.app.plotManager._setMode(id, 'phase2d'), twoDId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'phase2d', twoDId);
    await page.evaluate((id) => {
        const el = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager.addTrace(id, 'b', el);
        window.app.plotManager.addTrace(id, 'a', el);
    }, twoDId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phaseTraces?.length > 0, twoDId, { timeout: 30000 });
    let fitsComputed = 0;
    await check({
        name: '2D curve fit', id: twoDId, op: 'analysis:pairFit',
        open: async () => {
            await page.locator(`.layout-panel[data-id="${twoDId}"] .timeseries-analysis-menu-btn`).click();
            await page.locator('.panel-analysis-menu .analysis-card[data-mark="phase2d-fit"]').click();
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phase2dFitContainer, twoDId, { timeout: 30000 });
            await page.evaluate((id) => { const state = window.app.plotManager.plots.get(id).phase2d; state.rangeFull = true; }, twoDId);
        },
        values: ['linear', 'exponential-offset', 'quadratic'],
        change: (model) => page.evaluate(({ id, model }) => {
            const pm = window.app.plotManager;
            for (const pair of pm.plots.get(id).phaseTraces) pair.fitModel = model;
            pm._schedulePhase2dFitRecompute(id, { immediate: true });
        }, { id: twoDId, model }),
        setting: () => page.evaluate(id => window.app.plotManager.plots.get(id).phaseTraces.map(pair => pair.fitModel), twoDId),
        result: {
            ready: `(model) => { const r = window.app.plotManager.plots.get(${JSON.stringify(twoDId)})?._phase2dFits?.[0]; return r?.fit?.status === 'ok' && r.fit.model === model; }`,
            read: `() => { const r = window.app.plotManager.plots.get(${JSON.stringify(twoDId)})._phase2dFits[0]; return { fit: r.fit, n: r.nScope, curve: r.curve }; }`,
        },
        mainThread: `() => { const pm = window.app.plotManager; const r = pm._computePhase2dFits(pm.plots.get(${JSON.stringify(twoDId)}))[0]; return { fit: r.fit, n: r.nScope, curve: r.curve }; }`,
    });
    // One fit per request: the 2D fit used to fit every pair twice.
    fitsComputed = await page.evaluate(async (id) => {
        const pm = window.app.plotManager;
        window.__jobs.ran.length = 0;
        for (const pair of pm.plots.get(id).phaseTraces) pair.fitModel = 'first-order-offset';
        pm._schedulePhase2dFitRecompute(id, { immediate: true });
        for (let i = 0; i < 600; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            const r = pm.plots.get(id)._phase2dFits?.[0];
            if (r?.fit?.model === 'first-order-offset') break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        return window.__jobs.ran.filter(op => op === 'analysis:pairFit').length;
    }, twoDId);
    assert.equal(fitsComputed, 1, 'a change of model fits the pair once');

    // The pair Correlation, on the same 2D panel: the range is what a
    // recompute changes.
    {
        const id = JSON.stringify(twoDId);
        const ranges = await page.evaluate((id) => {
            const pm = window.app.plotManager;
            const pair = pm.plots.get(id).phaseTraces[0];
            const times = pm._getTransformedTimeDataForVariable(pair.fileId, pair.x);
            const lo = Number(times[0]);
            const hi = Number(times[times.length - 1]);
            const cut = (a, b) => ({ rangeFull: false, x1: lo + (hi - lo) * a, x2: lo + (hi - lo) * b });
            return [{ rangeFull: true }, cut(0.1, 0.9), cut(0.2, 0.8)];
        }, twoDId);
        const read = `() => window.app.plotManager.plots.get(${id})._correlationResults.map(r => ({ ...r, pair: null }))`;
        await check({
            name: 'Correlation', id: twoDId, op: 'analysis:correlation',
            open: async () => {
                await page.locator(`.layout-panel[data-id="${twoDId}"] .timeseries-analysis-menu-btn`).click();
                await page.locator('.panel-analysis-menu .analysis-card[data-mark="correlation"]').click();
                await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'correlation', twoDId, { timeout: 30000 });
                await page.waitForTimeout(600);
            },
            values: ranges,
            change: (value) => page.evaluate(({ id, value }) => {
                const pm = window.app.plotManager;
                const plot = pm.plots.get(id);
                plot.__before = plot._correlationResults;
                plot.__asked = JSON.stringify(value);
                Object.assign(plot.correlation, value);
                pm._scheduleCorrelationRecompute(id, { immediate: true });
            }, { id: twoDId, value }),
            setting: () => page.evaluate(id => { const state = window.app.plotManager.plots.get(id).correlation; return [state.rangeFull, state.x1, state.x2]; }, twoDId),
            result: {
                ready: `(value) => { const p = window.app.plotManager.plots.get(${id});
                    return p.__asked === JSON.stringify(value) && p._correlationResults !== p.__before && (p._correlationResults || []).length > 0 && Number.isFinite(p._correlationResults[0].r) && !p._analysisPill; }`,
                read,
            },
            mainThread: `async () => { const pm = window.app.plotManager; const p = pm.plots.get(${id});
                const before = p._correlationResults;
                pm._refreshCorrelationResults(${id}, p);
                for (let i = 0; i < 400 && (p._correlationResults === before || p._analysisPill); i++) await new Promise(resolve => setTimeout(resolve, 50));
                return (${read})(); }`,
        });
    }

    assert.deepEqual(errors, [], 'no page error');
    console.log('In-memory analyses: computed on the worker, the main thread\'s bits, and Cancel stops them (curve fit, trend, histogram, heatmap, temporal profile, integral; 2D fit, correlation).');
} finally {
    await browser.close();
    await server.close();
}
