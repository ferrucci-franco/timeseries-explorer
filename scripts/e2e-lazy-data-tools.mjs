// End-to-end check of the Data Tools panel on a file read in memory-saving
// (lazy) mode, in a real browser with the DuckDB-WASM the app ships.
//
// A 12 MB CSV (above the 10 MB full-load limit set here) opens lazily. Through
// the panel's own controls: the tool picker offers derivative, detrend and
// outliers and nothing else; the outlier method is hard bounds; the detrend
// methods leave out the moving-average baseline. A derivative and a linear
// detrend are created with "Create and plot", and each is
// drawn from SQL over the file (a zoom returns full resolution), with no page
// error.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-data-tools`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,a,b'];
    for (let i = 0; i < 420000; i++) {
        const a = i % 5003 === 7 ? 90 : Math.sin(i / 500) + (i % 7) / 100;
        lines.push(`${(i * 0.01).toFixed(2)},${a.toFixed(6)},${(i / 1000 + Math.cos(i / 90)).toFixed(6)}`);
    }
    return { name: 'lazy-tools.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

async function pick(page, id, value) {
    await page.locator(`#${id}`).selectOption(value);
}

async function createAndPlot(page, tool, source, output, configure = async () => {}) {
    await pick(page, 'data-tool-select', tool);
    await pick(page, 'outlier-variable', source);
    await configure();
    await page.locator('#outlier-output-name').fill(output);
    await page.locator('#outlier-output-name').dispatchEvent('input');
    const blocked = await page.evaluate(() => {
        const button = document.getElementById('data-tool-create-plot');
        return button.disabled ? (document.getElementById('outlier-message')?.textContent || 'disabled') : '';
    });
    assert.equal(blocked, '', `${tool}: the create button is enabled`);
    await page.locator('#data-tool-create-plot').click();
    await page.waitForFunction(name => {
        const data = [...window.app.plotManager.files.values()][0]?.data;
        return !!data?.variables?.[name]?._duckdbExpr;
    }, output, { timeout: 120000 });
    // The commit is done once the panel is no longer busy (the overview is
    // refreshed and the curve drawn after the variable exists).
    await page.waitForFunction(() => !window.app._dataToolBusy, null, { timeout: 120000 });
}

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
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 10 }));
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    await page.evaluate(() => window.app.setActiveFile([...window.app.plotManager.files.keys()][0]));
    await page.waitForTimeout(500);

    const picker = await page.evaluate(() => Object.fromEntries(
        [...document.querySelectorAll('#data-tool-select option')].filter(o => o.value).map(o => [o.value, !o.disabled])));
    assert.deepEqual(Object.keys(picker).filter(k => picker[k]).sort(), ['derivative', 'detrend', 'removeOutliers'],
        'a lazy file offers the tools written as SQL');

    await createAndPlot(page, 'derivative', 'a', 'da', () => pick(page, 'derivative-method', 'centered'));

    // Outliers: hard bounds only (the spike detector needs the chunked
    // executor; IQR is computed for sessions that carry it, but the menu does
    // not offer it for any file).
    await pick(page, 'data-tool-select', 'removeOutliers');
    const outlierMethods = await page.evaluate(() => Object.fromEntries(
        [...document.querySelectorAll('#outlier-method option')].map(o => [o.value, !o.disabled])));
    assert.deepEqual(Object.keys(outlierMethods).filter(k => outlierMethods[k]), ['bounds'], 'outliers: hard bounds');

    await createAndPlot(page, 'detrend', 'b', 'lb', async () => {
        const methods = await page.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('#detrend-method option')].map(o => [o.value, !o.disabled])));
        assert.equal(methods.movingAverage, false, 'the moving-average baseline is not offered');
        assert.equal(methods.linear, true, 'a straight line is');
        await pick(page, 'detrend-method', 'linear');
    });

    // Each output is on a plot and reads the file, not the overview: a narrow
    // zoom returns every row in it.
    const zoom = await page.evaluate(async () => {
        const data = [...window.app.plotManager.files.values()][0].data;
        const source = data._duckdb.source;
        const out = {};
        for (const name of ['da', 'lb']) {
            const raw = await source.getRawColumnsRange(data, [name], 1000, 1010, 1e6);
            out[name] = { rows: raw.x.length, finite: [...raw.yByVar.get(name)].filter(Number.isFinite).length };
        }
        const traced = [...window.app.plotManager.plots.values()].flatMap(p => p.traces.map(t => t.varName));
        return { out, traced, message: document.getElementById('outlier-message')?.textContent || '' };
    });
    for (const name of ['da', 'lb']) {
        assert.equal(zoom.out[name].rows, 1001, `${name}: a 10 s zoom returns all 1001 rows`);
        assert.ok(zoom.out[name].finite > 990, `${name}: with values`);
        assert.ok(zoom.traced.includes(name), `${name} is plotted`);
    }
    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e lazy data tools: derivative and detrend created from the panel on a lazy file');
} finally {
    await browser.close();
    await server.close();
}
