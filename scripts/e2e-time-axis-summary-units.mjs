// The time-axis summary speaks the units of the axis it describes.
//
// A datetime file shown as elapsed time, or reindexed with a step, is drawn in
// seconds although its stored column is a date. The "Plotted" summary used to
// read those seconds as milliseconds: an 11 ms step was reported as 11 µs, and
// 1 h as 3.6 s. Checked in a real app, on the desktop layout, against the
// values the plots are given.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

// Hourly samples with a calendar timestamp.
const lines = ['time,load'];
for (let i = 0; i < 48; i++) {
    const t = new Date(Date.UTC(2030, 0, 1) + i * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    lines.push(`${t},${(10 + Math.sin(i / 3)).toFixed(3)}`);
}

try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager);
    await page.setInputFiles('#file-input', [{ name: 'hourly.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const summaryFor = patch => page.evaluate(async (p) => {
        const app = window.app;
        const id = app.activeFileId;
        app._updateFileTransform(id, p, { rerender: true });
        await new Promise(resolve => setTimeout(resolve, 100));
        const times = app.plotManager._getTransformedTimeData(id);
        return { step: times[1] - times[0], lines: app._timeAxisPanelSummaryLines(id) };
    }, patch);
    const plotted = result => result.lines.find(line => line.startsWith('Plotted:')) || result.lines[0];

    let r = await summaryFor({ timeDisplayMode: 'index', timeStepMode: 'custom', customTimeStep: '11 ms' });
    assert.ok(Math.abs(r.step - 0.011) < 1e-12, 'the plots are given seconds');
    assert.match(plotted(r), /Δt 11 ms\b/, `a custom 11 ms step reads 11 ms (${plotted(r)})`);

    r = await summaryFor({ timeStepMode: '1hour', customTimeStep: '' });
    assert.equal(r.step, 3600);
    assert.match(plotted(r), /Δt 1 h\b/, `a 1 h step reads 1 h (${plotted(r)})`);
    assert.doesNotMatch(r.lines.join(' '), /3\.6 s/, 'not a thousandth of it');

    // A datetime column shown as elapsed time: seconds too.
    for (const mode of ['elapsedDateTime', 'elapsedSeconds']) {
        r = await summaryFor({ timeDisplayMode: mode, timeStepMode: null, customTimeStep: '' });
        assert.equal(r.step, 3600, `${mode}: the plots are given seconds`);
        assert.match(plotted(r), /Δt 1 h\b/, `${mode} reads 1 h (${plotted(r)})`);
    }

    // And a calendar still reads its epoch-ms as milliseconds.
    r = await summaryFor({ timeDisplayMode: 'calendar' });
    assert.equal(r.step, 3600e3, 'a calendar axis is epoch-ms');
    assert.match(plotted(r), /Δt 1 h\b/, `calendar reads 1 h (${plotted(r)})`);

    assert.deepEqual(errors, []);
    console.log('time-axis summary units e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
