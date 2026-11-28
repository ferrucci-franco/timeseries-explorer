// End-to-end check of the WAV export (#92), in a real browser.
//
//   · the audio strip's ⬇ opens the panel's export dialog on WAV, its options
//     filled in from what sounds and the cursor in the name field; the name
//     is file__signal__range; the size is given before saving;
//   · a stereo recording: Left and Right are offered for the two channels; the
//     file downloaded is a 16-bit stereo WAV at the recording's own rate
//     (8 kHz, not the browser's), and every sample is the strip's sample of
//     the same range;
//   · a panel with nothing that can be heard offers WAV disabled, with why;
//   · a file in memory-saving mode writes the visible window from the file:
//     the busy overlay shows the progress, and the file is byte for byte the
//     one the CSV's own rows give; Cancel stops an export, and nothing is
//     downloaded.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:wav-export`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';
import { createServer } from 'vite';
import { audioSamplesFromArrays } from '../src/utils/audio-samples.js';
import { encodeWav, encodeWavFrames, wavHeader } from '../src/utils/wav-encode.js';

const RATE = 8000;

async function stereoRecording() {
    const frames = RATE * 2;
    const left = Float32Array.from({ length: frames }, (_, i) => 0.1 + 0.6 * Math.sin(2 * Math.PI * 440 * i / RATE));
    const right = Float32Array.from({ length: frames }, (_, i) => -0.05 + 0.3 * Math.sin(2 * Math.PI * 660 * i / RATE));
    const blob = encodeWav([left, right], { sampleRate: RATE, format: 'float32' });
    return { left, right, file: { name: 'voz.wav', mimeType: 'audio/wav', buffer: Buffer.from(await blob.arrayBuffer()) } };
}
function toneCsv(seconds, name) {
    const times = [];
    const values = [];
    const lines = ['time,tone'];
    for (let i = 0; i < RATE * seconds; i++) {
        const t = i / RATE;
        const v = Math.round((0.2 + Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 97 * t)) * 1e5) / 1e5;
        lines.push(`${t.toFixed(6)},${v}`);
        times.push(Number(t.toFixed(6)));
        values.push(v);
    }
    return { file: { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }, times, values };
}
function slowCsv() {
    const lines = ['time,slow'];
    for (let i = 0; i < 2000; i++) lines.push(`${(i / 100).toFixed(2)},${Math.sin(i / 20).toFixed(5)}`);
    return { name: 'slow.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}
/** The WAV the app should write: the strip's kernel, then PCM or float. */
function expectedWav(time, channels, format) {
    const { info, outs } = audioSamplesFromArrays(Float64Array.from(time), channels.map(c => Float64Array.from(c)));
    const header = Buffer.from(wavHeader({ sampleRate: info.sampleRate, channels: outs.length, format, frames: info.frames }));
    return Buffer.concat([header, Buffer.from(encodeWavFrames(outs, format))]);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

async function open(page, file, varNames, { lazy = false } = {}) {
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    if (lazy) await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 1 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 120000 });
    if (lazy) await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    const panelId = await page.evaluate((names) => {
        const pm = window.app.plotManager;
        window.app.setActiveFile([...pm.files.keys()][0]);
        const panelEl = document.querySelector('.layout-panel');
        for (const name of names) pm.addTrace(panelEl.dataset.id, name, panelEl);
        return panelEl.dataset.id;
    }, varNames);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout, panelId, { timeout: 60000 });
    return panelId;
}
const openStrip = async (page, panelId) => {
    await page.locator(`.layout-panel[data-id="${panelId}"] .panel-audio-btn`).dispatchEvent('click');
    await page.waitForSelector(`.layout-panel[data-id="${panelId}"] .audio-strip`);
};
const dialog = '.modal-dialog-plot-export';
const bytesOf = async (file) => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(await file.path());
};

try {
    const errors = [];
    // ── A stereo recording, from the strip's ⬇ ──────────────────────────────
    {
        const context = await browser.newContext({ viewport: { width: 1300, height: 860 }, acceptDownloads: true });
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        const { left, right, file } = await stereoRecording();
        const panelId = await open(page, file, ['Left', 'Right']);
        await openStrip(page, panelId);
        await page.locator(`.layout-panel[data-id="${panelId}"] .audio-export`).click();
        await page.waitForSelector(dialog);
        assert.equal(await page.locator(`${dialog} input[name="omv-export-format"][value="wav"]`).isChecked(), true, 'the strip\'s ⬇ opens the dialog on WAV');
        await page.waitForFunction(() => document.activeElement?.classList.contains('export-name-input'), null, { timeout: 2000 });
        assert.equal(await page.locator(`${dialog} .export-name-input`).inputValue(), 'voz__Left__0.000-2.000s', 'named file__signal__range');
        assert.equal(await page.locator(`${dialog} .export-name-ext`).innerText(), '.wav');
        assert.equal(await page.locator(`${dialog} .export-wav-section`).isVisible(), true, 'with the sound options');
        assert.equal(await page.evaluate(() => document.querySelector('.export-wav-source').selectedOptions[0].textContent), 'Left', 'what sounds is the signal');
        const monoSize = await page.locator(`${dialog} .export-wav-size`).innerText();
        assert.match(monoSize, /32 kB · 8,000 Hz · Mono · 0:02\.00/, `the size before saving (${monoSize})`);
        assert.match(await page.locator(`${dialog} .export-wav-range`).innerText(), /whole record/, 'and the range');

        await page.locator(`${dialog} input[name="omv-export-wav-channels"][value="stereo"]`).check();
        assert.equal(await page.locator(`${dialog} .export-wav-left`).isVisible(), true, 'stereo: a signal per channel');
        const pick = await page.evaluate(() => ({
            left: document.querySelector('.export-wav-left').selectedOptions[0].textContent,
            right: document.querySelector('.export-wav-right').selectedOptions[0].textContent,
        }));
        assert.deepEqual(pick, { left: 'Left', right: 'Right' }, 'pre-filled with Left and Right of the recording');
        assert.match(await page.locator(`${dialog} .export-wav-size`).innerText(), /64 kB · 8,000 Hz · Stereo/, 'twice the size');
        assert.equal(await page.locator(`${dialog} .export-name-input`).inputValue(), 'voz__Left_Right__0.000-2.000s');

        const [saved] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator(`${dialog} .export-download-btn`).click()]);
        assert.equal(saved.suggestedFilename(), 'voz__Left_Right__0.000-2.000s.wav');
        const bytes = await bytesOf(saved);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        assert.equal(view.getUint16(20, true), 1, '16-bit PCM by default');
        assert.equal(view.getUint16(22, true), 2, 'stereo');
        assert.equal(view.getUint32(24, true), RATE, "at the recording's own rate, not the browser's");
        const time = Array.from({ length: left.length }, (_, i) => i / RATE);
        const want = expectedWav(time, [Array.from(left), Array.from(right)], 'pcm16');
        assert.equal(Buffer.compare(bytes, want), 0, 'every sample the strip\'s, left and right interleaved');
        await page.close();
    }

    // ── Nothing to hear: WAV disabled, with why ─────────────────────────────
    {
        const page = await (await browser.newContext({ viewport: { width: 1300, height: 860 } })).newPage();
        page.on('pageerror', e => errors.push(e.message));
        const panelId = await open(page, slowCsv(), ['slow']);
        await page.evaluate(id => { window.app.plotManager._openExportDialog(id); }, panelId);
        await page.waitForSelector(dialog);
        const wav = page.locator(`${dialog} input[name="omv-export-format"][value="wav"]`);
        assert.equal(await wav.isDisabled(), true, 'a 100 Hz signal cannot be written as sound');
        const hint = await wav.locator('xpath=..').locator('.export-option-hint').innerText();
        assert.match(hint, /slow/, `and the dialog says why, naming it (${hint})`);
        await page.locator(`${dialog} .modal-btn-cancel`).click();
        await page.close();
    }

    // ── Memory-saving mode: the window, from the file ───────────────────────
    {
        const context = await browser.newContext({ viewport: { width: 1300, height: 860 }, acceptDownloads: true });
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        const { file, times, values } = toneCsv(80, 'long-tone.csv');
        const panelId = await open(page, file, ['tone'], { lazy: true });
        await openStrip(page, panelId);
        await page.evaluate(id => Plotly.relayout(window.app.plotManager.plots.get(id).div, { 'xaxis.range': [10, 70] }), panelId);
        await page.locator(`.layout-panel[data-id="${panelId}"] .audio-window [data-window="visible"]`).click();

        // Cancel first: the overlay's button stops the export, nothing is saved.
        await page.locator(`.layout-panel[data-id="${panelId}"] .audio-export`).click();
        await page.waitForSelector(dialog);
        assert.match(await page.locator(`${dialog} .export-wav-range`).innerText(), /visible window/, 'the range is the visible window');
        let downloads = 0;
        page.on('download', () => { downloads++; });
        await page.locator(`${dialog} .export-download-btn`).click();
        await page.waitForSelector('#file-loading-cancel', { timeout: 30000 });
        await page.locator('#file-loading-cancel').click();
        await page.waitForSelector('#file-loading-overlay', { state: 'detached', timeout: 30000 });
        await page.waitForTimeout(500);
        assert.equal(downloads, 0, 'cancelled, nothing is downloaded');

        // Then the export, with its progress.
        await page.locator(`.layout-panel[data-id="${panelId}"] .audio-export`).click();
        await page.waitForSelector(dialog);
        await page.locator(`${dialog} input[name="omv-export-wav-encoding"][value="float32"]`).check();
        const [saved] = await Promise.all([
            page.waitForEvent('download', { timeout: 120000 }),
            (async () => {
                await page.locator(`${dialog} .export-download-btn`).click();
                await page.waitForFunction(() => /samples/.test(document.getElementById('file-loading-hint')?.textContent || ''), null, { timeout: 30000 });
            })(),
        ]);
        assert.equal(saved.suggestedFilename(), 'long-tone__tone__10.000-70.000s.wav');
        const bytes = await bytesOf(saved);
        const from = times.findIndex(t => t >= 10);
        const to = times.findIndex(t => t > 70);
        const want = expectedWav(times.slice(from, to), [values.slice(from, to)], 'float32');
        assert.equal(bytes.length, want.length, `every row of the window (${(bytes.length - 58) / 4} samples)`);
        assert.equal(Buffer.compare(bytes, want), 0, 'byte for byte the WAV of the CSV\'s own rows');
        await page.close();
    }

    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e wav export: the strip\'s ⬇ opens the dialog on WAV, named and sized; stereo Left/Right at the recording\'s rate, sample for sample; disabled with why; a lazy window written from the file, with progress and Cancel');
} finally {
    await browser.close();
    await server.close();
}
