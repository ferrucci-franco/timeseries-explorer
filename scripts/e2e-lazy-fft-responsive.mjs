// A lazy FFT that recomputes leaves the page responsive, and a newer range
// stops it instead of queueing behind it (#174).
//
// The report: a large file in memory-saving mode, the FFT open; a change of the
// range froze the app until the transform was done — the range could not be
// changed again, and the pointer stayed on the resize arrow. The transform
// itself already ran in a worker; what froze the page was the read of the
// rows: DuckDB's result converted, transformed and cut on the main thread in
// one block (about 1 s here per million rows, 8 s at 8 M), and the next range
// waited for the old read to end.
//
// In Chromium, on a generated CSV opened lazily (1.2 M rows by default):
//
//   1. the FFT is opened, over the whole file: every row of it;
//   2. the range is typed in: from the change to the moment the transform is
//      handed to the worker (the whole read of ~1 M rows), no main-thread task
//      lasts longer than MAX_BLOCK_MS;
//   3. a range is typed, and while its rows are being read the start bound is
//      dragged with the slider and let go: the read of the first range is
//      aborted at once (an AbortError, not a finished read thrown away), the
//      spectrum that comes out is the dragged range's, and no stream
//      connection is left open;
//   4. no page error.
//
// MAX_BLOCK_MS = 250. Before the fix the step 2 window held one task of
// 700–1300 ms on this file (the conversion of the whole read). After it the
// rows are converted in chunks of a few milliseconds; the longest tasks left
// are the time series' own redraws, which headless Chromium paints with
// software WebGL — 50–130 ms on a loaded machine. 250 ms is twice that noise
// and a quarter of the old block.
//
//   FFT_E2E_ROWS=…  another size;  FFT_E2E_CSV=path  an existing file instead.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-fft-responsive`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const MAX_BLOCK_MS = 250;
const ROWS = Number(process.env.FFT_E2E_ROWS || 1200000);
let csvPath = process.env.FFT_E2E_CSV || '';
let generated = false;
if (!csvPath) {
    csvPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-fft-')), `lazy-fft-${ROWS}.csv`);
    generated = true;
    const fd = fs.openSync(csvPath, 'w');
    let buf = ['time,a,b'];
    for (let i = 0; i < ROWS; i++) {
        const a = Math.sin(i * 0.0123) * 3 + Math.sin(i * 0.31) * 0.5 + ((i * 7919) % 101) / 500;
        buf.push(`${(i * 0.001).toFixed(3)},${a.toFixed(6)},${(Math.cos(i * 0.002) * 10).toFixed(5)}`);
        if (buf.length >= 100000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
    fs.closeSync(fd);
}

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
    await page.setInputFiles('#file-input', csvPath);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 600000 });

    const panelId = await page.evaluate(() => {
        const pm = window.app.plotManager;
        window.app.setActiveFile([...pm.files.keys()][0]);
        const el = document.querySelector('.layout-panel');
        pm.addTrace(el.dataset.id, 'a', el);
        return el.dataset.id;
    });
    await page.waitForTimeout(1000);

    // What happens on the main thread, and when each read starts and ends.
    await page.evaluate(() => {
        const pm = window.app.plotManager;
        window.__fft = { long: [], reads: [], computeStarts: [] };
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) window.__fft.long.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: 'longtask', buffered: true });
        const read = pm._fftSeriesForTrace;
        pm._fftSeriesForTrace = function (trace, range, state, signal) {
            const entry = { start: performance.now(), range: [...range], aborted: null, end: null, outcome: null };
            window.__fft.reads.push(entry);
            signal?.addEventListener?.('abort', () => { entry.aborted = performance.now(); }, { once: true });
            return read.apply(this, arguments).then(
                (result) => { entry.end = performance.now(); entry.outcome = result?.ok ? 'ok' : `refused:${result?.reason}`; return result; },
                (error) => { entry.end = performance.now(); entry.outcome = error?.name || 'error'; throw error; },
            );
        };
        // While __fft.slow is set, each chunk of a read arrives 150 ms late:
        // the read of step 3 then lasts long enough to be dragged over on any
        // machine, however fast its DuckDB.
        const source = [...pm.files.values()][0].data._duckdb.source;
        const stream = source.streamColumns.bind(source);
        source.streamColumns = async function* (...args) {
            for await (const chunk of stream(...args)) {
                if (window.__fft.slow) await new Promise(resolve => setTimeout(resolve, 150));
                yield chunk;
            }
        };
        const compute = pm._computeFftSpectrumForSeries;
        pm._computeFftSpectrumForSeries = function () {
            window.__fft.computeStarts.push(performance.now());
            return compute.apply(this, arguments);
        };
    });
    const settled = (since) => page.waitForFunction(({ id, since }) => {
        const plot = window.app.plotManager.plots.get(id);
        if (!plot?.fftDiv || (plot._fftToken || 0) <= since || plot._analysisPill) return null;
        if (!plot._fftStatusType || plot._fftStatusType === 'loading') return null;
        return { status: plot._fftStatusMessage, type: plot._fftStatusType };
    }, { id: panelId, since }, { timeout: 600000, polling: 100 }).then(handle => handle.jsonValue());
    const tokenOf = () => page.evaluate(id => window.app.plotManager.plots.get(id)?._fftToken || 0, panelId);
    // The samples the spectrum on screen was computed from.
    const samplesShown = () => page.evaluate(id => {
        const plot = window.app.plotManager.plots.get(id);
        const match = /([\d.,\s ]+) samples/.exec(plot._fftStatusMessage || '');
        return match ? Number(match[1].replace(/[^\d]/g, '')) : NaN;
    }, panelId);
    const setBound = (key, value) => page.evaluate(({ id, key, value }) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const panel = pm._fftOptionsPanel(plot);
        if (pm._ensureFftState(plot).rangeFull) panel.querySelector('[data-analysis-range-full="false"]').click();
        const field = panel.querySelector(`input[data-fft-key="${key}"][data-fft-role="input"]`);
        field.value = String(value);
        field.dispatchEvent(new Event('change'));
    }, { id: panelId, key, value });

    // 1. The FFT over the whole file.
    let since = await tokenOf();
    let started = Date.now();
    await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'fft'), panelId);
    const opened = await settled(since);
    assert.equal(opened.type, 'ready', `the FFT of the whole file comes out (${opened.status})`);
    const wholeSamples = await samplesShown();
    console.log(`lazy fft: whole file, ${wholeSamples} samples, in ${Date.now() - started} ms`);
    // Every row of the file, not the span of the overview in memory.
    if (generated) assert.equal(wholeSamples, ROWS, '"Full" transforms every row of the file');
    const domain = await page.evaluate(id => window.app.plotManager._fftDomain(window.app.plotManager.plots.get(id)), panelId);
    const span = domain.max - domain.min;

    // 2. A typed range: the page is not blocked while its rows are read.
    await page.evaluate(() => { window.__fft.long = []; window.__fft.reads = []; window.__fft.computeStarts = []; });
    since = await tokenOf();
    started = Date.now();
    const changedAt = await page.evaluate(() => performance.now());
    await setBound('x1', domain.min + span * 0.1);
    await setBound('x2', domain.min + span * 0.9);
    const typed = await settled(since);
    assert.equal(typed.type, 'ready', `the typed range is transformed (${typed.status})`);
    const typedSamples = await samplesShown();
    assert.ok(typedSamples > wholeSamples * 0.7, `the range holds most of the file (${typedSamples} samples)`);
    const window2 = await page.evaluate(() => window.__fft);
    const handedOver = window2.computeStarts.at(-1);
    assert.ok(Number.isFinite(handedOver), 'the transform was handed over');
    const during = window2.long.filter(task => task.start < handedOver && task.start + task.duration > changedAt);
    const longest = Math.max(0, ...during.map(task => task.duration));
    const read = window2.reads.at(-1);
    console.log(`lazy fft: typed range, ${typedSamples} samples, read in ${Math.round(read.end - read.start)} ms, `
        + `longest main-thread task while reading ${Math.round(longest)} ms (${during.length} over 50 ms); done in ${Date.now() - started} ms`);
    assert.ok(longest <= MAX_BLOCK_MS, `no task blocks the main thread for more than ${MAX_BLOCK_MS} ms while the rows are read (longest ${Math.round(longest)} ms)`);

    // 3. A range, and while it is read, the start bound dragged elsewhere.
    await page.evaluate(() => { window.__fft.reads = []; window.__fft.slow = true; });
    since = await tokenOf();
    await setBound('x1', domain.min + span * 0.05);
    await page.waitForFunction(() => window.__fft.reads.length >= 1, null, { timeout: 60000, polling: 20 });
    // Let the read get going, then drag.
    await page.waitForTimeout(200);
    const dragTo = domain.min + span * 0.4;
    const drag = await page.evaluate(async ({ id, from, to }) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const slider = pm._fftOptionsPanel(plot).querySelector('input[data-fft-key="x1"][data-fft-role="slider"]');
        const firstStillReading = window.__fft.reads[0].end === null;
        let maxDelay = 0;
        for (let k = 1; k <= 20; k++) {
            const before = performance.now();
            await new Promise(resolve => setTimeout(resolve, 16));
            maxDelay = Math.max(maxDelay, performance.now() - before - 16);
            slider.value = String(from + ((to - from) * k) / 20);
            slider.dispatchEvent(new Event('input'));
        }
        const followed = Math.abs(pm._ensureFftState(plot).x1 - to) < 1e-9;
        const stillReadingAtRelease = window.__fft.reads[0].end === null;
        slider.dispatchEvent(new Event('change'));
        window.__fft.slow = false;
        return { firstStillReading, stillReadingAtRelease, maxDelay, followed, releasedAt: performance.now() };
    }, { id: panelId, from: domain.min + span * 0.05, to: dragTo });
    assert.ok(drag.firstStillReading && drag.stillReadingAtRelease, 'the drag happens while the first range is still being read');
    assert.ok(drag.followed, 'the bound follows the slider during the read');
    const dragged = await settled(since);
    assert.equal(dragged.type, 'ready', `the dragged range is transformed (${dragged.status})`);
    const reads = await page.evaluate(() => window.__fft.reads);
    const [first] = reads;
    const last = reads.at(-1);
    assert.ok(reads.length >= 2, 'the dragged range is read anew');
    assert.ok(Number.isFinite(first.aborted), 'the first read is aborted');
    assert.ok(first.aborted <= drag.releasedAt + 500, 'as soon as the newer range is asked for');
    assert.equal(first.outcome, 'AbortError', `the first read stops with an AbortError (${first.outcome}), not a finished read thrown away`);
    assert.ok(first.end - first.aborted < 2000, `and stops at once (${Math.round(first.end - first.aborted)} ms after the abort)`);
    assert.ok(last.start < first.aborted + 2000, 'the newer read does not wait for the old one');
    assert.ok(Math.abs(last.range[0] - dragTo) < span * 1e-6, 'the last read is the dragged range');
    const draggedSamples = await samplesShown();
    const expected = Math.round(((domain.min + span * 0.9) - dragTo) / span * typedSamples / 0.8);
    assert.ok(Math.abs(draggedSamples - expected) < expected * 0.01, `the spectrum is the dragged range's (${draggedSamples} samples, ~${expected} expected)`);
    console.log(`lazy fft: a drag during the read aborted it in ${Math.round(first.end - first.aborted)} ms; the dragged range, ${draggedSamples} samples, came out; slider events waited at most ${Math.round(drag.maxDelay)} ms`);
    const openStreams = await page.waitForFunction(() => {
        const source = [...window.app.plotManager.files.values()][0].data._duckdb.source;
        return (source._streamConns?.size || 0) === 0 ? 'none' : null;
    }, null, { timeout: 30000, polling: 100 }).then(handle => handle.jsonValue());
    assert.equal(openStreams, 'none', 'no stream connection is left open');

    assert.deepEqual(errors, [], 'no page error');
    console.log('lazy fft responsive e2e: ok');
} finally {
    await browser.close();
    await server.close();
    if (generated) fs.rmSync(path.dirname(csvPath), { recursive: true, force: true });
}
