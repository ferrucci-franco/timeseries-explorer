// Every analysis shows a computing pill with a Cancel button while it
// recalculates, and Cancel stops the work and keeps what is on screen.
//
// For each of the nine analyses — FFT, histogram, heatmap, temporal profile,
// integral, curve fit and trend analysis on a time series; correlation and
// curve fit on a 2D plot — over a file open in memory-saving (lazy) mode:
//
//   1. the analysis computes its first result;
//   2. the queries and streams that carry the panel's cancel signal are made
//      to hang until that signal is aborted (so the test also proves the
//      analysis hands its queries the signal), and a recompute is asked for;
//   3. the pill shows with its Cancel button, over the previous result;
//   4. Cancel: the hung query is aborted, the pill goes, the previous result
//      is still drawn, and the setting the recompute was asked with is back to
//      the one of that result — the status says so;
//   5. with queries answering again, the analysis computes as before.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:analysis-cancel`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 200000;
const START = Date.UTC(2023, 4, 1, 0, 0, 0);
const lines = ['time,a,b'];
for (let i = 0; i < ROWS; i++) {
    const a = Math.sin(i / 500) * 3 + (i % 7) / 10;
    lines.push(`${new Date(START + i * 60000).toISOString()},${a.toFixed(6)},${(1 + i / 1000).toFixed(6)}`);
}
const file = { name: 'lazy-cancel.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 2 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });

    // Queries and streams that carry a cancel signal hang, while __hang.on,
    // until that signal is aborted. Everything else (overview, detail) runs.
    await page.evaluate(() => {
        const pm = window.app.plotManager;
        const source = [...pm.files.values()][0].data._duckdb.source;
        window.__hang = { on: false, started: 0, aborted: 0 };
        const hangUntilAborted = (signal) => new Promise((resolve, reject) => {
            window.__hang.started++;
            const fail = () => {
                window.__hang.aborted++;
                const error = new Error('cancelled');
                error.name = 'AbortError';
                reject(error);
            };
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
        });
        const query = source._interactiveQuery.bind(source);
        source._interactiveQuery = (sql, options = {}) => (window.__hang.on && options?.signal
            ? hangUntilAborted(options.signal)
            : query(sql, options));
        const stream = source.streamColumns.bind(source);
        source.streamColumns = (data, names, options = {}) => {
            if (!(window.__hang.on && options?.signal)) return stream(data, names, options);
            return (async function* hung() { await hangUntilAborted(options.signal); })();
        };
        window.__clearAnalysisCaches = (plot) => {
            source._heatmapCache?.clear?.();
            source._temporalProfileCache?.clear?.();
            source._correlationCache?.clear?.();
            source._regressionCache?.clear?.();
            plot?._fftSpectrumCache?.clear?.();
        };
    });

    const panelIds = await page.evaluate(() => {
        const app = window.app;
        const pm = app.plotManager;
        app.setActiveFile([...pm.files.keys()][0]);
        const first = document.querySelector('.layout-panel');
        window.app.layoutManager.splitPanel(first.dataset.id, 'h', false);
        return [...document.querySelectorAll('.layout-panel')].map(panel => panel.dataset.id);
    });
    await page.waitForFunction(() => document.querySelectorAll('.layout-panel').length === 2);
    const [timeId, twoDId] = panelIds;
    await page.evaluate(id => {
        const el = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager.addTrace(id, 'a', el);
    }, timeId);
    await page.waitForTimeout(1200);

    // What each analysis draws, read back as a count of drawn points: the
    // "previous result" a cancel must leave on screen.
    const drawn = (id, mode) => page.evaluate(({ id, mode }) => {
        const plot = window.app.plotManager.plots.get(id);
        const count = (div, keep = () => true) => (div?.data || []).filter(keep)
            .reduce((n, t) => n + (t.x?.length || 0) + (t.z?.length || 0) + (t.values?.length || 0), 0);
        switch (mode) {
        case 'fft': return count(plot.fftDiv);
        case 'histogram': return count(plot.histogramDiv);
        case 'heatmap': return count(plot.heatmapDiv);
        case 'temporal-profile': return count(plot.temporalProfileDiv);
        case 'integral': return count(plot.integralDiv);
        case 'curve-fit': return count(plot.div, t => t.meta?.curveFitIndex !== undefined);
        case 'trend': return count(plot.div, t => t.meta?.trendIndex !== undefined);
        case 'correlation': return count(plot.correlationDiv);
        case 'phase2d': return count(plot.div, t => t.line?.dash === 'dash');
        default: return 0;
        }
    }, { id, mode });
    const pillShown = (id) => page.evaluate(id => {
        const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
        return !!panel?.querySelector('.analysis-computing-indicator.active .analysis-cancel-btn');
    }, id);
    const statusText = (id) => page.evaluate(id => {
        const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
        return panel?.querySelector('.fft-status, .hist-status, .heatmap-status')?.textContent || '';
    }, id);
    const settled = (id, mode) => page.waitForFunction(({ id, mode }) => {
        const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
        const plot = window.app.plotManager.plots.get(id);
        if (!plot || panel?.querySelector('.analysis-computing-indicator')) return false;
        const status = panel?.querySelector('.fft-status, .hist-status, .heatmap-status');
        if (status?.className.includes('loading')) return false;
        const divs = { fft: 'fftDiv', histogram: 'histogramDiv', heatmap: 'heatmapDiv', 'temporal-profile': 'temporalProfileDiv', integral: 'integralDiv', correlation: 'correlationDiv' };
        if (divs[mode]) {
            const div = plot[divs[mode]];
            return !!div && (div.data || []).some(t => (t.x?.length || 0) + (t.z?.length || 0) + (t.values?.length || 0) > 0);
        }
        if (mode === 'curve-fit') return plot._curveFitResults?.[0]?.result?.fit?.status === 'ok';
        if (mode === 'trend') return !!plot._trendResults?.[0]?.result;
        if (mode === 'phase2d') return (plot._phase2dFits || []).some(r => r.fit?.status === 'ok');
        return true;
    }, { id, mode }, { timeout: 90000 }).catch(async (error) => {
        const state = await page.evaluate(({ id, mode }) => {
            const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
            const plot = window.app.plotManager.plots.get(id);
            return {
                mode: plot?.mode,
                pill: panel?.querySelector('.analysis-computing-indicator')?.textContent || null,
                status: panel?.querySelector('.fft-status, .hist-status, .heatmap-status')?.className + ' | ' + panel?.querySelector('.fft-status, .hist-status, .heatmap-status')?.textContent,
                pairs: (plot?.phaseTraces || []).map(p => `${p.x}→${p.y} ${p.visible}`),
                corr: plot?.correlationDiv ? (plot.correlationDiv.data || []).map(t => t.x?.length) : 'no div',
                fits: (plot?._phase2dFits || []).map(r => r.fit?.status ?? r.lazyStatus ?? null),
            };
        }, { id, mode });
        throw new Error(`${mode} did not settle: ${JSON.stringify(state)} (${error.message})`);
    });

    // `setting()` reads what the recompute changes; Cancel must put it back.
    async function checkCancel({ name, id, mode, open, recompute, setting }) {
        await open();
        await settled(id, mode);
        const before = await drawn(id, mode);
        assert.ok(before > 0, `${name}: a first result is drawn (${before} points)`);

        const hang = await page.evaluate(() => ({ ...window.__hang }));
        const settingBefore = await setting();
        await page.evaluate(() => { window.__hang.on = true; });
        await recompute();
        assert.notDeepEqual(await setting(), settingBefore, `${name}: the recompute changes a setting`);
        await page.waitForFunction(({ id, started }) => {
            const panel = document.querySelector(`.layout-panel[data-id="${id}"]`);
            return window.__hang.started > started
                && !!panel?.querySelector('.analysis-computing-indicator.active .analysis-cancel-btn');
        }, { id, started: hang.started }, { timeout: 60000 });
        assert.equal(await drawn(id, mode), before, `${name}: the previous result stays while it computes`);
        // OMV_SHOTS=<dir>: a picture of each panel with its pill, to look at.
        if (process.env.OMV_SHOTS) {
            await page.locator(`.layout-panel[data-id="${id}"]`).screenshot({ path: `${process.env.OMV_SHOTS}/${mode}.png` });
        }

        await page.locator(`.layout-panel[data-id="${id}"] .analysis-cancel-btn`).click();
        await page.waitForFunction(id => !document.querySelector(`.layout-panel[data-id="${id}"] .analysis-computing-indicator`), id, { timeout: 15000 });
        const after = await page.evaluate(() => ({ ...window.__hang }));
        assert.ok(after.aborted > hang.aborted, `${name}: Cancel aborted the hung query`);
        assert.match(await statusText(id), /Calculation cancelled — the previous result and its settings are back/, `${name}: the status says it was cancelled, and the settings put back`);
        const drawnAfter = await drawn(id, mode);
        if (drawnAfter !== before) {
            const traces = await page.evaluate(id => {
                const manager = window.app.plotManager;
                const plot = manager.plots.get(id);
                return {
                    traces: (plot.div?.data || []).map(t => ({ name: t.name, dash: t.line?.dash, n: t.x?.length })),
                    models: (plot.phaseTraces || []).map(p => p.fitModel),
                    applied: (plot._analysisApplied?.pairs || []).map(p => [p.fitModel, plot.phaseTraces.includes(p.pair)]),
                    lazy: [...(plot._phase2dLazyFits?.entries() || [])].map(([k, v]) => ({ status: v.status, fit: !!v.fit, prev: !!v.previous, keyOk: (plot.phaseTraces || []).some(p => manager._phase2dLazyFitKey(plot, p) === v.key) })),
                    fits: (plot._phase2dFits || []).map(r => ({ model: r.model, fit: r.fit?.status, curve: r.curve?.x?.length, lazy: r.lazy, st: r.lazyStatus })),
                };
            }, id);
            assert.fail(`${name}: the previous result is still drawn (${drawnAfter} points, ${before} before): ${JSON.stringify(traces)}`);
        }
        assert.deepEqual(await setting(), settingBefore, `${name}: the settings are those of the result on screen again`);
        // Nothing restarts it behind the user's back.
        await page.waitForTimeout(600);
        assert.equal(await pillShown(id), false, `${name}: no recompute starts by itself`);

        await page.evaluate(() => { window.__hang.on = false; });
        await recompute();
        await settled(id, mode);
        assert.doesNotMatch(await statusText(id), /cancelled/, `${name}: and then it computes again`);
        console.log(`ok  ${name}`);
    }

    const pm = (fn, ...args) => page.evaluate(({ fn, args }) => {
        const manager = window.app.plotManager;
        return manager[fn](...args);
    }, { fn, args });
    const stateOf = (id, key, read) => page.evaluate(({ id, key, read }) => {
        const state = window.app.plotManager.plots.get(id)[key];
        return read.map(field => state[field]);
    }, { id, key, read });
    const patchState = (id, key, patch) => page.evaluate(({ id, key, patch }) => {
        Object.assign(window.app.plotManager.plots.get(id)[key], patch);
    }, { id, key, patch });
    // A selection of the middle of the panel's time axis, in display units.
    const middleRange = (id) => page.evaluate((id) => {
        const manager = window.app.plotManager;
        const plot = manager.plots.get(id);
        const trace = plot.traces?.[0] || plot.phaseTraces?.[0];
        const times = manager._getTransformedTimeDataForVariable(trace.fileId, trace.varName || trace.x);
        const lo = Number(times[0]);
        const hi = Number(times[times.length - 1]);
        return { rangeFull: false, x1: lo + (hi - lo) * 0.3, x2: lo + (hi - lo) * 0.7 };
    }, id);
    const clearCaches = (id) => page.evaluate(id => window.__clearAnalysisCaches(window.app.plotManager.plots.get(id)), id);
    const toggle = (id, mode) => page.evaluate(({ id, mode }) => window.app.plotManager._toggleTimeseriesAnalysisMode(id, mode), { id, mode });
    // A 2D plot's analyses, picked as its Analysis menu picks them.
    const pick2d = (id, key) => page.evaluate(({ id, key }) => {
        const manager = window.app.plotManager;
        const item = manager._analysisMenuModel(id, manager.plots.get(id)).find(entry => entry.key === key);
        item.run();
    }, { id, key });

    // The time-series analyses are asked to recompute by a change of their
    // range: the whole file ↔ the middle of it. Cancel must put it back.
    const toggleRange = async (id, key, schedule) => {
        const [rangeFull] = await stateOf(id, key, ['rangeFull']);
        await patchState(id, key, rangeFull ? await middleRange(id) : { rangeFull: true });
        await clearCaches(id);
        await pm(schedule, id, { immediate: true });
    };
    const rangeOf = (id, key) => () => stateOf(id, key, ['rangeFull', 'x1', 'x2']);
    for (const [name, mode, key, schedule] of [
        ['FFT', 'fft', 'fft', '_scheduleFftRecompute'],
        ['Histogram', 'histogram', 'histogram', '_scheduleHistogramRecompute'],
        ['Heatmap', 'heatmap', 'heatmap', '_scheduleCalendarHeatmapRecompute'],
        ['Temporal profile', 'temporal-profile', 'temporalProfile', '_scheduleTemporalProfileRecompute'],
        ['Integral', 'integral', 'integral', '_scheduleIntegralRecompute'],
    ]) {
        await checkCancel({
            name, id: timeId, mode,
            open: () => toggle(timeId, mode),
            recompute: () => toggleRange(timeId, key, schedule),
            setting: rangeOf(timeId, key),
        });
    }
    let curveModel = 'linear';
    await checkCancel({
        name: 'Curve fit', id: timeId, mode: 'curve-fit',
        open: async () => {
            await toggle(timeId, 'curve-fit');
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.curveFitResidualDiv?._fullLayout, timeId, { timeout: 30000 });
            await pm('_updateCurveFitEntry', timeId, { model: 'linear' });
        },
        recompute: async () => {
            curveModel = curveModel === 'quadratic' ? 'power' : 'quadratic';
            await pm('_updateCurveFitEntry', timeId, { model: curveModel });
        },
        setting: () => page.evaluate(id => window.app.plotManager.plots.get(id).curveFit.fits.map(fit => fit.model), timeId),
    });

    // The trend analysis: its numbers come back from aggregate queries that
    // carry the panel's cancel signal, and its range is what a recompute
    // changes — the whole signal ↔ the middle of it.
    let trendFull = true;
    await checkCancel({
        name: 'Trend analysis', id: timeId, mode: 'trend',
        open: async () => {
            await toggle(timeId, 'trend');
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.trendTableEl, timeId, { timeout: 30000 });
            await pm('_updateTrendSegment', timeId, { rangeFull: true });
        },
        recompute: async () => {
            trendFull = !trendFull;
            await pm('_updateTrendSegment', timeId, trendFull ? { rangeFull: true } : await middleRange(timeId));
        },
        setting: () => page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments
            .map(segment => [segment.rangeFull, segment.x1, segment.x2]), timeId),
    });

    // The 2D plot: a against b.
    await page.evaluate(id => window.app.plotManager._setMode(id, 'phase2d'), twoDId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'phase2d', twoDId);
    await page.evaluate(id => {
        const el = document.querySelector(`.layout-panel[data-id="${id}"]`);
        const manager = window.app.plotManager;
        manager.addTrace(id, 'b', el);
        manager.addTrace(id, 'a', el);
    }, twoDId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phaseTraces?.length > 0, twoDId, { timeout: 30000 });
    await checkCancel({
        name: 'Correlation', id: twoDId, mode: 'correlation',
        open: () => pick2d(twoDId, 'correlation'),
        recompute: () => toggleRange(twoDId, 'correlation', '_scheduleCorrelationRecompute'),
        setting: rangeOf(twoDId, 'correlation'),
    });
    let pairModel = 'linear';
    const setPairModel = (model) => page.evaluate(({ id, model }) => {
        const manager = window.app.plotManager;
        const plot = manager.plots.get(id);
        for (const pair of plot.phaseTraces) pair.fitModel = model;
        manager._schedulePhase2dFitRecompute(id, { immediate: true });
    }, { id: twoDId, model });
    await checkCancel({
        name: '2D curve fit', id: twoDId, mode: 'phase2d',
        open: async () => {
            await pick2d(twoDId, 'phase2d-fit');
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.phase2dFitContainer, twoDId, { timeout: 30000 });
            await setPairModel('linear');
        },
        recompute: async () => {
            pairModel = pairModel === 'quadratic' ? 'exponential-offset' : 'quadratic';
            await setPairModel(pairModel);
        },
        setting: () => page.evaluate(id => window.app.plotManager.plots.get(id).phaseTraces.map(pair => pair.fitModel), twoDId),
    });

    // The Analysis menu: picking the analysis that is on changes nothing.
    for (const [id, key, mode] of [[timeId, 'curve-fit', 'curve-fit'], [twoDId, 'phase2d-fit', 'phase2d']]) {
        await page.evaluate(({ id, key }) => {
            const manager = window.app.plotManager;
            manager._analysisMenuModel(id, manager.plots.get(id)).find(entry => entry.key === key).run();
        }, { id, key });
        await page.waitForTimeout(400);
        const now = await page.evaluate(id => {
            const plot = window.app.plotManager.plots.get(id);
            return { mode: plot.mode, fit: !!plot.phase2d?.fitEnabled };
        }, id);
        assert.equal(now.mode, mode, `${key}: picked again from the menu, it stays on`);
        if (key === 'phase2d-fit') assert.equal(now.fit, true, 'the 2D fit workspace stays open');
    }

    assert.deepEqual(errors, [], 'no page errors');
    console.log('analysis cancel e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
