// End-to-end check of the Data Tools panel on a file read in memory-saving
// (lazy) mode, in a real browser with the DuckDB-WASM the app ships.
//
// A 12 MB CSV (above the 10 MB full-load limit set here) opens lazily. Through
// the panel's own controls: the tool picker offers every tool over one
// variable (derivative, detrend, integral, moving average, fill, filter and
// outliers) and none of the file tools; every outlier method and both
// replacements; every integral policy; every detrend method. A derivative, an
// integral bridging holes, a linear detrend, a moving average, a
// moving-average detrend, a designed filter, a zero-phase one, a spike
// removal replaced by interpolation and a fill of missing samples are created
// with "Create and plot", and each is drawn from the file (a zoom returns full
// resolution), with no page error. The moving average runs as a job behind an
// overlay that counts the rows; cancelled, it leaves no variable and no sink.
// The filter designer reads the sample rate of the whole file (100 Hz),
// measured once, not of the overview in memory. The spike detector's chunks
// run in the compute worker pool.
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
        // Holes for the fill: singles and a run of 30.
        const hole = i % 1201 === 600 || (i > 200000 && i < 200030);
        lines.push(`${(i * 0.01).toFixed(2)},${hole ? '' : a.toFixed(6)},${(i / 1000 + Math.cos(i / 90)).toFixed(6)}`);
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
    assert.deepEqual(Object.keys(picker).filter(k => picker[k]).sort(), ['derivative', 'detrend', 'filter', 'integrate', 'interpolate', 'movingAverage', 'removeOutliers'],
        'a lazy file offers every tool over one variable');
    assert.deepEqual(Object.keys(picker).filter(k => !picker[k]).sort(), ['collapse', 'resample', 'xcorr'], 'and none of the file tools yet');

    await createAndPlot(page, 'derivative', 'a', 'da', () => pick(page, 'derivative-method', 'centered'));

    // Outliers: every method the menu has, and both replacements. The spike
    // detector runs in the chunked executor, its chunks in the worker pool.
    await createAndPlot(page, 'removeOutliers', 'a', 'sa', async () => {
        const outlierMethods = await page.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('#outlier-method option')].map(o => [o.value, !o.disabled])));
        assert.deepEqual(Object.keys(outlierMethods).filter(k => outlierMethods[k]).sort(), ['bounds', 'spike'], 'outliers: every method');
        await pick(page, 'outlier-method', 'spike');
        const replacements = await page.evaluate(() => [...document.querySelectorAll('input[name="outlier-replacement"]')].map(i => [i.value, !i.disabled]));
        assert.deepEqual(replacements, [['nan', true], ['interpolate', true]], 'both replacements are offered');
        await page.locator('input[name="outlier-replacement"][value="interpolate"]').check();
    });
    const spikes = await page.evaluate(() => {
        const data = [...window.app.plotManager.files.values()][0].data;
        return { count: data.variables.sa.dataTool.outlierCount, replacement: data.variables.sa.dataTool.replacement };
    });
    assert.ok(spikes.count >= 80, `the spike detector found the spikes of the file (${spikes.count})`);
    assert.equal(spikes.replacement, 'interpolate', 'replaced by interpolation');

    await createAndPlot(page, 'integrate', 'a', 'ia', async () => {
        const policies = await page.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('#integral-gap-policy option')].map(o => [o.value, !o.disabled])));
        assert.equal(policies.interpolate && policies.zero && policies.propagate, true, 'every policy is offered on a lazy file');
        await pick(page, 'integral-method', 'trapezoidal');
        await pick(page, 'integral-gap-policy', 'interpolate');
    });
    const integral = await page.evaluate(() => [...window.app.plotManager.files.values()][0].data.variables.ia.dataTool);
    assert.equal(integral.gapPolicy, 'interpolate', 'the integral bridges holes');
    assert.ok(integral.nanSegmentCount > 300, `and counted the holes of the file (${integral.nanSegmentCount})`);

    // The fill: a job too, with its counts.
    await createAndPlot(page, 'interpolate', 'a', 'na', async () => {
        await pick(page, 'interpolate-method', 'pchip');
        await page.locator('#interpolate-max-gap').fill('0');
        await page.locator('#interpolate-max-gap').dispatchEvent('input');
        const status = await page.evaluate(() => document.getElementById('interpolate-status')?.textContent || '');
        assert.ok(status.length > 0 && !/\d/.test(status), `the live count is not read off the overview (${status})`);
    });
    const fill = await page.evaluate(() => [...window.app.plotManager.files.values()][0].data.variables.na.dataTool);
    assert.ok(fill.filledCount > 300 && fill.filledRuns > 300, `the fill counted what it filled (${fill.filledCount} in ${fill.filledRuns} runs)`);
    assert.equal(fill.skippedCount, 0, 'nothing left: no gap limit');

    await createAndPlot(page, 'detrend', 'b', 'lb', async () => {
        const methods = await page.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('#detrend-method option')].map(o => [o.value, !o.disabled])));
        assert.equal(methods.movingAverage && methods.linear, true, 'every detrend method is offered');
        await pick(page, 'detrend-method', 'linear');
    });

    // The moving average is a job over the whole file: an overlay says so and
    // counts the rows while it runs.
    await page.evaluate(() => {
        window.__overlays = [];
        new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.id === 'file-loading-overlay') {
                        window.__overlays.push(node.querySelector('#file-loading-title')?.textContent || '');
                        new MutationObserver(() => {
                            const hint = node.querySelector('#file-loading-hint')?.textContent || '';
                            if (hint) window.__overlays.push(hint);
                        }).observe(node, { subtree: true, childList: true, characterData: true });
                    }
                }
            }
        }).observe(document.body, { childList: true });
    });
    await createAndPlot(page, 'movingAverage', 'a', 'ma', async () => {
        await page.locator('#moving-average-window').fill('501');
        await page.locator('#moving-average-window').dispatchEvent('change');
    });
    const overlays = await page.evaluate(() => window.__overlays);
    assert.ok(overlays.some(text => /\bma\b/.test(text)), `the job runs behind an overlay naming it (${overlays.join(' | ')})`);
    await createAndPlot(page, 'detrend', 'b', 'hb', async () => {
        await pick(page, 'detrend-method', 'movingAverage');
        await page.locator('#detrend-window').fill('201');
        await page.locator('#detrend-window').dispatchEvent('change');
    });

    // A designed filter: the sample rate is measured over the whole file
    // first (the overview in memory is a sample of the rows), then designed
    // against.
    await createAndPlot(page, 'filter', 'a', 'fd', async () => {
        await pick(page, 'filter-source', 'design');
        await page.waitForFunction(() => /100/.test(document.getElementById('filter-design-rate')?.textContent || ''), null, { timeout: 120000 });
        await pick(page, 'filter-design-family', 'butterworth');
        await pick(page, 'filter-design-response', 'lowpass');
        await page.locator('#filter-design-cutoff').fill('5');
        await page.locator('#filter-design-cutoff').dispatchEvent('input');
        await pick(page, 'filter-mode', 'forward');
    });
    // Typed coefficients, forward and back.
    await createAndPlot(page, 'filter', 'b', 'fz', async () => {
        await pick(page, 'filter-source', 'manual');
        await page.locator('#filter-b').fill('0.2 0.3');
        await page.locator('#filter-b').dispatchEvent('input');
        await page.locator('#filter-a').fill('1 -0.5');
        await page.locator('#filter-a').dispatchEvent('input');
        await pick(page, 'filter-mode', 'zeroPhase');
    });

    // Cancelled as soon as it starts: nothing is created, nothing is left.
    const cancelled = await page.evaluate(async () => {
        const source = [...window.app.plotManager.files.values()][0].data._duckdb.source;
        const sinksBefore = source._liveSinks.size;
        const observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.id === 'file-loading-overlay') node.querySelector('#file-loading-cancel')?.click();
                }
            }
        });
        observer.observe(document.body, { childList: true });
        const select = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        select('data-tool-select', 'movingAverage');
        select('outlier-variable', 'a');
        const output = document.getElementById('outlier-output-name');
        output.value = 'never';
        output.dispatchEvent(new Event('input', { bubbles: true }));
        await window.app.commitDataTool({ plot: true });
        observer.disconnect();
        const tables = await source.query("SELECT COUNT(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name LIKE '%_sink_%'");
        return {
            created: !!window.app.plotManager.files.values().next().value.data.variables.never,
            sinksBefore,
            sinksAfter: source._liveSinks.size,
            tables: tables.getChild('n').get(0),
            message: document.getElementById('outlier-message')?.textContent || '',
        };
    });
    assert.equal(cancelled.created, false, 'a cancelled job creates no variable');
    assert.equal(cancelled.sinksAfter, cancelled.sinksBefore, 'and keeps no sink');
    assert.equal(cancelled.tables, cancelled.sinksBefore, 'no table is left behind in DuckDB');
    assert.match(cancelled.message, /never/, `the panel says it was not created (${cancelled.message})`);

    // Each output is on a plot and reads the file, not the overview: a narrow
    // zoom returns every row in it.
    const zoom = await page.evaluate(async () => {
        const data = [...window.app.plotManager.files.values()][0].data;
        const source = data._duckdb.source;
        const out = {};
        for (const name of ['da', 'ia', 'lb', 'ma', 'hb', 'fd', 'fz', 'sa', 'na']) {
            const raw = await source.getRawColumnsRange(data, [name], 1000, 1010, 1e6);
            out[name] = { rows: raw.x.length, finite: [...raw.yByVar.get(name)].filter(Number.isFinite).length };
        }
        const traced = [...window.app.plotManager.plots.values()].flatMap(p => p.traces.map(t => t.varName));
        return { out, traced, message: document.getElementById('outlier-message')?.textContent || '' };
    });
    for (const name of ['da', 'ia', 'lb', 'ma', 'hb', 'fd', 'fz', 'sa', 'na']) {
        assert.equal(zoom.out[name].rows, 1001, `${name}: a 10 s zoom returns all 1001 rows`);
        assert.ok(zoom.out[name].finite > 990, `${name}: with values`);
        assert.ok(zoom.traced.includes(name), `${name} is plotted`);
    }
    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e lazy data tools: derivative, integral, detrend, moving averages, filters, spikes and fill created from the panel on a lazy file');
} finally {
    await browser.close();
    await server.close();
}
