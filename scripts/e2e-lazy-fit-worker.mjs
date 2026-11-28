// The fits of a file in memory-saving (lazy) mode compute on the compute
// worker, from rows read as a stream — and give what they gave (#382).
//
// A lazy fit with no SQL form (every model of the time-series Curve fit, the
// Trend's exponential, the 2D fit's exponential family) used to read its rows
// in one query and fit them on the main thread: 1–3 s at a million rows, 10 s
// at four, during which the page took no click. Now the rows are read chunk
// by chunk, handed to the worker and fitted there by the in-memory kernel.
//
// A CSV of 200 000 rows opens lazily. For the Curve fit, the Trend and the 2D
// Curve fit, with an exponential model:
//   1. the fit is computed by a worker job (`analysis:joined`), from a stream
//      of the file (no single read of the rows);
//   2. it is the fit the previous path gives — the single read and the fit on
//      the main thread, which is what the app still does where there is no
//      worker — compared whole: coefficients, metrics, residuals, curve;
//   3. a change of setting while a job is in flight stops it at once, when the
//      change is scheduled, not when the recompute it schedules gets to run.
//
// Cancel on these fits is scripts/e2e-analysis-cancel.mjs's; their parity
// with a file in memory, scripts/test-lazy-curve-fit.mjs and
// scripts/test-lazy-trend.mjs.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-fit-worker`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
import { createServer } from 'vite';

const ROWS = 200000;
const START = Date.UTC(2023, 4, 1, 0, 0, 0);
const lines = ['time,a,b'];
for (let i = 0; i < ROWS; i++) {
    const a = 5 * Math.exp(-i / 60000) + Math.sin(i / 700) * 0.2 + 1;
    const cell = i % 9973 === 17 ? '' : a.toFixed(6);
    lines.push(`${new Date(START + i * 60000).toISOString()},${cell},${(1 + i / 1000).toFixed(6)}`);
}
const file = { name: 'lazy-fit.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error.stack || error.message)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 2 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelectorAll('.modal-overlay .modal-btn').forEach(button => button.click()));

    // Count what the fits ask of the workers and of the file; `hang` holds a
    // worker job until its signal is aborted.
    await page.evaluate(() => {
        const pm = window.app.plotManager;
        const pool = pm._analysisPool();
        if (!pool) throw new Error('no analysis pool in this browser');
        const source = [...pm.files.values()][0].data._duckdb.source;
        window.__seen = { hang: false, jobs: [], started: 0, aborted: 0, streams: 0, reads: 0 };
        const run = pool.run.bind(pool);
        pool.run = (op, payload, options = {}) => {
            window.__seen.jobs.push(op === 'analysis:joined' ? `joined:${payload.op}` : op);
            if (!window.__seen.hang) return run(op, payload, options);
            window.__seen.started++;
            return new Promise((resolve, reject) => {
                const fail = () => { window.__seen.aborted++; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
                if (options.signal?.aborted) fail();
                else options.signal?.addEventListener('abort', fail, { once: true });
            });
        };
        const stream = source.streamColumns.bind(source);
        source.streamColumns = (...args) => { window.__seen.streams++; return stream(...args); };
        const raw = source.getRawColumnsRange.bind(source);
        source.getRawColumnsRange = (...args) => { window.__seen.reads++; return raw(...args); };
    });
    const seen = () => page.evaluate(() => ({ ...window.__seen, jobs: [...window.__seen.jobs] }));
    const reset = () => page.evaluate(() => Object.assign(window.__seen, { hang: false, jobs: [], started: 0, aborted: 0, streams: 0, reads: 0 }));
    const text = `value => JSON.stringify(value, (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? '#' + v : v))`;

    const [timeId, twoDId] = await page.evaluate(() => {
        const app = window.app;
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        const first = document.querySelector('.layout-panel');
        app.layoutManager.splitPanel(first.dataset.id, 'h', false);
        return [...document.querySelectorAll('.layout-panel')].map(panel => panel.dataset.id);
    });
    await page.waitForFunction(() => document.querySelectorAll('.layout-panel').length === 2);
    await page.evaluate((id) => {
        const el = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager.addTrace(id, 'a', el);
    }, timeId);
    await page.waitForTimeout(1200);

    /**
     * One fit: `ask(value)` changes its setting and schedules it; `done(value)`
     * (page code) says its result for that value is in; `read` (page code)
     * returns that result; `forget` (page code) drops what is cached, so the
     * same setting is computed again.
     */
    async function check({ name, op, open, ask, values, done, read, forget }) {
        await open();
        const until = (value) => page.waitForFunction(({ fn, value }) => (0, eval)(`(${fn})`)(value), { fn: done, value }, { timeout: 180000 });
        // 1. On the worker, from a stream.
        await reset();
        await ask(values[0]);
        await until(values[0]);
        let s = await seen();
        assert.ok(s.jobs.includes(`joined:${op}`), `${name}: fitted by a worker job (${s.jobs})`);
        assert.ok(s.streams >= 1, `${name}: its rows read as a stream`);
        assert.equal(s.reads, 0, `${name}: and not in one read`);
        const fromWorker = await page.evaluate(({ read, text }) => (0, eval)(`(${text})`)((0, eval)(`(${read})`)()), { read, text });
        assert.ok(fromWorker.length > 100 && /"status":"ok"/.test(fromWorker), `${name}: a fit that converged`);

        // 2. The previous path: no worker, the single read, the main thread.
        await reset();
        await page.evaluate(({ forget }) => {
            const pm = window.app.plotManager;
            window.__pool = pm._analysisPool;
            pm._analysisPool = () => null;
            (0, eval)(`(${forget})`)();
        }, { forget });
        await ask(values[0]);
        await until(values[0]);
        s = await seen();
        assert.equal(s.jobs.length, 0, `${name}: with no worker, no job`);
        assert.ok(s.reads >= 1, `${name}: and the single read`);
        const fromMain = await page.evaluate(({ read, text }) => (0, eval)(`(${text})`)((0, eval)(`(${read})`)()), { read, text });
        await page.evaluate(() => { window.app.plotManager._analysisPool = window.__pool; });
        assert.equal(fromWorker, fromMain, `${name}: the worker's fit is the main thread's`);

        // 3. A change while a job is in flight stops it when it is scheduled.
        await reset();
        await page.evaluate(() => { window.__seen.hang = true; });
        await ask(values[1]);
        await page.waitForFunction(() => window.__seen.started === 1, null, { timeout: 60000 });
        // Back in the page's own turn: the abort must have happened inside the
        // call that scheduled the change, before any timer or frame.
        const abortedInCall = await page.evaluate(async ({ ask, value }) => {
            await (0, eval)(`(${ask})`)(value);
            return window.__seen.aborted;
        }, { ask: ask.inPage, value: values[2] });
        assert.equal(abortedInCall, 1, `${name}: the job in flight is stopped as the change is scheduled`);
        await page.evaluate(() => { window.__seen.hang = false; });
        await ask(values[0]);
        await until(values[0]);
        console.log(`  ${name}: worker job from a stream, the main thread's fit, stopped at schedule time`);
    }
    // `ask` both from here and, for step 3, as page code.
    const asker = (inPage) => Object.assign((value) => page.evaluate(({ fn, value }) => (0, eval)(`(${fn})`)(value), { fn: inPage, value }), { inPage });

    const T = JSON.stringify(timeId);
    await check({
        name: 'Curve fit', op: 'analysis:curveFit',
        open: async () => {
            await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'curve-fit'), timeId);
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.curveFitResidualDiv?._fullLayout, timeId, { timeout: 30000 });
        },
        values: ['exponential-offset', 'first-order-offset', 'quadratic'],
        ask: asker(`(model) => { const pm = window.app.plotManager; const p = pm.plots.get(${T}); p.curveFit.fits[0].rangeFull = true; pm._updateCurveFitEntry(${T}, { model }); }`),
        done: `(model) => { const r = window.app.plotManager.plots.get(${T})?._curveFitResults?.[0]; return r?.result?.fit?.status === 'ok' && r.result.fit.model === model; }`,
        read: `() => { const r = window.app.plotManager.plots.get(${T})._curveFitResults[0].result; return { fit: r.fit, residual: r.residual, curve: r.curve, n: r.nScope }; }`,
        forget: `() => { const p = window.app.plotManager.plots.get(${T}); p._curveFitCache.clear(); p._curveFitResults = []; }`,
    });

    await check({
        name: 'Trend', op: 'analysis:trendExp',
        open: async () => {
            await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'trend'), timeId);
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.trendTableEl, timeId, { timeout: 30000 });
        },
        values: ['exponential-offset', 'first-order-offset', 'exponential'],
        ask: asker(`(expModel) => window.app.plotManager._updateTrendSegment(${T}, { rangeFull: true, expModel })`),
        done: `(expModel) => { const r = window.app.plotManager.plots.get(${T})?._trendResults?.[0]; return !!r?.result?.exp && r.result.exp.model === expModel && r.segment.expModel === expModel; }`,
        read: `() => { const r = window.app.plotManager.plots.get(${T})._trendResults[0].result; return { exp: r.exp, trend: r.trend, curves: r.curves }; }`,
        forget: `() => { const p = window.app.plotManager.plots.get(${T}); p._trendCache.clear(); p._trendResults = []; }`,
    });

    // The 2D fit, a against b.
    await page.evaluate(id => window.app.plotManager._setMode(id, 'phase2d'), twoDId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'phase2d', twoDId);
    await page.evaluate((id) => {
        const el = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager.addTrace(id, 'b', el);
        window.app.plotManager.addTrace(id, 'a', el);
    }, twoDId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phaseTraces?.length > 0, twoDId, { timeout: 30000 });
    const D = JSON.stringify(twoDId);
    await check({
        name: '2D curve fit', op: 'analysis:pairFit',
        open: async () => {
            await page.evaluate((id) => {
                const pm = window.app.plotManager;
                const item = pm._analysisMenuModel(id, pm.plots.get(id)).find(entry => entry.key === 'phase2d-fit');
                item.run();
            }, twoDId);
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phase2dFitContainer, twoDId, { timeout: 30000 });
            await page.evaluate((id) => { window.app.plotManager.plots.get(id).phase2d.rangeFull = true; }, twoDId);
        },
        values: ['exponential-offset', 'first-order-offset', 'exponential'],
        ask: asker(`(model) => { const pm = window.app.plotManager; for (const pair of pm.plots.get(${D}).phaseTraces) pair.fitModel = model; pm._schedulePhase2dFitRecompute(${D}, { immediate: true }); }`),
        done: `(model) => { const r = window.app.plotManager.plots.get(${D})?._phase2dFits?.[0]; return r?.fit?.status === 'ok' && r.fit.model === model; }`,
        read: `() => { const r = window.app.plotManager.plots.get(${D})._phase2dFits[0]; return { fit: r.fit, n: r.nScope, curve: r.curve }; }`,
        forget: `() => { const p = window.app.plotManager.plots.get(${D}); p._phase2dLazyFits.clear(); p._phase2dFits = []; }`,
    });

    assert.deepEqual(errors, [], 'no page error');
    console.log('Lazy fits: read as a stream, fitted on the worker, the fit of the single read (curve fit, trend, 2D fit).');
} finally {
    await browser.close();
    await server.close();
}
