// End-to-end check of the Heatmap and the Temporal profile on a file read in
// memory-saving (lazy) mode, in a real browser with the DuckDB-WASM the app
// ships.
//
// A 14 MB CSV with a datetime column (above the 10 MB full-load limit set
// here) opens lazily; its overview in memory is a few thousand rows. A
// derivative of `a` is created with the Data Tools (a signal derived on the
// lazy file: window columns, no rows in memory) and drawn with `a`. The panel
// switched to Heatmap draws both over every row of the file — the cells count
// the file's rows, not the overview's — and to Temporal profile the same; no
// warning says a signal was left out, and no page error. Then the file's axis
// is reindexed from an origin date (row × 1 min from 2024-01-01): both panels
// follow the displayed axis, the rows landing in January and February 2024.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-heatmap-profile`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 300000;
const START = Date.UTC(2023, 4, 1, 0, 0, 0);
function makeCsv() {
    const lines = ['time,a,b'];
    let finite = 0;
    for (let i = 0; i < ROWS; i++) {
        const hole = i % 1201 === 600;
        const a = Math.sin(i / 500) * 3 + (i % 7) / 10;
        if (!hole) finite++;
        lines.push(`${new Date(START + i * 60000).toISOString()},${hole ? '' : a.toFixed(6)},${(i / 1000).toFixed(6)}`);
    }
    return { file: { name: 'lazy-heatmap.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') }, finite };
}

async function pick(page, id, value) {
    await page.locator(`#${id}`).selectOption(value);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const { file, finite } = makeCsv();
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 10 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
    const overviewRows = await page.evaluate(() => [...window.app.plotManager.files.values()][0].data.variables.a.data.length);
    assert.ok(overviewRows < ROWS / 10, `what is in memory is an overview (${overviewRows} rows)`);
    await page.evaluate(() => window.app.setActiveFile([...window.app.plotManager.files.keys()][0]));
    await page.waitForTimeout(500);

    // The derivative, as the user makes it: a signal of the lazy file with no rows in memory.
    await pick(page, 'data-tool-select', 'derivative');
    await pick(page, 'outlier-variable', 'a');
    await pick(page, 'derivative-method', 'centered');
    await page.locator('#outlier-output-name').fill('da');
    await page.locator('#outlier-output-name').dispatchEvent('input');
    await page.locator('#data-tool-create-plot').click();
    await page.waitForFunction(() => {
        const data = [...window.app.plotManager.files.values()][0]?.data;
        return !!data?.variables?.da?._duckdbExpr;
    }, null, { timeout: 120000 });
    await page.waitForFunction(() => !window.app._dataToolBusy, null, { timeout: 120000 });

    const panelId = await page.evaluate(() => {
        const pm = window.app.plotManager;
        const panelEl = document.querySelector('.layout-panel');
        const id = panelEl.dataset.id;
        const plot = pm.plots.get(id);
        if (!plot.traces.some(trace => trace.varName === 'a')) pm.addTrace(id, 'a', panelEl);
        if (!plot.traces.some(trace => trace.varName === 'da')) pm.addTrace(id, 'da', panelEl);
        return id;
    });
    await page.waitForTimeout(500);

    const heatmap = async () => {
        await page.evaluate(id => window.app.plotManager._scheduleCalendarHeatmapRecompute(id, { immediate: true }), panelId);
        return page.waitForFunction(id => {
            const plot = window.app.plotManager.plots.get(id);
            if (plot?.mode !== 'heatmap' || plot._calendarHeatmapStatusKind === 'loading' || !plot._calendarHeatmapModels?.length) return null;
            if (plot.heatmapContainer?.getAttribute('aria-busy') === 'true') return null;
            return {
                status: plot._calendarHeatmapStatusKind,
                warnings: plot.heatmap.warnings || [],
                models: plot._calendarHeatmapModels.map(model => ({
                    varName: model.trace.varName,
                    nScope: model.grid.stats?.nScope ?? null,
                    nFinite: model.grid.stats?.nFinite ?? null,
                    firstColumn: model.grid.meta?.firstColumnStartMs,
                    lastColumn: model.grid.meta?.lastColumnStartMs,
                })),
            };
        }, panelId, { timeout: 120000, polling: 200 }).then(handle => handle.jsonValue());
    };
    const profile = async () => {
        await page.evaluate(id => window.app.plotManager._scheduleTemporalProfileRecompute(id, { immediate: true }), panelId);
        return page.waitForFunction(id => {
            const plot = window.app.plotManager.plots.get(id);
            if (plot?.mode !== 'temporal-profile' || plot._temporalProfileStatusKind === 'loading' || !plot._temporalProfileModels?.length) return null;
            if (plot.temporalProfileContainer?.getAttribute('aria-busy') === 'true') return null;
            return {
                status: plot._temporalProfileStatusKind,
                warnings: plot.temporalProfile.warnings || [],
                models: plot._temporalProfileModels.map(model => ({
                    varName: model.trace.varName,
                    nScope: model.result.stats.nScope,
                    nFinite: model.result.stats.nFinite,
                    nPeriods: model.result.stats.nPeriods,
                })),
            };
        }, panelId, { timeout: 120000, polling: 200 }).then(handle => handle.jsonValue());
    };

    // ── The datetime column ──
    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'heatmap'), panelId);
    const heat = await heatmap();
    assert.deepEqual(heat.warnings, [], `heatmap: no warning (${heat.warnings.join(' | ')})`);
    // The derivative was drawn when it was created, before `a` was added.
    assert.deepEqual(heat.models.map(m => m.varName).sort(), ['a', 'da'], 'heatmap: both signals drawn');
    const heatA = heat.models.find(m => m.varName === 'a');
    const heatDa = heat.models.find(m => m.varName === 'da');
    assert.equal(heatA.nScope, ROWS, `heatmap: every row of the file is in a cell (${heatA.nScope})`);
    assert.equal(heatA.nFinite, finite, 'heatmap: and every finite value counted');
    assert.equal(heatDa.nScope, ROWS, `heatmap: the derivative too (${heatDa.nScope})`);
    assert.ok(heatDa.nFinite > finite - 2000 && heatDa.nFinite < finite, `heatmap: the derivative is finite away from the holes (${heatDa.nFinite})`);
    assert.equal(new Date(heatA.firstColumn).getUTCFullYear(), 2023, 'heatmap: the file\'s own dates');

    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'temporal-profile'), panelId);
    const prof = await profile();
    assert.deepEqual(prof.warnings, [], `profile: no warning (${prof.warnings.join(' | ')})`);
    assert.deepEqual(prof.models.map(m => m.varName).sort(), ['a', 'da'], 'profile: both signals profiled');
    const profA = prof.models.find(m => m.varName === 'a');
    assert.equal(profA.nScope, ROWS, `profile: every row of the file (${profA.nScope})`);
    assert.equal(profA.nFinite, finite, 'profile: every finite value');
    assert.equal(prof.models.find(m => m.varName === 'da').nScope, ROWS, 'profile: the derivative too');
    assert.equal(profA.nPeriods, Math.ceil(ROWS / 1440), `profile: one period per day of the file (${profA.nPeriods})`);

    // ── The axis reindexed from an origin date: row × 1 min from 2024-01-01 ──
    await page.evaluate(() => {
        const pm = window.app.plotManager;
        const fileId = [...pm.files.keys()][0];
        pm.setFileTransform(fileId, { timeDisplayMode: 'index', timeStepMode: '1minute', timeStepOriginMode: 'calendar', timeStepOriginDate: '2024-01-01T00:00' });
    });
    await page.waitForTimeout(300);
    const reindexedProfile = await profile();
    assert.deepEqual(reindexedProfile.warnings, [], `reindexed profile: no warning (${reindexedProfile.warnings.join(' | ')})`);
    const reindexedProfA = reindexedProfile.models.find(m => m.varName === 'a');
    assert.equal(reindexedProfA.nScope, ROWS, 'reindexed profile: every row');
    assert.equal(reindexedProfA.nPeriods, Math.ceil(ROWS / 1440), 'reindexed profile: the same days, now from the origin');

    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'heatmap'), panelId);
    const reindexed = await heatmap();
    assert.deepEqual(reindexed.warnings, [], `reindexed heatmap: no warning (${reindexed.warnings.join(' | ')})`);
    const reindexedA = reindexed.models.find(m => m.varName === 'a');
    assert.equal(reindexedA.nScope, ROWS, 'reindexed heatmap: every row');
    assert.equal(new Date(reindexedA.firstColumn).toISOString().slice(0, 10), '2024-01-01', `reindexed heatmap: the rows start on the origin (${new Date(reindexedA.firstColumn).toISOString()})`);
    assert.equal(new Date(reindexedA.lastColumn).getUTCMonth(), new Date(Date.UTC(2024, 0, 1) + (ROWS - 1) * 60000).getUTCMonth(), 'reindexed heatmap: and end where row × Δt ends');

    assert.deepEqual(errors, [], 'no page error');
    console.log(`e2e lazy heatmap/profile: ${ROWS} rows of a lazy file and their derivative in the Heatmap and the Temporal profile, by the file's dates and by a reindexed axis`);
} finally {
    await browser.close();
    await server.close();
}
