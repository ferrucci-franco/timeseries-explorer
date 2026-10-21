// End-to-end check of a Live Update poll on time-series panels
// (src/app/methods/live-update-methods.js, PlotManager._liveAppendUpdateInPlace)
// in a real browser, Full Desktop's file reads stood in for by the page:
//
//   - a poll redraws each time-series panel in place: the chart stays the same
//     element, and the rows appended reach its traces;
//   - what it draws is what rebuilding the panel would draw: the same points,
//     the same axis ranges, the right axis included;
//   - the view follows the policy chosen: pin the start and stretch the end,
//     a sliding window, autoscale;
//   - a poll is not a Ctrl+Z step;
//   - with downsampling off (a trace may need WebGL), the panel is rebuilt.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:live-update`. Not
// part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const row = i => {
    const stamp = new Date(T0 + i * 1000).toISOString().replace('T', ' ').slice(0, 19);
    return `${stamp},${(Math.sin(i / 50) * 10).toFixed(3)},${(i * 0.01).toFixed(3)},${(1000 + (i % 37)).toFixed(1)}\n`;
};
let initial = 'time,a,b,c\n';
for (let i = 0; i < 3000; i++) initial += row(i);
const PATH = '/virtual/live.csv';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Full Desktop reads the file through its preload; here the "file" is a
    // string the test appends to.
    await page.addInitScript(() => {
        const bytes = () => new TextEncoder().encode(window.__liveText || '');
        window.omvDesktop = {
            platform: 'linux', homedir: '/home/user', tmpdir: '/tmp', username: 'user',
            setTheme() {}, setSpellcheck() {},
            statFile: async () => ({ ok: true, size: bytes().length, lastModified: Date.now(), name: 'live.csv' }),
            readFileSlice: async ({ start, end }) => ({ ok: true, bytes: bytes().slice(start, end).buffer }),
            readFile: async () => ({ ok: false, message: 'not used' }),
            selectFilePath: async () => '/virtual/live.csv',
        };
    });
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.evaluate(async ({ text, path }) => {
        window.__liveText = text;
        const file = new File([text], 'live.csv', { type: 'text/csv', lastModified: Date.now() });
        await window.app.loadFiles([{ file, fileHandle: null, localPath: path }]);
    }, { text: initial, path: PATH });
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const panels = await page.evaluate(() => {
        const app = window.app;
        const pm = app.plotManager;
        app.setActiveFile([...pm.files.keys()][0]);
        app.layoutManager.resetToGrid(1, 2);
        const ids = [...document.querySelectorAll('.layout-panel')].map(el => el.dataset.id);
        const el = id => document.querySelector(`.layout-panel[data-id="${id}"]`);
        pm.addTrace(ids[0], 'a', el(ids[0]));
        pm.addTrace(ids[0], 'b', el(ids[0]));
        pm.addTrace(ids[1], 'c', el(ids[1]));
        return ids;
    });
    await page.waitForFunction(() => [...window.app.plotManager.plots.values()].every(p => p.div?._fullLayout));
    // The second trace of the first panel on the right axis.
    await page.evaluate(id => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        plot.timeseriesY2Enabled = true;
        plot.traces[1].axis = 'y2';
        pm._rebuildPanel(id);
    }, panels[0]);
    await page.waitForFunction(() => [...window.app.plotManager.plots.values()].every(p => p.div?._fullLayout));
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id).div._fullLayout.xaxis.type, panels[0]), 'date');

    await page.evaluate(async () => {
        const app = window.app;
        const fileId = [...app.files.keys()][0];
        await app._startLiveUpdate(fileId);
        // Polls are driven by the test, not by the timer.
        const state = app.files.get(fileId).liveUpdate;
        clearTimeout(state.timer);
        app._scheduleLiveUpdate = () => {};
    });

    let next = 3000;
    const poll = rows => page.evaluate(async ({ text }) => {
        const app = window.app;
        window.__liveText += text;
        const fileId = [...app.files.keys()][0];
        await app._pollLiveUpdate(fileId);
        // Let the redraw and what waits on it settle.
        await new Promise(resolve => setTimeout(resolve, 450));
        return app.files.get(fileId).liveUpdate.status;
    }, { text: Array.from({ length: rows }, () => row(next++)).join('') });
    const chart = id => page.evaluate(id => {
        const plot = window.app.plotManager.plots.get(id);
        const fl = plot.div._fullLayout;
        const data = plot.div.data.slice(0, plot.traces.length);
        return {
            x: data.map(d => Array.from(d.x)),
            y: data.map(d => Array.from(d.y)),
            xRange: fl.xaxis.range.map(String),
            yRange: [...fl.yaxis.range],
            y2Range: fl.yaxis2 ? [...fl.yaxis2.range] : null,
        };
    }, id);
    const lastStamp = () => new Date(T0 + (next - 1) * 1000).toISOString().slice(0, 19);
    const ms = value => Date.parse(String(value).replace(' ', 'T').replace(/Z?$/, 'Z'));

    // ── A poll redraws in place ──
    await page.evaluate(() => { window.__divs = [...window.app.plotManager.plots.values()].map(p => p.div); });
    const startBefore = (await chart(panels[0])).xRange[0];
    assert.equal(await poll(5), 'ok');
    assert.deepEqual(await page.evaluate(() => [...window.app.plotManager.plots.values()].map((p, i) => p.div === window.__divs[i])),
        [true, true], 'the charts are the same elements: updated, not rebuilt');
    let shown = await chart(panels[0]);
    assert.equal(shown.x[0].at(-1).slice(0, 19), lastStamp(), 'the last row appended is drawn');
    assert.equal(shown.xRange[0], startBefore, 'pin the start…');
    assert.equal(ms(shown.xRange[1]), ms(lastStamp()), '…and stretch the end to the last row');

    // ── The same as a rebuild ──
    const equalsRebuild = async (label) => {
        for (const id of panels) {
            const inPlace = await chart(id);
            await page.evaluate(id => {
                const pm = window.app.plotManager;
                pm._rebuildPanel(id, { restoreView: pm._capturePlotView(pm.plots.get(id)) });
            }, id);
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, id);
            await page.waitForTimeout(400);
            const rebuilt = await chart(id);
            assert.deepEqual(inPlace, rebuilt, `${label}: panel ${id} draws what a rebuild draws`);
        }
    };
    await equalsRebuild('pin start');

    // ── Sliding window ──
    await page.evaluate(() => window.app.plotManager.setGlobalLiveViewPolicy('timeseries', { xMode: 'sliding', windowSeconds: 600, yMode: 'autoscale' }));
    assert.equal(await poll(3), 'ok');
    shown = await chart(panels[0]);
    assert.equal(ms(shown.xRange[1]) - ms(shown.xRange[0]), 600 * 1000, 'a ten-minute window');
    assert.equal(ms(shown.xRange[1]), ms(lastStamp()), 'ending at the last row');
    await equalsRebuild('sliding');

    // ── Autoscale ──
    await page.evaluate(() => window.app.plotManager.setGlobalLiveViewPolicy('timeseries', { xMode: 'autoscale', yMode: 'expand' }));
    assert.equal(await poll(4), 'ok');
    shown = await chart(panels[1]);
    assert.equal(ms(shown.xRange[0]), T0, 'the whole record…');
    assert.equal(ms(shown.xRange[1]), ms(lastStamp()), '…up to the last row');
    assert.equal(shown.x[0].length > 1000, true, 'drawn over the whole record, not over the old window');
    await equalsRebuild('autoscale');

    // ── Not a Ctrl+Z step ──
    await page.waitForTimeout(500);
    const undoBefore = await page.evaluate(id => window.app.plotManager.plots.get(id)._viewHistory?.length || 0, panels[0]);
    await poll(2);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id)._viewHistory?.length || 0, panels[0]), undoBefore,
        'a poll adds no step to Ctrl+Z');

    // ── Downsampling off: rebuilt ──
    await page.evaluate(() => {
        const pm = window.app.plotManager;
        pm.timeseriesVisualMaxPoints = null;
        window.__divs = [...pm.plots.values()].map(p => p.div);
    });
    await poll(2);
    assert.deepEqual(await page.evaluate(() => [...window.app.plotManager.plots.values()].map((p, i) => p.div === window.__divs[i])),
        [false, false], 'with no downsampling limit the panels are rebuilt');
    assert.equal((await chart(panels[1])).x[0].length, next, 'every row drawn');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Live Update end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
