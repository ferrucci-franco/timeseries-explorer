// Benchmark runner — imports the real CsvParser and PlotManager from src/.
// Each step uses performance.now() and reports JSON-serializable results.

import CsvParser from '../src/parsers/csv-parser.js';
import MatParser from '../src/parsers/mat-parser.js';
import DuckDbSource from '../src/data/duckdb-source.js';
import PlotManager from '../src/plots/plot-manager.js';
import Plotly from '../src/vendor/plotly.js';

const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2);
const fmtMs = (ms) => ms.toFixed(2);
const now = () => performance.now();

function memSnapshot() {
    const m = performance.memory || {};
    return {
        used: m.usedJSHeapSize || null,
        total: m.totalJSHeapSize || null,
        limit: m.jsHeapSizeLimit || null,
    };
}

function logLine(target, msg) {
    if (target) {
        const line = document.createElement('div');
        line.textContent = msg;
        target.appendChild(line);
        target.scrollTop = target.scrollHeight;
    }
    console.log(msg);
}

async function readAsArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = (e) => resolve(e.target.result);
        r.onerror = () => reject(new Error('FileReader failed'));
        r.readAsArrayBuffer(file);
    });
}

function makePanelDom(panelId, host) {
    const root = document.createElement('div');
    root.className = 'layout-panel';
    root.dataset.id = panelId;
    root.style.cssText = 'position:relative;width:900px;height:480px;border:1px solid #888;margin:6px 0;background:#fff;';

    const toolbar = document.createElement('div');
    toolbar.className = 'layout-panel-toolbar';
    root.appendChild(toolbar);

    const content = document.createElement('div');
    content.className = 'layout-panel-content';
    content.style.cssText = 'width:100%;height:430px;position:relative;';
    root.appendChild(content);

    const placeholder = document.createElement('div');
    placeholder.className = 'layout-panel-placeholder';
    placeholder.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#888;';
    placeholder.textContent = '(bench panel)';
    content.appendChild(placeholder);

    host.appendChild(root);
    return content;
}

async function benchParseLegacy(file, parser) {
    const buffer = await readAsArrayBuffer(file);
    const t0 = now();
    const data = await parser.parse(buffer);
    const t1 = now();
    return {
        sizeMB: Number(fmtMB(buffer.byteLength)),
        rows: data.metadata?.numTimesteps || 0,
        variables: Object.keys(data.variables).length,
        parseMs: t1 - t0,
        backend: 'legacy',
        data,
    };
}

// Mirrors the threshold in file-methods.js so the bench matches the real
// app code path. Files above this size are parsed in lazy mode.
const LAZY_THRESHOLD_BYTES = 50 * 1024 * 1024;

async function benchParseDuckDb(file, duckdbSource) {
    const lazy = (file.size ?? 0) >= LAZY_THRESHOLD_BYTES;
    const sampleBuffer = await file.slice(0, 1024 * 1024).arrayBuffer();
    const csvProfile = new CsvParser(new MatParser()).inspectSample(sampleBuffer, { maxRows: 700 });
    const t0 = now();
    const data = await duckdbSource.parseCsvFile(file, file.name, { lazy, csvProfile });
    const t1 = now();
    return {
        sizeMB: Number(fmtMB(file.size)),
        rows: data.metadata?.numTimesteps || 0,
        variables: Object.keys(data.variables).length,
        parseMs: t1 - t0,
        backend: lazy ? 'duckdb-lazy' : 'duckdb-eager',
        data,
    };
}

function pickPlottableVariable(data) {
    const timeName = data.metadata?.timeName;
    for (const name of Object.keys(data.variables)) {
        if (name === timeName) continue;
        const v = data.variables[name];
        if (v.kind === 'abscissa' || v.dataType === 'string') continue;
        return name;
    }
    return null;
}

async function benchRenderTimeseries(plotManager, panelId, panelEl, data) {
    const yName = pickPlottableVariable(data);
    if (!yName) throw new Error('no plottable variable');
    const t0 = now();
    plotManager.addTrace(panelId, yName, panelEl);
    // PlotManager.addTrace -> _createChart -> Plotly.newPlot returns a promise.
    // Wait for the plot to actually appear in the DOM.
    let waited = 0;
    while (!plotManager.plots.get(panelId)?.div && waited < 5000) {
        await new Promise(res => setTimeout(res, 5));
        waited += 5;
    }
    if (!plotManager.plots.get(panelId)?.div) {
        throw new Error('plot did not mount within 5s');
    }
    // Allow the newPlot Promise chain to resolve.
    await new Promise(res => requestAnimationFrame(res));
    const t1 = now();
    return { yName, renderMs: t1 - t0 };
}

async function benchZoom(plotManager, panelId) {
    const plot = plotManager.plots.get(panelId);
    if (!plot?.div) throw new Error('plot not mounted');
    const trace = plot.traces[0];
    const fileId = trace.fileId;
    const fileData = plotManager.files.get(fileId)?.data;
    const timeName = fileData?.metadata?.timeName;
    const timeData = fileData?.variables?.[timeName]?.data;
    if (!timeData?.length) throw new Error('no time data');

    const tMin = timeData[0];
    const tMax = timeData[timeData.length - 1];
    const spans = [1.0, 0.5, 0.25, 0.1, 0.05, 0.01];
    const results = [];
    for (const span of spans) {
        const center = (tMin + tMax) / 2;
        const half = (tMax - tMin) * span * 0.5;
        const lo = center - half;
        const hi = center + half;
        const t0 = now();
        // Manually fire _onRelayout (PlotManager listens for plotly_relayout events,
        // but Plotly.relayout() does not emit those — they come from user gestures).
        // So call the path explicitly to measure realistic downsampling cost.
        await Plotly.relayout(plot.div, { 'xaxis.range': [lo, hi] });
        plotManager._onRelayout(panelId, { 'xaxis.range[0]': lo, 'xaxis.range[1]': hi });
        // Wait for any async DuckDB lazy refresh to finish before measuring.
        if (plotManager._lastLazyRefresh) {
            try { await plotManager._lastLazyRefresh; } catch (_) { /* ignore */ }
        }
        await new Promise(res => requestAnimationFrame(res));
        await new Promise(res => requestAnimationFrame(res));
        const t1 = now();
        results.push({ span, ms: t1 - t0 });
    }
    return results;
}

async function benchHeatmap(div, size) {
    const z = new Array(size);
    for (let r = 0; r < size; r++) {
        const row = new Float32Array(size);
        for (let c = 0; c < size; c++) row[c] = Math.sin(r * 0.05) + Math.cos(c * 0.07) + r * 0.0003 * c;
        z[r] = row;
    }
    const t0 = now();
    await Plotly.newPlot(div, [{ type: 'heatmap', z, colorscale: 'Viridis' }], { width: 700, height: 500 }, { staticPlot: true });
    const t1 = now();
    Plotly.purge(div);
    return { size, ms: t1 - t0 };
}

async function runAll({ files, panelHost, heatmapDiv, log, backend = 'legacy' }) {
    const legacyParser = new CsvParser(new MatParser());
    const duckdbSource = backend === 'duckdb' ? new DuckDbSource(new MatParser()) : null;
    if (duckdbSource) {
        logLine(log, 'initializing DuckDB-WASM…');
        const tInit0 = now();
        await duckdbSource.init();
        const tInit1 = now();
        logLine(log, `  DuckDB ready in ${fmtMs(tInit1 - tInit0)} ms`);
    }
    const plotManager = new PlotManager(new MatParser());

    const results = {
        startedAt: new Date().toISOString(),
        backend,
        userAgent: navigator.userAgent,
        deviceMemoryGB: navigator.deviceMemory ?? null,
        cpuThreads: navigator.hardwareConcurrency ?? null,
        memBefore: memSnapshot(),
        files: [],
        plots: {},
    };

    for (const file of files) {
        const fileResult = {
            name: file.name,
            sizeMB: Number(fmtMB(file.size)),
            steps: {},
            mem: {},
        };
        logLine(log, `--- ${file.name} (${fmtMB(file.size)} MB) — backend=${backend} ---`);
        fileResult.mem.beforeParse = memSnapshot();

        let parseRes = null;
        try {
            parseRes = backend === 'duckdb'
                ? await benchParseDuckDb(file, duckdbSource)
                : await benchParseLegacy(file, legacyParser);
            fileResult.steps.parse = {
                ms: parseRes.parseMs,
                rows: parseRes.rows,
                vars: parseRes.variables,
                backend: parseRes.backend,
            };
            fileResult.mem.afterParse = memSnapshot();
            logLine(log, `  parse: ${fmtMs(parseRes.parseMs)} ms · ${parseRes.rows} rows · ${parseRes.variables} vars · backend=${parseRes.backend}`);
        } catch (err) {
            fileResult.steps.parseError = String(err?.message || err);
            logLine(log, `  PARSE FAILED: ${err?.message || err}`);
            results.files.push(fileResult);
            continue;
        }

        // Fresh panel for this file.
        const panelId = `bench-${results.files.length}`;
        const panelEl = makePanelDom(panelId, panelHost);
        plotManager.onPanelMount(panelId, panelEl);

        try {
            plotManager.addFile(`f-bench-${results.files.length}`, file.name, parseRes.data);
            const renderRes = await benchRenderTimeseries(plotManager, panelId, panelEl, parseRes.data);
            fileResult.steps.render = { ms: renderRes.renderMs, variable: renderRes.yName };
            logLine(log, `  render initial 1D plot: ${fmtMs(renderRes.renderMs)} ms · var=${renderRes.yName}`);

            const zoom = await benchZoom(plotManager, panelId);
            fileResult.steps.zoom = zoom;
            const worst = zoom.reduce((m, z) => Math.max(m, z.ms), 0);
            const best = zoom.reduce((m, z) => Math.min(m, z.ms), Infinity);
            logLine(log, `  zoom (range 100%..1%): best ${fmtMs(best)} ms · worst ${fmtMs(worst)} ms`);
        } catch (err) {
            fileResult.steps.renderError = String(err?.message || err);
            logLine(log, `  RENDER/ZOOM FAILED: ${err?.message || err}`);
        }

        // Cleanup before next file.
        plotManager.onPanelUnmount(panelId);
        panelEl.parentElement?.remove();
        try {
            // Clear file registry so the next iteration starts clean.
            for (const fid of [...plotManager.files.keys()]) plotManager.removeFile(fid);
        } catch (_) { /* ignore */ }
        // Suggest GC where supported.
        if (typeof window.gc === 'function') window.gc();
        fileResult.mem.afterCleanup = memSnapshot();

        results.files.push(fileResult);
    }

    if (heatmapDiv) {
        logLine(log, '--- heatmap render (Plotly newPlot, static) ---');
        for (const size of [500, 1000, 2000]) {
            try {
                const r = await benchHeatmap(heatmapDiv, size);
                results.plots[`heatmap_${size}`] = r.ms;
                logLine(log, `  heatmap ${size}x${size}: ${fmtMs(r.ms)} ms`);
            } catch (err) {
                results.plots[`heatmap_${size}`] = String(err?.message || err);
                logLine(log, `  heatmap ${size} FAILED: ${err?.message || err}`);
            }
        }
    }

    results.memAfter = memSnapshot();
    results.finishedAt = new Date().toISOString();
    if (duckdbSource) {
        try { await duckdbSource.shutdown(); } catch (_) { /* ignore */ }
    }
    return results;
}

export { runAll };
