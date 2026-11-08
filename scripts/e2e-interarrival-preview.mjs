// End-to-end check of the live preview of "Edge interval and rate" (Data
// tools), in a real browser.
//
// The preview restyles its trace in place when only the numbers move. Changing
// HOW the result is drawn — at each edge (dots) to held over the interval
// (stairs), or the output name — must draw the trace again: a restyle kept the
// dots and the old legend name, and only "Create and plot" showed the stairs.
// The same holds while editing an existing result, and Cancel puts the dots
// back.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:interarrival-preview`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// A meter: one step every 90 minutes, a row a minute.
function makeCsv() {
    const lines = ['time,y'];
    const start = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 2000; i++) {
        const stamp = new Date(start + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
        lines.push(`${stamp},${8597 + Math.floor(i / 90)}`);
    }
    return { name: 'meter.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const previewTrace = page => page.evaluate(() => {
    const div = document.querySelector('.layout-panel .js-plotly-plot');
    const trace = (div?.data || []).find(t => t.name && t.name !== 'y');
    return trace ? { name: trace.name, mode: trace.mode, shape: trace.line?.shape } : null;
});
const traceNamed = (page, name) => page.evaluate(wanted => {
    const div = document.querySelector('.layout-panel .js-plotly-plot');
    const trace = (div?.data || []).find(t => t.name === wanted);
    return trace ? { mode: trace.mode, shape: trace.line?.shape } : null;
}, name);
const settle = page => page.waitForTimeout(900);

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'y', panelEl);
    });
    await page.waitForFunction(() => (document.querySelector('.layout-panel .js-plotly-plot')?.data || []).length === 1);

    // ── The draft preview ──
    await page.locator('#data-tool-select').selectOption('interarrival');
    await page.locator('#outlier-variable').selectOption('y');
    await settle(page);
    let preview = await previewTrace(page);
    assert.equal(preview?.mode, 'markers', `the interval at each edge previews as dots (${JSON.stringify(preview)})`);
    assert.equal(preview.name, 'y dt_edges');

    await page.locator('#interarrival-edge').selectOption('rising');
    await page.locator('#interarrival-output').selectOption('rate');
    await settle(page);
    preview = await previewTrace(page);
    assert.equal(preview?.name, 'y rate_up', `the legend follows the suggested name (${JSON.stringify(preview)})`);
    assert.equal(preview.mode, 'markers', 'still at each edge: dots');

    await page.locator('#interarrival-placement').selectOption('hold');
    await settle(page);
    preview = await previewTrace(page);
    assert.equal(preview?.mode, 'lines', `held, the preview is a line (${JSON.stringify(preview)})`);
    assert.equal(preview.shape, 'hv', 'drawn as stairs, as "Create and plot" draws it');

    await page.locator('#interarrival-placement').selectOption('edge');
    await settle(page);
    preview = await previewTrace(page);
    assert.equal(preview?.mode, 'markers', 'and back to dots');
    const traces = await page.evaluate(() => (document.querySelector('.layout-panel .js-plotly-plot')?.data || []).length);
    assert.equal(traces, 2, 'one preview trace, not one per change');

    // ── Editing an existing result ──
    await page.locator('#data-tool-create-plot').click();
    await page.waitForFunction(() => !window.app._dataToolBusy && !!window.app.plotManager.files.values().next().value.data.variables['y rate_up']);
    await settle(page);
    assert.equal((await traceNamed(page, 'y rate_up'))?.mode, 'markers', 'created at each edge: dots');
    await page.evaluate(() => window.app._enterDataToolEditing(window.app.activeFileId, 'y rate_up'));
    await settle(page);
    await page.locator('#interarrival-placement').selectOption('hold');
    await settle(page);
    let edited = await traceNamed(page, 'y rate_up');
    assert.equal(edited?.shape, 'hv', `editing to held redraws the result as stairs (${JSON.stringify(edited)})`);
    assert.equal(edited.mode, 'lines');
    await page.locator('#data-tool-clear').click();
    await settle(page);
    edited = await traceNamed(page, 'y rate_up');
    assert.equal(edited?.mode, 'markers', `Cancel puts the dots back (${JSON.stringify(edited)})`);
    const variable = await page.evaluate(() => {
        const v = window.app.plotManager.files.values().next().value.data.variables['y rate_up'];
        return { events: !!v.eventSamples, held: !!v.heldSteps, finite: Array.from(v.data).filter(Number.isFinite).length };
    });
    assert.deepEqual(variable, { events: true, held: false, finite: 21 }, 'with its own values and flags');

    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e interarrival preview: the live preview redraws dots and stairs as the placement changes, drafting and editing');
} finally {
    await browser.close();
    await server.close();
}
