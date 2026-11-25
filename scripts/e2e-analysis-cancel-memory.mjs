// The analyses of a file held in memory compute on the compute worker, and
// their Cancel button works while they do (#381).
//
// A kernel that runs on the main thread cannot be stopped: the pill is drawn,
// but the page takes no click until the result is there. On the worker
// (src/core/analysis-pool.js) the page stays free, and the run's signal
// terminates the worker. For each analysis moved there so far — the Curve fit
// of a time series — over a CSV of 150 000 rows open in memory:
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
const lines = ['time,a,b'];
for (let i = 0; i < ROWS; i++) {
    const a = 5 * Math.exp(-i / 40000) + Math.sin(i / 700) * 0.2 + 1;
    lines.push(`${(i * 0.01).toFixed(2)},${a.toFixed(6)},${(1 + i / 1000).toFixed(6)}`);
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

    assert.deepEqual(errors, [], 'no page error');
    console.log('In-memory analyses: computed on the worker, the main thread\'s bits, and Cancel stops them (curve fit).');
} finally {
    await browser.close();
    await server.close();
}
