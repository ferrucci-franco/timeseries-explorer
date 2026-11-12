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
// Then the fit is saved as signals (Fit → signal, Residual → signal): formula
// variables that must reproduce ŷ and y − ŷ inside the range — over the file
// in SQL for the lazy file — and be NaN outside it. An in-memory file with a
// time shift, a gain and an offset on its transform checks that the formula,
// written over the STORED time and values, still displays ŷ.
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
  // ── In memory, with a transform: shift 100 s, gain 2, offset 1 ──
  {
    const rows = ['time,v'];
    for (let i = 0; i <= 1000; i++) { const t = i * 0.1; rows.push(`${t.toFixed(1)},${(t < 20 ? 0.2 : 0.2 + 1.5 * (1 - Math.exp(-(t - 20) / 15))).toFixed(9)}`); }
    const page2 = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors2 = [];
    page2.on('pageerror', e => errors2.push(e.message));
    await page2.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page2.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page2.setInputFiles('#file-input', [{ name: 'step.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n') + '\n') }]);
    await page2.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const id2 = await page2.evaluate(() => {
      const app = window.app; const pm = app.plotManager; const fileId = [...pm.files.keys()][0];
      app.setActiveFile(fileId);
      pm.setFileTransform(fileId, { ...pm._fileTransform(fileId), timeShift: 100, gain: 2, yOffset: 1 });
      const el = document.querySelector('.layout-panel'); pm.addTrace(el.dataset.id, 'v', el); return el.dataset.id;
    });
    await page2.waitForTimeout(800);
    await page2.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'curve-fit'), id2);
    await page2.waitForFunction(id => window.app.plotManager.plots.get(id)?.curveFitResidualDiv?._fullLayout, id2, { timeout: 30000 });
    // Displayed time runs 100…200 s; the response starts at 120.
    await page2.evaluate(id => window.app.plotManager._updateCurveFitEntry(id, { model: 'first-order-offset', x1: 120, x2: 180 }), id2);
    await page2.waitForFunction(id => window.app.plotManager.plots.get(id)?._curveFitResults?.[0]?.result?.fit?.status === 'ok', id2, { timeout: 30000 });
    await page2.click('.curve-fit-save-fit');
    await page2.click('.curve-fit-save-residual');
    await page2.evaluate(async () => { window.__predict = (await import('/src/utils/regression.js')).predict; });
    const read = () => page2.evaluate(id => {
      const pm = window.app.plotManager; const plot = pm.plots.get(id); const r = plot._curveFitResults[0];
      const t = pm._getTransformedTimeDataForVariable(r.trace.fileId, 'v');
      const y = pm._getTransformedVariableData(r.trace.fileId, 'v');
      const fit = pm._getTransformedVariableData(r.trace.fileId, 'v_fit1');
      const res = pm._getTransformedVariableData(r.trace.fileId, 'v_res1');
      let err = 0; let inside = 0; let nanOutside = 0; let outside = 0;
      for (let i = 0; i < t.length; i++) {
        if (t[i] >= 120 && t[i] <= 180) {
          inside++;
          const p = window.__predict(r.result.fit, (t[i] - r.result.t0) / r.result.scale);
          err = Math.max(err, Math.abs(fit[i] - p), Math.abs(res[i] - (y[i] - p)));
        } else { outside++; if (Number.isNaN(fit[i])) nanOutside++; }
      }
      return { K: r.result.fit.K, tau: r.result.fit.timeConstant, y0: r.result.fit.y0, err, inside, outside, nanOutside };
    }, id2);
    const saved = await read();
    // Displayed values are 2·v + 1: K doubles, y₀ = 2·0.2 + 1.
    assert.ok(Math.abs(saved.K - 3) < 1e-6 && Math.abs(saved.tau - 15) < 1e-4 && Math.abs(saved.y0 - 1.4) < 1e-6, `fit in display units (${JSON.stringify(saved)})`);
    assert.ok(saved.inside > 500 && saved.err < 1e-9, `the saved signals display ŷ and y − ŷ (${saved.err})`);
    assert.equal(saved.nanOutside, saved.outside, 'and are NaN outside the range');
    // Extrapolate: the equation everywhere.
    await page2.evaluate(() => { const box = document.querySelector('.curve-fit-extrapolate-box'); box.checked = true; box.dispatchEvent(new Event('change')); });
    await page2.click('.curve-fit-save-fit');
    const extrapolated = await page2.evaluate(id => {
      const pm = window.app.plotManager; const fileId = pm.plots.get(id).traces[0].fileId;
      return Array.from(pm._getTransformedVariableData(fileId, 'v_fit1_2')).filter(Number.isNaN).length;
    }, id2);
    assert.equal(extrapolated, 0, 'extrapolated over the whole axis');
    // It is an ordinary formula variable: saved with the view.
    const inSession = await page2.evaluate(() => JSON.stringify(window.app._createSessionSnapshot({ includeData: false })).includes('v_fit1'));
    assert.ok(inSession, 'the saved signal travels with the view');
    assert.deepEqual(errors2, [], 'no page errors (in memory)');
  }
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

  // Saved from a lazy file: SQL over the file, exact against the fit.
  await page.click('.curve-fit-save-fit');
  await page.waitForTimeout(500);
  const lazySaved = await page.evaluate(async id => {
    const pm = window.app.plotManager; const plot = pm.plots.get(id); const r = plot._curveFitResults[0];
    const data = pm.files.get(r.trace.fileId).data;
    const variable = data.variables.y_fit1;
    const raw = await data._duckdb.source.getRawColumnsRange(data, ['y_fit1', 'y'], 999, 1100, 100000);
    const { predict } = await import('/src/utils/regression.js');
    let err = 0; let inside = 0; let nanBefore = 0; let before = 0;
    const values = raw.yByVar.get('y_fit1');
    for (let i = 0; i < raw.x.length; i++) {
      const t = raw.x[i];
      if (t >= 1000) { inside++; err = Math.max(err, Math.abs(values[i] - predict(r.result.fit, (t - r.result.t0) / r.result.scale))); }
      else { before++; if (Number.isNaN(values[i])) nanBefore++; }
    }
    return { sql: !!variable._duckdbExpr, inside, err, before, nanBefore };
  }, panelId);
  assert.ok(lazySaved.sql, 'the saved signal is SQL over the lazy file');
  assert.ok(lazySaved.inside > 9000 && lazySaved.err < 1e-9, `and exact there (${JSON.stringify(lazySaved)})`);
  assert.ok(lazySaved.before > 0 && lazySaved.nanBefore === lazySaved.before, 'NaN before the range');
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
