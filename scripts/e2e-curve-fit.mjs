// End-to-end check of the Curve Fit analyses on a file read in memory-saving
// (lazy) mode, where every fitted row comes from DuckDB rather than from the
// overview in memory.
//
// The signal is flat, then a first-order response from t = 1000 s:
// y = 0.5 + 2·(1 − e^(−(t − 1000)/300)). Fitted over [1000, 4199] as a
// first-order response with offset, the time-series fit must read K = 2,
// τ = 300 s and y₀ = 0.5 in t′ = t − 1000 — the shifted time — and the 2D fit
// of y against x (= t) as an exponential with offset must read b = −1/300 and
// c = 2.5. Both are known by hand.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:curve-fit`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const ROWS = 420000;
const lines = ['time,y,x'];
for (let i = 0; i < ROWS; i++) { const t = i * 0.01; lines.push(`${t.toFixed(2)},${(t < 1000 ? 0.5 : 0.5 + 2 * (1 - Math.exp(-(t - 1000) / 300))).toFixed(6)},${t.toFixed(2)}`); }
const file = { name: 'lazy-fit.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
  await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 4 }));
  await page.setInputFiles('#file-input', [file]);
  await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });
  const panelId = await page.evaluate(() => { const app = window.app; const el = document.querySelector('.layout-panel'); app.setActiveFile([...app.plotManager.files.keys()][0]); app.plotManager.addTrace(el.dataset.id, 'y', el); return el.dataset.id; });
  await page.waitForTimeout(1500);
  await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'curve-fit'), panelId);
  await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.curveFitResidualDiv?._fullLayout, panelId, { timeout: 30000 });
  await page.evaluate(id => window.app.plotManager._updateCurveFitEntry(id, { model: 'first-order-offset', x1: 1000, x2: 4199 }), panelId);
  await page.waitForFunction(id => window.app.plotManager.plots.get(id)?._curveFitResults?.[0]?.result?.fit, panelId, { timeout: 60000 });
  const fit = await page.evaluate(id => { const r = window.app.plotManager.plots.get(id)._curveFitResults[0]; return { n: r.result.fit.n, K: r.result.fit.K, y0: r.result.fit.y0, tau: r.result.fit.timeConstant, lazy: r.lazy }; }, panelId);
  
  assert.ok(fit.lazy && fit.n > 300000, 'every row in range');
  assert.ok(Math.abs(fit.K - 2) < 1e-3 && Math.abs(fit.tau - 300) < 0.5 && Math.abs(fit.y0 - 0.5) < 1e-3);
  // 2D lazy: x vs y, exponential-offset over all rows where x >= 1000 -> use selection
  await page.evaluate(id => { const pm = window.app.plotManager; pm._clearPanel(id); }, panelId);
  await page.waitForTimeout(500);
  await page.evaluate(id => { const pm = window.app.plotManager; const el = document.querySelector('.layout-panel'); pm._requestModeChange(id, 'phase2d'); pm.addTrace(id, 'x', el); pm.addTrace(id, 'y', el); }, panelId);
  await page.waitForTimeout(1500);
  await page.evaluate(id => { const pm = window.app.plotManager; pm._togglePhase2dFit(id); }, panelId);
  await page.waitForTimeout(1500);
  await page.evaluate(id => { const pm = window.app.plotManager; const st = pm._ensurePhase2dState(pm.plots.get(id)); st.rangeFull = false; st.x1 = 1000; st.x2 = 4199; pm._setPhase2dFitModel(id, 'exponential-offset'); }, panelId);
  await page.waitForFunction(id => window.app.plotManager.plots.get(id)?._phase2dFits?.[0]?.fit?.status === 'ok', panelId, { timeout: 60000 });
  const f2 = await page.evaluate(id => { const r = window.app.plotManager.plots.get(id)._phase2dFits[0]; return { n: r.fit.n, b: r.fit.b, c: r.fit.c, lazy: r.lazy }; }, panelId);
  
  assert.ok(Math.abs(f2.b + 1 / 300) < 1e-5 && Math.abs(f2.c - 2.5) < 1e-3);
  assert.deepEqual(errors, [], 'no page errors');
  console.log('curve fit e2e: ok');
} finally { await browser.close(); await server.close(); }
