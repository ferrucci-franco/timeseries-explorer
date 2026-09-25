// End-to-end check of "Collapse repeated timestamps" in a real browser: the
// Variable picker decides which variables the collapsed file holds, and
// "Create and plot" draws the result beside the original, on its panel.
//
// Scenario: a CSV with two variables and a burst at t = 20. The source's `a`
// is plotted; Collapse is run with `a` picked. The new file must hold `a`
// only, and its trace must land on the panel that shows the source `a` — no
// new panel. The Repeated button then tells the two apart: available for the
// original, and the collapsed trace has no repeats to mark.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:collapse-plot`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function burstCsv() {
    const lines = ['time,a,b'];
    for (let i = 0; i < 400; i++) {
        let t = i / 10;
        if (i >= 200 && i <= 203) t = 20;
        lines.push(`${t.toFixed(1)},${Math.sin(i / 20).toFixed(5)},${Math.cos(i / 20).toFixed(5)}`);
    }
    return { name: 'burst.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [burstCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'a', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForTimeout(500);
    const panelsBefore = await page.evaluate(() => document.querySelectorAll('.layout-panel').length);

    await page.selectOption('#data-tool-select', 'collapse');
    await page.waitForTimeout(300);
    const options = await page.evaluate(() => [...document.querySelectorAll('#outlier-variable option')].map(o => o.value));
    assert.ok(options.includes('a') && options.includes('b') && options.length === 3,
        `the picker offers All + each variable (${options})`);
    await page.selectOption('#outlier-variable', 'a');
    await page.waitForTimeout(200);
    await page.click('#data-tool-create-plot');
    await page.waitForFunction(() => window.app.plotManager.files.size === 2, null, { timeout: 30000 });
    await page.waitForTimeout(800);

    const result = await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const ids = [...pm.files.keys()];
        const derived = pm.files.get(ids[1]).data;
        const plot = pm.plots.get(id);
        return {
            variables: Object.keys(derived.variables).sort(),
            rows: derived.variables.a.data.length,
            panels: document.querySelectorAll('.layout-panel').length,
            traces: plot.traces.map(t => `${t.fileId === ids[0] ? 'source' : 'collapsed'}:${t.varName}`),
        };
    }, panelId);
    assert.deepEqual(result.variables, ['a', 'time'], 'the collapsed file holds the picked variable only');
    assert.equal(result.rows, 397, '400 rows, a burst of 4 → 397');
    assert.equal(result.panels, panelsBefore, 'no new panel');
    assert.deepEqual(result.traces, ['source:a', 'collapsed:a'], 'the collapsed curve is drawn beside the original');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Collapse plot end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
