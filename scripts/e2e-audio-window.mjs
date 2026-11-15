// End-to-end check of All | Visible window in the audio strip (#375), in a
// real browser with the app's own audio path.
//
//   · in timeseries mode the strip offers All | Visible window, All first;
//     in an analysis mode it is not shown;
//   · zoomed in, Visible window plays exactly the window: the buffer starts
//     at its left edge and lasts as long, and the readout says so;
//   · a zoom while looping is heard from the end of the loop: the take that
//     sounds is not cut, and the next turn is the new window; without loop
//     a zoom waits for the next play;
//   · a window under 50 ms says so before Play;
//   · a file in memory-saving mode plays its window from the file: every
//     sample of it, equal to the same samples computed here from the CSV.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:audio-window`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { audioSamplesFromArrays } from '../src/utils/audio-samples.js';

const RATE = 8000;
function toneCsv(seconds, name) {
    const times = [];
    const values = [];
    const lines = ['time,tone,half'];
    for (let i = 0; i < RATE * seconds; i++) {
        const t = i / RATE;
        const v = Math.round((0.2 + Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 97 * t)) * 1e5) / 1e5;
        lines.push(`${t.toFixed(6)},${v},${(v / 2).toFixed(6)}`);
        times.push(Number(t.toFixed(6)));
        values.push(v);
    }
    return { file: { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }, times, values };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(page, file, { lazy = false } = {}) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    if (lazy) await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 1 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 120000 });
    if (lazy) await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    const panelId = await page.evaluate(() => {
        const pm = window.app.plotManager;
        window.app.setActiveFile([...pm.files.keys()][0]);
        const panelEl = document.querySelector('.layout-panel');
        pm.addTrace(panelEl.dataset.id, 'tone', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, panelId, { timeout: 60000 });
    // A notice may lie over the toolbar (memory-saving mode): pressed as it is.
    await page.locator(`.layout-panel[data-id="${panelId}"] .panel-audio-btn`).dispatchEvent('click');
    await page.waitForSelector(`.layout-panel[data-id="${panelId}"] .audio-strip`);
    return panelId;
}

const strip = (panelId) => `.layout-panel[data-id="${panelId}"] .audio-strip`;
const zoom = (page, panelId, range) => page.evaluate(([id, r]) => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': r }), [panelId, range]);
const audio = (page, panelId) => page.evaluate((id) => {
    const pm = window.app.plotManager;
    const plot = pm.plots.get(id);
    const state = plot.audio;
    const source = pm._audioSelectedSource(plot);
    return {
        playing: pm._audioPanelIsPlaying(plot),
        position: pm._audioPosition(plot),
        start: state.buffer?.startTime ?? null,
        duration: state.buffer?.duration ?? null,
        frames: state.buffer?.buffer?.length ?? null,
        range: pm._audioRange(plot, source),
        window: state.window,
        loading: !!state.loading,
        readout: document.querySelector(`.layout-panel[data-id="${id}"] .audio-readout`)?.textContent || '',
        note: document.querySelector(`.layout-panel[data-id="${id}"] .audio-strip-note`)?.textContent || '',
    };
}, panelId);
const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label} (${a} vs ${b})`);

try {
    const errors = [];
    // ── In memory ───────────────────────────────────────────────────────────
    {
        const page = await (await browser.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
        page.on('pageerror', e => errors.push(e.message));
        const { file } = toneCsv(3, 'tone.csv');
        const panelId = await open(page, file);

        const group = page.locator(`${strip(panelId)} .audio-window`);
        assert.equal(await group.isVisible(), true, 'in timeseries mode the strip offers the choice');
        assert.deepEqual(await group.locator('.audio-window-btn').allInnerTexts(), ['All', 'Visible window'], 'All | Visible window');
        assert.equal(await group.locator('.audio-window-btn.active').innerText(), 'All', 'All is the default');
        let a = await audio(page, panelId);
        near(a.range[1] - a.range[0], 3 - 1 / RATE, 1e-9, 'All is the whole record');

        await zoom(page, panelId, [0.5, 1.25]);
        await group.locator('[data-window="visible"]').click();
        a = await audio(page, panelId);
        assert.equal(a.window, 'visible');
        assert.deepEqual(a.range, [0.5, 1.25], 'Visible window is the x range of the plot');
        assert.match(a.readout, /0:00\.75$/, `and the readout gives its length (${a.readout})`);

        // Loop, play: the window sounds.
        await page.locator(`${strip(panelId)} .audio-loop`).click();
        await page.locator(`${strip(panelId)} .audio-play`).click();
        await page.waitForFunction(id => window.app.plotManager._audioPanelIsPlaying(window.app.plotManager.plots.get(id)), panelId, { timeout: 5000 });
        a = await audio(page, panelId);
        near(a.start, 0.5, 1e-9, 'the sound starts at the left edge of the window');
        assert.equal(a.frames, 6001, 'and holds every sample of it, both ends included');

        // A pan while it loops: not cut, heard from the end of the turn.
        await page.waitForFunction(id => window.app.plotManager._audioPosition(window.app.plotManager.plots.get(id)) > 0.1, panelId, { timeout: 5000 });
        await zoom(page, panelId, [1.5, 2]);
        await page.waitForTimeout(350);
        a = await audio(page, panelId);
        assert.equal(a.playing, true, 'still playing');
        near(a.start, 0.5, 1e-9, 'the turn that sounds is not cut by the pan');
        await page.waitForFunction(id => Math.abs((window.app.plotManager.plots.get(id).audio.buffer?.startTime ?? 0) - 1.5) < 1e-9, panelId, { timeout: 4000, polling: 'raf' });
        a = await audio(page, panelId);
        assert.ok(a.position < 0.25, `the new window starts from its own beginning, at the seam (${a.position} s in)`);
        assert.equal(a.frames, 4001, 'and is the new window, whole');

        // Without loop: a zoom waits for the next play.
        await page.locator(`${strip(panelId)} .audio-loop`).click();
        await zoom(page, panelId, [0.2, 0.4]);
        await page.waitForTimeout(400);
        a = await audio(page, panelId);
        near(a.start, 1.5, 1e-9, 'playing once, the take runs out as it was');
        await page.waitForFunction(id => !window.app.plotManager._audioPanelIsPlaying(window.app.plotManager.plots.get(id)), panelId, { timeout: 5000 });
        await page.locator(`${strip(panelId)} .audio-play`).click();
        await page.waitForFunction(id => window.app.plotManager._audioPanelIsPlaying(window.app.plotManager.plots.get(id)), panelId, { timeout: 5000 });
        a = await audio(page, panelId);
        near(a.start, 0.2, 1e-9, 'the next play is the new window');
        near(a.duration, 1601 / RATE, 1e-9, 'all of it');
        await page.locator(`${strip(panelId)} .audio-stop`).click();

        // Too short to be a sound: said before Play.
        await zoom(page, panelId, [1, 1.02]);
        await page.waitForTimeout(200);
        a = await audio(page, panelId);
        assert.match(a.note, /50 ms/, `a 20 ms window says it is too short (${a.note})`);

        // All again: the whole record, whatever the zoom.
        await group.locator('[data-window="all"]').click();
        a = await audio(page, panelId);
        near(a.range[1] - a.range[0], 3 - 1 / RATE, 1e-9, 'All plays everything');
        assert.doesNotMatch(a.note, /50 ms/, `and has nothing to say about the zoom (${a.note})`);

        // In an analysis mode the analysis' selection sounds: no choice shown.
        await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'fft'), panelId);
        await page.waitForFunction(id => window.app.plotManager.plots.get(id).mode === 'fft', panelId);
        await page.waitForSelector(strip(panelId));
        assert.equal(await page.locator(`${strip(panelId)} .audio-window`).isVisible(), false, 'not shown in Fourier mode');
        await page.close();
    }

    // ── Memory-saving mode: the window is read from the file ────────────────
    {
        const page = await (await browser.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
        page.on('pageerror', e => errors.push(e.message));
        const { file, times, values } = toneCsv(80, 'long-tone.csv');
        assert.ok(file.buffer.length > 1.2 * 1024 * 1024, 'above the 1 MB full-load limit set for the test');
        const panelId = await open(page, file, { lazy: true });
        const overview = await page.evaluate(() => [...window.app.plotManager.files.values()][0].data.variables.tone.data.length);
        assert.ok(overview < times.length / 10, `what is in memory is an overview (${overview} of ${times.length} rows)`);
        assert.equal(await page.locator(`${strip(panelId)} .audio-play`).isDisabled(), false, 'a file in memory-saving mode can be played');

        await zoom(page, panelId, [40, 41.5]);
        await page.locator(`${strip(panelId)} .audio-window [data-window="visible"]`).click();
        await page.locator(`${strip(panelId)} .audio-play`).click();
        await page.waitForFunction(id => window.app.plotManager._audioPanelIsPlaying(window.app.plotManager.plots.get(id)), panelId, { timeout: 60000 });
        const a = await audio(page, panelId);
        near(a.start, 40, 1e-9, 'the window starts where the plot does');
        assert.equal(a.frames, 12001, 'every row of the window, read from the file');

        // The same samples, from the CSV's own rows, through the same kernel.
        const from = times.findIndex(t => t >= 40);
        const to = times.findIndex(t => t > 41.5);
        const want = audioSamplesFromArrays(Float64Array.from(times.slice(from, to)), [Float64Array.from(values.slice(from, to))]);
        const got = await page.evaluate(id => Array.from(window.app.plotManager.plots.get(id).audio.buffer.buffer.getChannelData(0)), panelId);
        assert.equal(got.length, want.outs[0].length);
        let differ = 0;
        for (let i = 0; i < got.length; i++) if (!Object.is(got[i], want.outs[0][i])) differ++;
        assert.equal(differ, 0, 'sample for sample what the rows of the file give');
        await page.locator(`${strip(panelId)} .audio-stop`).click();
        await page.close();
    }

    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e audio window: All | Visible window plays the zoom, follows it at the end of the loop or the next play, says when it is too short, and reads a lazy file\'s window from the file');
} finally {
    await browser.close();
    await server.close();
}
